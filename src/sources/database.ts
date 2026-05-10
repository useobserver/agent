// Database probe source (stubbed).

import type { ProbeResult, ProbeSource } from "../types.ts";
import { DatabaseConfigSchema, type DatabaseConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(DatabaseConfigSchema, config);
}

export async function execute(): Promise<ProbeResult> {
  return {
    value: null,
    timestamp: new Date().toISOString(),
    status_hint: "no_data",
    reason: "not_implemented",
  };
}

const source: ProbeSource<DatabaseConfig> = { execute, validateConfig };
export default source;
