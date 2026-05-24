// query allowlist parser tests.
//
// The parser is belt-and-suspenders alongside the operator's read-
// only role. It should reject obviously-write queries without
// false-positive rejection of legitimate SELECTs that contain the
// word "update" inside a string literal or comment.

import { describe, expect, it } from "bun:test";
import { checkSelectOnly } from "../src/sources/database/_query-check.ts";

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
    expect(checkSelectOnly("SELECT 'don\\'t' AS msg").ok).toBe(true);
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
