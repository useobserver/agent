// single dispatch site for probe sources.
//
// Two surfaces live here:
//   - `SOURCES` + `execute()` — the legacy stateless `ProbeSource`
//     contract (one-shot validate + execute). Preserved as the
//     production code path; existing tests + callers go through it.
//   - `getSourceClass(sourceType)` — the new `Source` lifecycle
//     contract (mode + validateConfig + init → SourceInstance with
//     read/dispose). This was introduced so push-mode
//     sources (OTLP, future receivers) can be wired by the scheduler
//     with the same registry call as pull sources.
//
// Pull-mode sources reuse the existing ProbeSource modules via the
// `asPullSource` adapter; push-mode sources will export a `Source`
// shape directly when they land.

import { asPullSource, type Source, type SourceInstance } from "@observer/protocol";
import type { AgentEnv, MetricDefinition, ProbeResult, ProbeSource, SourceType } from "../types.ts";
import prometheus from "./prometheus.ts";
import http from "./http.ts";
import tcp from "./tcp.ts";
import dns from "./dns.ts";
import tls_cert from "./tls_cert.ts";
import icmp from "./icmp.ts";
import grpc from "./grpc.ts";
import websocket from "./websocket.ts";
import mtls_http from "./mtls_http.ts";
import database from "./database.ts";
import otlp from "./otlp.ts";
import cloudwatch from "./cloudwatch.ts";
import custom from "./custom/index.ts";
import loki from "./loki.ts";
import elasticsearch from "./elasticsearch.ts";

// Each entry is the per-source default export typed as
// `ProbeSource<TConfig>` at the module level, narrowed to
// `ProbeSource<any>` only at the map boundary so the dispatcher
// stays generic without per-call type gymnastics.
// Legacy stateless map covers pull-mode sources. Push-mode sources
// (OTLP and later receivers) live in PUSH_SOURCES instead — they have
// no stateless `execute()` because their value comes from a long-lived
// receiver buffer, not an on-demand probe.
export const SOURCES: Partial<Record<SourceType, ProbeSource<any>>> = {
  prometheus,
  http,
  tcp,
  dns,
  tls_cert,
  icmp,
  grpc,
  websocket,
  mtls_http,
  database,
  cloudwatch,
  custom,
  loki,
  elasticsearch,
};

export function getSource(sourceType: string): ProbeSource | undefined {
  return SOURCES[sourceType as SourceType];
}

// Push-mode source registry. OTLP is the first
// entry. Receivers register `Source<TConfig>` here directly without
// touching the `SOURCES` legacy map; the dispatcher in `execute()`
// routes through the lifecycle path (init→read) instead of the
// stateless ProbeSource path.
export const PUSH_SOURCES: Partial<Record<SourceType, Source<any>>> = {
  otlp,
};

// Source-lifecycle registry. Pull-mode sources are lifted from the
// `SOURCES` legacy map via the `asPullSource` adapter; push-mode
// sources from `PUSH_SOURCES` are merged in directly. Computed once
// at module load.
export const SOURCE_CLASSES: Partial<Record<SourceType, Source<any>>> = {
  ...(Object.fromEntries(
    Object.entries(SOURCES).map(([k, probe]) => [k, asPullSource(probe as ProbeSource<any>)]),
  ) as Partial<Record<SourceType, Source<any>>>),
  ...PUSH_SOURCES,
};

export function getSourceClass(sourceType: string): Source<any> | undefined {
  return SOURCE_CLASSES[sourceType as SourceType];
}

// Push-mode SourceInstance cache, keyed by metric_def.id. The agent's
// pollingJob/pushJob calls `execute()` on a cron tick; for push
// sources we lazily init() the SourceInstance on first hit and reuse
// it for every subsequent read. The metric-definition refresh loop
// (see ../index.ts:pollDefinitions) calls `disposeForMetric()` when a
// definition disappears.
//
// We store the in-flight init promise (not the resolved instance) so
// concurrent execute() calls for the same metric_def.id (pollingJob +
// pushJob can both fire in the same tick) await one init, not race
// two. The promise resolves to the SourceInstance the cache should
// hold from then on.
const pushInstances = new Map<string, Promise<SourceInstance>>();

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

  // Push-mode dispatch. Lifecycle Source: init()
  // once per metric_def, cache the SourceInstance, call read() on
  // every cron tick. Validation runs at init time the first call.
  // Concurrent execute() calls for the same metric_def.id share the
  // single in-flight init promise so we never double-init.
  const pushSource = PUSH_SOURCES[sourceType as SourceType];
  if (pushSource) {
    let initPromise = pushInstances.get(metricDef.id);
    if (!initPromise) {
      const validationError = pushSource.validateConfig(config);
      if (validationError) {
        return {
          value: null,
          timestamp: ts(),
          status_hint: "no_data",
          reason: "invalid_config",
          metadata: { source_type: sourceType, error: validationError },
        };
      }
      initPromise = Promise.resolve(pushSource.init(config, env));
      pushInstances.set(metricDef.id, initPromise);
      // If init rejects, drop the cached promise so the next tick can
      // retry instead of returning the same error forever.
      initPromise.catch(() => {
        if (pushInstances.get(metricDef.id) === initPromise) {
          pushInstances.delete(metricDef.id);
        }
      });
    }
    let instance: SourceInstance;
    try {
      instance = await initPromise;
    } catch (e) {
      return {
        value: null,
        timestamp: ts(),
        status_hint: "no_data",
        reason: "push_source_init_failed",
        metadata: { source_type: sourceType, error: (e as Error).message },
      };
    }
    try {
      return await instance.read();
    } catch (e) {
      return {
        value: null,
        timestamp: ts(),
        status_hint: "no_data",
        reason: "push_source_read_failed",
        metadata: { source_type: sourceType, error: (e as Error).message },
      };
    }
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

/**
 * Dispose a push-mode SourceInstance bound to a metric definition.
 * Called by the scheduler when a metric_def drops out of the cloud's
 * projection (deleted, paused, or type-changed). Safe to call while
 * init() is still in-flight; we await the promise first.
 */
export async function disposeForMetric(metricId: string): Promise<void> {
  const initPromise = pushInstances.get(metricId);
  if (!initPromise) return;
  pushInstances.delete(metricId);
  try {
    const instance = await initPromise;
    await instance.dispose();
  } catch {
    // Dispose is best-effort; the entry is already out of our map.
  }
}

/**
 * Dispose every cached push-mode SourceInstance. Called from the
 * SIGTERM / SIGINT handler so receivers (OTLP HTTP listener) shut
 * down cleanly before process exit.
 */
export async function disposeAllPushInstances(): Promise<void> {
  const all = [...pushInstances.values()];
  pushInstances.clear();
  await Promise.allSettled(
    all.map(async (p) => {
      const instance = await p;
      return instance.dispose();
    }),
  );
}

export default {
  execute,
  getSource,
  SOURCES,
  getSourceClass,
  SOURCE_CLASSES,
  disposeForMetric,
  disposeAllPushInstances,
};
