// Custom-probe registry.
//
// Customers add probe functions to their agent's codebase and register
// them here by name. The Observer console references a registered probe
// by name; the agent runs it on schedule and uses its return value as
// the metric.
//
// There is deliberately NO sandboxing: the probe code is the customer's
// own trusted code, deployed by them, running with whatever privileges
// the agent already has. Same trust boundary as the rest of the agent.
// (If you find yourself reaching for QuickJS / isolated-vm here, stop.)

import type { AgentEnv } from "../../types.ts";

export type CustomProbeResult = number | { value: number; metadata?: Record<string, unknown> };

export interface CustomProbeContext {
  /** probe_config passed from the Observer console at runtime. */
  config: Record<string, unknown>;
  /** The agent's environment (auth tokens, secrets, etc). */
  env: AgentEnv;
  /** Structured log line; surfaced (last few lines) in probe metadata. */
  log: (msg: string, meta?: Record<string, unknown>) => void;
  /** Aborted when the probe exceeds its timeout. Respect it for cancellation. */
  signal: AbortSignal;
}

// Minimal structural type for an optional config validator. We avoid a
// hard zod dependency in the registry: anything exposing
// `safeParse(value) => { success, error? }` works (a zod schema does).
// Customers who don't use zod simply omit configSchema.
export interface CustomConfigValidator {
  safeParse(value: unknown): { success: boolean; error?: { message?: string } };
}

export interface CustomProbe {
  name: string;
  description?: string;
  configSchema?: CustomConfigValidator;
  run(ctx: CustomProbeContext): Promise<CustomProbeResult> | CustomProbeResult;
}

// What the agent reports to the cloud on heartbeat. The probe function
// itself is never serialised — only its name, description, and whether
// it declares a config schema.
export interface CustomProbeDescriptor {
  name: string;
  description?: string;
  has_config_schema: boolean;
}

const registry = new Map<string, CustomProbe>();

/**
 * Register a custom probe. Throws on a duplicate name so a copy-paste
 * mistake fails fast at agent boot rather than silently shadowing.
 */
export function registerCustomProbe(probe: CustomProbe): void {
  if (!probe || typeof probe.name !== "string" || probe.name.trim().length === 0) {
    throw new Error("registerCustomProbe: a non-empty `name` is required");
  }
  if (typeof probe.run !== "function") {
    throw new Error(`Custom probe '${probe.name}': run() must be a function`);
  }
  if (registry.has(probe.name)) {
    throw new Error(`Custom probe '${probe.name}' is already registered`);
  }
  registry.set(probe.name, probe);
}

export function listCustomProbes(): CustomProbe[] {
  return [...registry.values()];
}

export function getCustomProbe(name: string): CustomProbe | undefined {
  return registry.get(name);
}

/** Serialisable descriptors for the heartbeat payload. */
export function describeCustomProbes(): CustomProbeDescriptor[] {
  return [...registry.values()].map((p) => ({
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    has_config_schema: Boolean(p.configSchema),
  }));
}

/** Test-only: reset the registry between cases. */
export function __resetCustomProbes(): void {
  registry.clear();
}
