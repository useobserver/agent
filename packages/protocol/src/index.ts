// @observer/protocol — public API.
//
// Single source of truth for the cloud↔agent wire contract:
//   - Heartbeat shape + health alert state machine
//   - Push payload + status verdict types
//   - Metric definition projection
//   - Heartbeat ping parsing + the agent heartbeat-relay batch
//
// Zero runtime dependencies; types + pure functions only. Safe to
// publish to npm for the public agent mirror.

export type {
  HeartbeatPayload,
  HeartbeatResponse,
  HealthAlertState,
  OtlpReceiverStatsSnapshot,
  CustomProbeDescriptor,
  AgentBuildInfo,
} from "./heartbeat";
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
export { DEFINITIONS_VERSION_HEADER } from "./definition";

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

export type {
  HeartbeatPingKind,
  ParsedHeartbeatPing,
  HeartbeatRelayPing,
  HeartbeatRelayBatch,
  HeartbeatRelayRejectCode,
  HeartbeatRelayResponse,
} from "./heartbeat-relay";
export {
  HEARTBEAT_BODY_MAX_BYTES,
  HEARTBEAT_RELAY_CLOUD_PATH,
  HEARTBEAT_RELAY_MAX_BATCH,
  HEARTBEAT_RELAY_MAX_AGE_MS,
  isWellFormedHeartbeatToken,
  redactHeartbeatToken,
  parseHeartbeatPingPath,
} from "./heartbeat-relay";

export type {
  ProberSourceType,
  ProberCheck,
  ProberChecksResponse,
  ProberResultItem,
  ProberResultsRequest,
  ProberResultsResponse,
} from "./prober";
export {
  PROBER_CHECKS_PATH,
  PROBER_RESULTS_PATH,
  PROBER_KEY_HEADER,
  PROBER_KEY_PREFIX,
  PROBER_CAPABILITIES_HEADER,
  PROBER_VERSION_HEADER,
  PROBER_CHECKS_VERSION_HEADER,
  PROBER_RESULTS_MAX_BATCH,
} from "./prober";

export type {
  AgentJobKind,
  ProbeTestSourceType,
  ProbeTestPayload,
  ProbeTestResult,
  CloudwatchListMetricsPayload,
  CloudwatchListMetricsResult,
  AgentJob,
  AgentJobsClaimResponse,
  AgentJobResultBody,
} from "./jobs";
export {
  AGENT_JOBS_CLAIM_PATH,
  AGENT_JOB_KINDS,
  PROBE_TEST_SOURCE_TYPES,
  PROBE_TEST_TIMEOUT_MS,
  agentJobResultPath,
  isAgentJobKind,
  isProbeTestSourceType,
  sanitizeProbeTestResult,
  sanitizeReasonCode,
} from "./jobs";
