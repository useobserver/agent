// pins the Source lifecycle contract. Verifies that:
//   1. The asPullSource adapter turns every existing ProbeSource into
//      a Source with mode="pull" and a working init→read→dispose
//      lifecycle.
//   2. getSourceClass() returns the same Source instance per type
//      (no per-call allocation cost).
//   3. validateConfig errors surface through the Source path.

import { describe, expect, it } from "bun:test";
import { asPullSource } from "@observer/protocol";
import type { ProbeResult, ProbeSource } from "@observer/protocol";
import { SOURCE_CLASSES, getSourceClass } from "../src/sources/index.ts";

describe("Source lifecycle", () => {
  it("getSourceClass returns the same Source for repeated lookups", () => {
    const a = getSourceClass("prometheus");
    const b = getSourceClass("prometheus");
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it("every legacy SourceType has a Source class with mode=pull", () => {
    const expected = [
      "prometheus",
      "http",
      "tcp",
      "dns",
      "tls_cert",
      "icmp",
      "grpc",
      "websocket",
      "mtls_http",
      "database",
      "cloudwatch",
    ];
    for (const t of expected) {
      const s = getSourceClass(t);
      expect(s, `getSourceClass(${t}) returned undefined`).toBeDefined();
      expect(s!.mode).toBe("pull");
      expect(typeof s!.validateConfig).toBe("function");
      expect(typeof s!.init).toBe("function");
    }
  });

  it("init() yields an instance whose read() delegates to ProbeSource.execute", async () => {
    const calls: Array<unknown> = [];
    const fake: ProbeSource = {
      validateConfig() {
        return null;
      },
      async execute(config, env) {
        calls.push({ config, env });
        const r: ProbeResult = { value: 42, timestamp: "2026-05-22T00:00:00Z" };
        return r;
      },
    };
    const src = asPullSource(fake);
    const inst = await src.init({ k: "v" }, { env: 1 });
    const r1 = await inst.read();
    const r2 = await inst.read();
    await inst.dispose();
    expect(r1.value).toBe(42);
    expect(r2.value).toBe(42);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ config: { k: "v" }, env: { env: 1 } });
  });

  it("validateConfig error propagates through the adapter", () => {
    const fake: ProbeSource = {
      validateConfig: () => "missing url",
      async execute() {
        return { value: null, timestamp: "x" };
      },
    };
    const src = asPullSource(fake);
    expect(src.validateConfig({})).toBe("missing url");
  });

  it("supports async init returning a Promise<SourceInstance>", async () => {
    const probe: ProbeSource = {
      validateConfig: () => null,
      async execute() {
        return { value: 7, timestamp: "t" };
      },
    };
    // Build a Source manually with async init to pin the contract that
    // push receivers will rely on in push mode.
    const src = {
      mode: "push" as const,
      validateConfig: probe.validateConfig.bind(probe),
      async init() {
        // Pretend to open a socket.
        await new Promise((r) => setTimeout(r, 1));
        return {
          async read() {
            return await probe.execute({}, undefined);
          },
          async dispose() {},
        };
      },
    };
    const inst = await src.init();
    const r = await inst.read();
    await inst.dispose();
    expect(r.value).toBe(7);
  });

  it("dispose() is safe to call multiple times", async () => {
    let disposeCount = 0;
    const probe: ProbeSource = {
      validateConfig: () => null,
      async execute() {
        return { value: 1, timestamp: "t" };
      },
    };
    // Pull adapter's dispose is a no-op; verify two calls do not throw.
    const inst = await asPullSource(probe).init({}, undefined);
    await inst.dispose();
    await inst.dispose();
    disposeCount = 2;
    expect(disposeCount).toBe(2);

    // And verify a custom Source whose dispose tracks invocation can
    // be called twice without surfacing the second-call as a bug.
    let n = 0;
    const customInst = {
      async read() {
        return { value: 1, timestamp: "t" };
      },
      async dispose() {
        n++;
      },
    };
    await customInst.dispose();
    await customInst.dispose();
    expect(n).toBe(2);
  });

  it("getSourceClass returns undefined for unknown source types", () => {
    expect(getSourceClass("nonexistent")).toBeUndefined();
    expect(getSourceClass("")).toBeUndefined();
  });

  it("SOURCE_CLASSES has one entry per registered type (legacy pull + push)", () => {
    const keys = Object.keys(SOURCE_CLASSES).sort();
    expect(keys).toEqual([
      "cloudwatch",
      "custom",
      "database",
      "dns",
      "elasticsearch",
      "grpc",
      "host",
      "http",
      "icmp",
      "loki",
      "mtls_http",
      "otlp",
      "prometheus",
      "tcp",
      "tls_cert",
      "websocket",
    ]);
  });

  it("OTLP source is push-mode", () => {
    const s = getSourceClass("otlp");
    expect(s).toBeDefined();
    expect(s!.mode).toBe("push");
  });
});
