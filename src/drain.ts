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
const DROP_STATUSES = new Set([400, 404, 422]);

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
          dropped += 1;
          continue;
        }
        try {
          await post(payload);
          buffer.ack(row.id);
          acked += 1;
        } catch (error) {
          const c = classify(error);
          if (c.kind === "client_error") {
            log("WARN", `Cloud rejected payload (HTTP ${c.status}); dropping row id=${row.id}.`);
            buffer.ack(row.id);
            dropped += 1;
            continue;
          }
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
