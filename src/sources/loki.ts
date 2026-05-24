// Loki log-derived metric source.
//
// Pull-mode. Runs one LogQL instant query per cron tick against Loki's
// /loki/api/v1/query endpoint and reports the single numeric result.
// Observer never stores log lines: the query must be a metric
// aggregation. A raw log query returns resultType "streams", which we
// reject as loki_not_aggregation (belt-and-suspenders alongside the
// save-time schema refine).
//
// Auth secrets are read from the agent environment by reference
// (env-var-reference pattern): the cloud stores only the env-var NAME, the agent
// resolves the value here, and the token never leaves the agent or
// appears in logs / ProbeResult metadata.

import type { AgentEnv, ProbeResult, ProbeSource } from "../types.ts";
import { LokiConfigSchema, type LokiConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(LokiConfigSchema, config);
}

function classifyHttpError(error: unknown, status?: number): string {
  if (status === 401 || status === 403) return "loki_unauthorized";
  if (status === 400 || status === 422) return "loki_query_error";
  if (typeof status === "number" && status >= 500 && status < 600) return "loki_server_error";
  const e = error as { code?: string; cause?: { code?: string }; name?: string } | null | undefined;
  if (e?.name === "AbortError") return "loki_timeout";
  const code = e?.code ?? e?.cause?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ETIMEDOUT") {
    return "loki_unreachable";
  }
  return "loki_error";
}

// Build the Authorization + tenant headers. Returns an error reason
// when a referenced env var is unset, so a misconfig surfaces clearly
// rather than as a silent 401.
function buildHeaders(
  config: LokiConfig,
  env: NodeJS.ProcessEnv,
): { ok: true; headers: Record<string, string> } | { ok: false; reason: string; detail?: string } {
  const headers: Record<string, string> = {};
  if (config.tenant_id) headers["X-Scope-OrgID"] = config.tenant_id;

  const mode = config.auth_mode ?? "none";
  if (mode === "bearer") {
    const token = config.token_ref ? env[config.token_ref] : undefined;
    if (!token) return { ok: false, reason: "loki_auth_ref_missing", detail: config.token_ref };
    headers.Authorization = `Bearer ${token}`;
  } else if (mode === "basic") {
    const pass = config.password_ref ? env[config.password_ref] : undefined;
    if (!pass) return { ok: false, reason: "loki_auth_ref_missing", detail: config.password_ref };
    headers.Authorization = `Basic ${Buffer.from(`${config.username}:${pass}`).toString("base64")}`;
  }
  return { ok: true, headers };
}

// Loki error bodies are sometimes plain text, sometimes JSON. Pull a
// short, safe message (this is Loki's text about the query, not our
// token) for the metric metadata.
function lokiErrorText(body: string): string {
  const trimmed = (body || "").trim();
  if (!trimmed) return "";
  try {
    const j = JSON.parse(trimmed);
    const msg = j?.message ?? j?.error ?? trimmed;
    return String(msg).slice(0, 500);
  } catch {
    return trimmed.slice(0, 500);
  }
}

export async function execute(config: LokiConfig, _env: AgentEnv = {}): Promise<ProbeResult> {
  const ts = (): string => new Date().toISOString();

  const headerResult = buildHeaders(config, process.env);
  if (!headerResult.ok) {
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: headerResult.reason,
      metadata: { base_url: config.base_url, ...(headerResult.detail ? { auth_ref: headerResult.detail } : {}) },
    };
  }

  const queryUrl = new URL(`${config.base_url.replace(/\/$/, "")}/loki/api/v1/query`);
  queryUrl.searchParams.set("query", config.query);

  const controller = new AbortController();
  const timeoutMs = config.timeout_ms ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(queryUrl, { headers: headerResult.headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      let detail = "";
      try {
        detail = lokiErrorText(await res.text());
      } catch {
        /* body unreadable */
      }
      return {
        value: null,
        timestamp: ts(),
        status_hint: "no_data",
        reason: classifyHttpError(null, res.status),
        metadata: { base_url: config.base_url, http_status: res.status, ...(detail ? { error: detail } : {}) },
      };
    }

    const data = (await res.json()) as {
      data?: { resultType?: string; result?: unknown };
    };
    const resultType = data?.data?.resultType;
    const result = data?.data?.result;
    const meta = { base_url: config.base_url, result_type: resultType };

    // A raw log query (no aggregation) returns streams. Reject — the
    // probe needs a numeric metric, not log lines.
    if (resultType === "streams") {
      return { value: null, timestamp: ts(), status_hint: "no_data", reason: "loki_not_aggregation", metadata: meta };
    }

    // Instant metric query => "vector": array of { metric, value:[ts,"n"] }.
    if (resultType === "vector") {
      if (!Array.isArray(result) || result.length === 0) {
        return { value: null, timestamp: ts(), status_hint: "no_data", reason: "loki_no_data", metadata: meta };
      }
      if (result.length > 1) {
        return {
          value: null,
          timestamp: ts(),
          status_hint: "no_data",
          reason: "loki_multiple_series",
          metadata: { ...meta, series: result.length },
        };
      }
      const value = (result[0] as { value?: [string, string] }).value;
      if (!value) {
        return { value: null, timestamp: ts(), status_hint: "no_data", reason: "loki_no_data", metadata: meta };
      }
      const num = parseFloat(value[1]);
      if (!Number.isFinite(num)) {
        return { value: null, timestamp: ts(), status_hint: "no_data", reason: "loki_no_data", metadata: meta };
      }
      return { value: num, timestamp: new Date(parseFloat(value[0]) * 1000).toISOString(), metadata: meta };
    }

    // "scalar": result is [ts, "n"]. Use Loki's timestamp (the data
    // collection time), not the probe's execution time, to match the
    // vector path and keep history aligned.
    if (resultType === "scalar" && Array.isArray(result) && result.length === 2) {
      const scalar = result as [number, string];
      const num = parseFloat(String(scalar[1]));
      if (!Number.isFinite(num)) {
        return { value: null, timestamp: ts(), status_hint: "no_data", reason: "loki_no_data", metadata: meta };
      }
      return { value: num, timestamp: new Date(parseFloat(String(scalar[0])) * 1000).toISOString(), metadata: meta };
    }

    // matrix or anything unexpected from an instant query.
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: "loki_bad_response", metadata: meta };
  } catch (error) {
    clearTimeout(timer);
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: classifyHttpError(error),
      metadata: { base_url: config.base_url },
    };
  }
}

const source: ProbeSource<LokiConfig> = { execute, validateConfig };
export default source;
