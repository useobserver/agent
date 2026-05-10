// Wire contract for /api/agent/receiver and /api/agent/receiver/batch.
// Agent computes status client-side and pushes the precomputed verdict;
// cloud stores it.

export type ProbeStatus = "healthy" | "degraded" | "unhealthy" | "no_data";

export type Operation = "over" | "under" | "equal";

export interface ProbeResult {
  value: number | null;
  timestamp: string;
  status_hint?: "no_data";
  reason?: string;
  metadata?: Record<string, unknown>;
}

// Per-source contract. TConfig is the type-specific source_config
// shape (defined in @observer/probe-config via Zod inference); for
// agent runtime modules, TConfig narrows once Phase D lands.
export interface ProbeSource<TConfig = Record<string, unknown>> {
  validateConfig(config: unknown): null | string;
  execute(config: TConfig, env?: unknown): Promise<ProbeResult>;
}

export interface MetricSamplePayload {
  metric_id: string;
  value: number;
  timestamp: string;
  status: ProbeStatus | string;
  reason?: string;
}
