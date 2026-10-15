// probe_test job: run one configured source once against a draft
// source_config from the console's metric form.
//
// Same privacy promise as a scheduled probe: the result carries one number,
// a verdict, a latency and a reason code. Source metadata (which can hold
// validation messages, hostnames, or driver errors) is dropped, and the
// result passes sanitizeProbeTestResult before it leaves the host.
//
// Same execution path as a scheduled probe too: sources.execute() (which
// re-validates the config, resolves *_ref env vars on this host and never
// throws) followed by evaluate() (strict operators).

import {
  PROBE_TEST_TIMEOUT_MS,
  isProbeTestSourceType,
  sanitizeProbeTestResult,
  type AgentJob,
  type AgentJobResultBody,
  type ProbeTestPayload,
} from "@observer/protocol";
import { evaluate } from "../evaluator.ts";
import type { AgentEnv, MetricDefinition, ProbeResult } from "../types.ts";

const OPS = new Set(["over", "under", "equal"]);

export interface ProbeTestDeps {
  execute: (def: MetricDefinition, env: AgentEnv) => Promise<ProbeResult>;
  env: () => AgentEnv;
  timeoutMs?: number;
  now?: () => number;
}

function op(v: unknown): "over" | "under" | "equal" {
  // An unset operator never matches (evaluateOperation's default branch).
  return (OPS.has(v as string) ? v : "none") as "over" | "under" | "equal";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
}

export function createProbeTestHandler(deps: ProbeTestDeps) {
  const timeoutMs = deps.timeoutMs ?? PROBE_TEST_TIMEOUT_MS;
  const now = deps.now ?? (() => performance.now());

  return async function probeTest(job: AgentJob): Promise<AgentJobResultBody> {
    const p = (job.payload && typeof job.payload === "object" ? job.payload : {}) as Partial<ProbeTestPayload>;
    if (!isProbeTestSourceType(p.source_type)) return { ok: false, error: "unsupported_source_type" };
    if (!p.source_config || typeof p.source_config !== "object" || Array.isArray(p.source_config)) {
      return { ok: false, error: "invalid_config" };
    }

    const def: MetricDefinition = {
      // Never collides with a real metric id (those are uuids), so the push
      // instance cache in sources/index.ts can't be touched by a test.
      id: `probe-test:${job.id}`,
      source_type: p.source_type,
      source_config: { ...p.source_config },
      interval: 1,
      interval_agent_push: 15,
      healthy_operation: op(p.healthy_operation),
      healthy_value: num(p.healthy_value),
      unhealthy_operation: op(p.unhealthy_operation),
      unhealthy_value: num(p.unhealthy_value),
    };

    const started = now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<ProbeResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ value: null, timestamp: new Date().toISOString(), status_hint: "no_data", reason: "test_timeout" }),
        timeoutMs,
      );
    });
    let result: ProbeResult;
    try {
      result = await Promise.race([
        deps.execute(def, deps.env()).catch(
          (): ProbeResult => ({ value: null, timestamp: new Date().toISOString(), status_hint: "no_data", reason: "source_threw" }),
        ),
        timedOut,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const latency = now() - started;
    const ev = evaluate(def, result);
    return {
      ok: true,
      result: sanitizeProbeTestResult({
        value: ev.value,
        verdict: ev.status,
        latency_ms: latency,
        reason: ev.reason ?? null,
      }),
    };
  };
}
