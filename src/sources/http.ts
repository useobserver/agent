// HTTP probe source.
//
// Two modes:
//   * default — value is response time in ms; status_hint=no_data on
//     non-matching status or body_match failure.
//   * json_path — value is extracted from the JSON response via the
//     configured JSONPath expression. Booleans cast to 0/1; strings
//     coerced numerically; missing / multi-match / non-numeric leaves
//     surface as no_data with a specific reason code.

import type { ProbeResult, ProbeSource } from "../types.ts";
import { HttpConfigSchema, type HttpConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";
import { parseAndExtract } from "./_json-path.ts";
import { hasMtls, isCertExpiringSoon, loadMtlsMaterial, type MtlsMaterial } from "./_mtls.ts";

const BODY_PREVIEW_BYTES = 4096;
// 10 MB cap on JSON bodies. Anything larger is almost certainly a
// configuration mistake — extracting a single number out of a 10MB
// payload defeats the purpose of a thresholded probe.
const JSON_BODY_MAX_BYTES = 10 * 1024 * 1024;

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(HttpConfigSchema, config);
}

export async function execute(config: HttpConfig): Promise<ProbeResult> {
  const ts = (): string => new Date().toISOString();
  const method = (config.method || "GET").toUpperCase();
  const timeoutMs = config.timeout_ms ?? 5_000;
  const expected = Array.isArray(config.expected_status)
    ? config.expected_status
    : [config.expected_status ?? 200];
  const verifyTls = config.verify_tls !== false;
  const followRedirects = config.follow_redirects !== false;
  const headers = config.headers || {};

  // Defense-in-depth: the Zod schema restricts url to http/https, but re-check
  // at runtime so a stale/out-of-band config can't reach file:// (local file
  // read+exfil) or other schemes.
  try {
    const proto = new URL(config.url).protocol;
    if (proto !== "http:" && proto !== "https:") {
      return { value: null, timestamp: ts(), status_hint: "no_data", reason: "invalid_url_scheme", metadata: { protocol: proto } };
    }
  } catch {
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: "invalid_url", metadata: {} };
  }

  // mTLS. When cert+key refs are present, load the
  // PEM material from the agent's env and pass it on the per-request
  // tls options. Loading is cheap (env read + parse) so we don't hold
  // a long-lived Agent; Bun's fetch reuses the connection pool keyed
  // on the tls config, which is stable across ticks for the same
  // metric def. A load failure short-circuits to no_data with a typed
  // mtls_* reason — never leaking cert/key bytes.
  let mtls: MtlsMaterial | null = null;
  let certExpiryWarning: { not_after: string; days_remaining: number } | undefined;
  if (hasMtls(config)) {
    const loaded = loadMtlsMaterial(config);
    if (!loaded.ok) {
      return {
        value: null,
        timestamp: ts(),
        status_hint: "no_data",
        reason: loaded.reason,
        metadata: loaded.detail ? { detail: loaded.detail } : {},
      };
    }
    mtls = loaded.material;
    if (isCertExpiringSoon(mtls)) {
      certExpiryWarning = { not_after: mtls.certNotAfter, days_remaining: mtls.certDaysRemaining };
    }
  }

  // Per-probe tls options. We rebuild this object each tick rather
  // than holding a long-lived Agent because the source is a stateless
  // ProbeSource (no place to cache per-metric state). The cost is one
  // extra TLS handshake per probe if Bun's fetch pools connections by
  // object identity rather than tls-content; at probe cadence (1-60
  // min) that sub-100ms handshake is negligible. Tracked as a perf
  // follow-up if a future high-frequency mTLS probe makes it matter.
  const tlsOptions: Record<string, unknown> = { rejectUnauthorized: verifyTls };
  if (mtls) {
    tlsOptions.cert = mtls.cert;
    tlsOptions.key = mtls.key;
    if (mtls.ca) tlsOptions.ca = mtls.ca;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    // Follow redirects manually so operator-supplied headers (which may carry
    // auth) are DROPPED on a cross-origin hop — `redirect:"follow"` would
    // re-send them to the redirect target. Same-origin hops keep the headers.
    const MAX_REDIRECTS = 5;
    const origin0 = new URL(config.url).origin;
    let currentUrl = config.url;
    let reqHeaders: Record<string, string> = { ...headers };
    let res: Response;
    for (let hop = 0; ; hop++) {
      res = await fetch(currentUrl, {
        method,
        headers: reqHeaders,
        signal: controller.signal,
        redirect: "manual",
        // Bun-specific knob — node-fetch ignores.
        tls: tlsOptions,
      } as RequestInit & { tls?: Record<string, unknown> });
      if (!followRedirects || res.status < 300 || res.status >= 400 || hop >= MAX_REDIRECTS) break;
      const loc = res.headers.get("location");
      if (!loc) break;
      // We're about to follow — this intermediate response's body is
      // never read. Cancel it so the connection returns to the pool
      // instead of idling until GC.
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      const next = new URL(loc, currentUrl);
      if (next.origin !== origin0) reqHeaders = {}; // strip headers cross-origin
      currentUrl = next.toString();
    }
    const elapsed = Date.now() - start;

    if (!expected.includes(res.status)) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      return {
        value: null,
        timestamp: ts(),
        status_hint: "no_data",
        reason: `unexpected_status:${res.status}`,
        metadata: { status: res.status },
      };
    }

    // JSON path mode — value is extracted from the body. body_match
    // still applies as a pre-check if both are configured, and is
    // restricted to the same 4 KB preview window the default path
    // uses (preserving the behavior advertised in the docs).
    if (config.json_path) {
      const contentType = res.headers.get("content-type") ?? "";
      let body = "";
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let received = 0;
        // Effective cap. fetch-level AbortController with `timeout_ms`
        // is the ultimate wall: a connection that streams forever
        // without closing trips the timeout, not this loop. The cap
        // bounds memory growth on slow but valid responses.
        while (received < JSON_BODY_MAX_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
          received += value.byteLength;
        }
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        if (received >= JSON_BODY_MAX_BYTES) {
          return {
            value: null,
            timestamp: ts(),
            status_hint: "no_data",
            reason: "json_body_too_large",
            metadata: { status: res.status, content_type: contentType, body_bytes: received },
          };
        }
      } else {
        body = await res.text();
        if (body.length > JSON_BODY_MAX_BYTES) {
          return {
            value: null,
            timestamp: ts(),
            status_hint: "no_data",
            reason: "json_body_too_large",
            metadata: { status: res.status, content_type: contentType, body_bytes: body.length },
          };
        }
      }
      if (config.body_match && !body.slice(0, BODY_PREVIEW_BYTES).includes(config.body_match)) {
        return {
          value: null,
          timestamp: ts(),
          status_hint: "no_data",
          reason: "body_mismatch",
          metadata: { status: res.status },
        };
      }
      const extracted = parseAndExtract(body, config.json_path);
      if (!extracted.ok) {
        return {
          value: null,
          timestamp: ts(),
          status_hint: "no_data",
          reason: extracted.reason,
          metadata: {
            status: res.status,
            content_type: contentType,
            ...(extracted.detail ? { detail: extracted.detail } : {}),
          },
        };
      }
      return {
        value: extracted.value,
        timestamp: ts(),
        metadata: {
          status: res.status,
          content_type: contentType,
          response_time_ms: elapsed,
          ...(certExpiryWarning ? { cert_expiry_warning: certExpiryWarning } : {}),
        },
      };
    }

    if (config.body_match) {
      const reader = res.body?.getReader();
      let received = 0;
      let buf = "";
      const decoder = new TextDecoder();
      if (reader) {
        while (received < BODY_PREVIEW_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          received += value.byteLength;
        }
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
      } else {
        buf = await res.text();
      }
      if (!buf.includes(config.body_match)) {
        return {
          value: null,
          timestamp: ts(),
          status_hint: "no_data",
          reason: "body_mismatch",
          metadata: { status: res.status },
        };
      }
    } else {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
    }

    return {
      value: elapsed,
      timestamp: ts(),
      metadata: {
        status: res.status,
        ...(certExpiryWarning ? { cert_expiry_warning: certExpiryWarning } : {}),
      },
    };
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string }; code?: string; message?: string };
    if (e?.name === "AbortError") {
      return { value: null, timestamp: ts(), status_hint: "no_data", reason: "ETIMEDOUT" };
    }
    // mTLS handshake failures surface as TLS error codes. Distinguish
    // the common ones so the operator can tell "my client cert was
    // rejected" from "I couldn't verify the server cert". We classify
    // by the error code only — never echo cert/key bytes.
    const code = e?.cause?.code ?? e?.code ?? "";
    if (mtls) {
      const tlsReason = classifyTlsError(code, e?.message);
      if (tlsReason) {
        return {
          value: null,
          timestamp: ts(),
          status_hint: "no_data",
          reason: tlsReason,
          ...(certExpiryWarning ? { metadata: { cert_expiry_warning: certExpiryWarning } } : {}),
        };
      }
      // mTLS active but the error didn't match a known TLS code. Never
      // fall through to e.message here — a TLS / OpenSSL error string
      // can embed cert subject or chain detail. Use the error code if
      // present, else a generic reason.
      return {
        value: null,
        timestamp: ts(),
        status_hint: "no_data",
        reason: code || "mtls_handshake_failed",
      };
    }
    // Typed codes only — never fall back to e.message. A fetch error
    // message can echo the request URL, which may carry userinfo
    // credentials (schema now rejects those, but stale/out-of-band
    // configs can still reach here). Mirrors the mTLS branch above.
    const reason = code || "http_error";
    return { value: null, timestamp: ts(), status_hint: "no_data", reason };
  } finally {
    clearTimeout(timer);
  }
}

// Map a TLS/handshake error code to a curated reason when mTLS is in
// play. Returns null when the code isn't TLS-related (caller falls
// back to the generic code). Never inspects cert/key material.
function classifyTlsError(code: string, message?: string): string | null {
  const m = (message ?? "").toUpperCase();
  if (code === "CERT_HAS_EXPIRED" || m.includes("CERTIFICATE HAS EXPIRED")) {
    return "mtls_server_cert_expired";
  }
  if (
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT"
  ) {
    return "mtls_server_verify_failed";
  }
  if (
    code === "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE" ||
    code === "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED" ||
    code === "ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE" ||
    m.includes("ALERT") ||
    m.includes("HANDSHAKE")
  ) {
    return "mtls_client_cert_rejected";
  }
  return null;
}

const source: ProbeSource<HttpConfig> = { execute, validateConfig };
export default source;
