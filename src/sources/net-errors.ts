// Network error normalisation, shared by every source that opens a socket.
//
// Bun and Node disagree on error codes. Measured on Bun 1.3:
//   * fetch, refused port         -> code "ConnectionRefused"
//   * fetch, NXDOMAIN host        -> code "ConnectionRefused" (same code!)
//   * fetch, reset by peer        -> code "ECONNRESET"
//   * fetch, TLS cert problems    -> OpenSSL names (CERT_HAS_EXPIRED,
//                                    DEPTH_ZERO_SELF_SIGNED_CERT,
//                                    SELF_SIGNED_CERT_IN_CHAIN,
//                                    ERR_TLS_CERT_ALTNAME_INVALID)
//   * AbortSignal.timeout()       -> name "TimeoutError", NUMERIC code 23
//   * node:net / node:tls         -> Node errno codes (ECONNREFUSED, ENOTFOUND)
//   * node:dns Resolver           -> c-ares codes (ENOTFOUND, ETIMEOUT,
//                                    ECONNREFUSED, ...)
// Bun's own socket layer can also surface ConnectionClosed,
// ConnectionResetByPeer, ConnectionTimedOut, FailedToOpenSocket, BrokenPipe.
//
// The reason code is a wire contract the cloud renders (apps/web/lib/
// probe-reasons.ts), so it must come from a small, stable set. Everything
// here maps onto NET_REASON_CODES or the caller's fallback; the raw code
// (never a message, which can echo a URL or cert detail) is returned
// separately for metadata.

import dns from "node:dns";
import net from "node:net";

/** Every reason this module can produce (besides the caller's fallback). */
export const NET_REASON_CODES = [
  // Transport
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "connect_failed",
  // Name resolution
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENODATA",
  "ESERVFAIL",
  "EREFUSED",
  // TLS
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "tls_handshake_failed",
] as const;

export type NetReasonCode = (typeof NET_REASON_CODES)[number];

const KNOWN = new Set<string>(NET_REASON_CODES);

// Raw code -> normalised code. Codes already in NET_REASON_CODES pass
// through unchanged.
const ALIASES: Record<string, NetReasonCode> = {
  // Bun
  ConnectionRefused: "ECONNREFUSED",
  ConnectionFailed: "connect_failed",
  FailedToOpenSocket: "connect_failed",
  ConnectionClosed: "ECONNRESET",
  ConnectionResetByPeer: "ECONNRESET",
  BrokenPipe: "ECONNRESET",
  ConnectionTimedOut: "ETIMEDOUT",
  ConnectionTimeout: "ETIMEDOUT",
  Timeout: "ETIMEDOUT",
  // Node / libuv
  EPIPE: "ECONNRESET",
  ECONNABORTED: "ETIMEDOUT",
  ESOCKETTIMEDOUT: "ETIMEDOUT",
  ENETUNREACH: "EHOSTUNREACH",
  ENETDOWN: "EHOSTUNREACH",
  EHOSTDOWN: "EHOSTUNREACH",
  EADDRNOTAVAIL: "connect_failed",
  // getaddrinfo
  EAI_NONAME: "ENOTFOUND",
  EAI_NODATA: "ENOTFOUND",
  EAI_FAIL: "ENOTFOUND",
  // c-ares (node:dns Resolver)
  ETIMEOUT: "ETIMEDOUT",
  ENOTINITIALIZED: "connect_failed",
  // OpenSSL verify codes folded into their nearest sibling
  CERT_UNTRUSTED: "SELF_SIGNED_CERT_IN_CHAIN",
  UNABLE_TO_GET_ISSUER_CERT: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  CERT_REVOKED: "tls_handshake_failed",
  CERT_SIGNATURE_FAILURE: "tls_handshake_failed",
  HOSTNAME_MISMATCH: "ERR_TLS_CERT_ALTNAME_INVALID",
};

// Bun codes that do not say WHY the connection failed. Bun's fetch reports
// NXDOMAIN with the same code as a refused port.
const AMBIGUOUS_CONNECT = new Set(["ConnectionRefused", "ConnectionFailed"]);

export interface NetErrorClass {
  /** Stable reason: one of NET_REASON_CODES, or the caller's fallback. */
  reason: string;
  /** The raw error code (string codes only), for metadata. */
  raw?: string;
  /** True when the raw code was one of Bun's "could not connect" codes. */
  ambiguousConnect: boolean;
}

function rawCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  // Prefer the cause: undici-style fetch errors wrap the socket error.
  const c = e?.cause?.code ?? e?.code;
  return typeof c === "string" && /^[A-Za-z0-9_]{1,48}$/.test(c) ? c : undefined;
}

/** Normalise one raw code string. Unknown codes return the fallback. */
export function normaliseNetCode(code: string | undefined | null, fallback: string): string {
  if (!code) return fallback;
  if (KNOWN.has(code)) return code;
  const alias = ALIASES[code];
  if (alias) return alias;
  // Any other TLS / OpenSSL failure collapses to one code.
  if (/^ERR_(TLS|SSL)_/.test(code) || /CERT/.test(code)) return "tls_handshake_failed";
  return fallback;
}

/**
 * Classify a thrown network error. Never inspects or returns the message.
 * Abort / timeout errors map to ETIMEDOUT.
 */
export function classifyNetError(err: unknown, fallback: string): NetErrorClass {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  const raw = rawCode(err);
  if (name === "AbortError" || name === "TimeoutError") {
    return { reason: "ETIMEDOUT", raw, ambiguousConnect: false };
  }
  return {
    reason: normaliseNetCode(raw, fallback),
    raw,
    ambiguousConnect: raw !== undefined && AMBIGUOUS_CONNECT.has(raw),
  };
}

/** Test seam: how a hostname is looked up when disambiguating. */
export type LookupFn = (hostname: string) => Promise<unknown>;

const defaultLookup: LookupFn = (hostname) => dns.promises.lookup(hostname);
const LOOKUP_TIMEOUT_MS = 2_000;

/**
 * Classify a fetch() rejection. Same as classifyNetError, plus: when Bun
 * reports an ambiguous "could not connect" for a hostname (not an IP
 * literal), resolve the name once to tell a DNS failure (ENOTFOUND /
 * EAI_AGAIN) from a refused connection. Only runs on the failure path.
 */
export async function classifyFetchError(
  err: unknown,
  url: string | URL,
  fallback: string,
  lookup: LookupFn = defaultLookup,
): Promise<NetErrorClass> {
  const c = classifyNetError(err, fallback);
  if (!c.ambiguousConnect) return c;
  let hostname: string;
  try {
    hostname = new URL(String(url)).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return c;
  }
  if (!hostname || net.isIP(hostname) !== 0) return c;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      lookup(hostname),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("lookup timeout"), { code: "EAI_AGAIN" })), LOOKUP_TIMEOUT_MS);
      }),
    ]);
    return c; // name resolves, so the connection itself failed
  } catch (lookupErr) {
    const dnsReason = normaliseNetCode(rawCode(lookupErr), "ENOTFOUND");
    const isDns = dnsReason === "ENOTFOUND" || dnsReason === "EAI_AGAIN" || dnsReason === "ENODATA" || dnsReason === "ESERVFAIL" || dnsReason === "EREFUSED";
    return { ...c, reason: isDns ? dnsReason : "ENOTFOUND" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Normalised reasons that mean "could not reach the server at all" (as
 * opposed to a TLS or protocol failure). Log sources collapse these into
 * their own *_unreachable reason.
 */
export const UNREACHABLE_REASONS: ReadonlySet<string> = new Set<NetReasonCode>([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "connect_failed",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENODATA",
  "ESERVFAIL",
  "EREFUSED",
]);
