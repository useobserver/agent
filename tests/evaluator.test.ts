// evaluator unit tests. The evaluator wraps the existing
// `evaluateStatus` rules with no-data short-circuiting and metadata
// passthrough; tests pin both branches.

import { describe, expect, it } from "bun:test";
import { evaluate } from "../src/evaluator.ts";
import type { MetricDefinition, ProbeResult } from "../src/types.ts";

function metric(overrides: Partial<MetricDefinition> = {}): MetricDefinition {
  return {
    id: "m1",
    interval: 1,
    interval_agent_push: 10,
    healthy_operation: "under",
    healthy_value: 100,
    unhealthy_operation: "over",
    unhealthy_value: 500,
    ...overrides,
  };
}

describe("evaluator", () => {
  it("returns healthy when value matches healthy operation", () => {
    const r: ProbeResult = { value: 50, timestamp: "t" };
    expect(evaluate(metric(), r).status).toBe("healthy");
  });

  it("returns unhealthy when value matches unhealthy operation", () => {
    const r: ProbeResult = { value: 600, timestamp: "t" };
    expect(evaluate(metric(), r).status).toBe("unhealthy");
  });

  it("returns degraded when value matches neither", () => {
    const r: ProbeResult = { value: 250, timestamp: "t" };
    expect(evaluate(metric(), r).status).toBe("degraded");
  });

  it("returns no_data when status_hint=no_data even with a numeric value", () => {
    const r: ProbeResult = { value: 50, timestamp: "t", status_hint: "no_data", reason: "network" };
    const e = evaluate(metric(), r);
    expect(e.status).toBe("no_data");
    expect(e.reason).toBe("network");
  });

  it("returns no_data when value is null", () => {
    const r: ProbeResult = { value: null, timestamp: "t" };
    expect(evaluate(metric(), r).status).toBe("no_data");
  });

  it("operators are strict — exact equality on `over` does not match", () => {
    const r: ProbeResult = { value: 500, timestamp: "t" };
    // healthy: under 100 → 500 not less than 100, false
    // unhealthy: over 500 → 500 not greater than 500, false (strict)
    // -> degraded
    expect(evaluate(metric(), r).status).toBe("degraded");
  });

  it("forwards timestamp + metadata + reason untouched", () => {
    const r: ProbeResult = {
      value: 75,
      timestamp: "2026-05-22T00:00:00Z",
      reason: "ok",
      metadata: { source_type: "http" },
    };
    const e = evaluate(metric(), r);
    expect(e.timestamp).toBe("2026-05-22T00:00:00Z");
    expect(e.reason).toBe("ok");
    expect(e.metadata).toEqual({ source_type: "http" });
  });

  it("handles equal-mode thresholds", () => {
    const m = metric({ healthy_operation: "equal", healthy_value: 0 });
    expect(evaluate(m, { value: 0, timestamp: "t" }).status).toBe("healthy");
    expect(evaluate(m, { value: 1, timestamp: "t" }).status).toBe("degraded");
  });
});
