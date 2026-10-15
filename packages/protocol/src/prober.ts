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
