// single dispatch site for probe sources.

import type { AgentEnv, MetricDefinition, ProbeResult, ProbeSource, SourceType } from "../types.ts";
import * as prometheus from "./prometheus.ts";
import * as http from "./http.ts";
import * as tcp from "./tcp.ts";
import * as dns from "./dns.ts";
import * as tls_cert from "./tls_cert.ts";
import * as icmp from "./icmp.ts";
import * as grpc from "./grpc.ts";
import * as websocket from "./websocket.ts";
import * as mtls_http from "./mtls_http.ts";
import * as database from "./database.ts";

// Each module imports as a namespace; we cast the discovered shape to
// the generic ProbeSource interface. Strictly typing per-config flow
// requires per-source type registration, which complicates the
// dispatcher without buying anything at runtime.
export const SOURCES: Record<SourceType, ProbeSource<any>> = {
  prometheus: prometheus as unknown as ProbeSource<any>,
  http: http as unknown as ProbeSource<any>,
  tcp: tcp as unknown as ProbeSource<any>,
  dns: dns as unknown as ProbeSource<any>,
  tls_cert: tls_cert as unknown as ProbeSource<any>,
  icmp: icmp as unknown as ProbeSource<any>,
  grpc: grpc as unknown as ProbeSource<any>,
  websocket: websocket as unknown as ProbeSource<any>,
  mtls_http: mtls_http as unknown as ProbeSource<any>,
  database: database as unknown as ProbeSource<any>,
};

export function getSource(sourceType: string): ProbeSource | undefined {
  return SOURCES[sourceType as SourceType];
}

export async function execute(metricDef: MetricDefinition, env: AgentEnv = {}): Promise<ProbeResult> {
  const ts = (): string => new Date().toISOString();
  const sourceType = metricDef?.source_type || "prometheus";
  const config: Record<string, unknown> =
    metricDef?.source_config && typeof metricDef.source_config === "object"
      ? { ...metricDef.source_config }
      : {};

  // Legacy fallback: prometheus rows pre-21.1 may not have query
  // mirrored into source_config yet. Pull it from the top-level column.
  if (sourceType === "prometheus" && !config.query && typeof metricDef?.query === "string") {
    config.query = metricDef.query;
  }

  const source = getSource(sourceType);
  if (!source) {
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: "unknown_source_type",
      metadata: { source_type: sourceType },
    };
  }

  const validationError = source.validateConfig(config);
  if (validationError) {
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: "invalid_config",
      metadata: { source_type: sourceType, error: validationError },
    };
  }

  return await source.execute(config, env);
}

export default { execute, getSource, SOURCES };
