// MongoDB backend for the database probe.
//
// One MongoClient per (DSN, statement_timeout_ms) tuple, SHA-256-keyed
// and LRU-bounded at 32 entries. v1 supports `countDocuments` and
// `estimatedDocumentCount` only — both return integers. Aggregation
// pipelines and find queries are deferred until customer demand
// surfaces.
//
// Connection strings (mongodb:// / mongodb+srv://) never persist in
// source_config, log, or surface in ProbeResult metadata.

import crypto from "node:crypto";
import { MongoClient, type MongoClientOptions } from "mongodb";
import { checkMongoQuery } from "./_mongo-check.ts";

export interface MongoQueryResult {
  ok: true;
  value: number;
  row_count: number;
  column_count: number;
}
export interface MongoQueryFailure {
  ok: false;
  reason: string;
  detail?: string;
}

const MAX_CACHE_ENTRIES = 32;
const MAX_POOL = 2;
const cache = new Map<string, MongoClient>();

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
      void ev?.close(true).catch(() => {
        /* fire-and-forget close; a late rejection must not surface */
      });
    } catch {
      /* best-effort */
    }
  }
}

function getClient(dsn: string, statementTimeoutMs: number): MongoClient {
  const key = cacheKey(dsn, statementTimeoutMs);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  evictOldestIfFull();
  const opts: MongoClientOptions = {
    maxPoolSize: MAX_POOL,
    minPoolSize: 0,
    // Per-operation deadline. The driver aborts the cursor /
    // command server-side when this elapses.
    serverSelectionTimeoutMS: Math.min(statementTimeoutMs, 5_000),
    connectTimeoutMS: Math.min(statementTimeoutMs, 5_000),
    socketTimeoutMS: statementTimeoutMs,
    waitQueueTimeoutMS: statementTimeoutMs,
    // Don't pollute the upstream MongoDB's logs with per-tick
    // sessions.
    appName: "observer-agent",
  };
  const client = new MongoClient(dsn, opts);
  cache.set(key, client);
  return client;
}

function classifyMongoError(err: unknown): MongoQueryFailure {
  const e = err as { name?: string; code?: number | string; codeName?: string; message?: string };
  const codeName = e?.codeName ?? "";
  const code = e?.code;
  if (codeName === "Unauthorized" || code === 13) return { ok: false, reason: "db_access_denied" };
  if (codeName === "AuthenticationFailed" || code === 18) return { ok: false, reason: "db_auth_failed" };
  if (codeName === "MaxTimeMSExpired" || code === 50) return { ok: false, reason: "db_timeout" };
  if (codeName === "NamespaceNotFound" || code === 26) return { ok: false, reason: "db_syntax_error" };
  if (e?.name === "MongoServerSelectionError" || e?.name === "MongoNetworkError") {
    return { ok: false, reason: "db_connection_failed" };
  }
  const msg = e?.message ?? "";
  if (/connect ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg)) {
    return { ok: false, reason: "db_connection_failed" };
  }
  return { ok: false, reason: "db_error" };
}

export async function runQuery(
  dsn: string,
  query: string,
  statementTimeoutMs: number,
): Promise<MongoQueryResult | MongoQueryFailure> {
  if (!Number.isFinite(statementTimeoutMs) || statementTimeoutMs <= 0) {
    return { ok: false, reason: "db_invalid_timeout", detail: String(statementTimeoutMs) };
  }
  const check = checkMongoQuery(query);
  if (!check.ok || !check.spec) {
    return { ok: false, reason: "db_query_not_allowed", detail: check.reason };
  }
  try {
    // Client acquisition stays INSIDE the try: a malformed DSN makes
    // the MongoClient constructor throw synchronously, and that error
    // message can embed the full connection string (password included).
    // classifyMongoError maps it to a typed reason and never echoes the
    // driver message.
    const client = getClient(dsn, statementTimeoutMs);
    await client.connect();
    const collection = client.db(check.spec.db).collection(check.spec.collection);
    // maxTimeMS makes the server abort the count when the deadline
    // hits, mirroring postgres `statement_timeout` semantics.
    const result: number =
      check.spec.op === "countDocuments"
        ? await collection.countDocuments(check.spec.filter ?? {}, { maxTimeMS: statementTimeoutMs })
        : await collection.estimatedDocumentCount({ maxTimeMS: statementTimeoutMs });
    if (!Number.isFinite(result)) {
      return { ok: false, reason: "db_non_numeric", detail: "non-finite count" };
    }
    return { ok: true, value: result, row_count: 1, column_count: 1 };
  } catch (err) {
    return classifyMongoError(err);
  }
}

export function resetMongoClientCacheForTests(): void {
  for (const c of cache.values()) {
    try {
      void c.close(true).catch(() => {
        /* ignore */
      });
    } catch {
      /* ignore */
    }
  }
  cache.clear();
}
