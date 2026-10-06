// @ts-nocheck — matches the sibling suites; tighten test types per-file later.
//
// Heartbeat relay: local route parsing (same URLs as the cloud's public ping
// URL), body cap, local rate limit, enqueue -> ordered forward with a mocked
// transport, and token redaction in every log line.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuffer } from "../src/buffer";
import {
  createRelayForwarder,
  createRelayHandler,
  createRelayRateLimiter,
  readCappedBody,
  relayPathSegments,
  relayQueuePath,
  resolveRelayConfig,
  startRelayServer,
} from "../src/heartbeat-relay";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWx";
const TOKEN2 = "ZyXwVuTsRqPoNmLkJiHgFeDc";

function req(path, init = {}) {
  return new Request(`http://127.0.0.1:10102${path}`, init);
}

function harness(opts = {}) {
  const queued = [];
  const logs = [];
  const handler = createRelayHandler({
    enqueue: opts.enqueue ?? ((p) => queued.push(p)),
    rateLimiter: opts.rateLimiter,
    log: (level, message) => logs.push(`${level} ${message}`),
    now: opts.now ?? (() => Date.parse("2026-10-05T12:00:00.000Z")),
  });
  return { handler, queued, logs };
}

describe("relay config", () => {
  it("is off by default, loopback by default, port 10102", () => {
    const c = resolveRelayConfig({});
    expect(c.enabled).toBe(false);
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(10102);
    expect(c.queuePath).toBe("./observer-agent-buffer-relay.db");
  });

  it("honours the env and ignores a garbage port", () => {
    const c = resolveRelayConfig({
      HEARTBEAT_RELAY_ENABLED: "true",
      HEARTBEAT_RELAY_HOST: "0.0.0.0",
      HEARTBEAT_RELAY_PORT: "abc",
      BUFFER_PATH: "/data/agent.db",
    });
    expect(c).toMatchObject({ enabled: true, host: "0.0.0.0", port: 10102, queuePath: "/data/agent-relay.db" });
    expect(resolveRelayConfig({ HEARTBEAT_RELAY_PORT: "18080" }).port).toBe(18080);
    expect(resolveRelayConfig({ HEARTBEAT_RELAY_PORT: "70000" }).port).toBe(10102);
    expect(relayQueuePath("/var/lib/observer/buffer")).toBe("/var/lib/observer/buffer-relay.db");
  });
});

describe("relay routes", () => {
  it("accepts /heartbeat/<token> and the cloud's /api/heartbeat/<token>", () => {
    expect(relayPathSegments(`/heartbeat/${TOKEN}`)).toEqual([TOKEN]);
    expect(relayPathSegments(`/api/heartbeat/${TOKEN}/fail`)).toEqual([TOKEN, "fail"]);
    expect(relayPathSegments(`/other/${TOKEN}`)).toBeNull();
  });

  it("queues success / start / fail / exit codes like the cloud parses them, 202 at once", async () => {
    const { handler, queued } = harness();
    const cases = [
      [`/heartbeat/${TOKEN}`, { kind: "success", exit_code: null }],
      [`/heartbeat/${TOKEN}/start`, { kind: "start", exit_code: null }],
      [`/heartbeat/${TOKEN}/fail`, { kind: "fail", exit_code: null }],
      [`/heartbeat/${TOKEN}/0`, { kind: "success", exit_code: 0 }],
      [`/heartbeat/${TOKEN}/2`, { kind: "fail", exit_code: 2 }],
      [`/heartbeat/${TOKEN}?exit=3`, { kind: "fail", exit_code: 3 }],
      [`/heartbeat/${TOKEN}/fail?exit=0`, { kind: "fail", exit_code: 0 }],
    ];
    for (const [path, want] of cases) {
      const res = await handler.handle(req(path));
      expect(res.status).toBe(202);
      expect(await res.text()).toBe("Accepted\n");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(queued.at(-1)).toMatchObject({ token: TOKEN, ...want, received_at: "2026-10-05T12:00:00.000Z" });
    }
    expect(queued).toHaveLength(cases.length);
  });

  it("GET, POST and HEAD are accepted; HEAD has no body; other methods are 405", async () => {
    const { handler, queued } = harness();
    expect((await handler.handle(req(`/heartbeat/${TOKEN}`, { method: "POST", body: "done" }))).status).toBe(202);
    expect(queued.at(-1).body).toBe("done");
    const head = await handler.handle(req(`/heartbeat/${TOKEN}`, { method: "HEAD" }));
    expect(head.status).toBe(202);
    expect(await head.text()).toBe("");
    const put = await handler.handle(req(`/heartbeat/${TOKEN}`, { method: "PUT", body: "x" }));
    expect(put.status).toBe(405);
    expect(put.headers.get("allow")).toBe("GET, POST, HEAD");
    expect(queued).toHaveLength(2);
  });

  it("rejects malformed tokens, bad exit codes and unknown paths without queueing", async () => {
    const { handler, queued } = harness();
    expect((await handler.handle(req("/heartbeat/short"))).status).toBe(404);
    expect((await handler.handle(req("/heartbeat/has-dash-aaaaaaaaaaaaaaaaaaa"))).status).toBe(404);
    expect((await handler.handle(req(`/heartbeat/${TOKEN}/nope`))).status).toBe(404);
    expect((await handler.handle(req(`/heartbeat/${TOKEN}?exit=999`))).status).toBe(400);
    expect((await handler.handle(req(`/heartbeat/${TOKEN}/start?exit=1`))).status).toBe(400);
    expect((await handler.handle(req(`/heartbeat/${TOKEN}/a/b`))).status).toBe(404);
    expect((await handler.handle(req("/"))).status).toBe(404);
    expect(queued).toHaveLength(0);
    expect(handler.stats().rejected_invalid).toBe(6);
  });

  it("healthz answers ok", async () => {
    const { handler } = harness();
    const res = await handler.handle(req("/healthz"));
    expect(res.status).toBe(200);
  });

  it("caps the body at 10 KB, strips NUL, ignores GET bodies and blank bodies", async () => {
    const big = "x".repeat(50_000);
    expect((await readCappedBody(req("/", { method: "POST", body: big })))?.length).toBe(10 * 1024);
    expect(await readCappedBody(req("/"))).toBeNull();
    expect(await readCappedBody(req("/", { method: "POST", body: "  \n" }))).toBeNull();
    expect(await readCappedBody(req("/", { method: "POST", body: "a\u0000b" }))).toBe("ab");

    const { handler, queued } = harness();
    await handler.handle(req(`/heartbeat/${TOKEN}/fail`, { method: "POST", body: big }));
    expect(queued[0].body.length).toBe(10 * 1024);
  });

  it("truncates the forwarded user agent", async () => {
    const { handler, queued } = harness();
    await handler.handle(req(`/heartbeat/${TOKEN}`, { headers: { "user-agent": "u".repeat(1000) } }));
    expect(queued[0].user_agent.length).toBe(256);
  });

  it("answers 503 when the queue cannot take the ping", async () => {
    const { handler, logs } = harness({
      enqueue: () => {
        throw new Error("SQLITE_FULL");
      },
    });
    const res = await handler.handle(req(`/heartbeat/${TOKEN}`));
    expect(res.status).toBe(503);
    expect(handler.stats().enqueue_failures).toBe(1);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
});

describe("relay rate limit", () => {
  it("limits per token and overall per minute, then resets", async () => {
    let t = 0;
    const limiter = createRelayRateLimiter({ perTokenPerMinute: 2, globalPerMinute: 3, now: () => t });
    expect(limiter.allow(TOKEN)).toBe(true);
    expect(limiter.allow(TOKEN)).toBe(true);
    expect(limiter.allow(TOKEN)).toBe(false); // per token
    expect(limiter.allow(TOKEN2)).toBe(true);
    expect(limiter.allow(TOKEN2)).toBe(false); // global (3)
    t += 60_000;
    expect(limiter.allow(TOKEN)).toBe(true);
  });

  it("returns 429 with Retry-After and logs a redacted token once a minute", async () => {
    const limiter = createRelayRateLimiter({ perTokenPerMinute: 1, now: () => 0 });
    const { handler, queued, logs } = harness({ rateLimiter: limiter, now: () => 0 });
    expect((await handler.handle(req(`/heartbeat/${TOKEN}`))).status).toBe(202);
    const limited = await handler.handle(req(`/heartbeat/${TOKEN}`));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await handler.handle(req(`/heartbeat/${TOKEN}`));
    expect(queued).toHaveLength(1);
    expect(handler.stats().rejected_rate_limited).toBe(2);
    const warns = logs.filter((l) => l.startsWith("WARN"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("AbCd…");
  });
});

describe("token redaction", () => {
  it("never logs a full token on any path", async () => {
    const limiter = createRelayRateLimiter({ perTokenPerMinute: 1, now: () => 0 });
    const { handler, logs } = harness({ rateLimiter: limiter, now: () => 0 });
    await handler.handle(req(`/heartbeat/${TOKEN}`));
    await handler.handle(req(`/heartbeat/${TOKEN}/fail`, { method: "POST", body: "boom" }));
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain(TOKEN);
    expect(logs.join("\n")).toContain("AbCd…");
  });
});

describe("enqueue and forward", () => {
  let dir;
  let buf;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "obs-relay-test-"));
    buf = createBuffer(join(dir, "relay.db"), { maxRows: 100 });
  });
  afterEach(() => {
    try {
      buf.close();
    } catch {
      /* closed */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("forwards queued pings in order with received_at preserved and sent_at stamped", async () => {
    let t = Date.parse("2026-10-05T12:00:00.000Z");
    const { handler } = harness({ enqueue: (p) => buf.enqueue(p), now: () => t });
    await handler.handle(req(`/heartbeat/${TOKEN}/start`));
    t += 5_000;
    await handler.handle(req(`/heartbeat/${TOKEN}`, { method: "POST", body: "ok" }));
    expect(buf.size()).toBe(2);

    const sent = [];
    const forwarder = createRelayForwarder({
      buffer: buf,
      now: () => Date.parse("2026-10-05T12:10:00.000Z"),
      send: async (batch) => {
        sent.push(batch);
        return { accepted: batch.pings.length, rejected: [] };
      },
    });
    const r = await forwarder.drainOnce();
    expect(r).toMatchObject({ acked: 2, paused: false });
    expect(buf.size()).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0].sent_at).toBe("2026-10-05T12:10:00.000Z");
    expect(sent[0].pings.map((p) => [p.kind, p.received_at, p.body])).toEqual([
      ["start", "2026-10-05T12:00:00.000Z", null],
      ["success", "2026-10-05T12:00:05.000Z", "ok"],
    ]);
  });

  it("keeps pings queued across a cloud outage and delivers them after", async () => {
    const { handler } = harness({ enqueue: (p) => buf.enqueue(p) });
    await handler.handle(req(`/heartbeat/${TOKEN}`));
    let down = true;
    const sent = [];
    const forwarder = createRelayForwarder({
      buffer: buf,
      send: async (batch) => {
        if (down) {
          const e = new Error("HTTP 503");
          e.status = 503;
          throw e;
        }
        sent.push(batch);
        return { accepted: batch.pings.length, rejected: [] };
      },
    });
    expect((await forwarder.drainOnce()).paused).toBe(true);
    expect(buf.size()).toBe(1);
    down = false;
    expect((await forwarder.drainOnce()).acked).toBe(1);
    expect(sent[0].pings[0].token).toBe(TOKEN);
    expect(buf.size()).toBe(0);
  });

  it("drops rows the cloud rejects per index, with a redacted log", async () => {
    const { handler } = harness({ enqueue: (p) => buf.enqueue(p) });
    await handler.handle(req(`/heartbeat/${TOKEN}`));
    await handler.handle(req(`/heartbeat/${TOKEN2}`));
    const logs = [];
    const forwarder = createRelayForwarder({
      buffer: buf,
      log: (level, m) => logs.push(`${level} ${m}`),
      send: async () => ({ accepted: 1, rejected: [{ index: 1, code: "not_found" }] }),
    });
    const r = await forwarder.drainOnce();
    expect(r).toMatchObject({ acked: 1, dropped: 1 });
    expect(buf.size()).toBe(0);
    expect(logs.join("\n")).toContain("not_found");
    for (const l of logs) {
      expect(l).not.toContain(TOKEN);
      expect(l).not.toContain(TOKEN2);
    }
  });

  it("batches at most 25 pings per request", async () => {
    for (let i = 0; i < 60; i++) buf.enqueue({ token: TOKEN, kind: "success", exit_code: null, body: null, received_at: new Date().toISOString() });
    const sizes = [];
    const forwarder = createRelayForwarder({
      buffer: buf,
      send: async (batch) => {
        sizes.push(batch.pings.length);
        return { accepted: batch.pings.length, rejected: [] };
      },
    });
    await forwarder.drainOnce();
    expect(sizes).toEqual([25, 25, 10]);
  });
});

describe("relay listener", () => {
  it("serves the handler over HTTP on the configured address", async () => {
    const { handler, queued } = harness();
    const server = startRelayServer({ host: "127.0.0.1", port: 0 }, handler.handle);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/heartbeat/${TOKEN}/fail`, { method: "POST", body: "exit 1" });
      expect(res.status).toBe(202);
      expect(queued[0]).toMatchObject({ kind: "fail", body: "exit 1" });
    } finally {
      server.stop();
    }
  });
});
