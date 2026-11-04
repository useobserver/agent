// Datadog metrics source: placeholder until the reader lands (agent 1.8.0).
// Validates the config so a stored check is checked like any other, then
// reports no data with a reason the console explains.

import type { ProbeResult, ProbeSource } from "../types.ts";
import { DatadogConfigSchema, type DatadogConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(DatadogConfigSchema, config);
}

export async function execute(_config: DatadogConfig): Promise<ProbeResult> {
  return { value: null, timestamp: new Date().toISOString(), status_hint: "no_data", reason: "datadog_not_implemented" };
}

const source: ProbeSource<DatadogConfig> = { execute, validateConfig };
export default source;
