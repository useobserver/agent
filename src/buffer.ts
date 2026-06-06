// Local write-ahead buffer for unsent metric payloads.
//
// SQLite-backed (bun:sqlite) so it survives agent restarts. On every
// failed cloud push the payload is appended; the drain controller
// flushes with exponential backoff. Capped at MAX_ROWS rows: oldest
// entries are evicted beyond the cap and the eviction is logged so
// operators notice persistent outages.

import { Database } from "bun:sqlite";
import type { BufferAccess, BufferEnqueueResult, BufferRow } from "./types.ts";

interface CreateBufferOptions {
  maxRows?: number;
}

const DEFAULT_BUFFER_MAX_ROWS = 10000;

// Resolve the eviction cap defensively: a non-numeric/empty BUFFER_MAX_ROWS
// (Number("foo")=NaN, Number("")=0) must NOT disable eviction — that would let
// the SQLite WAL grow until the disk fills. Prefer the explicit option, then
// the env, then the default. Same guard as the postgres timeout / dashboard
// port fixes.
export function resolveBufferCap(maxRows?: unknown, envRaw?: unknown): number {
  const optMax = Number(maxRows);
  if (Number.isFinite(optMax) && optMax > 0) return Math.trunc(optMax);
  const envMax = Number(envRaw);
  if (Number.isFinite(envMax) && envMax > 0) return Math.trunc(envMax);
  return DEFAULT_BUFFER_MAX_ROWS;
}

export function createBuffer(bufferPath: string, { maxRows }: CreateBufferOptions = {}): BufferAccess {
  const cap = resolveBufferCap(maxRows, process.env.BUFFER_MAX_ROWS);
  console.log(`[buffer] eviction cap = ${cap} rows`);
  const db = new Database(bufferPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS metric_buffer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_metric_buffer_id ON metric_buffer (id);
  `);

  const stmtCount = db.prepare("SELECT COUNT(*) AS n FROM metric_buffer");
  const stmtInsert = db.prepare("INSERT INTO metric_buffer (payload) VALUES (?)");
  const stmtSelectBatch = db.prepare("SELECT id, payload FROM metric_buffer ORDER BY id ASC LIMIT ?");
  const stmtDeleteById = db.prepare("DELETE FROM metric_buffer WHERE id = ?");
  const stmtDeleteOldest = db.prepare(
    "DELETE FROM metric_buffer WHERE id IN (SELECT id FROM metric_buffer ORDER BY id ASC LIMIT ?)"
  );
  const stmtOldest = db.prepare("SELECT created_at FROM metric_buffer ORDER BY id ASC LIMIT 1");

  function enqueue(payload: unknown): BufferEnqueueResult {
    stmtInsert.run(JSON.stringify(payload));
    const row = stmtCount.get() as { n: number };
    if (row.n > cap) {
      const overflow = row.n - cap;
      stmtDeleteOldest.run(overflow);
      return { dropped: overflow, size: cap };
    }
    return { dropped: 0, size: row.n };
  }

  function size(): number {
    return (stmtCount.get() as { n: number }).n;
  }

  function oldestAgeSeconds(): number {
    const row = stmtOldest.get() as { created_at: number } | null;
    if (!row) return 0;
    const nowSec = Math.floor(Date.now() / 1000);
    return Math.max(0, nowSec - row.created_at);
  }

  function* batches(batchSize: number = 50): Generator<BufferRow[], void, unknown> {
    while (true) {
      const rows = stmtSelectBatch.all(batchSize) as BufferRow[];
      if (rows.length === 0) return;
      yield rows;
    }
  }

  function ack(id: number): void {
    stmtDeleteById.run(id);
  }

  function close(): void {
    db.close();
  }

  return { enqueue, size, oldestAgeSeconds, batches, ack, close, MAX_ROWS: cap };
}

let singleton: BufferAccess | null = null;

function getSingleton(): BufferAccess {
  if (!singleton) {
    const defaultPath = process.env.BUFFER_PATH || "./observer-agent-buffer.db";
    singleton = createBuffer(defaultPath);
  }
  return singleton;
}

const bufferAccess: BufferAccess = {
  enqueue: (payload) => getSingleton().enqueue(payload),
  size: () => getSingleton().size(),
  oldestAgeSeconds: () => getSingleton().oldestAgeSeconds(),
  batches: (batchSize?: number) => getSingleton().batches(batchSize),
  ack: (id: number) => getSingleton().ack(id),
  close: () => {
    if (singleton) {
      singleton.close();
      singleton = null;
    }
  },
  get MAX_ROWS(): number {
    return getSingleton().MAX_ROWS;
  },
};

export default bufferAccess;
