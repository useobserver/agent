// CloudWatch metric reader.
//
// Pull-mode source. Each cron tick runs a single GetMetricData query
// scoped to one (region, namespace, metric_name, dimensions, statistic,
// period). Returns the most recent non-null data point.
//
// Auth model: the agent inherits credentials from its ambient
// environment (env vars, EC2 instance role, ECS task role, IRSA, etc.)
// via the AWS SDK's default credential provider chain. When a metric
// def carries `role_arn`, the agent calls STS AssumeRole using its
// ambient credentials and uses the resulting session for the query
// (cross-account access pattern).
//
// Credentials are NEVER stored in source_config — the agent's
// environment is the source of truth. This avoids the rotation +
// encryption surface that storing per-metric_def access keys would
// require.

import crypto from "node:crypto";
import {
  CloudWatchClient,
  GetMetricDataCommand,
  type GetMetricDataCommandOutput,
  ListMetricsCommand,
  type ListMetricsCommandOutput,
} from "@aws-sdk/client-cloudwatch";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { ProbeResult, ProbeSource } from "../types.ts";
import { CloudwatchConfigSchema, type CloudwatchConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(CloudwatchConfigSchema, config);
}

// Per-(region, role_arn, external_id) CloudWatchClient cache. Each
// cache entry holds a long-lived client; the AWS SDK manages
// connection pooling + credential refresh internally. Building a new
// client on every tick would re-establish HTTPS connections.
//
// The cache is bounded: when MAX_CLIENT_CACHE_ENTRIES is reached we
// evict the least-recently-used entry. Bounds memory growth when a
// customer churns through many transient role ARNs (typos, test
// definitions, deleted metric defs whose disposeForMetric path didn't
// have a chance to flush). 64 entries is well above the realistic
// active-region × active-role-arn working set for a single agent.
//
// Cache key is a SHA-256 hash of the tuple to defend against
// adversarial separator injection — IAM role names allow [+=,.@_-]+
// and paths allow / so we can construct unambiguous string joins,
// but a hash makes the key shape robust under future schema changes.
//
// Tests reset the cache via `resetCloudwatchClientCacheForTests`.
type ClientKey = string;
const MAX_CLIENT_CACHE_ENTRIES = 64;
const clientCache = new Map<ClientKey, CloudWatchClient>();

function clientKey(region: string, roleArn?: string, externalId?: string): ClientKey {
  const h = crypto.createHash("sha256");
  h.update(region);
  h.update("\x00");
  h.update(roleArn ?? "");
  h.update("\x00");
  h.update(externalId ?? "");
  return h.digest("hex");
}

function touchCacheEntry(key: ClientKey, client: CloudWatchClient): void {
  // Map preserves insertion order; deleting + re-setting moves the
  // entry to the end, giving us LRU semantics for free.
  if (clientCache.has(key)) clientCache.delete(key);
  clientCache.set(key, client);
}

function evictOldestIfFull(): void {
  while (clientCache.size >= MAX_CLIENT_CACHE_ENTRIES) {
    const oldest = clientCache.keys().next();
    if (oldest.done || oldest.value === undefined) break;
    const evicted = clientCache.get(oldest.value);
    clientCache.delete(oldest.value);
    try {
      evicted?.destroy();
    } catch {
      /* AWS SDK destroy is best-effort */
    }
  }
}

function buildClient(config: CloudwatchConfig): CloudWatchClient {
  const key = clientKey(config.region, config.role_arn, config.external_id);
  const cached = clientCache.get(key);
  if (cached) {
    touchCacheEntry(key, cached);
    return cached;
  }
  evictOldestIfFull();
  const client = new CloudWatchClient({
    region: config.region,
    // AWS SDK v3 defaults: 3 retries with exponential backoff + jitter
    // via the standard retry strategy. Throttling errors retry
    // automatically.
    maxAttempts: 3,
    // Hard deadlines on the underlying HTTP handler. Without these the
    // SDK inherits the OS socket defaults and a blackholed endpoint can
    // hang a probe tick indefinitely. The plain-object options shape is
    // the SDK-supported (>=3.521.0) equivalent of constructing
    // NodeHttpHandler({ connectionTimeout, requestTimeout }) — used here
    // because @smithy/node-http-handler is not directly resolvable from
    // this workspace (transitive-only under Bun's isolated linker).
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 15_000 },
    credentials: config.role_arn
      ? fromTemporaryCredentials({
          params: {
            RoleArn: config.role_arn,
            ExternalId: config.external_id,
            RoleSessionName: "observer-agent",
            DurationSeconds: 3600,
          },
        })
      : undefined, // undefined → default credential provider chain
  });
  clientCache.set(key, client);
  return client;
}

/**
 * Pick the latest non-null value from a CloudWatch GetMetricData
 * response. CloudWatch orders timestamps newest-first by default
 * (ScanBy=TimestampDescending below), but we re-sort defensively
 * because some legacy SDK paths return ascending.
 */
function pickLatestDatapoint(out: GetMetricDataCommandOutput): {
  value: number;
  timestamp: Date;
} | null {
  const results = out.MetricDataResults ?? [];
  if (results.length === 0) return null;
  const r = results[0]!;
  const timestamps = r.Timestamps ?? [];
  const values = r.Values ?? [];
  if (timestamps.length === 0 || values.length === 0) return null;
  // Build (timestamp, value) pairs and pick the most-recent.
  let best: { value: number; timestamp: Date } | null = null;
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    const v = values[i];
    if (!(t instanceof Date) || typeof v !== "number" || !Number.isFinite(v)) continue;
    if (!best || t.getTime() > best.timestamp.getTime()) {
      best = { value: v, timestamp: t };
    }
  }
  return best;
}

// Minimum lookback the GetMetricData query covers. CloudWatch can
// take up to ~5 minutes to publish a custom or cross-region metric
// (and longer for some EventBridge-published values), so a 5×60s
// lookback at the default 60s period sits exactly at the edge and
// surfaces transient no_data on metrics that are actually emitting.
// Bumping to 10 minutes gives a 5-minute safety margin without
// inflating the response size meaningfully (GetMetricData returns
// at most `lookback / period` points; 600/60=10 points is trivial).
const MIN_LOOKBACK_MS = 10 * 60 * 1000;

/**
 * Build the GetMetricData request body. Dimensions are sent in
 * key-sorted order so the request body is deterministic — the SDK
 * doesn't care, but it makes test fixtures stable.
 */
function buildGetMetricDataParams(config: CloudwatchConfig, now: Date) {
  const dimensions = Object.entries(config.dimensions ?? {})
    .filter(([k]) => k.length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([Name, Value]) => ({ Name, Value }));

  const period = config.period_seconds;
  // Look back at least MIN_LOOKBACK_MS or five periods, whichever is
  // larger. Five periods covers the typical 1-3 period CloudWatch
  // publish lag; the floor covers worst-case custom-metric latency
  // (~5 min) at the default 60s period.
  const lookbackMs = Math.max(period * 5 * 1000, MIN_LOOKBACK_MS);
  const startTime = new Date(now.getTime() - lookbackMs);
  const endTime = now;
  return {
    StartTime: startTime,
    EndTime: endTime,
    ScanBy: "TimestampDescending" as const,
    MetricDataQueries: [
      {
        Id: "m1",
        MetricStat: {
          Metric: {
            Namespace: config.namespace,
            MetricName: config.metric_name,
            Dimensions: dimensions,
          },
          Period: period,
          Stat: config.statistic,
        },
        ReturnData: true,
      },
    ],
  };
}

export async function execute(config: CloudwatchConfig): Promise<ProbeResult> {
  const ts = (): string => new Date().toISOString();
  try {
    const client = buildClient(config);
    const params = buildGetMetricDataParams(config, new Date());
    const out = await client.send(new GetMetricDataCommand(params));
    const latest = pickLatestDatapoint(out);
    if (!latest) {
      return {
        value: null,
        timestamp: ts(),
        status_hint: "no_data",
        reason: "cloudwatch_no_data",
        metadata: {
          region: config.region,
          namespace: config.namespace,
          metric_name: config.metric_name,
          statistic: config.statistic,
          period_seconds: config.period_seconds,
        },
      };
    }
    return {
      value: latest.value,
      timestamp: latest.timestamp.toISOString(),
      metadata: {
        region: config.region,
        namespace: config.namespace,
        metric_name: config.metric_name,
        statistic: config.statistic,
        period_seconds: config.period_seconds,
      },
    };
  } catch (err) {
    // AWS SDK errors carry a `name` (error class) and a `message`.
    // We surface a curated reason code per the common cases an
    // operator needs to distinguish; everything else falls through
    // to `cloudwatch_error`. We never log the raw error (it can
    // include the rendered request, which leaks identifiers); the
    // `reason` is the only operator surface.
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    const reason = classifyCloudwatchError(e);
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason,
      metadata: {
        region: config.region,
        namespace: config.namespace,
        metric_name: config.metric_name,
        http_status: e?.$metadata?.httpStatusCode,
      },
    };
  }
}

export function classifyCloudwatchError(e: {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}): string {
  const name = e?.name ?? "";
  if (name === "AccessDeniedException" || name === "UnrecognizedClientException") {
    return "cloudwatch_access_denied";
  }
  if (name === "ThrottlingException" || name === "RequestLimitExceeded") {
    return "cloudwatch_throttled";
  }
  if (name === "InvalidParameterValue" || name === "InvalidParameterCombination") {
    return "cloudwatch_invalid_parameter";
  }
  if (name === "ResourceNotFoundException") {
    return "cloudwatch_resource_not_found";
  }
  if (name === "ExpiredToken" || name === "ExpiredTokenException") {
    return "cloudwatch_expired_credentials";
  }
  const status = e?.$metadata?.httpStatusCode;
  if (typeof status === "number") {
    if (status === 403) return "cloudwatch_access_denied";
    if (status === 429) return "cloudwatch_throttled";
    if (status >= 500) return "cloudwatch_server_error";
  }
  return "cloudwatch_error";
}

/**
 * list metrics in a region (+ optional namespace), reusing
 * the per-(region, role_arn) CloudWatchClient cache. Walks ListMetrics
 * pagination up to a hard cap so a typo'd namespace returning 50k
 * series can't blow the response payload.
 */
export interface ListMetricsRequest {
  region: string;
  namespace?: string;
  role_arn?: string;
  external_id?: string;
  /** Hard cap on total metrics returned. Defaults to 500. */
  max_metrics?: number;
}

export interface ListMetricsResult {
  ok: true;
  metrics: Array<{
    metric_name: string;
    dimensions: Array<{ Name: string; Value: string }>;
  }>;
  truncated: boolean;
}

export interface ListMetricsFailure {
  ok: false;
  reason: string;
  detail?: string;
}

const LIST_METRICS_DEFAULT_CAP = 500;
const LIST_METRICS_PAGE_SIZE = 500;

export async function listMetrics(
  req: ListMetricsRequest,
): Promise<ListMetricsResult | ListMetricsFailure> {
  const cap = Math.min(Math.max(1, req.max_metrics ?? LIST_METRICS_DEFAULT_CAP), 2_000);
  // Reuse the same client cache; pretend the call is from a metric
  // def with the same (region, role_arn, external_id).
  const dummyConfig = {
    region: req.region,
    namespace: req.namespace ?? "",
    metric_name: "_unused_",
    statistic: "Average",
    period_seconds: 60,
    role_arn: req.role_arn,
    external_id: req.external_id,
  } as unknown as CloudwatchConfig;
  try {
    const client = buildClient(dummyConfig);
    const out: ListMetricsResult["metrics"] = [];
    let nextToken: string | undefined;
    let truncated = false;
    do {
      const page: ListMetricsCommandOutput = await client.send(
        new ListMetricsCommand({
          Namespace: req.namespace || undefined,
          NextToken: nextToken,
        }),
      );
      for (const m of page.Metrics ?? []) {
        if (out.length >= cap) {
          truncated = true;
          break;
        }
        if (!m.MetricName) continue;
        out.push({
          metric_name: m.MetricName,
          dimensions: (m.Dimensions ?? [])
            .filter((d) => typeof d.Name === "string" && typeof d.Value === "string")
            .map((d) => ({ Name: d.Name as string, Value: d.Value as string })),
        });
      }
      if (truncated) break;
      nextToken = page.NextToken;
      // Stop after a few pages even if we haven't hit cap to keep
      // the API call count bounded.
      if ((out.length + LIST_METRICS_PAGE_SIZE) > cap) break;
    } while (nextToken);
    return { ok: true, metrics: out, truncated };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return { ok: false, reason: classifyCloudwatchError(e) };
  }
}

export function resetCloudwatchClientCacheForTests(): void {
  for (const c of clientCache.values()) {
    try {
      c.destroy();
    } catch {
      /* ignore */
    }
  }
  clientCache.clear();
}

const source: ProbeSource<CloudwatchConfig> = { execute, validateConfig };
export default source;
