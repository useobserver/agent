// Prober failure modes seen in production and in its audit: a check
// that never settles, overlapping flushes, a hung self-check control, the
// watchdog, the body preview cap, the tcp wall timer, shared DNS resolvers.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import type net from "node:net";
import { PROBER_HEALTH_HEADER, formatProberHealth, parseProberHealth, type ProberCheck } from "@observer/protocol";
import { withDeadline, DeadlineError } from "../src/deadline";
import { createProber, proberNetworkOk, type ProberConfig } from "../src/prober/prober";
import { bunAtLeast } from "../src/prober/main";
import { proberHttp, type ProberDeps } from "../src/prober/sources";
import tcpSource from "../src/sources/tcp";

const cfg: ProberConfig = {
  cloudUrl: "https://cloud.test",
  key: "obs_prb_test",
  expectedLocation: null,
  dnsServers: ["1.1.1.1"],
  icmp: "off",
  concurrency: 4,
  refreshMs: 30_000,
  flushMs: 5_000,
  queueMax: 100,
  maxRssMb: 384,
  version: "test",
};

function check(id: string, over: Partial<ProberCheck> = {}): ProberCheck {
  return {
    id,
    source_type: "http",
    source_config: { url: "https://hang.example.com" },
    interval: 1,
    healthy_operation: "under",
    healthy_value: 1000,
    unhealthy_operation: "over",
    unhealthy_value: 3000,
    ...over,
  } as ProberCheck;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function checksResponse(checks: ProberCheck[]) {
  return new Response(JSON.stringify({ location: "eu-central", version: "v1", checks }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("withDeadline", () => {
  it("rejects with DeadlineError when the promise never settles", async () => {
    const err = await withDeadline(new Promise(() => {}), 20, "x").catch((e) => e);
    expect(err).toBeInstanceOf(DeadlineError);
    expect(err.code).toBe("ETIMEDOUT");
  });
  it("passes a value through and swallows a late rejection", async () => {
    expect(await withDeadline(Promise.resolve(7), 50)).toBe(7);
    let late!: (e: Error) => void;
    const p = new Promise((_, rej) => (late = rej));
    await withDeadline(p, 10).catch(() => {});
    late(new Error("late"));
    await tick(5);
  });
});

describe("a check that never settles", () => {
  it("is abandoned at its deadline: the slot is freed once, nothing is sent, the count rises", async () => {
    let t = 0;
    const hangDeps: ProberDeps = {
      resolve: () => new Promise(() => {}),
      dnsServers: ["1.1.1.1"],
      icmpEnabled: false,
      userAgent: "test",
    };
    const prober = createProber(cfg, hangDeps, {
      fetch: (async () => checksResponse([check("00000000-0000-4000-8000-0000000000a1")])) as typeof fetch,
      now: () => t,
      random: () => 0,
      deadlines: { check: 30 },
      log: () => {},
    });
    await prober.refreshOnce();
    await prober.runDue();
    const h = prober.health();
    expect(h.inflight).toBe(0);
    expect(h.stuck).toBe(1);
    expect(h.abandoned).toBe(1);
    expect(h.queued).toBe(0);
    // The check runs again on its next interval instead of staying "running".
    t += 60_000;
    await prober.runDue();
    expect(prober.health().stuck).toBe(2);
    expect(prober.health().inflight).toBe(0);
  });
});

describe("flushOnce", () => {
  it("never overlaps and never drops unsent results when the queue changes mid-post", async () => {
    let t = 0;
    const okDeps: ProberDeps = {
      resolve: async () => ({ v4: ["10.0.0.1"], v6: [] }), // private: each run is a quick no_data result
      dnsServers: ["1.1.1.1"],
      icmpEnabled: false,
      userAgent: "test",
    };
    const posts: number[][] = [];
    let release!: () => void;
    let calls = 0;
    const checks = Array.from({ length: 3 }, (_, i) => check(`00000000-0000-4000-8000-00000000000${i}`));
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      if (!init?.method) return checksResponse(checks);
      calls++;
      const items = (JSON.parse(String(init.body)).results as Array<{ value: number; timestamp: string }>).map((r) =>
        Date.parse(r.timestamp),
      );
      posts.push(items);
      if (calls === 1) await new Promise<void>((r) => (release = r));
      return new Response(JSON.stringify({ accepted: items.length, rejected: [] }), { status: 200 });
    }) as typeof fetch;
    const prober = createProber({ ...cfg, concurrency: 10 }, okDeps, { fetch: fetchFn, now: () => t, random: () => 0, log: () => {} });
    await prober.refreshOnce();
    await prober.runDue();
    expect(prober.health().queued).toBe(3);
    const first = prober.flushOnce();
    await tick(5);
    // A second flush while the first is in flight must not send anything.
    await prober.flushOnce();
    expect(posts.length).toBe(1);
    // More results arrive while the post is in flight.
    t += 60_000;
    await prober.runDue();
    release();
    await first;
    expect(prober.health().queued).toBe(3);
    await prober.flushOnce();
    expect(posts.length).toBe(2);
    expect(posts[1].length).toBe(3);
    expect(prober.health().queued).toBe(0);
  });
});

describe("Prober-Health", () => {
  it("is sent on cloud calls and round-trips through the protocol parser", async () => {
    let seen: string | null = null;
    const prober = createProber(cfg, { resolve: async () => ({ v4: [], v6: [] }), dnsServers: [], icmpEnabled: false, userAgent: "t" }, {
      fetch: (async (_u: string, init?: RequestInit) => {
        seen = new Headers(init?.headers).get(PROBER_HEALTH_HEADER);
        return checksResponse([]);
      }) as typeof fetch,
      rss: () => 100 * 1_048_576,
      log: () => {},
    });
    await prober.refreshOnce();
    const parsed = parseProberHealth(seen);
    expect(parsed?.rss_mb).toBe(100);
    expect(parsed?.result_age_s).toBe(-1);
    expect(parseProberHealth(formatProberHealth({ queued: 3, lag_ms: 12 }))).toEqual({ queued: 3, lag_ms: 12 });
    expect(parseProberHealth("rss_mb=1; evil=9; lag_ms=abc")).toEqual({ rss_mb: 1 });
    expect(parseProberHealth("x".repeat(600))).toBeNull();
  });
});

describe("watchdog", () => {
  const quiet: ProberDeps = { resolve: async () => ({ v4: [], v6: [] }), dnsServers: [], icmpEnabled: false, userAgent: "t" };
  it("asks for a restart after three rounds over the memory cap, and not before", () => {
    let mb = 500;
    const prober = createProber(cfg, quiet, { rss: () => mb * 1_048_576, log: () => {} });
    expect(prober.watchdog()).toBeNull();
    expect(prober.watchdog()).toBeNull();
    expect(prober.watchdog()).toContain("PROBER_MAX_RSS_MB");
    mb = 100;
    expect(prober.watchdog()).toBeNull();
  });
  it("asks for a restart when checks are assigned but no result came for 10 minutes", async () => {
    let t = 0;
    const prober = createProber(cfg, { ...quiet, resolve: () => new Promise(() => {}) }, {
      fetch: (async () => checksResponse([check("00000000-0000-4000-8000-0000000000b1")])) as typeof fetch,
      now: () => t,
      rss: () => 50 * 1_048_576,
      deadlines: { check: 5 },
      log: () => {},
    });
    await prober.refreshOnce();
    t = 9 * 60_000;
    expect(prober.watchdog()).toBeNull();
    t = 11 * 60_000;
    prober.watchdog();
    prober.watchdog();
    expect(prober.watchdog()).toContain("no check produced a result");
  });
});

describe("network self-check", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((_req, res) => void res.writeHead(204).end());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });
  it("passes on the first control that answers, even when the other one hangs", async () => {
    const deps: ProberDeps = {
      resolve: (name) => (name.startsWith("hang.") ? new Promise(() => {}) : Promise.resolve({ v4: ["1.0.0.1"], v6: [] })),
      dnsServers: ["1.1.1.1"],
      icmpEnabled: false,
      userAgent: "t",
      dialTarget: () => ({ ip: "127.0.0.1", family: 4, port }),
    };
    const controls = ["http://hang.example.com/", "http://ok.example.com/"];
    expect(await withDeadline(proberNetworkOk(deps, controls), 3_000)).toBe(true);
  });
  it("fails when DNS is broken, even though an IP would answer", async () => {
    const deps: ProberDeps = {
      resolve: async () => {
        throw new Error("resolver down");
      },
      dnsServers: ["1.1.1.1"],
      icmpEnabled: false,
      userAgent: "t",
      dialTarget: () => ({ ip: "127.0.0.1", family: 4, port }),
    };
    expect(await proberNetworkOk(deps, ["http://a.example.com/", "http://b.example.com/"])).toBe(false);
  });
});

describe("proberHttp body preview", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/big") {
        // One write well over the 4 KiB preview cap, with the marker early.
        return void res.writeHead(200, { "content-type": "text/html" }).end(`<html>MARKER ${"x".repeat(64 * 1024)}</html>`);
      }
      res.writeHead(200).end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });
  const deps = (): ProberDeps => ({
    resolve: async () => ({ v4: ["93.184.216.34"], v6: [] }),
    dnsServers: ["1.1.1.1"],
    icmpEnabled: false,
    userAgent: "ObserverProber/test",
    dialTarget: () => ({ ip: "127.0.0.1", family: 4, port }),
  });
  it("matches body_match inside a first chunk larger than the cap", async () => {
    const r = await proberHttp({ url: "http://public.example.com/big", timeout_ms: 3000, body_match: "MARKER" } as never, deps());
    expect(r.status_hint).toBeUndefined();
    expect(typeof r.value).toBe("number");
  });
  it("keeps the prober's User-Agent even when the check sets one", async () => {
    let ua = "";
    const s2 = createServer((req, res) => {
      ua = String(req.headers["user-agent"]);
      res.writeHead(200).end();
    });
    await new Promise<void>((r) => s2.listen(0, "127.0.0.1", () => r()));
    const p2 = (s2.address() as net.AddressInfo).port;
    await proberHttp(
      { url: "http://public.example.com/", timeout_ms: 3000, headers: { "User-Agent": "Mozilla/5.0 innocent" } } as never,
      { ...deps(), dialTarget: () => ({ ip: "127.0.0.1", family: 4, port: p2 }) },
    );
    await new Promise((r) => s2.close(r));
    expect(ua).toBe("ObserverProber/test");
  });
});

describe("tcp source", () => {
  it("is bounded by timeout_ms when the connect never completes", async () => {
    const started = Date.now();
    // TEST-NET-1: nothing answers, so the SYN is never acknowledged (or the
    // route is refused at once on hosts without a default route).
    const r = await tcpSource.execute({ host: "192.0.2.1", port: 81, timeout_ms: 300 } as never);
    expect(r.status_hint).toBe("no_data");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("bunAtLeast", () => {
  it("compares versions numerically", () => {
    expect(bunAtLeast("1.4.5", "1.4.4")).toBe(true);
    expect(bunAtLeast("1.4.4", "1.4.4")).toBe(true);
    expect(bunAtLeast("1.3.6", "1.4.4")).toBe(false);
    expect(bunAtLeast("1.10.0", "1.4.4")).toBe(true);
    expect(bunAtLeast("2.0.0-canary.1", "1.4.4")).toBe(true);
  });
});
