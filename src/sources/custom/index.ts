// Custom probe source.
//
// Looks up a registered custom probe by name (source_config.probe_name),
// runs it with the supplied probe_config + the agent env, and returns
// its numeric value. A probe that throws, times out, or returns a
// non-number surfaces as a typed no_data reason — never an agent crash.

import type { AgentEnv, ProbeResult, ProbeSource } from "../../types.ts";
import { CustomConfigSchema, type CustomConfig } from "@observer/probe-config";
import { validateWithSchema } from "../_validate.ts";
import { getCustomProbe, type CustomProbeContext, type CustomProbeResult } from "./registry.ts";
// Import the customer barrel so registerCustomProbe() calls run at
// module load (and therefore at agent boot, before the first probe).
import "./probes/index.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_LOG_LINES = 10;

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(CustomConfigSchema, config);
}

type RunOutcome =
  | { kind: "value"; value: CustomProbeResult }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

export async function execute(config: CustomConfig, env: AgentEnv = {}): Promise<ProbeResult> {
  const ts = (): string => new Date().toISOString();
  const probeName = config.probe_name;
  const probe = getCustomProbe(probeName);
  if (!probe) {
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: "custom_probe_not_found",
      metadata: { probe_name: probeName },
    };
  }

  const probeConfig = (config.probe_config ?? {}) as Record<string, unknown>;
  if (probe.configSchema) {
    const parsed = probe.configSchema.safeParse(probeConfig);
    if (!parsed.success) {
      return {
        value: null,
        timestamp: ts(),
        status_hint: "no_data",
        reason: "custom_probe_config_invalid",
        metadata: { probe_name: probeName, error: parsed.error?.message ?? "config validation failed" },
      };
    }
  }

  const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const logs: string[] = [];
  const ctx: CustomProbeContext = {
    config: probeConfig,
    env,
    log: (msg, meta) => {
      if (logs.length < 1000) logs.push(meta ? `${msg} ${safeJson(meta)}` : String(msg));
    },
    signal: controller.signal,
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  // Wrap run() so its rejection is always captured — even if it settles
  // AFTER the timeout wins the race — so there's never an unhandled
  // rejection.
  const runPromise: Promise<RunOutcome> = Promise.resolve()
    .then(() => probe.run(ctx))
    .then((value) => ({ kind: "value" as const, value }))
    .catch((error) => ({ kind: "error" as const, error }));
  const timeoutPromise: Promise<RunOutcome> = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timeout" as const });
    }, timeoutMs);
  });

  try {
    // Timeout wins ties: if the deadline fires first we report a
    // timeout and ignore whatever runPromise settles to afterwards
    // (it's already wrapped by the .catch above, so a late rejection
    // can never become an unhandled rejection).
    const outcome = await Promise.race([runPromise, timeoutPromise]);
    const logMeta = logs.length ? { logs: logs.slice(-MAX_LOG_LINES) } : {};

    if (outcome.kind === "timeout") {
      return {
        value: null,
        timestamp: ts(),
        status_hint: "no_data",
        reason: "custom_probe_timeout",
        metadata: { probe_name: probeName, timeout_ms: timeoutMs, ...logMeta },
      };
    }
    if (outcome.kind === "error") {
      // A probe can throw a non-Error (string, plain object, …). Pull a
      // message + stack when it's an Error; otherwise serialise the
      // value so metadata.error isn't a useless "[object Object]".
      const raw = outcome.error;
      const isError = raw instanceof Error;
      const message = isError ? raw.message : typeof raw === "string" ? raw : safeJson(raw);
      const stack = isError && raw.stack ? trimStack(raw.stack) : undefined;
      return {
        value: null,
        timestamp: ts(),
        status_hint: "no_data",
        reason: "custom_probe_error",
        metadata: {
          probe_name: probeName,
          error: message,
          ...(stack ? { stack } : {}),
          ...logMeta,
        },
      };
    }
    return coerce(probeName, outcome.value, ts, logMeta);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Map the probe's return into a ProbeResult. Accepts a bare number or
// { value, metadata }. Anything else (or a non-finite number) is a
// contract violation surfaced as custom_probe_bad_return.
function coerce(
  probeName: string,
  result: CustomProbeResult,
  ts: () => string,
  logMeta: Record<string, unknown>,
): ProbeResult {
  let num: number | undefined;
  let probeMeta: Record<string, unknown> | undefined;
  if (typeof result === "number") {
    num = result;
  } else if (result && typeof result === "object" && typeof (result as { value?: unknown }).value === "number") {
    num = (result as { value: number }).value;
    const m = (result as { metadata?: Record<string, unknown> }).metadata;
    if (m && typeof m === "object") probeMeta = m;
  }
  if (num === undefined || !Number.isFinite(num)) {
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: "custom_probe_bad_return",
      metadata: { probe_name: probeName, ...logMeta },
    };
  }
  return {
    value: num,
    timestamp: ts(),
    metadata: { probe_name: probeName, ...(probeMeta ?? {}), ...logMeta },
  };
}

function trimStack(stack: string): string {
  return stack.split("\n").slice(0, 4).join("\n");
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "[unserialisable]";
  }
}

const source: ProbeSource<CustomConfig> = { execute, validateConfig };
export default source;
