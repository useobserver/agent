// Validation responsibilities by layer:
//   - Storage: enum check on source_type, opaque jsonb on source_config.
//   - App: shape-validates source_config per source_type before write.
//   - Agent: re-validates at execute() time as a defensive check
//     (config can be edited out-of-band by privileged ops).

import type { ZodTypeAny } from "zod";
import {
  PrometheusConfigSchema,
  HttpConfigSchema,
  TcpConfigSchema,
  DnsConfigSchema,
  TlsCertConfigSchema,
  IcmpConfigSchema,
  GrpcConfigSchema,
  WebsocketConfigSchema,
  MtlsHttpConfigSchema,
  DatabaseConfigSchema,
} from "./schemas";
import { PROBE_TYPES, type ProbeType } from "./probe-types";

const SCHEMAS: Record<ProbeType, ZodTypeAny> = {
  prometheus: PrometheusConfigSchema,
  http: HttpConfigSchema,
  tcp: TcpConfigSchema,
  dns: DnsConfigSchema,
  icmp: IcmpConfigSchema,
  tls_cert: TlsCertConfigSchema,
  grpc: GrpcConfigSchema,
  websocket: WebsocketConfigSchema,
  mtls_http: MtlsHttpConfigSchema,
  database: DatabaseConfigSchema,
};

// Returns the Zod schema for a given source_type, or undefined if the
// type is not in PROBE_TYPES. UI form construction uses this to drive
// the right field component per probe.
export function getConfigSchema(sourceType: string): ZodTypeAny | undefined {
  return SCHEMAS[sourceType as ProbeType];
}

export interface ProbeWriteValues {
  source_type?: string;
  sourceType?: string;
  source_config?: unknown;
  sourceConfig?: unknown;
  [k: string]: unknown;
}

export type ProbeWriteResult =
  | { ok: true; data?: { sourceType: string; sourceConfig: unknown } }
  | {
      ok: false;
      code: "incomplete_probe_update" | "unknown_source_type" | "invalid_probe_config";
      message: string;
      issues?: unknown;
    };

// Validate a write payload that targets a metric definition. Accepts
// both snake_case and camelCase keys so callers can pass straight from
// the server action without normalising.
//
// Returns:
//   { ok: true, data: { sourceType, sourceConfig } }   — validated + normalised
//   { ok: true }                                       — payload doesn't touch probe fields
//   { ok: false, code, message, issues? }              — rejection
//
// Behaviour:
//   - If neither source_type nor source_config is in the payload, returns
//     ok:true with no data (caller can pass through unchanged — this is
//     a non-probe update such as a title rename).
//   - If exactly one of the two is in the payload, rejects with
//     `incomplete_probe_update`. Updating one without the other risks
//     mismatching shape and stored type.
//   - If both are present, picks the schema by source_type and parses
//     source_config. On success, returns the parsed config (defaults
//     filled in). On failure, returns Zod issues for the UI.
export function validateProbeWrite(values: ProbeWriteValues | null | undefined): ProbeWriteResult {
  const sourceType = values?.source_type ?? values?.sourceType;
  const sourceConfig = values?.source_config ?? values?.sourceConfig;
  const hasType = sourceType !== undefined;
  const hasConfig = sourceConfig !== undefined;

  if (!hasType && !hasConfig) {
    return { ok: true };
  }

  if (hasType !== hasConfig) {
    return {
      ok: false,
      code: "incomplete_probe_update",
      message: "source_type and source_config must be provided together.",
    };
  }

  const schema = getConfigSchema(sourceType as string);
  if (!schema) {
    return {
      ok: false,
      code: "unknown_source_type",
      message: `Unknown source_type "${sourceType}". Allowed: ${PROBE_TYPES.join(", ")}.`,
    };
  }

  const result = schema.safeParse(sourceConfig);
  if (!result.success) {
    return {
      ok: false,
      code: "invalid_probe_config",
      message: `Invalid source_config for source_type "${sourceType}".`,
      issues: result.error.issues,
    };
  }

  return {
    ok: true,
    data: { sourceType: sourceType as string, sourceConfig: result.data },
  };
}
