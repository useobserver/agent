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

// Resolvers are reused, keyed by (server, timeout). A new
// dns.promises.Resolver per lookup leaked about 8 KB each on Bun 1.3.6, so a
// DNS check every minute grew the agent by about 11 MB a day. Entries are
// rebuilt after RESOLVER_TTL_MS so a resolver on the system servers picks
// up a changed /etc/resolv.conf, and the map is bounded.
const RESOLVER_TTL_MS = 60 * 60_000;
const RESOLVER_CACHE_MAX = 64;
const resolvers = new Map<string, { resolver: dnsModule.promises.Resolver; createdAt: number }>();

function resolverFor(server: string | undefined, timeoutMs: number): dnsModule.promises.Resolver {
  const key = `${server ?? ""}|${timeoutMs}`;
  const now = Date.now();
  const hit = resolvers.get(key);
  if (hit && now - hit.createdAt < RESOLVER_TTL_MS) return hit.resolver;
  // tries: 1. With 2, c-ares backs off and retries, so a blackholed
  // resolver took about 3x timeout_ms. The race in execute() is the hard cap.
  const resolver = new dnsModule.promises.Resolver({ timeout: timeoutMs, tries: 1 });
  if (server) resolver.setServers([server]);
  resolvers.delete(key);
  resolvers.set(key, { resolver, createdAt: now });
  while (resolvers.size > RESOLVER_CACHE_MAX) resolvers.delete(resolvers.keys().next().value as string);
  return resolver;
}

/** Test hook: forget cached resolvers. */
export function resetDnsResolversForTests(): void {
  resolvers.clear();
}

export async function execute(config: DnsConfig): Promise<ProbeResult> {
  const ts = (): string => new Date().toISOString();
  const recordType: RecordType = config.record_type || "A";
  const timeoutMs = config.timeout_ms ?? 5_000;

  // Always use a Resolver (never bare dnsModule.promises): it is the only
  // way to put a hard deadline on the DNS transaction. Without `timeout` a
  // blackholed resolver hangs the probe on the OS default. setServers throws
  // synchronously (TypeError) on a malformed resolver address: guard it so
  // the "sources never throw" contract holds and the operator gets a typed
  // reason instead of a dispatcher backstop.
  let resolver: dnsModule.promises.Resolver;
  try {
    resolver = resolverFor(config.resolver, timeoutMs);
  } catch {
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: "dns_resolver_invalid" };
  }

  const start = Date.now();
  try {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const records = await Promise.race([
      resolver.resolve(config.domain, recordType),
      new Promise<never>((_, reject) => {
        // No resolver.cancel(): the resolver is shared, and cancel() would
        // fail every other check's lookup in flight on it. The abandoned
        // query ends on its own c-ares timeout.
        deadline = setTimeout(() => {
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
