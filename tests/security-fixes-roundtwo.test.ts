// @ts-nocheck — tests for the round-2 security/correctness fixes.
import { describe, expect, it } from "bun:test";
import { evaluate } from "../src/evaluator.ts";
import { evaluateOperation, evaluateStatus } from "../src/status.ts";
import { checkSelectOnly } from "../src/sources/database/_query-check.ts";
import { checkMongoQuery } from "../src/sources/database/_mongo-check.ts";
import { attributesFingerprint } from "../src/sources/otlp/decode.ts";
import { resolveBufferCap } from "../src/buffer.ts";

// Item 8 — non-finite guards.
describe("non-finite value handling (item 8)", () => {
  const metric = {
    healthy_operation: "under",
    healthy_value: 100,
    unhealthy_operation: "over",
    unhealthy_value: 200,
  };
  it("evaluate() maps NaN value to no_data with non_finite_value reason", () => {
    const r = evaluate(metric, { value: NaN, timestamp: "t", status_hint: undefined });
    expect(r.status).toBe("no_data");
    expect(r.value).toBe(null);
    expect(r.reason).toBe("non_finite_value");
  });
  it("evaluate() maps Infinity to no_data", () => {
    expect(evaluate(metric, { value: Infinity, timestamp: "t" }).status).toBe("no_data");
  });
  it("evaluate() still classifies a finite value normally", () => {
    expect(evaluate(metric, { value: 50, timestamp: "t" }).status).toBe("healthy");
  });
  it("evaluateOperation returns false for non-finite value or threshold", () => {
    expect(evaluateOperation(NaN, "over", 1)).toBe(false);
    expect(evaluateOperation(5, "over", NaN)).toBe(false);
    expect(evaluateOperation(Infinity, "under", 10)).toBe(false);
  });
  it("evaluateStatus does not return healthy/unhealthy for NaN", () => {
    expect(evaluateStatus(NaN, "under", 100, "over", 200)).toBe("degraded");
  });
});

// Item 9 — SELECT-only parser rejects INTO + side-effecting functions.
describe("SELECT-only parser (item 9)", () => {
  it("rejects SELECT INTO", () => {
    expect(checkSelectOnly("SELECT * INTO newtbl FROM t").ok).toBe(false);
  });
  it("rejects INTO OUTFILE", () => {
    expect(checkSelectOnly("SELECT * FROM t INTO OUTFILE '/tmp/x'").ok).toBe(false);
  });
  it("rejects side-effecting functions", () => {
    expect(checkSelectOnly("SELECT setval('s', 1)").ok).toBe(false);
    expect(checkSelectOnly("SELECT nextval('s')").ok).toBe(false);
    expect(checkSelectOnly("SELECT pg_terminate_backend(123)").ok).toBe(false);
    expect(checkSelectOnly("SELECT lo_export(1, '/tmp/x')").ok).toBe(false);
  });
  it("still allows a plain SELECT and read-only pg_ functions", () => {
    expect(checkSelectOnly("SELECT count(*) FROM orders").ok).toBe(true);
    expect(checkSelectOnly("SELECT pg_database_size('mydb')").ok).toBe(true);
  });
  it("does not false-positive on INTO inside a string literal", () => {
    expect(checkSelectOnly("SELECT 'INSERT INTO logs' AS msg").ok).toBe(true);
  });
});

// Item 10 — mongo namespace denylist + recursion cap.
describe("mongo check (item 10)", () => {
  const spec = (o) => JSON.stringify(o);
  it("rejects reserved databases", () => {
    expect(checkMongoQuery(spec({ db: "admin", collection: "x", op: "countDocuments" })).ok).toBe(false);
    expect(checkMongoQuery(spec({ db: "config", collection: "x", op: "countDocuments" })).ok).toBe(false);
    expect(checkMongoQuery(spec({ db: "local", collection: "x", op: "countDocuments" })).ok).toBe(false);
  });
  it("rejects system.* collections", () => {
    expect(checkMongoQuery(spec({ db: "app", collection: "system.users", op: "countDocuments" })).ok).toBe(false);
  });
  it("rejects a filter nested beyond the depth cap (no throw)", () => {
    let f = { x: 1 };
    for (let i = 0; i < 60; i++) f = { nested: f };
    const r = checkMongoQuery(spec({ db: "app", collection: "orders", op: "countDocuments", filter: f }));
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain("deeply nested");
  });
  it("still accepts a normal query", () => {
    expect(checkMongoQuery(spec({ db: "app", collection: "orders", op: "countDocuments", filter: { status: "open" } })).ok).toBe(true);
  });
});

// BUFFER_MAX_ROWS NaN must NOT disable eviction (WAL growth DoS).
describe("resolveBufferCap (buffer eviction cap guard)", () => {
  const DEFAULT = 10000;
  it("falls back to the default for a non-numeric env (Number('foo')=NaN)", () => {
    expect(resolveBufferCap(undefined, "foo")).toBe(DEFAULT);
  });
  it("falls back to the default for an empty env (Number('')=0)", () => {
    expect(resolveBufferCap(undefined, "")).toBe(DEFAULT);
    expect(resolveBufferCap(undefined, undefined)).toBe(DEFAULT);
  });
  it("falls back to the default for zero / negative", () => {
    expect(resolveBufferCap(undefined, "0")).toBe(DEFAULT);
    expect(resolveBufferCap(undefined, "-5")).toBe(DEFAULT);
  });
  it("honours a valid env value", () => {
    expect(resolveBufferCap(undefined, "500")).toBe(500);
  });
  it("prefers an explicit option over env, truncating floats", () => {
    expect(resolveBufferCap(250, "500")).toBe(250);
    expect(resolveBufferCap(250.9, "500")).toBe(250);
  });
  it("ignores an invalid option and uses env", () => {
    expect(resolveBufferCap(NaN, "500")).toBe(500);
    expect(resolveBufferCap(0, "500")).toBe(500);
  });
});

// Item 19 — attributes fingerprint has no delimiter collision.
describe("attributesFingerprint (item 19)", () => {
  it("distinguishes attribute sets whose values contain = or |", () => {
    const a = attributesFingerprint({ k: "a|b", j: "c" });
    const b = attributesFingerprint({ k: "a", j: "b|c" });
    expect(a).not.toBe(b);
  });
  it("is order-independent", () => {
    expect(attributesFingerprint({ a: "1", b: "2" })).toBe(attributesFingerprint({ b: "2", a: "1" }));
  });
});
