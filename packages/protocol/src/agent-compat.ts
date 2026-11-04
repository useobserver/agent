// Which agent versions understand which probe types and fields (compat C3).
//
// Agents validate source_config with `.strict()` schemas from the
// @observer/probe-config they were built with. So an older agent given a new
// source type reports `unknown_source_type`, and one given a new field (or a
// new enum value) on an existing type reports `invalid_config`. Every such
// addition needs an entry here; the probe-config snapshot check in
// `bun run compat` fails without one. The console uses `agentSupports` to warn
// before a check is assigned to an agent that is too old.

import type { SourceType } from "./definition";

/** Oldest agent the cloud guarantees to serve correctly (prod had 1.6.0 heartbeating on 2026-11-04). */
export const MIN_SUPPORTED_AGENT_VERSION = "1.6.0";

/** Types the cloud evaluates itself; never sent to an agent. */
export const CLOUD_EVALUATED_SOURCE_TYPES = Object.freeze(["manual", "heartbeat", "alert"] as const);

/** First agent version that runs each source type. Types older than MIN_SUPPORTED say MIN_SUPPORTED. */
export const SOURCE_TYPE_MIN_AGENT_VERSION: Readonly<Record<SourceType, string>> = Object.freeze({
  prometheus: "1.6.0",
  http: "1.6.0",
  tcp: "1.6.0",
  dns: "1.6.0",
  tls_cert: "1.6.0",
  icmp: "1.6.0",
  grpc: "1.6.0",
  websocket: "1.6.0",
  mtls_http: "1.6.0",
  database: "1.6.0",
  otlp: "1.6.0",
  cloudwatch: "1.6.0",
  custom: "1.6.0",
  loki: "1.6.0",
  elasticsearch: "1.6.0",
  host: "1.6.0",
  datadog: "1.8.0",
  gcp_monitoring: "1.8.0",
  azure_monitor: "1.8.0",
});

/**
 * First agent version that accepts a field (or, keyed "<field>=<value>", an
 * enum value) added to a type after the type shipped. Fields present since
 * the type shipped are not listed.
 */
export const SOURCE_FIELD_MIN_AGENT_VERSION: Readonly<Partial<Record<SourceType, Readonly<Record<string, string>>>>> =
  Object.freeze({
    // header_refs / metadata_refs landed after agent 1.5.0; 1.6.0 was the next release.
    http: { header_refs: "1.6.0" },
    websocket: { header_refs: "1.6.0" },
    grpc: { metadata_refs: "1.6.0" },
  });

function parse(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1; null when either side is not a semver (e.g. a "demo" or dev build). */
export function compareAgentVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Whether an agent at `agentVersion` can run `sourceType` with the given
 * config fields. An unknown or non-semver version is treated as supported
 * (no warning we can't back up).
 */
export function agentSupports(
  agentVersion: string | null | undefined,
  sourceType: string,
  fields: readonly string[] = [],
): { ok: boolean; needs?: string } {
  if (!agentVersion) return { ok: true };
  let needs: string | undefined = (SOURCE_TYPE_MIN_AGENT_VERSION as Record<string, string>)[sourceType];
  const fieldMins = (SOURCE_FIELD_MIN_AGENT_VERSION as Record<string, Record<string, string> | undefined>)[sourceType];
  for (const f of fields) {
    const min = fieldMins?.[f];
    if (min && (!needs || compareAgentVersions(min, needs) === 1)) needs = min;
  }
  if (!needs) return { ok: true };
  const cmp = compareAgentVersions(agentVersion, needs);
  if (cmp === null || cmp >= 0) return { ok: true };
  return { ok: false, needs };
}
