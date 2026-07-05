// MySQL backend for the database probe.
//
// Uses mysql2/promise. Per-(dsn, statement_timeout_ms) pool cached
// at max 2 connections. statement_timeout is enforced at the
// session level via `SET SESSION MAX_EXECUTION_TIME = N` (MySQL 5.7+)
// before each query — mysql2's connection pool doesn't expose a
// per-query timeout the way postgres.js does.
//
// Connection strings never persist, log, or leak into metadata.

import crypto from "node:crypto";
import mysql from "mysql2/promise";

export interface MyQueryResult {
  ok: true;
  value: number;
  row_count: number;
  column_count: number;
}
export interface MyQueryFailure {
  ok: false;
  reason: string;
  detail?: string;
}

const MAX_POOL = 2;
const MAX_CACHE_ENTRIES = 32;
// Client-side deadline slack on top of the server-side MAX_EXECUTION_TIME.
// The server timeout should always fire first; the race is the backstop
// for network partitions where the server response never arrives.
const RACE_SLACK_MS = 2_000;

const cache = new Map<string, mysql.Pool>();

function cacheKey(dsn: string, statementTimeoutMs: number): string {
  const h = crypto.createHash("sha256");
  h.update(dsn);
  h.update("\x00");
  h.update(String(statementTimeoutMs));
  return h.digest("hex");
}

function evictOldestIfFull(): void {
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done || oldest.value === undefined) break;
    const ev = cache.get(oldest.value);
    cache.delete(oldest.value);
    try {
      void ev?.end().catch(() => {
        /* fire-and-forget close; a late rejection must not surface */
      });
    } catch {
      /* best-effort */
    }
  }
}

function getPool(dsn: string, statementTimeoutMs: number): mysql.Pool {
  const key = cacheKey(dsn, statementTimeoutMs);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  evictOldestIfFull();
  // mysql2 accepts either a connection-string `uri` or a config
  // object. We use the uri form so the operator's DSN flows through
  // unchanged (supports mysql:// and TCP/Unix-socket variants).
  const pool = mysql.createPool({
    uri: dsn,
    connectionLimit: MAX_POOL,
    waitForConnections: true,
    queueLimit: 0,
    // Don't keep idle conns around longer than 10s.
    idleTimeout: 10_000,
    // Keep TCP keep-alives on so idle connections survive a stateful
    // firewall / load balancer idle-timeout. mysql2's default is
    // true; restated here for explicitness.
    enableKeepAlive: true,
    keepAliveInitialDelay: 30_000,
  });
  cache.set(key, pool);
  return pool;
}

export async function runQuery(
  dsn: string,
  query: string,
  statementTimeoutMs: number,
): Promise<MyQueryResult | MyQueryFailure> {
  // We Math.trunc rather than `| 0` because the bitwise OR coerces
  // NaN / Infinity / non-finite numbers to 0 — and MAX_EXECUTION_TIME=0
  // DISABLES the timeout in MySQL, which would defeat the safeguard.
  // Hard-fail on non-finite so a configuration bug surfaces as a
  // probe error rather than an unbounded query.
  if (!Number.isFinite(statementTimeoutMs) || statementTimeoutMs <= 0) {
    return { ok: false, reason: "db_invalid_timeout", detail: String(statementTimeoutMs) };
  }
  let connection: mysql.PoolConnection | null = null;
  let raceTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOutAbandoned = false;
  try {
    // Pool acquisition stays INSIDE the try: a malformed DSN makes
    // mysql2 throw synchronously, and that error message can embed the
    // full connection string (password included). classifyMyError maps
    // it to a typed reason and never echoes the driver message.
    const pool = getPool(dsn, statementTimeoutMs);
    connection = await pool.getConnection();
    // Enforce statement timeout at the session level. MAX_EXECUTION_TIME
    // applies to SELECT only and is itself in milliseconds. We set
    // and reset it via SET SESSION; the connection is returned to
    // the pool with the session variable in place but that's fine —
    // every probe uses the same statement_timeout_ms within its
    // cache key.
    const clampedTimeout = Math.max(1, Math.trunc(statementTimeoutMs));
    await connection.query(`SET SESSION MAX_EXECUTION_TIME = ${clampedTimeout}`);
    // Client-side deadline: MAX_EXECUTION_TIME is server-side only — a
    // network partition after connect leaves the promise hanging. Race
    // against statementTimeoutMs + slack; on loss, detach the abandoned
    // query promise so its eventual rejection can't go unhandled, and
    // destroy (not release) the connection since it has an in-flight
    // query and can't safely return to the pool.
    const queryPromise = connection.query(query);
    const timedOut = Symbol("timeout");
    const raced = await Promise.race([
      queryPromise,
      new Promise<typeof timedOut>((resolve) => {
        raceTimer = setTimeout(() => resolve(timedOut), statementTimeoutMs + RACE_SLACK_MS);
      }),
    ]);
    if (raced === timedOut) {
      timedOutAbandoned = true;
      Promise.resolve(queryPromise).catch(() => {
        /* abandoned after client-side deadline */
      });
      return { ok: false, reason: "db_timeout" };
    }
    const [rows] = raced as Awaited<typeof queryPromise>;
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, reason: "db_empty_result" };
    }
    if (rows.length > 1) {
      return { ok: false, reason: "db_multi_row", detail: `query returned ${rows.length} rows` };
    }
    const row = rows[0] as Record<string, unknown>;
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
    return classifyMyError(err);
  } finally {
    clearTimeout(raceTimer);
    try {
      if (timedOutAbandoned) {
        // In-flight query still owns the wire; releasing would hand a
        // protocol-desynced connection to the next probe.
        connection?.destroy();
      } else {
        connection?.release();
      }
    } catch {
      /* ignore */
    }
  }
}

function coerceNumeric(raw: unknown, rowCount: number, colCount: number): MyQueryResult | MyQueryFailure {
  if (raw === null || raw === undefined) return { ok: false, reason: "db_null_value" };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, reason: "db_non_numeric", detail: "non-finite" };
    return { ok: true, value: raw, row_count: rowCount, column_count: colCount };
  }
  if (typeof raw === "boolean") {
    return { ok: true, value: raw ? 1 : 0, row_count: rowCount, column_count: colCount };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: false, reason: "db_non_numeric", detail: "empty string" };
    const n = Number(trimmed);
    if (Number.isFinite(n)) return { ok: true, value: n, row_count: rowCount, column_count: colCount };
    return { ok: false, reason: "db_non_numeric", detail: `string "${trimmed.slice(0, 32)}"` };
  }
  if (typeof raw === "bigint") {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return { ok: true, value: n, row_count: rowCount, column_count: colCount };
    return { ok: false, reason: "db_non_numeric", detail: "bigint exceeds JS-safe range" };
  }
  // mysql2 returns DECIMAL/NUMERIC as a string by default; the path
  // above handles that. Buffer (e.g. BLOB) and Date should not appear
  // in a numeric probe — surface as non_numeric so the operator
  // catches the configuration mistake.
  return { ok: false, reason: "db_non_numeric", detail: typeof raw };
}

function classifyMyError(err: unknown): MyQueryFailure {
  const e = err as { code?: string; errno?: number; message?: string; sqlState?: string };
  const code = e?.code ?? "";
  // MAX_EXECUTION_TIME firing surfaces as ER_QUERY_TIMEOUT.
  if (code === "ER_QUERY_TIMEOUT" || code === "ER_QUERY_INTERRUPTED" || code === "PROTOCOL_SEQUENCE_TIMEOUT") {
    return { ok: false, reason: "db_timeout" };
  }
  if (code === "ER_ACCESS_DENIED_ERROR" || code === "ER_DBACCESS_DENIED_ERROR") {
    return { ok: false, reason: "db_auth_failed" };
  }
  if (code === "ER_TABLEACCESS_DENIED_ERROR" || code === "ER_COLUMNACCESS_DENIED_ERROR" || code === "ER_SPECIFIC_ACCESS_DENIED_ERROR") {
    return { ok: false, reason: "db_access_denied" };
  }
  if (code === "ER_PARSE_ERROR" || code === "ER_BAD_FIELD_ERROR" || code === "ER_NO_SUCH_TABLE") {
    return { ok: false, reason: "db_syntax_error" };
  }
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT" || code === "PROTOCOL_CONNECTION_LOST") {
    return { ok: false, reason: "db_connection_failed" };
  }
  return { ok: false, reason: "db_error" };
}

export function resetMyClientCacheForTests(): void {
  for (const p of cache.values()) {
    try {
      void p.end().catch(() => {
        /* ignore */
      });
    } catch {
      /* ignore */
    }
  }
  cache.clear();
}
