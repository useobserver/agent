// Elasticsearch / OpenSearch source tests.
//
// Real HTTP against an ephemeral Bun.serve ES stub. The index path
// drives each branch; the request body + headers are captured.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import es from "../src/sources/elasticsearch.ts";

let lastHeaders: Record<string, string> = {};
let lastBody: unknown = null;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/_search")) return new Response("not found", { status: 404 });
    lastHeaders = Object.fromEntries(req.headers.entries());
    lastBody = await req.json().catch(() => null);
    const index = decodeURIComponent(url.pathname.split("/")[1] ?? "");

    if (index === "unauth") return new Response(JSON.stringify({ error: { type: "security_exception", reason: "denied" } }), { status: 401 });
    if (index === "missing")
      return new Response(JSON.stringify({ error: { type: "index_not_found_exception", reason: "no such index [missing]" } }), { status: 404 });
    if (index === "badquery")
      return new Response(JSON.stringify({ error: { type: "parsing_exception", reason: "unknown query [bogus]" } }), { status: 400 });
    if (index === "boom") return new Response("oops", { status: 503 });
    if (index === "noaggs") return Response.json({ took: 1, hits: { total: { value: 0 } } });
    if (index === "nullavg") return Response.json({ aggregations: { avg_latency: { value: null } } });
    if (index === "percentiles")
      return Response.json({ aggregations: { p: { values: { "95.0": 123.4, "99.0": 200.1 } } } });
    // default: a value_count aggregation named error_count = 17
    return Response.json({ aggregations: { error_count: { value: 17 } } });
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

beforeEach(() => {
  lastHeaders = {};
  lastBody = null;
  delete process.env.OBSERVER_TEST_ES_TOKEN;
  delete process.env.OBSERVER_TEST_ES_PASS;
  delete process.env.OBSERVER_TEST_ES_APIKEY;
});
afterAll(() => server.stop(true));

const AGGS = { query: { match_all: {} }, aggs: { error_count: { value_count: { field: "@timestamp" } } } };
const cfg = (extra: Record<string, unknown> = {}) => ({
  base_url: BASE,
  index: "logs-*",
  query: AGGS,
  agg_name: "error_count",
  auth_mode: "none" as const,
  timeout_ms: 3000,
  ...extra,
});

describe("validateConfig", () => {
  it("accepts a query with an aggs block", () => {
    expect(es.validateConfig(cfg())).toBeNull();
  });
  it("rejects a query with no aggregation", () => {
    expect(es.validateConfig({ base_url: BASE, index: "logs-*", query: { query: { match_all: {} } }, agg_name: "x" })).not.toBeNull();
  });
  it("rejects api_key auth without api_key_ref", () => {
    expect(es.validateConfig(cfg({ auth_mode: "api_key" }))).not.toBeNull();
  });
});

describe("execute — aggregation extraction", () => {
  it("reads a single-value aggregation", async () => {
    const r = await es.execute(cfg());
    expect(r.value).toBe(17);
    expect(r.status_hint).toBeUndefined();
  });
  it("forces size:0 in the request body", async () => {
    await es.execute(cfg());
    expect((lastBody as { size?: number }).size).toBe(0);
  });
  it("missing aggregation name → es_agg_not_found with available names", async () => {
    const r = await es.execute(cfg({ agg_name: "nope" }));
    expect(r.reason).toBe("es_agg_not_found");
    expect((r.metadata as Record<string, unknown>).available).toEqual(["error_count"]);
  });
  it("no aggregations block → es_agg_not_found", async () => {
    const r = await es.execute(cfg({ index: "noaggs" }));
    expect(r.reason).toBe("es_agg_not_found");
  });
  it("null aggregation value → es_no_data", async () => {
    const r = await es.execute(cfg({ index: "nullavg", agg_name: "avg_latency" }));
    expect(r.reason).toBe("es_no_data");
  });
  it("percentiles: reads the requested percentile", async () => {
    const r = await es.execute(cfg({ index: "percentiles", agg_name: "p", percentile: "95.0" }));
    expect(r.value).toBe(123.4);
  });
  it("percentiles: accepts '95' for the '95.0' key", async () => {
    const r = await es.execute(cfg({ index: "percentiles", agg_name: "p", percentile: "95" }));
    expect(r.value).toBe(123.4);
  });
});

describe("execute — errors surface with ES text", () => {
  it("400 → es_query_error with the parser reason", async () => {
    const r = await es.execute(cfg({ index: "badquery" }));
    expect(r.reason).toBe("es_query_error");
    expect(String((r.metadata as Record<string, unknown>).error)).toContain("unknown query");
  });
  it("404 → es_index_not_found", async () => {
    const r = await es.execute(cfg({ index: "missing" }));
    expect(r.reason).toBe("es_index_not_found");
  });
  it("401 → es_unauthorized", async () => {
    const r = await es.execute(cfg({ index: "unauth" }));
    expect(r.reason).toBe("es_unauthorized");
  });
  it("503 → es_server_error", async () => {
    const r = await es.execute(cfg({ index: "boom" }));
    expect(r.reason).toBe("es_server_error");
  });
  it("connection refused → es_unreachable", async () => {
    const r = await es.execute(cfg({ base_url: "http://127.0.0.1:1" }));
    expect(["es_unreachable", "es_error"]).toContain(r.reason);
  });
});

describe("execute — auth via env refs", () => {
  it("api_key sets ApiKey header, never echoed", async () => {
    process.env.OBSERVER_TEST_ES_APIKEY = "base64-id-key";
    const r = await es.execute(cfg({ auth_mode: "api_key", api_key_ref: "OBSERVER_TEST_ES_APIKEY" }));
    expect(r.value).toBe(17);
    expect(lastHeaders.authorization).toBe("ApiKey base64-id-key");
    expect(JSON.stringify(r.metadata ?? {})).not.toContain("base64-id-key");
  });
  it("missing api_key env ref → es_auth_ref_missing", async () => {
    const r = await es.execute(cfg({ auth_mode: "api_key", api_key_ref: "OBSERVER_TEST_ES_APIKEY" }));
    expect(r.reason).toBe("es_auth_ref_missing");
  });
  it("basic auth builds the header from username + password ref", async () => {
    process.env.OBSERVER_TEST_ES_PASS = "pw";
    const r = await es.execute(cfg({ auth_mode: "basic", username: "obs", password_ref: "OBSERVER_TEST_ES_PASS" }));
    expect(r.value).toBe(17);
    expect(lastHeaders.authorization).toBe(`Basic ${Buffer.from("obs:pw").toString("base64")}`);
  });
});
