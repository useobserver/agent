// WebSocket probe source tests.
//
// Real sockets against ephemeral Bun.serve / Bun.listen harnesses —
// no mocking. Each harness models one server behaviour:
//   echo            — opens, echoes "echo:<msg>" back
//   silent_ws       — opens, never replies to messages
//   close_on_open   — opens then immediately closes
//   raw_tcp         — accepts TCP, never speaks WebSocket (hangs the handshake)

import { afterAll, describe, expect, it } from "bun:test";
import ws from "../src/sources/websocket.ts";

const servers: Array<{ stop: () => void }> = [];

function echoServer() {
  const s = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response("expected websocket", { status: 426 });
    },
    websocket: {
      message(sock, msg) {
        sock.send(`echo:${msg}`);
      },
    },
  });
  servers.push(s);
  return `ws://localhost:${s.port}`;
}

function silentWsServer() {
  const s = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response("no", { status: 426 });
    },
    websocket: {
      message() {
        /* deliberately never reply */
      },
    },
  });
  servers.push(s);
  return `ws://localhost:${s.port}`;
}

function closeOnOpenServer() {
  const s = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response("no", { status: 426 });
    },
    websocket: {
      open(sock) {
        sock.close();
      },
      message() {},
    },
  });
  servers.push(s);
  return `ws://localhost:${s.port}`;
}

// Raw TCP listener that accepts the connection and stays silent, so
// the WebSocket upgrade never completes.
function rawTcpServer() {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {} },
  });
  servers.push({ stop: () => listener.stop() });
  return `ws://127.0.0.1:${listener.port}`;
}

// A port we open then immediately close, so connects are refused.
function deadUrl() {
  const s = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const url = `ws://localhost:${s.port}`;
  s.stop(true);
  return url;
}

afterAll(() => {
  for (const s of servers) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
});

describe("validateConfig", () => {
  it("accepts a wss url", () => {
    expect(ws.validateConfig({ url: "wss://example.test/socket" })).toBeNull();
  });
  it("rejects an http url", () => {
    expect(ws.validateConfig({ url: "https://example.test" })).not.toBeNull();
  });
  it("rejects round_trip_latency without a send_message", () => {
    expect(
      ws.validateConfig({ url: "ws://example.test", interpretation: "round_trip_latency" }),
    ).not.toBeNull();
  });
  it("accepts round_trip_latency with ping_mode + send_message", () => {
    expect(
      ws.validateConfig({
        url: "ws://example.test",
        interpretation: "round_trip_latency",
        ping_mode: "message",
        send_message: "ping",
      }),
    ).toBeNull();
  });
});

describe("execute — handshake_latency", () => {
  it("returns a numeric latency when the socket opens", async () => {
    const url = echoServer();
    const r = await ws.execute({ url, interpretation: "handshake_latency", ping_mode: "none", timeout_ms: 5000 });
    expect(r.status_hint).toBeUndefined();
    expect(typeof r.value).toBe("number");
    expect(r.value as number).toBeGreaterThanOrEqual(0);
  });

  it("times out as ws_handshake_timeout against a non-WebSocket TCP server", async () => {
    const url = rawTcpServer();
    const r = await ws.execute({ url, interpretation: "handshake_latency", ping_mode: "none", timeout_ms: 300 });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("ws_handshake_timeout");
  });
});

describe("execute — connection_success", () => {
  it("returns 1 when the socket opens", async () => {
    const url = echoServer();
    const r = await ws.execute({ url, interpretation: "connection_success", ping_mode: "none", timeout_ms: 5000 });
    expect(r.value).toBe(1);
    expect(r.status_hint).toBeUndefined();
  });

  it("returns 0 (never no_data) when the connection is refused", async () => {
    const url = deadUrl();
    const r = await ws.execute({ url, interpretation: "connection_success", ping_mode: "none", timeout_ms: 1000 });
    expect(r.value).toBe(0);
    expect(r.status_hint).toBeUndefined();
  });
});

describe("execute — round_trip_latency", () => {
  it("returns round-trip ms when the reply matches", async () => {
    const url = echoServer();
    const r = await ws.execute({
      url,
      interpretation: "round_trip_latency",
      ping_mode: "message",
      send_message: "ping",
      expect_message: "echo:ping",
      timeout_ms: 5000,
    });
    expect(r.status_hint).toBeUndefined();
    expect(typeof r.value).toBe("number");
    expect(r.value as number).toBeGreaterThanOrEqual(0);
  });

  it("reports ws_reply_mismatch when the reply doesn't contain expect_message", async () => {
    const url = echoServer();
    const r = await ws.execute({
      url,
      interpretation: "round_trip_latency",
      ping_mode: "message",
      send_message: "ping",
      expect_message: "NOPE",
      timeout_ms: 5000,
    });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("ws_reply_mismatch");
  });

  it("reports ws_reply_timeout when the server never replies", async () => {
    const url = silentWsServer();
    const r = await ws.execute({
      url,
      interpretation: "round_trip_latency",
      ping_mode: "message",
      send_message: "ping",
      timeout_ms: 400,
    });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("ws_reply_timeout");
  });

  it("reports ws_closed_early when the server closes before replying", async () => {
    const url = closeOnOpenServer();
    const r = await ws.execute({
      url,
      interpretation: "round_trip_latency",
      ping_mode: "message",
      send_message: "ping",
      timeout_ms: 2000,
    });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("ws_closed_early");
  });
});
