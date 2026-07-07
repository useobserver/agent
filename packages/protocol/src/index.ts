// @observer/protocol — public API.
//
// Single source of truth for the cloud↔agent wire contract:
//   - Heartbeat shape + health alert state machine
//   - Push payload + status verdict types
//   - Metric definition projection
//
// Zero runtime dependencies; types + pure functions only. Safe to
// publish to npm for the public agent mirror.

export type { HeartbeatPayload, HealthAlertState, OtlpReceiverStatsSnapshot, CustomProbeDescriptor, AgentBuildInfo } from "./heartbeat";
export {
  LAG_QUEUE_DEPTH_THRESHOLD,
  LAG_OLDEST_AGE_SECONDS_THRESHOLD,
  UPTIME_PCT_THRESHOLD,
  UPTIME_MIN_OBSERVATION_SECONDS,
  CLEAR_HYSTERESIS_MS,
} from "./heartbeat";

export type {
  ProbeStatus,
  Operation,
  ProbeResult,
  ProbeSource,
  MetricSamplePayload,
} from "./push";

export type { Source, SourceInstance, SourceMode } from "./source";
export { asPullSource } from "./source";

export type { SourceType, MetricDefinition } from "./definition";

export type { StartedAtClass, DuplicateKeyState } from "./agent-health";
export {
  classifyLagSignal,
  classifyUptimeSignal,
  transition,
  uptimeSecondsToPct,
  uptimeObservationWindowSeconds,
  classifyStartedAt,
  duplicateSeen,
  duplicateTick,
  DUPLICATE_CLEAR_MS,
} from "./agent-health";
