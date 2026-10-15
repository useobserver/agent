// Outside-in (hosted) checks: the shared rules for what Observer's own
// probers may run, used by BOTH the cloud (create/edit validation, the
// prober checks endpoint) and the agent's managed-prober mode (which
// re-checks everything before it touches the network).
//
// A hosted check runs on Observer infrastructure on behalf of any tenant, so
// the threat model is SSRF: a tenant must never be able to make a prober
// reach loopback, a private or cluster network, a cloud metadata service, or
// read a secret from the prober host. This module is the policy:
//
//   - source types: http, tcp, dns, tls_cert, icmp only;
//   - no *_ref fields (they name env vars on the host that runs the probe,
//     and on a prober that host is ours);
//   - targets must be public: classifyIp() blocks private, loopback,
//     link-local, CGNAT, metadata, multicast, documentation and reserved
//     ranges for IPv4 and IPv6 (incl. v4-mapped / NAT64 / 6to4 / Teredo);
//   - hostnames must be fully qualified and not under internal suffixes.
//
// Pure TypeScript with no Node imports: the console form bundles it.
// The DNS-resolution half of the guard (resolve, vet every answer, pin)
// lives in the agent (apps/agent/src/prober/guard.ts); the cloud runs the
// static half at write time and again before handing a check out.

import { getConfigSchema } from "./validate";

export const OUTSIDE_IN_SOURCE_TYPES = Object.freeze(["http", "tcp", "dns", "tls_cert", "icmp"] as const);
export type OutsideInSourceType = (typeof OUTSIDE_IN_SOURCE_TYPES)[number];

export function isOutsideInSourceType(t: unknown): t is OutsideInSourceType {
  return typeof t === "string" && (OUTSIDE_IN_SOURCE_TYPES as readonly string[]).includes(t);
}

/** Config keys that name env vars on the probing host. Never allowed. */
export const OUTSIDE_IN_FORBIDDEN_KEYS = Object.freeze([
  "header_refs",
  "client_cert_ref",
  "client_key_ref",
  "ca_cert_ref",
] as const);

/** Per-attempt time cap on a prober (ms). */
export const OUTSIDE_IN_MAX_TIMEOUT_MS = 10_000;
/** Response body cap on a prober (bytes); body_match / json_path read at most this. */
export const OUTSIDE_IN_MAX_BODY_BYTES = 1_048_576;
/** Redirect hops a prober follows (each hop re-vetted). */
export const OUTSIDE_IN_MAX_REDIRECTS = 5;
/** Most locations one check may run from. */
export const OUTSIDE_IN_MAX_LOCATIONS = 8;

// Request headers a tenant may not set on a prober request: the prober sets
// Host itself (it connects to a pinned IP), and framing / hop-by-hop headers
// could desync or smuggle on the far side.
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "expect",
  "proxy-authorization",
  "proxy-connection",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
]);

export function isForbiddenProberHeader(name: string): boolean {
  const n = name.trim().toLowerCase();
  return FORBIDDEN_REQUEST_HEADERS.has(n) || n.startsWith("proxy-");
}

// ── IP parsing ────────────────────────────────────────────────────────────

/** Strict dotted-quad decimal → 4 bytes, else null. */
export function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p.startsWith("0")) return null; // no octal-looking octets
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** IPv6 text (optionally bracketed, no zone id) → 16 bytes, else null. */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s.includes("%")) return null; // zone ids are link-local by definition
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(":")) return null;

  // Embedded dotted IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4).
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return null;
    tail = v4;
    s = s.slice(0, lastColon + 1) + "0:0"; // placeholder groups, replaced below
  }

  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const groupsOf = (part: string): string[] | null => {
    if (part === "") return [];
    const g = part.split(":");
    for (const x of g) if (!/^[0-9a-fA-F]{1,4}$/.test(x)) return null;
    return g;
  };
  const head = groupsOf(dbl[0]);
  const rest = dbl.length === 2 ? groupsOf(dbl[1]) : [];
  if (!head || !rest) return null;
  let groups: string[];
  if (dbl.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 255, n & 255);
  }
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

export type IpBlockReason =
  | "invalid_ip"
  | "unspecified"
  | "loopback"
  | "private"
  | "carrier_grade_nat"
  | "link_local"
  | "cloud_metadata"
  | "multicast"
  | "reserved"
  | "documentation"
  | "benchmarking"
  | "ietf_special"
  | "broadcast"
  | "unique_local"
  | "site_local"
  | "ipv4_mapped"
  | "ipv4_compatible"
  | "nat64"
  | "6to4"
  | "teredo"
  | "not_global_unicast";

export type IpClass =
  | { blocked: false; family: 4 | 6; normalized: string }
  | { blocked: true; reason: IpBlockReason; family?: 4 | 6 };

// Cloud metadata / host-control endpoints that sit on otherwise-allowed or
// worth-naming addresses. Most are already inside a blocked range; listing
// them gives the precise reason and guards the ones that are not
// (Azure's WireServer is a public address).
const METADATA_V4 = new Set([
  "169.254.169.254", // AWS / GCP / Azure / OCI / DO IMDS
  "169.254.170.2", // AWS ECS task metadata
  "169.254.169.253", // AWS VPC DNS
  "169.254.169.123", // AWS time sync
  "168.63.129.16", // Azure WireServer (public address)
  "100.100.100.200", // Alibaba Cloud metadata
  "192.0.0.192", // Oracle Cloud classic metadata
]);
const METADATA_V6 = new Set(["fd00:ec2:0:0:0:0:0:254", "fd00:ec2:0:0:0:0:0:23"]);

function v4String(b: number[]): string {
  return b.join(".");
}
function v6String(b: number[]): string {
  const g: string[] = [];
  for (let i = 0; i < 16; i += 2) g.push(((b[i] << 8) | b[i + 1]).toString(16));
  return g.join(":");
}

function inV4(b: number[], net: [number, number, number, number], bits: number): boolean {
  const ip = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  const n = ((net[0] << 24) | (net[1] << 16) | (net[2] << 8) | net[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (n & mask);
}

function classifyV4Bytes(b: number[]): IpClass {
  const s = v4String(b);
  if (METADATA_V4.has(s)) return { blocked: true, reason: "cloud_metadata", family: 4 };
  const rules: Array<[[number, number, number, number], number, IpBlockReason]> = [
    [[0, 0, 0, 0], 8, "unspecified"],
    [[10, 0, 0, 0], 8, "private"],
    [[100, 64, 0, 0], 10, "carrier_grade_nat"],
    [[127, 0, 0, 0], 8, "loopback"],
    [[169, 254, 0, 0], 16, "link_local"],
    [[172, 16, 0, 0], 12, "private"],
    [[192, 0, 0, 0], 24, "ietf_special"],
    [[192, 0, 2, 0], 24, "documentation"],
    [[192, 31, 196, 0], 24, "ietf_special"],
    [[192, 52, 193, 0], 24, "ietf_special"],
    [[192, 88, 99, 0], 24, "reserved"],
    [[192, 168, 0, 0], 16, "private"],
    [[192, 175, 48, 0], 24, "ietf_special"],
    [[198, 18, 0, 0], 15, "benchmarking"],
    [[198, 51, 100, 0], 24, "documentation"],
    [[203, 0, 113, 0], 24, "documentation"],
    [[224, 0, 0, 0], 4, "multicast"],
    [[255, 255, 255, 255], 32, "broadcast"],
    [[240, 0, 0, 0], 4, "reserved"],
  ];
  for (const [net, bits, reason] of rules) {
    if (inV4(b, net, bits)) return { blocked: true, reason, family: 4 };
  }
  return { blocked: false, family: 4, normalized: s };
}

function classifyV6Bytes(b: number[]): IpClass {
  const s = v6String(b);
  if (METADATA_V6.has(s)) return { blocked: true, reason: "cloud_metadata", family: 6 };
  const allZero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (allZero(0, 16)) return { blocked: true, reason: "unspecified", family: 6 };
  if (allZero(0, 15) && b[15] === 1) return { blocked: true, reason: "loopback", family: 6 };
  // ::ffff:0:0/96 IPv4-mapped, ::ffff:0:0:0/96 IPv4-translated, ::/96 compat.
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) return { blocked: true, reason: "ipv4_mapped", family: 6 };
  if (allZero(0, 8) && b[8] === 0xff && b[9] === 0xff && allZero(10, 12)) {
    return { blocked: true, reason: "ipv4_mapped", family: 6 };
  }
  if (allZero(0, 12)) return { blocked: true, reason: "ipv4_compatible", family: 6 };
  // 64:ff9b::/96 well-known NAT64 and 64:ff9b:1::/48 local-use NAT64.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return { blocked: true, reason: "nat64", family: 6 };
  }
  if (b[0] === 0xff) return { blocked: true, reason: "multicast", family: 6 };
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return { blocked: true, reason: "link_local", family: 6 };
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return { blocked: true, reason: "site_local", family: 6 };
  if ((b[0] & 0xfe) === 0xfc) return { blocked: true, reason: "unique_local", family: 6 };
  // Allow-list: only 2000::/3 global unicast is routable on the internet.
  if ((b[0] & 0xe0) !== 0x20) return { blocked: true, reason: "not_global_unicast", family: 6 };
  // Special blocks inside 2000::/3.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) {
    return { blocked: true, reason: "teredo", family: 6 }; // 2001::/32
  }
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) {
    return { blocked: true, reason: "documentation", family: 6 }; // 2001:db8::/32
  }
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] <= 0x01) {
    return { blocked: true, reason: "ietf_special", family: 6 }; // 2001::/23
  }
  if (b[0] === 0x20 && b[1] === 0x02) return { blocked: true, reason: "6to4", family: 6 }; // 2002::/16
  if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0x00) {
    return { blocked: true, reason: "documentation", family: 6 }; // 3fff::/20
  }
  return { blocked: false, family: 6, normalized: s };
}

/**
 * Classify an IP address string. Anything that is not a strict IPv4
 * dotted quad or a valid IPv6 literal is `invalid_ip` (fail closed).
 */
export function classifyIp(ip: string): IpClass {
  if (typeof ip !== "string") return { blocked: true, reason: "invalid_ip" };
  const v4 = parseIPv4(ip.trim());
  if (v4) return classifyV4Bytes(v4);
  const v6 = parseIPv6(ip);
  if (v6) return classifyV6Bytes(v6);
  return { blocked: true, reason: "invalid_ip" };
}

// ── Hostnames ─────────────────────────────────────────────────────────────

// Suffixes that only resolve on private networks, the prober's own host, or
// a cluster's DNS. Matched on whole labels.
const BLOCKED_SUFFIXES = [
  "localhost",
  "localdomain",
  "local",
  "internal",
  "intranet",
  "private",
  "lan",
  "home",
  "corp",
  "home.arpa",
  "cluster.local",
  "svc",
  "test",
  "invalid",
  "onion",
  "alt",
];

export type HostCheck =
  | { ok: true; kind: "ip"; ip: string; family: 4 | 6 }
  | { ok: true; kind: "name"; name: string }
  | { ok: false; code: string; message: string; reason?: IpBlockReason };

function hostError(code: string, message: string): HostCheck {
  return { ok: false, code, message };
}

/**
 * Canonicalise and statically vet a probe target host. IP literals are
 * classified; names must be fully qualified and outside internal suffixes.
 * Non-canonical IPv4 spellings ("2130706433", "0x7f.1", "127.1") are
 * normalised the way a URL parser would and then classified, so they cannot
 * slip past as "names".
 */
export function checkTargetHost(raw: unknown): HostCheck {
  if (typeof raw !== "string") return hostError("invalid_host", "Enter a host name.");
  let host = raw.trim();
  if (!host) return hostError("invalid_host", "Enter a host name.");
  if (host.length > 255) return hostError("invalid_host", "That host name is too long.");

  if (host.includes(":") || host.startsWith("[")) {
    const v6 = parseIPv6(host);
    if (!v6) return hostError("invalid_host", "That is not a valid IPv6 address.");
    const c = classifyV6Bytes(v6);
    if (c.blocked === true) return blockedIpError(c.reason);
    return { ok: true, kind: "ip", ip: c.normalized, family: 6 };
  }

  if (/[\s/\\?#@%]/.test(host)) return hostError("invalid_host", "Enter just the host name, without a path or port.");

  // Let the WHATWG URL host parser canonicalise (IDN → punycode, lowercase,
  // legacy numeric IPv4 forms → dotted quad).
  let canonical: string;
  try {
    canonical = new URL(`http://${host}/`).hostname;
  } catch {
    return hostError("invalid_host", "That is not a valid host name.");
  }
  host = canonical.replace(/\.$/, "");

  const v4 = parseIPv4(host);
  if (v4) {
    const c = classifyV4Bytes(v4);
    if (c.blocked === true) return blockedIpError(c.reason);
    return { ok: true, kind: "ip", ip: c.normalized, family: 4 };
  }

  if (host.length > 253) return hostError("invalid_host", "That host name is too long.");
  const labels = host.split(".");
  if (labels.length < 2) {
    return hostError("host_not_fqdn", "Use a fully qualified domain name, like api.example.com.");
  }
  for (const l of labels) {
    if (!/^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/.test(l)) {
      return hostError("invalid_host", "That is not a valid host name.");
    }
  }
  const tld = labels[labels.length - 1];
  if (/^[0-9]+$/.test(tld)) return hostError("invalid_host", "That is not a valid host name.");
  for (const suffix of BLOCKED_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      return hostError(
        "host_internal",
        "Outside-in checks run from the public internet and cannot reach internal names. Use the in-network agent for this target.",
      );
    }
  }
  return { ok: true, kind: "name", name: host };
}

function blockedIpError(reason: IpBlockReason): HostCheck {
  return {
    ok: false,
    code: "host_not_public",
    reason,
    message: `Outside-in checks can only reach public addresses (this one is ${reason.replace(/_/g, " ")}). Use the in-network agent for private targets.`,
  };
}

/**
 * Parse a DNS resolver address ("1.1.1.1", "1.1.1.1:53", "2606:4700::1111",
 * "[2606:4700::1111]:53"). Only public IP literals are accepted on a prober:
 * a hostname would be resolved by the prober's own (possibly cluster) DNS.
 */
export function checkResolverAddress(raw: unknown): { ok: true; ip: string; port: number } | { ok: false; code: string; message: string } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, code: "invalid_resolver", message: "Enter a resolver IP address." };
  const s = raw.trim();
  let ip = s;
  let port = 53;
  const bracket = s.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  const v4port = s.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
  if (bracket) {
    ip = bracket[1];
    if (bracket[2]) port = Number(bracket[2]);
  } else if (v4port) {
    ip = v4port[1];
    port = Number(v4port[2]);
  }
  // Port 53 only: a tenant-chosen port would let a hosted check fire UDP at
  // any service on any public host.
  if (port !== 53) {
    return { ok: false, code: "invalid_resolver", message: "On an outside-in check the resolver must use port 53." };
  }
  const c = classifyIp(ip);
  if (c.blocked === true) {
    return c.reason === "invalid_ip"
      ? { ok: false, code: "invalid_resolver", message: "On an outside-in check the resolver must be a public IP address." }
      : { ok: false, code: "resolver_not_public", message: `The resolver must be a public address (this one is ${c.reason.replace(/_/g, " ")}).` };
  }
  return { ok: true, ip: c.normalized, port };
}

// ── Config validation ─────────────────────────────────────────────────────

export type OutsideInConfigResult =
  | { ok: true; sourceType: OutsideInSourceType; config: Record<string, unknown> }
  | { ok: false; code: string; message: string; field?: string; issues?: unknown };

/**
 * Validate an outside-in check's probe config. Runs the normal per-type Zod
 * schema, then the prober policy: allowed type, no env-var refs, public
 * static target, bounded timeouts, no framing headers, public resolver.
 * Returns the parsed config (defaults filled) on success.
 */
export function validateOutsideInConfig(sourceType: unknown, config: unknown): OutsideInConfigResult {
  if (!isOutsideInSourceType(sourceType)) {
    return {
      ok: false,
      code: "source_type_not_allowed",
      message: `Outside-in checks support ${OUTSIDE_IN_SOURCE_TYPES.join(", ")}. Use the in-network agent for other sources.`,
      field: "source_type",
    };
  }
  if (config && typeof config === "object") {
    for (const k of OUTSIDE_IN_FORBIDDEN_KEYS) {
      if ((config as Record<string, unknown>)[k] !== undefined) {
        return {
          ok: false,
          code: "secret_refs_not_allowed",
          message:
            "Outside-in checks run on Observer's hosts, so they cannot read secrets or certificates by env var reference. Use the in-network agent for authenticated targets.",
          field: k,
        };
      }
    }
  }
  const schema = getConfigSchema(sourceType);
  const parsed = schema?.safeParse(config);
  if (!parsed || !parsed.success) {
    return {
      ok: false,
      code: "invalid_probe_config",
      message: `Invalid configuration for a ${sourceType} check.`,
      issues: parsed?.error?.issues,
    };
  }
  const cfg = parsed.data as Record<string, unknown>;

  const timeout = cfg.timeout_ms;
  if (typeof timeout === "number" && timeout > OUTSIDE_IN_MAX_TIMEOUT_MS) {
    return {
      ok: false,
      code: "timeout_too_long",
      message: `Outside-in checks time out after at most ${OUTSIDE_IN_MAX_TIMEOUT_MS / 1000} seconds.`,
      field: "timeout_ms",
    };
  }

  const hostField = (field: string, value: unknown): OutsideInConfigResult | null => {
    const h = checkTargetHost(value);
    return h.ok === true ? null : { ok: false, code: h.code, message: h.message, field };
  };

  switch (sourceType) {
    case "http": {
      let u: URL;
      try {
        u = new URL(String(cfg.url));
      } catch {
        return { ok: false, code: "invalid_url", message: "Enter a valid URL.", field: "url" };
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        return { ok: false, code: "invalid_url", message: "Use an http:// or https:// URL.", field: "url" };
      }
      const bad = hostField("url", u.hostname);
      if (bad) return bad;
      const headers = (cfg.headers ?? {}) as Record<string, string>;
      for (const name of Object.keys(headers)) {
        if (isForbiddenProberHeader(name)) {
          return {
            ok: false,
            code: "header_not_allowed",
            message: `The ${name} header is set by the prober and cannot be overridden.`,
            field: "headers",
          };
        }
      }
      break;
    }
    case "tcp":
    case "tls_cert":
    case "icmp": {
      const bad = hostField("host", cfg.host);
      if (bad) return bad;
      break;
    }
    case "dns": {
      const d = checkTargetHost(cfg.domain);
      // A DNS check only queries the name (nothing connects to the answer),
      // so a public IP literal is not a meaningful domain either way; internal
      // suffixes are refused so cluster DNS is never consulted.
      if (d.ok === false) return { ok: false, code: d.code, message: d.message, field: "domain" };
      if (d.kind === "ip") {
        return { ok: false, code: "invalid_host", message: "Enter a domain name, not an IP address.", field: "domain" };
      }
      if (cfg.resolver !== undefined && cfg.resolver !== "") {
        const r = checkResolverAddress(cfg.resolver);
        if (r.ok === false) return { ok: false, code: r.code, message: r.message, field: "resolver" };
      }
      break;
    }
  }
  return { ok: true, sourceType, config: cfg };
}
