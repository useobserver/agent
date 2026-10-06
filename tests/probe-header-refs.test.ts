// @ts-nocheck — test harness types are loose on purpose.
// Secret headers (header_refs) for the http + websocket sources.
//
// header_refs maps a header name to an env var NAME on the agent host.
// The agent resolves the value at probe time, merges it over the inline
// headers, and must:
//   1. send the resolved value to the target;
//   2. report no_data + header_ref_missing (never throw, never send the
//      request unauthenticated) when the env var is unset or blank;
//   3. reject a value with control characters (header_ref_invalid);
//   4. never put the value in a result, a reason, metadata, or a log line;
//   5. drop the merged headers on a cross-origin redirect hop.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import http from "../src/sources/http.ts";
import ws from "../src/sources/websocket.ts";
import sources from "../src/sources/index";
import { redactSecrets, resolveHeaderRefs } from "../src/sources/_header-refs.ts";

const SECRET = "s3cr3t-token-value-0123456789abcdef";
const ENV_NAME = "OBSERVER_TEST_HEADER_SECRET";
const MISSING_ENV = "OBSERVER_TEST_HEADER_SECRET_UNSET";

// Capture everything written to the console while a probe runs.
let logged: string[] = [];
const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
beforeEach(() => {
  logged = [];
  for (const k of Object.keys(originals)) {
    console[k] = (...args) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
  process.env[ENV_NAME] = SECRET;
  delete process.env[MISSING_ENV];
});
afterEach(() => {
  for (const [k, fn] of Object.entries(originals)) console[k] = fn;
  delete process.env[ENV_NAME];
});

function expectNoLeak(result) {
  expect(JSON.stringify(result)).not.toContain(SECRET);
  for (const line of logged) expect(line).not.toContain(SECRET);
}

// ── HTTP harness ────────────────────────────────────────────────────
// serverA: /echo returns the received auth headers as JSON;
//          /same redirects to serverA /echo (same origin);
//          /cross redirects to serverB /echo (different port = different origin).
// serverB: /echo returns the received auth headers as JSON.
let serverA;
let serverB;
let baseA;
let baseB;

function echoHandler(req, res) {
  if (req.url === "/echo") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        authorization: req.headers["authorization"] ?? null,
        x_tenant: req.headers["x-tenant"] ?? null,
      }),
    );
    return true;
  }
  return false;
}

beforeAll(async () => {
  serverB = createServer((req, res) => {
    if (echoHandler(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => serverB.listen(0, "127.0.0.1", r));
  baseB = `http://127.0.0.1:${serverB.address().port}`;

  serverA = createServer((req, res) => {
    if (echoHandler(req, res)) return;
    if (req.url === "/same") {
      res.writeHead(302, { location: "/echo" });
      res.end();
      return;
    }
    if (req.url === "/cross") {
      res.writeHead(302, { location: `${baseB}/echo` });
      res.end();
      return;
    }
    if (req.url === "/require-auth") {
      const ok = req.headers["authorization"] === `Bearer ${SECRET}`;
      res.writeHead(ok ? 200 : 401);
      res.end(ok ? "ok" : "no");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => serverA.listen(0, "127.0.0.1", r));
  baseA = `http://127.0.0.1:${serverA.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => serverA.close(r));
  await new Promise((r) => serverB.close(r));
});

describe("resolveHeaderRefs", () => {
  it("merges resolved refs over inline headers, secret wins case-insensitively", () => {
    const r = resolveHeaderRefs({ "X-Tenant": "acme", authorization: "stale" }, { Authorization: ENV_NAME }, {
      [ENV_NAME]: `Bearer ${SECRET}\n`,
    });
    expect(r.ok).toBe(true);
    expect(r.headers).toEqual({ "X-Tenant": "acme", Authorization: `Bearer ${SECRET}` });
    expect(r.secretValues).toEqual([`Bearer ${SECRET}`]);
  });

  it("reports header_ref_missing for an unset or blank env var", () => {
    expect(resolveHeaderRefs({}, { Authorization: MISSING_ENV }, {})).toEqual({
      ok: false,
      reason: "header_ref_missing",
      header: "Authorization",
      ref: MISSING_ENV,
    });
    expect(resolveHeaderRefs({}, { Authorization: ENV_NAME }, { [ENV_NAME]: "   " }).reason).toBe(
      "header_ref_missing",
    );
  });

  it("reports header_ref_invalid for a value with embedded CR/LF", () => {
    const r = resolveHeaderRefs({}, { Authorization: ENV_NAME }, { [ENV_NAME]: "a\r\nInjected: 1" });
    expect(r).toEqual({ ok: false, reason: "header_ref_invalid", header: "Authorization", ref: ENV_NAME });
  });

  it("redactSecrets scrubs every occurrence", () => {
    expect(redactSecrets(`bad ${SECRET} and ${SECRET}`, [SECRET])).toBe("bad [redacted] and [redacted]");
  });
});

describe("http source — header_refs", () => {
  it("accepts header_refs in validateConfig and rejects a credential-looking inline header", () => {
    expect(http.validateConfig({ url: `${baseA}/echo`, header_refs: { Authorization: ENV_NAME } })).toBeNull();
    const err = http.validateConfig({ url: `${baseA}/echo`, headers: { Authorization: `Bearer ${SECRET}` } });
    expect(err).toMatch(/headers\.Authorization: Header "Authorization" looks like a credential/);
    expect(err).not.toContain(SECRET);
  });

  it("sends the resolved value and keeps inline headers", async () => {
    process.env[ENV_NAME] = `Bearer ${SECRET}`;
    const r = await http.execute({
      url: `${baseA}/echo`,
      headers: { "X-Tenant": "acme" },
      header_refs: { Authorization: ENV_NAME },
      // The endpoint echoes the headers it received; body_match proves both arrived.
      body_match: `{"authorization":"Bearer ${SECRET}","x_tenant":"acme"}`,
    });
    expect(r.status_hint).toBeUndefined();
    expect(r.metadata?.status).toBe(200);
    expectNoLeak(r);
  });

  it("authenticates against an endpoint that requires the secret", async () => {
    process.env[ENV_NAME] = `Bearer ${SECRET}`;
    const r = await http.execute({ url: `${baseA}/require-auth`, header_refs: { Authorization: ENV_NAME } });
    expect(r.status_hint).toBeUndefined();
    expect(r.metadata?.status).toBe(200);
    expectNoLeak(r);
  });

  it("missing env var -> no_data header_ref_missing, request never sent", async () => {
    const r = await http.execute({ url: `${baseA}/require-auth`, header_refs: { Authorization: MISSING_ENV } });
    expect(r.value).toBeNull();
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("header_ref_missing");
    expect(r.metadata).toEqual({ header: "Authorization", header_ref: MISSING_ENV });
  });

  it("invalid secret value -> no_data header_ref_invalid without echoing it", async () => {
    process.env[ENV_NAME] = `${SECRET}\r\nX-Evil: 1`;
    const r = await http.execute({ url: `${baseA}/echo`, header_refs: { Authorization: ENV_NAME } });
    expect(r.reason).toBe("header_ref_invalid");
    expectNoLeak(r);
  });

  it("keeps the merged headers on a same-origin redirect", async () => {
    process.env[ENV_NAME] = `Bearer ${SECRET}`;
    const r = await http.execute({
      url: `${baseA}/same`,
      headers: { "X-Tenant": "acme" },
      header_refs: { Authorization: ENV_NAME },
      body_match: `"authorization":"Bearer ${SECRET}"`,
    });
    expect(r.status_hint).toBeUndefined();
    expect(r.metadata?.status).toBe(200);
  });

  it("strips inline AND secret headers on a cross-origin redirect", async () => {
    process.env[ENV_NAME] = `Bearer ${SECRET}`;
    const r = await http.execute({
      url: `${baseA}/cross`,
      headers: { "X-Tenant": "acme" },
      header_refs: { Authorization: ENV_NAME },
      body_match: '{"authorization":null,"x_tenant":null}',
    });
    expect(r.status_hint).toBeUndefined();
    expect(r.metadata?.status).toBe(200);
    expectNoLeak(r);
  });

  it("network failure with a secret header never surfaces the value", async () => {
    process.env[ENV_NAME] = `Bearer ${SECRET}`;
    const r = await http.execute({
      url: "http://127.0.0.1:1/never-listens",
      timeout_ms: 500,
      header_refs: { Authorization: ENV_NAME },
    });
    expect(r.status_hint).toBe("no_data");
    expectNoLeak(r);
  });

  it("dispatcher: missing ref resolves to no_data, never throws", async () => {
    const r = await sources.execute({
      id: "m-header-refs",
      source_type: "http",
      source_config: { url: `${baseA}/echo`, header_refs: { Authorization: MISSING_ENV } },
    });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("header_ref_missing");
  });
});

// ── WebSocket harness ───────────────────────────────────────────────
const wsServers: Array<{ stop: () => void }> = [];
afterAll(() => {
  for (const s of wsServers) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
});

// Only upgrades when the handshake carries the expected Authorization;
// echoes back the header it saw so round-trip can assert on it.
function authWsServer() {
  const seen: Array<string | null> = [];
  const s = Bun.serve({
    port: 0,
    fetch(req, server) {
      const auth = req.headers.get("authorization");
      seen.push(auth);
      if (auth !== `Bearer ${SECRET}`) return new Response("unauthorized", { status: 401 });
      if (server.upgrade(req)) return undefined;
      return new Response("expected websocket", { status: 426 });
    },
    websocket: {
      message(sock, msg) {
        sock.send(`echo:${msg}`);
      },
    },
  });
  wsServers.push(s);
  return { url: `ws://localhost:${s.port}`, seen };
}

describe("websocket source — header_refs", () => {
  it("accepts header_refs in validateConfig and rejects a credential-looking inline header", () => {
    expect(ws.validateConfig({ url: "wss://example.test", header_refs: { Authorization: ENV_NAME } })).toBeNull();
    const err = ws.validateConfig({ url: "wss://example.test", headers: { "X-Session-Id": SECRET } });
    expect(err).toMatch(/headers\.X-Session-Id: Header "X-Session-Id" looks like a credential/);
    expect(err).not.toContain(SECRET);
  });

  it("sends the resolved secret on the handshake", async () => {
    process.env[ENV_NAME] = `Bearer ${SECRET}`;
    const { url, seen } = authWsServer();
    const r = await ws.execute({
      url,
      interpretation: "handshake_latency",
      ping_mode: "none",
      timeout_ms: 5000,
      header_refs: { Authorization: ENV_NAME },
    });
    expect(r.status_hint).toBeUndefined();
    expect(typeof r.value).toBe("number");
    expect(seen).toContain(`Bearer ${SECRET}`);
    expectNoLeak(r);
  });

  it("missing env var -> no_data header_ref_missing (even for connection_success)", async () => {
    const { url, seen } = authWsServer();
    const r = await ws.execute({
      url,
      interpretation: "connection_success",
      ping_mode: "none",
      timeout_ms: 2000,
      header_refs: { Authorization: MISSING_ENV },
    });
    expect(r.value).toBeNull();
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("header_ref_missing");
    expect(r.metadata?.header).toBe("Authorization");
    expect(r.metadata?.header_ref).toBe(MISSING_ENV);
    expect(seen).toHaveLength(0); // never connected
  });

  it("rejected handshake never echoes the secret into metadata", async () => {
    process.env[ENV_NAME] = "Bearer wrong-but-still-secret-value";
    const { url } = authWsServer();
    const r = await ws.execute({
      url,
      interpretation: "handshake_latency",
      ping_mode: "none",
      timeout_ms: 2000,
      header_refs: { Authorization: ENV_NAME },
    });
    expect(r.reason).toBe("ws_open_failed");
    expect(JSON.stringify(r)).not.toContain("wrong-but-still-secret-value");
    for (const line of logged) expect(line).not.toContain("wrong-but-still-secret-value");
  });
});
