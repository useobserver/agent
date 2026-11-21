// SSRF guard for managed-prober mode: resolve a target, vet EVERY answer,
// and hand back one address to pin the connection to.
//
// The static policy (which IPs and names are public) is shared with the
// cloud in @observer/probe-config (classifyIp / checkTargetHost). This file
// adds the runtime half the cloud cannot do: DNS resolution on the prober,
// at probe time, so a name that resolves somewhere private (or rebinds to
// it later) is refused at the moment it would be connected to. Callers
// connect to the returned `ip` and never re-resolve the name.
//
// Resolution goes through a c-ares Resolver pointed at PROBER_DNS_SERVERS
// (public resolvers by default), never getaddrinfo: no /etc/hosts, no
// search-domain expansion, no cluster DNS.

import dnsModule from "node:dns";
import { checkTargetHost, classifyIp } from "@observer/probe-config";
import { withDeadline } from "../deadline.ts";

export const DEFAULT_PROBER_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];
const DNS_TIMEOUT_MS = 3_000;

export type Vetted = { ok: true; hostname: string; ip: string; family: 4 | 6 };
export type VetFailure = { ok: false; reason: string };

export interface ResolveFn {
  (name: string): Promise<{ v4: string[]; v6: string[] }>;
}

/** Parse PROBER_DNS_SERVERS ("1.1.1.1,9.9.9.9"); every entry must be a public IP. */
export function parseDnsServers(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [...DEFAULT_PROBER_DNS_SERVERS];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;
    const c = classifyIp(s);
    if (c.blocked) throw new Error(`PROBER_DNS_SERVERS entry ${s} is not a public IP address`);
    out.push(s);
  }
  return out.length > 0 ? out : [...DEFAULT_PROBER_DNS_SERVERS];
}

// c-ares gives up after tries × timeout; the deadline is the backstop for a
// lookup that never settles at all.
export const DNS_DEADLINE_MS = DNS_TIMEOUT_MS * 2 + 1_000;
// c-ares answers that describe the NAME (no such domain, no record of this
// type), as opposed to the resolver failing.
const NAME_ANSWER_CODES = new Set(["ENOTFOUND", "ENODATA", "ENONAME", "NXDOMAIN"]);

export function createResolver(servers: string[]): ResolveFn {
  // ONE resolver for the prober's lifetime. A new dns.promises.Resolver per
  // lookup leaked about 8 KB each on Bun 1.3.6: a prober reached its 512 MB
  // memory limit after two weeks, then thrashed until its timers fired
  // minutes late.
  const r = new dnsModule.promises.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
  r.setServers(servers);
  return async (name: string) => {
    // Trailing dot: absolute name, no search-domain expansion.
    const fq = name.endsWith(".") ? name : `${name}.`;
    const [a, aaaa] = await Promise.allSettled([
      withDeadline(r.resolve4(fq), DNS_DEADLINE_MS, "dns A lookup"),
      withDeadline(r.resolve6(fq), DNS_DEADLINE_MS, "dns AAAA lookup"),
    ]);
    // Both lookups failed, and not with "this name has no such record": the
    // resolver itself is failing (timeout, refused, SERVFAIL). Throw, so the
    // check reads dns_failed instead of dns_no_answer, which blames the target.
    if (a.status === "rejected" && aaaa.status === "rejected") {
      const codes = [a.reason, aaaa.reason].map((e) => String((e as { code?: unknown } | null)?.code ?? ""));
      if (!codes.every((c) => NAME_ANSWER_CODES.has(c))) throw new Error("dns resolver failed");
    }
    return {
      v4: a.status === "fulfilled" ? a.value : [],
      v6: aaaa.status === "fulfilled" ? aaaa.value : [],
    };
  };
}

/**
 * Vet a target host. IP literals are classified directly; names are
 * resolved and refused if ANY answer is non-public (a record mixing a
 * public and a private address is a rebinding / pivot attempt, not an
 * outage). Prefers IPv4 for the pinned address.
 */
export async function vetHost(host: string, resolve: ResolveFn): Promise<Vetted | VetFailure> {
  const h = checkTargetHost(host);
  if (!h.ok) return { ok: false, reason: h.reason ? `target_not_public:${h.reason}` : h.code };
  if (h.kind === "ip") return { ok: true, hostname: h.ip, ip: h.ip, family: h.family };

  let answers: { v4: string[]; v6: string[] };
  try {
    answers = await resolve(h.name);
  } catch {
    return { ok: false, reason: "dns_failed" };
  }
  const all = [...answers.v4, ...answers.v6];
  if (all.length === 0) return { ok: false, reason: "dns_no_answer" };
  for (const ip of all) {
    const c = classifyIp(ip);
    if (c.blocked) return { ok: false, reason: `target_not_public:${c.reason}` };
  }
  if (answers.v4.length > 0) return { ok: true, hostname: h.name, ip: answers.v4[0], family: 4 };
  const v6 = classifyIp(answers.v6[0]);
  return { ok: true, hostname: h.name, ip: v6.blocked ? answers.v6[0] : v6.normalized, family: 6 };
}
