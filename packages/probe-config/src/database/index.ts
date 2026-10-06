// Database probe query-safety checks. One implementation shared by the cloud
// (DatabaseConfigSchema refines on it, so an unsafe query is rejected at save
// time with a clear message) and the agent (apps/agent/src/sources/database.ts
// re-checks before the query reaches the database).

import { checkSelectOnly } from "./query-check";
import { checkRedisCommand } from "./redis-check";
import { checkMongoQuery } from "./mongo-check";

export { checkSelectOnly, type QueryCheckResult } from "./query-check";
export { checkRedisCommand, REDIS_ALLOWED_COMMANDS, type RedisCheckResult } from "./redis-check";
export { checkMongoQuery, type MongoCheckResult, type MongoOp, type MongoSpec } from "./mongo-check";

export type DatabaseKind = "postgres" | "mysql" | "redis" | "mongodb";

/**
 * Run the kind's read-only check on a probe query. postgres / mysql: single
 * SELECT / WITH statement; redis: read-only command allowlist; mongodb:
 * countDocuments / estimatedDocumentCount spec only.
 */
export function checkDatabaseQuery(kind: string, query: string): { ok: boolean; reason?: string } {
  switch (kind) {
    case "postgres":
    case "mysql":
      return checkSelectOnly(query);
    case "redis":
      return checkRedisCommand(query);
    case "mongodb":
      return checkMongoQuery(query);
    default:
      return { ok: false, reason: `kind "${kind}" has no query check` };
  }
}
