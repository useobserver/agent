// MongoDB query JSON validator tests.

import { describe, expect, it } from "bun:test";
import { checkMongoQuery } from "../src/sources/database/_mongo-check.ts";

describe("checkMongoQuery — accepts", () => {
  it("countDocuments without filter", () => {
    const r = checkMongoQuery(
      JSON.stringify({ db: "mydb", collection: "orders", op: "countDocuments" }),
    );
    expect(r.ok).toBe(true);
    expect(r.spec?.op).toBe("countDocuments");
    expect(r.spec?.filter).toBeUndefined();
  });

  it("countDocuments with a simple filter", () => {
    const r = checkMongoQuery(
      JSON.stringify({
        db: "mydb",
        collection: "orders",
        op: "countDocuments",
        filter: { status: "pending" },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.spec?.filter).toEqual({ status: "pending" });
  });

  it("countDocuments with a nested filter using safe operators", () => {
    const r = checkMongoQuery(
      JSON.stringify({
        db: "mydb",
        collection: "orders",
        op: "countDocuments",
        filter: { status: { $in: ["pending", "queued"] }, created_at: { $gte: "2026-01-01" } },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("estimatedDocumentCount without filter", () => {
    const r = checkMongoQuery(
      JSON.stringify({ db: "mydb", collection: "orders", op: "estimatedDocumentCount" }),
    );
    expect(r.ok).toBe(true);
  });

  it("db / collection names with allowed characters", () => {
    const r = checkMongoQuery(
      JSON.stringify({ db: "my-db.v2", collection: "orders_2026", op: "countDocuments" }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("checkMongoQuery — rejects", () => {
  it("non-JSON", () => {
    expect(checkMongoQuery("not json").ok).toBe(false);
  });

  it("JSON that isn't an object", () => {
    expect(checkMongoQuery("[]").ok).toBe(false);
    expect(checkMongoQuery("null").ok).toBe(false);
    expect(checkMongoQuery('"hello"').ok).toBe(false);
  });

  it("missing db", () => {
    const r = checkMongoQuery(JSON.stringify({ collection: "x", op: "countDocuments" }));
    expect(r.ok).toBe(false);
  });

  it("missing collection", () => {
    const r = checkMongoQuery(JSON.stringify({ db: "x", op: "countDocuments" }));
    expect(r.ok).toBe(false);
  });

  it("unsupported op (find)", () => {
    const r = checkMongoQuery(
      JSON.stringify({ db: "x", collection: "y", op: "find" }),
    );
    expect(r.ok).toBe(false);
  });

  it("unsupported op (aggregate)", () => {
    const r = checkMongoQuery(
      JSON.stringify({ db: "x", collection: "y", op: "aggregate", pipeline: [{ $count: "x" }] }),
    );
    expect(r.ok).toBe(false);
  });

  it("estimatedDocumentCount with a filter (driver rejects this; we surface it earlier)", () => {
    const r = checkMongoQuery(
      JSON.stringify({
        db: "x",
        collection: "y",
        op: "estimatedDocumentCount",
        filter: { x: 1 },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/filter/);
  });

  it("filter containing $where", () => {
    const r = checkMongoQuery(
      JSON.stringify({
        db: "x",
        collection: "y",
        op: "countDocuments",
        filter: { $where: "this.x > 0" },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/\$where/);
  });

  it("filter containing $function (nested)", () => {
    const r = checkMongoQuery(
      JSON.stringify({
        db: "x",
        collection: "y",
        op: "countDocuments",
        filter: { compound: { nested: { $function: { body: "fn" } } } },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/\$function/);
  });

  it("filter containing $expr", () => {
    const r = checkMongoQuery(
      JSON.stringify({
        db: "x",
        collection: "y",
        op: "countDocuments",
        filter: { $expr: { $eq: ["$a", "$b"] } },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("filter that is an array", () => {
    const r = checkMongoQuery(
      JSON.stringify({
        db: "x",
        collection: "y",
        op: "countDocuments",
        filter: [{ x: 1 }],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("db name with disallowed characters", () => {
    const r = checkMongoQuery(
      JSON.stringify({ db: "my db", collection: "x", op: "countDocuments" }),
    );
    expect(r.ok).toBe(false);
  });

  it("collection name with disallowed characters", () => {
    const r = checkMongoQuery(
      JSON.stringify({ db: "x", collection: "my/coll", op: "countDocuments" }),
    );
    expect(r.ok).toBe(false);
  });

  it("non-string raw input", () => {
    expect(checkMongoQuery(undefined as unknown as string).ok).toBe(false);
  });
});
