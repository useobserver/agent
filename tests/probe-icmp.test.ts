// ICMP ping source tests.
//
// The pure parse + classify helpers are tested directly against real
// Linux + macOS ping output. execute() is tested by mocking
// node:child_process spawn so no actual ICMP is sent.

import { afterEach, describe, expect, it, mock } from "bun:test";

// ── spawn mock ──────────────────────────────────────────────────
// A fake ChildProcess that emits canned stdout/stderr then closes.
let nextRun: { stdout?: string; stderr?: string; code?: number; throwOnSpawn?: string; emitError?: string } = {};

function makeFakeChild(run: typeof nextRun) {
  const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
  const stream = (data?: string) => ({
    on(_ev: string, cb: (d: Buffer) => void) {
      if (data) cb(Buffer.from(data));
      return this;
    },
  });
  const child = {
    stdout: stream(run.stdout),
    stderr: stream(run.stderr),
    kill() {},
    on(ev: string, cb: (arg?: unknown) => void) {
      (listeners[ev] ??= []).push(cb);
      return child;
    },
  };
  // Fire async so the .on("close"/"error") handlers are registered first.
  queueMicrotask(() => {
    if (run.emitError) {
      const err = new Error(run.emitError) as NodeJS.ErrnoException;
      if (run.emitError === "ENOENT") err.code = "ENOENT";
      listeners["error"]?.forEach((cb) => cb(err));
      return;
    }
    listeners["close"]?.forEach((cb) => cb(run.code ?? 0));
  });
  return child;
}

mock.module("node:child_process", () => ({
  spawn: (_cmd: string, _args: string[]) => {
    if (nextRun.throwOnSpawn) throw new Error(nextRun.throwOnSpawn);
    return makeFakeChild(nextRun);
  },
}));

const { default: icmp, parsePingOutput, classifyPingFailure } = await import(
  "../src/sources/icmp.ts"
);

afterEach(() => {
  nextRun = {};
});

const LINUX_OK = `PING example.com (93.184.216.34) 56(84) bytes of data.
64 bytes from 93.184.216.34: icmp_seq=1 ttl=56 time=11.2 ms
64 bytes from 93.184.216.34: icmp_seq=2 ttl=56 time=12.8 ms
64 bytes from 93.184.216.34: icmp_seq=3 ttl=56 time=10.1 ms

--- example.com ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2003ms
rtt min/avg/max/mdev = 10.123/11.367/12.812/1.100 ms`;

const MACOS_OK = `PING example.com (93.184.216.34): 56 data bytes
64 bytes from 93.184.216.34: icmp_seq=0 ttl=56 time=11.2 ms

--- example.com ping statistics ---
3 packets transmitted, 3 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 10.1/11.4/12.8/1.1 ms`;

const PARTIAL_LOSS = `--- host ping statistics ---
4 packets transmitted, 2 received, 50% packet loss, time 3004ms
rtt min/avg/max/mdev = 10.0/20.0/30.0/5.0 ms`;

const ALL_LOSS = `--- 192.0.2.1 ping statistics ---
3 packets transmitted, 0 received, 100% packet loss, time 2050ms`;

describe("parsePingOutput", () => {
  it("parses Linux output (transmitted/received/avg)", () => {
    const r = parsePingOutput(LINUX_OK);
    expect(r).not.toBeNull();
    expect(r!.transmitted).toBe(3);
    expect(r!.received).toBe(3);
    expect(r!.avgRttMs).toBeCloseTo(11.367, 2);
  });
  it("parses macOS output (round-trip / stddev)", () => {
    const r = parsePingOutput(MACOS_OK);
    expect(r!.received).toBe(3);
    expect(r!.avgRttMs).toBeCloseTo(11.4, 1);
  });
  it("parses partial loss", () => {
    const r = parsePingOutput(PARTIAL_LOSS);
    expect(r!.transmitted).toBe(4);
    expect(r!.received).toBe(2);
    expect(r!.avgRttMs).toBe(20.0);
  });
  it("parses all-loss (no rtt line)", () => {
    const r = parsePingOutput(ALL_LOSS);
    expect(r!.received).toBe(0);
    expect(r!.avgRttMs).toBeNull();
  });
  it("returns null for non-ping output", () => {
    expect(parsePingOutput("garbage")).toBeNull();
  });
});

describe("classifyPingFailure", () => {
  it("privilege denied", () => {
    expect(classifyPingFailure("ping: socket: Operation not permitted", 2)).toBe("icmp_privilege_denied");
    expect(classifyPingFailure("must be superuser to use ping", 2)).toBe("icmp_privilege_denied");
  });
  it("dns failure", () => {
    expect(classifyPingFailure("ping: nope.invalid: Name or service not known", 2)).toBe("icmp_dns_failed");
    expect(classifyPingFailure("ping: cannot resolve nope: Unknown host", 68)).toBe("icmp_dns_failed");
  });
  it("binary missing", () => {
    expect(classifyPingFailure("not found", 127)).toBe("icmp_unavailable");
  });
  it("generic", () => {
    expect(classifyPingFailure("something else", 1)).toBe("icmp_error");
  });
});

const base = { host: "example.com", count: 3, timeout_ms: 1000 };

describe("execute — interpretations", () => {
  it("latency returns avg RTT", async () => {
    nextRun = { stdout: LINUX_OK, code: 0 };
    const r = await icmp.execute({ ...base, interpretation: "latency" });
    expect(r.value).toBeCloseTo(11.367, 2);
    expect(r.status_hint).toBeUndefined();
  });
  it("packet_loss returns loss percent", async () => {
    nextRun = { stdout: PARTIAL_LOSS, code: 0 };
    const r = await icmp.execute({ ...base, count: 4, interpretation: "packet_loss" });
    expect(r.value).toBe(50);
  });
  it("reachability returns 1 when any received", async () => {
    nextRun = { stdout: PARTIAL_LOSS, code: 0 };
    const r = await icmp.execute({ ...base, interpretation: "reachability" });
    expect(r.value).toBe(1);
  });
  it("reachability returns 0 when all lost", async () => {
    nextRun = { stdout: ALL_LOSS, code: 1 };
    const r = await icmp.execute({ ...base, interpretation: "reachability" });
    expect(r.value).toBe(0);
  });
  it("packet_loss returns 100 when all lost", async () => {
    nextRun = { stdout: ALL_LOSS, code: 1 };
    const r = await icmp.execute({ ...base, interpretation: "packet_loss" });
    expect(r.value).toBe(100);
  });
  it("latency is no_data (icmp_all_timeout) when all lost", async () => {
    nextRun = { stdout: ALL_LOSS, code: 1 };
    const r = await icmp.execute({ ...base, interpretation: "latency" });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("icmp_all_timeout");
  });

  it("clamps packet_loss to [0,100] on malformed output (received > transmitted)", async () => {
    const weird = `--- host ping statistics ---
2 packets transmitted, 5 received, 0% packet loss
rtt min/avg/max/mdev = 1.0/1.0/1.0/0.0 ms`;
    nextRun = { stdout: weird, code: 0 };
    const r = await icmp.execute({ ...base, count: 2, interpretation: "packet_loss" });
    expect(r.value).toBeGreaterThanOrEqual(0);
    expect(r.value).toBeLessThanOrEqual(100);
  });
});

describe("execute — failure surfaces, never falls back to TCP", () => {
  it("privilege denied surfaces icmp_privilege_denied", async () => {
    nextRun = { stderr: "ping: socket: Operation not permitted", code: 2 };
    const r = await icmp.execute({ ...base, interpretation: "reachability" });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("icmp_privilege_denied");
    // never returns a reachability value from a TCP fallback
    expect(r.value).toBeNull();
  });
  it("missing binary surfaces icmp_unavailable", async () => {
    nextRun = { emitError: "ENOENT" };
    const r = await icmp.execute({ ...base });
    expect(r.reason).toBe("icmp_unavailable");
  });
  it("spawn throw surfaces a typed reason", async () => {
    nextRun = { throwOnSpawn: "spawn EACCES" };
    const r = await icmp.execute({ ...base });
    expect(r.status_hint).toBe("no_data");
    expect(["icmp_unavailable", "icmp_error", "icmp_privilege_denied"]).toContain(r.reason);
  });
});

describe("validateConfig", () => {
  it("accepts a hostname", () => {
    expect(icmp.validateConfig({ host: "db.internal" })).toBeNull();
  });
  it("accepts an IPv4", () => {
    expect(icmp.validateConfig({ host: "10.0.0.1" })).toBeNull();
  });
  it("rejects a host starting with '-' (flag injection guard)", () => {
    expect(icmp.validateConfig({ host: "-fHost" })).not.toBeNull();
  });
  it("rejects count over 10", () => {
    expect(icmp.validateConfig({ host: "x.test", count: 50 })).not.toBeNull();
  });
  it("rejects unknown interpretation", () => {
    expect(icmp.validateConfig({ host: "x.test", interpretation: "jitter" })).not.toBeNull();
  });
});
