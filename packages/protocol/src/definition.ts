// Metric definition: the projection the cloud sends to the agent
// over /api/agent/metrics-definitions. Wire contract.

// Every source type an agent runs. PROBE_TYPES (@observer/probe-config) is
// this list plus the cloud-evaluated types (CLOUD_EVALUATED_SOURCE_TYPES in
// ./agent-compat); a test keeps the two aligned.
export const AGENT_SOURCE_TYPES = Object.freeze([
  "prometheus",
  "http",
  "tcp",
  "dns",
  "tls_cert",
  "icmp",
  "grpc",
  "websocket",
  "mtls_http",
  "database",
  "otlp",
  "cloudwatch",
  "custom",
  "loki",
  "elasticsearch",
  "host",
] as const);

export type SourceType = (typeof AGENT_SOURCE_TYPES)[number];

export interface MetricDefinition {
  id: string;
  source_type?: SourceType;
  source_config?: Record<string, unknown>;
  query?: string;
  interval: number;
  interval_agent_push: number;
  healthy_operation: "over" | "under" | "equal";
  healthy_value: number | string;
  unhealthy_operation: "over" | "under" | "equal";
  unhealthy_value: number | string;
  agent_id?: string | null;
}

// Response header on GET /api/agent/metrics-definitions carrying the
// definitions version of the returned set (see HeartbeatResponse.
// definitions_version). Lowercase: fetch Headers lookups are
// case-insensitive, and this is what HTTP/2 puts on the wire anyway.
export const DEFINITIONS_VERSION_HEADER = "x-observer-definitions-version";
