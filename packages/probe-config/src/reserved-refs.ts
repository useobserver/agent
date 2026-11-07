// Env var names a metric config may never use as a secret ref.
//
// A probe sends a ref's value to the target the same config chooses, so a ref
// that named one of the agent's own credentials would let anyone who can write
// a metric read it. The agent refuses these at runtime (apps/agent
// src/sources/_ref-policy.ts); this list makes the cloud refuse them at save
// time too, with a clear message.
//
// Kept in sync with the agent runtime contract (@observer/protocol
// isAgentInternalSecretEnv: secret vars owned by the agent or the prober) by
// apps/agent/tests/ref-policy.test.ts. This package has no dependency on
// @observer/protocol, hence the copy.
export const RESERVED_AGENT_SECRET_REFS: readonly string[] = Object.freeze([
  "AGENT_KEY",
  "PROMETHEUS_PASSWORD",
  "PROMETHEUS_BEARER_TOKEN",
  "PROMETHEUS_HEADERS",
  "DEBUG_DASHBOARD_TOKEN",
  "OBSERVER_OTLP_BEARER_TOKEN",
  "OBSERVER_PROBER_KEY",
]);

const RESERVED = new Set(RESERVED_AGENT_SECRET_REFS);

export function isReservedAgentSecretRef(name: unknown): boolean {
  return typeof name === "string" && RESERVED.has(name);
}

const REF_FIELD = /_ref$/;
const REF_MAP_FIELDS = new Set(["header_refs", "metadata_refs"]);

/** Every env var name a source_config references (top-level *_ref fields and
 *  header_refs / metadata_refs values). */
export function configRefNames(config: unknown): string[] {
  if (!config || typeof config !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    if (REF_FIELD.test(k) && typeof v === "string") out.push(v);
    else if (REF_MAP_FIELDS.has(k) && v && typeof v === "object") {
      for (const r of Object.values(v as Record<string, unknown>)) if (typeof r === "string") out.push(r);
    }
  }
  return out;
}
