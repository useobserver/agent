// Metric definition: the projection the cloud sends to the agent
// over /api/agent/metrics-definitions. Wire contract.

export type SourceType =
  | "prometheus"
  | "http"
  | "tcp"
  | "dns"
  | "tls_cert"
  | "icmp"
  | "grpc"
  | "websocket"
  | "mtls_http"
  | "database"
  | "otlp"
  | "cloudwatch"
  | "custom"
  | "loki"
  | "elasticsearch"
  | "host";

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
