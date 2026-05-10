// heartbeat wire shape + alert thresholds.
//
// Agent posts this to /api/agent/heartbeat. The cloud route handler
// derives uptime/restart counts and runs the alert state machine
// defined in ./agent-health.

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
export const CLEAR_HYSTERESIS_MS = 60_000;
