// Prometheus-compatible backends (Grafana Mimir, Cortex, Thanos,
// VictoriaMetrics, Grafana Cloud): header building, auth exclusivity,
// redaction and path-prefix URL joining.

import { describe, it, expect } from "bun:test";
import {
  buildPrometheusHeaders,
  describePrometheusAuth,
  parsePrometheusHeaders,
  prometheusQueryUrl,
  redactPrometheusHeaders,
} from "../src/sources/prometheus-auth.ts";
import { execute } from "../src/sources/prometheus.ts";

const cfg = { query: "up" } as Parameters<typeof execute>[0];

describe("parsePrometheusHeaders", () => {
  it("empty or unset is no headers", () => {
    expect(parsePrometheusHeaders(undefined)).toEqual({ ok: true, headers: {} });
    expect(parsePrometheusHeaders("  ")).toEqual({ ok: true, headers: {} });
  });

  it("parses a JSON object", () => {
    expect(parsePrometheusHeaders('{"X-Org": "acme", "X-Num": 7}')).toEqual({
      ok: true,
      headers: { "X-Org": "acme", "X-Num": "7" },
    });
  });

  it("parses a Name: value; list (values may contain colons)", () => {
    expect(parsePrometheusHeaders("X-A: one; X-B: http://x:1/y ;")).toEqual({
      ok: true,
      headers: { "X-A": "one", "X-B": "http://x:1/y" },
    });
  });

  it("parses newline-separated entries", () => {
    expect(parsePrometheusHeaders("X-A: 1\nX-B: 2")).toEqual({ ok: true, headers: { "X-A": "1", "X-B": "2" } });
  });

  it("rejects bad JSON, arrays, bad names and missing colons without echoing values", () => {
    for (const raw of ["{nope", "[1,2]", '{"bad name": "secret-value"}', "no-colon-secret-value", '{"X": {"a": 1}}']) {
      const r = parsePrometheusHeaders(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toContain("secret-value");
    }
  });
});

describe("buildPrometheusHeaders", () => {
  it("no auth configured → no headers", () => {
    expect(buildPrometheusHeaders({})).toEqual({ ok: true, headers: {}, secretValues: [] });
  });

  it("basic auth stays as before (enabled + username + password)", () => {
    const r = buildPrometheusHeaders({ prometheusBasicAuthEnabled: true, prometheusUsername: "admin", prometheusPassword: "pw" });
    expect(r.ok && r.headers.Authorization).toBe(`Basic ${Buffer.from("admin:pw").toString("base64")}`);
  });

  it("basic auth enabled without a password sends nothing (the long-standing default)", () => {
    const r = buildPrometheusHeaders({ prometheusBasicAuthEnabled: true, prometheusUsername: "admin", prometheusPassword: "" });
    expect(r.ok && r.headers).toEqual({});
  });

  it("bearer token → Authorization: Bearer", () => {
    const r = buildPrometheusHeaders({ prometheusBasicAuthEnabled: true, prometheusUsername: "admin", prometheusBearerToken: "tok" });
    expect(r.ok && r.headers.Authorization).toBe("Bearer tok");
  });

  it("tenant id → X-Scope-OrgID", () => {
    const r = buildPrometheusHeaders({ prometheusTenantId: "team-a" });
    expect(r.ok && r.headers["X-Scope-OrgID"]).toBe("team-a");
  });

  it("bearer + basic is a conflict naming the variables, not the values", () => {
    const r = buildPrometheusHeaders({
      prometheusBasicAuthEnabled: true,
      prometheusUsername: "admin",
      prometheusPassword: "pw-secret",
      prometheusBearerToken: "tok-secret",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("prometheus_auth_conflict");
      expect(r.error).toContain("PROMETHEUS_BEARER_TOKEN");
      expect(r.error).not.toContain("pw-secret");
      expect(r.error).not.toContain("tok-secret");
    }
  });

  it("PROMETHEUS_HEADERS may not repeat Authorization or X-Scope-OrgID set elsewhere", () => {
    const a = buildPrometheusHeaders({ prometheusBearerToken: "t", prometheusHeaders: "authorization: Basic x" });
    expect(!a.ok && a.reason).toBe("prometheus_auth_conflict");
    const b = buildPrometheusHeaders({ prometheusTenantId: "t", prometheusHeaders: '{"x-scope-orgid": "u"}' });
    expect(!b.ok && b.reason).toBe("prometheus_auth_conflict");
  });

  it("PROMETHEUS_HEADERS alone may carry Authorization", () => {
    const r = buildPrometheusHeaders({ prometheusHeaders: "Authorization: Custom abc; X-Extra: 1" });
    expect(r.ok && r.headers).toEqual({ Authorization: "Custom abc", "X-Extra": "1" });
  });

  it("invalid PROMETHEUS_HEADERS → prometheus_headers_invalid", () => {
    const r = buildPrometheusHeaders({ prometheusHeaders: "{oops" });
    expect(!r.ok && r.reason).toBe("prometheus_headers_invalid");
  });
});

describe("redaction", () => {
  it("redactPrometheusHeaders keeps names, drops every value", () => {
    const r = buildPrometheusHeaders({ prometheusBearerToken: "tok-secret", prometheusTenantId: "tenant-secret", prometheusHeaders: "X-Key: key-secret" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const red = JSON.stringify(redactPrometheusHeaders(r.headers));
    expect(red).toContain("Authorization");
    expect(red).toContain("X-Scope-OrgID");
    expect(red).toContain("X-Key");
    for (const s of ["tok-secret", "tenant-secret", "key-secret"]) expect(red).not.toContain(s);
  });

  it("describePrometheusAuth names the auth and headers, never values", () => {
    const line = describePrometheusAuth({ prometheusBearerToken: "tok-secret", prometheusTenantId: "tenant-secret", prometheusHeaders: "X-Key: key-secret" });
    expect(line).toBe("bearer token, tenant header X-Scope-OrgID, extra headers: X-Key");
    expect(describePrometheusAuth({ prometheusBasicAuthEnabled: true, prometheusUsername: "u", prometheusPassword: "p" })).toBe("basic auth");
    expect(describePrometheusAuth({})).toBe("no auth");
    expect(describePrometheusAuth({ prometheusHeaders: "{bad" })).toBe("invalid (prometheus_headers_invalid)");
  });
});

describe("prometheusQueryUrl (path prefix)", () => {
  const q = (base: string) => {
    const u = prometheusQueryUrl(base, "up");
    return `${u.origin}${u.pathname}`;
  };
  it("plain Prometheus", () => {
    expect(q("http://prom:9090")).toBe("http://prom:9090/api/v1/query");
    expect(q("http://prom:9090/")).toBe("http://prom:9090/api/v1/query");
  });
  it("keeps the Mimir /prometheus prefix", () => {
    expect(q("https://mimir.example.com/prometheus")).toBe("https://mimir.example.com/prometheus/api/v1/query");
    expect(q("https://mimir.example.com/prometheus//")).toBe("https://mimir.example.com/prometheus/api/v1/query");
  });
  it("keeps Grafana Cloud's /api/prom prefix", () => {
    expect(q("https://prometheus-prod-01-eu-west-0.grafana.net/api/prom")).toBe(
      "https://prometheus-prod-01-eu-west-0.grafana.net/api/prom/api/v1/query",
    );
  });
  it("does not double /api/v1 or /api/v1/query", () => {
    expect(q("https://mimir.example.com/prometheus/api/v1")).toBe("https://mimir.example.com/prometheus/api/v1/query");
    expect(q("https://mimir.example.com/prometheus/api/v1/query")).toBe("https://mimir.example.com/prometheus/api/v1/query");
  });
  it("encodes the query and keeps existing search params", () => {
    const u = prometheusQueryUrl("http://vm:8428/select/0/prometheus?extra_label=env%3Dprod", 'sum(rate(x{a="b"}[5m]))');
    expect(u.pathname).toBe("/select/0/prometheus/api/v1/query");
    expect(u.searchParams.get("extra_label")).toBe("env=prod");
    expect(u.searchParams.get("query")).toBe('sum(rate(x{a="b"}[5m]))');
  });
  it("throws on a malformed base (execute maps it to no_data)", () => {
    expect(() => prometheusQueryUrl("not a url", "up")).toThrow();
  });
});

describe("prometheus source against a stub Mimir", () => {
  const ok = { status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [1700000000, "1"] }] } };

  it("sends the tenant + bearer headers to the prefixed path", async () => {
    let seen: { path: string; auth: string | null; tenant: string | null; extra: string | null } | null = null;
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const u = new URL(req.url);
        seen = {
          path: u.pathname,
          auth: req.headers.get("authorization"),
          tenant: req.headers.get("x-scope-orgid"),
          extra: req.headers.get("x-extra"),
        };
        return Response.json(ok);
      },
    });
    try {
      const r = await execute(cfg, {
        prometheusUrl: `http://127.0.0.1:${server.port}/prometheus`,
        prometheusBearerToken: "tok",
        prometheusTenantId: "team-a",
        prometheusHeaders: '{"X-Extra": "1"}',
      });
      expect(r.value).toBe(1);
      expect(seen).toEqual({ path: "/prometheus/api/v1/query", auth: "Bearer tok", tenant: "team-a", extra: "1" });
    } finally {
      server.stop(true);
    }
  });

  it("an auth conflict resolves to no_data without a request", async () => {
    let hits = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return Response.json(ok);
      },
    });
    try {
      const r = await execute(cfg, {
        prometheusUrl: `http://127.0.0.1:${server.port}`,
        prometheusBasicAuthEnabled: true,
        prometheusUsername: "u",
        prometheusPassword: "p",
        prometheusBearerToken: "t",
      });
      expect(r.status_hint).toBe("no_data");
      expect(r.reason).toBe("prometheus_auth_conflict");
      expect(hits).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});
