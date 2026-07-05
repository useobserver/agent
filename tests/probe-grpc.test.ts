// gRPC health-check probe tests.
//
// Real @grpc/grpc-js Health servers on ephemeral ports — no mocking.
// The server-side codec mirrors the source's hand-rolled wire so the
// round trip exercises the actual serialize/deserialize paths.

import { afterAll, describe, expect, it } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import grpcSource from "../src/sources/grpc.ts";

// ── server-side protobuf codec (mirror of the source) ─────────────
function encodeVarint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}
function parseRequest(buf: Buffer): { service: string } {
  // field 1, wire 2 (string)
  if (buf.length === 0) return { service: "" };
  if (buf[0] !== 0x0a) return { service: "" };
  let i = 1;
  let len = 0;
  let shift = 0;
  while (i < buf.length) {
    const b = buf[i++];
    len |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { service: buf.slice(i, i + len).toString("utf8") };
}
function serializeResponse(resp: { status: number }): Buffer {
  if (!resp.status) return Buffer.alloc(0); // status 0 (UNKNOWN) => default
  // field 1, wire 0 (varint) = 0x08
  return Buffer.from([0x08, ...encodeVarint(resp.status)]);
}
function parseResponse(buf: Buffer): { status: number } {
  let status = 0;
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i++];
    if (tag === 0x08) {
      let shift = 0;
      let val = 0;
      while (i < buf.length) {
        const b = buf[i++];
        val |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      status = val;
    }
  }
  return { status };
}

const SERVICE_DEF = {
  check: {
    path: "/grpc.health.v1.Health/Check",
    requestStream: false,
    responseStream: false,
    requestSerialize: (r: { service: string }) =>
      r.service ? Buffer.from([0x0a, ...encodeVarint(Buffer.byteLength(r.service)), ...Buffer.from(r.service, "utf8")]) : Buffer.alloc(0),
    requestDeserialize: parseRequest,
    responseSerialize: serializeResponse,
    responseDeserialize: parseResponse,
  },
} as unknown as grpc.ServiceDefinition;

const servers: grpc.Server[] = [];

type CheckImpl = (call: grpc.ServerUnaryCall<{ service: string }, { status: number }>, cb: grpc.sendUnaryData<{ status: number }>) => void;

function startServer(check: CheckImpl): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(SERVICE_DEF, { check });
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) return reject(err);
      servers.push(server);
      resolve(port);
    });
  });
}

afterAll(() => {
  for (const s of servers) {
    try {
      s.forceShutdown();
    } catch {
      /* already down */
    }
  }
});

const cfg = (port: number, extra: Record<string, unknown> = {}) => ({
  host: "127.0.0.1",
  port,
  tls_mode: "plaintext" as const,
  timeout_ms: 3000,
  interpretation: "health_state" as const,
  ...extra,
});

describe("validateConfig", () => {
  it("accepts host + port", () => {
    expect(grpcSource.validateConfig({ host: "x", port: 50051 })).toBeNull();
  });
  it("rejects missing port", () => {
    expect(grpcSource.validateConfig({ host: "x" })).not.toBeNull();
  });
  it("rejects mtls mode without cert/key refs", () => {
    expect(grpcSource.validateConfig({ host: "x", port: 50051, tls_mode: "mtls" })).not.toBeNull();
  });
  it("accepts mtls mode with both refs", () => {
    expect(
      grpcSource.validateConfig({
        host: "x",
        port: 50051,
        tls_mode: "mtls",
        client_cert_ref: "OBSERVER_GRPC_CERT",
        client_key_ref: "OBSERVER_GRPC_KEY",
      }),
    ).toBeNull();
  });
});

describe("execute — health_state", () => {
  it("SERVING → 1", async () => {
    const port = await startServer((_c, cb) => cb(null, { status: 1 }));
    const r = await grpcSource.execute(cfg(port));
    expect(r.value).toBe(1);
    expect(r.status_hint).toBeUndefined();
  });
  it("NOT_SERVING → 0", async () => {
    const port = await startServer((_c, cb) => cb(null, { status: 2 }));
    const r = await grpcSource.execute(cfg(port));
    expect(r.value).toBe(0);
    expect(r.status_hint).toBeUndefined();
  });
  it("UNKNOWN → no_data grpc_health_unknown", async () => {
    const port = await startServer((_c, cb) => cb(null, { status: 0 }));
    const r = await grpcSource.execute(cfg(port));
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("grpc_health_unknown");
  });
  it("SERVICE_UNKNOWN status → no_data grpc_service_unknown", async () => {
    const port = await startServer((_c, cb) => cb(null, { status: 3 }));
    const r = await grpcSource.execute(cfg(port));
    expect(r.reason).toBe("grpc_service_unknown");
  });
  it("NOT_FOUND error → grpc_service_unknown", async () => {
    const port = await startServer((_c, cb) => cb({ code: grpc.status.NOT_FOUND, details: "unknown service" } as grpc.ServiceError, null));
    const r = await grpcSource.execute(cfg(port, { service: "nope" }));
    expect(r.reason).toBe("grpc_service_unknown");
  });
  it("UNIMPLEMENTED error → grpc_unimplemented", async () => {
    const port = await startServer((_c, cb) => cb({ code: grpc.status.UNIMPLEMENTED, details: "not implemented" } as grpc.ServiceError, null));
    const r = await grpcSource.execute(cfg(port));
    expect(r.reason).toBe("grpc_unimplemented");
  });
});

describe("execute — latency", () => {
  it("returns round-trip ms on a successful check regardless of serving status", async () => {
    const port = await startServer((_c, cb) => cb(null, { status: 2 }));
    const r = await grpcSource.execute(cfg(port, { interpretation: "latency" }));
    expect(r.status_hint).toBeUndefined();
    expect(typeof r.value).toBe("number");
    expect(r.value as number).toBeGreaterThanOrEqual(0);
  });
});

describe("execute — metadata (auth)", () => {
  it("forwards call metadata to the server", async () => {
    const port = await startServer((call, cb) => {
      const token = call.metadata.get("authorization")[0];
      cb(null, { status: token === "Bearer t0ken" ? 1 : 2 });
    });
    const r = await grpcSource.execute(cfg(port, { metadata: { authorization: "Bearer t0ken" } }));
    expect(r.value).toBe(1);
  });
});

describe("execute — invalid metadata never leaks the value", () => {
  it("newline in a metadata value → grpc_metadata_invalid with no token text anywhere", async () => {
    const SECRET = "Bearer sup3r-s3cret\ntoken";
    // No server needed: the metadata guard fires before any connection
    // is attempted (and before the client is even constructed).
    const r = await grpcSource.execute(cfg(59999, { metadata: { authorization: SECRET } }));
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("grpc_metadata_invalid");
    expect(r.value).toBeNull();
    const flat = JSON.stringify(r);
    expect(flat).not.toContain("sup3r-s3cret");
    expect(flat).not.toContain("illegal characters");
  });

  it("schema rejects metadata values with CR/LF/control characters", () => {
    expect(
      grpcSource.validateConfig({ host: "x", port: 50051, metadata: { authorization: "Bearer a\nb" } }),
    ).not.toBeNull();
    expect(
      grpcSource.validateConfig({ host: "x", port: 50051, metadata: { authorization: "Bearer a\rb" } }),
    ).not.toBeNull();
    expect(
      grpcSource.validateConfig({ host: "x", port: 50051, metadata: { authorization: "Bearer abc123" } }),
    ).toBeNull();
  });
});

describe("execute — no secret leakage on the error path", () => {
  it("does not surface the gRPC error detail (server-controlled text) in metadata", async () => {
    const SECRET = "Bearer s3cr3t-token";
    const port = await startServer((call, cb) =>
      // Server echoes the caller's metadata back in the status detail —
      // the probe must NOT persist that detail.
      cb({ code: grpc.status.UNAUTHENTICATED, details: `rejected ${call.metadata.get("authorization")[0]}` } as grpc.ServiceError, null),
    );
    const r = await grpcSource.execute(cfg(port, { metadata: { authorization: SECRET } }));
    expect(r.reason).toBe("grpc_unauthenticated");
    const meta = JSON.stringify(r.metadata ?? {});
    expect(meta).not.toContain(SECRET);
    expect(meta).not.toContain("rejected");
    expect((r.metadata as Record<string, unknown>)?.detail).toBeUndefined();
  });
});

describe("execute — failures never throw", () => {
  it("connection refused → no_data grpc_unavailable", async () => {
    // Bind then immediately shut down so the port refuses.
    const port = await startServer((_c, cb) => cb(null, { status: 1 }));
    servers.pop()?.forceShutdown();
    const r = await grpcSource.execute(cfg(port, { timeout_ms: 1500 }));
    expect(r.status_hint).toBe("no_data");
    expect(["grpc_unavailable", "grpc_timeout"]).toContain(r.reason);
    expect(r.value).toBeNull();
  });
  it("deadline exceeded → grpc_timeout", async () => {
    // Server holds the call open past the client deadline.
    const port = await startServer(() => {
      /* never calls cb */
    });
    const r = await grpcSource.execute(cfg(port, { timeout_ms: 300 }));
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("grpc_timeout");
  });
});
