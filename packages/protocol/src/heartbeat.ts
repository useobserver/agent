// heartbeat wire shape + alert thresholds.
//
// Agent posts this to /api/agent/heartbeat. The cloud route handler
// derives uptime/restart counts and runs the alert state machine
// defined in ./agent-health.

export interface OtlpReceiverStatsSnapshot {
  running: boolean;
  listen_addr: string | null;
  bearer_required: boolean;
  data_points_received: number;
  data_points_dropped: number;
  requests_authenticated: number;
  requests_rejected_auth: number;
  requests_rejected_payload: number;
  unique_streams: number;
  active_subscriptions: number;
}

// one entry per custom probe registered on the agent. The
// probe function is never serialised; only its name, description, and
// whether it declares a config schema. The console populates the
// custom-probe dropdown from the latest heartbeat's list.
export interface CustomProbeDescriptor {
  name: string;
  description?: string;
  has_config_schema: boolean;
}

export interface HeartbeatPayload {
  version: string;
  uptime_seconds: number;
  buffer_size: number;
  buffer_oldest_age_seconds: number;
  queue_depth: number;
  queue_oldest_age_seconds: number;
  queue_capacity: number;
  agent_started_at: string;
  source_types_active: string[];
  // OTLP receiver stats snapshot. Optional because not every
  // agent runs the receiver (OBSERVER_OTLP_DISABLE=true) and older
  // agent versions don't emit this field at all.
  otlp_stats?: OtlpReceiverStatsSnapshot;
  // custom probes registered on the agent. Optional; omitted
  // when none are registered (and by older agents).
  custom_probes?: CustomProbeDescriptor[];
}

export interface HealthAlertState {
  state: "off" | "on";
  open_at?: string;
  below_since?: string;
}

// Alert thresholds — see ./agent-health for the state machine that
// uses them.
export const LAG_QUEUE_DEPTH_THRESHOLD = 1000;
export const LAG_OLDEST_AGE_SECONDS_THRESHOLD = 300;
export const UPTIME_PCT_THRESHOLD = 95;
// Minimum observation window before uptime_degraded may open. Below
// this, minute-bucket rounding over a tiny window makes the pct too
// noisy to alert on (and an operator mid-install would get paged for
// a process they started two minutes ago).
export const UPTIME_MIN_OBSERVATION_SECONDS = 3_600;
export const CLEAR_HYSTERESIS_MS = 60_000;
