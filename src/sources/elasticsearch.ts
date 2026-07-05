// Elasticsearch / OpenSearch log-derived metric source
//
// Pull-mode. POSTs one search (size:0) with the customer's query + aggs
// to /{index}/_search and reads a named aggregation's numeric value.
// Observer never stores documents. OpenSearch uses the same search API
// (flavor only changes UI copy).
//
// Auth secrets are read from the agent environment by reference
// (env-var-reference pattern): the cloud stores only the env-var NAME; the token /
// password / API key never leaves the agent or appears in metadata.

import type { AgentEnv, ProbeResult, ProbeSource } from "../types.ts";
import { EsConfigSchema, type EsConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(EsConfigSchema, config);
}

function classifyHttpError(error: unknown, status?: number): string {
  if (status === 401 || status === 403) return "es_unauthorized";
  if (status === 404) return "es_index_not_found";
  if (status === 400 || status === 422) return "es_query_error";
  if (typeof status === "number" && status >= 500 && status < 600) return "es_server_error";
  const e = error as { code?: string; cause?: { code?: string }; name?: string } | null | undefined;
  if (e?.name === "AbortError") return "es_timeout";
  const code = e?.code ?? e?.cause?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ETIMEDOUT") {
    return "es_unreachable";
  }
  return "es_error";
}

// ES error bodies are structured JSON ({ error: { type, reason } }).
// Pull a short, safe message (ES's text about the query, not our
// credential) for the metric metadata.
function esErrorText(body: string): string {
  const trimmed = (body || "").trim();
  if (!trimmed) return "";
  try {
    const j = JSON.parse(trimmed);
    const err = j?.error;
    if (err && typeof err === "object") {
      const reason = err.reason ?? err.type ?? "";
      const type = err.type ?? "";
      return String(reason || type || trimmed).slice(0, 500);
    }
    return String(j?.message ?? trimmed).slice(0, 500);
  } catch {
    return trimmed.slice(0, 500);
  }
}

function buildHeaders(
  config: EsConfig,
  env: NodeJS.ProcessEnv,
): { ok: true; headers: Record<string, string> } | { ok: false; reason: string; detail?: string } {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const mode = config.auth_mode ?? "none";
  if (mode === "bearer") {
    const token = config.token_ref ? env[config.token_ref] : undefined;
    if (!token) return { ok: false, reason: "es_auth_ref_missing", detail: config.token_ref };
    headers.Authorization = `Bearer ${token}`;
  } else if (mode === "basic") {
    const pass = config.password_ref ? env[config.password_ref] : undefined;
    if (!pass) return { ok: false, reason: "es_auth_ref_missing", detail: config.password_ref };
    headers.Authorization = `Basic ${Buffer.from(`${config.username}:${pass}`).toString("base64")}`;
  } else if (mode === "api_key") {
    const key = config.api_key_ref ? env[config.api_key_ref] : undefined;
    if (!key) return { ok: false, reason: "es_auth_ref_missing", detail: config.api_key_ref };
    headers.Authorization = `ApiKey ${key}`;
  }
  return { ok: true, headers };
}

// Read the numeric value out of a named aggregation result. Handles
// single-value aggs (.value) and percentiles (.values["95.0"]).
function extractAggValue(
  agg: unknown,
  percentile: string | undefined,
): { ok: true; value: number } | { ok: false; reason: string } {
  if (!agg || typeof agg !== "object") return { ok: false, reason: "es_agg_unsupported" };
  const a = agg as { value?: unknown; values?: Record<string, unknown> };

  if ("value" in a) {
    if (a.value === null || a.value === undefined) return { ok: false, reason: "es_no_data" };
    const n = Number(a.value);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, reason: "es_no_data" };
  }

  if (a.values && typeof a.values === "object") {
    // percentiles: pick the requested key, or the sole key if only one.
    const keys = Object.keys(a.values);
    let key = percentile;
    if (key && !(key in a.values)) {
      // ES keys percentiles as "95.0"; accept "95" too.
      const alt = keys.find((k) => parseFloat(k) === parseFloat(key as string));
      key = alt;
    }
    if (!key) {
      if (keys.length === 1) key = keys[0];
      else return { ok: false, reason: "es_agg_unsupported" };
    }
    const raw = a.values[key];
    const n = Number(raw);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, reason: "es_no_data" };
  }

  return { ok: false, reason: "es_agg_unsupported" };
}

export async function execute(config: EsConfig, _env: AgentEnv = {}): Promise<ProbeResult> {
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

  const url = `${config.base_url.replace(/\/$/, "")}/${encodeURIComponent(config.index)}/_search`;
  // Force size:0 — we only want the aggregation, never the documents.
  const body = JSON.stringify({ ...(config.query as Record<string, unknown>), size: 0 });

  const controller = new AbortController();
  const timeoutMs = config.timeout_ms ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { method: "POST", headers: headerResult.headers, body, signal: controller.signal });
    if (!res.ok) {
      let detail = "";
      try {
        detail = esErrorText(await res.text());
      } catch {
        /* body unreadable */
      }
      return {
        value: null,
        timestamp: ts(),
        status_hint: "no_data",
        reason: classifyHttpError(null, res.status),
        metadata: { base_url: config.base_url, index: config.index, http_status: res.status, ...(detail ? { error: detail } : {}) },
      };
    }

    const data = (await res.json()) as { aggregations?: Record<string, unknown> };
    const aggs = data?.aggregations;
    const meta = { base_url: config.base_url, index: config.index, agg_name: config.agg_name };
    if (!aggs || typeof aggs !== "object" || !(config.agg_name in aggs)) {
      return {
        value: null,
        timestamp: ts(),
        status_hint: "no_data",
        reason: "es_agg_not_found",
        metadata: { ...meta, available: aggs ? Object.keys(aggs).slice(0, 20) : [] },
      };
    }

    const extracted = extractAggValue(aggs[config.agg_name], config.percentile);
    if (!extracted.ok) {
      return { value: null, timestamp: ts(), status_hint: "no_data", reason: extracted.reason, metadata: meta };
    }
    return { value: extracted.value, timestamp: ts(), metadata: meta };
  } catch (error) {
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: classifyHttpError(error),
      metadata: { base_url: config.base_url, index: config.index },
    };
  } finally {
    // In finally — not right after fetch resolves — so the abort signal
    // also covers the body read (res.json/text can hang on a stalled stream).
    clearTimeout(timer);
  }
}

const source: ProbeSource<EsConfig> = { execute, validateConfig };
export default source;
