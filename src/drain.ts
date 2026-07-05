// drain controller for the local SQLite queue.
//
// Decouples the producer (probe execute → enqueue) from the consumer
// (drain → POST to cloud). Every probe writes to the queue first; this
// controller is the only thing that talks to the cloud.

import type { BufferAccess, DrainController, DrainTickResult } from "./types.ts";

export const DEFAULT_BACKOFF_MIN_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 5 * 60 * 1_000;
export const DEFAULT_BATCH_SIZE = 100;

export interface DrainOptions {
  buffer: BufferAccess;
  post: (payload: unknown) => Promise<unknown>;
  log?: (level: string, message: string) => void;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  batchSize?: number;
}

interface ClassifiedError {
  kind: "client_error" | "transient";
  status?: number;
}

// 4xx that mean "this payload will never succeed" — safe to ack-and-drop.
// Everything else (401/403 token-rotation races, 408 timeout, 425 too-early,
// 429 backpressure, all 5xx, network) is transient and MUST be retried, or the
// SQLite WAL — which exists precisely to survive cloud unavailability — gets
// silently emptied on a recoverable error.
//
// 409 is the duplicate-key fence: another process with a newer started_at
// owns this key, and the cloud will keep rejecting this process until it
// restarts. Retrying would queue-spin forever, so drop — with a dedicated,
// throttled warning instead of the per-row drop log.
const DROP_STATUSES = new Set([400, 404, 409, 422]);

const FENCE_WARN_INTERVAL_MS = 5 * 60 * 1_000;

// Poor man's dead-letter: a head-of-line row that fails "transient"
// (5xx / network) on every attempt would otherwise block every newer
// row forever — the drain always retries the queue head first. After
// this many CONSECUTIVE transient failures of the SAME head row, it is
// ack-and-dropped with an ERROR log so the queue keeps moving. The
// counter is per-row and cleared on ack/drop, and with backoff capped
// at 5 min, 20 attempts is well over an hour of retrying — a genuine
// cloud outage loses at most one row per ~hour, while a poison pill
// stops blocking the queue the same day it appears.
export const POISON_PILL_MAX_TRANSIENT_FAILURES = 20;

function classify(error: unknown): ClassifiedError {
  const e = error as { response?: { status?: number }; status?: number } | null | undefined;
  const status = e?.response?.status ?? e?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    if (DROP_STATUSES.has(status)) return { kind: "client_error", status };
    return { kind: "transient", status };
  }
  return { kind: "transient", status };
}

export function createDrainController(options: DrainOptions): DrainController {
  const {
    buffer,
    post,
    log = () => {},
    backoffMinMs = DEFAULT_BACKOFF_MIN_MS,
    backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
    batchSize = DEFAULT_BATCH_SIZE,
  } = options;
  if (!buffer) throw new Error("createDrainController: buffer is required");
  if (typeof post !== "function") throw new Error("createDrainController: post is required");

  let backoffMs = backoffMinMs;
  let lastFenceWarnAtMs = 0;
  // rowId → consecutive transient-failure count. Only head-of-line rows
  // ever accumulate (the drain pauses on the first transient failure),
  // and entries are cleared on ack/drop, so this stays tiny.
  const transientFailures = new Map<number, number>();

  async function drainOnce(): Promise<DrainTickResult> {
    if (buffer.size() === 0) {
      backoffMs = backoffMinMs;
      return { acked: 0, dropped: 0, paused: false };
    }
    let acked = 0;
    let dropped = 0;
    for (const rows of buffer.batches(batchSize)) {
      for (const row of rows) {
        let payload: unknown;
        try {
          payload = JSON.parse(row.payload);
        } catch (parseError) {
          const msg = parseError instanceof Error ? parseError.message : String(parseError);
          log("WARN", `Buffer row id=${row.id} unparseable; dropping. ${msg}`);
          buffer.ack(row.id);
          transientFailures.delete(row.id);
          dropped += 1;
          continue;
        }
        try {
          await post(payload);
          buffer.ack(row.id);
          transientFailures.delete(row.id);
          acked += 1;
        } catch (error) {
          const c = classify(error);
          if (c.kind === "client_error") {
            if (c.status === 409) {
              const nowMs = Date.now();
              if (nowMs - lastFenceWarnAtMs >= FENCE_WARN_INTERVAL_MS) {
                lastFenceWarnAtMs = nowMs;
                log(
                  "WARN",
                  "Cloud fenced this process (HTTP 409): another agent process with a newer start time is using this key. Samples from this process are dropped — stop one of the two processes or rotate the key.",
                );
              }
            } else {
              log("WARN", `Cloud rejected payload (HTTP ${c.status}); dropping row id=${row.id}.`);
            }
            buffer.ack(row.id);
            transientFailures.delete(row.id);
            dropped += 1;
            continue;
          }
          // Transient failure — normally retry-with-backoff, but a row
          // that keeps failing transiently at the head of the queue is
          // a poison pill: drop it after the cap so newer rows flow.
          const failures = (transientFailures.get(row.id) ?? 0) + 1;
          if (failures >= POISON_PILL_MAX_TRANSIENT_FAILURES) {
            transientFailures.delete(row.id);
            const metricId =
              payload != null && typeof payload === "object" && "metric_id" in payload
                ? String((payload as { metric_id?: unknown }).metric_id)
                : "unknown";
            log(
              "ERROR",
              `Buffer row id=${row.id} (metric_id=${metricId}) failed ${failures} consecutive transient attempts ` +
                `(last: HTTP ${c.status ?? "network error"}); dropping it to unblock the queue.`,
            );
            buffer.ack(row.id);
            dropped += 1;
            continue;
          }
          transientFailures.set(row.id, failures);
          backoffMs = Math.min(backoffMs * 2, backoffMaxMs);
          return { acked, dropped, paused: true };
        }
      }
    }
    backoffMs = backoffMinMs;
    return { acked, dropped, paused: false };
  }

  return {
    drainOnce,
    currentBackoffMs() {
      return backoffMs;
    },
    resetBackoff() {
      backoffMs = backoffMinMs;
    },
  };
}
