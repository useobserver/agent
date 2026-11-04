// _prom-result.ts: the instant-query parser prometheus.ts uses (and the GCP
// source will). The prometheus cases pin the reason codes prometheus.ts has
// always emitted.
import { afterEach, describe, expect, it } from "bun:test";
import { parsePromInstantResult, parsePromInstantText } from "../src/sources/_prom-result.ts";
import { execute as promExecute } from "../src/sources/prometheus.ts";

const fixedNow = () => new Date("2026-11-04T00:00:00.000Z");
const vector = (...values: Array<[number | string, string]>) => ({
  status: "success",
  data: { resultType: "vector", result: values.map((value, i) => ({ metric: { i: String(i) }, value })) },
});

describe("parsePromInstantResult", () => {
  it("reads a single vector sample with its timestamp", () => {
    expect(parsePromInstantResult(vector([1700000000, "0.25"]), "prom")).toEqual({
      ok: true,
      value: 0.25,
      timestamp: new Date(1700000000 * 1000).toISOString(),
      seriesCount: 1,
    });
  });

  it("empty, missing and non-finite results are no_data_for_query", () => {
    for (const body of [vector(), { data: {} }, {}, null, 5, { data: { result: [{ metric: {} }] } }, vector([1, "NaN"]), vector([1, "abc"])]) {
      expect(parsePromInstantResult(body, "prom")).toEqual({ ok: false, reason: "no_data_for_query" });
    }
  });

  it("several series are prom_multiple_series with the count", () => {
    expect(parsePromInstantResult(vector([1, "1"], [1, "2"], [1, "3"]), "prom")).toEqual({
      ok: false,
      reason: "prom_multiple_series",
      metadata: { series: 3 },
    });
  });

  it("falls back to now on a malformed sample timestamp", () => {
    const r = parsePromInstantResult(vector(["junk", "7"]), "prom", { now: fixedNow });
    expect(r).toMatchObject({ ok: true, value: 7, timestamp: "2026-11-04T00:00:00.000Z" });
  });

  it("scalar results only when asked", () => {
    const scalar = { data: { resultType: "scalar", result: [1700000000, "42"] } };
    expect(parsePromInstantResult(scalar, "prom", { scalar: false })).toEqual({ ok: false, reason: "no_data_for_query" });
    expect(parsePromInstantResult(scalar, "prom", { scalar: true })).toMatchObject({ ok: true, value: 42, seriesCount: 1 });
    expect(parsePromInstantResult({ data: { resultType: "scalar", result: [] } }, "prom", { scalar: true })).toEqual({
      ok: false,
      reason: "no_data_for_query",
    });
  });

  it("text input: bad JSON is the prefix's bad-response code", () => {
    expect(parsePromInstantText("{not json", "prom")).toEqual({ ok: false, reason: "prom_bad_response" });
    expect(parsePromInstantText(JSON.stringify(vector([1, "3"])), "prom")).toMatchObject({ ok: true, value: 3 });
  });
});

describe("prometheus.ts through the shared parser", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const respond = (body: string, status = 200) => {
    globalThis.fetch = (async () => new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  };
  const env = { prometheusUrl: "http://prom.test:9090" };

  it("value and sample timestamp", async () => {
    respond(JSON.stringify(vector([1700000000, "12.5"])));
    const r = await promExecute({ query: "up" } as never, env);
    expect(r.value).toBe(12.5);
    expect(r.timestamp).toBe(new Date(1700000000 * 1000).toISOString());
    expect(r.reason).toBeUndefined();
  });

  it("keeps its reason codes", async () => {
    respond(JSON.stringify(vector()));
    expect((await promExecute({ query: "up" } as never, env)).reason).toBe("no_data_for_query");
    respond(JSON.stringify(vector([1, "1"], [1, "2"])));
    const multi = await promExecute({ query: "up" } as never, env);
    expect(multi.reason).toBe("prom_multiple_series");
    expect(multi.metadata).toEqual({ series: 2 });
    respond("{not json");
    expect((await promExecute({ query: "up" } as never, env)).reason).toBe("prom_bad_response");
    respond(JSON.stringify({ data: { resultType: "scalar", result: [1, "4"] } }));
    expect((await promExecute({ query: "up" } as never, env)).reason).toBe("no_data_for_query");
    respond("", 400);
    expect((await promExecute({ query: "up" } as never, env)).reason).toBe("BadQuery");
  });
});
