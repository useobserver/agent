// Tests for the prometheus probe source — specifically the missing-URL guard.
//
// The prometheus source must never throw: when PROMETHEUS_SERVER_URL is absent
// from the agent env and the metric's source_config does not supply
// prometheus_url, execute() must resolve (not reject) with a no_data result
// carrying reason "prometheus_url_missing".

import { describe, it, expect } from "bun:test";
import { execute } from "../src/sources/prometheus.ts";

// Minimal valid PrometheusConfig — only `query` is required; `prometheus_url`
// is optional and intentionally omitted here so the env path is exercised.
const minimalConfig = { query: "up" } as Parameters<typeof execute>[0];

describe("prometheus source — missing URL", () => {
  it("returns no_data with reason prometheus_url_missing when env has no URL", async () => {
    const result = await execute(minimalConfig, {});
    expect(result.status_hint).toBe("no_data");
    expect(result.reason).toBe("prometheus_url_missing");
    expect(result.value).toBeNull();
    expect(typeof result.timestamp).toBe("string");
    // Timestamp must be a valid ISO-8601 string.
    expect(new Date(result.timestamp).getTime()).not.toBeNaN();
  });

  it("does not throw when URL is missing from both config and env", async () => {
    await expect(execute(minimalConfig, {})).resolves.toBeDefined();
  });

  it("returns prometheus_url_missing when env URL is an empty string", async () => {
    const result = await execute(minimalConfig, { prometheusUrl: "" });
    expect(result.status_hint).toBe("no_data");
    expect(result.reason).toBe("prometheus_url_missing");
  });
});

// Instant-query result-shape guards, exercised against a local stub
// (mirrors the loki test harness pattern).
describe("prometheus source — result shape", () => {
  const withServer = async (
    payload: unknown,
    fn: (baseUrl: string) => Promise<void>,
  ): Promise<void> => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json(payload),
    });
    try {
      await fn(`http://127.0.0.1:${server.port}`);
    } finally {
      server.stop(true);
    }
  };

  it("multi-series instant result → no_data with reason prom_multiple_series", async () => {
    await withServer(
      {
        status: "success",
        data: {
          resultType: "vector",
          result: [
            { metric: { pod: "a" }, value: [1700000000, "1"] },
            { metric: { pod: "b" }, value: [1700000000, "2"] },
          ],
        },
      },
      async (baseUrl) => {
        const r = await execute({ query: "up" } as Parameters<typeof execute>[0], { prometheusUrl: baseUrl });
        expect(r.status_hint).toBe("no_data");
        expect(r.reason).toBe("prom_multiple_series");
        expect(r.value).toBeNull();
        expect((r.metadata as Record<string, unknown>)?.series).toBe(2);
      },
    );
  });

  it("NaN sample timestamp falls back to now with a valid ISO string", async () => {
    await withServer(
      {
        status: "success",
        data: { resultType: "vector", result: [{ metric: {}, value: ["not-a-ts", "12.5"] }] },
      },
      async (baseUrl) => {
        const r = await execute({ query: "up" } as Parameters<typeof execute>[0], { prometheusUrl: baseUrl });
        expect(r.value).toBe(12.5);
        expect(r.status_hint).toBeUndefined();
        expect(new Date(r.timestamp).getTime()).not.toBeNaN();
      },
    );
  });

  it("NaN sample value → no_data with the typed no_data_for_query reason", async () => {
    await withServer(
      {
        status: "success",
        data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, "NaN"] }] },
      },
      async (baseUrl) => {
        const r = await execute({ query: "up" } as Parameters<typeof execute>[0], { prometheusUrl: baseUrl });
        expect(r.status_hint).toBe("no_data");
        expect(r.reason).toBe("no_data_for_query");
        expect(r.value).toBeNull();
      },
    );
  });
});
