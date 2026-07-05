// DNS probe source.

import dnsModule from "node:dns";
import type { ProbeResult, ProbeSource } from "../types.ts";
import { DnsConfigSchema, type DnsConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";

type RecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV" | "CAA" | "PTR";

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(DnsConfigSchema, config);
}

function flattenRecords(records: unknown): string[] {
  if (!Array.isArray(records)) return [String(records)];
  return records.flatMap((r) => {
    if (typeof r === "string") return [r];
    if (Array.isArray(r)) return r.map(String);
    if (r && typeof r === "object") {
      const obj = r as { exchange?: string };
      if (obj.exchange) return [obj.exchange];
      return Object.values(r).map(String);
    }
    return [String(r)];
  });
}

export async function execute(config: DnsConfig): Promise<ProbeResult> {
  const ts = (): string => new Date().toISOString();
  const recordType: RecordType = config.record_type || "A";
  const timeoutMs = config.timeout_ms ?? 5_000;

  // Always construct a Resolver (never bare dnsModule.promises): it is
  // the only way to put a hard deadline on the DNS transaction. Without
  // `timeout` a blackholed resolver hangs the probe on the OS default.
  // setServers throws synchronously (TypeError) on a malformed resolver
  // address — guard it so the "sources never throw" contract holds and
  // the operator gets a typed reason instead of a dispatcher backstop.
  let resolver: dnsModule.promises.Resolver;
  try {
    resolver = new dnsModule.promises.Resolver({ timeout: timeoutMs, tries: 2 });
    if (config.resolver) resolver.setServers([config.resolver]);
  } catch {
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: "dns_resolver_invalid" };
  }

  const start = Date.now();
  try {
    const records = await resolver.resolve(config.domain, recordType);
    const elapsed = Date.now() - start;
    if (config.expected_value) {
      const flat = flattenRecords(records);
      const matched = flat.some((v) => v.includes(config.expected_value!));
      if (!matched) {
        return {
          value: null,
          timestamp: ts(),
          status_hint: "no_data",
          reason: "expected_value_mismatch",
          metadata: { records: flat },
        };
      }
    }
    return { value: elapsed, timestamp: ts(), metadata: { records: flattenRecords(records) } };
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: e.code || e.message || "dns_error",
    };
  }
}

const source: ProbeSource<DnsConfig> = { execute, validateConfig };
export default source;
