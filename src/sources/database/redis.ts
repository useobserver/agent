// Redis backend for the database probe.
//
// One client per (DSN, statement_timeout_ms) cached SHA-256-keyed and
// LRU-bounded at 32 entries (matching the postgres / mysql cache
// dimensions). Per-call timeout enforced via Promise.race against a
// setTimeout — ioredis doesn't expose a per-command timeout knob.
//
// Connection strings (redis:// / rediss://) never persist in
// source_config, log, or surface in ProbeResult metadata.

import crypto from "node:crypto";
import { Redis } from "ioredis";
import { checkRedisCommand } from "./_redis-check.ts";

export interface RedisQueryResult {
  ok: true;
  value: number;
  row_count: number;
  column_count: number;
}
export interface RedisQueryFailure {
  ok: false;
  reason: string;
  detail?: string;
}

const MAX_CACHE_ENTRIES = 32;
const cache = new Map<string, Redis>();

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
      void ev?.quit().catch(() => {
        /* fire-and-forget close; a late rejection must not surface */
      });
    } catch {
      /* best-effort */
    }
  }
}

function getClient(dsn: string, statementTimeoutMs: number): Redis {
  const key = cacheKey(dsn, statementTimeoutMs);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  evictOldestIfFull();
  const client = new Redis(dsn, {
    // ioredis manages its own connection lifecycle; cap retries so
    // a stuck endpoint doesn't queue commands forever.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
    connectTimeout: Math.min(statementTimeoutMs, 5_000),
    commandTimeout: statementTimeoutMs,
  });
  // Swallow connection errors so unexpected disconnects don't bring
  // down the agent. Errors surface via runQuery's catch.
  client.on("error", () => {
    /* drained; classifyRedisError handles per-call failures */
  });
  cache.set(key, client);
  return client;
}

function coerceNumeric(raw: unknown): RedisQueryResult | RedisQueryFailure {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "db_null_value" };
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, reason: "db_non_numeric", detail: "non-finite" };
    return { ok: true, value: raw, row_count: 1, column_count: 1 };
  }
  if (typeof raw === "boolean") {
    return { ok: true, value: raw ? 1 : 0, row_count: 1, column_count: 1 };
  }
  if (typeof raw === "bigint") {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return { ok: true, value: n, row_count: 1, column_count: 1 };
    return { ok: false, reason: "db_non_numeric", detail: "bigint exceeds JS-safe range" };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: false, reason: "db_non_numeric", detail: "empty string" };
    const n = Number(trimmed);
    if (Number.isFinite(n)) return { ok: true, value: n, row_count: 1, column_count: 1 };
    return { ok: false, reason: "db_non_numeric", detail: `string "${trimmed.slice(0, 32)}"` };
  }
  return { ok: false, reason: "db_non_numeric", detail: typeof raw };
}

function classifyRedisError(err: unknown): RedisQueryFailure {
  const e = err as { name?: string; code?: string; message?: string };
  const code = e?.code ?? "";
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
    return { ok: false, reason: "db_connection_failed" };
  }
  const msg = e?.message ?? "";
  if (/NOAUTH|WRONGPASS|invalid password/i.test(msg)) return { ok: false, reason: "db_auth_failed" };
  if (/NOPERM|denied/i.test(msg)) return { ok: false, reason: "db_access_denied" };
  if (/Command timed out/i.test(msg) || code === "ETIMEDOUT") return { ok: false, reason: "db_timeout" };
  if (/unknown command|wrong number/i.test(msg)) return { ok: false, reason: "db_syntax_error" };
  return { ok: false, reason: "db_error" };
}

export async function runQuery(
  dsn: string,
  command: string,
  statementTimeoutMs: number,
): Promise<RedisQueryResult | RedisQueryFailure> {
  if (!Number.isFinite(statementTimeoutMs) || statementTimeoutMs <= 0) {
    return { ok: false, reason: "db_invalid_timeout", detail: String(statementTimeoutMs) };
  }
  const check = checkRedisCommand(command);
  if (!check.ok || !check.command) {
    return { ok: false, reason: "db_query_not_allowed", detail: check.reason };
  }
  try {
    // Client acquisition stays INSIDE the try: a malformed DSN makes
    // ioredis throw synchronously, and that error message can embed the
    // full connection string (password included). classifyRedisError
    // maps it to a typed reason and never echoes the driver message.
    const client = getClient(dsn, statementTimeoutMs);
    // Use ioredis's generic `call` so the command argument list is
    // passed through verbatim. `client.call` accepts the command as
    // the first arg and the remaining args as the command's args.
    const raw = await client.call(check.command, ...(check.args ?? []));
    return coerceNumeric(raw);
  } catch (err) {
    return classifyRedisError(err);
  }
}

export function resetRedisClientCacheForTests(): void {
  for (const c of cache.values()) {
    try {
      void c.quit().catch(() => {
        /* ignore */
      });
    } catch {
      /* ignore */
    }
  }
  cache.clear();
}
