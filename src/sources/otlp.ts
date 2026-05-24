// OTLP source — push-mode receiver bound to a metric definition.
//
// One singleton receiver per agent process (see ./otlp/receiver.ts).
// Each metric_def with source_type=otlp opens a subscription that
// filters the receiver's stream buffer by metric_name and (optionally)
// attribute key→value matches. The scheduler calls `read()` on the
// metric's pull cadence; we return the latest matching data point
// aggregated to the configured scalar.

import type { Source } from "@observer/protocol";
import { OtlpConfigSchema, type OtlpConfig } from "@observer/probe-config";
import type { ProbeResult } from "../types.ts";
import { validateWithSchema } from "./_validate.ts";
import { aggregateDataPoint } from "./otlp/decode.ts";
import { startOtlpReceiverOnce } from "./otlp/receiver.ts";

function validateConfig(config: unknown): null | string {
  return validateWithSchema(OtlpConfigSchema, config);
}

const otlpSource: Source<OtlpConfig> = {
  mode: "push",
  validateConfig,
  async init(config) {
    const receiver = await startOtlpReceiverOnce();
    if (!receiver) {
      // Receiver disabled in this process (OBSERVER_OTLP_DISABLE=true).
      // Surface as a permanent no_data so the operator sees the cause
      // on the dashboard instead of guessing why metrics are missing.
      return {
        read(): ProbeResult {
          return {
            value: null,
            timestamp: new Date().toISOString(),
            status_hint: "no_data",
            reason: "otlp_receiver_disabled",
          };
        },
        dispose() {},
      };
    }

    const subscription = receiver.subscribe({
      metric_name: config.metric_name,
      attribute_filters: config.attribute_filters,
    });

    return {
      read(): ProbeResult {
        const latest = subscription.latest();
        const nowIso = new Date().toISOString();
        if (!latest) {
          return {
            value: null,
            timestamp: nowIso,
            status_hint: "no_data",
            reason: "otlp_no_samples",
            metadata: { metric_name: config.metric_name },
          };
        }
        const ageMs = Date.now() - latest.time_ms;
        if (ageMs > config.staleness_ms) {
          return {
            value: null,
            timestamp: nowIso,
            status_hint: "no_data",
            reason: "otlp_stale",
            metadata: {
              metric_name: config.metric_name,
              age_ms: ageMs,
              staleness_ms: config.staleness_ms,
            },
          };
        }
        const aggregated = aggregateDataPoint(latest, config.aggregation);
        if (aggregated === null) {
          return {
            value: null,
            timestamp: nowIso,
            status_hint: "no_data",
            reason: "otlp_aggregation_unavailable",
            metadata: {
              metric_name: config.metric_name,
              aggregation: config.aggregation,
              data_point_kind: latest.kind,
            },
          };
        }
        return {
          value: aggregated,
          timestamp: new Date(latest.time_ms).toISOString(),
          metadata: {
            metric_name: config.metric_name,
            data_point_kind: latest.kind,
            aggregation: config.aggregation,
          },
        };
      },
      dispose() {
        subscription.unsubscribe();
      },
    };
  },
};

export default otlpSource;
export { validateConfig };
