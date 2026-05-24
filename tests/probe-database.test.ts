// SQL source dispatcher tests.
//
// Mocks both `postgres` and `mysql2/promise` so we cover the
// dispatch + result-shape + error-classification paths without
// needing a real database. Real-database integration testing is
// out of scope for unit tests.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// ---- postgres mock ---------------------------------------------------

let pgQueryImpl: (sql: string) => Promise<unknown> = async () => [];
const pgEnds: number[] = [];

function makeFakePostgres() {
  return function postgresFactory(_dsn: string, _opts?: unknown) {
    const sql = (..._args: unknown[]) => {
      throw new Error("tagged-template path not used in tests");
    };
    (sql as unknown as { unsafe: (q: string) => Promise<unknown> }).unsafe = async (q: string) => {
      return pgQueryImpl(q);
    };
    (sql as unknown as { end: (opts?: unknown) => Promise<void> }).end = async () => {
      pgEnds.push(Date.now());
    };
    return sql;
  };
}

mock.module("postgres", () => ({
  default: makeFakePostgres(),
}));

// ---- mysql2/promise mock --------------------------------------------

let myQueryImpl: (sql: string) => Promise<[unknown[], unknown]> = async () => [[], []];
const myEnds: number[] = [];
const mySessionStmts: string[] = [];

function makeFakeMysql() {
  return {
    createPool() {
      return {
        async getConnection() {
          return {
            async query(sqlStmt: string) {
              if (/^SET SESSION/i.test(sqlStmt)) {
                mySessionStmts.push(sqlStmt);
                return [[], []];
              }
              return await myQueryImpl(sqlStmt);
            },
            release() {},
          };
        },
        async end() {
          myEnds.push(Date.now());
        },
      };
    },
  };
}

mock.module("mysql2/promise", () => ({
  default: makeFakeMysql(),
}));

// Import after mocks so the module picks them up.
const { default: dbSource, resetDatabaseClientCachesForTests } = await import(
  "../src/sources/database.ts"
);

beforeEach(() => {
  resetDatabaseClientCachesForTests();
  pgQueryImpl = async () => [];
  myQueryImpl = async () => [[], []];
  pgEnds.length = 0;
  myEnds.length = 0;
  mySessionStmts.length = 0;
  process.env.OBS_TEST_DSN = "postgres://obs:pw@localhost:5432/db";
  process.env.OBS_TEST_MYSQL_DSN = "mysql://obs:pw@localhost:3306/db";
});

afterEach(() => {
  resetDatabaseClientCachesForTests();
  delete process.env.OBS_TEST_DSN;
  delete process.env.OBS_TEST_MYSQL_DSN;
});

const baseConfig = {
  kind: "postgres" as const,
  connection_string_ref: "OBS_TEST_DSN",
  query: "SELECT 1",
  statement_timeout_ms: 5000,
};

describe("validateConfig", () => {
  it("accepts a minimum-shape postgres config", () => {
    expect(dbSource.validateConfig(baseConfig)).toBeNull();
  });

  it("rejects an UPDATE query at validate time", () => {
    const err = dbSource.validateConfig({ ...baseConfig, query: "UPDATE x SET y = 1" });
    expect(err).not.toBeNull();
    expect(err).toMatch(/UPDATE/);
  });

  it("rejects a multi-statement body", () => {
    expect(
      dbSource.validateConfig({ ...baseConfig, query: "SELECT 1; DROP TABLE x" }),
    ).not.toBeNull();
  });

  it("rejects a non-uppercase connection_string_ref", () => {
    expect(
      dbSource.validateConfig({ ...baseConfig, connection_string_ref: "obs_test_dsn" }),
    ).not.toBeNull();
  });

  it("rejects statement_timeout_ms > 30000", () => {
    expect(
      dbSource.validateConfig({ ...baseConfig, statement_timeout_ms: 60_000 }),
    ).not.toBeNull();
  });

  it("rejects unknown keys (strict)", () => {
    expect(dbSource.validateConfig({ ...baseConfig, extra: "x" })).not.toBeNull();
  });

  it("accepts WITH ... SELECT", () => {
    expect(
      dbSource.validateConfig({
        ...baseConfig,
        query: "WITH r AS (SELECT id FROM orders) SELECT count(*) FROM r",
      }),
    ).toBeNull();
  });

  it("accepts kind=redis with a valid command", () => {
    expect(
      dbSource.validateConfig({ ...baseConfig, kind: "redis", query: "DBSIZE" }),
    ).toBeNull();
  });

  it("rejects kind=redis with a mutating command", () => {
    const err = dbSource.validateConfig({ ...baseConfig, kind: "redis", query: "FLUSHALL" });
    expect(err).not.toBeNull();
    expect(err).toMatch(/FLUSHALL/);
  });

  it("accepts kind=mongodb with a JSON countDocuments spec", () => {
    expect(
      dbSource.validateConfig({
        ...baseConfig,
        kind: "mongodb",
        query: JSON.stringify({ db: "x", collection: "y", op: "countDocuments" }),
      }),
    ).toBeNull();
  });

  it("rejects kind=mongodb when the query isn't JSON", () => {
    expect(
      dbSource.validateConfig({ ...baseConfig, kind: "mongodb", query: "SELECT 1" }),
    ).not.toBeNull();
  });
});

describe("execute — postgres", () => {
  it("returns the scalar from a 1-row 1-col result", async () => {
    pgQueryImpl = async () => [{ count: 42 }];
    const r = await dbSource.execute(baseConfig);
    expect(r.value).toBe(42);
    expect(r.status_hint).toBeUndefined();
  });

  it("coerces a numeric string to number", async () => {
    pgQueryImpl = async () => [{ result: "97" }];
    const r = await dbSource.execute(baseConfig);
    expect(r.value).toBe(97);
  });

  it("coerces a bigint to number when safe", async () => {
    pgQueryImpl = async () => [{ n: 7n }];
    const r = await dbSource.execute(baseConfig);
    expect(r.value).toBe(7);
  });

  it("rejects a non-numeric string", async () => {
    pgQueryImpl = async () => [{ s: "healthy" }];
    const r = await dbSource.execute(baseConfig);
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("db_non_numeric");
  });

  it("rejects NULL", async () => {
    pgQueryImpl = async () => [{ x: null }];
    const r = await dbSource.execute(baseConfig);
    expect(r.reason).toBe("db_null_value");
  });

  it("rejects multi-row results", async () => {
    pgQueryImpl = async () => [{ x: 1 }, { x: 2 }];
    const r = await dbSource.execute(baseConfig);
    expect(r.reason).toBe("db_multi_row");
  });

  it("rejects multi-column results", async () => {
    pgQueryImpl = async () => [{ a: 1, b: 2 }];
    const r = await dbSource.execute(baseConfig);
    expect(r.reason).toBe("db_multi_column");
  });

  it("rejects empty result sets", async () => {
    pgQueryImpl = async () => [];
    const r = await dbSource.execute(baseConfig);
    expect(r.reason).toBe("db_empty_result");
  });

  it("returns db_dsn_missing when env var is not set", async () => {
    delete process.env.OBS_TEST_DSN;
    const r = await dbSource.execute(baseConfig);
    expect(r.reason).toBe("db_dsn_missing");
  });

  it("maps statement_timeout cancellation (SQLSTATE 57014) to db_timeout", async () => {
    pgQueryImpl = async () => {
      const e = new Error("canceling statement due to statement timeout") as Error & { code: string };
      e.code = "57014";
      throw e;
    };
    const r = await dbSource.execute(baseConfig);
    expect(r.reason).toBe("db_timeout");
  });

  it("maps SQLSTATE 42501 to db_access_denied", async () => {
    pgQueryImpl = async () => {
      const e = new Error("permission denied for table users") as Error & { code: string };
      e.code = "42501";
      throw e;
    };
    const r = await dbSource.execute(baseConfig);
    expect(r.reason).toBe("db_access_denied");
  });

  it("maps SQLSTATE 28xxx to db_auth_failed", async () => {
    pgQueryImpl = async () => {
      const e = new Error("auth failed") as Error & { code: string };
      e.code = "28P01";
      throw e;
    };
    const r = await dbSource.execute(baseConfig);
    expect(r.reason).toBe("db_auth_failed");
  });

  it("maps ECONNREFUSED to db_connection_failed", async () => {
    pgQueryImpl = async () => {
      const e = new Error("ECONNREFUSED") as Error & { code: string };
      e.code = "ECONNREFUSED";
      throw e;
    };
    const r = await dbSource.execute(baseConfig);
    expect(r.reason).toBe("db_connection_failed");
  });

  it("returns metadata that never contains the DSN", async () => {
    pgQueryImpl = async () => [{ x: 1 }];
    const r = await dbSource.execute(baseConfig);
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("obs:pw");
    expect(serialized).not.toContain("postgres://");
  });
});

describe("execute — mysql", () => {
  const myConfig = {
    kind: "mysql" as const,
    connection_string_ref: "OBS_TEST_MYSQL_DSN",
    query: "SELECT 1",
    statement_timeout_ms: 5000,
  };

  it("returns the scalar from a 1-row 1-col result", async () => {
    myQueryImpl = async () => [[{ result: 42 }], []];
    const r = await dbSource.execute(myConfig);
    expect(r.value).toBe(42);
  });

  it("issues SET SESSION MAX_EXECUTION_TIME before the query", async () => {
    myQueryImpl = async () => [[{ result: 1 }], []];
    await dbSource.execute(myConfig);
    expect(mySessionStmts.length).toBeGreaterThanOrEqual(1);
    expect(mySessionStmts[0]).toMatch(/SET SESSION MAX_EXECUTION_TIME = 5000/);
  });

  it("maps ER_QUERY_TIMEOUT to db_timeout", async () => {
    myQueryImpl = async () => {
      const e = new Error("timeout") as Error & { code: string };
      e.code = "ER_QUERY_TIMEOUT";
      throw e;
    };
    const r = await dbSource.execute(myConfig);
    expect(r.reason).toBe("db_timeout");
  });

  it("maps ER_ACCESS_DENIED_ERROR to db_auth_failed", async () => {
    myQueryImpl = async () => {
      const e = new Error("denied") as Error & { code: string };
      e.code = "ER_ACCESS_DENIED_ERROR";
      throw e;
    };
    const r = await dbSource.execute(myConfig);
    expect(r.reason).toBe("db_auth_failed");
  });

  it("refuses non-finite statement_timeout_ms (defends MAX_EXECUTION_TIME=0)", async () => {
    // Bypass the Zod schema by casting; verifies the runtime
    // hard-fails on a NaN that would otherwise coerce to 0 and
    // disable the MySQL timeout.
    const r = await dbSource.execute({
      ...myConfig,
      statement_timeout_ms: NaN as unknown as number,
    });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("db_invalid_timeout");
  });

  it("returns metadata that never contains the DSN", async () => {
    myQueryImpl = async () => [[{ x: 1 }], []];
    const r = await dbSource.execute(myConfig);
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("obs:pw");
    expect(serialized).not.toContain("mysql://");
  });
});
