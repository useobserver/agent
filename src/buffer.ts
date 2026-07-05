// Local write-ahead buffer for unsent metric payloads.
//
// SQLite-backed (bun:sqlite) so it survives agent restarts. On every
// failed cloud push the payload is appended; the drain controller
// flushes with exponential backoff. Capped at MAX_ROWS rows: oldest
// entries are evicted beyond the cap and the eviction is logged so
// operators notice persistent outages.

import { Database } from "bun:sqlite";
import { renameSync } from "node:fs";
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

// SQLITE_CORRUPT / SQLITE_NOTADB mean the file on disk is not (or no
// longer) a usable database. Bun's SQLiteError carries `code`; match
// the message too as belt-and-suspenders across bun versions.
function isCorruptionError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null | undefined;
  const code = typeof e?.code === "string" ? e.code : "";
  const message = typeof e?.message === "string" ? e.message : "";
  return (
    /SQLITE_CORRUPT|SQLITE_NOTADB/i.test(code) ||
    /database disk image is malformed|file is not a database/i.test(message)
  );
}

function errText(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown } | null | undefined;
  const code = typeof e?.code === "string" ? `${e.code}: ` : "";
  return `${code}${e instanceof Error ? e.message : String(error)}`;
}

// Open the buffer database defensively. A garbage file often opens
// fine and only fails on the first real statement, so the pragmas plus
// a cheap post-open probe (SELECT count(*)) run inside the same guard.
//
// - Corrupt / not-a-database → rename the file (+ -wal/-shm siblings)
//   to `<name>.corrupt-<epoch>` and recreate empty. Old samples are
//   lost, but the buffer works again instead of throwing on every call.
// - Anything else unrecoverable (SQLITE_FULL, permissions, …) → fall
//   back to an IN-MEMORY database. Non-persistent, but delivering
//   recent samples beats delivering none.
function openDatabase(bufferPath: string): Database {
  const attempt = (): Database => {
    const db = new Database(bufferPath);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
      // Cheap corruption probe — touches page 1 so a bad file fails
      // here, at open time, not on the first enqueue mid-flight.
      db.prepare("SELECT count(*) AS n FROM sqlite_master").get();
      return db;
    } catch (error) {
      try {
        db.close();
      } catch {
        /* already unusable */
      }
      throw error;
    }
  };

  try {
    return attempt();
  } catch (openError) {
    if (isCorruptionError(openError)) {
      const quarantine = `${bufferPath}.corrupt-${Date.now()}`;
      console.error(
        `[buffer] ERROR: SQLite buffer at ${bufferPath} is corrupt (${errText(openError)}). ` +
          `Moving it aside to ${quarantine} and recreating an empty buffer. ` +
          `Any samples buffered in the old file are lost.`,
      );
      for (const ext of ["", "-wal", "-shm"]) {
        try {
          renameSync(`${bufferPath}${ext}`, `${quarantine}${ext}`);
        } catch {
          /* sibling may not exist */
        }
      }
      try {
        return attempt();
      } catch (retryError) {
        console.error(
          `[buffer] ERROR: recreating the buffer at ${bufferPath} failed too (${errText(retryError)}). ` +
            `Falling back to a NON-PERSISTENT in-memory buffer — samples will not survive a restart.`,
        );
        return new Database(":memory:");
      }
    }
    console.error(
      `[buffer] ERROR: cannot open SQLite buffer at ${bufferPath} (${errText(openError)}). ` +
        `Falling back to a NON-PERSISTENT in-memory buffer — samples will not survive a restart.`,
    );
    return new Database(":memory:");
  }
}

export function createBuffer(bufferPath: string, { maxRows }: CreateBufferOptions = {}): BufferAccess {
  const cap = resolveBufferCap(maxRows, process.env.BUFFER_MAX_ROWS);
  console.log(`[buffer] eviction cap = ${cap} rows`);
  const db = openDatabase(bufferPath);

  // No explicit index on id: `id INTEGER PRIMARY KEY` IS the rowid, so
  // the old idx_metric_buffer_id was redundant. Existing databases that
  // still carry it keep working — we just stop creating it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS metric_buffer (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const stmtCount = db.prepare("SELECT COUNT(*) AS n FROM metric_buffer");
  const stmtInsert = db.prepare("INSERT INTO metric_buffer (payload) VALUES (?)");
  const stmtSelectBatch = db.prepare("SELECT id, payload FROM metric_buffer ORDER BY id ASC LIMIT ?");
  const stmtDeleteById = db.prepare("DELETE FROM metric_buffer WHERE id = ?");
  const stmtDeleteOldest = db.prepare(
    "DELETE FROM metric_buffer WHERE id IN (SELECT id FROM metric_buffer ORDER BY id ASC LIMIT ?)"
  );
  const stmtOldest = db.prepare("SELECT created_at FROM metric_buffer ORDER BY id ASC LIMIT 1");

  // Post-close guard: a closed buffer must never resurrect the DB or
  // throw on a late call — enqueue drops (warn once), reads report
  // empty, batches yields nothing, ack no-ops, close is idempotent.
  let closed = false;
  let warnedClosedEnqueue = false;

  // INSERT → COUNT → DELETE-oldest as one atomic unit so a crash
  // between statements can't leave the buffer above cap or the count
  // observed by a concurrent reader mid-eviction.
  const enqueueTx = db.transaction((json: string): BufferEnqueueResult => {
    stmtInsert.run(json);
    const row = stmtCount.get() as { n: number };
    if (row.n > cap) {
      const overflow = row.n - cap;
      stmtDeleteOldest.run(overflow);
      return { dropped: overflow, size: cap };
    }
    return { dropped: 0, size: row.n };
  });

  function enqueue(payload: unknown): BufferEnqueueResult {
    if (closed) {
      if (!warnedClosedEnqueue) {
        warnedClosedEnqueue = true;
        console.warn("[buffer] enqueue after close(); dropping sample. (Logged once.)");
      }
      return { dropped: 1, size: 0 };
    }
    return enqueueTx(JSON.stringify(payload));
  }

  function size(): number {
    if (closed) return 0;
    return (stmtCount.get() as { n: number }).n;
  }

  function oldestAgeSeconds(): number {
    if (closed) return 0;
    const row = stmtOldest.get() as { created_at: number } | null;
    if (!row) return 0;
    const nowSec = Math.floor(Date.now() / 1000);
    return Math.max(0, nowSec - row.created_at);
  }

  function* batches(batchSize: number = 50): Generator<BufferRow[], void, unknown> {
    while (!closed) {
      const rows = stmtSelectBatch.all(batchSize) as BufferRow[];
      if (rows.length === 0) return;
      yield rows;
    }
  }

  function ack(id: number): void {
    if (closed) return;
    stmtDeleteById.run(id);
  }

  function close(): void {
    if (closed) return;
    closed = true;
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
    // Keep the (now closed) instance around instead of nulling it —
    // nulling let any later call resurrect a fresh DB after shutdown.
    // The closed instance no-ops every call instead.
    if (singleton) singleton.close();
  },
  get MAX_ROWS(): number {
    return getSingleton().MAX_ROWS;
  },
};

export default bufferAccess;
