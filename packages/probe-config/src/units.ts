// What a metric's sample value means, and the unit it is measured in, per
// source_type (and per sub-metric where the config selects one). The single
// source of truth for units: the console (value suffixes), the public API
// (`unit` on metric and testProbe responses) and the OpenAPI / MCP tool
// descriptions all read it. Derived from the agent sources
// (apps/agent/src/sources/*) and the cloud evaluators (heartbeat, alert).
//
// `unit` is a short display suffix ("ms", "%", "days", "B/s", "s") or null
// when the value is a bare number: a scalar whose unit is whatever the query
// returns (prometheus, otlp, cloudwatch, database, ...) or a 1/0 state.
// `description` says what the number is in plain words.

import type { ProbeType } from "./probe-types";

export interface ProbeValueUnit {
  unit: string | null;
  description: string;
}

type Config = Record<string, unknown> | null | undefined;

/** A variant selected by one source_config field (e.g. icmp.interpretation). */
interface UnitVariants {
  field: string;
  default: string;
  values: Record<string, ProbeValueUnit>;
}

interface UnitEntry extends ProbeValueUnit {
  variants?: UnitVariants;
  /** http: a json_path replaces the response time with the extracted number. */
  jsonPath?: ProbeValueUnit;
}

const AS_QUERIED = "as returned by the query; Observer does not rescale it";

const JSON_PATH: ProbeValueUnit = {
  unit: null,
  description: "the number extracted from the JSON response at json_path (booleans read as 1/0); unit as in the response",
};

export const PROBE_VALUE_UNITS: Readonly<Record<ProbeType, UnitEntry>> = Object.freeze({
  prometheus: { unit: null, description: `scalar result of the PromQL query, ${AS_QUERIED}` },
  http: { unit: "ms", description: "response time in milliseconds", jsonPath: JSON_PATH },
  mtls_http: { unit: "ms", description: "response time in milliseconds (deprecated alias of http)", jsonPath: JSON_PATH },
  tcp: { unit: "ms", description: "TCP connect time in milliseconds" },
  dns: { unit: "ms", description: "DNS resolve time in milliseconds" },
  tls_cert: { unit: "days", description: "days until the certificate expires" },
  icmp: {
    unit: "ms",
    description: "average round-trip time in milliseconds",
    variants: {
      field: "interpretation",
      default: "latency",
      values: {
        latency: { unit: "ms", description: "average round-trip time in milliseconds" },
        packet_loss: { unit: "%", description: "percentage of pings lost, 0 to 100" },
        reachability: { unit: null, description: "1 when any ping returned, 0 when none did" },
      },
    },
  },
  grpc: {
    unit: null,
    description: "1 when the health check reports SERVING, 0 when NOT_SERVING",
    variants: {
      field: "interpretation",
      default: "health_state",
      values: {
        health_state: { unit: null, description: "1 when the health check reports SERVING, 0 when NOT_SERVING" },
        latency: { unit: "ms", description: "health check round-trip time in milliseconds" },
      },
    },
  },
  websocket: {
    unit: "ms",
    description: "handshake time in milliseconds",
    variants: {
      field: "interpretation",
      default: "handshake_latency",
      values: {
        handshake_latency: { unit: "ms", description: "handshake time in milliseconds" },
        round_trip_latency: { unit: "ms", description: "message round-trip time in milliseconds" },
        connection_success: { unit: null, description: "1 when the socket opened, 0 when it did not" },
      },
    },
  },
  database: { unit: null, description: `scalar returned by the read-only query (one row, one column), ${AS_QUERIED}` },
  otlp: { unit: null, description: `aggregated value of the pushed OTLP data points, in the instrument's own unit` },
  cloudwatch: { unit: null, description: `latest CloudWatch datapoint for the chosen statistic, in the metric's CloudWatch unit` },
  loki: { unit: null, description: `scalar result of the LogQL aggregation, ${AS_QUERIED}` },
  elasticsearch: { unit: null, description: `value of the named aggregation, ${AS_QUERIED}` },
  custom: { unit: null, description: "number returned by the registered probe function, in whatever unit it uses" },
  host: {
    unit: "%",
    description: "CPU utilisation percentage, 0 to 100",
    variants: {
      field: "metric",
      default: "cpu",
      values: {
        cpu: { unit: "%", description: "CPU utilisation percentage, 0 to 100" },
        memory: { unit: "%", description: "used memory percentage, 0 to 100" },
        filesystem: { unit: "%", description: "used disk space percentage of the mountpoint, 0 to 100" },
        network: { unit: "B/s", description: "network throughput in bytes per second (received + sent)" },
        load: { unit: null, description: "1-minute load average divided by the CPU count" },
      },
    },
  },
  manual: { unit: null, description: "no measured value; the status is set by hand or by an open incident" },
  heartbeat: { unit: "s", description: "seconds since the last successful ping" },
  alert: { unit: null, description: "worst firing alert as a score: 0 none, 1 degraded, 2 unhealthy" },
});

function pick(entry: UnitEntry, config: Config): ProbeValueUnit {
  const cfg = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  if (entry.jsonPath && typeof cfg.json_path === "string" && cfg.json_path.length > 0) return entry.jsonPath;
  if (entry.variants) {
    const raw = cfg[entry.variants.field];
    const key = typeof raw === "string" && raw.length > 0 ? raw : entry.variants.default;
    const v = entry.variants.values[key];
    if (v) return v;
    // Unknown variant: no unit beats a wrong one.
    return { unit: null, description: entry.description };
  }
  return { unit: entry.unit, description: entry.description };
}

/** Unit + meaning of a metric's value, from its source_type and source_config. */
export function probeValueUnitInfo(sourceType: string | null | undefined, config?: Config): ProbeValueUnit | null {
  if (!sourceType) return null;
  const entry = (PROBE_VALUE_UNITS as Record<string, UnitEntry | undefined>)[sourceType];
  if (!entry) return null;
  return pick(entry, config);
}

/** Display suffix for a metric's value, or null for a bare number. */
export function probeValueUnit(sourceType: string | null | undefined, config?: Config): string | null {
  return probeValueUnitInfo(sourceType, config)?.unit ?? null;
}

/**
 * One line per source_type (and per variant), for API / tool descriptions:
 * "icmp: interpretation=latency ms (average round-trip ...); ...".
 */
export function describeProbeValueUnits(sourceType: string): string | null {
  const entry = (PROBE_VALUE_UNITS as Record<string, UnitEntry | undefined>)[sourceType];
  if (!entry) return null;
  const fmt = (u: ProbeValueUnit) => (u.unit ? `${u.unit}: ${u.description}` : u.description);
  if (entry.variants) {
    const parts = Object.entries(entry.variants.values).map(
      ([k, v]) => `${entry.variants!.field}=${k}${k === entry.variants!.default ? " (default)" : ""} → ${fmt(v)}`,
    );
    return `Value by ${entry.variants.field}: ${parts.join("; ")}.`;
  }
  const base = `Value: ${fmt(entry)}.`;
  return entry.jsonPath ? `${base} With json_path set: ${entry.jsonPath.description}.` : base;
}
