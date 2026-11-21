// Live check of the postgres source against a real server, so a driver
// upgrade cannot quietly weaken the read-only guard (postgres.js 4 rewrote
// the protocol layer). Runs only when AGENT_TEST_PG_URL names a database
// ending in _test, e.g.
//   AGENT_TEST_PG_URL=postgres://observer_app:observer@127.0.0.1:5433/observer_test bun test tests/database-postgres-live.test.ts
import { afterAll, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { runQuery } from "../src/sources/database/postgres.ts";

const url = process.env.AGENT_TEST_PG_URL ?? "";
const usable = (() => {
  try {
    return new URL(url).pathname.replace(/^\//, "").endsWith("_test");
  } catch {
    return false;
  }
})();

describe.skipIf(!usable)("postgres source (live)", () => {
  const table = `agent_live_guard_${process.pid}`;
  afterAll(async () => {
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
    await sql.end();
  });

  it("reads one numeric value", async () => {
    expect(await runQuery(url, "SELECT 42", 5000)).toMatchObject({ ok: true, value: 42 });
    expect(await runQuery(url, "SELECT 3.5::numeric", 5000)).toMatchObject({ ok: true, value: 3.5 });
    expect(await runQuery(url, "SELECT true", 5000)).toMatchObject({ ok: true, value: 1 });
  });

  it("runs exactly one statement, so COMMIT cannot end the read-only transaction", async () => {
    expect(await runQuery(url, "SELECT 1; SELECT 2", 5000)).toMatchObject({ ok: false });
    expect(await runQuery(url, `SELECT 1; COMMIT; CREATE TABLE ${table} (x int)`, 5000)).toMatchObject({ ok: false });
    expect(await runQuery(url, `CREATE TABLE ${table} (x int)`, 5000)).toMatchObject({ ok: false });
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    const [row] = await sql`SELECT to_regclass(${table}) AS t`;
    await sql.end();
    expect(row.t).toBeNull();
  });

  it("times out on the client side and classifies connection errors", async () => {
    expect(await runQuery(url, "SELECT pg_sleep(3)", 500)).toEqual({ ok: false, reason: "db_timeout" });
    expect(await runQuery("postgres://u:pw@127.0.0.1:1/db_test", "SELECT 1", 2000)).toEqual({
      ok: false,
      reason: "db_connection_failed",
    });
  });
});
