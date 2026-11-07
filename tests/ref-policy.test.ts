// Secret refs from the cloud must never resolve the agent's own credentials,
// and OBSERVER_PROBE_SECRET_REFS (when set) restricts them to an allowlist.
import { describe, expect, it } from "bun:test";
import { AGENT_ENV, isAgentInternalSecretEnv } from "@observer/protocol";
import { RESERVED_AGENT_SECRET_REFS, validateProbeWrite } from "@observer/probe-config";
import { isProbeRefAllowed, readProbeRef } from "../src/sources/_ref-policy.ts";
import { resolveHeaderRefs, resolveMetadataRefs } from "../src/sources/_header-refs.ts";
import { readSecretValue } from "../src/sources/_secret-value.ts";

const ENV = {
  AGENT_KEY: "obs_live_secret",
  OBSERVER_PROBER_KEY: "obs_prb_secret",
  DEBUG_DASHBOARD_TOKEN: "dash",
  PROMETHEUS_PASSWORD: "prom",
  API_TOKEN: "probe-token",
  PROBE_DB: "postgres://x",
} as NodeJS.ProcessEnv;

describe("agent secret ref policy", () => {
  it("the cloud-side reserved list matches the runtime contract exactly", () => {
    const fromContract = AGENT_ENV.filter((e) => isAgentInternalSecretEnv(e.name)).map((e) => e.name).sort();
    expect([...RESERVED_AGENT_SECRET_REFS].sort()).toEqual(fromContract);
  });

  it("refuses every agent-internal secret, including aliases", () => {
    for (const e of AGENT_ENV.filter((x) => x.secret && (x.scope === "agent" || x.scope === "prober"))) {
      expect(isProbeRefAllowed(e.name, ENV)).toBe(false);
      for (const a of e.aliases ?? []) expect(isProbeRefAllowed(a, ENV)).toBe(false);
    }
  });

  it("keeps customer probe secrets and runtime SDK credentials resolvable", () => {
    expect(readProbeRef("API_TOKEN", ENV)).toBe("probe-token");
    expect(isProbeRefAllowed("AWS_SECRET_ACCESS_KEY", ENV)).toBe(true);
  });

  it("applies the OBSERVER_PROBE_SECRET_REFS allowlist (exact names and prefix*)", () => {
    const env = { ...ENV, OBSERVER_PROBE_SECRET_REFS: "API_TOKEN, PROBE_*" };
    expect(readProbeRef("API_TOKEN", env)).toBe("probe-token");
    expect(readProbeRef("PROBE_DB", env)).toBe("postgres://x");
    expect(readProbeRef("OTHER", { ...env, OTHER: "x" })).toBeUndefined();
    // The allowlist itself and agent secrets stay refused even if listed.
    expect(readProbeRef("AGENT_KEY", { ...env, OBSERVER_PROBE_SECRET_REFS: "AGENT_KEY" })).toBeUndefined();
    expect(readProbeRef("OBSERVER_PROBE_SECRET_REFS", { ...env, OBSERVER_PROBE_SECRET_REFS: "*" })).toBeUndefined();
  });

  it("header_refs naming AGENT_KEY never yield the key (reads as missing)", () => {
    const r = resolveHeaderRefs(undefined, { "X-A": "AGENT_KEY" }, ENV);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("header_ref_missing");
    const ok = resolveHeaderRefs(undefined, { Authorization: "API_TOKEN" }, ENV);
    expect(ok.ok && ok.headers.Authorization).toBe("probe-token");
  });

  it("metadata_refs and file/inline secret refs use the same gate", () => {
    expect(resolveMetadataRefs(undefined, { "x-k": "OBSERVER_PROBER_KEY" }, ENV).ok).toBe(false);
    const r = readSecretValue("AGENT_KEY", ENV, () => true);
    expect(r.ok).toBe(false);
  });

  it("the cloud write validator rejects a config naming an agent secret", () => {
    const bad = validateProbeWrite({
      source_type: "http",
      source_config: { url: "https://example.com/", method: "GET", expected_status: 200, header_refs: { "X-A": "AGENT_KEY" } },
    });
    expect(bad.ok).toBe(false);
    const good = validateProbeWrite({
      source_type: "http",
      source_config: { url: "https://example.com/", method: "GET", expected_status: 200, header_refs: { "X-A": "API_TOKEN" } },
    });
    expect(good.ok).toBe(true);
  });
});
