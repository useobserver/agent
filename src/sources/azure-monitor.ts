// Azure Monitor source: placeholder until the reader lands (agent 1.8.0).
// Validates the config so a stored check is checked like any other, then
// reports no data with a reason the console explains.

import type { ProbeResult, ProbeSource } from "../types.ts";
import { AzureMonitorConfigSchema, type AzureMonitorConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(AzureMonitorConfigSchema, config);
}

export async function execute(_config: AzureMonitorConfig): Promise<ProbeResult> {
  return {
    value: null,
    timestamp: new Date().toISOString(),
    status_hint: "no_data",
    reason: "azure_monitor_not_implemented",
  };
}

const source: ProbeSource<AzureMonitorConfig> = { execute, validateConfig };
export default source;
