// Loki log-derived metric source tests.
//
// Real HTTP against an ephemeral Bun.serve Loki stub that returns
// canned /loki/api/v1/query responses by query/header — no mocking.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import loki from "../src/sources/loki.ts";

// The stub inspects the `query` param + headers and returns a shaped
// Loki response. Special query tokens drive each branch.
let lastHeaders: Record<string, string> = {};
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/loki/api/v1/query")) return new Response("not found", { status: 404 });
    lastHeaders = Object.fromEntries(req.headers.entries());
    const q = url.searchParams.get("query") ?? "";
    if (q.includes("UNAUTH")) return new Response(JSON.stringify({ message: "no org id" }), { status: 401 });
    if (q.includes("BADQUERY"))
      return new Response(JSON.stringify({ message: "parse error: unexpected }" }), { status: 400 });
    if (q.includes("BOOM")) return new Response("upstream", { status: 502 });
    if (q.includes("STREAMS"))
      return Response.json({ status: "success", data: { resultType: "streams", result: [{ stream: {}, values: [] }] } });
    if (q.includes("EMPTY"))
      return Response.json({ status: "success", data: { resultType: "vector", result: [] } });
    if (q.includes("MULTI"))
      return Response.json({
        status: "success",
        data: {
          resultType: "vector",
          result: [
            { metric: { a: "1" }, value: [1700000000, "3"] },
            { metric: { a: "2" }, value: [1700000000, "7"] },
          ],
        },
      });
    if (q.includes("SCALAR"))
      return Response.json({ status: "success", data: { resultType: "scalar", result: [1700000000, "42"] } });
    // default: single vector value
    return Response.json({
      status: "success",
      data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, "12.5"] }] },
    });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

beforeEach(() => {
  lastHeaders = {};
  delete process.env.OBSERVER_TEST_LOKI_TOKEN;
  delete process.env.OBSERVER_TEST_LOKI_PASS;
});
afterAll(() => server.stop(true));

const cfg = (extra: Record<string, unknown> = {}) => ({
  base_url: BASE,
  query: 'sum(rate({app="checkout"} |= "ERROR" [5m]))',
  auth_mode: "none" as const,
  timeout_ms: 3000,
  ...extra,
});

describe("validateConfig", () => {
  it("accepts an aggregation query", () => {
    expect(loki.validateConfig(cfg())).toBeNull();
  });
  it("rejects a raw log stream (no aggregation)", () => {
    expect(loki.validateConfig({ base_url: BASE, query: '{app="checkout"} |= "ERROR"' })).not.toBeNull();
  });
  it("accepts count_over_time", () => {
    expect(loki.validateConfig({ base_url: BASE, query: 'count_over_time({s="p"} |~ "x" [1h])' })).toBeNull();
  });
  it("rejects bearer auth without token_ref", () => {
    expect(loki.validateConfig({ base_url: BASE, query: "rate({a=\"b\"}[5m])", auth_mode: "bearer" })).not.toBeNull();
  });
  it("rejects basic auth without username + password_ref", () => {
    expect(
      loki.validateConfig({ base_url: BASE, query: "rate({a=\"b\"}[5m])", auth_mode: "basic", username: "u" }),
    ).not.toBeNull();
  });
});

describe("execute — result extraction", () => {
  it("returns the single vector value", async () => {
    const r = await loki.execute(cfg());
    expect(r.value).toBe(12.5);
    expect(r.status_hint).toBeUndefined();
  });
  it("returns a scalar value with Loki's timestamp (not execution time)", async () => {
    const r = await loki.execute(cfg({ query: "rate({a=\"SCALAR\"}[5m])" }));
    expect(r.value).toBe(42);
    expect(r.timestamp).toBe(new Date(1700000000 * 1000).toISOString());
  });
  it("empty result → loki_no_data", async () => {
    const r = await loki.execute(cfg({ query: "rate({a=\"EMPTY\"}[5m])" }));
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("loki_no_data");
  });
  it("multiple series → loki_multiple_series", async () => {
    const r = await loki.execute(cfg({ query: "rate({a=\"MULTI\"}[5m])" }));
    expect(r.reason).toBe("loki_multiple_series");
  });
  it("streams resultType → loki_not_aggregation", async () => {
    const r = await loki.execute(cfg({ query: "rate({a=\"STREAMS\"}[5m])" }));
    expect(r.reason).toBe("loki_not_aggregation");
  });
});

describe("execute — errors surface with text", () => {
  it("400 → loki_query_error with Loki's message", async () => {
    const r = await loki.execute(cfg({ query: "rate({a=\"BADQUERY\"}[5m])" }));
    expect(r.reason).toBe("loki_query_error");
    expect(String((r.metadata as Record<string, unknown>).error)).toContain("parse error");
  });
  it("401 → loki_unauthorized", async () => {
    const r = await loki.execute(cfg({ query: "rate({a=\"UNAUTH\"}[5m])" }));
    expect(r.reason).toBe("loki_unauthorized");
  });
  it("502 → loki_server_error", async () => {
    const r = await loki.execute(cfg({ query: "rate({a=\"BOOM\"}[5m])" }));
    expect(r.reason).toBe("loki_server_error");
  });
  it("connection refused → loki_unreachable", async () => {
    const r = await loki.execute(cfg({ base_url: "http://127.0.0.1:1" }));
    expect(["loki_unreachable", "loki_error"]).toContain(r.reason);
  });
});

describe("execute — auth via env refs", () => {
  it("bearer token from env ref sets Authorization, never echoed", async () => {
    process.env.OBSERVER_TEST_LOKI_TOKEN = "s3cret-token";
    const r = await loki.execute(cfg({ auth_mode: "bearer", token_ref: "OBSERVER_TEST_LOKI_TOKEN" }));
    expect(r.value).toBe(12.5);
    expect(lastHeaders.authorization).toBe("Bearer s3cret-token");
    expect(JSON.stringify(r.metadata ?? {})).not.toContain("s3cret-token");
  });
  it("missing token env ref → loki_auth_ref_missing", async () => {
    const r = await loki.execute(cfg({ auth_mode: "bearer", token_ref: "OBSERVER_TEST_LOKI_TOKEN" }));
    expect(r.reason).toBe("loki_auth_ref_missing");
  });
  it("basic auth builds the header from username + password ref", async () => {
    process.env.OBSERVER_TEST_LOKI_PASS = "pw";
    const r = await loki.execute(cfg({ auth_mode: "basic", username: "obs", password_ref: "OBSERVER_TEST_LOKI_PASS" }));
    expect(r.value).toBe(12.5);
    expect(lastHeaders.authorization).toBe(`Basic ${Buffer.from("obs:pw").toString("base64")}`);
  });
  it("tenant_id sets X-Scope-OrgID", async () => {
    const r = await loki.execute(cfg({ tenant_id: "team-a" }));
    expect(r.value).toBe(12.5);
    expect(lastHeaders["x-scope-orgid"]).toBe("team-a");
  });
});
