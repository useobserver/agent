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
  PROBER_KEY_HEADER,
  PROBER_KEY_PREFIX,
  PROBER_RESULTS_MAX_BATCH,
  PROBER_RESULTS_PATH,
  PROBER_VERSION_HEADER,
  type ProberCheck,
  type ProberChecksResponse,
  type ProberResultItem,
  type ProberResultsResponse,
} from "@observer/protocol";
import icmpSource from "../sources/icmp.ts";
import { createResolver, parseDnsServers } from "./guard.ts";
import { runProberCheck } from "./runner.ts";
import type { ProberDeps } from "./sources.ts";

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
      version,
    },
  };
}

/** Can this host send ICMP? One loopback ping (our own process, not a tenant target). */
export async function detectIcmp(): Promise<boolean> {
  const r = await icmpSource.execute({ host: "127.0.0.1", count: 1, timeout_ms: 1000, interpretation: "reachability" });
  return r.value === 1;
}

interface Scheduled {
  check: ProberCheck;
  hash: string;
  nextRunAt: number;
  running: boolean;
}

type Log = (level: "INFO" | "WARN" | "ERROR", msg: string) => void;

export interface ProberHandle {
  refreshOnce(): Promise<void>;
  runDue(): Promise<void>;
  flushOnce(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  /** Introspection for tests and the boot log. */
  state(): { location: string | null; checks: number; queued: number; refused: boolean };
}

export function createProber(
  cfg: ProberConfig,
  deps: ProberDeps,
  opts: { fetch?: typeof fetch; now?: () => number; random?: () => number; log?: Log } = {},
): ProberHandle {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const log: Log = opts.log ?? ((level, msg) => console.log(`[${level}] [prober] ${msg}`));

  const scheduled = new Map<string, Scheduled>();
  let queue: ProberResultItem[] = [];
  let version: string | null = null;
  let location: string | null = null;
  let refused = false;
  let inflight = 0;
  let initialLoad = true;
  let flushBackoffMs = 0;
  let nextFlushAt = 0;
  let droppedTotal = 0;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const running = new Set<Promise<void>>();

  const baseHeaders = (): Record<string, string> => ({
    [PROBER_KEY_HEADER]: cfg.key,
    [PROBER_VERSION_HEADER]: cfg.version,
    [PROBER_CAPABILITIES_HEADER]: deps.icmpEnabled ? "icmp" : "",
  });

  async function refreshOnce(): Promise<void> {
    let res: Response;
    try {
      res = await doFetch(`${cfg.cloudUrl}${PROBER_CHECKS_PATH}`, {
        headers: { ...baseHeaders(), ...(version ? { "If-None-Match": version } : {}) },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      log("WARN", "checks fetch failed (network); keeping the current set");
      return;
    }
    if (res.status === 304) return;
    if (!res.ok) {
      log(res.status === 401 ? "ERROR" : "WARN", `checks fetch returned ${res.status}; keeping the current set`);
      await res.body?.cancel().catch(() => {});
      return;
    }
    let body: ProberChecksResponse;
    try {
      body = (await res.json()) as ProberChecksResponse;
    } catch {
      log("WARN", "checks response was not JSON");
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
          existing.check = check;
          existing.hash = hash;
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
    for (const id of [...scheduled.keys()]) if (!seen.has(id)) scheduled.delete(id);
    initialLoad = false;
  }

  function enqueue(item: ProberResultItem): void {
    queue.push(item);
    if (queue.length > cfg.queueMax) {
      const drop = queue.length - cfg.queueMax;
      queue = queue.slice(drop);
      droppedTotal += drop;
      log("WARN", `result queue full; dropped ${drop} oldest (total ${droppedTotal})`);
    }
  }

  async function runDue(): Promise<void> {
    if (refused) return;
    const t = now();
    const batch: Promise<void>[] = [];
    for (const s of scheduled.values()) {
      if (inflight >= cfg.concurrency) break;
      if (s.running || s.nextRunAt > t) continue;
      s.running = true;
      inflight++;
      const intervalMs = Math.max(1, Number(s.check.interval) || 1) * 60_000;
      s.nextRunAt = t + intervalMs;
      const p = runProberCheck(s.check, deps)
        .then((item) => {
          // Dropped from the set mid-run (deleted / reassigned): discard.
          if (scheduled.get(s.check.id) === s) enqueue(item);
        })
        .catch(() => {})
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
    if (queue.length === 0 || now() < nextFlushAt) return;
    const batch = queue.slice(0, PROBER_RESULTS_MAX_BATCH);
    let res: Response;
    try {
      res = await doFetch(`${cfg.cloudUrl}${PROBER_RESULTS_PATH}`, {
        method: "POST",
        headers: { ...baseHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ results: batch }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      backoff("network error");
      return;
    }
    if (res.ok) {
      queue = queue.slice(batch.length);
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
    await res.body?.cancel().catch(() => {});
    if (res.status === 429 || res.status >= 500 || res.status === 401 || res.status === 403) {
      backoff(`HTTP ${res.status}`);
      return;
    }
    // Any other 4xx is permanent for this batch (malformed / too large).
    queue = queue.slice(batch.length);
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
    start() {
      void refreshOnce().then(() => runDue());
      timers.push(setInterval(() => void refreshOnce(), cfg.refreshMs));
      timers.push(setInterval(() => void runDue(), 1_000));
      timers.push(setInterval(() => void flushOnce(), cfg.flushMs));
    },
    async stop() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      await Promise.allSettled([...running]);
      // Best effort: one last flush so a rolling restart loses little.
      nextFlushAt = 0;
      await flushOnce().catch(() => {});
    },
    state: () => ({ location, checks: scheduled.size, queued: queue.length, refused }),
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
