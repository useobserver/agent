// MongoDB read-only query validator.
//
// Mongo has no SQL surface; the probe's `query` field is a JSON-
// encoded specification that names the database, collection, and
// read operation. We restrict v1 to the two count-shaped ops that
// always return a scalar without bucket geometry:
//
//   { "db": "mydb", "collection": "orders", "op": "countDocuments", "filter": {"status": "pending"} }
//   { "db": "mydb", "collection": "orders", "op": "estimatedDocumentCount" }
//
// `filter` may be any BSON-serialisable JSON value (passed verbatim
// to driver.collection.countDocuments). The driver enforces the
// read role at the connection level; the schema enforces no
// $where / $function shapes that could trigger server-side JS.

export interface MongoCheckResult {
  ok: boolean;
  spec?: MongoSpec;
  reason?: string;
}

export type MongoOp = "countDocuments" | "estimatedDocumentCount";

export interface MongoSpec {
  db: string;
  collection: string;
  op: MongoOp;
  filter?: Record<string, unknown>;
}

// Recursively reject filter operators that allow server-side
// code execution. The Mongo server still enforces the user's role
// (which should not grant $where / $function privilege), but reject
// loudly so a misconfigured environment doesn't silently send a
// $function-bearing filter.
const FORBIDDEN_OPERATORS = new Set(["$where", "$function", "$accumulator", "$expr"]);

function scanForForbidden(value: unknown, path: string): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const r = scanForForbidden(value[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_OPERATORS.has(k)) {
        return `forbidden filter operator ${k} at ${path}`;
      }
      const r = scanForForbidden(v, path === "" ? k : `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export function checkMongoQuery(raw: string): MongoCheckResult {
  if (typeof raw !== "string") {
    return { ok: false, reason: "query is not a string" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "query is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "query must be a JSON object" };
  }
  const p = parsed as Partial<MongoSpec> & Record<string, unknown>;
  if (typeof p.db !== "string" || !NAME_PATTERN.test(p.db)) {
    return { ok: false, reason: "db must be a valid identifier" };
  }
  if (typeof p.collection !== "string" || !NAME_PATTERN.test(p.collection)) {
    return { ok: false, reason: "collection must be a valid identifier" };
  }
  if (p.op !== "countDocuments" && p.op !== "estimatedDocumentCount") {
    return { ok: false, reason: "op must be countDocuments or estimatedDocumentCount" };
  }
  if (p.op === "estimatedDocumentCount" && p.filter !== undefined) {
    return { ok: false, reason: "estimatedDocumentCount does not accept a filter" };
  }
  if (p.filter !== undefined) {
    if (typeof p.filter !== "object" || Array.isArray(p.filter) || p.filter === null) {
      return { ok: false, reason: "filter must be an object" };
    }
    const bad = scanForForbidden(p.filter, "filter");
    if (bad) return { ok: false, reason: bad };
  }
  return {
    ok: true,
    spec: {
      db: p.db,
      collection: p.collection,
      op: p.op,
      filter: (p.filter as Record<string, unknown> | undefined) ?? undefined,
    },
  };
}
