// OTLP JSON decoder + aggregation tests.

import { describe, expect, it } from "bun:test";
import {
  aggregateDataPoint,
  attributesFingerprint,
  attributesMatch,
  decodeOtlpHttpJson,
  type OtlpDataPoint,
} from "../src/sources/otlp/decode.ts";

const baseGauge = (overrides: Partial<Record<string, unknown>> = {}): string =>
  JSON.stringify({
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "checkout" } }],
        },
        scopeMetrics: [
          {
            scope: { name: "test", attributes: [] },
            metrics: [
              {
                name: "queue.depth",
                unit: "1",
                gauge: {
                  dataPoints: [
                    {
                      attributes: [{ key: "queue", value: { stringValue: "primary" } }],
                      timeUnixNano: "1700000000000000000",
                      asDouble: 42.5,
                      ...overrides,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });

describe("decodeOtlpHttpJson", () => {
  it("rejects invalid JSON", () => {
    const r = decodeOtlpHttpJson("not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("otlp_invalid_json");
  });

  it("rejects payloads without resourceMetrics", () => {
    const r = decodeOtlpHttpJson(JSON.stringify({ foo: "bar" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("otlp_malformed_payload");
  });

  it("decodes a gauge data point with merged resource + dp attributes", () => {
    const r = decodeOtlpHttpJson(baseGauge());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data_points).toHaveLength(1);
    const dp = r.data_points[0]!;
    expect(dp.metric_name).toBe("queue.depth");
    expect(dp.kind).toBe("gauge");
    expect(dp.value).toBe(42.5);
    expect(dp.attributes["service.name"]).toBe("checkout");
    expect(dp.attributes["queue"]).toBe("primary");
  });

  it("converts unix nano string to ms losslessly within JS-safe range", () => {
    const r = decodeOtlpHttpJson(baseGauge());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 1700000000 s → 1700000000000 ms
    expect(r.data_points[0]!.time_ms).toBe(1_700_000_000_000);
  });

  it("decodes sum data points and reads asInt", () => {
    const body = JSON.stringify({
      resourceMetrics: [
        {
          resource: { attributes: [] },
          scopeMetrics: [
            {
              scope: { attributes: [] },
              metrics: [
                {
                  name: "requests.total",
                  sum: {
                    aggregationTemporality: 2,
                    isMonotonic: true,
                    dataPoints: [
                      { attributes: [], timeUnixNano: "1700000000000000000", asInt: "97" },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const r = decodeOtlpHttpJson(body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data_points[0]!.kind).toBe("sum");
    expect(r.data_points[0]!.value).toBe(97);
  });

  it("decodes histogram data points", () => {
    const body = JSON.stringify({
      resourceMetrics: [
        {
          resource: { attributes: [] },
          scopeMetrics: [
            {
              scope: { attributes: [] },
              metrics: [
                {
                  name: "http.duration",
                  histogram: {
                    aggregationTemporality: 2,
                    dataPoints: [
                      {
                        attributes: [],
                        timeUnixNano: "1700000000000000000",
                        count: "10",
                        sum: 500,
                        bucketCounts: ["1", "3", "4", "2"],
                        explicitBounds: [50, 100, 250],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const r = decodeOtlpHttpJson(body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dp = r.data_points[0]!;
    expect(dp.kind).toBe("histogram");
    expect(dp.histogram!.count).toBe(10);
    expect(dp.histogram!.sum).toBe(500);
    expect(dp.histogram!.bucket_counts).toEqual([1, 3, 4, 2]);
    expect(dp.histogram!.explicit_bounds).toEqual([50, 100, 250]);
  });

  it("decodes exponential histogram data points (count + sum)", () => {
    const body = JSON.stringify({
      resourceMetrics: [
        {
          resource: { attributes: [] },
          scopeMetrics: [
            {
              scope: { attributes: [] },
              metrics: [
                {
                  name: "exp.duration",
                  exponentialHistogram: {
                    aggregationTemporality: 2,
                    dataPoints: [
                      { attributes: [], timeUnixNano: "1700000000000000000", count: "20", sum: 800 },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const r = decodeOtlpHttpJson(body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dp = r.data_points[0]!;
    expect(dp.kind).toBe("exponential_histogram");
    expect(dp.exponential_histogram!.count).toBe(20);
    expect(dp.exponential_histogram!.sum).toBe(800);
  });

  it("decodes exponential histogram bucket geometry (scale, offset, buckets, zero)", () => {
    const body = JSON.stringify({
      resourceMetrics: [
        {
          resource: { attributes: [] },
          scopeMetrics: [
            {
              scope: { attributes: [] },
              metrics: [
                {
                  name: "exp.duration",
                  exponentialHistogram: {
                    aggregationTemporality: 2,
                    dataPoints: [
                      {
                        attributes: [],
                        timeUnixNano: "1700000000000000000",
                        count: "20",
                        sum: 800,
                        scale: -1,
                        zeroCount: "3",
                        zeroThreshold: 0.5,
                        positive: { offset: 2, bucketCounts: ["7", "5"] },
                        negative: { offset: -1, bucketCounts: ["5"] },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const r = decodeOtlpHttpJson(body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const eh = r.data_points[0]!.exponential_histogram!;
    expect(eh.scale).toBe(-1);
    expect(eh.zero_count).toBe(3);
    expect(eh.zero_threshold).toBe(0.5);
    expect(eh.positive.offset).toBe(2);
    expect(eh.positive.bucket_counts).toEqual([7, 5]);
    expect(eh.negative.offset).toBe(-1);
    expect(eh.negative.bucket_counts).toEqual([5]);
  });

  it("returns empty data_points for empty resourceMetrics (keepalive)", () => {
    const r = decodeOtlpHttpJson(JSON.stringify({ resourceMetrics: [] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data_points).toHaveLength(0);
  });
});

describe("aggregateDataPoint", () => {
  const gauge: OtlpDataPoint = {
    metric_name: "m",
    attributes: {},
    time_ms: 0,
    kind: "gauge",
    value: 42,
  };
  const histogram: OtlpDataPoint = {
    metric_name: "h",
    attributes: {},
    time_ms: 0,
    kind: "histogram",
    histogram: {
      count: 10,
      sum: 500,
      bucket_counts: [1, 3, 4, 2],
      explicit_bounds: [50, 100, 250],
    },
  };
  const expHist: OtlpDataPoint = {
    metric_name: "eh",
    attributes: {},
    time_ms: 0,
    kind: "exponential_histogram",
    exponential_histogram: {
      count: 20,
      sum: 800,
      scale: 0,
      zero_count: 0,
      zero_threshold: 0,
      positive: { offset: 0, bucket_counts: [10, 10] },
      negative: { offset: 0, bucket_counts: [] },
    },
  };

  it("returns latest value for gauges", () => {
    expect(aggregateDataPoint(gauge, "latest")).toBe(42);
  });

  it("ignores non-latest aggregations on gauges (returns the scalar)", () => {
    expect(aggregateDataPoint(gauge, "p95")).toBe(42);
    expect(aggregateDataPoint(gauge, "count")).toBe(42);
  });

  it("histogram count returns the count", () => {
    expect(aggregateDataPoint(histogram, "count")).toBe(10);
  });

  it("histogram sum returns the sum", () => {
    expect(aggregateDataPoint(histogram, "sum")).toBe(500);
  });

  it("histogram mean returns sum/count", () => {
    expect(aggregateDataPoint(histogram, "mean")).toBe(50);
  });

  it("histogram quantile interpolates within the target bucket (p50)", () => {
    // count=10 → target rank = 5. cumulative after each bucket: [1, 4, 8, 10].
    // First bucket with cumulative ≥ 5 is index 2 (bounds 100→250, count 4).
    // In-bucket rank = 5 - (8 - 4) = 1; frac = 1/4 = 0.25 → 100 + 0.25*(250-100) = 137.5.
    const v = aggregateDataPoint(histogram, "p50");
    expect(v).toBeCloseTo(137.5, 5);
  });

  it("histogram quantile lands in the +Inf bucket and returns the last finite bound", () => {
    const tailHist: OtlpDataPoint = {
      ...histogram,
      histogram: {
        count: 10,
        sum: 5000,
        bucket_counts: [0, 0, 0, 10],
        explicit_bounds: [50, 100, 250],
      },
    };
    expect(aggregateDataPoint(tailHist, "p99")).toBe(250);
  });

  it("exponential histogram supports count / sum / mean", () => {
    expect(aggregateDataPoint(expHist, "count")).toBe(20);
    expect(aggregateDataPoint(expHist, "sum")).toBe(800);
    expect(aggregateDataPoint(expHist, "mean")).toBe(40);
  });

  it("exponential histogram p50 interpolates within the target bucket", () => {
    // expHist: positive offset 0, buckets [10, 10] at scale 0.
    // base = 2 ^ (2 ^ 0) = 2. So:
    //   positive bucket 0 covers [2^0, 2^1) = [1, 2) with 10 samples
    //   positive bucket 1 covers [2^1, 2^2) = [2, 4) with 10 samples
    // count=20 → target rank for p50 = 10. cumulative after b0 = 10.
    // p50 lands at the upper edge of bucket 0: frac = 10/10 = 1 → upper = 2.
    expect(aggregateDataPoint(expHist, "p50")).toBeCloseTo(2, 5);
  });

  it("exponential histogram p99 walks into the last positive bucket", () => {
    // target rank = 0.99 * 20 = 19.8. cumulative: b0=10, b1=20.
    // 19.8 lands in b1 (lower 2, upper 4). in-bucket rank = 19.8 - 10 = 9.8.
    // frac = 9.8 / 10 = 0.98 → 2 + 0.98 * (4 - 2) = 2 + 1.96 = 3.96.
    expect(aggregateDataPoint(expHist, "p99")).toBeCloseTo(3.96, 5);
  });

  it("exponential histogram returns null for an empty distribution", () => {
    const empty: OtlpDataPoint = {
      ...expHist,
      exponential_histogram: {
        count: 0,
        sum: 0,
        scale: 0,
        zero_count: 0,
        zero_threshold: 0,
        positive: { offset: 0, bucket_counts: [] },
        negative: { offset: 0, bucket_counts: [] },
      },
    };
    expect(aggregateDataPoint(empty, "p95")).toBeNull();
  });

  it("exponential histogram with zero-only count returns zero for p50", () => {
    const zeroes: OtlpDataPoint = {
      ...expHist,
      exponential_histogram: {
        count: 5,
        sum: 0,
        scale: 0,
        zero_count: 5,
        zero_threshold: 0,
        positive: { offset: 0, bucket_counts: [] },
        negative: { offset: 0, bucket_counts: [] },
      },
    };
    // Single bucket [-0, +0]; interpolated → 0.
    expect(aggregateDataPoint(zeroes, "p50")).toBe(0);
  });

  it("exponential histogram bridging negative + zero + positive", () => {
    // scale 0 → base = 2. negative offset 0, buckets [5] → covers (-2, -1].
    // zero bucket: 2 samples in [-0.5, 0.5].
    // positive offset 0, buckets [3] → covers [1, 2).
    // total = 5 + 2 + 3 = 10. target p50 rank = 5.
    // cumulative: negative=5 (just hits 5) → in-bucket rank = 5/5 = 1 → upper = -1.
    const bridge: OtlpDataPoint = {
      ...expHist,
      exponential_histogram: {
        count: 10,
        sum: -7,
        scale: 0,
        zero_count: 2,
        zero_threshold: 0.5,
        positive: { offset: 0, bucket_counts: [3] },
        negative: { offset: 0, bucket_counts: [5] },
      },
    };
    expect(aggregateDataPoint(bridge, "p50")).toBeCloseTo(-1, 5);
  });
});

describe("attributesFingerprint + attributesMatch", () => {
  it("fingerprint is order-independent", () => {
    expect(attributesFingerprint({ a: "1", b: "2" })).toBe(attributesFingerprint({ b: "2", a: "1" }));
  });

  it("match returns true when filter is empty", () => {
    expect(attributesMatch({ a: "1" }, {})).toBe(true);
    expect(attributesMatch({ a: "1" }, undefined)).toBe(true);
  });

  it("match enforces every filter key", () => {
    expect(attributesMatch({ a: "1", b: "2" }, { a: "1" })).toBe(true);
    expect(attributesMatch({ a: "1", b: "2" }, { a: "1", b: "3" })).toBe(false);
    expect(attributesMatch({ a: "1" }, { b: "2" })).toBe(false);
  });
});
