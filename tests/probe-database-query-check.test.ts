// query allowlist parser tests.
//
// The parser is belt-and-suspenders alongside the operator's read-
// only role. It should reject obviously-write queries without
// false-positive rejection of legitimate SELECTs that contain the
// word "update" inside a string literal or comment.

import { describe, expect, it } from "bun:test";
import { checkDatabaseQuery, checkSelectOnly } from "@observer/probe-config";

describe("checkSelectOnly — accepts", () => {
  it("a plain SELECT", () => {
    expect(checkSelectOnly("SELECT 1").ok).toBe(true);
  });
  it("a SELECT with whitespace and trailing semicolon", () => {
    expect(checkSelectOnly("  SELECT count(*) FROM users;  ").ok).toBe(true);
  });
  it("a lowercase select", () => {
    expect(checkSelectOnly("select extract(epoch from now())").ok).toBe(true);
  });
  it("a WITH ... SELECT CTE", () => {
    expect(
      checkSelectOnly(
        "WITH recent AS (SELECT id FROM orders WHERE created_at > now() - interval '1 hour') SELECT count(*) FROM recent",
      ).ok,
    ).toBe(true);
  });
  it("a SELECT with a literal containing 'update'", () => {
    expect(checkSelectOnly("SELECT 1 WHERE 'do not update' = 'do not update'").ok).toBe(true);
  });
  it("a SELECT with a -- line comment", () => {
    expect(checkSelectOnly("-- comment\nSELECT 1").ok).toBe(true);
  });
  it("a SELECT preceded by a /* block comment */", () => {
    expect(checkSelectOnly("/* probe note */ SELECT 1").ok).toBe(true);
  });
  it("a SELECT with embedded INSERT inside a string literal", () => {
    // INSERT inside a string is fine; it's not parsed as a statement.
    expect(checkSelectOnly("SELECT 'INSERT INTO logs' AS msg").ok).toBe(true);
  });

  it("a SELECT with a Postgres-style doubled-quote escape", () => {
    // 'don''t' is a single SQL-standard string literal containing
    // an apostrophe. The parser must not interpret the second quote
    // as closing the string.
    expect(checkSelectOnly("SELECT 'don''t' AS msg").ok).toBe(true);
  });

  it("a SELECT with a doubled identifier-quote inside a double-quoted name", () => {
    expect(checkSelectOnly('SELECT "weird""col" FROM t').ok).toBe(true);
  });

  it("a SELECT with a MySQL-style backslash-quote escape", () => {
    expect(checkSelectOnly("SELECT 'don\\'t' AS msg", "mysql").ok).toBe(true);
    // Postgres reads \' as a backslash and a closing quote, so the same text
    // leaves an unterminated literal there.
    expect(checkSelectOnly("SELECT 'don\\'t' AS msg", "postgres").ok).toBe(false);
  });

  it("a SELECT whose literal contains a fake closing quote then ; DROP", () => {
    // After the doubled '' the string continues; the ; is INSIDE
    // the literal, not a statement break. Must accept.
    expect(checkSelectOnly("SELECT 'a''; SELECT 1; --'").ok).toBe(true);
  });
});

describe("checkSelectOnly — rejects", () => {
  it("an empty string", () => {
    const r = checkSelectOnly("");
    expect(r.ok).toBe(false);
  });
  it("whitespace only", () => {
    expect(checkSelectOnly("    \n\n  ").ok).toBe(false);
  });
  it("a comment-only query", () => {
    expect(checkSelectOnly("-- nothing here").ok).toBe(false);
  });
  it("an UPDATE", () => {
    const r = checkSelectOnly("UPDATE users SET banned = true");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/UPDATE/);
  });
  it("an INSERT", () => {
    expect(checkSelectOnly("INSERT INTO users (id) VALUES (1)").ok).toBe(false);
  });
  it("a DELETE", () => {
    expect(checkSelectOnly("DELETE FROM users").ok).toBe(false);
  });
  it("a TRUNCATE", () => {
    expect(checkSelectOnly("TRUNCATE TABLE users").ok).toBe(false);
  });
  it("a DROP", () => {
    expect(checkSelectOnly("DROP TABLE users").ok).toBe(false);
  });
  it("a GRANT", () => {
    expect(checkSelectOnly("GRANT ALL ON users TO bad").ok).toBe(false);
  });
  it("a COPY", () => {
    expect(checkSelectOnly("COPY users TO '/tmp/out.csv'").ok).toBe(false);
  });
  it("a CALL", () => {
    expect(checkSelectOnly("CALL my_proc()").ok).toBe(false);
  });
  it("a SET statement", () => {
    expect(checkSelectOnly("SET search_path = public").ok).toBe(false);
  });
  it("a BEGIN/COMMIT transaction block", () => {
    expect(checkSelectOnly("BEGIN; SELECT 1; COMMIT;").ok).toBe(false);
  });
  it("a multi-statement body", () => {
    const r = checkSelectOnly("SELECT 1; DROP TABLE users");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/multi-statement/);
  });
  it("a WITH that wraps a write (DELETE-returning)", () => {
    const r = checkSelectOnly(
      "WITH deleted AS (DELETE FROM users RETURNING id) SELECT count(*) FROM deleted",
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/write/i);
  });
  it("a WITH that wraps an UPDATE returning", () => {
    expect(
      checkSelectOnly(
        "WITH u AS (UPDATE users SET name='x' RETURNING id) SELECT count(*) FROM u",
      ).ok,
    ).toBe(false);
  });
  it("EXEC", () => {
    expect(checkSelectOnly("EXEC sp_helpdb").ok).toBe(false);
  });
  it("non-string input", () => {
    expect(checkSelectOnly(undefined as unknown as string).ok).toBe(false);
  });
});

describe("checkSelectOnly — audit bypasses (2026-11)", () => {
  const rejected = [
    ['quoted function name', `SELECT "nextval"('s')`],
    ["MySQL executable comment hiding INTO OUTFILE", "SELECT 1 /*! INTO OUTFILE '/tmp/x' */"],
    ["MySQL -- without space (not a comment there)", "SELECT 1 --1 INTO OUTFILE '/tmp/x'"],
    ["advisory lock", "SELECT pg_advisory_lock(1)"],
    ["large object create", "SELECT lo_create(0)"],
    ["reload conf", "SELECT pg_reload_conf()"],
    ["MySQL GET_LOCK", "SELECT GET_LOCK('x', 10)"],
    ["MySQL LOAD_FILE", "SELECT LOAD_FILE('/etc/passwd')"],
  ] as const;
  for (const [label, q] of rejected) {
    it(`rejects ${label}`, () => {
      expect(checkSelectOnly(q).ok).toBe(false);
    });
  }

  const accepted = [
    ["a -- comment with a space", "SELECT count(*) FROM jobs -- pending rows into dashboard\n"],
    ["a quoted column", `SELECT "count" FROM stats`],
    ["a -- inside a string literal", "SELECT '--x' AS s"],
  ] as const;
  for (const [label, q] of accepted) {
    it(`still accepts ${label}`, () => {
      expect(checkSelectOnly(q).ok).toBe(true);
    });
  }
});

// Each engine's own quoting (audit 2026-11-10): text one engine reads as a
// literal must not hide live SQL from the check for the other.
describe("checkDatabaseQuery — engine-aware quoting", () => {
  const refused: Array<["postgres" | "mysql", string]> = [
    ["postgres", "SELECT 'a\\', nextval('s'), '\\'"],
    ["postgres", "SELECT 'x\\' , pg_terminate_backend(pid), '\\' FROM pg_stat_activity"],
    ["postgres", "SELECT 'a\\'; DELETE FROM t; SELECT '\\'"],
    ["postgres", "SELECT $$'$$, set_config('x','y',false), $$'$$"],
    ["postgres", "SELECT $$'$$ INTO newt FROM t WHERE $$'$$ = ''"],
    ["postgres", 'SELECT "nextval"(\'s\')'],
    ["postgres", "SELECT pg_notify('c','x')"],
    ["postgres", "SELECT * FROM t FOR UPDATE"],
    ["postgres", "WITH x AS (DELETE FROM t RETURNING 1) SELECT count(*) FROM x"],
    ["postgres", "SELECT 1 /* a /* b */ c"],
    ["mysql", "SELECT `a'b`, GET_LOCK('x',10), `c'd`"],
    ["mysql", "SELECT `a'b` FROM t INTO OUTFILE '/tmp/x' -- `'"],
    ["mysql", "SELECT 1 # '\n, GET_LOCK('x',1) -- '"],
    ["mysql", "SELECT /*! 1; DROP TABLE t */ 1"],
    ["mysql", "SELECT * FROM t LOCK IN SHARE MODE"],
  ];
  for (const [kind, q] of refused) {
    it(`refuses ${kind}: ${q}`, () => {
      expect(checkDatabaseQuery(kind, q).ok).toBe(false);
      expect(checkSelectOnly(q).ok).toBe(false);
    });
  }
  const accepted: Array<["postgres" | "mysql", string]> = [
    ["postgres", "SELECT E'a\\'b' AS x"],
    ["postgres", "SELECT $tag$a 'b' $tag$"],
    ["postgres", "SELECT a$b FROM t"],
    ["postgres", "SELECT 'a\\' AS backslash"],
    ["postgres", 'SELECT "Update" FROM t'],
    ["mysql", "SELECT `col` FROM t"],
    ["mysql", "SELECT 1 # trailing comment"],
  ];
  for (const [kind, q] of accepted) {
    it(`accepts ${kind}: ${q}`, () => {
      expect(checkDatabaseQuery(kind, q).ok).toBe(true);
    });
  }
});
