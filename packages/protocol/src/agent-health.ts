// agent health alert state machine.
//
// Two alerts fire from the heartbeat receiver:
//   - agent.lag_high — queue_depth > 1000 OR oldest pending > 300s
//   - agent.uptime_degraded — uptime_pct_24h < 95%
//
// Both follow the same state shape:
//   { state: "off" | "on",
//     open_at?: ISO timestamp the alert opened,
//     below_since?: ISO timestamp the signal first dropped back under
//                   the threshold (used for clear hysteresis) }
//
// Transitions are pure functions of (previous state, current signal,
// now). Persistence and event dispatch are the route handler's job —
// this module just answers "what should the new state be, and is
// there an event to emit?". Pure functions keep the test surface
// tractable.

import {
  LAG_QUEUE_DEPTH_THRESHOLD,
  LAG_OLDEST_AGE_SECONDS_THRESHOLD,
  UPTIME_PCT_THRESHOLD,
  CLEAR_HYSTERESIS_MS,
  type HealthAlertState,
} from "./heartbeat";

export type Signal = "above" | "below";
export type AlertEventKind = "open" | "cleared";

export interface AlertEvent {
  kind: AlertEventKind;
  at: string;
}

export interface TransitionResult {
  newState: HealthAlertState;
  event: AlertEvent | null;
}

export function classifyLagSignal(queueDepth: number, queueOldestAgeSeconds: number): Signal {
  return queueDepth > LAG_QUEUE_DEPTH_THRESHOLD || queueOldestAgeSeconds > LAG_OLDEST_AGE_SECONDS_THRESHOLD
    ? "above"
    : "below";
}

export function classifyUptimeSignal(uptimePct24h: number): Signal {
  return uptimePct24h < UPTIME_PCT_THRESHOLD ? "above" : "below";
}

// transition(prevState, signal, nowMs, clearAfterMs) → { newState, event }
//
//   signal: "above" | "below" — whether the signal is currently
//     breaching the threshold this tick.
//   event: { kind: "open" | "cleared", at: ISO } — caller dispatches.
//     null when nothing changed.
//
// Hysteresis: once open, the alert only clears after the signal has
// been below the threshold for at least clearAfterMs. A flap that
// returns above before the hysteresis window expires resets the
// below_since marker without emitting a clear.
export function transition(
  prevState: HealthAlertState | null | undefined,
  signal: Signal,
  nowMs: number,
  clearAfterMs: number = CLEAR_HYSTERESIS_MS,
): TransitionResult {
  const now = new Date(nowMs).toISOString();
  const s: HealthAlertState =
    prevState && typeof prevState === "object" ? prevState : { state: "off" };

  if (signal === "above") {
    if (s.state === "off") {
      return {
        newState: { state: "on", open_at: now },
        event: { kind: "open", at: now },
      };
    }
    // Already on; clear any pending below marker so the hysteresis window restarts.
    if (s.below_since) {
      const { below_since: _drop, ...rest } = s;
      return { newState: rest, event: null };
    }
    return { newState: s, event: null };
  }

  // signal === "below"
  if (s.state === "off") {
    return { newState: s, event: null };
  }
  if (!s.below_since) {
    return { newState: { ...s, below_since: now }, event: null };
  }
  const belowMs = nowMs - new Date(s.below_since).getTime();
  if (belowMs >= clearAfterMs) {
    return {
      newState: { state: "off" },
      event: { kind: "cleared", at: now },
    };
  }
  return { newState: s, event: null };
}

// Convert agent_uptime_seconds_24h (0..86400) to a pct integer (0..100).
export function uptimeSecondsToPct(uptimeSeconds24h: number): number {
  if (!Number.isFinite(uptimeSeconds24h) || uptimeSeconds24h <= 0) return 0;
  if (uptimeSeconds24h >= 86_400) return 100;
  return Math.floor((uptimeSeconds24h * 100) / 86_400);
}
