// drain controller for the local SQLite queue.
//
// Decouples the producer (probe execute → enqueue) from the consumer
// (drain → POST to cloud). Every probe writes to the queue first; this
// controller is the only thing that talks to the cloud.
//
// Since 1.5.0 the drain posts BATCHES to /api/agent/receiver/batch (up to
// batchSize samples per request) instead of one request per sample: a 10k-row
// WAL after an outage drains in ~100 requests instead of 10k sequential ones
// through the cloud's rate limits. The cloud accepts good rows per-row and
// reports rejects by index, so one bad row no longer costs its batch.

import type { BufferAccess, DrainController, DrainTickResult, BufferRow } from "./types.ts";

export const DEFAULT_BACKOFF_MIN_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 5 * 60 * 1_000;
export const DEFAULT_BATCH_SIZE = 100;

export interface DrainOptions {
  buffer: BufferAccess;
  /** POST the payload array to the cloud batch receiver; returns the parsed
   *  response body (or null). Throws with `.status` on HTTP error. */
  post: (payloads: unknown[]) => Promise<unknown>;
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
// With the per-row batch contract a 400 means EVERY row in the batch was
// rejected (the cloud accepts partial batches with 200 + rejected[]), so
// whole-batch drop on 400 no longer over-drops.
//
// 409 is the duplicate-key fence: another process with a newer started_at
// owns this key, and the cloud will keep rejecting this process until it
// restarts. Retrying would queue-spin forever, so drop — with a dedicated,
// throttled warning instead of the per-batch drop log.
const DROP_STATUSES = new Set([400, 404, 409, 413, 422]);

const FENCE_WARN_INTERVAL_MS = 5 * 60 * 1_000;

// Poor man's dead-letter: a head-of-line batch that fails "transient"
// (5xx / network) on every attempt would otherwise block every newer
// row forever — the drain always retries the queue head first. After
// this many CONSECUTIVE transient failures, the HEAD ROW ONLY is
// ack-and-dropped with an ERROR log so the queue keeps moving (the rest
// of the batch retries next tick — if the head row was the poison, the
// remainder now flows). With backoff capped at 5 min, 20 attempts is
// well over an hour of retrying: a genuine cloud outage loses at most
// one row per ~hour.
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
  // head-row id → consecutive transient-failure count. Only head-of-line
  // rows ever accumulate (the drain pauses on the first transient failure),
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
      // Parse locally; unparseable rows are dropped individually so they
      // can't poison the batch they happened to ride in.
      const parsed: Array<{ row: BufferRow; payload: unknown }> = [];
      for (const row of rows) {
        try {
          parsed.push({ row, payload: JSON.parse(row.payload) });
        } catch (parseError) {
          const msg = parseError instanceof Error ? parseError.message : String(parseError);
          log("WARN", `Buffer row id=${row.id} unparseable; dropping. ${msg}`);
          buffer.ack(row.id);
          transientFailures.delete(row.id);
          dropped += 1;
        }
      }
      if (parsed.length === 0) continue;

      try {
        const body = (await post(parsed.map((p) => p.payload))) as
          | { accepted?: number; rejected?: Array<{ index: number; field?: string; code?: string }> }
          | null
          | undefined;
        for (const p of parsed) {
          buffer.ack(p.row.id);
          transientFailures.delete(p.row.id);
        }
        acked += parsed.length;
        const rejects = Array.isArray(body?.rejected) ? body.rejected : [];
        if (rejects.length > 0) {
          dropped += rejects.length;
          acked -= rejects.length;
          const sample = rejects
            .slice(0, 3)
            .map((r) => `#${r.index} ${r.field ?? "?"}:${r.code ?? "?"}`)
            .join(", ");
          log("WARN", `Cloud rejected ${rejects.length}/${parsed.length} rows in batch (${sample}).`);
        }
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
            log("WARN", `Cloud rejected batch (HTTP ${c.status}); dropping ${parsed.length} rows.`);
          }
          for (const p of parsed) {
            buffer.ack(p.row.id);
            transientFailures.delete(p.row.id);
          }
          dropped += parsed.length;
          continue;
        }
        // Transient failure — normally retry-with-backoff, but a head row
        // that keeps failing transiently is a poison pill: drop JUST the
        // head after the cap so newer rows flow.
        const headId = parsed[0].row.id;
        const failures = (transientFailures.get(headId) ?? 0) + 1;
        if (failures >= POISON_PILL_MAX_TRANSIENT_FAILURES) {
          transientFailures.delete(headId);
          const headPayload = parsed[0].payload;
          const metricId =
            headPayload != null && typeof headPayload === "object" && "metric_id" in headPayload
              ? String((headPayload as { metric_id?: unknown }).metric_id)
              : "unknown";
          log(
            "ERROR",
            `Buffer row id=${headId} (metric_id=${metricId}) failed ${failures} consecutive transient attempts ` +
              `(last: HTTP ${c.status ?? "network error"}); dropping it to unblock the queue.`,
          );
          buffer.ack(headId);
          dropped += 1;
          continue;
        }
        transientFailures.set(headId, failures);
        backoffMs = Math.min(backoffMs * 2, backoffMaxMs);
        return { acked, dropped, paused: true };
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
