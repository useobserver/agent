// @ts-nocheck — test harness types are loose on purpose.
// Secret call metadata (metadata_refs) for the grpc source.
//
// metadata_refs maps a metadata key to an env var NAME on the agent host.
// The agent resolves the value at probe time, merges it over the inline
// metadata, and must:
//   1. send the resolved value to the server;
//   2. report no_data + metadata_ref_missing (never throw, never make the
//      call unauthenticated) when the env var is unset or blank;
//   3. reject a value grpc-js would refuse (metadata_ref_invalid);
//   4. never put the value in a result, a reason, metadata, or a log line.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as grpc from "@grpc/grpc-js";
import grpcSource from "../src/sources/grpc.ts";
import { resolveMetadataRefs } from "../src/sources/_header-refs.ts";

const SECRET = "Bearer s3cr3t-grpc-token-0123456789abcdef";
const ENV_NAME = "OBSERVER_TEST_GRPC_METADATA_SECRET";
const MISSING_ENV = "OBSERVER_TEST_GRPC_METADATA_UNSET";

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
  expect(JSON.stringify(result)).not.toContain("s3cr3t-grpc-token");
  for (const line of logged) expect(line).not.toContain("s3cr3t-grpc-token");
}

// ── minimal Health server (same wire as probe-grpc.test.ts) ─────────
const SERVICE_DEF = {
  check: {
    path: "/grpc.health.v1.Health/Check",
    requestStream: false,
    responseStream: false,
    requestSerialize: () => Buffer.alloc(0),
    requestDeserialize: () => ({ service: "" }),
    responseSerialize: (r) => (r.status ? Buffer.from([0x08, r.status]) : Buffer.alloc(0)),
    responseDeserialize: (b) => ({ status: b.length > 1 ? b[1] : 0 }),
  },
};

const servers = [];
// Records what metadata each call carried.
let seen: Record<string, unknown>[] = [];

function startServer(check?): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(SERVICE_DEF, {
      check:
        check ??
        ((call, cb) => {
          seen.push(call.metadata.getMap());
          cb(null, { status: call.metadata.get("authorization")[0] === SECRET ? 1 : 2 });
        }),
    });
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
  tls_mode: "plaintext",
  timeout_ms: 3000,
  interpretation: "health_state",
  ...extra,
});

describe("resolveMetadataRefs", () => {
  it("merges resolved refs over inline metadata, secret wins case-insensitively", () => {
    const r = resolveMetadataRefs(
      { "x-tenant": "acme", Authorization: "stale" },
      { authorization: ENV_NAME },
      { [ENV_NAME]: `  ${SECRET}\n` },
    );
    expect(r).toEqual({ ok: true, metadata: { "x-tenant": "acme", authorization: SECRET }, secretValues: [SECRET] });
  });

  it("unset or blank env var -> metadata_ref_missing naming key + ref only", () => {
    expect(resolveMetadataRefs(undefined, { authorization: MISSING_ENV }, {})).toEqual({
      ok: false,
      reason: "metadata_ref_missing",
      key: "authorization",
      ref: MISSING_ENV,
    });
    expect(resolveMetadataRefs(undefined, { authorization: ENV_NAME }, { [ENV_NAME]: "   " })).toMatchObject({
      reason: "metadata_ref_missing",
    });
  });

  it("non-printable-ASCII value -> metadata_ref_invalid", () => {
    for (const bad of ["Bearer a\nb", "Bearer a\tb", "Bearer café"]) {
      const r = resolveMetadataRefs(undefined, { authorization: ENV_NAME }, { [ENV_NAME]: bad });
      expect(r).toEqual({ ok: false, reason: "metadata_ref_invalid", key: "authorization", ref: ENV_NAME });
    }
  });
});

describe("grpc execute with metadata_refs", () => {
  it("sends the resolved secret and inline metadata to the server", async () => {
    seen = [];
    const port = await startServer();
    const r = await grpcSource.execute(
      cfg(port, { metadata: { "x-tenant": "acme" }, metadata_refs: { authorization: ENV_NAME } }),
    );
    expect(r.value).toBe(1);
    expect(seen[0]?.authorization).toBe(SECRET);
    expect(seen[0]?.["x-tenant"]).toBe("acme");
    expectNoLeak(r);
  });

  it("missing env var -> no_data metadata_ref_missing, no call is made, never throws", async () => {
    seen = [];
    const port = await startServer();
    const r = await grpcSource.execute(cfg(port, { metadata_refs: { authorization: MISSING_ENV } }));
    expect(r.value).toBeNull();
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("metadata_ref_missing");
    expect(r.metadata).toMatchObject({ metadata_key: "authorization", metadata_ref: MISSING_ENV });
    expect(seen).toHaveLength(0);
    expectNoLeak(r);
  });

  it("invalid value -> no_data metadata_ref_invalid without echoing the value", async () => {
    process.env[ENV_NAME] = `${SECRET}\ninjected: yes`;
    const r = await grpcSource.execute(cfg(59999, { metadata_refs: { authorization: ENV_NAME } }));
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("metadata_ref_invalid");
    expect(JSON.stringify(r)).not.toContain("injected");
    expectNoLeak(r);
  });

  it("server echoing the secret in its error detail does not leak it", async () => {
    const port = await startServer((call, cb) =>
      cb({ code: grpc.status.UNAUTHENTICATED, details: `rejected ${call.metadata.get("authorization")[0]}` }, null),
    );
    const r = await grpcSource.execute(cfg(port, { metadata_refs: { authorization: ENV_NAME } }));
    expect(r.reason).toBe("grpc_unauthenticated");
    expectNoLeak(r);
  });
});

describe("grpc validateConfig: metadata_refs rules", () => {
  const base = { host: "x", port: 50051 };
  it("accepts metadata_refs with an env var name", () => {
    expect(grpcSource.validateConfig({ ...base, metadata_refs: { authorization: "GRPC_TOKEN" } })).toBeNull();
  });
  it("rejects a secret-looking ref value (must be an env var NAME)", () => {
    expect(grpcSource.validateConfig({ ...base, metadata_refs: { authorization: "Bearer abc" } })).not.toBeNull();
  });
  it("rejects a key present in both metadata and metadata_refs", () => {
    const err = grpcSource.validateConfig({
      ...base,
      metadata: { "x-tenant": "acme" },
      metadata_refs: { "X-Tenant": "TENANT" },
    });
    expect(err).toContain("metadata_refs");
  });
  it("rejects reserved grpc- keys, binary -bin keys and illegal characters", () => {
    for (const key of ["grpc-timeout", "trace-bin", "bad key", "colon:key"]) {
      expect(grpcSource.validateConfig({ ...base, metadata_refs: { [key]: "SOME_ENV" } })).not.toBeNull();
      expect(grpcSource.validateConfig({ ...base, metadata: { [key]: "v" } })).not.toBeNull();
    }
  });
});
