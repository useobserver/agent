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
  // Build provenance (agent 1.5.0+). SELF-REPORTED — a fork can send
  // anything here, so this is telemetry for honest users, never a trust
  // boundary. channel: "official" (build-info.json baked by the public
  // image CI), "source" (running from a checkout, hash computed at boot).
  build?: AgentBuildInfo;
  // The agent host's hostname (os.hostname()). Optional; older agents omit
  // it. The console offers it as a one-click name for an agent still on
  // its auto-assigned "agent-N" name. Self-reported, display only.
  hostname?: string;
}

export interface AgentBuildInfo {
  channel: "official" | "source";
  // git commit the official image was built from; null for source runs.
  commit: string | null;
  // sha256 over the sorted relative paths + contents of src/ — computed
  // identically at image-build time (official) and at boot (source), so
  // a patched official image or a modified checkout reports a hash that
  // differs from the published one for that version.
  source_hash: string;
}

// Cloud → agent: body of a 200 heartbeat response. Every field is
// additive; agents ignore what they don't know and must tolerate any
// field being absent (older clouds, fenced responses).
export interface HeartbeatResponse {
  ok: boolean;
  // true when this process lost duplicate-key fencing; nothing else is set.
  fenced?: boolean;
  uptime_pct_24h?: number;
  restart_count_24h?: number;
  // Opaque fingerprint of the metric definitions currently assigned to
  // this agent. Same value the definitions endpoint returns in the
  // DEFINITIONS_VERSION_HEADER response header. When it differs from the
  // version of the agent's last fetch, the agent re-fetches right away
  // instead of waiting for its periodic poll. Absent on clouds that
  // predate the signal; agents then rely on the periodic poll alone.
  definitions_version?: string;
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
