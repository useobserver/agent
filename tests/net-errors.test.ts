import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import {
  NET_REASON_CODES,
  classifyFetchError,
  classifyNetError,
  normaliseNetCode,
} from "../src/sources/net-errors";
import { execute as httpExecute } from "../src/sources/http";
import { execute as dnsExecute } from "../src/sources/dns";

// Network error normalisation. Bun's fetch reports a refused port AND an
// NXDOMAIN host as code "ConnectionRefused"; node:net / node:dns report
// Node / c-ares codes. Every source must end up on the same stable set.

const REASON_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

describe("normaliseNetCode", () => {
  it("maps Bun's socket error names onto Node errno codes", () => {
    expect(normaliseNetCode("ConnectionRefused", "x")).toBe("ECONNREFUSED");
    expect(normaliseNetCode("ConnectionClosed", "x")).toBe("ECONNRESET");
    expect(normaliseNetCode("ConnectionResetByPeer", "x")).toBe("ECONNRESET");
    expect(normaliseNetCode("BrokenPipe", "x")).toBe("ECONNRESET");
    expect(normaliseNetCode("ConnectionTimedOut", "x")).toBe("ETIMEDOUT");
    expect(normaliseNetCode("FailedToOpenSocket", "x")).toBe("connect_failed");
  });

  it("folds Node / c-ares variants", () => {
    expect(normaliseNetCode("ETIMEOUT", "x")).toBe("ETIMEDOUT");
    expect(normaliseNetCode("ECONNABORTED", "x")).toBe("ETIMEDOUT");
    expect(normaliseNetCode("ENETUNREACH", "x")).toBe("EHOSTUNREACH");
    expect(normaliseNetCode("EAI_NONAME", "x")).toBe("ENOTFOUND");
    expect(normaliseNetCode("EPIPE", "x")).toBe("ECONNRESET");
  });

  it("passes known TLS codes and collapses the rest", () => {
    expect(normaliseNetCode("CERT_HAS_EXPIRED", "x")).toBe("CERT_HAS_EXPIRED");
    expect(normaliseNetCode("ERR_TLS_CERT_ALTNAME_INVALID", "x")).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(normaliseNetCode("ERR_SSL_WRONG_VERSION_NUMBER", "x")).toBe("tls_handshake_failed");
    expect(normaliseNetCode("ERR_TLS_HANDSHAKE_TIMEOUT", "x")).toBe("tls_handshake_failed");
  });

  it("returns the fallback for unknown or missing codes", () => {
    expect(normaliseNetCode("ESOMETHINGNEW", "http_error")).toBe("http_error");
    expect(normaliseNetCode(undefined, "dns_error")).toBe("dns_error");
  });
});

describe("classifyNetError", () => {
  it("treats Abort / Timeout errors as ETIMEDOUT (Bun's TimeoutError has a numeric code)", () => {
    expect(classifyNetError({ name: "AbortError" }, "x").reason).toBe("ETIMEDOUT");
    expect(classifyNetError({ name: "TimeoutError", code: 23 }, "x").reason).toBe("ETIMEDOUT");
  });
  it("ignores non-string codes and never reads the message", () => {
    const c = classifyNetError({ code: 23, message: "connect to https://user:pw@x" }, "http_error");
    expect(c.reason).toBe("http_error");
    expect(c.raw).toBeUndefined();
  });
  it("prefers cause.code", () => {
    expect(classifyNetError({ code: "X", cause: { code: "ECONNRESET" } }, "f").reason).toBe("ECONNRESET");
  });
  it("flags Bun's ambiguous connect codes", () => {
    expect(classifyNetError({ code: "ConnectionRefused" }, "f").ambiguousConnect).toBe(true);
    expect(classifyNetError({ code: "ECONNREFUSED" }, "f").ambiguousConnect).toBe(false);
  });
  it("every possible output is in NET_REASON_CODES or the fallback, and matches the wire regex", () => {
    const inputs = [
      "ConnectionRefused", "ConnectionFailed", "FailedToOpenSocket", "ConnectionClosed", "ConnectionResetByPeer",
      "BrokenPipe", "ConnectionTimedOut", "ConnectionTimeout", "Timeout", "EPIPE", "ECONNABORTED", "ESOCKETTIMEDOUT",
      "ENETUNREACH", "ENETDOWN", "EHOSTDOWN", "EADDRNOTAVAIL", "EAI_NONAME", "EAI_NODATA", "EAI_FAIL", "ETIMEOUT",
      "ENOTINITIALIZED", "CERT_UNTRUSTED", "UNABLE_TO_GET_ISSUER_CERT", "CERT_REVOKED", "CERT_SIGNATURE_FAILURE",
      "HOSTNAME_MISMATCH", "ERR_SSL_X", "ERR_TLS_Y", "SOME_CERT_THING", "EWHATEVER", ...NET_REASON_CODES,
    ];
    for (const code of inputs) {
      const r = classifyNetError({ code }, "FALLBACK").reason;
      expect(r === "FALLBACK" || (NET_REASON_CODES as readonly string[]).includes(r), code).toBe(true);
      expect(r).toMatch(REASON_RE);
    }
  });
});

describe("classifyFetchError", () => {
  const refused = { code: "ConnectionRefused" };
  it("an ambiguous refusal on a name that does not resolve becomes ENOTFOUND", async () => {
    const lookup = () => Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" }));
    expect((await classifyFetchError(refused, "http://nope.invalid/", "http_error", lookup)).reason).toBe("ENOTFOUND");
  });
  it("a transient resolver failure stays EAI_AGAIN", async () => {
    const lookup = () => Promise.reject(Object.assign(new Error("x"), { code: "EAI_AGAIN" }));
    expect((await classifyFetchError(refused, "http://flaky.example/", "http_error", lookup)).reason).toBe("EAI_AGAIN");
  });
  it("an ambiguous refusal on a name that resolves is ECONNREFUSED", async () => {
    const lookup = () => Promise.resolve({ address: "203.0.113.1", family: 4 });
    expect((await classifyFetchError(refused, "http://up.example/", "http_error", lookup)).reason).toBe("ECONNREFUSED");
  });
  it("IP literals skip the lookup", async () => {
    let called = false;
    const lookup = () => {
      called = true;
      return Promise.resolve({});
    };
    expect((await classifyFetchError(refused, "http://127.0.0.1:1/", "http_error", lookup)).reason).toBe("ECONNREFUSED");
    expect((await classifyFetchError(refused, "http://[::1]:1/", "http_error", lookup)).reason).toBe("ECONNREFUSED");
    expect(called).toBe(false);
  });
});

// End to end against the real runtime: the codes Bun actually produces.
describe("sources on the real runtime", () => {
  let server;
  let resetPort;
  beforeAll(async () => {
    server = createServer((s) => (s.resetAndDestroy ? s.resetAndDestroy() : s.destroy()));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    resetPort = server.address().port;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it("http: refused port -> ECONNREFUSED (not Bun's ConnectionRefused)", async () => {
    const r = await httpExecute({ url: "http://127.0.0.1:1/", timeout_ms: 2_000 });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("ECONNREFUSED");
  });

  it("http: NXDOMAIN -> ENOTFOUND (Bun reports it as ConnectionRefused)", async () => {
    const r = await httpExecute({ url: "http://no-such-host-obs.invalid/", timeout_ms: 4_000 });
    expect(r.status_hint).toBe("no_data");
    expect(["ENOTFOUND", "EAI_AGAIN"]).toContain(r.reason);
  }, 8_000);

  it("http: reset by peer -> ECONNRESET", async () => {
    const r = await httpExecute({ url: `http://127.0.0.1:${resetPort}/`, timeout_ms: 2_000 });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("ECONNRESET");
  });

  it("dns: NXDOMAIN reason is a code, never the error message", async () => {
    const r = await dnsExecute({ domain: "no-such-host-obs.invalid", timeout_ms: 3_000 });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toMatch(REASON_RE);
    expect(r.reason).not.toContain(" ");
  }, 8_000);
});
