// Managed prober wire contract: Observer-operated probers fetch outside-in
// (hosted) checks across orgs and post per-location results. Separate from
// the org agent channel: its own credential (obs_prb_ prefix, sha256-hashed
// in the cloud, env var on the prober host), its own endpoints, and the
// cloud derives the location from the credential, never from the payload.

import type { Operation, ProbeStatus } from "./push";

export const PROBER_CHECKS_PATH = "/api/prober/checks";
export const PROBER_RESULTS_PATH = "/api/prober/results";

/** Request header carrying the prober credential. */
export const PROBER_KEY_HEADER = "Prober-Key";
/** Credential prefix; 32 random bytes base64url follow. */
export const PROBER_KEY_PREFIX = "obs_prb_";
/** Comma-separated optional capabilities, e.g. "icmp". */
export const PROBER_CAPABILITIES_HEADER = "Prober-Capabilities";
/** Prober software version (agent package version). */
export const PROBER_VERSION_HEADER = "Prober-Version";
/**
 * Prober health as the prober sees it (agent 1.8.2+): "ok", "network_down"
 * (its network self-check is failing; it is not measuring) or "refused" (it
 * will not run checks, e.g. its location does not match PROBER_LOCATION).
 * Absent means ok. The cloud counts a location as live only while one of its
 * probers reports ok.
 */
export const PROBER_STATE_HEADER = "Prober-State";
export const PROBER_STATES = ["ok", "network_down", "refused"] as const;
export type ProberState = (typeof PROBER_STATES)[number];

/**
 * Prober self-report (agent 1.8.4+), sent on every request so the cloud can
 * export it and Grafana can alert before a prober degrades into silence.
 * Format: `key=value` pairs joined by "; ", integers only, unknown keys
 * ignored, absent from older probers:
 *   rss_mb        resident memory
 *   lag_ms        worst event-loop delay over the last minute
 *   queued        results waiting to be sent
 *   inflight      checks running now
 *   stuck         checks abandoned at their hard deadline since start
 *   abandoned     abandoned checks whose work has still not settled
 *   skipped       results not sent because the process was running late
 *   dropped       results dropped (queue full) since start
 *   sched_lag_ms  worst lateness of a check's start over the last minute
 *   result_age_s  seconds since the last result was produced (-1 = none yet)
 *   skew_s        prober clock minus the cloud's Date header, in seconds
 *   uptime_s      seconds since the process started
 */
export const PROBER_HEALTH_HEADER = "Prober-Health";
export const PROBER_HEALTH_KEYS = [
  "rss_mb",
  "lag_ms",
  "queued",
  "inflight",
  "stuck",
  "abandoned",
  "skipped",
  "dropped",
  "sched_lag_ms",
  "result_age_s",
  "skew_s",
  "uptime_s",
] as const;
export type ProberHealthKey = (typeof PROBER_HEALTH_KEYS)[number];
export type ProberHealth = Partial<Record<ProberHealthKey, number>>;

/** Encode a health report for PROBER_HEALTH_HEADER. Non-finite values are left out. */
export function formatProberHealth(h: ProberHealth): string {
  return PROBER_HEALTH_KEYS.filter((k) => Number.isFinite(h[k]))
    .map((k) => `${k}=${Math.round(h[k] as number)}`)
    .join("; ");
}

/** Parse PROBER_HEALTH_HEADER leniently: known keys, integers in [-1e6, 1e9], at most 512 chars. */
export function parseProberHealth(raw: string | null | undefined): ProberHealth | null {
  if (!raw || raw.length > 512) return null;
  const out: ProberHealth = {};
  for (const part of raw.split(";")) {
    const m = /^\s*([a-z_]{1,32})=(-?\d{1,10})\s*$/.exec(part);
    if (!m) continue;
    const key = m[1] as ProberHealthKey;
    if (!(PROBER_HEALTH_KEYS as readonly string[]).includes(key)) continue;
    const n = Number(m[2]);
    if (n >= -1e6 && n <= 1e9) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Result reasons that mean "this location could not measure the target, and
 * that is not the target failing" (agent 1.8.2+). The cloud stores such a
 * result as evidence but leaves it out of the location verdict, so the
 * check's other locations decide.
 */
export const PROBER_ABSTAIN_REASONS = ["bot_challenge"] as const;

/** Version of the returned check set; send back as If-None-Match for a 304. */
export const PROBER_CHECKS_VERSION_HEADER = "x-observer-prober-checks-version";

/** Most result items accepted in one POST. */
export const PROBER_RESULTS_MAX_BATCH = 500;

export type ProberSourceType = "http" | "tcp" | "dns" | "tls_cert" | "icmp";

export interface ProberCheck {
  id: string;
  source_type: ProberSourceType;
  source_config: Record<string, unknown>;
  /** Poll interval in minutes. */
  interval: number;
  healthy_operation: Operation;
  healthy_value: number | string;
  unhealthy_operation: Operation;
  unhealthy_value: number | string;
}

export interface ProberChecksResponse {
  location: string;
  version: string;
  checks: ProberCheck[];
}

export interface ProberResultItem {
  metric_id: string;
  value: number;
  timestamp: string;
  status: ProbeStatus | string;
  reason?: string;
}

export interface ProberResultsRequest {
  results: ProberResultItem[];
}

export interface ProberResultsResponse {
  accepted: number;
  /** Per-item rejections by index into `results`; never retried. */
  rejected: Array<{ index: number; error: string }>;
}
