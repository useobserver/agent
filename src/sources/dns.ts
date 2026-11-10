// DNS probe source.

import dnsModule from "node:dns";
import type { ProbeResult, ProbeSource } from "../types.ts";
import { DnsConfigSchema, type DnsConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";
import { classifyNetError } from "./net-errors.ts";

type RecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS" | "SRV" | "CAA" | "PTR";

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(DnsConfigSchema, config);
}

function flattenRecords(records: unknown): string[] {
  if (!Array.isArray(records)) return [String(records)];
  return records.flatMap((r) => {
    if (typeof r === "string") return [r];
    // A TXT record longer than 255 bytes arrives as several strings; they
    // are one value (RFC 7208 joins them), so match against the join.
    if (Array.isArray(r)) return [r.map(String).join("")];
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
    // tries: 1. With 2, c-ares backs off and retries, so a blackholed
    // resolver took about 3x timeout_ms. The race below is the hard cap.
    resolver = new dnsModule.promises.Resolver({ timeout: timeoutMs, tries: 1 });
    if (config.resolver) resolver.setServers([config.resolver]);
  } catch {
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: "dns_resolver_invalid" };
  }

  const start = Date.now();
  try {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const records = await Promise.race([
      resolver.resolve(config.domain, recordType),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          try {
            resolver.cancel();
          } catch {
            /* nothing in flight */
          }
          reject(Object.assign(new Error("dns timeout"), { code: "ETIMEOUT" }));
        }, timeoutMs + 250);
      }),
    ]).finally(() => clearTimeout(deadline));
    const elapsed = Date.now() - start;
    if (config.expected_value) {
      const flat = flattenRecords(records);
      // Bun returns each string of a split TXT record (long SPF / DKIM) as
      // a separate record, so for TXT also match against the strings joined
      // in order.
      const matched =
        flat.some((v) => v.includes(config.expected_value!)) ||
        (recordType === "TXT" && flat.join("").includes(config.expected_value!));
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
    // Normalised code only. Never e.message: it is free text (and can
    // carry the queried name), not a reason code.
    const n = classifyNetError(error, "dns_error");
    return {
      value: null,
      timestamp: ts(),
      status_hint: "no_data",
      reason: n.reason,
      ...(n.raw && n.raw !== n.reason ? { metadata: { error_code: n.raw } } : {}),
    };
  }
}

const source: ProbeSource<DnsConfig> = { execute, validateConfig };
export default source;
