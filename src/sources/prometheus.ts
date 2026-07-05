// Prometheus probe source.

import type { AgentEnv, ProbeResult, ProbeSource } from "../types.ts";
import { PrometheusConfigSchema, type PrometheusConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";

function classifyHttpError(error: unknown, status?: number): string {
  if (status === 401 || status === 403) return "Unauthorized";
  if (status === 400) return "BadQuery";
  if (typeof status === "number" && status >= 500 && status < 600) return "PromUpstream";
  const e = error as { code?: string; cause?: { code?: string }; name?: string } | null | undefined;
  if (e?.code === "ECONNREFUSED") return "ECONNREFUSED";
  if (e?.code === "ECONNABORTED" || e?.code === "ETIMEDOUT") return "ETIMEDOUT";
  if (e?.code === "ENOTFOUND" || e?.code === "EAI_AGAIN") return "DNS";
  if (e?.cause?.code) return e.cause.code;
  if (e?.code) return e.code;
  if (e?.name === "AbortError") return "ETIMEDOUT";
  if (e?.name && e.name !== "Error") return e.name;
  return "AgentInternal";
}

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(PrometheusConfigSchema, config);
}

export async function execute(config: PrometheusConfig, env: AgentEnv = {}): Promise<ProbeResult> {
  const ts = (): string => new Date().toISOString();
  const url = config.prometheus_url || env.prometheusUrl;
  if (!url) {
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: "prometheus_url_missing" };
  }

  // Guard the URL construction — a malformed PROMETHEUS_SERVER_URL would throw
  // a TypeError out of execute(), violating the "sources never throw" contract
  // the dispatcher relies on.
  let queryUrl: URL;
  try {
    queryUrl = new URL(`${url.replace(/\/$/, "")}/api/v1/query`);
  } catch {
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: "invalid_prometheus_url" };
  }
  queryUrl.searchParams.set("query", config.query);

  const headers: Record<string, string> = {};
  if (env.prometheusBasicAuthEnabled && env.prometheusUsername && env.prometheusPassword) {
    const basic = Buffer.from(`${env.prometheusUsername}:${env.prometheusPassword}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  }

  const controller = new AbortController();
  const timeoutMs = env.prometheusTimeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(queryUrl, { headers, signal: controller.signal });
    if (!res.ok) {
      return { value: null, timestamp: ts(), status_hint: "no_data", reason: classifyHttpError(null, res.status) };
    }
    const data = (await res.json()) as { data?: { result?: Array<{ value?: [string, string] }> } };
    const result = data?.data?.result;
    if (!Array.isArray(result) || result.length === 0 || !result[0].value) {
      return { value: null, timestamp: ts(), status_hint: "no_data", reason: "no_data_for_query" };
    }
    // An instant query returning more than one series is ambiguous —
    // picking result[0] silently renders an arbitrary series as truth.
    // Mirror the loki source: typed no_data reason instead.
    if (result.length > 1) {
      return {
        value: null,
        timestamp: ts(),
        status_hint: "no_data",
        reason: "prom_multiple_series",
        metadata: { series: result.length },
      };
    }
    const [tstamp, value] = result[0].value;
    const num = parseFloat(value);
    if (!Number.isFinite(num)) {
      return { value: null, timestamp: ts(), status_hint: "no_data", reason: "no_data_for_query" };
    }
    // Guard the sample timestamp: a malformed one must not produce an
    // Invalid Date ISO string downstream. Fall back to now.
    const tsNum = parseFloat(tstamp);
    return {
      value: num,
      timestamp: Number.isFinite(tsNum) ? new Date(tsNum * 1000).toISOString() : ts(),
    };
  } catch (error) {
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: classifyHttpError(error) };
  } finally {
    // In finally — not right after fetch resolves — so the abort signal
    // also covers the body read (res.json can hang on a stalled stream).
    clearTimeout(timer);
  }
}

const source: ProbeSource<PrometheusConfig> = { execute, validateConfig };
export default source;
