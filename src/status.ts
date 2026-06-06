// Pure status-decision helpers — unit-testable without booting the agent.
//
// Rule: operators are strict everywhere. A value exactly equal to a
// threshold under `over` / `under` does NOT match. Cloud's read-side
// must use the same comparison.

export type Operation = "over" | "under" | "equal";

export function evaluateOperation(value: number, operation: Operation, threshold: number): boolean {
  // Non-finite value or threshold can't satisfy any strict operator — return
  // false so a NaN/Infinity never yields a spurious healthy/unhealthy verdict.
  // (evaluate() already routes non-finite values to no_data; this hardens any
  // direct caller.)
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return false;
  switch (operation) {
    case "over":
      return value > threshold;
    case "under":
      return value < threshold;
    case "equal":
      return value === threshold;
    default:
      return false;
  }
}

export function evaluateStatus(
  value: number,
  healthyOperation: Operation,
  healthyValue: number,
  unhealthyOperation: Operation,
  unhealthyValue: number
): "healthy" | "degraded" | "unhealthy" {
  if (evaluateOperation(value, healthyOperation, healthyValue)) return "healthy";
  if (evaluateOperation(value, unhealthyOperation, unhealthyValue)) return "unhealthy";
  return "degraded";
}
