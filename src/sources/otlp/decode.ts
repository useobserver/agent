// OTLP/HTTP JSON decoder.
//
// Wire format: https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
//
// We accept the JSON-encoded protobuf shape used by OTel SDKs and the
// OpenTelemetry Collector's `otlphttpexporter`. The decoder is
// schema-aware enough to extract one numeric value per data point and
// the attributes it carries; it does not validate the full message
// graph.
//
// Histograms (explicit + exponential) carry richer statistics (buckets,
// sum, count). The decoder surfaces those raw fields; the aggregation
// step picks a single number out of them at read() time.

export type OtlpAggregation = "latest" | "count" | "sum" | "mean" | "p50" | "p95" | "p99";

export interface OtlpAttributes {
  [key: string]: string;
}

export interface OtlpDataPoint {
  metric_name: string;
  attributes: OtlpAttributes;
  // unix-nanoseconds as a number; OTLP carries it as a string due to
  // protobuf-int64 → JSON-number precision loss. We convert to ms at
  // ingest and store milliseconds (safe within 2^53 for any sender we
  // care about — millennia of headroom).
  time_ms: number;
  // Discriminator for which value field to read in `aggregate()`.
  kind: "gauge" | "sum" | "histogram" | "exponential_histogram";
  // Set when kind is gauge or sum.
  value?: number;
  // Set when kind is histogram. Buckets correspond to explicit_bounds:
  // count[i] = number of values <= explicit_bounds[i] (and < bounds[i+1]).
  // The final bucket count is the count of values > the last bound.
  histogram?: {
    count: number;
    sum: number;
    bucket_counts: number[];
    explicit_bounds: number[];
  };
  // Set when kind is exponential_histogram. count + sum + bucket
  // geometry. Quantile estimation walks negatives → zero → positives
  // in ascending numeric order and interpolates within the target
  // bucket. See aggregateDataPoint / exponentialHistogramQuantile.
  //
  // Per OTLP spec:
  //   base = 2 ^ (2 ^ -scale)
  //   positive bucket index i covers [base^(offset+i), base^(offset+i+1))
  //   negative bucket index i covers (-base^(offset+i+1), -base^(offset+i)]
  //   zero_count holds values in [-zero_threshold, +zero_threshold]
  //
  // Reference: https://opentelemetry.io/docs/specs/otel/metrics/data-model/#exponentialhistogram
  exponential_histogram?: {
    count: number;
    sum: number;
    scale: number;
    zero_count: number;
    zero_threshold: number;
    positive: { offset: number; bucket_counts: number[] };
    negative: { offset: number; bucket_counts: number[] };
  };
}

export interface DecodeResult {
  ok: true;
  data_points: OtlpDataPoint[];
}
export interface DecodeFailure {
  ok: false;
  reason:
    | "otlp_invalid_json"
    | "otlp_unsupported_encoding"
    | "otlp_empty_payload"
    | "otlp_malformed_payload";
  detail?: string;
}

interface AnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: AnyValue[] };
}

function stringifyAttrValue(v: AnyValue | undefined): string {
  if (!v) return "";
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.boolValue === "boolean") return v.boolValue ? "true" : "false";
  if (v.intValue !== undefined) return String(v.intValue);
  if (typeof v.doubleValue === "number") return String(v.doubleValue);
  if (v.arrayValue?.values) return v.arrayValue.values.map(stringifyAttrValue).join(",");
  return "";
}

function readAttributes(attrs?: Array<{ key?: string; value?: AnyValue }>): OtlpAttributes {
  const out: OtlpAttributes = {};
  if (!Array.isArray(attrs)) return out;
  for (const a of attrs) {
    if (typeof a?.key !== "string" || !a.key) continue;
    out[a.key] = stringifyAttrValue(a.value);
  }
  return out;
}

// time_unix_nano arrives as a numeric string (protobuf int64 → JSON).
// We accept number, numeric string, undefined; never throw.
function readTimeMs(rawNano: unknown): number {
  if (typeof rawNano === "number" && Number.isFinite(rawNano)) {
    return Math.round(rawNano / 1e6);
  }
  if (typeof rawNano === "string" && rawNano.length > 0) {
    // Strip trailing 6 digits cheaply via BigInt division for precision,
    // fall back to Number on parse failure.
    try {
      return Number(BigInt(rawNano) / 1_000_000n);
    } catch {
      const n = Number(rawNano);
      if (Number.isFinite(n)) return Math.round(n / 1e6);
    }
  }
  return Date.now();
}

function readNumericValue(dp: Record<string, unknown>): number | undefined {
  if (typeof dp.asDouble === "number" && Number.isFinite(dp.asDouble)) return dp.asDouble;
  if (typeof dp.asInt === "number" && Number.isFinite(dp.asInt)) return dp.asInt;
  if (typeof dp.asInt === "string") {
    const n = Number(dp.asInt);
    if (Number.isFinite(n)) return n;
  }
  // Some collectors emit `value` directly (non-standard but seen in the wild).
  if (typeof dp.value === "number" && Number.isFinite(dp.value)) return dp.value;
  return undefined;
}

/**
 * Parse an OTLP/HTTP JSON request body into a flat list of data points.
 *
 * The outer envelope is `{ resourceMetrics: [...] }`. We walk
 * resourceMetrics[].scopeMetrics[].metrics[].(gauge|sum|histogram|exponentialHistogram).dataPoints[]
 * and emit one OtlpDataPoint per dataPoint with the metric name and
 * resource+scope+dataPoint attribute layers merged (later layers win
 * because the data-point attributes are the most specific).
 *
 * Returns DecodeFailure on parse / shape errors. Empty payload (no
 * resourceMetrics or no extractable data points) returns ok with an
 * empty array — that's a valid "keepalive" request.
 */
export function decodeOtlpHttpJson(body: string): DecodeResult | DecodeFailure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return { ok: false, reason: "otlp_invalid_json", detail: (e as Error).message };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "otlp_malformed_payload", detail: "root is not an object" };
  }
  const rm = (parsed as { resourceMetrics?: unknown }).resourceMetrics;
  if (!Array.isArray(rm)) {
    return { ok: false, reason: "otlp_malformed_payload", detail: "resourceMetrics is not an array" };
  }
  const out: OtlpDataPoint[] = [];
  for (const r of rm) {
    if (!r || typeof r !== "object") continue;
    const resourceAttrs = readAttributes((r as { resource?: { attributes?: unknown } }).resource?.attributes as Array<{ key?: string; value?: AnyValue }>);
    const scopes = (r as { scopeMetrics?: unknown }).scopeMetrics;
    if (!Array.isArray(scopes)) continue;
    for (const s of scopes) {
      if (!s || typeof s !== "object") continue;
      const scopeAttrs = readAttributes((s as { scope?: { attributes?: unknown } }).scope?.attributes as Array<{ key?: string; value?: AnyValue }>);
      const metrics = (s as { metrics?: unknown }).metrics;
      if (!Array.isArray(metrics)) continue;
      for (const m of metrics) {
        if (!m || typeof m !== "object") continue;
        const name = (m as { name?: unknown }).name;
        if (typeof name !== "string" || !name) continue;
        for (const dp of extractDataPoints(m, name, { ...resourceAttrs, ...scopeAttrs })) {
          out.push(dp);
        }
      }
    }
  }
  return { ok: true, data_points: out };
}

function extractDataPoints(
  metric: Record<string, unknown>,
  name: string,
  outerAttrs: OtlpAttributes,
): OtlpDataPoint[] {
  const gauge = metric.gauge as { dataPoints?: Array<Record<string, unknown>> } | undefined;
  const sum = metric.sum as { dataPoints?: Array<Record<string, unknown>> } | undefined;
  const hist = metric.histogram as { dataPoints?: Array<Record<string, unknown>> } | undefined;
  const expHist = metric.exponentialHistogram as { dataPoints?: Array<Record<string, unknown>> } | undefined;

  const out: OtlpDataPoint[] = [];

  for (const dp of gauge?.dataPoints ?? []) {
    const v = readNumericValue(dp);
    if (v === undefined) continue;
    out.push({
      metric_name: name,
      attributes: { ...outerAttrs, ...readAttributes(dp.attributes as Array<{ key?: string; value?: AnyValue }>) },
      time_ms: readTimeMs(dp.timeUnixNano),
      kind: "gauge",
      value: v,
    });
  }

  for (const dp of sum?.dataPoints ?? []) {
    const v = readNumericValue(dp);
    if (v === undefined) continue;
    out.push({
      metric_name: name,
      attributes: { ...outerAttrs, ...readAttributes(dp.attributes as Array<{ key?: string; value?: AnyValue }>) },
      time_ms: readTimeMs(dp.timeUnixNano),
      kind: "sum",
      value: v,
    });
  }

  for (const dp of hist?.dataPoints ?? []) {
    const count = readCountField(dp.count);
    const sumVal = readDoubleField(dp.sum) ?? 0;
    const buckets = (dp.bucketCounts as unknown[]) ?? [];
    const bounds = (dp.explicitBounds as unknown[]) ?? [];
    if (count === undefined) continue;
    out.push({
      metric_name: name,
      attributes: { ...outerAttrs, ...readAttributes(dp.attributes as Array<{ key?: string; value?: AnyValue }>) },
      time_ms: readTimeMs(dp.timeUnixNano),
      kind: "histogram",
      histogram: {
        count,
        sum: sumVal,
        bucket_counts: buckets.map((b) => readCountField(b) ?? 0),
        explicit_bounds: bounds.map((b) => (typeof b === "number" ? b : Number(b) || 0)),
      },
    });
  }

  for (const dp of expHist?.dataPoints ?? []) {
    const count = readCountField(dp.count);
    const sumVal = readDoubleField(dp.sum) ?? 0;
    if (count === undefined) continue;
    const scale = readSignedIntField(dp.scale) ?? 0;
    const zeroCount = readCountField(dp.zeroCount) ?? 0;
    const zeroThreshold = readDoubleField(dp.zeroThreshold) ?? 0;
    const positive = readExpBuckets(dp.positive);
    const negative = readExpBuckets(dp.negative);
    out.push({
      metric_name: name,
      attributes: { ...outerAttrs, ...readAttributes(dp.attributes as Array<{ key?: string; value?: AnyValue }>) },
      time_ms: readTimeMs(dp.timeUnixNano),
      kind: "exponential_histogram",
      exponential_histogram: {
        count,
        sum: sumVal,
        scale,
        zero_count: zeroCount,
        zero_threshold: zeroThreshold,
        positive,
        negative,
      },
    });
  }

  return out;
}

function readCountField(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function readDoubleField(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// Signed int. Accepts negative numbers and negative numeric strings;
// used for `scale` and bucket `offset` fields which can be negative.
function readSignedIntField(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

function readExpBuckets(raw: unknown): { offset: number; bucket_counts: number[] } {
  const r = raw as { offset?: unknown; bucketCounts?: unknown[] } | undefined;
  if (!r) return { offset: 0, bucket_counts: [] };
  const offset = readSignedIntField(r.offset) ?? 0;
  const arr = Array.isArray(r.bucketCounts) ? r.bucketCounts : [];
  return { offset, bucket_counts: arr.map((b) => readCountField(b) ?? 0) };
}

/**
 * Reduce a data point to a single numeric value using the configured
 * aggregation. Returns null when the aggregation is not extractable
 * from the data point shape (e.g. p95 on a gauge, count on a gauge).
 */
export function aggregateDataPoint(dp: OtlpDataPoint, mode: OtlpAggregation): number | null {
  if (dp.kind === "gauge" || dp.kind === "sum") {
    // For scalars, only `latest` and `sum` make sense; everything else
    // collapses to the scalar value itself.
    return dp.value ?? null;
  }
  if (dp.kind === "histogram") {
    const h = dp.histogram;
    if (!h) return null;
    if (mode === "count") return h.count;
    if (mode === "sum") return h.sum;
    if (mode === "mean") return h.count > 0 ? h.sum / h.count : null;
    if (mode === "latest") return h.count > 0 ? h.sum / h.count : null;
    if (mode === "p50" || mode === "p95" || mode === "p99") {
      return histogramQuantile(h, modeToQ(mode));
    }
    return null;
  }
  if (dp.kind === "exponential_histogram") {
    const e = dp.exponential_histogram;
    if (!e) return null;
    if (mode === "count") return e.count;
    if (mode === "sum") return e.sum;
    if (mode === "mean" || mode === "latest") return e.count > 0 ? e.sum / e.count : null;
    if (mode === "p50" || mode === "p95" || mode === "p99") {
      return exponentialHistogramQuantile(e, modeToQ(mode));
    }
    return null;
  }
  return null;
}

function modeToQ(mode: "p50" | "p95" | "p99"): number {
  if (mode === "p50") return 0.5;
  if (mode === "p95") return 0.95;
  return 0.99;
}

/**
 * Estimate a quantile from an explicit-bucket histogram using linear
 * interpolation across the bucket containing the target rank. Matches
 * Prometheus' `histogram_quantile` semantics closely enough for the
 * single-data-point case (we don't aggregate across data points; OTLP
 * histograms arrive pre-aggregated by the sender).
 *
 * Returns null when the histogram is empty or the bucket geometry is
 * degenerate.
 */
function histogramQuantile(
  h: { count: number; bucket_counts: number[]; explicit_bounds: number[] },
  q: number,
): number | null {
  if (!Number.isFinite(q) || q < 0 || q > 1) return null;
  if (h.count <= 0 || h.bucket_counts.length === 0) return null;
  const target = q * h.count;
  let cumulative = 0;
  for (let i = 0; i < h.bucket_counts.length; i++) {
    cumulative += h.bucket_counts[i] ?? 0;
    if (cumulative >= target) {
      const upper = h.explicit_bounds[i];
      const lower = i === 0 ? 0 : h.explicit_bounds[i - 1];
      // Final +Inf bucket — return the last finite bound rather than Infinity.
      if (upper === undefined) {
        const lastBound = h.explicit_bounds[h.explicit_bounds.length - 1];
        return typeof lastBound === "number" ? lastBound : null;
      }
      const bucketCount = h.bucket_counts[i] ?? 0;
      if (bucketCount === 0) return upper;
      const inBucketRank = target - (cumulative - bucketCount);
      const frac = inBucketRank / bucketCount;
      return lower + (upper - lower) * frac;
    }
  }
  // Should not reach: cumulative will hit target before we run out.
  return h.explicit_bounds[h.explicit_bounds.length - 1] ?? null;
}

/**
 * Estimate a quantile from an OTLP exponential histogram by walking
 * buckets in ascending numeric order — most-negative first, then
 * zero bucket, then positives — and interpolating linearly within
 * the bucket containing the target rank.
 *
 * Bucket geometry per spec:
 *   base = 2 ^ (2 ^ -scale)
 *   positive bucket index i covers [base^(offset+i), base^(offset+i+1))
 *   negative bucket index i covers (-base^(offset+i+1), -base^(offset+i)]
 *   zero bucket covers [-zero_threshold, +zero_threshold]
 *
 * The numerically-smallest sample lives in the highest-index negative
 * bucket; we walk negatives from `negative.bucket_counts.length - 1`
 * down to 0, then the zero bucket, then positives from index 0 upward.
 *
 * Returns null when:
 *   - the histogram is empty
 *   - q is not in [0, 1]
 *   - scale is so coarse that `base` is non-finite (rare in practice)
 */
export function exponentialHistogramQuantile(
  h: {
    count: number;
    scale: number;
    zero_count: number;
    zero_threshold: number;
    positive: { offset: number; bucket_counts: number[] };
    negative: { offset: number; bucket_counts: number[] };
  },
  q: number,
): number | null {
  if (!Number.isFinite(q) || q < 0 || q > 1) return null;
  const total =
    h.zero_count +
    h.positive.bucket_counts.reduce((a, b) => a + b, 0) +
    h.negative.bucket_counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;

  // base = 2 ^ (2 ^ -scale). For scale in [-10, 20] the inner power
  // stays in [2^-20, 2^10]. Anything outside that range is treated as
  // unsupported and we return null.
  const inner = Math.pow(2, -h.scale);
  if (!Number.isFinite(inner)) return null;
  const base = Math.pow(2, inner);
  if (!Number.isFinite(base) || base <= 1) return null;

  const target = q * total;

  // Build (lower, upper, count) triples in ascending numeric order.
  // We materialise the bucket list because there are at most a few
  // hundred non-zero buckets in well-tuned exporters and we need to
  // know cumulative counts to interpolate. Skip zero-count buckets
  // entirely; they don't shift the rank.
  type Bucket = { lower: number; upper: number; count: number };
  const buckets: Bucket[] = [];

  // Negatives, most-negative first.
  for (let i = h.negative.bucket_counts.length - 1; i >= 0; i--) {
    const c = h.negative.bucket_counts[i] ?? 0;
    if (c === 0) continue;
    // Index i covers (-base^(offset+i+1), -base^(offset+i)].
    // Ascending numeric order: the lower (more negative) bound is
    // -base^(offset+i+1); the upper bound is -base^(offset+i).
    const lower = -Math.pow(base, h.negative.offset + i + 1);
    const upper = -Math.pow(base, h.negative.offset + i);
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
    buckets.push({ lower, upper, count: c });
  }
  // Zero bucket.
  if (h.zero_count > 0) {
    const zt = Math.max(0, h.zero_threshold);
    buckets.push({ lower: -zt, upper: zt, count: h.zero_count });
  }
  // Positives, least-positive first.
  for (let i = 0; i < h.positive.bucket_counts.length; i++) {
    const c = h.positive.bucket_counts[i] ?? 0;
    if (c === 0) continue;
    const lower = Math.pow(base, h.positive.offset + i);
    const upper = Math.pow(base, h.positive.offset + i + 1);
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) return null;
    buckets.push({ lower, upper, count: c });
  }

  if (buckets.length === 0) return null;

  let cumulative = 0;
  for (const b of buckets) {
    cumulative += b.count;
    if (cumulative >= target) {
      const inBucketRank = target - (cumulative - b.count);
      const frac = b.count > 0 ? inBucketRank / b.count : 0;
      return b.lower + (b.upper - b.lower) * frac;
    }
  }
  // Numerical edge: target sits just beyond the last bucket's
  // cumulative. Return the upper bound of the last bucket.
  return buckets[buckets.length - 1]!.upper;
}

/**
 * Cheap fingerprint of an attributes object for buffer keying. Sort by
 * key (lexicographic) so {a:1,b:2} and {b:2,a:1} share a slot.
 */
export function attributesFingerprint(attrs: OtlpAttributes): string {
  const keys = Object.keys(attrs).sort();
  if (keys.length === 0) return "";
  // JSON-encode sorted [key, value] pairs so values containing the old `=`/`|`
  // delimiters can't collide two distinct attribute sets into one stream slot.
  return JSON.stringify(keys.map((k) => [k, attrs[k]]));
}

/**
 * Does `attrs` satisfy every key→value pair in `filter`? Missing keys
 * fail the match. Filter with empty / undefined matches every point.
 */
export function attributesMatch(attrs: OtlpAttributes, filter?: OtlpAttributes): boolean {
  if (!filter) return true;
  const keys = Object.keys(filter);
  if (keys.length === 0) return true;
  for (const k of keys) {
    if (attrs[k] !== filter[k]) return false;
  }
  return true;
}
