// Request headers and URL for the Prometheus source, shared by every
// Prometheus-compatible backend (Prometheus, Grafana Mimir, Cortex, Thanos,
// VictoriaMetrics, Grafana Cloud).
//
//   PROMETHEUS_BASIC_AUTH_ENABLED + PROMETHEUS_USERNAME / PROMETHEUS_PASSWORD
//                              → Authorization: Basic …
//   PROMETHEUS_BEARER_TOKEN    → Authorization: Bearer … (exclusive with basic)
//   PROMETHEUS_TENANT_ID       → X-Scope-OrgID (Mimir / Cortex multi-tenancy)
//   PROMETHEUS_HEADERS         → anything else: a JSON object, or a
//                                "Name: value; Name2: value" list
//
// Header VALUES are credentials (a tenant id can be one too): they never
// reach a log line. describePrometheusAuth / redactPrometheusHeaders render
// names only, the same rule as the PromQL redaction in index.ts.

export interface PrometheusAuthEnv {
  prometheusBasicAuthEnabled?: boolean;
  prometheusUsername?: string;
  prometheusPassword?: string;
  prometheusBearerToken?: string;
  prometheusTenantId?: string;
  prometheusHeaders?: string;
}

export type PrometheusHeadersResult =
  | { ok: true; headers: Record<string, string>; secretValues: string[] }
  | { ok: false; reason: "prometheus_auth_conflict" | "prometheus_headers_invalid"; error: string };

export const TENANT_HEADER = "X-Scope-OrgID";

// RFC 7230 token: what a header name may contain.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Parse PROMETHEUS_HEADERS. Accepts a JSON object of string values or a
 * "Name: value; Name2: value" list (also newline-separated). Errors name the
 * offending header, never its value.
 */
export function parsePrometheusHeaders(
  raw: string | undefined,
): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  const s = (raw ?? "").trim();
  if (!s) return { ok: true, headers: {} };
  const out: Record<string, string> = {};
  const add = (name: string, value: unknown): string | null => {
    const n = name.trim();
    if (!HEADER_NAME.test(n)) return `PROMETHEUS_HEADERS: "${n.slice(0, 64)}" is not a valid header name.`;
    if (typeof value !== "string" && typeof value !== "number") return `PROMETHEUS_HEADERS: the value of ${n} must be a string.`;
    const v = String(value).trim();
    if (/[\r\n]/.test(v)) return `PROMETHEUS_HEADERS: the value of ${n} contains a line break.`;
    out[n] = v;
    return null;
  };
  if (s.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      return { ok: false, error: "PROMETHEUS_HEADERS: not valid JSON (expected an object such as {\"X-Org\": \"…\"})." };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "PROMETHEUS_HEADERS: the JSON must be an object of header names to values." };
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const err = add(k, v);
      if (err) return { ok: false, error: err };
    }
    return { ok: true, headers: out };
  }
  for (const part of s.split(/[;\n]/)) {
    if (!part.trim()) continue;
    const i = part.indexOf(":");
    if (i <= 0) return { ok: false, error: "PROMETHEUS_HEADERS: use \"Name: value; Name2: value\" or a JSON object." };
    const err = add(part.slice(0, i), part.slice(i + 1));
    if (err) return { ok: false, error: err };
  }
  return { ok: true, headers: out };
}

const has = (o: Record<string, string>, name: string): boolean =>
  Object.keys(o).some((k) => k.toLowerCase() === name.toLowerCase());

/** Basic auth is in effect: enabled AND a password is set (the agent's long-standing rule). */
export function basicAuthActive(env: PrometheusAuthEnv): boolean {
  return !!(env.prometheusBasicAuthEnabled && env.prometheusUsername && env.prometheusPassword);
}

/**
 * Build the request headers. Bearer and basic auth are mutually exclusive,
 * and PROMETHEUS_HEADERS may not set Authorization (or X-Scope-OrgID) when
 * the dedicated variable already does.
 */
export function buildPrometheusHeaders(env: PrometheusAuthEnv): PrometheusHeadersResult {
  const extra = parsePrometheusHeaders(env.prometheusHeaders);
  if (!extra.ok) return { ok: false, reason: "prometheus_headers_invalid", error: extra.error };

  const bearer = (env.prometheusBearerToken ?? "").trim();
  const basic = basicAuthActive(env);
  if (bearer && basic) {
    return {
      ok: false,
      reason: "prometheus_auth_conflict",
      error:
        "PROMETHEUS_BEARER_TOKEN and basic auth (PROMETHEUS_BASIC_AUTH_ENABLED with PROMETHEUS_PASSWORD) are both set. " +
        "Use one: unset PROMETHEUS_PASSWORD or set PROMETHEUS_BASIC_AUTH_ENABLED=false for a bearer token.",
    };
  }
  const tenant = (env.prometheusTenantId ?? "").trim();
  if ((bearer || basic) && has(extra.headers, "Authorization")) {
    return {
      ok: false,
      reason: "prometheus_auth_conflict",
      error: "PROMETHEUS_HEADERS sets Authorization while PROMETHEUS_BEARER_TOKEN or basic auth also does. Use one.",
    };
  }
  if (tenant && has(extra.headers, TENANT_HEADER)) {
    return {
      ok: false,
      reason: "prometheus_auth_conflict",
      error: `PROMETHEUS_HEADERS sets ${TENANT_HEADER} while PROMETHEUS_TENANT_ID also does. Use one.`,
    };
  }

  const headers: Record<string, string> = { ...extra.headers };
  const secretValues: string[] = Object.values(extra.headers).filter(Boolean);
  if (basic) {
    const token = Buffer.from(`${env.prometheusUsername}:${env.prometheusPassword}`).toString("base64");
    headers.Authorization = `Basic ${token}`;
    secretValues.push(String(env.prometheusPassword), token);
  } else if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
    secretValues.push(bearer);
  }
  if (tenant) {
    headers[TENANT_HEADER] = tenant;
    secretValues.push(tenant);
  }
  return { ok: true, headers, secretValues };
}

/** Header names with every value replaced: safe to log. */
export function redactPrometheusHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(headers).map((k) => [k, "[redacted]"]));
}

/** One log-safe line describing the auth in effect (names only, never values). */
export function describePrometheusAuth(env: PrometheusAuthEnv): string {
  const built = buildPrometheusHeaders(env);
  if (!built.ok) return `invalid (${built.reason})`;
  const parts: string[] = [];
  if (basicAuthActive(env)) parts.push("basic auth");
  else if ((env.prometheusBearerToken ?? "").trim()) parts.push("bearer token");
  else parts.push("no auth");
  if ((env.prometheusTenantId ?? "").trim()) parts.push(`tenant header ${TENANT_HEADER}`);
  const extra = Object.keys(parseHeadersOrEmpty(env.prometheusHeaders));
  if (extra.length) parts.push(`extra headers: ${extra.join(", ")}`);
  return parts.join(", ");
}

function parseHeadersOrEmpty(raw: string | undefined): Record<string, string> {
  const r = parsePrometheusHeaders(raw);
  return r.ok ? r.headers : {};
}

/**
 * The instant-query URL under a base that may carry a path prefix
 * (https://mimir.example.com/prometheus, Grafana Cloud's /api/prom). The
 * prefix is kept; trailing slashes are dropped, and a base that already ends
 * in /api/v1 or /api/v1/query is not doubled. Throws on a malformed base
 * (the caller maps that to no_data).
 */
export function prometheusQueryUrl(base: string, query: string): URL {
  const u = new URL(base.trim());
  let path = u.pathname.replace(/\/+$/, "");
  path = path.replace(/\/api\/v1(\/query)?$/, "");
  u.pathname = `${path}/api/v1/query`;
  u.hash = "";
  u.searchParams.set("query", query);
  return u;
}
