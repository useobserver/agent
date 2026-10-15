import { describe, expect, it } from "bun:test";
import { AGENT_JOBS_CLAIM_PATH, sanitizeProbeTestResult } from "@observer/protocol";
import {
  BUSY_POLL_MS,
  DEFAULT_POLL_MS,
  MAX_POLL_MS,
  MIN_POLL_MS,
  UNSUPPORTED_RECHECK_MS,
  clampPollMs,
  createJobRunner,
  type JobHandler,
} from "../src/jobs/runner";
import { createProbeTestHandler } from "../src/jobs/probe-test";
import { createCloudwatchListMetricsHandler } from "../src/jobs/cloudwatch-list-metrics";

// Agent job queue client: claim → run → post. A fake cloudFetch records
// every call so tests can assert exactly what leaves the host.

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function fakeCloud(claim: () => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const cloudFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : null });
    if (method === "GET") {
      const out = await claim();
      if (out instanceof Error) throw out;
      return new Response(JSON.stringify(out), { status: 200 });
    }
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  };
  return { calls, cloudFetch };
}

function httpError(status: number): Error {
  const e = new Error(`HTTP ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}

const noopLog = () => {};

describe("job runner: claim request", () => {
  it("asks only for the kinds it has handlers for", async () => {
    const { calls, cloudFetch } = fakeCloud(() => ({ jobs: [] }));
    const runner = createJobRunner({
      cloudFetch,
      handlers: { probe_test: async () => ({ ok: true, result: {} }), cloudwatch_list_metrics: async () => ({ ok: true, result: {} }) },
      log: noopLog,
    });
    await runner.pollOnce();
    expect(calls[0].path).toBe(`${AGENT_JOBS_CLAIM_PATH}?kinds=${encodeURIComponent("cloudwatch_list_metrics,probe_test")}`);
    expect(runner.supported()).toBe(true);
  });

  it("idle poll honours the cloud's next_poll_ms within clamps", async () => {
    const { cloudFetch } = fakeCloud(() => ({ jobs: [], next_poll_ms: 7_000 }));
    const runner = createJobRunner({ cloudFetch, handlers: {}, log: noopLog });
    expect(await runner.pollOnce()).toBe(7_000);
    expect(clampPollMs(10)).toBe(MIN_POLL_MS);
    expect(clampPollMs(10_000_000)).toBe(MAX_POLL_MS);
    expect(clampPollMs(undefined)).toBe(DEFAULT_POLL_MS);
    expect(clampPollMs("nope")).toBe(DEFAULT_POLL_MS);
  });
});

describe("job runner: unknown kinds are never executed", () => {
  it("answers unsupported_kind without calling any handler", async () => {
    let ran = 0;
    const { calls, cloudFetch } = fakeCloud(() => ({ jobs: [{ id: "j1", kind: "future_kind", payload: { x: 1 } }] }));
    const runner = createJobRunner({
      cloudFetch,
      handlers: { probe_test: async () => ((ran += 1), { ok: true, result: {} }) },
      log: noopLog,
    });
    const delay = await runner.pollOnce();
    expect(ran).toBe(0);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe(`${AGENT_JOBS_CLAIM_PATH}/j1/result`);
    expect(post.body).toEqual({ ok: false, error: "unsupported_kind" });
    expect(runner.stats().unsupported_kind).toBe(1);
    expect(delay).toBe(BUSY_POLL_MS);
  });

  it("does not treat inherited object keys as handlers", async () => {
    const { calls, cloudFetch } = fakeCloud(() => ({ jobs: [{ id: "j2", kind: "toString", payload: {} }] }));
    const runner = createJobRunner({ cloudFetch, handlers: {}, log: noopLog });
    await runner.pollOnce();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ ok: false, error: "unsupported_kind" });
  });

  it("drops malformed job entries", async () => {
    const { calls, cloudFetch } = fakeCloud(() => ({ jobs: [null, { kind: "probe_test" }, { id: "", kind: "probe_test" }] }));
    const runner = createJobRunner({ cloudFetch, handlers: { probe_test: async () => ({ ok: true, result: {} }) }, log: noopLog });
    await runner.pollOnce();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("job runner: failures never leak messages", () => {
  it("a throwing handler posts a reason code, not the message", async () => {
    const handler: JobHandler = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED postgres://admin:hunter2@db:5432"), { code: "ECONNREFUSED" });
    };
    const { calls, cloudFetch } = fakeCloud(() => ({ jobs: [{ id: "j3", kind: "probe_test", payload: {} }] }));
    const runner = createJobRunner({ cloudFetch, handlers: { probe_test: handler }, log: noopLog });
    await runner.pollOnce();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ ok: false, error: "ECONNREFUSED" });
    expect(JSON.stringify(post.body)).not.toContain("hunter2");
  });

  it("a throw without a code becomes agent_error", async () => {
    const { calls, cloudFetch } = fakeCloud(() => ({ jobs: [{ id: "j4", kind: "probe_test", payload: {} }] }));
    const runner = createJobRunner({
      cloudFetch,
      handlers: { probe_test: async () => { throw new Error("free text with https://secret.example/?token=abc"); } },
      log: noopLog,
    });
    await runner.pollOnce();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ ok: false, error: "agent_error" });
  });
});

describe("job runner: cloud compatibility", () => {
  it("404 on the claim path marks the queue unsupported and backs off to the recheck interval", async () => {
    const seen: boolean[] = [];
    const { cloudFetch } = fakeCloud(() => httpError(404));
    const runner = createJobRunner({ cloudFetch, handlers: {}, log: noopLog, onSupportChange: (s) => seen.push(s) });
    expect(runner.supported()).toBeNull();
    expect(await runner.pollOnce()).toBe(UNSUPPORTED_RECHECK_MS);
    expect(runner.supported()).toBe(false);
    expect(seen).toEqual([false]);
  });

  it("other errors back off exponentially, capped, and recover", async () => {
    let fail = true;
    const { cloudFetch } = fakeCloud(() => (fail ? httpError(503) : { jobs: [] }));
    const runner = createJobRunner({ cloudFetch, handlers: {}, log: noopLog });
    const d1 = await runner.pollOnce();
    const d2 = await runner.pollOnce();
    expect(d2).toBeGreaterThan(d1);
    for (let i = 0; i < 10; i++) await runner.pollOnce();
    expect(await runner.pollOnce()).toBeLessThanOrEqual(60_000);
    fail = false;
    expect(await runner.pollOnce()).toBe(DEFAULT_POLL_MS);
  });

  it("start/stop drives a single timer chain", async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const { calls, cloudFetch } = fakeCloud(() => ({ jobs: [] }));
    const runner = createJobRunner({
      cloudFetch,
      handlers: {},
      log: noopLog,
      setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimer: () => {},
    });
    runner.start();
    runner.start(); // idempotent
    expect(timers).toHaveLength(1);
    timers[0].fn();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toHaveLength(1);
    expect(timers).toHaveLength(2);
    runner.stop();
    timers[1].fn();
    await new Promise((r) => setTimeout(r, 5));
    // A tick after stop() still completes its poll but never reschedules.
    expect(timers).toHaveLength(2);
  });
});

describe("probe_test handler", () => {
  const job = (payload: unknown) => ({ id: "t1", kind: "probe_test", payload });
  const thresholds = { healthy_operation: "under", healthy_value: 500, unhealthy_operation: "over", unhealthy_value: 2000 };

  it("runs the source once and returns only value, verdict, latency, reason", async () => {
    let seenId = "";
    const handler = createProbeTestHandler({
      execute: async (def) => {
        seenId = def.id;
        return {
          value: 120,
          timestamp: new Date().toISOString(),
          metadata: { body: "SECRET RESPONSE BODY", rows: [{ email: "a@b.c" }] },
        };
      },
      env: () => ({}),
    });
    const out = await handler(job({ source_type: "http", source_config: { url: "https://x" }, ...thresholds }));
    expect(out.ok).toBe(true);
    const result = (out as { ok: true; result: Record<string, unknown> }).result;
    expect(Object.keys(result).sort()).toEqual(["latency_ms", "reason", "value", "verdict"]);
    expect(result.value).toBe(120);
    expect(result.verdict).toBe("healthy");
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(seenId.startsWith("probe-test:")).toBe(true);
  });

  it("applies strict operators (threshold-equal is not a match)", async () => {
    const handler = createProbeTestHandler({ execute: async () => ({ value: 500, timestamp: "" }), env: () => ({}) });
    const out = (await handler(job({ source_type: "http", source_config: {}, ...thresholds }))) as { ok: true; result: { verdict: string } };
    expect(out.result.verdict).toBe("degraded");
  });

  it("no_data keeps the reason code; free-text reasons collapse", async () => {
    const h1 = createProbeTestHandler({
      execute: async () => ({ value: null, timestamp: "", status_hint: "no_data", reason: "ETIMEDOUT" }),
      env: () => ({}),
    });
    const r1 = (await h1(job({ source_type: "tcp", source_config: {}, ...thresholds }))) as { ok: true; result: Record<string, unknown> };
    expect(r1.result).toMatchObject({ value: null, verdict: "no_data", reason: "ETIMEDOUT" });

    const h2 = createProbeTestHandler({
      execute: async () => ({ value: null, timestamp: "", status_hint: "no_data", reason: "password authentication failed for user admin" }),
      env: () => ({}),
    });
    const r2 = (await h2(job({ source_type: "database", source_config: {}, ...thresholds }))) as { ok: true; result: Record<string, unknown> };
    expect(r2.result.reason).toBe("probe_failed");
  });

  it("refuses custom, otlp and unknown source types without executing", async () => {
    let ran = 0;
    const handler = createProbeTestHandler({ execute: async () => ((ran += 1), { value: 1, timestamp: "" }), env: () => ({}) });
    for (const t of ["custom", "otlp", "manual", "heartbeat", "nope"]) {
      expect(await handler(job({ source_type: t, source_config: {} }))).toEqual({ ok: false, error: "unsupported_source_type" });
    }
    expect(await handler(job({ source_type: "http", source_config: [] }))).toEqual({ ok: false, error: "invalid_config" });
    expect(ran).toBe(0);
  });

  it("times out a hung source", async () => {
    const handler = createProbeTestHandler({
      execute: () => new Promise(() => {}),
      env: () => ({}),
      timeoutMs: 20,
    });
    const out = (await handler(job({ source_type: "http", source_config: {}, ...thresholds }))) as { ok: true; result: Record<string, unknown> };
    expect(out.result).toMatchObject({ verdict: "no_data", reason: "test_timeout" });
  });

  it("a rejecting source becomes source_threw, never a throw", async () => {
    const handler = createProbeTestHandler({ execute: async () => { throw new Error("boom dsn"); }, env: () => ({}) });
    const out = (await handler(job({ source_type: "http", source_config: {}, ...thresholds }))) as { ok: true; result: Record<string, unknown> };
    expect(out.result).toMatchObject({ verdict: "no_data", reason: "source_threw" });
  });
});

describe("sanitizeProbeTestResult", () => {
  it("drops unknown keys and normalises bad values", () => {
    expect(sanitizeProbeTestResult({ value: Number.NaN, verdict: "healthy", latency_ms: -5, body: "x" })).toEqual({
      value: null,
      verdict: "no_data",
      latency_ms: 0,
      reason: "no_data",
    });
    expect(sanitizeProbeTestResult({ value: 3, verdict: "weird", latency_ms: 12.6, reason: null })).toEqual({
      value: 3,
      verdict: "no_data",
      latency_ms: 13,
      reason: "no_data",
    });
    expect(sanitizeProbeTestResult(null).verdict).toBe("no_data");
  });
});

describe("cloudwatch_list_metrics handler", () => {
  it("maps AWS dimension keys to lowercase and passes failures as codes", async () => {
    const ok = createCloudwatchListMetricsHandler(async () => ({
      ok: true,
      truncated: false,
      metrics: [{ metric_name: "CPUUtilization", dimensions: [{ Name: "DBInstanceIdentifier", Value: "db1" }] }],
    }));
    expect(await ok({ id: "c1", kind: "cloudwatch_list_metrics", payload: { region: "us-east-1" } })).toEqual({
      ok: true,
      result: { metrics: [{ metric_name: "CPUUtilization", dimensions: [{ name: "DBInstanceIdentifier", value: "db1" }] }], truncated: false },
    });
    const bad = createCloudwatchListMetricsHandler(async () => ({ ok: false, reason: "access_denied" }));
    expect(await bad({ id: "c2", kind: "cloudwatch_list_metrics", payload: { region: "us-east-1" } })).toEqual({ ok: false, error: "access_denied" });
    expect(await bad({ id: "c3", kind: "cloudwatch_list_metrics", payload: { region: "US EAST" } })).toEqual({ ok: false, error: "invalid_region" });
  });
});
