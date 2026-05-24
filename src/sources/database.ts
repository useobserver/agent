// SQL probe source.
//
// Pull-mode. Per cron tick, run a single SELECT statement against a
// customer database (postgres or mysql) and report the scalar.
//
// Safeguards (all enforced before the query leaves the agent):
//   1. The DSN comes from process.env via `connection_string_ref`.
//      Never persisted in source_config or returned in metadata.
//   2. The query passes the SELECT-only parser (`./database/_query-check`).
//      Multi-statement bodies, INSERT/UPDATE/DELETE/DDL all rejected.
//   3. Statement timeout enforced at the database connection
//      (postgres `statement_timeout`, mysql session
//      `MAX_EXECUTION_TIME`). Default 5s, max 30s.
//   4. Connection pool capped at 2 per (dsn, timeout) tuple — cannot
//      exhaust the upstream database's connection limit.
//   5. Result must be exactly one row × one column. Multi-result
//      shapes surface a typed reason; the metric def is broken,
//      not the database.
//
// Read-only-role provisioning is the operator's responsibility. The
// docs walk through it; we don't enforce it inside the agent because
// the agent has no way to inspect upstream role grants reliably.

import type { ProbeResult, ProbeSource } from "../types.ts";
import { DatabaseConfigSchema, type DatabaseConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";
import { checkSelectOnly } from "./database/_query-check.ts";
import { checkRedisCommand } from "./database/_redis-check.ts";
import { checkMongoQuery } from "./database/_mongo-check.ts";
import {
  runQuery as runPgQuery,
  resetPgClientCacheForTests,
} from "./database/postgres.ts";
import {
  runQuery as runMyQuery,
  resetMyClientCacheForTests,
} from "./database/mysql.ts";
import {
  runQuery as runRedisQuery,
  resetRedisClientCacheForTests,
} from "./database/redis.ts";
import {
  runQuery as runMongoQuery,
  resetMongoClientCacheForTests,
} from "./database/mongo.ts";

export function validateConfig(config: unknown): null | string {
  const baseError = validateWithSchema(DatabaseConfigSchema, config);
  if (baseError) return baseError;
  const c = config as DatabaseConfig;
  if (c.kind === "postgres" || c.kind === "mysql") {
    const check = checkSelectOnly(c.query);
    if (!check.ok) return `query: ${check.reason}`;
    return null;
  }
  if (c.kind === "redis") {
    const check = checkRedisCommand(c.query);
    if (!check.ok) return `query: ${check.reason}`;
    return null;
  }
  if (c.kind === "mongodb") {
    const check = checkMongoQuery(c.query);
    if (!check.ok) return `query: ${check.reason}`;
    return null;
  }
  return `kind "${(c as { kind?: string }).kind}" runtime not implemented`;
}

function curatedMetadata(config: DatabaseConfig): Record<string, unknown> {
  return {
    kind: config.kind,
    connection_string_ref: config.connection_string_ref,
    statement_timeout_ms: config.statement_timeout_ms,
  };
}

type Runner = (dsn: string, query: string, timeoutMs: number) => Promise<
  { ok: true; value: number; row_count: number; column_count: number } | { ok: false; reason: string; detail?: string }
>;

const RUNNERS: Record<string, Runner> = {
  postgres: runPgQuery,
  mysql: runMyQuery,
  redis: runRedisQuery,
  mongodb: runMongoQuery,
};

const KIND_CHECKERS: Record<string, (query: string) => { ok: boolean; reason?: string }> = {
  postgres: checkSelectOnly,
  mysql: checkSelectOnly,
  redis: checkRedisCommand,
  mongodb: checkMongoQuery,
};

export async function execute(config: DatabaseConfig): Promise<ProbeResult> {
  const ts = (): string => new Date().toISOString();

  const runner = RUNNERS[config.kind];
  const checker = KIND_CHECKERS[config.kind];
  if (!runner || !checker) {
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: "not_implemented",
      metadata: curatedMetadata(config),
    };
  }

  const dsn = process.env[config.connection_string_ref];
  if (!dsn) {
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: "db_dsn_missing",
      metadata: curatedMetadata(config),
    };
  }

  // Defensive second-check at execute time. If a malformed query
  // slipped through (e.g. config edited out-of-band), reject before
  // the query reaches the database / cache.
  const check = checker(config.query);
  if (!check.ok) {
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: "db_query_not_allowed",
      metadata: { ...curatedMetadata(config), detail: check.reason },
    };
  }

  const result = await runner(dsn, config.query, config.statement_timeout_ms);

  if (!result.ok) {
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: result.reason,
      metadata: {
        ...curatedMetadata(config),
        ...(result.detail ? { detail: result.detail } : {}),
      },
    };
  }

  return {
    value: result.value,
    timestamp: ts(),
    metadata: {
      ...curatedMetadata(config),
      row_count: result.row_count,
      column_count: result.column_count,
    },
  };
}

export function resetDatabaseClientCachesForTests(): void {
  resetPgClientCacheForTests();
  resetMyClientCacheForTests();
  resetRedisClientCacheForTests();
  resetMongoClientCacheForTests();
}

const source: ProbeSource<DatabaseConfig> = { execute, validateConfig };
export default source;
