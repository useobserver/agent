// Agent job queue poller (cloud ↔ agent contract: @observer/protocol jobs.ts).
//
// The console enqueues typed jobs for this agent (probe tests, CloudWatch
// ListMetrics discovery). This module polls the cloud for pending jobs,
// runs each through the handler registered for its kind, and posts the
// outcome back. It is self-contained so index.ts only wires it up.
//
// Rules:
//   - Only kinds with a registered handler are requested (`kinds` query).
//     A job of any other kind is answered "unsupported_kind" and never run.
//   - A handler that throws is answered with a reason CODE only; error
//     messages never leave the host (driver errors can embed DSNs/tokens).
//   - 404 from the claim path = a cloud that predates the queue. The runner
//     marks itself unsupported (index.ts then keeps the legacy CloudWatch
//     poller) and re-checks every UNSUPPORTED_RECHECK_MS.
//   - One poll at a time (setTimeout chain, never setInterval), bounded
//     concurrency per batch, exponential backoff on cloud errors.

import {
  AGENT_JOBS_CLAIM_PATH,
  agentJobResultPath,
  sanitizeReasonCode,
  type AgentJob,
  type AgentJobResultBody,
  type AgentJobsClaimResponse,
} from "@observer/protocol";

export type JobHandler = (job: AgentJob) => Promise<AgentJobResultBody>;

export const DEFAULT_POLL_MS = 5_000;
export const MIN_POLL_MS = 1_000;
export const MAX_POLL_MS = 60_000;
// After a batch with work, poll again soon: the operator is likely clicking
// "Test" repeatedly in the console.
export const BUSY_POLL_MS = 1_000;
export const MAX_ERROR_BACKOFF_MS = 60_000;
export const UNSUPPORTED_RECHECK_MS = 5 * 60_000;
export const MAX_JOBS_PER_POLL = 5;

export interface JobRunnerDeps {
  cloudFetch: (path: string, init?: RequestInit) => Promise<Response>;
  handlers: Record<string, JobHandler>;
  log: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
  verbose?: boolean;
  /** Called once when support is first known (true) or ruled out (false). */
  onSupportChange?: (supported: boolean) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface JobRunner {
  /** One claim + run cycle. Resolves to the delay before the next poll. */
  pollOnce(): Promise<number>;
  start(): void;
  stop(): void;
  /** null until the first poll answers; false = cloud predates the queue. */
  supported(): boolean | null;
  stats(): { claimed: number; succeeded: number; failed: number; unsupported_kind: number };
}

export function clampPollMs(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(n)));
}

function errorStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown })?.status;
  return typeof s === "number" ? s : undefined;
}

export function createJobRunner(deps: JobRunnerDeps): JobRunner {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const kinds = Object.keys(deps.handlers).sort();
  let isSupported: boolean | null = null;
  let errorStreak = 0;
  let timer: unknown = null;
  let running = false;
  const counters = { claimed: 0, succeeded: 0, failed: 0, unsupported_kind: 0 };

  function setSupported(v: boolean): void {
    if (isSupported === v) return;
    isSupported = v;
    deps.onSupportChange?.(v);
  }

  async function postResult(id: string, body: AgentJobResultBody): Promise<void> {
    try {
      const res = await deps.cloudFetch(agentJobResultPath(id), { method: "POST", body: JSON.stringify(body) });
      res.body?.cancel().catch(() => {});
    } catch (e) {
      // 404/409 = the job expired or was already answered; nothing to do.
      // Anything else: the cloud's stale-claim release re-queues the job.
      if (deps.verbose) {
        deps.log("WARN", `job ${id}: result post failed (${errorStatus(e) ?? "network"})`);
      }
    }
  }

  async function runJob(job: AgentJob): Promise<void> {
    const handler = Object.prototype.hasOwnProperty.call(deps.handlers, job.kind) ? deps.handlers[job.kind] : undefined;
    if (!handler) {
      counters.unsupported_kind += 1;
      await postResult(job.id, { ok: false, error: "unsupported_kind" });
      return;
    }
    let body: AgentJobResultBody;
    try {
      body = await handler(job);
    } catch (e) {
      const code = sanitizeReasonCode((e as { code?: unknown })?.code, "agent_error");
      body = { ok: false, error: code };
    }
    if (body.ok) counters.succeeded += 1;
    else counters.failed += 1;
    await postResult(job.id, body);
  }

  async function pollOnce(): Promise<number> {
    let data: AgentJobsClaimResponse;
    try {
      const qs = kinds.length > 0 ? `?kinds=${encodeURIComponent(kinds.join(","))}` : "";
      const res = await deps.cloudFetch(`${AGENT_JOBS_CLAIM_PATH}${qs}`, { method: "GET" });
      data = (await res.json()) as AgentJobsClaimResponse;
    } catch (e) {
      if (errorStatus(e) === 404) {
        setSupported(false);
        errorStreak = 0;
        return UNSUPPORTED_RECHECK_MS;
      }
      errorStreak += 1;
      if (deps.verbose) {
        deps.log("WARN", `job poll failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return Math.min(MAX_ERROR_BACKOFF_MS, DEFAULT_POLL_MS * 2 ** Math.min(errorStreak, 4));
    }
    setSupported(true);
    errorStreak = 0;
    const next = clampPollMs(data?.next_poll_ms);
    const jobs = Array.isArray(data?.jobs) ? data.jobs.slice(0, MAX_JOBS_PER_POLL) : [];
    const valid = jobs.filter(
      (j): j is AgentJob => !!j && typeof j.id === "string" && j.id.length > 0 && typeof j.kind === "string",
    );
    if (valid.length === 0) return next;
    counters.claimed += valid.length;
    await Promise.allSettled(valid.map((j) => runJob(j)));
    return Math.min(next, BUSY_POLL_MS);
  }

  function schedule(ms: number): void {
    if (!running) return;
    timer = setTimer(() => {
      timer = null;
      pollOnce()
        .catch(() => DEFAULT_POLL_MS)
        .then((delay) => schedule(delay));
    }, ms);
  }

  return {
    pollOnce,
    start() {
      if (running) return;
      running = true;
      schedule(0);
    },
    stop() {
      running = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    supported: () => isSupported,
    stats: () => ({ ...counters }),
  };
}
