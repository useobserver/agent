// Data-probe audit (2026-11-10): one regression test per confirmed bug,
// each reproducing the audit case.
import { afterEach, describe, expect, it } from "bun:test";
import { aggregateDataPoint, cumulativeWindow, type OtlpDataPoint } from "../src/sources/otlp/decode.ts";
import { createOtlpReceiver } from "../src/sources/otlp/receiver.ts";
import { execute as esExecute } from "../src/sources/elasticsearch.ts";
import { cpuPctFromTimes } from "../src/sources/host.ts";
import { classifyCloudwatchError } from "../src/sources/cloudwatch.ts";
import { lokiQueryUrl } from "../src/sources/loki.ts";
import { execute as promExecute } from "../src/sources/prometheus.ts";
import { execute as customExecute } from "../src/sources/custom/index.ts";
import { __resetCustomProbes, registerCustomProbe } from "../src/sources/custom/registry.ts";

const nowNano = (offsetMs = 0) => String(BigInt(Date.now() + offsetMs) * 1_000_000n);

function histBody(name: string, buckets: number[], count: number, sum: number, startNano: string, timeNano: string, temporality = 2) {
  return {
    resourceMetrics: [
      {
        resource: { attributes: [] },
        scopeMetrics: [
          {
            metrics: [
              {
                name,
                histogram: {
                  aggregationTemporality: temporality,
                  dataPoints: [
                    {
                      attributes: [],
                      startTimeUnixNano: startNano,
                      timeUnixNano: timeNano,
                      count: String(count),
                      sum,
                      bucketCounts: buckets.map(String),
                      explicitBounds: [0.1, 1, 5],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

const gaugeBody = (name: string, value: number, timeNano: string) => ({
  resourceMetrics: [
    { scopeMetrics: [{ metrics: [{ name, gauge: { dataPoints: [{ timeUnixNano: timeNano, asDouble: value }] } }] }] },
  ],
});

let receivers: Array<ReturnType<typeof createOtlpReceiver>> = [];
afterEach(async () => {
  for (const r of receivers) await r.stop();
  receivers = [];
});

async function startReceiver(maxBufferPoints = 1000) {
  const r = createOtlpReceiver({ listenAddr: "127.0.0.1:0", bearerToken: null, maxBufferPoints });
  await r.start();
  receivers.push(r);
  const addr = r.stats().listen_addr!;
  const push = (body: unknown) =>
    fetch(`http://${addr}/v1/metrics`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { r, push };
}

describe("OTLP cumulative histograms read the last interval", () => {
  it("p95 and count describe the new requests, not the process lifetime", async () => {
    const { r, push } = await startReceiver();
    const sub = r.subscribe({ metric_name: "http.duration" });
    const start = nowNano(-3_600_000);
    // 10000 fast requests since start.
    await push(histBody("http.duration", [10000, 0, 0, 0], 10000, 500, start, nowNano(-60_000)));
    // The next push adds 100 requests in the 1-5s bucket.
    await push(histBody("http.duration", [10000, 0, 100, 0], 10100, 800, start, nowNano()));
    const p = sub.latest()!;
    expect(aggregateDataPoint(p, "count")).toBe(100);
    const p95 = aggregateDataPoint(p, "p95")!;
    expect(p95).toBeGreaterThan(1);
    expect(p95).toBeLessThanOrEqual(5);
    expect(aggregateDataPoint(p, "sum")).toBe(300);
  });

  it("a reset (new start time) reads the new point as-is", async () => {
    const { r, push } = await startReceiver();
    const sub = r.subscribe({ metric_name: "http.duration" });
    await push(histBody("http.duration", [10000, 0, 0, 0], 10000, 500, nowNano(-3_600_000), nowNano(-60_000)));
    await push(histBody("http.duration", [0, 0, 5, 0], 5, 10, nowNano(-30_000), nowNano()));
    expect(aggregateDataPoint(sub.latest()!, "count")).toBe(5);
  });

  it("delta histograms are untouched", async () => {
    const { r, push } = await startReceiver();
    const sub = r.subscribe({ metric_name: "http.duration" });
    await push(histBody("http.duration", [5, 0, 0, 0], 5, 1, nowNano(-120_000), nowNano(-60_000), 1));
    await push(histBody("http.duration", [7, 0, 0, 0], 7, 1, nowNano(-60_000), nowNano(), 1));
    expect(aggregateDataPoint(sub.latest()!, "count")).toBe(7);
  });

  it("no window when the count went down", () => {
    const base = { metric_name: "m", attributes: {}, kind: "histogram" as const, temporality: "cumulative" as const, start_time_ms: 1 };
    const prev: OtlpDataPoint = { ...base, time_ms: 1, histogram: { count: 10, sum: 1, bucket_counts: [10], explicit_bounds: [] } };
    const cur: OtlpDataPoint = { ...base, time_ms: 2, histogram: { count: 3, sum: 1, bucket_counts: [3], explicit_bounds: [] } };
    expect(cumulativeWindow(prev, cur)).toBeNull();
  });
});

describe("OTLP receiver ordering and stream cap", () => {
  it("an older point never replaces a newer one", async () => {
    const { r, push } = await startReceiver();
    const sub = r.subscribe({ metric_name: "q" });
    await push(gaugeBody("q", 2, nowNano()));
    await push(gaugeBody("q", 1, nowNano(-200_000)));
    expect(sub.latest()!.value).toBe(2);
  });

  it("a stream that keeps being pushed is not evicted by new names", async () => {
    const { r, push } = await startReceiver(3);
    const sub = r.subscribe({ metric_name: "keep" });
    for (let i = 0; i < 5; i++) {
      await push(gaugeBody("keep", i, nowNano()));
      await push(gaugeBody(`noise${i}`, i, nowNano()));
    }
    expect(sub.latest()?.value).toBe(4);
  });
});

describe("Elasticsearch percentiles with no matching docs", () => {
  it("reports es_no_data, not 0", async () => {
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ aggregations: { lat: { values: { "95.0": null } } } }),
    });
    try {
      const res = await esExecute({
        base_url: `http://127.0.0.1:${srv.port}`,
        index: "logs",
        query: { aggs: { lat: { percentiles: { field: "ms", percents: [95] } } } },
        agg_name: "lat",
        percentile: "95",
        auth_mode: "none",
        timeout_ms: 2000,
      } as never);
      expect(res.value).toBeNull();
      expect(res.reason).toBe("es_no_data");
    } finally {
      srv.stop(true);
    }
  });
});

describe("host CPU from os.cpus() times", () => {
  const t = (user: number, idle: number) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });
  it("is null when the counters have not moved (Bun on macOS within ~1 s)", () => {
    expect(cpuPctFromTimes([t(100, 900)], [t(100, 900)])).toBeNull();
  });
  it("reads busy share over the window", () => {
    expect(cpuPctFromTimes([t(100, 900)], [t(125, 975)])).toBeCloseTo(25, 5);
  });
});

describe("CloudWatch error names", () => {
  it("accepts the query-compat names and the Exception names", () => {
    expect(classifyCloudwatchError({ name: "AccessDenied" })).toBe("cloudwatch_access_denied");
    expect(classifyCloudwatchError({ name: "Throttling" })).toBe("cloudwatch_throttled");
    expect(classifyCloudwatchError({ name: "ExpiredToken" })).toBe("cloudwatch_expired_credentials");
    expect(classifyCloudwatchError({ name: "InvalidParameterValueException" })).toBe("cloudwatch_invalid_parameter");
    expect(classifyCloudwatchError({ name: "SomethingElse", Code: "AccessDeniedException" })).toBe("cloudwatch_access_denied");
    expect(classifyCloudwatchError({ name: "Unknown", $metadata: { httpStatusCode: 400 } })).toBe("cloudwatch_error");
  });
});

describe("Loki base URL", () => {
  it("does not double a trailing /loki", () => {
    expect(lokiQueryUrl("http://loki:3100/loki")).toBe("http://loki:3100/loki/api/v1/query");
    expect(lokiQueryUrl("http://loki:3100/")).toBe("http://loki:3100/loki/api/v1/query");
    expect(lokiQueryUrl("https://gw.example/logs")).toBe("https://gw.example/logs/loki/api/v1/query");
  });
});

describe("Prometheus 422", () => {
  it("is a BadQuery", async () => {
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ status: "error", errorType: "execution", error: "too many samples" }, { status: 422 }),
    });
    try {
      const res = await promExecute({ query: "up" } as never, { prometheusUrl: `http://127.0.0.1:${srv.port}` } as never);
      expect(res.reason).toBe("BadQuery");
    } finally {
      srv.stop(true);
    }
  });
});

describe("custom probe config", () => {
  afterEach(() => __resetCustomProbes());
  it("run() receives the schema's parsed output (defaults, coercion)", async () => {
    let seen: unknown = null;
    registerCustomProbe({
      name: "parsed_cfg",
      configSchema: {
        safeParse: (v: any) => ({ success: true, data: { threshold: 5, port: Number(v.port) } }),
      },
      run(ctx) {
        seen = ctx.config;
        return 1;
      },
    });
    await customExecute({ probe_name: "parsed_cfg", probe_config: { port: "8080" } } as never);
    expect(seen).toEqual({ threshold: 5, port: 8080 });
  });
});
