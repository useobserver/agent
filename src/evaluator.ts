// Evaluator — applies threshold rules to a ProbeResult to produce a
// final ProbeStatus + reason, so the scheduler can hand a Source's
// read() output to a single evaluation entry point regardless of
// source mode (pull vs push).
//
// Dwell and state-machine logic for status flips do NOT live here.
// The agent emits the raw verdict per read; the dwell-gated decision
// about when to flip the public state is made server-side, not in the
// agent.
//
// ─── Wire-shape coercion contract ───
// The evaluator is a PURE FUNCTION. It preserves `result.value` even
// when the resulting status is "no_data", so callers retain the
// original sample for logging / debugging / metadata.
//
// The wire payload sent to the receiver endpoint requires `value: 0`
// for no_data verdicts. The dispatcher (NOT this function) coerces at
// the wire boundary before constructing the MetricSamplePayload:
//
//   const evaluated = evaluate(metric, probeResult);
//   const wireValue = evaluated.status === "no_data" ? 0 : evaluated.value;
//
// Moving the coercion into the evaluator would lose the original
// sample for downstream consumers (drain queue introspection, the
// "last value seen" display). Keep it pure here; coerce at the wire
// boundary.

import { evaluateStatus } from "./status.ts";
import type { MetricDefinition, ProbeResult, ProbeStatus } from "./types.ts";

export interface EvaluatedResult {
  /** Final ProbeStatus after applying thresholds (or "no_data"). */
  status: ProbeStatus;
  /** Numeric value (may be null on no_data). */
  value: number | null;
  /** Read timestamp from the Source's ProbeResult. */
  timestamp: string;
  /** Reason string forwarded from the Source, if any. */
  reason?: string;
  /** Metadata forwarded from the Source, if any. */
  metadata?: Record<string, unknown>;
}

/**
 * Apply the metric definition's healthy/unhealthy thresholds to a
 * Source's read() result. Returns `no_data` when the Source signaled
 * `status_hint=no_data` OR when value is null. Otherwise classifies
 * via the strict-operator rule (over=`>`, under=`<`, equal=`=`).
 */
export function evaluate(metric: MetricDefinition, result: ProbeResult): EvaluatedResult {
  // No-data short-circuit. Value is meaningless; reason carries the
  // failure mode (network error, no recent push, etc.).
  if (result.status_hint === "no_data" || result.value === null) {
    return {
      status: "no_data",
      value: result.value,
      timestamp: result.timestamp,
      reason: result.reason,
      metadata: result.metadata,
    };
  }

  const status = evaluateStatus(
    result.value,
    metric.healthy_operation,
    Number(metric.healthy_value),
    metric.unhealthy_operation,
    Number(metric.unhealthy_value),
  );

  return {
    status,
    value: result.value,
    timestamp: result.timestamp,
    reason: result.reason,
    metadata: result.metadata,
  };
}
