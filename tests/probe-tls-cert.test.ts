import { describe, expect, it } from "bun:test";
import { execute, validateConfig } from "../src/sources/tls_cert";

// TLS certificate probe runtime.
//
// We do not generate a self-signed cert + spin up a tls server here.
// Doing so reliably across CI environments is more work than the
// signal it adds. We cover the validateConfig contract + the error
// branch (unreachable port). A real-cert smoke test runs in the
// integration suite against a known public host.

describe("validateConfig", () => {
  it("requires host", () => {
    expect(validateConfig({})).toMatch(/host/);
  });
  it("rejects port out of range", () => {
    expect(validateConfig({ host: "x", port: 0 })).toMatch(/port/);
    expect(validateConfig({ host: "x", port: 70_000 })).toMatch(/port/);
  });
  it("accepts host with default port", () => {
    expect(validateConfig({ host: "example.test" })).toBeNull();
  });
});

describe("execute", () => {
  it("returns no_data on connection failure (closed port)", async () => {
    const r = await execute({ host: "127.0.0.1", port: 1 });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBeTruthy();
    expect(r.value).toBeNull();
  }, 5_000);
});
