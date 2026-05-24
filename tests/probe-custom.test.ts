// custom probe registry + source tests.

import { afterEach, describe, expect, it } from "bun:test";
import {
  __resetCustomProbes,
  describeCustomProbes,
  getCustomProbe,
  listCustomProbes,
  registerCustomProbe,
} from "../src/sources/custom/registry.ts";
import customSource from "../src/sources/custom/index.ts";

afterEach(() => __resetCustomProbes());

describe("registry", () => {
  it("registers and looks up a probe", () => {
    registerCustomProbe({ name: "p1", run: () => 1 });
    expect(getCustomProbe("p1")).toBeDefined();
    expect(listCustomProbes()).toHaveLength(1);
  });
  it("throws on a duplicate name (fail fast at boot)", () => {
    registerCustomProbe({ name: "dup", run: () => 1 });
    expect(() => registerCustomProbe({ name: "dup", run: () => 2 })).toThrow(/already registered/);
  });
  it("rejects an empty name", () => {
    expect(() => registerCustomProbe({ name: "", run: () => 1 })).toThrow();
  });
  it("rejects a missing run()", () => {
    // @ts-expect-error — deliberately malformed
    expect(() => registerCustomProbe({ name: "x" })).toThrow();
  });
  it("describes probes for the heartbeat without serialising run()", () => {
    registerCustomProbe({ name: "a", description: "desc a", run: () => 1 });
    registerCustomProbe({ name: "b", configSchema: { safeParse: () => ({ success: true }) }, run: () => 2 });
    const d = describeCustomProbes();
    expect(d).toEqual([
      { name: "a", description: "desc a", has_config_schema: false },
      { name: "b", has_config_schema: true },
    ]);
    expect(JSON.stringify(d)).not.toContain("function");
  });
});

describe("custom source — validateConfig", () => {
  it("requires probe_name", () => {
    expect(customSource.validateConfig({})).not.toBeNull();
    expect(customSource.validateConfig({ probe_name: "x" })).toBeNull();
  });
  it("accepts an opaque probe_config", () => {
    expect(customSource.validateConfig({ probe_name: "x", probe_config: { a: 1, b: "two" } })).toBeNull();
  });
});

describe("custom source — execute", () => {
  it("not registered → custom_probe_not_found", async () => {
    const r = await customSource.execute({ probe_name: "missing" });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("custom_probe_not_found");
  });

  it("returns a bare number", async () => {
    registerCustomProbe({ name: "n", run: () => 42 });
    const r = await customSource.execute({ probe_name: "n" });
    expect(r.value).toBe(42);
    expect(r.status_hint).toBeUndefined();
  });

  it("returns { value, metadata }", async () => {
    registerCustomProbe({ name: "vm", run: () => ({ value: 7, metadata: { detail: "x" } }) });
    const r = await customSource.execute({ probe_name: "vm" });
    expect(r.value).toBe(7);
    expect((r.metadata as Record<string, unknown>).detail).toBe("x");
  });

  it("passes probe_config and env into run()", async () => {
    let seen: { config?: unknown; env?: unknown } = {};
    registerCustomProbe({
      name: "ctx",
      run: ({ config, env }) => {
        seen = { config, env };
        return 1;
      },
    });
    await customSource.execute({ probe_name: "ctx", probe_config: { threshold: 5 } }, { prometheusUrl: "http://x" });
    expect(seen.config).toEqual({ threshold: 5 });
    expect((seen.env as { prometheusUrl?: string }).prometheusUrl).toBe("http://x");
  });

  it("validates against the probe's configSchema → custom_probe_config_invalid", async () => {
    registerCustomProbe({
      name: "sch",
      configSchema: { safeParse: (v) => ((v as { ok?: boolean }).ok ? { success: true } : { success: false, error: { message: "needs ok:true" } }) },
      run: () => 1,
    });
    const bad = await customSource.execute({ probe_name: "sch", probe_config: {} });
    expect(bad.reason).toBe("custom_probe_config_invalid");
    expect((bad.metadata as Record<string, unknown>).error).toBe("needs ok:true");
    const ok = await customSource.execute({ probe_name: "sch", probe_config: { ok: true } });
    expect(ok.value).toBe(1);
  });

  it("a throwing probe → custom_probe_error, never crashes", async () => {
    registerCustomProbe({
      name: "boom",
      run: () => {
        throw new Error("kaboom");
      },
    });
    const r = await customSource.execute({ probe_name: "boom" });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("custom_probe_error");
    expect((r.metadata as Record<string, unknown>).error).toBe("kaboom");
  });

  it("a non-numeric return → custom_probe_bad_return", async () => {
    registerCustomProbe({ name: "str", run: () => "not a number" as unknown as number });
    const r = await customSource.execute({ probe_name: "str" });
    expect(r.reason).toBe("custom_probe_bad_return");
  });

  it("a NaN / non-finite return → custom_probe_bad_return", async () => {
    registerCustomProbe({ name: "nan", run: () => NaN });
    const r = await customSource.execute({ probe_name: "nan" });
    expect(r.reason).toBe("custom_probe_bad_return");
  });

  it("aborts a hanging probe at the timeout → custom_probe_timeout", async () => {
    let aborted = false;
    registerCustomProbe({
      name: "hang",
      run: ({ signal }) =>
        new Promise<number>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(0); // late resolve must be ignored
          });
          // otherwise never resolves
        }),
    });
    const r = await customSource.execute({ probe_name: "hang", timeout_ms: 150 });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("custom_probe_timeout");
    expect(aborted).toBe(true);
  });

  it("captures log lines into metadata", async () => {
    registerCustomProbe({
      name: "logger",
      run: ({ log }) => {
        log("step one");
        log("step two", { n: 2 });
        return 3;
      },
    });
    const r = await customSource.execute({ probe_name: "logger" });
    const logs = (r.metadata as Record<string, unknown>).logs as string[];
    expect(logs).toContain("step one");
    expect(logs.some((l) => l.includes("step two"))).toBe(true);
  });
});
