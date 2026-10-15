// cloudwatch_list_metrics job: cloudwatch:ListMetrics discovery for the
// console's "Fetch from AWS" button, run with this host's AWS credentials.
// Same work the legacy poller (index.ts, /api/agent/work/cloudwatch-list-
// metrics) does; the queue version returns lowercase dimension keys.

import type { AgentJob, AgentJobResultBody, CloudwatchListMetricsPayload } from "@observer/protocol";

type ListMetrics = (req: {
  region: string;
  namespace?: string;
  role_arn?: string;
  external_id?: string;
}) => Promise<
  | { ok: true; metrics: Array<{ metric_name: string; dimensions: Array<{ Name: string; Value: string }> }>; truncated: boolean }
  | { ok: false; reason: string; detail?: string }
>;

const REGION_RE = /^[a-z0-9-]+$/;

export function createCloudwatchListMetricsHandler(listMetrics?: ListMetrics) {
  return async function cloudwatchListMetrics(job: AgentJob): Promise<AgentJobResultBody> {
    const p = (job.payload && typeof job.payload === "object" ? job.payload : {}) as Partial<CloudwatchListMetricsPayload>;
    if (typeof p.region !== "string" || !REGION_RE.test(p.region)) return { ok: false, error: "invalid_region" };
    const run = listMetrics ?? (await import("../sources/cloudwatch.ts")).listMetrics;
    const out = await run({
      region: p.region,
      namespace: p.namespace || undefined,
      role_arn: p.role_arn || undefined,
      external_id: p.external_id || undefined,
    });
    if (!out.ok) return { ok: false, error: out.reason };
    return {
      ok: true,
      result: {
        metrics: out.metrics.map((m) => ({
          metric_name: m.metric_name,
          dimensions: m.dimensions.map((d) => ({ name: d.Name, value: d.Value })),
        })),
        truncated: out.truncated,
      },
    };
  };
}
