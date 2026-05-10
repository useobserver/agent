// @ts-nocheck — follow-up: tighten test types per-file.
import { describe, expect, it } from "bun:test";
import { evaluateOperation, evaluateStatus } from "../src/status";

describe("evaluateOperation", () => {
  // Strict comparisons everywhere — values exactly equal to a threshold under
  // 'over' or 'under' must NOT match.
  const cases = [
    // [value, op, threshold, expected]
    [10, "over", 5, true],
    [5, "over", 5, false], // strict: not >
    [4, "over", 5, false],
    [4, "under", 5, true],
    [5, "under", 5, false], // strict: not <
    [6, "under", 5, false],
    [5, "equal", 5, true],
    [5.0, "equal", 5, true],
    [4, "equal", 5, false],
    [10, "garbage", 0, false],
    [0, "over", 0, false],
    [0, "under", 0, false],
    [-1, "over", 0, false],
    [-1, "under", 0, true],
    [Number.MAX_SAFE_INTEGER, "over", 0, true],
  ];

  for (const [value, op, threshold, expected] of cases) {
    it(`${value} ${op} ${threshold} → ${expected}`, () => {
      expect(evaluateOperation(value, op, threshold)).toBe(expected);
    });
  }
});

describe("evaluateStatus", () => {
  // Source rule: if matches healthy → 'healthy'; elif matches unhealthy →
  // 'unhealthy'; else 'degraded'. Healthy wins over unhealthy when both
  // would match (cannot happen with sane configs but tested for safety).
  const cases = [
    // typical: over for healthy, under for unhealthy
    { value: 100, hOp: "over", hVal: 50, uOp: "under", uVal: 10, want: "healthy" },
    { value: 5, hOp: "over", hVal: 50, uOp: "under", uVal: 10, want: "unhealthy" },
    { value: 30, hOp: "over", hVal: 50, uOp: "under", uVal: 10, want: "degraded" },
    // strict at thresholds
    { value: 50, hOp: "over", hVal: 50, uOp: "under", uVal: 10, want: "degraded" },
    { value: 10, hOp: "over", hVal: 50, uOp: "under", uVal: 10, want: "degraded" },
    // inverted (under for healthy, over for unhealthy) — e.g. error rate
    { value: 0, hOp: "under", hVal: 1, uOp: "over", uVal: 10, want: "healthy" },
    { value: 50, hOp: "under", hVal: 1, uOp: "over", uVal: 10, want: "unhealthy" },
    { value: 5, hOp: "under", hVal: 1, uOp: "over", uVal: 10, want: "degraded" },
    // equal operator
    { value: 1, hOp: "equal", hVal: 1, uOp: "equal", uVal: 0, want: "healthy" },
    { value: 0, hOp: "equal", hVal: 1, uOp: "equal", uVal: 0, want: "unhealthy" },
    { value: 2, hOp: "equal", hVal: 1, uOp: "equal", uVal: 0, want: "degraded" },
    // both rules match — healthy wins
    { value: 5, hOp: "over", hVal: 0, uOp: "over", uVal: 1, want: "healthy" },
  ];

  for (const c of cases) {
    it(`${c.value} healthy(${c.hOp} ${c.hVal}) unhealthy(${c.uOp} ${c.uVal}) → ${c.want}`, () => {
      expect(evaluateStatus(c.value, c.hOp, c.hVal, c.uOp, c.uVal)).toBe(c.want);
    });
  }
});