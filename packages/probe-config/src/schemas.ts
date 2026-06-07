// Per-source Zod schemas.
//
// Each metric definition carries source_type + source_config. These
// schemas are the single contract between the cloud UI, the cloud
// API, and the agent runtime in src/sources/.
//
// Schemas marked "runtime: shipped" have a working executor. Schemas
// marked "runtime: stubbed" are defined so the UI / API can accept
// definitions before the runtime lands.

import { z } from "zod";

// Status-flip dwell bounds (metrics_def.dwell_seconds_to_breach / _to_recover).
// Single source of truth for every write path — metric forms, server actions,
// config-as-code apply — per the validation-bounds-everywhere rule. Defaults
// mirror the column defaults in apps/web/lib/schema.ts.
export const DWELL_SECONDS_MIN = 0; // 0 = flip on the next confirming sample
export const DWELL_SECONDS_MAX = 3600;
export const DWELL_BREACH_DEFAULT = 180;
export const DWELL_RECOVER_DEFAULT = 300;
export const dwellSecondsSchema = z.coerce
  .number()
  .int()
  .min(DWELL_SECONDS_MIN)
  .max(DWELL_SECONDS_MAX);

const port = z.number().int().min(1).max(65535);
const timeoutMs = z.number().int().min(1).max(60_000);
const nonEmptyString = z.string().min(1);
// Name of an env var on the agent host that holds a secret (DSN, PEM
// material, or a path to it). Same shape as connection_string_ref.
const envVarRef = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Z][A-Z0-9_]*$/, "must be an UPPER_SNAKE_CASE env var name");

const httpFields = {
  // Restrict to http/https. z.string().url() alone admits file://, which on the
  // agent host turns body_match / json_path into a local-file read+exfil oracle
  // (e.g. reading the agent's own PEM keys). Mirrors the WebSocket scheme guard.
  url: z
    .string()
    .url()
    .refine(
      (v) => {
        try {
          return ["http:", "https:"].includes(new URL(v).protocol);
        } catch {
          return false;
        }
      },
      { message: "url must use http:// or https://" },
    ),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).default("GET"),
  expected_status: z.union([z.number().int().min(100).max(599), z.array(z.number().int().min(100).max(599)).min(1)]).default(200),
  timeout_ms: timeoutMs.default(5_000),
  headers: z.record(z.string(), z.string()).optional(),
  body_match: z.string().optional(),
  follow_redirects: z.boolean().default(true),
  verify_tls: z.boolean().default(true),
  // Optional JSONPath expression. When present, the probe value is
  // the numeric value extracted from the JSON response body instead
  // of the response time in milliseconds. Booleans cast to 0/1.
  // Multi-value matches, missing paths, and non-numeric leaves are
  // surfaced as no_data with a specific reason code.
  json_path: z.string().min(1).max(256).optional(),
  // mTLS. Each *_ref names an env var on the AGENT
  // host whose value is either the PEM material directly or a path to
  // a PEM file. The cloud stores only the env-var NAME — never the
  // cert or key — matching the connection_string_ref pattern. The
  // private key never leaves the agent host.
  //   client_cert_ref — client certificate (required for mTLS)
  //   client_key_ref  — client private key (required for mTLS)
  //   ca_cert_ref     — CA cert for verifying the server (optional;
  //                     falls back to the system trust store)
  // cert + key are both-or-neither (refine below).
  client_cert_ref: envVarRef.optional(),
  client_key_ref: envVarRef.optional(),
  ca_cert_ref: envVarRef.optional(),
};

// Refinement shared by HttpConfigSchema: client cert and key must be
// supplied together. Typed loosely so Zod doesn't infer a type guard.
const mtlsRefRefinement = (v: Record<string, unknown>): boolean =>
  Boolean(v.client_cert_ref) === Boolean(v.client_key_ref);
const mtlsRefMessage: { message: string; path: (string | number)[] } = {
  message: "client_cert_ref and client_key_ref must be provided together",
  path: ["client_cert_ref"],
};

// runtime: shipped
export const PrometheusConfigSchema = z
  .object({
    query: nonEmptyString,
    prometheus_url: z.string().url().optional(),
  })
  .strict();

// runtime: shipped
export const HttpConfigSchema = z
  .object(httpFields)
  .strict()
  .refine(mtlsRefRefinement, mtlsRefMessage);

// runtime: shipped
export const TcpConfigSchema = z
  .object({
    host: nonEmptyString,
    port,
    timeout_ms: timeoutMs.default(2_000),
  })
  .strict();

// runtime: shipped
export const DnsConfigSchema = z
  .object({
    domain: nonEmptyString,
    record_type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA", "PTR"]).default("A"),
    expected_value: z.string().optional(),
    resolver: z.string().optional(),
  })
  .strict();

// runtime: shipped
export const TlsCertConfigSchema = z
  .object({
    host: nonEmptyString,
    port: port.default(443),
    warn_days: z.number().int().min(1).max(365).default(30),
    critical_days: z.number().int().min(1).max(365).default(7),
  })
  .strict()
  .refine((v) => v.warn_days >= v.critical_days, {
    message: "warn_days must be >= critical_days",
    path: ["warn_days"],
  });

// runtime: shipped (shells out to the system ping)
//
// host MUST NOT start with "-" (would be read as a ping flag when
// passed as argv) and must look like a hostname or IPv4 literal. The
// agent passes it as an argv element (no shell), so this regex is the
// flag-injection guard, not shell-escaping.
const hostnameOrIp = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?!-)[A-Za-z0-9._-]+$/,
    "host must be a hostname or IPv4 address and may not start with '-'",
  );
export const IcmpConfigSchema = z
  .object({
    host: hostnameOrIp,
    count: z.number().int().min(1).max(10).default(3),
    // per-ping timeout; ICMP probes are short so cap at 5s per the spec.
    timeout_ms: z.number().int().min(100).max(5_000).default(1_000),
    // What the metric value represents:
    //   latency       — average RTT in ms across successful pings
    //   packet_loss   — percentage of pings that didn't return (0..100)
    //   reachability  — 1 if any ping succeeded, else 0
    interpretation: z.enum(["latency", "packet_loss", "reachability"]).default("latency"),
  })
  .strict();

// runtime: shipped (@grpc/grpc-js Health/Check)
//
// gRPC Health Checking Protocol (grpc.health.v1.Health/Check) only.
// Arbitrary method invocation is out of scope.
//
// service — empty / omitted checks overall server health; a name
//   checks one registered service.
// tls_mode:
//   plaintext — h2c, no TLS.
//   tls       — server-auth TLS. ca_cert_ref optional (private CA);
//               falls back to the system trust store.
//   mtls      — mutual TLS. client_cert_ref + client_key_ref required;
//               reuses the agent's mTLS material loader.
// metadata — gRPC call metadata (e.g. an authorization token). Values
//   are treated as secrets: never logged, never surfaced in metadata.
// interpretation:
//   health_state — SERVING=1, NOT_SERVING=0, UNKNOWN=no_data,
//                  SERVICE_UNKNOWN=no_data(error).
//   latency      — Check round-trip in ms.
export const GrpcConfigSchema = z
  .object({
    host: nonEmptyString,
    port,
    service: z.string().max(256).optional(),
    tls_mode: z.enum(["plaintext", "tls", "mtls"]).default("plaintext"),
    client_cert_ref: envVarRef.optional(),
    client_key_ref: envVarRef.optional(),
    ca_cert_ref: envVarRef.optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    timeout_ms: z.number().int().min(100).max(30_000).default(5_000),
    interpretation: z.enum(["health_state", "latency"]).default("health_state"),
  })
  .strict()
  .refine(mtlsRefRefinement, mtlsRefMessage)
  .refine((v) => v.tls_mode !== "mtls" || (Boolean(v.client_cert_ref) && Boolean(v.client_key_ref)), {
    message: "mTLS mode requires client_cert_ref and client_key_ref.",
    path: ["client_cert_ref"],
  });

// runtime: shipped (Bun native WebSocket)
//
// ping_mode:
//   none    — open the connection, measure handshake, close.
//   message — after open, send `send_message`, await a reply; if
//             `expect_message` is set the reply must contain it.
// Protocol-level ping/pong frames are not exposed by the
// browser-compatible WebSocket API Bun implements, so round-trip is
// measured via an application message rather than a control frame.
// interpretation:
//   handshake_latency   — ms from connect to open
//   round_trip_latency  — ms from send to matching reply (needs ping_mode=message)
//   connection_success  — 1 if the socket opened, else 0
export const WebsocketConfigSchema = z
  .object({
    url: z.string().url().refine((v) => v.startsWith("ws://") || v.startsWith("wss://"), {
      message: "url must use ws:// or wss://",
    }),
    protocols: z.array(z.string().min(1).max(128)).max(16).optional(),
    // Inline like the http source's headers field (same precedent).
    headers: z.record(z.string(), z.string()).optional(),
    ping_mode: z.enum(["none", "message"]).default("none"),
    send_message: z.string().max(8192).optional(),
    expect_message: z.string().max(8192).optional(),
    timeout_ms: z.number().int().min(100).max(30_000).default(10_000),
    interpretation: z
      .enum(["handshake_latency", "round_trip_latency", "connection_success"])
      .default("handshake_latency"),
  })
  .strict()
  // Split into separately-pathed rules so the validateProbeWrite error
  // toast names the field the operator actually has to fix (the form's
  // ping_mode is derived from interpretation at submit time, so the
  // first rule always holds for form writes; it guards direct API
  // writes that set round-trip without ping_mode=message).
  .refine((v) => v.interpretation !== "round_trip_latency" || v.ping_mode === "message", {
    message: "Round-trip latency requires ping_mode=message.",
    path: ["ping_mode"],
  })
  .refine((v) => v.interpretation !== "round_trip_latency" || Boolean(v.send_message), {
    message: "Round-trip latency needs a message to send.",
    path: ["send_message"],
  })
  .refine((v) => v.ping_mode !== "message" || Boolean(v.send_message), {
    message: "ping_mode=message requires a send_message.",
    path: ["send_message"],
  });

// DEPRECATED. mTLS now lives on the `http` source
// via the optional client_cert_ref / client_key_ref / ca_cert_ref
// fields in httpFields. This stub type stays registered for the
// SourceType union + DB constraint backward-compat (no metric uses
// it — it always returned not_implemented) and is no longer offered
// in the picker. Here it requires cert + key so a stray config still
// validates; the agent routes it through the http runtime.
export const MtlsHttpConfigSchema = z
  .object({
    ...httpFields,
    client_cert_ref: envVarRef,
    client_key_ref: envVarRef,
  })
  .strict();

// runtime: shipped (postgres + mysql; redis +
// mongodb still stubbed pending the next batch of dispatch wiring)
//
// SQL probe. The agent runs a single SELECT query per cron tick
// against a customer database and reports the scalar return value.
//
// kind — postgres or mysql in v1; redis + mongodb are accepted by the
//   schema for forward-compat but the agent rejects them at
//   validateConfig time until a runtime ships.
// connection_string_ref — name of an env var on the agent host
//   holding the full database URL (e.g. "OBSERVER_PG_PROD_DSN"). The
//   agent reads the value at execute() time and never persists it,
//   logs it, or surfaces it in ProbeResult.metadata. Operators
//   provision read-only credentials at the agent level and reference
//   them here; the cloud never sees a secret.
// query — single SELECT (or WITH ... SELECT) statement returning
//   exactly one row with one column. Parser-checked at validate
//   time; rejected before reaching the database.
// statement_timeout_ms — per-query hard timeout (default 5s, max 30s).
//   Applied at the DB connection level (statement_timeout for
//   postgres; MAX_EXECUTION_TIME for mysql) so the database itself
//   aborts long-runners.
export const DatabaseConfigSchema = z
  .object({
    kind: z.enum(["postgres", "mysql", "redis", "mongodb"]),
    connection_string_ref: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Z][A-Z0-9_]*$/, "connection_string_ref must be an UPPER_SNAKE_CASE env var name"),
    query: z.string().min(1).max(8192),
    statement_timeout_ms: z.number().int().min(100).max(30_000).default(5_000),
  })
  .strict();

// runtime: shipped
//
// Loki log-derived metric source. Pull-mode. The agent runs one LogQL
// instant query per cron tick and reports the single numeric result.
// Observer never stores log lines: the query MUST be a metric
// aggregation (count_over_time / rate / sum(...) etc.), not a raw log
// stream. The agent confirms this at run time too (a "streams"
// resultType is rejected); this refine is the save-time guard.
//
// Auth secrets follow the env-var-reference pattern: the cloud
// stores only the NAME of an env var on the agent host; the agent reads
// the value at query time so the token never leaves the agent.
// Leading \b so a label value / identifier that merely contains a
// function name as a substring (mysum(...), sunny_rate(...)) doesn't
// false-positive as an aggregation. The runtime streams-rejection is
// the final guard; this keeps the save-time check honest.
const LOKI_METRIC_FN =
  /\b(?:rate|bytes_rate|count_over_time|bytes_over_time|absent_over_time|sum_over_time|avg_over_time|min_over_time|max_over_time|stdvar_over_time|stddev_over_time|quantile_over_time|first_over_time|last_over_time|sum|avg|min|max|count|topk|bottomk|stddev|stdvar|quantile)\s*(?:\(|by\b|without\b)/;
export function isLogQLAggregation(query: string): boolean {
  return LOKI_METRIC_FN.test(query);
}
export const LokiConfigSchema = z
  .object({
    base_url: z.string().url(),
    query: z
      .string()
      .min(1)
      .max(8192)
      .refine(isLogQLAggregation, {
        message:
          "LogQL query must be a metric aggregation (count_over_time, rate, sum(...), …), not a raw log stream",
      }),
    auth_mode: z.enum(["none", "bearer", "basic"]).default("none"),
    token_ref: envVarRef.optional(),
    username: z.string().min(1).max(256).optional(),
    password_ref: envVarRef.optional(),
    tenant_id: z.string().min(1).max(256).optional(),
    timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
  })
  .strict()
  .refine((v) => v.auth_mode !== "bearer" || Boolean(v.token_ref), {
    message: "bearer auth requires token_ref",
    path: ["token_ref"],
  })
  .refine((v) => v.auth_mode !== "basic" || (Boolean(v.username) && Boolean(v.password_ref)), {
    message: "basic auth requires username and password_ref",
    path: ["password_ref"],
  });
export type LokiConfig = z.infer<typeof LokiConfigSchema>;

// runtime: shipped
//
// Elasticsearch / OpenSearch log-derived metric source. Pull-mode. The
// agent POSTs one search (size:0) with the customer's query + aggs to
// /{index}/_search and reads a named aggregation's numeric value.
// Observer never stores log lines. OpenSearch uses the same search API;
// `flavor` only changes UI copy, not the request.
//
// Auth secrets follow the env-var-reference pattern: the cloud
// stores only the NAME of an env var on the agent host.
//   bearer  → token_ref
//   basic   → username + password_ref
//   api_key → api_key_ref (the base64 id:key; sent as `Authorization: ApiKey <value>`)
export const EsConfigSchema = z
  .object({
    base_url: z.string().url(),
    index: z.string().min(1).max(256),
    // Full search body: { query?, aggs|aggregations: {...} }. Free-form
    // jsonb; ES parses it. Must contain an aggregation block.
    query: z
      .record(z.string(), z.unknown())
      .refine((q) => Boolean((q as Record<string, unknown>).aggs ?? (q as Record<string, unknown>).aggregations), {
        message: "query must contain an `aggs` (or `aggregations`) block that produces the metric value",
      }),
    // Name of the aggregation in the response to read the value from.
    agg_name: z.string().min(1).max(256),
    // For a percentiles aggregation, which percentile key to read
    // (e.g. "95.0"). Ignored for single-value aggregations.
    percentile: z
      .string()
      .regex(/^\d{1,3}(?:\.\d+)?$/, "percentile must look like 95 or 99.9")
      .optional(),
    flavor: z.enum(["elasticsearch", "opensearch"]).default("elasticsearch"),
    auth_mode: z.enum(["none", "bearer", "basic", "api_key"]).default("none"),
    token_ref: envVarRef.optional(),
    username: z.string().min(1).max(256).optional(),
    password_ref: envVarRef.optional(),
    api_key_ref: envVarRef.optional(),
    timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
  })
  .strict()
  .refine((v) => v.auth_mode !== "bearer" || Boolean(v.token_ref), {
    message: "bearer auth requires token_ref",
    path: ["token_ref"],
  })
  .refine((v) => v.auth_mode !== "basic" || (Boolean(v.username) && Boolean(v.password_ref)), {
    message: "basic auth requires username and password_ref",
    path: ["password_ref"],
  })
  .refine((v) => v.auth_mode !== "api_key" || Boolean(v.api_key_ref), {
    message: "api_key auth requires api_key_ref",
    path: ["api_key_ref"],
  });
export type EsConfig = z.infer<typeof EsConfigSchema>;

// z.infer<>'d types — public so callers can replace `Record<string, unknown>`
// with the right shape per probe.
export type PrometheusConfig = z.infer<typeof PrometheusConfigSchema>;
export type HttpConfig = z.infer<typeof HttpConfigSchema>;
export type TcpConfig = z.infer<typeof TcpConfigSchema>;
export type DnsConfig = z.infer<typeof DnsConfigSchema>;
export type TlsCertConfig = z.infer<typeof TlsCertConfigSchema>;
export type IcmpConfig = z.infer<typeof IcmpConfigSchema>;
export type GrpcConfig = z.infer<typeof GrpcConfigSchema>;
export type WebsocketConfig = z.infer<typeof WebsocketConfigSchema>;
export type MtlsHttpConfig = z.infer<typeof MtlsHttpConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

// runtime: shipped — agent-produced host metrics.
//
// The agent reads these from the host it runs on (no external source),
// so deploying the agent gives instant signal. `metric` selects what
// the value represents:
//   cpu         — CPU utilization %, 0..100 (busy across all cores)
//   memory      — used memory %, 0..100
//   filesystem  — used space % for `mountpoint`, 0..100
//   network     — throughput on `iface` (or all non-loopback) in bytes/sec
//   load        — 1-minute load average per core (loadavg[0] / ncpu)
// host source_config carries NO endpoint/credentials — it always reads
// the local host. execution_mode is forced to "agent" for this type.
export const HostConfigSchema = z
  .object({
    metric: z.enum(["cpu", "memory", "filesystem", "network", "load"]),
    mountpoint: z.string().min(1).max(256).default("/"),
    iface: z.string().min(1).max(64).optional(),
  })
  .strict();
export type HostConfig = z.infer<typeof HostConfigSchema>;

// runtime: not applicable — manual metrics carry no probe runtime.
// Status is set explicitly via UI / API or implicitly by an open
// incident. The agent filters these out at metrics-definitions time.
export const ManualConfigSchema = z.object({}).strict();
export type ManualConfig = z.infer<typeof ManualConfigSchema>;

// runtime: shipped
//
// Custom probe source. The probe FUNCTION lives in the customer's agent
// codebase, registered by name via registerCustomProbe(). The cloud
// stores only a reference: which registered probe to run + an opaque
// config object passed to it at runtime. No code is ever stored in the
// cloud, so there is nothing to sandbox.
//
// probe_name — name the probe was registered under on the agent.
// probe_config — opaque per-probe config object. The cloud does not
//   know the per-probe shape (that's the agent's configSchema), so this
//   is a free-form record validated agent-side at run time.
export const CustomConfigSchema = z
  .object({
    probe_name: z.string().min(1).max(128),
    probe_config: z.record(z.string(), z.unknown()).optional(),
    // Per-probe hard timeout. The agent aborts (via AbortSignal) and
    // reports custom_probe_timeout if run() doesn't resolve in time.
    timeout_ms: z.number().int().min(100).max(30_000).optional(),
  })
  .strict();
export type CustomConfig = z.infer<typeof CustomConfigSchema>;

// runtime: shipped
//
// CloudWatch metric reader. Pull-mode source. The agent runs a single
// CloudWatch GetMetricData query per cron tick scoped to one
// (region, namespace, metric_name, dimensions, statistic, period).
//
// region — AWS region the metric lives in. Each region is a separate
//   source (cross-region requires a metric def per region).
// namespace — CloudWatch namespace, e.g. "AWS/RDS".
// metric_name — the metric name within the namespace, e.g. "CPUUtilization".
// dimensions — key→value exact match. AWS dimensions are ordered in
//   the wire model but match semantics are unordered; we store them
//   as a map and pass to the SDK in deterministic key-sorted order.
// statistic — Average / Sum / Minimum / Maximum / SampleCount, or a
//   percentile token like p50 / p95 / p99.9.
// period_seconds — granularity. Multiple of 60 in v1 (60 / 300 / 900 /
//   3600). Affects CloudWatch billing — every read is one DataPoint
//   over `period_seconds * 5` lookback to absorb collection lag.
// role_arn — optional STS AssumeRole target. When set, the agent
//   assumes this role using its ambient credentials (env / IRSA / EC2
//   role / ECS task role) and uses the resulting session for the
//   query. Cross-account access pattern.
// external_id — optional STS ExternalId for the assume call.
const CLOUDWATCH_STATISTICS = [
  "Average",
  "Sum",
  "Minimum",
  "Maximum",
  "SampleCount",
] as const;
const PERCENTILE_PATTERN = /^p(?:[0-9]|[1-9][0-9](?:\.[0-9])?)$/;
const cloudwatchStatistic = z
  .string()
  .min(1)
  .max(16)
  .refine(
    (s) => (CLOUDWATCH_STATISTICS as readonly string[]).includes(s) || PERCENTILE_PATTERN.test(s),
    {
      message: "statistic must be Average, Sum, Minimum, Maximum, SampleCount, or a percentile (p50, p95, p99.9)",
    },
  );
const CLOUDWATCH_PERIOD_SECONDS = [60, 300, 900, 3600] as const;
export const CloudwatchConfigSchema = z
  .object({
    region: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "region must be an AWS region code"),
    namespace: z.string().min(1).max(255),
    metric_name: z.string().min(1).max(255),
    dimensions: z.record(z.string().min(1).max(255), z.string().max(255)).optional(),
    statistic: cloudwatchStatistic.default("Average"),
    period_seconds: z
      .number()
      .int()
      .refine((n) => (CLOUDWATCH_PERIOD_SECONDS as readonly number[]).includes(n), {
        message: "period_seconds must be 60, 300, 900, or 3600",
      })
      .default(60),
    role_arn: z
      .string()
      .min(20)
      .max(2048)
      .regex(/^arn:aws[a-zA-Z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/, "role_arn must be a valid IAM role ARN")
      .optional(),
    external_id: z.string().min(2).max(1224).optional(),
  })
  .strict();
export type CloudwatchConfig = z.infer<typeof CloudwatchConfigSchema>;
export const CLOUDWATCH_STATISTIC_VALUES = CLOUDWATCH_STATISTICS;
export const CLOUDWATCH_PERIOD_VALUES = CLOUDWATCH_PERIOD_SECONDS;

// runtime: shipped
//
// OTLP receiver source. The agent runs an OTLP/HTTP listener (JSON
// encoding, default port 4318); every metric_def with source_type=otlp
// subscribes to a filtered view of the latest data point.
//
// metric_name — the OTLP metric name to read (e.g. "http.server.duration").
// attribute_filters — key→value exact match. Empty means "any data point
//   carrying the metric name regardless of attributes". Multi-match
//   returns the most recently received sample.
// aggregation — for histograms; ignored for gauge and sum data point types.
// staleness_ms — read() surfaces no_data when the latest sample is older
//   than this. Bounds liveness so a sender that stops pushing surfaces
//   on the dashboard rather than serving stale values forever.
const OTLP_AGGREGATIONS = ["latest", "count", "sum", "mean", "p50", "p95", "p99"] as const;
export const OtlpConfigSchema = z
  .object({
    metric_name: nonEmptyString.max(256),
    attribute_filters: z.record(z.string().min(1).max(128), z.string().max(512)).optional(),
    aggregation: z.enum(OTLP_AGGREGATIONS).default("latest"),
    staleness_ms: z.number().int().min(1_000).max(86_400_000).default(120_000),
  })
  .strict();
export type OtlpConfig = z.infer<typeof OtlpConfigSchema>;
export const OTLP_AGGREGATION_VALUES = OTLP_AGGREGATIONS;
