import { describe, expect, it } from "bun:test";
import type { ProberCheck } from "@observer/protocol";
import { executeProberCheck, runProberCheck } from "../src/prober/runner";
import { PROBER_INFO_URL, createProber, loadProberConfig, proberUserAgent, type ProberConfig } from "../src/prober/prober";
import type { ProberDeps } from "../src/prober/sources";

const deps: ProberDeps = {
  resolve: async () => ({ v4: ["10.0.0.1"], v6: [] }),
  dnsServers: ["1.1.1.1"],
  icmpEnabled: false,
  userAgent: "test",
};

function check(over: Partial<ProberCheck> & Record<string, unknown> = {}): ProberCheck {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    source_type: "http",
    source_config: { url: "https://example.com" },
    interval: 1,
    healthy_operation: "under",
    healthy_value: 1000,
    unhealthy_operation: "over",
    unhealthy_value: 3000,
    ...over,
  } as ProberCheck;
}

describe("prober mode refuses non-public-safe sources", () => {
  for (const t of ["custom", "database", "prometheus", "loki", "elasticsearch", "cloudwatch", "otlp", "host", "grpc", "websocket", "mtls_http"]) {
    it(`refuses ${t} without running it`, async () => {
      const r = await executeProberCheck(check({ source_type: t as never, source_config: { query: "x", connection_string_ref: "DATABASE_URL" } }), deps);
      expect(r.status_hint).toBe("no_data");
      expect(r.reason).toBe("source_not_allowed_in_prober");
    });
  }
  it("refuses env-var refs on an allowed type", async () => {
    const r = await executeProberCheck(check({ source_config: { url: "https://example.com", header_refs: { Authorization: "OBSERVER_PROBER_KEY" } } }), deps);
    expect(r.reason).toBe("refused:secret_refs_not_allowed");
  });
  it("refuses a private literal target from config", async () => {
    const r = await executeProberCheck(check({ source_config: { url: "http://127.0.0.1:10101/" } }), deps);
    expect(r.reason).toBe("refused:host_not_public");
  });
  it("shapes a no_data wire sample with value 0", async () => {
    const s = await runProberCheck(check({ source_config: { url: "https://private-resolving.example.com" } }), deps);
    expect(s).toMatchObject({ metric_id: check().id, value: 0, status: "no_data", reason: "target_not_public:private" });
  });
});

describe("loadProberConfig", () => {
  it("requires a prober credential, not an agent key", () => {
    expect(loadProberConfig({}, "1").ok).toBe(false);
    const r = loadProberConfig({ OBSERVER_PROBER_KEY: "obs_live_abc" }, "1");
    expect(r.ok).toBe(false);
  });
  it("requires https for the cloud", () => {
    expect(loadProberConfig({ OBSERVER_PROBER_KEY: "obs_prb_x", CLOUD_SERVER_URL: "http://use.observer" }, "1").ok).toBe(false);
    expect(loadProberConfig({ OBSERVER_PROBER_KEY: "obs_prb_x" }, "1").ok).toBe(true);
  });
  it("ICMP is off unless the operator opts in", () => {
    const base = { OBSERVER_PROBER_KEY: "obs_prb_x" };
    const off = loadProberConfig(base, "1");
    expect(off.ok && off.config.icmp).toBe("off");
    const bogus = loadProberConfig({ ...base, PROBER_ICMP: "yes" }, "1");
    expect(bogus.ok && bogus.config.icmp).toBe("off");
    const on = loadProberConfig({ ...base, PROBER_ICMP: "on" }, "1");
    expect(on.ok && on.config.icmp).toBe("on");
  });

  it("user agent points at the public outside-in checks guide", () => {
    expect(PROBER_INFO_URL).toBe("https://docs.use.observer/docs/guides/outside-in-checks");
    expect(proberUserAgent("1.2.3")).toBe("ObserverProber/1.2.3 (+https://docs.use.observer/docs/guides/outside-in-checks)");
  });

  it("refuses private DNS servers", () => {
    expect(loadProberConfig({ OBSERVER_PROBER_KEY: "obs_prb_x", PROBER_DNS_SERVERS: "10.96.0.10" }, "1").ok).toBe(false);
  });
});

function cfg(over: Partial<ProberConfig> = {}): ProberConfig {
  return {
    cloudUrl: "https://cloud.test",
    key: "obs_prb_testkey",
    expectedLocation: null,
    dnsServers: ["1.1.1.1"],
    icmp: "off",
    concurrency: 4,
    refreshMs: 30_000,
    flushMs: 5_000,
    queueMax: 1000,
    version: "9.9.9",
    ...over,
  };
}

function mockCloud(checks: ProberCheck[], location = "eu-central") {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let resultsStatus = 200;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/api/prober/checks")) {
      const inm = (init?.headers as Record<string, string>)?.["If-None-Match"];
      if (inm === "v1") return new Response(null, { status: 304 });
      return new Response(JSON.stringify({ location, version: "v1", checks }), {
        status: 200,
        headers: { "x-observer-prober-checks-version": "v1" },
      });
    }
    return new Response(JSON.stringify({ accepted: 1, rejected: [] }), { status: resultsStatus });
  }) as unknown as typeof fetch;
  return { fetchFn, calls, setResultsStatus: (s: number) => (resultsStatus = s) };
}

describe("createProber loop", () => {
  it("authenticates with the prober key and runs due checks", async () => {
    const cloud = mockCloud([check()]);
    let t = 1_000_000;
    const p = createProber(cfg(), deps, { fetch: cloud.fetchFn, now: () => t, random: () => 0, log: () => {} });
    await p.refreshOnce();
    expect((cloud.calls[0].init?.headers as Record<string, string>)["Prober-Key"]).toBe("obs_prb_testkey");
    await p.runDue();
    expect(p.state()).toMatchObject({ location: "eu-central", checks: 1, queued: 1 });
    await p.flushOnce();
    const post = cloud.calls.find((c) => c.url.endsWith("/api/prober/results"))!;
    const body = JSON.parse(String(post.init?.body));
    expect(body.results[0]).toMatchObject({ metric_id: check().id, status: "no_data" });
    expect(p.state().queued).toBe(0);
    // Not due again until the interval passes.
    await p.runDue();
    expect(p.state().queued).toBe(0);
    t += 60_000;
    await p.runDue();
    expect(p.state().queued).toBe(1);
  });

  it("sends If-None-Match and keeps the set on 304", async () => {
    const cloud = mockCloud([check()]);
    const p = createProber(cfg(), deps, { fetch: cloud.fetchFn, log: () => {} });
    await p.refreshOnce();
    await p.refreshOnce();
    expect((cloud.calls[1].init?.headers as Record<string, string>)["If-None-Match"]).toBe("v1");
    expect(p.state().checks).toBe(1);
  });

  it("refuses to run when the credential's location differs from PROBER_LOCATION", async () => {
    const cloud = mockCloud([check()], "us-east");
    const p = createProber(cfg({ expectedLocation: "eu-central" }), deps, { fetch: cloud.fetchFn, random: () => 0, log: () => {} });
    await p.refreshOnce();
    await p.runDue();
    expect(p.state()).toMatchObject({ refused: true, checks: 0, queued: 0 });
  });

  it("keeps results and backs off on 5xx; drops a batch on a permanent 4xx", async () => {
    const cloud = mockCloud([check()]);
    let t = 0;
    const p = createProber(cfg(), deps, { fetch: cloud.fetchFn, now: () => t, random: () => 0, log: () => {} });
    await p.refreshOnce();
    await p.runDue();
    cloud.setResultsStatus(503);
    await p.flushOnce();
    expect(p.state().queued).toBe(1);
    await p.flushOnce(); // still backing off: no second POST
    expect(cloud.calls.filter((c) => c.url.endsWith("/results")).length).toBe(1);
    t += 61_000;
    cloud.setResultsStatus(400);
    await p.flushOnce();
    expect(p.state().queued).toBe(0);
  });

  it("drops checks the cloud stops assigning", async () => {
    let checks = [check()];
    const fetchFn = (async (url: string) =>
      url.endsWith("/checks")
        ? new Response(JSON.stringify({ location: "eu-central", version: String(checks.length), checks }), { status: 200 })
        : new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const p = createProber(cfg(), deps, { fetch: fetchFn, log: () => {} });
    await p.refreshOnce();
    expect(p.state().checks).toBe(1);
    checks = [];
    await p.refreshOnce();
    expect(p.state().checks).toBe(0);
  });
});
