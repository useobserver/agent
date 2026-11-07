// Prometheus probe source.

import type { AgentEnv, ProbeResult, ProbeSource } from "../types.ts";
import { PrometheusConfigSchema, type PrometheusConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";
import { buildPrometheusHeaders, prometheusQueryUrl } from "./prometheus-auth.ts";
import { classifyFetchError } from "./net-errors.ts";
import { parsePromInstantResult } from "./_prom-result.ts";

function classifyHttpStatus(status: number): string {
  if (status === 401 || status === 403) return "Unauthorized";
  if (status === 400) return "BadQuery";
  if (status >= 500 && status < 600) return "PromUpstream";
  return `unexpected_status:${status}`;
}

// A thrown error: network codes are normalised (Bun's ConnectionRefused,
// NXDOMAIN, resets, TLS); a JSON parse failure is a bad response; anything
// else is an agent-side bug. Never echoes an error name or message.
async function classifyThrown(error: unknown, url: URL): Promise<string> {
  if ((error as { name?: string } | null)?.name === "SyntaxError") return "prom_bad_response";
  return (await classifyFetchError(error, url, "AgentInternal")).reason;
}

function sameOrigin(target: URL, operatorUrl: string | undefined): boolean {
  if (!operatorUrl) return false;
  try {
    return new URL(operatorUrl).origin === target.origin;
  } catch {
    return false;
  }
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
    queryUrl = prometheusQueryUrl(url, config.query);
  } catch {
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: "invalid_prometheus_url" };
  }

  // Auth + tenant + extra headers. A misconfiguration (bearer AND basic, bad
  // PROMETHEUS_HEADERS) is a typed no_data, never a throw; index.ts logs the
  // explanation once at boot.
  //
  // The credentials belong to the operator's PROMETHEUS_SERVER_URL. A metric
  // may point at another Prometheus (config.prometheus_url, set from the
  // cloud); sending the operator's credentials there would hand them to
  // whoever controls that URL. So they go only to the operator's origin.
  let headers: Record<string, string> = {};
  if (sameOrigin(queryUrl, env.prometheusUrl)) {
    const built = buildPrometheusHeaders(env);
    if (!built.ok) {
      return { value: null, timestamp: ts(), status_hint: "no_data", reason: built.reason };
    }
    headers = built.headers;
  }

  const controller = new AbortController();
  const timeoutMs = env.prometheusTimeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(queryUrl, { headers, signal: controller.signal });
    if (!res.ok) {
      return { value: null, timestamp: ts(), status_hint: "no_data", reason: classifyHttpStatus(res.status), metadata: { status: res.status } };
    }
    // Vector results only (scalar: false), as this source always has: empty
    // or non-finite → no_data_for_query, several series → prom_multiple_series.
    const parsed = parsePromInstantResult(await res.json(), "prom", { scalar: false });
    if (!parsed.ok) {
      return {
        value: null,
        timestamp: ts(),
        status_hint: "no_data",
        reason: parsed.reason,
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
    }
    return { value: parsed.value, timestamp: parsed.timestamp };
  } catch (error) {
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: await classifyThrown(error, queryUrl) };
  } finally {
    // In finally — not right after fetch resolves — so the abort signal
    // also covers the body read (res.json can hang on a stalled stream).
    clearTimeout(timer);
  }
}

const source: ProbeSource<PrometheusConfig> = { execute, validateConfig };
export default source;
