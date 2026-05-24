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
    const types = ["prometheus", "http", "tcp", "dns", "tls_cert", "icmp", "grpc", "websocket", "mtls_http", "database"];
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
    // source_config) by checking the failure mode is no_prometheus_url
    // rather than invalid_config.
    const r = await sources.execute(
      { id: "m1", source_type: "prometheus", source_config: {}, query: "up" },
      {} // env without prometheusUrl → reason should be no_prometheus_url, not invalid_config
    );
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("no_prometheus_url");
  });

  it("default source_type is prometheus when omitted", async () => {
    const r = await sources.execute({ id: "m1", source_config: { query: "up" } }, {});
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("no_prometheus_url");
  });
});