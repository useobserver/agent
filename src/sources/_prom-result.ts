// Prometheus instant-query result parsing, shared by every source that
// speaks the Prometheus HTTP API (prometheus, and Google Cloud Monitoring's
// Prometheus-compatible endpoint).
//
// Body shape: { status, data: { resultType: "vector" | "scalar" | ..., result } }
//   vector: result = [{ metric, value: [ts, "num"] }, ...]
//   scalar: result = [ts, "num"]
//
// Reason codes are per caller, picked by `prefix`. They are spelled out as
// literals here (not built from the prefix) so the console's reason catalog
// test can see every code an agent may emit.

/** Every code this parser can return, across all prefixes. */
export type PromResultReason = "no_data_for_query" | "prom_multiple_series" | "prom_bad_response";

export interface PromResultCodes {
  /** Empty result, missing sample, or a non-finite value. */
  noData: PromResultReason;
  /** More than one series: picking one would be arbitrary. */
  multipleSeries: PromResultReason;
  /** The body is not JSON. */
  badResponse: PromResultReason;
}

export const PROM_RESULT_CODES = {
  // prometheus.ts keeps the codes it has always emitted.
  prom: { noData: "no_data_for_query", multipleSeries: "prom_multiple_series", badResponse: "prom_bad_response" },
} as const satisfies Record<string, PromResultCodes>;

export type PromResultPrefix = keyof typeof PROM_RESULT_CODES;

export type PromInstantResult =
  | { ok: true; value: number; timestamp: string; seriesCount: number }
  | { ok: false; reason: PromResultReason; metadata?: Record<string, unknown> };

export interface PromParseOptions {
  /**
   * Accept `resultType: "scalar"` bodies. prometheus.ts passes false: it has
   * always read only vector results (a scalar result reports no data).
   */
  scalar?: boolean;
  /** Fallback timestamp when the sample's own is malformed. Default: now. */
  now?: () => Date;
}

function sampleToResult(
  sample: unknown,
  codes: PromResultCodes,
  seriesCount: number,
  now: () => Date,
): PromInstantResult {
  const [tstamp, value] = sample as [unknown, unknown];
  const num = parseFloat(value as string);
  if (!Number.isFinite(num)) return { ok: false, reason: codes.noData };
  // A malformed sample timestamp must not produce an Invalid Date; fall back to now.
  const tsNum = parseFloat(tstamp as string);
  return {
    ok: true,
    value: num,
    timestamp: Number.isFinite(tsNum) ? new Date(tsNum * 1000).toISOString() : now().toISOString(),
    seriesCount,
  };
}

/**
 * Parse an already-decoded instant-query body.
 *
 * A structurally broken body (a null series entry, a non-array sample) throws
 * a TypeError, exactly as prometheus.ts always did; callers already run this
 * inside the try/catch that classifies thrown errors, and must keep doing so.
 */
export function parsePromInstantResult(
  body: unknown,
  prefix: PromResultPrefix,
  opts: PromParseOptions = {},
): PromInstantResult {
  const codes: PromResultCodes = PROM_RESULT_CODES[prefix];
  const now = opts.now ?? (() => new Date());
  const data = (body as { data?: { resultType?: unknown; result?: unknown } } | null)?.data;
  const result = data?.result;
  if (opts.scalar && data?.resultType === "scalar") {
    if (!Array.isArray(result) || result.length < 2) return { ok: false, reason: codes.noData };
    return sampleToResult(result, codes, 1, now);
  }
  const series = result as Array<{ value?: unknown }> | undefined;
  if (!Array.isArray(series) || series.length === 0 || !series[0].value) {
    return { ok: false, reason: codes.noData };
  }
  // An instant query returning more than one series is ambiguous: picking
  // result[0] silently renders an arbitrary series as truth.
  if (series.length > 1) {
    return { ok: false, reason: codes.multipleSeries, metadata: { series: series.length } };
  }
  return sampleToResult(series[0].value, codes, 1, now);
}

/**
 * Parse a raw response body; a JSON parse failure is the prefix's
 * bad-response code. Throws on a broken shape, like parsePromInstantResult.
 */
export function parsePromInstantText(text: string, prefix: PromResultPrefix, opts: PromParseOptions = {}): PromInstantResult {
  const codes: PromResultCodes = PROM_RESULT_CODES[prefix];
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: codes.badResponse };
  }
  return parsePromInstantResult(body, prefix, opts);
}
