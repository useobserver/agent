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
