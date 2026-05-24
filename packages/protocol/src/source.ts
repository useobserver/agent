// Source + Evaluator abstraction.
// to give the agent a single contract that accommodates both pull
// sources (Prometheus, HTTP, TCP, DNS, TLS-cert, etc.) and push
// sources (OTLP receiver, future Webhook ingestion).
//
// The stateless `ProbeSource` in ./push remains the wire-level
// contract every source module continues to export. `Source` is a
// thin lifecycle wrapper over `ProbeSource` so the scheduler can:
//   - lazily initialize push sources once and hold the receiver
//     handle for the lifetime of the metric definition
//   - call `read()` on a fixed interval (pull) or on the agent's
//     internal heartbeat cadence (push, returning the buffered
//     latest value)
//   - call `dispose()` when the metric definition disappears from
//     the agent's projection
//
// A pull source's adapter implements `init` by capturing config +
// env into a closure and `read()` calling the underlying
// `ProbeSource.execute`. A push source's `init` starts the
// receiver and `read()` polls the receiver's most-recent buffered
// sample.

import type { ProbeResult, ProbeSource } from "./push";

export type SourceMode = "pull" | "push";

export interface SourceInstance {
  /**
   * Pull: fetch a fresh value. Push: return the most-recent buffered
   * sample, or a `no_data` ProbeResult when the buffer is empty.
   *
   * May return synchronously when the value is already in memory
   * (push sources reading their internal buffer). Callers await
   * the result regardless.
   */
  read(): Promise<ProbeResult> | ProbeResult;
  /**
   * Cleanup. Push sources stop their listener / close sockets here.
   * Pull sources are usually no-op.
   */
  dispose(): Promise<void> | void;
}

export interface Source<TConfig = Record<string, unknown>, TEnv = unknown> {
  /**
   * "pull" — scheduler invokes `read()` on the per-metric interval.
   * "push" — scheduler initializes once, polls `read()` for the
   * latest value. `init()` is responsible for setting up the
   * receiver / subscription that fills the buffer.
   */
  readonly mode: SourceMode;
  /**
   * Reject before scheduling. Returns null on success, a single
   * error string otherwise. Identical contract to the existing
   * `ProbeSource.validateConfig`.
   */
  validateConfig(config: unknown): null | string;
  /**
   * Create a runtime instance bound to this config. May be sync
   * (pull adapter) or async (push receiver setup that opens a
   * socket). Agent specializes TEnv with its `AgentEnv` shape;
   * protocol keeps TEnv unknown by default so no agent-internal
   * type leaks into the wire contract.
   */
  init(config: TConfig, env?: TEnv): Promise<SourceInstance> | SourceInstance;
}

/**
 * Lift a stateless `ProbeSource` (the existing wire shape) into a
 * pull-mode `Source`. The scheduler uses this for every source
 * registered today; push sources implement `Source` directly.
 */
export function asPullSource<TConfig, TEnv = unknown>(
  probe: ProbeSource<TConfig>,
): Source<TConfig, TEnv> {
  return {
    mode: "pull",
    validateConfig: probe.validateConfig.bind(probe),
    init(config, env) {
      return {
        async read() {
          return await probe.execute(config, env);
        },
        async dispose() {},
      };
    },
  };
}
