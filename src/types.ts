// Local agent types + re-exports of the cloud↔agent wire contract.
//
// Wire shapes (HeartbeatPayload, MetricSamplePayload, ProbeStatus,
// Operation, ProbeResult, ProbeSource, MetricDefinition, SourceType)
// live in @observer/protocol so the agent and cloud share one
// source of truth. Local-only types (BufferRow, BufferAccess,
// DrainController, DashboardSnapshot, AgentEnv) stay here — they do
// not cross the wire.

export type {
  ProbeStatus,
  Operation,
  ProbeResult,
  ProbeSource,
  SourceType,
  MetricDefinition,
  HeartbeatPayload,
  MetricSamplePayload,
} from "@observer/protocol";

export interface AgentEnv {
  prometheusUrl?: string;
  prometheusBasicAuthEnabled?: boolean;
  prometheusUsername?: string;
  prometheusPassword?: string;
  prometheusTimeoutMs?: number;
}

export interface BufferRow {
  id: number;
  payload: string;
}

export interface BufferEnqueueResult {
  dropped: number;
  size: number;
}

export interface BufferAccess {
  enqueue(payload: unknown): BufferEnqueueResult;
  size(): number;
  oldestAgeSeconds(): number;
  batches(batchSize?: number): Generator<BufferRow[], void, unknown>;
  ack(id: number): void;
  close(): void;
  readonly MAX_ROWS: number;
}

export interface DrainTickResult {
  acked: number;
  dropped: number;
  paused: boolean;
}

export interface DrainController {
  drainOnce(): Promise<DrainTickResult>;
  currentBackoffMs(): number;
  resetBackoff(): void;
}

// Dashboard state surface — everything the debug dashboard renders is
// derived from a snapshot of these fields. Read-only; the dashboard
// never mutates agent state.
export interface DashboardSnapshot {
  process: {
    agent_started_at: string;
    uptime_seconds: number;
    memory_rss_mb: number;
    version: string;
    bun_version: string;
  };
  config: Record<string, string>;
  queue: {
    depth: number;
    oldest_age_seconds: number;
    capacity: number;
    drain_backoff_ms: number;
  };
  cloud: {
    cloud_server_url: string;
    last_heartbeat_at: string | null;
    last_heartbeat_ok: boolean | null;
    last_heartbeat_error: string | null;
    last_post_at: string | null;
    last_post_ok: boolean | null;
    last_post_error: string | null;
  };
  prometheus: {
    server_url: string;
    last_probe_outcome: "success" | "no_data" | "error" | null;
    last_probe_at: string | null;
  };
  definitions: Array<{
    id: string;
    source_type: string;
    interval_minutes: number;
    push_interval_minutes: number;
    last_status: string | null;
    last_value: number | null;
    last_at: string | null;
    last_reason: string | null;
  }>;
  active_source_types: string[];
}
