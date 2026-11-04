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
  "host",
  // Cloud metric sources (agent 1.8.0): read one value from Datadog, Google
  // Cloud Monitoring (PromQL) or Azure Monitor with credentials that stay on
  // the agent host.
  "datadog",
  "gcp_monitoring",
  "azure_monitor",
  "manual",
  // Cloud-evaluated, agentless: jobs ping a per-check URL and the cloud
  // flags them late / failed (apps/web lib/heartbeat).
  "heartbeat",
  // Cloud-evaluated, agentless: status derived from inbound alerts
  // (Alertmanager, Grafana, Datadog, CloudWatch, generic JSON) routed by the
  // cloud's intake rules (apps/web lib/alert-intake). Never sent to an agent.
  "alert",
] as const);

export type ProbeType = (typeof PROBE_TYPES)[number];
