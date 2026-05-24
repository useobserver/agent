// OTLP Source class (push-mode) integration with
// the singleton receiver. Verifies init→read→dispose around live
// receiver state.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import otlpSource from "../src/sources/otlp.ts";
import {
  configureOtlpReceiverFromEnv,
  resetOtlpReceiverForTests,
  startOtlpReceiverOnce,
  getOtlpReceiver,
} from "../src/sources/otlp/receiver.ts";

function sampleGauge(value: number, attrs: Record<string, string> = {}, name = "queue.depth", ts = Date.now()) {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: Object.entries(attrs).map(([k, v]) => ({ key: k, value: { stringValue: v } })),
        },
        scopeMetrics: [
          {
            scope: { attributes: [] },
            metrics: [
              {
                name,
                gauge: {
                  dataPoints: [
                    {
                      attributes: [],
                      timeUnixNano: String(BigInt(ts) * 1_000_000n),
                      asDouble: value,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

let receiverAddr: string;

beforeEach(async () => {
  resetOtlpReceiverForTests();
  // configureOtlpReceiverFromEnv reads OBSERVER_OTLP_LISTEN_ADDR; set
  // it to an ephemeral port on loopback so each test gets a fresh
  // receiver.
  process.env.OBSERVER_OTLP_LISTEN_ADDR = "127.0.0.1:0";
  delete process.env.OBSERVER_OTLP_BEARER_TOKEN;
  delete process.env.OBSERVER_OTLP_DISABLE;
  configureOtlpReceiverFromEnv();
  await startOtlpReceiverOnce();
  const r = getOtlpReceiver();
  if (!r) throw new Error("receiver did not start");
  const a = r.stats().listen_addr;
  if (!a) throw new Error("receiver has no listen address");
  receiverAddr = a;
});

afterEach(() => {
  resetOtlpReceiverForTests();
});

describe("OTLP source class lifecycle", () => {
  it("validateConfig rejects unknown keys (strict)", () => {
    const err = otlpSource.validateConfig({
      metric_name: "queue.depth",
      aggregation: "latest",
      staleness_ms: 60_000,
      not_a_real_key: "x",
    });
    expect(err).not.toBeNull();
  });

  it("init() returns an instance whose read() surfaces no_data when no samples", async () => {
    const inst = await otlpSource.init({
      metric_name: "never.seen",
      aggregation: "latest",
      staleness_ms: 60_000,
    });
    const r = await inst.read();
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("otlp_no_samples");
    await inst.dispose();
  });

  it("init() reads the most recent matching sample after ingest", async () => {
    const inst = await otlpSource.init({
      metric_name: "queue.depth",
      aggregation: "latest",
      staleness_ms: 60_000,
    });
    await fetch(`http://${receiverAddr}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleGauge(123)),
    });
    const r = await inst.read();
    expect(r.value).toBe(123);
    expect(r.status_hint).toBeUndefined();
    await inst.dispose();
  });

  it("filters by attribute_filters", async () => {
    const inst = await otlpSource.init({
      metric_name: "queue.depth",
      attribute_filters: { "service.name": "checkout" },
      aggregation: "latest",
      staleness_ms: 60_000,
    });
    await fetch(`http://${receiverAddr}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleGauge(5, { "service.name": "billing" })),
    });
    await fetch(`http://${receiverAddr}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleGauge(50, { "service.name": "checkout" })),
    });
    const r = await inst.read();
    expect(r.value).toBe(50);
    await inst.dispose();
  });

  it("surfaces otlp_stale once the latest sample is older than staleness_ms", async () => {
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    await fetch(`http://${receiverAddr}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleGauge(99, {}, "stale.metric", tenMinAgo)),
    });
    const inst = await otlpSource.init({
      metric_name: "stale.metric",
      aggregation: "latest",
      staleness_ms: 60_000, // 60s; sample is 10min old
    });
    const r = await inst.read();
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("otlp_stale");
    await inst.dispose();
  });

  it("dispose unsubscribes — subsequent reads from a new sub see fresh data", async () => {
    const a = await otlpSource.init({
      metric_name: "queue.depth",
      aggregation: "latest",
      staleness_ms: 60_000,
    });
    await fetch(`http://${receiverAddr}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleGauge(7)),
    });
    expect((await a.read()).value).toBe(7);
    await a.dispose();

    // Subscriptions are independent. A new init reads from the same
    // shared receiver buffer, which still has the latest sample.
    const b = await otlpSource.init({
      metric_name: "queue.depth",
      aggregation: "latest",
      staleness_ms: 60_000,
    });
    expect((await b.read()).value).toBe(7);
    await b.dispose();
  });

  it("returns otlp_receiver_disabled when OBSERVER_OTLP_DISABLE=true", async () => {
    resetOtlpReceiverForTests();
    process.env.OBSERVER_OTLP_DISABLE = "true";
    const inst = await otlpSource.init({
      metric_name: "x",
      aggregation: "latest",
      staleness_ms: 60_000,
    });
    const r = await inst.read();
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("otlp_receiver_disabled");
    await inst.dispose();
    delete process.env.OBSERVER_OTLP_DISABLE;
  });
});
