// Agent runtime contract (compat C5): every environment variable, port, path
// and image fact that something outside the agent depends on. Consumers: the
// Helm chart, PaaS deploy templates, the install script, the console's install
// snippets (apps/web lib/agent-snippets.ts) and env catalog (lib/agent-env.ts),
// the agent README and the public docs.
//
// Change rules (CLAUDE.md "Compatibility contracts"): add a var here in the
// same PR the agent starts reading it; a rename keeps the old name in
// `aliases` for two minor releases; never change a default. Enforced by
// apps/agent/tests/runtime-contract.test.ts (agent code ⇔ this list) and the
// deploy-targets tests in apps/web.

export type AgentEnvScope =
  // Read by the org agent (src/index.ts and the modules it starts).
  | "agent"
  // Read only by Observer's own managed prober (src/prober). Customers never set these.
  | "prober"
  // Honored by the Bun runtime or a bundled SDK, not by agent code.
  | "runtime"
  // Read by one probe source at execute time, e.g. "source:azure_monitor".
  | `source:${string}`;

// `secret` means the value must never appear literally in a template, snippet
// or log: it is set on the agent host (a platform secret, a Kubernetes Secret,
// an env file). Non-secret values may be written into templates.
export interface AgentEnvVar {
  name: string;
  /** The agent's own default, as a string. null = unset (no default). */
  default: string | null;
  required: boolean;
  secret: boolean;
  /** First agent version that reads it. Vars older than 1.6.0 say "1.6.0". */
  since: string;
  scope: AgentEnvScope;
  /** Old names still honored after a rename. */
  aliases?: string[];
  deprecated?: { since: string; removeAfter: string; replacement?: string };
}

const v = (
  name: string,
  def: string | null,
  scope: AgentEnvScope,
  opts: { required?: boolean; secret?: boolean; since?: string } = {},
): AgentEnvVar => ({
  name,
  default: def,
  required: opts.required ?? false,
  secret: opts.secret ?? false,
  since: opts.since ?? "1.6.0",
  scope,
});

export const AGENT_ENV: readonly AgentEnvVar[] = Object.freeze([
  // Core
  v("AGENT_KEY", null, "agent", { required: true, secret: true }),
  v("CLOUD_SERVER_URL", "https://use.observer", "agent"),
  // Prometheus
  v("PROMETHEUS_SERVER_URL", null, "agent"),
  v("PROMETHEUS_BASIC_AUTH_ENABLED", "true", "agent"),
  v("PROMETHEUS_USERNAME", "admin", "agent"),
  v("PROMETHEUS_PASSWORD", "", "agent", { secret: true }),
  v("PROMETHEUS_BEARER_TOKEN", null, "agent", { secret: true, since: "1.6.2" }),
  v("PROMETHEUS_TENANT_ID", null, "agent", { since: "1.6.2" }),
  v("PROMETHEUS_HEADERS", null, "agent", { secret: true, since: "1.6.2" }),
  // Logs
  v("VERBOSE", "false", "agent"),
  v("BROADCAST_LOGS", "false", "agent"),
  v("LOG_BROADCAST_LEVEL", "WARN", "agent"),
  // Connection
  v("SKIP_SSL_VERIFICATION", "false", "agent"),
  // Debug dashboard
  v("ENABLE_DEBUG_DASHBOARD", "true", "agent"),
  v("DEBUG_DASHBOARD_PORT", "10101", "agent"),
  v("DEBUG_DASHBOARD_HOST", "127.0.0.1", "agent"),
  v("DEBUG_DASHBOARD_TOKEN", null, "agent", { secret: true }),
  // Buffer
  v("BUFFER_PATH", "./observer-agent-buffer.db", "agent"),
  v("BUFFER_MAX_ROWS", "200000", "agent"),
  // Heartbeat relay
  v("HEARTBEAT_RELAY_ENABLED", "false", "agent"),
  v("HEARTBEAT_RELAY_HOST", "127.0.0.1", "agent"),
  v("HEARTBEAT_RELAY_PORT", "10102", "agent"),
  // OTLP receiver
  v("OBSERVER_OTLP_DISABLE", "false", "agent"),
  v("OBSERVER_OTLP_LISTEN_ADDR", "127.0.0.1:4318", "agent"),
  // Required when OBSERVER_OTLP_LISTEN_ADDR is not loopback.
  v("OBSERVER_OTLP_BEARER_TOKEN", null, "agent", { secret: true }),
  v("OBSERVER_OTLP_MAX_BUFFER_POINTS", "1000", "agent"),
  v("OBSERVER_OTLP_MAX_BODY_BYTES", "16777216", "agent"),
  // Probe secret refs: comma-separated env var names (trailing * = prefix) a
  // metric config may name in header_refs / token_ref / connection_string_ref
  // etc. Unset = any name except the agent's own secrets.
  v("OBSERVER_PROBE_SECRET_REFS", null, "agent", { since: "1.8.0" }),

  // Managed prober mode (src/prober/main.ts)
  v("OBSERVER_PROBER_KEY", null, "prober", { required: true, secret: true, since: "1.7.0" }),
  v("PROBER_ALLOW_INSECURE_CLOUD", "false", "prober", { since: "1.7.0" }),
  v("PROBER_LOCATION", null, "prober", { since: "1.7.0" }),
  v("PROBER_DNS_SERVERS", "1.1.1.1,8.8.8.8", "prober", { since: "1.7.0" }),
  v("PROBER_ICMP", "off", "prober", { since: "1.7.0" }),
  v("PROBER_CONCURRENCY", "32", "prober", { since: "1.7.0" }),
  v("PROBER_REFRESH_SECONDS", "30", "prober", { since: "1.7.0" }),
  v("PROBER_FLUSH_SECONDS", "5", "prober", { since: "1.7.0" }),
  v("PROBER_QUEUE_MAX", "20000", "prober", { since: "1.7.0" }),

  // Runtime / SDK (not read by agent code)
  v("HTTPS_PROXY", null, "runtime"),
  v("HTTP_PROXY", null, "runtime"),
  v("NO_PROXY", null, "runtime"),
  v("NODE_EXTRA_CA_CERTS", null, "runtime"),
  v("NODE_TLS_REJECT_UNAUTHORIZED", null, "runtime"),
  v("NODE_ENV", null, "runtime"),
  v("BUN_OPTIONS", null, "runtime"),
  // "0" turns off Bun's on-disk transpiler cache (the Helm chart sets it: the
  // root filesystem is read-only there).
  v("BUN_RUNTIME_TRANSPILER_CACHE_PATH", null, "runtime"),
  v("AWS_ACCESS_KEY_ID", null, "runtime", { secret: true }),
  v("AWS_SECRET_ACCESS_KEY", null, "runtime", { secret: true }),
  v("AWS_SESSION_TOKEN", null, "runtime", { secret: true }),
  v("AWS_PROFILE", null, "runtime"),
  v("AWS_ROLE_ARN", null, "runtime"),
  v("AWS_WEB_IDENTITY_TOKEN_FILE", null, "runtime"),
  v("AWS_REGION", null, "runtime"),
]);

export const AGENT_RUNTIME = Object.freeze({
  image: "ghcr.io/useobserver/agent",
  /** The tag PaaS templates pin: the major-version tag. */
  templateTag: "1",
  dataDir: "/data",
  bufferPath: "/data/observer-agent-buffer.db",
  /** /data in the image is owned by this UID (gid 0, mode 0770). */
  runAsUser: 65532,
  ports: Object.freeze({ dashboard: 10101, heartbeatRelay: 10102, otlp: 4318 }),
  healthPath: "/healthz",
  /** Exec probe using the image's own bun (the dashboard binds loopback). */
  healthExec: Object.freeze([
    "/usr/local/bin/bun",
    "-e",
    "fetch('http://127.0.0.1:10101/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))",
  ]),
  shutdownGraceSeconds: 5,
  /** One running process per agent key: SQLite single writer + cloud duplicate-key fencing. */
  singleReplicaPerKey: true,
  env: AGENT_ENV,
});

export function agentEnvVar(name: string): AgentEnvVar | undefined {
  return AGENT_ENV.find((e) => e.name === name || e.aliases?.includes(name));
}

// Agent-internal secrets a cloud-supplied probe config may never name as a
// secret ref (header_refs, metadata_refs, token_ref, *_cert_ref,
// connection_string_ref, ...). A probe sends a ref's value to the target the
// same config chooses, so without this any principal who can write a metric
// could read the agent's own credentials (AGENT_KEY etc.). Derived from this
// list (secret vars owned by the agent or the prober, plus aliases) so a new
// agent secret is covered automatically. Runtime/SDK secrets such as
// AWS_SECRET_ACCESS_KEY stay nameable: customers legitimately use them as
// probe credentials.
export function isAgentInternalSecretEnv(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  const e = agentEnvVar(name);
  return !!e && e.secret && (e.scope === "agent" || e.scope === "prober");
}
