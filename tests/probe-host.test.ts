// @ts-nocheck — Phase D follow-up: tighten test types per-file.
import { describe, expect, it } from "bun:test";
import { execute, validateConfig } from "../src/sources/host";

// Host-metrics probe runtime (OBS-107). The agent produces these from the
// host it runs on — no external target/credentials. Linux is first-class
// (/proc); other platforms fall back to the `os` module where meaningful
// and return no_data with a typed reason otherwise. The probe never throws.

const isLinux = process.platform === "linux";

describe("validateConfig", () => {
  it("requires a known metric", () => {
    expect(validateConfig({})).toBeTruthy();
    expect(validateConfig({ metric: "nope" })).toBeTruthy();
  });
  it("accepts each supported metric", () => {
    for (const metric of ["cpu", "memory", "filesystem", "network", "load"]) {
      expect(validateConfig({ metric })).toBeNull();
    }
  });
  it("rejects unknown keys (strict schema)", () => {
    expect(validateConfig({ metric: "cpu", bogus: 1 })).toBeTruthy();
  });
  it("accepts mountpoint for filesystem and iface for network", () => {
    expect(validateConfig({ metric: "filesystem", mountpoint: "/var" })).toBeNull();
    expect(validateConfig({ metric: "network", iface: "eth0" })).toBeNull();
  });
});

describe("execute — never throws, returns a numeric value or typed no_data", () => {
  it("memory: usable percentage on every platform", async () => {
    const r = await execute({ metric: "memory" });
    expect(r.status_hint).toBeUndefined();
    expect(typeof r.value).toBe("number");
    expect(r.value).toBeGreaterThanOrEqual(0);
    expect(r.value).toBeLessThanOrEqual(100);
  });

  it("filesystem: percentage for the root mount", async () => {
    const r = await execute({ metric: "filesystem", mountpoint: "/" });
    expect(r.value).toBeGreaterThanOrEqual(0);
    expect(r.value).toBeLessThanOrEqual(100);
  });

  it("filesystem: unreadable mount → no_data, not a throw", async () => {
    const r = await execute({ metric: "filesystem", mountpoint: "/no/such/mount/observer" });
    expect(r.value).toBeNull();
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("host_filesystem_unavailable");
  });

  it("load: per-core average is non-negative", async () => {
    const r = await execute({ metric: "load" });
    // win32 reports [0,0,0] for loadavg → unsupported; elsewhere a number.
    if (process.platform === "win32") {
      expect(r.status_hint).toBe("no_data");
      expect(r.reason).toBe("host_metric_unsupported_platform");
    } else {
      expect(typeof r.value).toBe("number");
      expect(r.value).toBeGreaterThanOrEqual(0);
    }
  });

  it("network: Linux-only — non-Linux surfaces unsupported_platform", async () => {
    const r = await execute({ metric: "network" });
    if (isLinux) {
      // value may be a number or host_network_unavailable depending on env;
      // either way it must be well-formed and never throw.
      if (r.status_hint) expect(r.reason).toMatch(/host_network/);
      else expect(typeof r.value).toBe("number");
    } else {
      expect(r.status_hint).toBe("no_data");
      expect(r.reason).toBe("host_metric_unsupported_platform");
    }
  });

  it("cpu: returns a percentage or a typed no_data (never a wrong number)", async () => {
    const r = await execute({ metric: "cpu" });
    if (r.status_hint) {
      expect(r.reason).toBe("host_cpu_unavailable");
      expect(r.value).toBeNull();
    } else {
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThanOrEqual(100);
    }
  });

  it("every result carries an ISO timestamp", async () => {
    const r = await execute({ metric: "memory" });
    expect(() => new Date(r.timestamp).toISOString()).not.toThrow();
  });
});
