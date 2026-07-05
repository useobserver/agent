import { describe, expect, it } from "bun:test";
import { execute, validateConfig } from "../src/sources/dns";

// DNS probe runtime.
//
// We don't spin up a fake DNS server here — that costs more than it
// buys for the negative path. We assert validateConfig + the error
// branch with a guaranteed-to-fail name. Positive resolution coverage
// will land alongside the integration tests once the agent has a
// container-level DNS fixture.

describe("validateConfig", () => {
  it("requires domain", () => {
    expect(validateConfig({})).toMatch(/domain/);
  });
  it("rejects unknown record_type", () => {
    expect(validateConfig({ domain: "example.test", record_type: "ANY" })).toMatch(/record_type/);
  });
  it("accepts default record type (A)", () => {
    expect(validateConfig({ domain: "example.test" })).toBeNull();
  });
});

describe("execute", () => {
  it("returns no_data with a code on a guaranteed NXDOMAIN-like name", async () => {
    // .invalid is a reserved TLD per RFC 2606. Any well-behaved
    // resolver returns NXDOMAIN for it.
    const r = await execute({ domain: "no-such-host-21-3.invalid" });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBeTruthy();
  }, 5_000);

  it("returns dns_resolver_invalid (not a throw) for a malformed resolver address", async () => {
    // setServers throws a synchronous TypeError on a non-IP resolver;
    // the source must absorb it into a typed no_data reason.
    const r = await execute({ domain: "example.com", resolver: "not-an-ip-address" });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("dns_resolver_invalid");
    expect(r.value).toBeNull();
  });

  it("bounds a blackholed resolver by timeout_ms instead of hanging", async () => {
    // 192.0.2.1 is TEST-NET-1 (RFC 5737) — guaranteed unroutable, so
    // the query blackholes and only the Resolver deadline can end it.
    const started = Date.now();
    const r = await execute({ domain: "example.com", resolver: "192.0.2.1", timeout_ms: 500 });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBeTruthy();
    // 2 tries × 500ms + slack; well under the previous OS-default hang.
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 6_000);
});
