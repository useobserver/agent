// Postgres backend for the database probe.
//
// Uses postgres.js (`postgres` package). Each (connection_string,
// statement_timeout_ms) pair gets one long-lived client with a tiny
// connection pool (max=2). The pool ceiling guarantees that even
// pathological probe configurations cannot exhaust the upstream
// database's connection limit.
//
// Connection strings are NEVER persisted in source_config, logged,
// or surfaced in ProbeResult metadata. The agent reads them from
// process.env at execute() time via the configured ref.

import crypto from "node:crypto";
import postgres from "postgres";

export interface PgQueryResult {
  ok: true;
  value: number;
  row_count: number;
  column_count: number;
}
export interface PgQueryFailure {
  ok: false;
  reason: string;
  detail?: string;
}

const MAX_POOL = 2;
// Client-side deadline slack on top of the server-side statement_timeout.
// The server timeout should always fire first; the race is the backstop
// for network partitions where the server response never arrives.
const RACE_SLACK_MS = 2_000;

// Per-(dsn, statement_timeout_ms) Sql client cache. The dsn is hashed
// before being used as a key so the connection string never appears
// in any in-memory map key, log line, or test output.
const cache = new Map<string, ReturnType<typeof postgres>>();

function cacheKey(dsn: string, statementTimeoutMs: number): string {
  const sum = crypto.createHash("sha256");
  sum.update(dsn);
  sum.update("\x00");
  sum.update(String(statementTimeoutMs));
  return sum.digest("hex");
}

const MAX_CACHE_ENTRIES = 32;

function evictOldestIfFull(): void {
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done || oldest.value === undefined) break;
    const ev = cache.get(oldest.value);
    cache.delete(oldest.value);
    try {
      void ev?.end({ timeout: 1 }).catch(() => {
        /* fire-and-forget close; a late rejection must not surface */
      });
    } catch {
      /* best-effort */
    }
  }
}

function getClient(dsn: string, statementTimeoutMs: number): ReturnType<typeof postgres> {
  const key = cacheKey(dsn, statementTimeoutMs);
  const cached = cache.get(key);
  if (cached) {
    // Touch ordering: delete + re-set so the entry moves to the
    // newest slot (LRU semantics piggybacking on Map insertion order).
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  evictOldestIfFull();
  const client = postgres(dsn, {
    max: MAX_POOL,
    // statement_timeout is applied per session. postgres.js (pinned
    // to ^3.4.5) types `connection.statement_timeout` as numeric but
    // the runtime forwards these as GUC SETs at connect time — string
    // values are accepted and explicit `String(...)` avoids any
    // surprise integer→bigint coercion. The cast through unknown
    // works around the overly-strict declaration. If we bump the
    // library, re-verify this option still accepts a string.
    connection: ({
      statement_timeout: String(statementTimeoutMs),
      application_name: "observer-agent",
    } as unknown) as { statement_timeout?: number; application_name?: string },
    // Client-side TCP/TLS connect deadline (seconds). Without it a
    // blackholed endpoint hangs the probe until the OS gives up —
    // statement_timeout only covers the query, not the handshake.
    connect_timeout: Math.max(1, Math.ceil(Math.min(statementTimeoutMs, 5_000) / 1000)),
    // Don't auto-prepare; we run one-shot queries.
    prepare: false,
    // Idle connections close after 10s so we don't hold connections
    // open across long probe gaps.
    idle_timeout: 10,
    // Connection retry/backoff is handled at the agent's cron-tick
    // level; the SDK's own retry logic would just multiply latency
    // on stuck endpoints.
    max_lifetime: 60 * 5,
    onnotice: () => {
      /* drop notices */
    },
  });
  cache.set(key, client);
  return client;
}

export async function runQuery(
  dsn: string,
  query: string,
  statementTimeoutMs: number,
): Promise<PgQueryResult | PgQueryFailure> {
  // Mirror the mysql/mongo/redis sibling guards: a zero/NaN timeout would set
  // statement_timeout="0", disabling the DB-side timeout entirely. Schema bounds
  // it today, but re-check here for the out-of-band-edit scenario.
  if (!Number.isFinite(statementTimeoutMs) || statementTimeoutMs <= 0) {
    return { ok: false, reason: "db_invalid_timeout", detail: String(statementTimeoutMs) };
  }
  let raceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Client acquisition stays INSIDE the try: a malformed DSN makes the
    // driver throw synchronously, and that error message can embed the
    // full connection string (password included). classifyPgError maps
    // it to a typed reason and never echoes the driver message.
    const sql = getClient(dsn, statementTimeoutMs);
    // postgres.js exposes a tag function for parameterized queries.
    // The probe contract takes a verbatim query string with no
    // interpolation, so we use the `.unsafe` escape hatch. The query
    // is operator-supplied configuration; SELECT-only and read-only
    // safeguards live at the dispatch layer above us.
    //
    // Client-side deadline: statement_timeout is server-side only — a
    // network partition after connect leaves the promise hanging. Race
    // against statementTimeoutMs + slack; on loss, detach the abandoned
    // query promise so its eventual rejection can't go unhandled.
    const queryPromise = sql.unsafe(query) as unknown as Promise<Array<Record<string, unknown>>>;
    const timedOut = Symbol("timeout");
    const raced = await Promise.race([
      queryPromise,
      new Promise<typeof timedOut>((resolve) => {
        raceTimer = setTimeout(() => resolve(timedOut), statementTimeoutMs + RACE_SLACK_MS);
      }),
    ]);
    if (raced === timedOut) {
      Promise.resolve(queryPromise).catch(() => {
        /* abandoned after client-side deadline */
      });
      return { ok: false, reason: "db_timeout" };
    }
    const rows = raced as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, reason: "db_empty_result" };
    }
    if (rows.length > 1) {
      return { ok: false, reason: "db_multi_row", detail: `query returned ${rows.length} rows` };
    }
    const row = rows[0]!;
    const cols = Object.keys(row);
    if (cols.length === 0) {
      return { ok: false, reason: "db_empty_result" };
    }
    if (cols.length > 1) {
      return { ok: false, reason: "db_multi_column", detail: `query returned ${cols.length} columns` };
    }
    const raw = row[cols[0]!];
    return coerceNumeric(raw, rows.length, cols.length);
  } catch (err) {
    return classifyPgError(err);
  } finally {
    clearTimeout(raceTimer);
  }
}

function coerceNumeric(raw: unknown, rowCount: number, colCount: number): PgQueryResult | PgQueryFailure {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "db_null_value" };
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, reason: "db_non_numeric", detail: "non-finite" };
    return { ok: true, value: raw, row_count: rowCount, column_count: colCount };
  }
  if (typeof raw === "boolean") {
    return { ok: true, value: raw ? 1 : 0, row_count: rowCount, column_count: colCount };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: "db_non_numeric", detail: "empty string" };
    }
    const n = Number(trimmed);
    if (Number.isFinite(n)) {
      return { ok: true, value: n, row_count: rowCount, column_count: colCount };
    }
    return { ok: false, reason: "db_non_numeric", detail: `string "${trimmed.slice(0, 32)}"` };
  }
  if (typeof raw === "bigint") {
    // Cast to Number; range check.
    const n = Number(raw);
    if (Number.isSafeInteger(n)) {
      return { ok: true, value: n, row_count: rowCount, column_count: colCount };
    }
    return { ok: false, reason: "db_non_numeric", detail: "bigint exceeds JS-safe range" };
  }
  return { ok: false, reason: "db_non_numeric", detail: typeof raw };
}

function classifyPgError(err: unknown): PgQueryFailure {
  const e = err as { code?: string; severity?: string; message?: string; name?: string };
  const code = e?.code ?? "";
  if (code === "57014") return { ok: false, reason: "db_timeout" };
  if (code === "42501") return { ok: false, reason: "db_access_denied" };
  if (code.startsWith("42")) return { ok: false, reason: "db_syntax_error" };
  if (code.startsWith("28")) return { ok: false, reason: "db_auth_failed" };
  if (code.startsWith("08") || e?.name === "AggregateError") return { ok: false, reason: "db_connection_failed" };
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
    return { ok: false, reason: "db_connection_failed" };
  }
  return { ok: false, reason: "db_error" };
}

export function resetPgClientCacheForTests(): void {
  for (const c of cache.values()) {
    try {
      void c.end({ timeout: 1 }).catch(() => {
        /* ignore */
      });
    } catch {
      /* ignore */
    }
  }
  cache.clear();
}
