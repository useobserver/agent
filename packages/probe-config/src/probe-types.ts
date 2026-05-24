// PROBE_TYPES — canonical list of source_type values. Keep aligned
// with the cloud's persistence-layer enum; drift causes inserts that
// pass app validation to fail at storage time.

export const PROBE_TYPES = Object.freeze([
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
  "otlp",
  "cloudwatch",
  "custom",
  "loki",
  "elasticsearch",
  "manual",
] as const);

export type ProbeType = (typeof PROBE_TYPES)[number];
