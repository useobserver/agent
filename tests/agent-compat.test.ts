// Compat C3: which agent versions understand which probe types. Lives with
// the agent tests so the public mirror runs it too.
import { describe, expect, it } from "bun:test";
import { PROBE_TYPES } from "@observer/probe-config";
import {
  AGENT_SOURCE_TYPES,
  CLOUD_EVALUATED_SOURCE_TYPES,
  MIN_SUPPORTED_AGENT_VERSION,
  SOURCE_FIELD_MIN_AGENT_VERSION,
  SOURCE_TYPE_MIN_AGENT_VERSION,
  agentSupports,
  compareAgentVersions,
} from "@observer/protocol";
import sources from "../src/sources/index";

describe("agent source types", () => {
  it("PROBE_TYPES is exactly the agent types plus the cloud-evaluated types", () => {
    const expected = [...AGENT_SOURCE_TYPES, ...CLOUD_EVALUATED_SOURCE_TYPES].sort();
    expect([...PROBE_TYPES].sort()).toEqual(expected);
  });

  it("every agent type has a minimum agent version, none older than the supported floor", () => {
    expect(Object.keys(SOURCE_TYPE_MIN_AGENT_VERSION).sort()).toEqual([...AGENT_SOURCE_TYPES].sort());
    for (const [type, min] of Object.entries(SOURCE_TYPE_MIN_AGENT_VERSION)) {
      expect(compareAgentVersions(min, MIN_SUPPORTED_AGENT_VERSION), type).not.toBe(-1);
    }
    for (const fields of Object.values(SOURCE_FIELD_MIN_AGENT_VERSION)) {
      for (const min of Object.values(fields ?? {})) expect(compareAgentVersions(min, "0.0.0")).toBe(1);
    }
  });

  it("this agent dispatches every agent source type", () => {
    for (const type of AGENT_SOURCE_TYPES) expect(sources.getSourceClass(type), type).toBeTruthy();
  });
});

describe("agentSupports", () => {
  it("passes unknown and non-semver versions (no warning we can't back up)", () => {
    expect(agentSupports(null, "http").ok).toBe(true);
    expect(agentSupports("demo", "http").ok).toBe(true);
  });
  it("flags agents older than a field's minimum", () => {
    expect(agentSupports("1.5.0", "http", ["header_refs"])).toEqual({ ok: false, needs: "1.6.0" });
    expect(agentSupports("1.6.0", "http", ["header_refs"]).ok).toBe(true);
    expect(agentSupports("1.7.3", "http", ["url"]).ok).toBe(true);
  });
  it("compares versions numerically", () => {
    expect(compareAgentVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareAgentVersions("v1.6.0", "1.6.0")).toBe(0);
    expect(compareAgentVersions("1.6.0-rc.1", "1.6.0")).toBe(0);
  });
});
