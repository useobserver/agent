// Managed-prober loop: fetch the outside-in checks assigned to this
// prober's location, run each on its interval through the guarded runner,
// and post per-location results in batches.
//
// Deliberately separate from the org agent loop (src/index.ts): different
// credential, endpoints and failure model. No SQLite buffer: a prober that
// cannot reach the cloud keeps a bounded in-memory queue and drops the
// oldest samples first (outside-in history is re-observable; a stale
// backlog is worth less than fresh results).

import {
  PROBER_CAPABILITIES_HEADER,
  PROBER_CHECKS_PATH,
  PROBER_CHECKS_VERSION_HEADER,
  PROBER_HEALTH_HEADER,
  PROBER_KEY_HEADER,
  PROBER_KEY_PREFIX,
  PROBER_RESULTS_MAX_BATCH,
  PROBER_RESULTS_PATH,
  PROBER_STATE_HEADER,
  PROBER_VERSION_HEADER,
  formatProberHealth,
  type ProberCheck,
  type ProberChecksResponse,
  type ProberHealth,
  type ProberResultItem,
  type ProberResultsResponse,
} from "@observer/protocol";
import { DeadlineError, withDeadline } from "../deadline.ts";
import icmpSource from "../sources/icmp.ts";
import { createResolver, parseDnsServers } from "./guard.ts";
import { runProberCheck } from "./runner.ts";
import { BOT_CHALLENGE_REASON, proberHttp, type ProberDeps } from "./sources.ts";
import type { ProbeResult } from "../types.ts";

export interface ProberConfig {
  cloudUrl: string;
  key: string;
  /** When set, the prober refuses to run unless the cloud agrees on its location. */
  expectedLocation: string | null;
  dnsServers: string[];
  icmp: "auto" | "on" | "off";
  concurrency: number;
  refreshMs: number;
  flushMs: number;
  queueMax: number;
  /** The watchdog exits (for the supervisor to restart) above this resident memory. */
  maxRssMb: number;
  version: string;
}

export function loadProberConfig(
  env: Record<string, string | undefined>,
  version: string,
): { ok: true; config: ProberConfig } | { ok: false; error: string } {
  const key = env.OBSERVER_PROBER_KEY;
  if (!key) return { ok: false, error: "OBSERVER_PROBER_KEY is required in prober mode." };
  if (!key.startsWith(PROBER_KEY_PREFIX)) {
    return { ok: false, error: `OBSERVER_PROBER_KEY must be a prober credential (${PROBER_KEY_PREFIX}…), not an agent key.` };
  }
  let cloudUrl: URL;
  try {
    cloudUrl = new URL(env.CLOUD_SERVER_URL || "https://use.observer");
  } catch {
    return { ok: false, error: "CLOUD_SERVER_URL is not a valid URL." };
  }
  if (cloudUrl.protocol !== "https:" && env.PROBER_ALLOW_INSECURE_CLOUD !== "true") {
    return { ok: false, error: "CLOUD_SERVER_URL must be https:// in prober mode." };
  }
  let dnsServers: string[];
  try {
    dnsServers = parseDnsServers(env.PROBER_DNS_SERVERS);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  // Off unless the operator opts in: ping is also gated per location in the cloud (probe_locations.icmp_enabled).
  const icmp = (env.PROBER_ICMP ?? "off").toLowerCase();
  const int = (v: string | undefined, d: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : d;
  };
  return {
    ok: true,
    config: {
      cloudUrl: cloudUrl.toString().replace(/\/$/, ""),
      key,
      expectedLocation: env.PROBER_LOCATION?.trim() || null,
      dnsServers,
      icmp: icmp === "on" || icmp === "auto" ? icmp : "off",
      concurrency: int(env.PROBER_CONCURRENCY, 32, 1, 512),
      refreshMs: int(env.PROBER_REFRESH_SECONDS, 30, 5, 600) * 1000,
      flushMs: int(env.PROBER_FLUSH_SECONDS, 5, 1, 60) * 1000,
      queueMax: int(env.PROBER_QUEUE_MAX, 20_000, 100, 1_000_000),
      maxRssMb: int(env.PROBER_MAX_RSS_MB, 384, 64, 65_536),
      version,
    },
  };
}

/** Can this host send ICMP? One loopback ping (our own process, not a tenant target). */
export async function detectIcmp(): Promise<boolean> {
  const r = await icmpSource.execute({ host: "127.0.0.1", count: 1, timeout_ms: 1000, interpretation: "reachability" });
  return r.value === 1;
}

// Hard deadlines. The sources have their own timeouts (fetch abort, c-ares,
// socket timeouts); these are the backstop for a promise that never settles,
// which once left a prober checking in for days without producing a result.
// A check can re-vet DNS on each of 5 redirect hops, so its cap is generous.
export const CHECK_DEADLINE_MS = 60_000;
export const SELF_CHECK_DEADLINE_MS = 20_000;
export const CLOUD_CALL_DEADLINE_MS = 30_000;

// Watchdog: the prober exits and lets its supervisor (systemd, k8s) restart
// it when it can no longer do its job. A wedged process that still checks in
// is worse than a restart: it looks alive while measuring nothing.
export const WATCHDOG_INTERVAL_MS = 30_000;
/** Worst event-loop delay over a minute that counts as stalled. */
export const WATCHDOG_MAX_LAG_MS = 30_000;
/** Consecutive bad watchdog rounds before exiting (about 90 s). */
export const WATCHDOG_STRIKES = 3;
/** No result at all for this long, while checks are assigned and the network is fine. */
export const WATCHDOG_NO_RESULT_MIN_MS = 10 * 60_000;
/** stop(): how long to wait for running checks, and for the last self-check. */
export const STOP_WAIT_CHECKS_MS = 3_000;
export const STOP_SELF_CHECK_MS = 5_000;
/** Abandoned checks still holding sockets and memory; past this, restart. */
export const WATCHDOG_MAX_ABANDONED = 8;
/** A result that finished while the event loop ran this late measured the prober, not the target. */
export const SKIP_RESULT_LAG_MS = 2_000;

// Scheduling, backoff and result ordering use a monotonic clock: an NTP
// step backwards (VM migration, chrony makestep) on the wall clock pushed
// every next-run time into the future. Result timestamps stay wall-clock.
const monotonicNow = (): number => performance.timeOrigin + performance.now();

interface Scheduled {
  check: ProberCheck;
  hash: string;
  nextRunAt: number;
  running: boolean;
}

type Log = (level: "INFO" | "WARN" | "ERROR", msg: string) => void;

// Network self-check. Two control targets on different providers, fetched
// through the same guarded path as tenant checks (public resolvers, SSRF
// guard, pinned IP, SNI). Both are names, so a round also proves the
// prober's DNS works: with DNS broken every check would fail, and those
// failures would read as outages of every target. Any HTTP answer from either
// one passes; both failing means this host cannot measure.
export const PROBER_CONTROL_URLS = ["https://www.gstatic.com/generate_204", "https://one.one.one.one/cdn-cgi/trace"];
export const PROBER_SELF_CHECK_MS = 15_000;

export async function proberNetworkOk(deps: ProberDeps, controls: readonly string[] = PROBER_CONTROL_URLS): Promise<boolean> {
  const reached = (r: ProbeResult) => r.value !== null || String(r.reason ?? "").startsWith("unexpected_status");
  // The first control that answers decides; one hung control does not hold
  // the round once the other has passed.
  return await new Promise<boolean>((resolve) => {
    let pending = controls.length;
    if (pending === 0) return resolve(false);
    for (const url of controls) {
      proberHttp({ url, method: "GET", timeout_ms: 5_000, expected_status: [200, 204] } as never, deps)
        .then((r) => {
          if (reached(r)) resolve(true);
        })
        .catch(() => {})
        .finally(() => {
          if (--pending === 0) resolve(false);
        });
    }
  });
}

export interface ProberHandle {
  refreshOnce(): Promise<void>;
  runDue(): Promise<void>;
  flushOnce(): Promise<void>;
  /** One network self-check round (no-op without opts.selfCheck). */
  selfCheckOnce(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  /** Introspection for tests and the boot log. */
  state(): { location: string | null; checks: number; queued: number; refused: boolean; networkOk: boolean };
  /** The self-report sent in the Prober-Health header. */
  health(): ProberHealth;
  /**
   * One watchdog round: a reason to exit once the same problem has lasted
   * WATCHDOG_STRIKES rounds, else null.
   */
  watchdog(): string | null;
}

export function createProber(
  cfg: ProberConfig,
  deps: ProberDeps,
  opts: {
    fetch?: typeof fetch;
    now?: () => number;
    random?: () => number;
    log?: Log;
    /**
     * Network self-check (proberNetworkOk in production). When set, a result
     * is sent only once a later self-check round has passed, so results taken
     * while the host network was down are dropped instead of reported. Unset,
     * every result is sent as soon as it is ready.
     */
    selfCheck?: () => Promise<boolean>;
    /** Resident memory in bytes (process.memoryUsage().rss in production). */
    rss?: () => number;
    /** Called about every 10 s while the event loop runs (k8s liveness file). */
    heartbeat?: () => void;
    /** Test seam: shorter hard deadlines (ms). */
    deadlines?: { check?: number; selfCheck?: number; cloud?: number };
  } = {},
): ProberHandle {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? monotonicNow;
  const checkDeadlineMs = opts.deadlines?.check ?? CHECK_DEADLINE_MS;
  const selfCheckDeadlineMs = opts.deadlines?.selfCheck ?? SELF_CHECK_DEADLINE_MS;
  const cloudDeadlineMs = opts.deadlines?.cloud ?? CLOUD_CALL_DEADLINE_MS;
  const random = opts.random ?? Math.random;
  const log: Log = opts.log ?? ((level, msg) => console.log(`[${level}] [prober] ${msg}`));

  const scheduled = new Map<string, Scheduled>();
  // `at` = when the result was ready. Only results ready at or before the
  // start of the last passing self-check round (`verifiedAt`) are sent.
  let queue: Array<{ item: ProberResultItem; at: number }> = [];
  let verifiedAt = opts.selfCheck ? -Infinity : Infinity;
  let networkOk = true;
  let version: string | null = null;
  let location: string | null = null;
  let refused = false;
  let inflight = 0;
  let initialLoad = true;
  let flushBackoffMs = 0;
  let nextFlushAt = 0;
  let droppedTotal = 0;
  let stuckTotal = 0;
  let stuckLoggedAt = -Infinity;
  // Each of these runs on its own interval; a slow round must not overlap
  // the next one (two flushes would send, then drop, the same batch).
  let refreshing = false;
  let flushing = false;
  let selfChecking = false;
  const startedAt = now();
  let lastResultAt: number | null = null;
  // Event-loop delay: worst lateness of the 1 s tick per 10 s bucket, last 6 buckets.
  const lagBuckets: number[] = [0];
  let lagBucketStartedAt = startedAt;
  let expectedTickAt = startedAt + 1_000;
  let abandoned = 0;
  let skippedTotal = 0;
  let skewS = 0;
  let schedLagPrev = 0;
  let schedLagCur = 0;
  let schedLagWindowAt = startedAt;
  let lastHeartbeatAt = -Infinity;
  let queueFullLoggedAt = -Infinity;
  let strikes = 0;
  let strikeReason: string | null = null;
  const rss = opts.rss ?? (() => process.memoryUsage().rss);
  const challengeLoggedAt = new Map<string, number>();
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const running = new Set<Promise<void>>();

  const baseHeaders = (): Record<string, string> => ({
    [PROBER_KEY_HEADER]: cfg.key,
    [PROBER_VERSION_HEADER]: cfg.version,
    [PROBER_CAPABILITIES_HEADER]: deps.icmpEnabled ? "icmp" : "",
    // The cloud counts this location as live only while a prober says "ok".
    [PROBER_STATE_HEADER]: refused ? "refused" : networkOk ? "ok" : "network_down",
    [PROBER_HEALTH_HEADER]: formatProberHealth(health()),
  });

  function maxLagMs(): number {
    return Math.max(0, ...lagBuckets);
  }

  function health(): ProberHealth {
    const t = now();
    return {
      rss_mb: rss() / 1_048_576,
      lag_ms: maxLagMs(),
      queued: queue.length,
      inflight,
      stuck: stuckTotal,
      abandoned,
      skipped: skippedTotal,
      dropped: droppedTotal,
      sched_lag_ms: Math.max(schedLagPrev, schedLagCur),
      skew_s: skewS,
      result_age_s: lastResultAt === null ? -1 : (t - lastResultAt) / 1000,
      uptime_s: (t - startedAt) / 1000,
    };
  }

  function tickLag(): void {
    const t = now();
    const late = Math.max(0, t - expectedTickAt);
    expectedTickAt = t + 1_000;
    if (t - lagBucketStartedAt >= 10_000) {
      lagBuckets.push(0);
      if (lagBuckets.length > 6) lagBuckets.shift();
      lagBucketStartedAt = t;
    }
    lagBuckets[lagBuckets.length - 1] = Math.max(lagBuckets[lagBuckets.length - 1], late);
    if (opts.heartbeat && t - lastHeartbeatAt >= 10_000) {
      lastHeartbeatAt = t;
      try {
        opts.heartbeat();
      } catch {
        /* a failed heartbeat write shows up as a failed liveness probe */
      }
    }
  }

  function recordSchedLag(lateMs: number): void {
    const t = now();
    if (t - schedLagWindowAt >= 60_000) {
      schedLagPrev = schedLagCur;
      schedLagCur = 0;
      schedLagWindowAt = t;
    }
    schedLagCur = Math.max(schedLagCur, lateMs);
  }

  function unhealthy(): string | null {
    const t = now();
    const mb = rss() / 1_048_576;
    if (mb > cfg.maxRssMb) return `resident memory ${Math.round(mb)} MB is above PROBER_MAX_RSS_MB=${cfg.maxRssMb}`;
    const lag = maxLagMs();
    if (lag > WATCHDOG_MAX_LAG_MS) return `the event loop ran ${Math.round(lag / 1000)} s late`;
    if (abandoned > WATCHDOG_MAX_ABANDONED) return `${abandoned} abandoned checks have still not finished`;
    if (scheduled.size > 0 && networkOk && !refused) {
      let longest = 0;
      for (const s of scheduled.values()) longest = Math.max(longest, Math.max(1, Number(s.check.interval) || 1) * 60_000);
      const allowed = Math.max(WATCHDOG_NO_RESULT_MIN_MS, 3 * longest);
      const since = lastResultAt ?? startedAt;
      if (t - since > allowed) return `no check produced a result for ${Math.round((t - since) / 60_000)} min`;
    }
    return null;
  }

  function watchdog(): string | null {
    const reason = unhealthy();
    if (!reason) {
      strikes = 0;
      strikeReason = null;
      return null;
    }
    strikes = strikeReason === null || strikes === 0 ? 1 : strikes + 1;
    strikeReason = reason;
    if (strikes < WATCHDOG_STRIKES) {
      log("WARN", `watchdog: ${reason} (${strikes}/${WATCHDOG_STRIKES})`);
      return null;
    }
    return reason;
  }

  async function refreshOnce(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      await withDeadline(refreshInner(), cloudDeadlineMs, "checks fetch");
    } catch {
      log("WARN", "checks fetch did not finish in time; keeping the current set");
    } finally {
      refreshing = false;
    }
  }

  async function refreshInner(): Promise<void> {
    let res: Response;
    try {
      res = await doFetch(`${cfg.cloudUrl}${PROBER_CHECKS_PATH}`, {
        headers: { ...baseHeaders(), ...(version ? { "If-None-Match": version } : {}) },
        signal: AbortSignal.timeout(20_000),
        // Never follow a redirect with the prober key (fetch keeps custom
        // headers across origins and allows an https to http downgrade).
        redirect: "error",
      });
    } catch {
      log("WARN", "checks fetch failed (network); keeping the current set");
      return;
    }
    // Clock skew against the cloud (whole seconds; the Date header has no
    // finer resolution). Results more than 2 minutes ahead are rejected.
    const cloudDate = Date.parse(res.headers.get("date") ?? "");
    if (Number.isFinite(cloudDate)) skewS = Math.round((Date.now() - cloudDate) / 1000);
    if (res.status === 304) return;
    if (!res.ok) {
      log(res.status === 401 ? "ERROR" : "WARN", `checks fetch returned ${res.status}; keeping the current set`);
      void res.body?.cancel().catch(() => {});
      return;
    }
    let body: ProberChecksResponse;
    try {
      body = (await res.json()) as ProberChecksResponse;
    } catch {
      log("WARN", "checks response was not JSON");
      return;
    }
    if (!body || typeof body !== "object") {
      log("WARN", "checks response was not an object");
      return;
    }
    if (cfg.expectedLocation && body.location !== cfg.expectedLocation) {
      // Credential installed on the wrong host: running would attribute
      // results to the wrong region. Refuse until fixed.
      if (!refused) {
        log("ERROR", `this credential belongs to location "${body.location}", but PROBER_LOCATION is "${cfg.expectedLocation}". Not running checks.`);
      }
      refused = true;
      scheduled.clear();
      return;
    }
    refused = false;
    location = body.location;
    version = res.headers.get(PROBER_CHECKS_VERSION_HEADER) ?? body.version ?? null;
    const seen = new Set<string>();
    const t = now();
    for (const check of Array.isArray(body.checks) ? body.checks : []) {
      if (!check?.id) continue;
      seen.add(check.id);
      const hash = JSON.stringify(check);
      const existing = scheduled.get(check.id);
      if (existing) {
        if (existing.hash !== hash) {
          const oldMs = Math.max(1, Number(existing.check.interval) || 1) * 60_000;
          const newMs = Math.max(1, Number(check.interval) || 1) * 60_000;
          existing.check = check;
          existing.hash = hash;
          // A shorter interval takes effect now, not after the old one runs out.
          if (newMs < oldMs) existing.nextRunAt = Math.min(existing.nextRunAt, t + newMs);
        }
        continue;
      }
      // Spread the first run: a fresh boot jitters across the interval (no
      // thundering herd); a check added later runs within seconds so a new
      // org sees a live result fast.
      const intervalMs = Math.max(1, Number(check.interval) || 1) * 60_000;
      const spread = initialLoad ? Math.min(intervalMs, 60_000) : 3_000;
      scheduled.set(check.id, { check, hash, nextRunAt: t + Math.floor(random() * spread), running: false });
    }
    for (const id of [...scheduled.keys()]) {
      if (seen.has(id)) continue;
      scheduled.delete(id);
      challengeLoggedAt.delete(id);
    }
    initialLoad = false;
  }

  function enqueue(item: ProberResultItem): void {
    queue.push({ item, at: now() });
    lastResultAt = now();
    if (queue.length > cfg.queueMax) {
      // Drop a tenth at once (not one per result) so a long cloud outage
      // does not copy the whole queue on every new result.
      const drop = queue.length - cfg.queueMax + Math.floor(cfg.queueMax / 10);
      queue = queue.slice(drop);
      droppedTotal += drop;
      if (now() - queueFullLoggedAt >= 10 * 60_000) {
        queueFullLoggedAt = now();
        log("WARN", `result queue full; dropped the ${drop} oldest (total ${droppedTotal})`);
      }
    }
  }

  async function selfCheckOnce(): Promise<void> {
    if (!opts.selfCheck || selfChecking) return;
    selfChecking = true;
    try {
      await selfCheckRound(opts.selfCheck);
    } finally {
      selfChecking = false;
    }
  }

  async function selfCheckRound(selfCheck: () => Promise<boolean>): Promise<void> {
    const roundStartedAt = now();
    let ok = false;
    try {
      // A round that never settles counts as failed.
      ok = await withDeadline(selfCheck(), selfCheckDeadlineMs, "network self-check");
    } catch {
      ok = false;
    }
    if (ok) {
      verifiedAt = Math.max(verifiedAt, roundStartedAt);
      if (!networkOk) log("INFO", "network self-check passed again; running checks");
      networkOk = true;
      return;
    }
    // Results not yet covered by a passing round may have been taken while
    // the network was already down: drop them rather than report outages.
    const keep = queue.filter((q) => q.at <= verifiedAt);
    const dropped = queue.length - keep.length;
    queue = keep;
    if (networkOk) {
      log(
        "ERROR",
        `network self-check failed (no control target reachable); pausing checks and dropping ${dropped} unverified result(s)`,
      );
    }
    networkOk = false;
  }

  async function runDue(): Promise<void> {
    if (refused || !networkOk) return;
    const t = now();
    const batch: Promise<void>[] = [];
    // Most overdue first, so a saturated prober spreads the lateness.
    const due = [...scheduled.values()].filter((s) => !s.running && s.nextRunAt <= t).sort((a, b) => a.nextRunAt - b.nextRunAt);
    for (const s of due) {
      if (inflight >= cfg.concurrency) break;
      recordSchedLag(t - s.nextRunAt);
      s.running = true;
      inflight++;
      const intervalMs = Math.max(1, Number(s.check.interval) || 1) * 60_000;
      s.nextRunAt = t + intervalMs;
      const run = runProberCheck(s.check, deps);
      const p = withDeadline(run, checkDeadlineMs, "check")
        .then((item) => {
          // Dropped from the set mid-run (deleted / reassigned): discard.
          if (scheduled.get(s.check.id) !== s) return;
          // Finished while this process ran late: the timing measured the
          // prober, so the result is not sent.
          if (lagBuckets[lagBuckets.length - 1] > SKIP_RESULT_LAG_MS) {
            skippedTotal++;
            return;
          }
          // A bot-challenge page says nothing about the target: the result is
          // sent with reason bot_challenge, which the cloud keeps as evidence
          // but leaves out of the verdict (PROBER_ABSTAIN_REASONS), so the
          // check's other locations decide.
          if (item.reason === BOT_CHALLENGE_REASON) {
            const last = challengeLoggedAt.get(s.check.id) ?? -Infinity;
            if (now() - last >= 60 * 60_000) {
              challengeLoggedAt.set(s.check.id, now());
              log("WARN", `check ${s.check.id} got a bot-challenge page; this location abstains from its verdict`);
            }
          }
          enqueue(item);
        })
        .catch((e) => {
          // Abandoned at its hard deadline: a prober fault, not a target
          // outage, so no result is sent for this run. The slot is freed so
          // the check runs again on its next interval.
          if (!(e instanceof DeadlineError)) return;
          stuckTotal++;
          abandoned++;
          void run
            .catch(() => {})
            .finally(() => {
              abandoned--;
            });
          if (now() - stuckLoggedAt >= 10 * 60_000) {
            stuckLoggedAt = now();
            log("WARN", `a check did not finish within ${checkDeadlineMs / 1000} s and was abandoned (${stuckTotal} since start)`);
          }
        })
        .finally(() => {
          s.running = false;
          inflight--;
          running.delete(p);
        });
      running.add(p);
      batch.push(p);
    }
    await Promise.all(batch);
  }

  async function flushOnce(): Promise<void> {
    if (flushing || queue.length === 0 || now() < nextFlushAt) return;
    flushing = true;
    try {
      await withDeadline(flushInner(), cloudDeadlineMs, "result post");
    } catch {
      backoff("did not finish in time");
    } finally {
      flushing = false;
    }
  }

  // Remove exactly the entries that were sent. The queue can change while a
  // post is in flight (oldest dropped when full, unverified dropped by a
  // failed self-check), so slicing by count could drop unsent results.
  function removeSent(sent: ReadonlySet<{ item: ProberResultItem; at: number }>): void {
    queue = queue.filter((q) => !sent.has(q));
  }

  async function flushInner(): Promise<void> {
    let ready = 0;
    while (ready < queue.length && ready < PROBER_RESULTS_MAX_BATCH && queue[ready].at <= verifiedAt) ready++;
    if (ready === 0) return;
    const entries = queue.slice(0, ready);
    const sent = new Set(entries);
    const batch = entries.map((q) => q.item);
    let res: Response;
    try {
      res = await doFetch(`${cfg.cloudUrl}${PROBER_RESULTS_PATH}`, {
        method: "POST",
        headers: { ...baseHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ results: batch }),
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
      });
    } catch {
      backoff("network error");
      return;
    }
    if (res.ok) {
      removeSent(sent);
      flushBackoffMs = 0;
      nextFlushAt = 0;
      try {
        const body = (await res.json()) as ProberResultsResponse;
        if (body?.rejected?.length) {
          const reasons = [...new Set(body.rejected.map((r) => r.error))].join(", ");
          log("WARN", `cloud rejected ${body.rejected.length}/${batch.length} results (${reasons})`);
        }
      } catch {
        /* body is informational */
      }
      return;
    }
    void res.body?.cancel().catch(() => {});
    if (res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403) {
      backoff(`HTTP ${res.status}`);
      return;
    }
    // Any other 4xx is permanent for this batch (malformed / too large).
    removeSent(sent);
    log("WARN", `cloud refused a result batch with ${res.status}; dropped ${batch.length}`);
  }

  function backoff(why: string): void {
    flushBackoffMs = Math.min(60_000, flushBackoffMs ? flushBackoffMs * 2 : 2_000);
    nextFlushAt = now() + flushBackoffMs;
    log("WARN", `result post failed (${why}); retrying in ${Math.round(flushBackoffMs / 1000)}s`);
  }

  return {
    refreshOnce,
    runDue,
    flushOnce,
    selfCheckOnce,
    start() {
      void selfCheckOnce()
        .then(() => refreshOnce())
        .then(() => runDue());
      if (opts.selfCheck) timers.push(setInterval(() => void selfCheckOnce(), PROBER_SELF_CHECK_MS));
      timers.push(setInterval(() => void refreshOnce(), cfg.refreshMs));
      timers.push(setInterval(() => void runDue(), 1_000));
      timers.push(setInterval(tickLag, 1_000));
      timers.push(setInterval(() => void flushOnce(), cfg.flushMs));
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      // Bounded: a check that never settles must not cost the final flush.
      await Promise.race([Promise.allSettled([...running]), new Promise((r) => setTimeout(r, STOP_WAIT_CHECKS_MS))]);
      // Best effort: verify what was measured since the last round (bounded),
      // then one last flush of verified results so a restart loses little.
      await withDeadline(selfCheckOnce(), STOP_SELF_CHECK_MS, "final self-check").catch(() => {});
      nextFlushAt = 0;
      await flushOnce().catch(() => {});
    },
    state: () => ({ location, checks: scheduled.size, queued: queue.length, refused, networkOk }),
    health,
    watchdog,
  };
}

/** Public page that explains the prober's traffic to target owners (useobserver/docs). */
export const PROBER_INFO_URL = "https://docs.use.observer/docs/guides/outside-in-checks";

export function proberUserAgent(version: string): string {
  return `ObserverProber/${version} (+${PROBER_INFO_URL})`;
}

export function buildDeps(cfg: ProberConfig, icmpEnabled: boolean): ProberDeps {
  return {
    resolve: createResolver(cfg.dnsServers),
    dnsServers: cfg.dnsServers,
    icmpEnabled,
    userAgent: proberUserAgent(cfg.version),
  };
}
