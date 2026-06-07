// agent/index.ts — Bun runtime entry point.

import crypto from "node:crypto";
import os from "node:os";
import pkg from "../package.json" with { type: "json" };
import buffer from "./buffer.ts";
import { createDrainController } from "./drain.ts";
import { startDashboard, maskEnv } from "./dashboard.ts";
import { getOtlpReceiver } from "./sources/otlp/receiver.ts";
import sources from "./sources/index.ts";
import { describeCustomProbes } from "./sources/custom/registry.ts";
import { evaluate } from "./evaluator.ts";
import type {
  DashboardSnapshot,
  HeartbeatPayload,
  MetricDefinition,
  MetricSamplePayload,
} from "./types.ts";

// Defaults.
const DEFAULT_CLOUD_SERVER_URL = "https://localhost:3000";
const DEFAULT_PROMETHEUS_BASIC_AUTH_ENABLED = "true";
const DEFAULT_PROMETHEUS_USERNAME = "admin";
const DEFAULT_PROMETHEUS_PASSWORD = "";
const DEFAULT_VERBOSE = "false";
const DEFAULT_BROADCAST_LOGS = "false";
const DEFAULT_LOG_BROADCAST_LEVEL = "WARN";
// Secure by default: TLS cert verification is ON for the cloud channel.
// Operators may opt out only by explicitly setting SKIP_SSL_VERIFICATION=true
// (local/self-signed dev), and the agent warns loudly at boot when they do.
const DEFAULT_SKIP_SSL_VERIFICATION = "false";
const DEFAULT_ENABLE_DEBUG_DASHBOARD = "true";

const LEVEL_RANK: Record<string, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  WARNING: 30,
  ERROR: 40,
};

const {
  CLOUD_SERVER_URL = DEFAULT_CLOUD_SERVER_URL,
  PROMETHEUS_SERVER_URL,
  AGENT_KEY,
  PROMETHEUS_BASIC_AUTH_ENABLED = DEFAULT_PROMETHEUS_BASIC_AUTH_ENABLED,
  PROMETHEUS_USERNAME = DEFAULT_PROMETHEUS_USERNAME,
  PROMETHEUS_PASSWORD = DEFAULT_PROMETHEUS_PASSWORD,
  VERBOSE = DEFAULT_VERBOSE,
  BROADCAST_LOGS = DEFAULT_BROADCAST_LOGS,
  LOG_BROADCAST_LEVEL = DEFAULT_LOG_BROADCAST_LEVEL,
  SKIP_SSL_VERIFICATION = DEFAULT_SKIP_SSL_VERIFICATION,
  ENABLE_DEBUG_DASHBOARD = DEFAULT_ENABLE_DEBUG_DASHBOARD,
} = process.env;

const broadcastThreshold = LEVEL_RANK[String(LOG_BROADCAST_LEVEL).toUpperCase()] ?? LEVEL_RANK.WARN;
const isVerbose = VERBOSE === "true";
const skipSslVerification = SKIP_SSL_VERIFICATION === "true";
if (skipSslVerification) {
  console.warn(
    "[WARN] SKIP_SSL_VERIFICATION=true — TLS certificate verification is DISABLED on the cloud channel. " +
      "The AGENT_KEY is exposed to man-in-the-middle interception. Use only for local/self-signed dev.",
  );
}

if (!PROMETHEUS_SERVER_URL) {
  console.error("[ERROR] PROMETHEUS_SERVER_URL is mandatory.");
  process.exit(1);
}
if (!AGENT_KEY) {
  console.error("[ERROR] AGENT_KEY is mandatory.");
  process.exit(1);
}

// Single source of truth: the agent's package.json. Bumping the package
// version + pushing an `agent-v<semver>` tag both stamps the GHCR image
// AND propagates the new version to every heartbeat, which is what the
// dashboard renders next to the agent.
const AGENT_VERSION = (pkg as { version: string }).version;
const HEARTBEAT_INTERVAL_MS = 30_000;
const AGENT_STARTED_AT = new Date().toISOString();
const activeSourceTypes = new Set<string>();

// ───────────────────────── Dashboard state mirror ────────────────────
//
// Updated by the heartbeat loop, drain loop, and probe scheduler. The
// dashboard reads via getSnapshot(); never mutates.

interface DefinitionState {
  source_type: string;
  interval_minutes: number;
  push_interval_minutes: number;
  last_status: string | null;
  last_value: number | null;
  last_at: string | null;
  last_reason: string | null;
  healthy_operation: string | null;
  healthy_value: number | null;
  unhealthy_operation: string | null;
  unhealthy_value: number | null;
}

const definitionState = new Map<string, DefinitionState>();
let lastHeartbeatAt: string | null = null;
let lastHeartbeatOk: boolean | null = null;
let lastHeartbeatError: string | null = null;
let lastPostAt: string | null = null;
let lastPostOk: boolean | null = null;
let lastPostError: string | null = null;
let lastPromProbeAt: string | null = null;
let lastPromProbeOutcome: "success" | "no_data" | "error" | null = null;

// Counters — cumulative since process start. Dashboard renders the
// snapshot; long-window aggregation (24h "errors") is the cloud's job.
const counters = {
  evaluations: 0,
  pushes: 0,
  errors: 0,
  dropped: 0,
};

// Ring buffer of recent log lines for the dashboard's log pane.
// Capped to keep memory bounded and stay aligned with the dashboard's
// "last N" pane size.
const RECENT_LOGS_CAP = 50;
const recentLogs: Array<{ timestamp: string; level: string; message: string }> = [];

function pushRecentLog(level: string, message: string): void {
  recentLogs.push({ timestamp: new Date().toISOString(), level, message });
  if (recentLogs.length > RECENT_LOGS_CAP) {
    recentLogs.splice(0, recentLogs.length - RECENT_LOGS_CAP);
  }
}

function getSnapshot(): DashboardSnapshot {
  return {
    process: {
      agent_started_at: AGENT_STARTED_AT,
      uptime_seconds: Math.floor(process.uptime()),
      memory_rss_mb: process.memoryUsage().rss / 1_048_576,
      version: AGENT_VERSION,
      bun_version: typeof Bun !== "undefined" ? Bun.version : "unknown",
      pid: process.pid,
      hostname: os.hostname(),
    },
    counters: { ...counters },
    config: maskEnv(process.env),
    queue: {
      depth: buffer.size(),
      oldest_age_seconds: buffer.oldestAgeSeconds(),
      capacity: buffer.MAX_ROWS,
      drain_backoff_ms: drainController.currentBackoffMs(),
    },
    cloud: {
      cloud_server_url: CLOUD_SERVER_URL,
      last_heartbeat_at: lastHeartbeatAt,
      last_heartbeat_ok: lastHeartbeatOk,
      last_heartbeat_error: lastHeartbeatError,
      last_post_at: lastPostAt,
      last_post_ok: lastPostOk,
      last_post_error: lastPostError,
    },
    prometheus: {
      server_url: PROMETHEUS_SERVER_URL ?? "",
      last_probe_outcome: lastPromProbeOutcome,
      last_probe_at: lastPromProbeAt,
    },
    definitions: Array.from(definitionState.entries()).map(([id, s]) => ({ id, ...s })),
    active_source_types: [...activeSourceTypes],
    recent_logs: recentLogs.slice(-20),
  };
}

// ───────────────────────── Logging ───────────────────────────────────

function formatLogMessage(level: string, message: string): string {
  return `[${new Date().toISOString()}] [${level}] ${message}`;
}

const log = async (level: string, message: string): Promise<void> => {
  pushRecentLog(level, message);
  if (level === "ERROR") {
    console.error(formatLogMessage(level, message));
  } else {
    console.log(formatLogMessage(level, message));
  }
  if (BROADCAST_LOGS !== "true") return;
  const rank = LEVEL_RANK[String(level).toUpperCase()];
  if (rank === undefined || rank >= broadcastThreshold) {
    await sendLog(level, message);
  }
};

async function sendLog(level: string, message: string): Promise<void> {
  try {
    await cloudFetch("/api/agent/log", {
      method: "POST",
      body: JSON.stringify({ level, message, timestamp: new Date().toISOString() }),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(formatLogMessage("ERROR", `Failed to send log: ${msg}`));
  }
}

function handleError(message: string, error: unknown): void {
  counters.errors += 1;
  log("ERROR", message);
  if (isVerbose && error instanceof Error && error.stack) console.error(error.stack);
}

function redactQuery(query: unknown): string {
  if (typeof query !== "string") return "#<invalid>";
  const hash = crypto.createHash("sha256").update(query).digest("hex").slice(0, 12);
  return `#${hash}(len=${query.length})`;
}

function classifyNoDataReason(error: unknown): string {
  if (!error) return "unknown";
  const e = error as { status?: number; code?: string; cause?: { code?: string }; name?: string };
  if (e?.status === 401 || e?.status === 403) return "Unauthorized";
  if (e?.code === "ECONNREFUSED") return "ECONNREFUSED";
  if (e?.code === "ECONNABORTED" || e?.code === "ETIMEDOUT") return "ETIMEDOUT";
  if (e?.code === "ENOTFOUND" || e?.code === "EAI_AGAIN") return "DNS";
  if (e?.code) return e.code;
  if (e?.cause?.code) return e.cause.code;
  if (e?.name && e.name !== "Error") return e.name;
  return "AgentInternal";
}

// ───────────────────────── Cloud HTTP ────────────────────────────────

async function cloudFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${CLOUD_SERVER_URL.replace(/\/$/, "")}${path}`;
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    "Agent-Key": AGENT_KEY!,
    // Duplicate-key fencing: the cloud compares this against the stored
    // agent_started_at and 409s receiver pushes from any process older than
    // the most recently started one sharing this key.
    "Agent-Started-At": AGENT_STARTED_AT,
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(url, {
    ...init,
    headers,
    // Do NOT follow redirects — the cloud doesn't legitimately redirect agents,
    // and `redirect:"follow"` would re-send the Agent-Key to a (cross-origin)
    // redirect target. Abort on any 3xx instead.
    redirect: "manual",
    // Bun-specific knob.
    tls: { rejectUnauthorized: !skipSslVerification },
  } as RequestInit & { tls?: { rejectUnauthorized: boolean } });
  if (res.status >= 300 && res.status < 400) {
    console.warn(`[WARN] cloud responded ${res.status} redirect for ${path} — not followed (Agent-Key not re-sent).`);
    const err = new Error(`HTTP ${res.status} redirect (not followed)`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res;
}

// ───────────────────────── Metric definitions ────────────────────────

async function fetchMetricDefinitions(): Promise<MetricDefinition[]> {
  try {
    const res = await cloudFetch("/api/agent/metrics-definitions", { method: "GET" });
    const data = (await res.json()) as MetricDefinition[];
    log("INFO", `Successfully fetched metric definitions (${data.length})`);
    return data;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    handleError("Error fetching metric definitions: " + msg, error);
    throw error;
  }
}

// ───────────────────────── Cloud post + drain ─────────────────────────

const postOneToCloud = async (metricData: MetricSamplePayload): Promise<unknown> => {
  try {
    const res = await cloudFetch("/api/agent/receiver", {
      method: "POST",
      body: JSON.stringify(metricData),
    });
    counters.pushes += 1;
    lastPostAt = new Date().toISOString();
    lastPostOk = true;
    lastPostError = null;
    return res;
  } catch (error) {
    lastPostAt = new Date().toISOString();
    lastPostOk = false;
    lastPostError = error instanceof Error ? error.message : String(error);
    throw error;
  }
};

const sendMetricsToCloudServer = (metricData: MetricSamplePayload): void => {
  const { size, dropped } = buffer.enqueue(metricData);
  if (dropped > 0) {
    counters.dropped += dropped;
    log("ERROR", `Queue cap reached: dropped ${dropped} oldest rows. Cap=${buffer.MAX_ROWS}. Depth=${size}.`);
  }
};

const drainController = createDrainController({
  buffer,
  post: (payload) => postOneToCloud(payload as MetricSamplePayload),
  log: (level, msg) => log(level, msg),
});

const startDrainLoop = (): void => {
  const tick = async (): Promise<void> => {
    try {
      await drainController.drainOnce();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      handleError("Buffer drain error: " + msg, error);
    }
    const jitter = Math.random() * 500;
    setTimeout(tick, drainController.currentBackoffMs() + jitter);
  };
  tick();
};

// ───────────────────────── Heartbeat ─────────────────────────────────

const sendHeartbeat = async (): Promise<void> => {
  // OTLP receiver is lazy-started; getOtlpReceiver() returns null
  // before the first OTLP source has been dispatched. We omit
  // otlp_stats entirely in that case so the cloud row stays null
  // and the dashboard doesn't render a misleading "0 dropped" cell
  // for agents that never run the receiver.
  const otlpReceiver = getOtlpReceiver();
  const otlpStats = otlpReceiver ? otlpReceiver.stats() : undefined;
  // Custom probes registered at boot. Always send the field (even when
  // empty) so that removing a probe + redeploying CLEARS the stale list
  // on the cloud. Older agents omit the field
  // entirely, so the cloud leaves their column untouched.
  const customProbes = describeCustomProbes();
  const payload: HeartbeatPayload = {
    version: AGENT_VERSION,
    uptime_seconds: Math.floor(process.uptime()),
    buffer_size: buffer.size(),
    buffer_oldest_age_seconds: buffer.oldestAgeSeconds(),
    queue_depth: buffer.size(),
    queue_oldest_age_seconds: buffer.oldestAgeSeconds(),
    queue_capacity: buffer.MAX_ROWS,
    agent_started_at: AGENT_STARTED_AT,
    source_types_active: [...activeSourceTypes],
    ...(otlpStats ? { otlp_stats: otlpStats } : {}),
    custom_probes: customProbes,
  };
  try {
    await cloudFetch("/api/agent/heartbeat", { method: "POST", body: JSON.stringify(payload) });
    lastHeartbeatAt = new Date().toISOString();
    lastHeartbeatOk = true;
    lastHeartbeatError = null;
  } catch (error) {
    lastHeartbeatAt = new Date().toISOString();
    lastHeartbeatOk = false;
    lastHeartbeatError = error instanceof Error ? error.message : String(error);
    if (isVerbose) log("WARN", "Heartbeat failed: " + lastHeartbeatError);
  }
};

const startHeartbeatLoop = (): void => {
  sendHeartbeat();
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
};

// ───────────────────── CloudWatch ListMetrics poller ────────
//
// The cloud queues operator-initiated `cloudwatch:ListMetrics`
// requests (from the metric edit form) into `cloudwatch_list_requests`.
// The cloud has no AWS creds; the agent does. This poller fetches
// pending work via Agent-Key, runs ListMetrics against the same
// CloudWatch client cache used at probe time, and posts the result
// back. Disabled when there are no OTLP / CloudWatch sources active —
// no point polling if nothing's pending.

const CLOUDWATCH_WORK_POLL_INTERVAL_MS = 5_000;
let cloudwatchWorkPollerStarted = false;

interface CloudwatchWorkItem {
  correlation_id: string;
  region: string;
  namespace: string | null;
  role_arn: string | null;
  external_id: string | null;
}

async function processCloudwatchWorkItem(item: CloudwatchWorkItem): Promise<void> {
  const cloudwatch = await import("./sources/cloudwatch.ts");
  const result = await cloudwatch.listMetrics({
    region: item.region,
    namespace: item.namespace ?? undefined,
    role_arn: item.role_arn ?? undefined,
    external_id: item.external_id ?? undefined,
  });
  const body = result.ok
    ? { ok: true, metrics: result.metrics.map((m) => ({ metric_name: m.metric_name, dimensions: m.dimensions })) }
    : { ok: false, reason: result.reason, detail: result.detail };
  await cloudFetch(`/api/agent/work/cloudwatch-list-metrics/${item.correlation_id}/result`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function pollCloudwatchWork(): Promise<void> {
  try {
    const res = await cloudFetch("/api/agent/work/cloudwatch-list-metrics", { method: "GET" });
    const data = (await res.json()) as { work?: CloudwatchWorkItem[] };
    const work = data?.work ?? [];
    if (work.length === 0) return;
    // Run items in parallel; each item already has its own CloudWatch
    // client from the cache, and the cap-of-5 batch size limits
    // simultaneous AWS calls.
    await Promise.allSettled(
      work.map(async (item) => {
        try {
          await processCloudwatchWorkItem(item);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log("WARN", `CloudWatch list work ${item.correlation_id} failed: ${msg}`);
          // Best-effort error post so the form doesn't hang.
          try {
            await cloudFetch(`/api/agent/work/cloudwatch-list-metrics/${item.correlation_id}/result`, {
              method: "POST",
              body: JSON.stringify({ ok: false, reason: "agent_error", detail: msg.slice(0, 256) }),
            });
          } catch {
            /* swallow — work item will be reclaimed via stale-claim cleanup */
          }
        }
      }),
    );
  } catch (error) {
    // Don't loud-log if the cloud is briefly unreachable; the next
    // tick retries. Verbose-mode users see the warning.
    if (isVerbose) {
      const msg = error instanceof Error ? error.message : String(error);
      log("WARN", `CloudWatch work poll failed: ${msg}`);
    }
  }
}

const startCloudwatchWorkPoller = (): void => {
  if (cloudwatchWorkPollerStarted) return;
  cloudwatchWorkPollerStarted = true;
  setInterval(pollCloudwatchWork, CLOUDWATCH_WORK_POLL_INTERVAL_MS);
};

// ───────────────────────── Probe scheduling ──────────────────────────

const sourceEnv = (): {
  prometheusUrl?: string;
  prometheusBasicAuthEnabled: boolean;
  prometheusUsername?: string;
  prometheusPassword?: string;
} => ({
  prometheusUrl: PROMETHEUS_SERVER_URL,
  prometheusBasicAuthEnabled: PROMETHEUS_BASIC_AUTH_ENABLED === "true",
  prometheusUsername: PROMETHEUS_USERNAME,
  prometheusPassword: PROMETHEUS_PASSWORD,
});

function probeLabel(definition: MetricDefinition): string {
  if (definition.source_type === "prometheus" || !definition.source_type) {
    const q = definition.source_config?.query ?? definition.query ?? "";
    return `prometheus ${redactQuery(q)}`;
  }
  return `${definition.source_type} metric=${definition.id}`;
}

interface SchedulerHandle {
  stop(): void;
}

function scheduleEvery(minutes: number, fn: () => Promise<void>): SchedulerHandle {
  const ms = Math.max(1, Math.floor(minutes * 60_000));
  const handle = setInterval(() => {
    fn().catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      log("ERROR", `scheduled task error: ${msg}`);
    });
  }, ms);
  return { stop: () => clearInterval(handle) };
}

const scheduledJobs = new Map<string, SchedulerHandle>();

const startMetricPolling = async (): Promise<void> => {
  const pollDefinitions = async (): Promise<void> => {
    try {
      const metricDefinitions = await fetchMetricDefinitions();

      scheduledJobs.forEach((job) => job.stop());
      scheduledJobs.clear();

      activeSourceTypes.clear();
      for (const def of metricDefinitions) {
        activeSourceTypes.add(def.source_type || "prometheus");
      }

      const seenIds = new Set<string>();
      for (const definition of metricDefinitions) {
        const {
          id,
          interval,
          interval_agent_push,
          healthy_operation,
          healthy_value,
          unhealthy_operation,
          unhealthy_value,
        } = definition;

        seenIds.add(id);
        const thresholdFields = {
          healthy_operation: (healthy_operation as string) ?? null,
          healthy_value: healthy_value != null ? Number(healthy_value) : null,
          unhealthy_operation: (unhealthy_operation as string) ?? null,
          unhealthy_value: unhealthy_value != null ? Number(unhealthy_value) : null,
        };
        if (!definitionState.has(id)) {
          definitionState.set(id, {
            source_type: definition.source_type ?? "prometheus",
            interval_minutes: interval,
            push_interval_minutes: interval_agent_push,
            last_status: null,
            last_value: null,
            last_at: null,
            last_reason: null,
            ...thresholdFields,
          });
        } else {
          const s = definitionState.get(id)!;
          s.source_type = definition.source_type ?? "prometheus";
          s.interval_minutes = interval;
          s.push_interval_minutes = interval_agent_push;
          s.healthy_operation = thresholdFields.healthy_operation;
          s.healthy_value = thresholdFields.healthy_value;
          s.unhealthy_operation = thresholdFields.unhealthy_operation;
          s.unhealthy_value = thresholdFields.unhealthy_value;
        }

        let lastStatus: string | null = null;
        const label = probeLabel(definition);
        const runProbe = () => sources.execute(definition, sourceEnv());

        const recordOutcome = (status: string, value: number | null, ts: string, reason: string | null): void => {
          const s = definitionState.get(id);
          if (!s) return;
          s.last_status = status;
          s.last_value = value;
          s.last_at = ts;
          s.last_reason = reason;
          if (definition.source_type === "prometheus" || !definition.source_type) {
            lastPromProbeAt = ts;
            lastPromProbeOutcome = status === "no_data" ? "no_data" : "success";
          }
        };

        const pollingJob = scheduleEvery(interval, async () => {
          counters.evaluations += 1;
          log("INFO", `Fetching metric: ${label}`);
          try {
            const result = await runProbe();
            // Single evaluation entry point: handles no_data, null, and
            // non-finite values uniformly (non-finite → no_data, never a
            // spurious "degraded"). Replaces the inline evaluateStatus + casts.
            const ev = evaluate(definition, result);
            if (ev.status === "no_data") {
              recordOutcome("no_data", ev.value, ev.timestamp, ev.reason ?? null);
              if (lastStatus !== "no_data") {
                lastStatus = "no_data";
                sendMetricsToCloudServer({
                  metric_id: id,
                  value: 0,
                  timestamp: ev.timestamp,
                  status: "no_data",
                  reason: ev.reason ?? "no_data",
                });
              }
              return;
            }
            recordOutcome(ev.status, ev.value, ev.timestamp, null);
            if (ev.status !== lastStatus || lastStatus === null) {
              lastStatus = ev.status;
              sendMetricsToCloudServer({
                metric_id: id,
                value: ev.value ?? 0,
                timestamp: ev.timestamp,
                status: ev.status,
              });
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            handleError(`Unexpected throw from probe ${label}: ${msg}`, error);
            if (lastStatus !== "no_data") {
              lastStatus = "no_data";
              sendMetricsToCloudServer({
                metric_id: id,
                value: 0,
                timestamp: new Date().toISOString(),
                status: "no_data",
                reason: classifyNoDataReason(error),
              });
            }
          }
        });

        const pushJob = scheduleEvery(interval_agent_push, async () => {
          try {
            const result = await runProbe();
            const ev = evaluate(definition, result);
            if (ev.status === "no_data") {
              sendMetricsToCloudServer({
                metric_id: id,
                value: 0,
                timestamp: ev.timestamp,
                status: "no_data",
                reason: ev.reason ?? "no_data",
              });
              return;
            }
            sendMetricsToCloudServer({
              metric_id: id,
              value: ev.value ?? 0,
              timestamp: ev.timestamp,
              status: ev.status,
            });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            handleError(`Unexpected throw from probe ${label}: ${msg}`, error);
          }
        });

        scheduledJobs.set(`${id}-polling`, pollingJob);
        scheduledJobs.set(`${id}-push`, pushJob);
      }

      // Drop definitions that disappeared from the cloud, and dispose
      // any push-mode SourceInstance they held (OTLP subscription,
      // future receivers). Best-effort: dispose failures are logged
      // but never block the polling tick.
      for (const id of [...definitionState.keys()]) {
        if (!seenIds.has(id)) {
          definitionState.delete(id);
          sources.disposeForMetric(id).catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            log("WARN", `dispose push source for ${id} failed: ${msg}`);
          });
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Don't exit — cloud may be transiently unreachable. Setinterval
      // below keeps retrying every 5 min. Heartbeat + dashboard stay
      // up. Operator sees the failure on the dashboard.
      handleError("Error fetching metric definitions: " + msg, error);
    }
  };

  await pollDefinitions();
  setInterval(pollDefinitions, 5 * 60 * 1000);
};

// ───────────────────────── Boot ──────────────────────────────────────

startDrainLoop();
startHeartbeatLoop();
startCloudwatchWorkPoller();

if (ENABLE_DEBUG_DASHBOARD !== "false") {
  try {
    const dash = startDashboard({ state: { getSnapshot } });
    log("INFO", `Debug dashboard listening on http://${dash.hostname}:${dash.port}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    handleError("Failed to start debug dashboard: " + msg, error);
  }
} else {
  log("INFO", "Debug dashboard disabled (ENABLE_DEBUG_DASHBOARD=false).");
}

startMetricPolling().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  handleError("Error initializing metric polling: " + msg, error);
});

async function shutdown(signal: string): Promise<void> {
  log("INFO", `Received ${signal}; disposing push sources, closing buffer, exiting.`);
  try {
    await sources.disposeAllPushInstances();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("WARN", `dispose push instances on shutdown failed: ${msg}`);
  }
  try {
    buffer.close();
  } catch {
    /* already closed */
  }
  process.exit(0);
}
process.on("SIGINT", () => {
  shutdown("SIGINT").catch(() => process.exit(1));
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch(() => process.exit(1));
});
