// @ts-nocheck — Phase D follow-up: tighten test types per-file.
import { describe, expect, it } from "bun:test";
import { darwinUsedPct, execute, parseVmStat, validateConfig } from "../src/sources/host";

// Host-metrics probe runtime. The agent produces these from the
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

// macOS memory: vm_stat-based "Memory Used" (wired + active + compressed),
// not 1 - os.freemem()/total (which reads ~99% on any Mac).
const VM_STAT_FIXTURE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    56005.
Pages active:                                 217325.
Pages inactive:                               220309.
Pages speculative:                               228.
Pages throttled:                                   0.
Pages wired down:                             217391.
Pages purgeable:                                1813.
"Translation faults":                    22634640393.
Pages copy-on-write:                      2021429180.
Pages zero filled:                        6883519490.
Pages reactivated:                        4629939766.
Pages purged:                              255773201.
File-backed pages:                            181448.
Anonymous pages:                              256414.
Pages stored in compressor:                   658747.
Pages occupied by compressor:                 303867.
Decompressions:                           4542833757.
Compressions:                             4967504224.
Pageins:                                   680350651.
Pageouts:                                    3633286.
Swapins:                                   159888588.
Swapouts:                                  185015747.
`;

describe("parseVmStat / darwinUsedPct", () => {
  it("parses active, wired, compressor-occupied pages and the header page size", () => {
    expect(parseVmStat(VM_STAT_FIXTURE)).toEqual({
      pageSize: 16384,
      active: 217325,
      wired: 217391,
      // "occupied by", not "stored in": physical pages, not logical
      compressed: 303867,
    });
  });

  it("computes Activity Monitor's Memory Used over hw.memsize", () => {
    const pages = parseVmStat(VM_STAT_FIXTURE);
    const pct = darwinUsedPct(pages, 16384, 17179869184); // 16 GiB
    // (217325 + 217391 + 303867) * 16384 / 16 GiB = 70.44%
    expect(pct).toBeCloseTo(70.44, 1);
  });

  it("returns null when a required line is missing", () => {
    expect(parseVmStat("Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 1.\n")).toBeNull();
    expect(parseVmStat("")).toBeNull();
  });

  it("works without the page-size header (caller supplies hw.pagesize)", () => {
    const noHeader = VM_STAT_FIXTURE.split("\n").slice(1).join("\n");
    const pages = parseVmStat(noHeader);
    expect(pages.pageSize).toBeNull();
    expect(darwinUsedPct(pages, 16384, 17179869184)).toBeCloseTo(70.44, 1);
  });

  it("rejects a non-positive page size or total, and clamps to 100", () => {
    const pages = parseVmStat(VM_STAT_FIXTURE);
    expect(darwinUsedPct(pages, 0, 17179869184)).toBeNull();
    expect(darwinUsedPct(pages, 16384, 0)).toBeNull();
    expect(darwinUsedPct(pages, 16384, 1024)).toBe(100);
  });

  it.if(process.platform === "darwin")("memory on macOS returns a vm_stat percentage, not a throw", async () => {
    const r = await execute({ metric: "memory" });
    expect(typeof r.value).toBe("number");
    expect(r.value).toBeGreaterThan(0);
    expect(r.value).toBeLessThanOrEqual(100);
  });
});
