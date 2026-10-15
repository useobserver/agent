// One outside-in check → one wire sample. The ONLY dispatch in prober mode:
// the check is re-validated against the shared outside-in policy (the cloud
// already did, this is the prober refusing on its own), then routed to a
// guarded executor. Anything else (custom, database, prometheus, loki,
// elasticsearch, cloudwatch, otlp, host, grpc, websocket, …) is refused
// without being run.

import { validateOutsideInConfig } from "@observer/probe-config";
import type { ProberCheck, ProberResultItem } from "@observer/protocol";
import { evaluate } from "../evaluator.ts";
import type { MetricDefinition, ProbeResult } from "../types.ts";
import { proberDns, proberHttp, proberIcmp, proberTcp, proberTlsCert, type ProberDeps } from "./sources.ts";

function refused(reason: string): ProbeResult {
  return { value: null, timestamp: new Date().toISOString(), status_hint: "no_data", reason: reason.slice(0, 64) };
}

export async function executeProberCheck(check: ProberCheck, deps: ProberDeps): Promise<ProbeResult> {
  const v = validateOutsideInConfig(check?.source_type, check?.source_config);
  if (!v.ok) {
    return refused(v.code === "source_type_not_allowed" ? "source_not_allowed_in_prober" : `refused:${v.code}`);
  }
  try {
    switch (v.sourceType) {
      case "http":
        return await proberHttp(v.config as never, deps);
      case "tcp":
        return await proberTcp(v.config as never, deps);
      case "dns":
        return await proberDns(v.config as never, deps);
      case "tls_cert":
        return await proberTlsCert(v.config as never, deps);
      case "icmp":
        return await proberIcmp(v.config as never, deps);
    }
  } catch {
    // Backstop for "sources never throw"; no message (it can echo a URL).
    return refused("source_threw");
  }
  return refused("source_not_allowed_in_prober");
}

/** Run a check and shape the wire sample (no_data → value 0, like the agent). */
export async function runProberCheck(check: ProberCheck, deps: ProberDeps): Promise<ProberResultItem> {
  const result = await executeProberCheck(check, deps);
  const ev = evaluate(check as unknown as MetricDefinition, result);
  return {
    metric_id: check.id,
    value: ev.status === "no_data" ? 0 : (ev.value ?? 0),
    timestamp: ev.timestamp,
    status: ev.status,
    ...(ev.reason ? { reason: ev.reason.slice(0, 64) } : {}),
  };
}
