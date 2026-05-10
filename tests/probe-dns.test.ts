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
});
