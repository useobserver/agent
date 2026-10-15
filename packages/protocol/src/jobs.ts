// agent job queue wire contract (cloud ↔ agent).
//
// The console enqueues a typed job bound to one agent (apps/web
// lib/agent-jobs, table agent_jobs). The agent polls
// GET AGENT_JOBS_CLAIM_PATH?kinds=<comma list>, runs each claimed job on
// its own network, and POSTs the outcome to agentJobResultPath(id).
//
// Compatibility rules:
//   - The agent names the kinds it can run in `kinds`; the cloud only
//     hands out those. A job of a kind the agent does not know (an old
//     agent against a newer cloud that ignored the filter) is answered
//     with { ok: false, error: "unsupported_kind" } and never executed.
//   - Every response field is additive; both sides tolerate absent fields.
//   - An agent that gets 404 from the claim path is talking to a cloud
//     that predates the queue and falls back to the legacy pollers.
//
// Privacy (probe_test): the result is one number, a verdict, a latency
// and a reason CODE. Never response bodies, rows, log lines, headers or
// error messages (driver errors can embed DSNs and tokens).
// sanitizeProbeTestResult is applied by the agent before sending AND by the
// cloud on receipt.

import type { ProbeStatus } from "./push";

export const AGENT_JOBS_CLAIM_PATH = "/api/agent/work/jobs";

export function agentJobResultPath(id: string): string {
  return `${AGENT_JOBS_CLAIM_PATH}/${encodeURIComponent(id)}/result`;
}

export const AGENT_JOB_KINDS = ["probe_test", "cloudwatch_list_metrics"] as const;
export type AgentJobKind = (typeof AGENT_JOB_KINDS)[number];

export function isAgentJobKind(v: unknown): v is AgentJobKind {
  return typeof v === "string" && (AGENT_JOB_KINDS as readonly string[]).includes(v);
}

// Source types a probe_test may run. custom is excluded (operator code on
// the agent host), push sources (otlp) have no one-shot read, and manual /
// heartbeat never run on an agent.
export const PROBE_TEST_SOURCE_TYPES = [
  "prometheus",
  "http",
  "tcp",
  "dns",
  "icmp",
  "tls_cert",
  "grpc",
  "websocket",
  "mtls_http",
  "database",
  "cloudwatch",
  "loki",
  "elasticsearch",
  "host",
] as const;
export type ProbeTestSourceType = (typeof PROBE_TEST_SOURCE_TYPES)[number];

export function isProbeTestSourceType(v: unknown): v is ProbeTestSourceType {
  return typeof v === "string" && (PROBE_TEST_SOURCE_TYPES as readonly string[]).includes(v);
}

// Hard ceiling for one probe test on the agent. The cloud's job TTL is
// longer so a slow probe still reports before the row expires.
export const PROBE_TEST_TIMEOUT_MS = 30_000;

export interface ProbeTestPayload {
  source_type: ProbeTestSourceType;
  source_config: Record<string, unknown>;
  healthy_operation: "over" | "under" | "equal" | null;
  healthy_value: number | null;
  unhealthy_operation: "over" | "under" | "equal" | null;
  unhealthy_value: number | null;
}

export interface ProbeTestResult {
  value: number | null;
  verdict: ProbeStatus;
  latency_ms: number;
  reason: string | null;
}

export interface CloudwatchListMetricsPayload {
  region: string;
  namespace: string | null;
  role_arn: string | null;
  external_id: string | null;
}

export interface CloudwatchListMetricsResult {
  metrics: Array<{ metric_name: string; dimensions: Array<{ name: string; value: string }> }>;
}

export interface AgentJob<K extends string = string, P = unknown> {
  id: string;
  kind: K;
  payload: P;
}

// GET AGENT_JOBS_CLAIM_PATH response.
export interface AgentJobsClaimResponse {
  jobs: AgentJob[];
  // Cloud-tuned delay before the next poll (ms). Agents clamp it; absent →
  // agent default.
  next_poll_ms?: number;
}

// POST agentJobResultPath(id) body.
export type AgentJobResultBody =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

const VERDICTS: ReadonlySet<string> = new Set(["healthy", "degraded", "unhealthy", "no_data"]);
// Reason codes are short machine tokens ("ETIMEDOUT", "unexpected_status:503",
// "invalid_config"). Anything else (free text that could carry a URL, DSN or
// token) collapses to a generic code.
const REASON_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function sanitizeReasonCode(v: unknown, fallback = "probe_failed"): string {
  if (typeof v !== "string") return fallback;
  return REASON_RE.test(v) ? v : fallback;
}

/**
 * Coerce anything into the privacy-safe probe_test result shape. Unknown
 * keys are dropped; a non-finite value becomes null with verdict no_data.
 */
export function sanitizeProbeTestResult(raw: unknown): ProbeTestResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = typeof r.value === "number" && Number.isFinite(r.value) ? r.value : null;
  let verdict = typeof r.verdict === "string" && VERDICTS.has(r.verdict) ? (r.verdict as ProbeStatus) : "no_data";
  if (num === null) verdict = "no_data";
  const latency =
    typeof r.latency_ms === "number" && Number.isFinite(r.latency_ms) && r.latency_ms >= 0
      ? Math.min(Math.round(r.latency_ms), 3_600_000)
      : 0;
  const reason = r.reason === null || r.reason === undefined ? null : sanitizeReasonCode(r.reason);
  return { value: num, verdict, latency_ms: latency, reason: verdict === "no_data" ? (reason ?? "no_data") : reason };
}
