// receiver integration tests.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createOtlpReceiver } from "../src/sources/otlp/receiver.ts";

// Pick an ephemeral port range so parallel runs don't collide. Bun's
// Bun.serve {port: 0} would also work, but createOtlpReceiver takes a
// concrete listen_addr — we resolve the port via the stats() output.

function freshReceiver(opts?: Partial<{ bearerToken: string; maxBufferPoints: number; host: string }>) {
  return createOtlpReceiver({
    listenAddr: `${opts?.host ?? "127.0.0.1"}:0`,
    bearerToken: opts?.bearerToken ?? null,
    maxBufferPoints: opts?.maxBufferPoints ?? 1000,
  });
}

async function pushMetrics(addr: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return await fetch(`http://${addr}/v1/metrics`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const sampleGauge = (name = "queue.depth", value = 5, attrs: Record<string, string> = {}) => ({
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
                    // Time = now in nanos to avoid staleness failures.
                    timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
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
});

let receiver: ReturnType<typeof createOtlpReceiver> | null = null;
let addr = "";

beforeEach(async () => {
  receiver = freshReceiver();
  await receiver.start();
  addr = receiver.stats().listen_addr!;
  // Replace the listen_addr placeholder host with the bind we asked
  // for (Bun.serve assigns the ephemeral port back into stats()).
});

afterEach(async () => {
  await receiver?.stop();
  receiver = null;
});

describe("OTLP receiver lifecycle", () => {
  it("starts + reports a non-null listen address", () => {
    expect(receiver!.stats().running).toBe(true);
    expect(receiver!.stats().listen_addr).not.toBeNull();
  });

  it("405s on non-POST", async () => {
    const r = await fetch(`http://${addr}/v1/metrics`, { method: "GET" });
    expect(r.status).toBe(405);
  });

  it("404s on unknown paths", async () => {
    const r = await fetch(`http://${addr}/v2/metrics`, { method: "POST" });
    expect(r.status).toBe(404);
  });

  it("400s on malformed JSON", async () => {
    const r = await pushMetrics(addr, "not json");
    expect(r.status).toBe(400);
  });

  it("415s on application/x-protobuf (encoding not supported in v1)", async () => {
    const r = await fetch(`http://${addr}/v1/metrics`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: "binary",
    });
    expect(r.status).toBe(415);
  });

  it("ingests a gauge and exposes it through subscribe()", async () => {
    const r = await pushMetrics(addr, sampleGauge("queue.depth", 5));
    expect(r.status).toBe(200);
    const sub = receiver!.subscribe({ metric_name: "queue.depth" });
    const dp = sub.latest();
    expect(dp).not.toBeNull();
    expect(dp!.value).toBe(5);
    sub.unsubscribe();
  });

  it("filters subscriptions by attributes (exact match)", async () => {
    await pushMetrics(addr, sampleGauge("queue.depth", 10, { "service.name": "checkout" }));
    await pushMetrics(addr, sampleGauge("queue.depth", 20, { "service.name": "billing" }));
    const subA = receiver!.subscribe({
      metric_name: "queue.depth",
      attribute_filters: { "service.name": "checkout" },
    });
    const subB = receiver!.subscribe({
      metric_name: "queue.depth",
      attribute_filters: { "service.name": "billing" },
    });
    expect(subA.latest()?.value).toBe(10);
    expect(subB.latest()?.value).toBe(20);
    subA.unsubscribe();
    subB.unsubscribe();
  });

  it("returns null when no matching data has arrived", () => {
    const sub = receiver!.subscribe({ metric_name: "never.seen" });
    expect(sub.latest()).toBeNull();
    sub.unsubscribe();
  });
});

describe("OTLP receiver auth", () => {
  it("accepts valid bearer token", async () => {
    await receiver!.stop();
    receiver = freshReceiver({ bearerToken: "secret-token-42" });
    await receiver.start();
    addr = receiver.stats().listen_addr!;
    const r = await pushMetrics(addr, sampleGauge(), { Authorization: "Bearer secret-token-42" });
    expect(r.status).toBe(200);
    expect(receiver.stats().requests_authenticated).toBe(1);
    expect(receiver.stats().requests_rejected_auth).toBe(0);
  });

  it("rejects missing bearer token", async () => {
    await receiver!.stop();
    receiver = freshReceiver({ bearerToken: "secret-token-42" });
    await receiver.start();
    addr = receiver.stats().listen_addr!;
    const r = await pushMetrics(addr, sampleGauge());
    expect(r.status).toBe(401);
    expect(receiver.stats().requests_rejected_auth).toBe(1);
  });

  it("rejects wrong bearer token", async () => {
    await receiver!.stop();
    receiver = freshReceiver({ bearerToken: "secret-token-42" });
    await receiver.start();
    addr = receiver.stats().listen_addr!;
    const r = await pushMetrics(addr, sampleGauge(), { Authorization: "Bearer not-the-token" });
    expect(r.status).toBe(401);
  });

  it("refuses to bind non-loopback without a token", () => {
    expect(() =>
      createOtlpReceiver({
        listenAddr: "0.0.0.0:14318",
        bearerToken: null,
        maxBufferPoints: 100,
      }),
    ).toThrow(/non-loopback/);
  });
});

describe("OTLP receiver buffer eviction", () => {
  it("drops the oldest stream when max stream count is exceeded", async () => {
    await receiver!.stop();
    receiver = freshReceiver({ maxBufferPoints: 3 });
    await receiver.start();
    addr = receiver.stats().listen_addr!;

    // Push 4 distinct stream keys (metric_name × attributes); the 4th
    // forces eviction of the 1st.
    for (let i = 0; i < 4; i++) {
      await pushMetrics(addr, sampleGauge("queue.depth", i, { id: String(i) }));
    }
    const stats = receiver.stats();
    expect(stats.unique_streams).toBe(3);
    expect(stats.data_points_dropped).toBeGreaterThanOrEqual(1);
  });
});

describe("OTLP receiver stats", () => {
  it("counts each authenticated request", async () => {
    await pushMetrics(addr, sampleGauge());
    await pushMetrics(addr, sampleGauge());
    expect(receiver!.stats().requests_authenticated).toBe(2);
    expect(receiver!.stats().data_points_received).toBe(2);
  });

  it("counts payload rejections", async () => {
    await pushMetrics(addr, "garbage");
    expect(receiver!.stats().requests_rejected_payload).toBe(1);
  });
});
