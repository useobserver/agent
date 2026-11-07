// Which env vars a cloud-supplied secret ref may resolve.
//
// A metric config names an env var (header_refs, metadata_refs, token_ref,
// password_ref, api_key_ref, *_cert_ref, connection_string_ref) and the probe
// sends its value to a target the same config chooses. Two limits:
//
// 1. The agent's own credentials are never resolvable (AGENT_KEY,
//    OBSERVER_PROBER_KEY, DEBUG_DASHBOARD_TOKEN, OBSERVER_OTLP_BEARER_TOKEN,
//    PROMETHEUS_* secrets): see isAgentInternalSecretEnv in
//    @observer/protocol. Otherwise anyone who can write a metric could read
//    them by pointing a probe at their own URL.
// 2. Optional allowlist: when OBSERVER_PROBE_SECRET_REFS is set (comma-separated
//    names, a trailing * matches a prefix, e.g. "DB_DSN,PROBE_*"), only those
//    names resolve. Unset keeps today's behaviour minus (1).
//
// A refused name reads as unset, so every source reports its existing
// *_ref_missing reason and nothing new crosses the wire.
import { isAgentInternalSecretEnv } from "@observer/protocol";

function allowlist(env: NodeJS.ProcessEnv): string[] | null {
  const raw = env.OBSERVER_PROBE_SECRET_REFS;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isProbeRefAllowed(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name === "OBSERVER_PROBE_SECRET_REFS") return false;
  if (isAgentInternalSecretEnv(name)) return false;
  const list = allowlist(env);
  if (!list) return true;
  return list.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

/** The value of a cloud-named env ref, or undefined when unset or refused. */
export function readProbeRef(name: string | undefined | null, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!name || !isProbeRefAllowed(name, env)) return undefined;
  return env[name];
}
