// @ts-nocheck — Phase D follow-up: tighten test types per-file.
import { describe, expect, it } from "bun:test";
import sources from "../src/sources/index";

// single dispatch site.
//
// The dispatcher must:
//   1. Route by source_type to the right module.
//   2. Mirror legacy `query` into source_config.query for prometheus.
//   3. Reject unknown source_type values cleanly (no throw).
//   4. Return not_implemented for stubbed runtimes.
//   5. Surface invalid_config without invoking the source.

describe("getSource", () => {
  it("exposes every probe type", () => {
    const types = ["prometheus", "http", "tcp", "dns", "tls_cert", "icmp", "grpc", "websocket", "mtls_http", "database", "host"];
    for (const t of types) {
      expect(typeof sources.getSource(t)?.execute).toBe("function");
      expect(typeof sources.getSource(t)?.validateConfig).toBe("function");
    }
  });

  it("returns undefined for an unknown source_type", () => {
    expect(sources.getSource("nope")).toBeUndefined();
  });
});

describe("dispatch", () => {
  it("returns no_data with reason='unknown_source_type' for unmapped types", async () => {
    const r = await sources.execute({ id: "m1", source_type: "nope", source_config: {} });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("unknown_source_type");
  });

  it("returns no_data with reason='invalid_config' when validateConfig rejects", async () => {
    const r = await sources.execute({ id: "m1", source_type: "tcp", source_config: { host: "" } });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("invalid_config");
    expect(r.metadata?.error).toBeTruthy();
  });

  it("every enumerated runtime ships; custom routes through validateConfig", async () => {
    // database, mtls_http (delegates to http), icmp
    //, websocket, grpc, and custom
    // all dispatch. A custom row with no probe_name fails validation
    // (invalid_config) rather than falling through to unknown_source_type.
    const r = await sources.execute({ id: "m1", source_type: "custom", source_config: {} });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("invalid_config");
  });

  it("legacy fallback: prometheus row with top-level query but empty source_config still routes", async () => {
    // We cannot exercise the actual prometheus runtime without a server,
    // but we can assert that validateConfig sees a query (not the empty
    // source_config) by checking the failure mode is prometheus_url_missing
    // rather than invalid_config.
    const r = await sources.execute(
      { id: "m1", source_type: "prometheus", source_config: {}, query: "up" },
      {} // env without prometheusUrl → reason should be prometheus_url_missing, not invalid_config
    );
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("prometheus_url_missing");
  });

  it("default source_type is prometheus when omitted", async () => {
    const r = await sources.execute({ id: "m1", source_config: { query: "up" } }, {});
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("prometheus_url_missing");
  });

  it("backstop: a source whose execute throws → source_threw, no error text surfaced", async () => {
    const original = sources.SOURCES.tcp;
    sources.SOURCES.tcp = {
      validateConfig: () => null,
      execute: async () => {
        throw new Error("boom postgres://user:SECRETPASS@host/db");
      },
    };
    try {
      const r = await sources.execute({ id: "m1", source_type: "tcp", source_config: { host: "x", port: 1 } });
      expect(r.status_hint).toBe("no_data");
      expect(r.reason).toBe("source_threw");
      expect(r.value).toBeNull();
      expect(r.metadata?.source_type).toBe("tcp");
      expect(JSON.stringify(r)).not.toContain("SECRETPASS");
      expect(JSON.stringify(r)).not.toContain("boom");
    } finally {
      sources.SOURCES.tcp = original;
    }
  });

  it("backstop: a source whose execute throws synchronously → source_threw", async () => {
    const original = sources.SOURCES.tcp;
    sources.SOURCES.tcp = {
      validateConfig: () => null,
      execute: () => {
        throw new Error("sync boom");
      },
    };
    try {
      const r = await sources.execute({ id: "m1", source_type: "tcp", source_config: { host: "x", port: 1 } });
      expect(r.status_hint).toBe("no_data");
      expect(r.reason).toBe("source_threw");
    } finally {
      sources.SOURCES.tcp = original;
    }
  });
});