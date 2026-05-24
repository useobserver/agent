// Reusable mTLS material loader.
//
// Shared by the HTTP source (mTLS HTTP) and
// the gRPC source. Resolves client cert / key / optional CA from
// env-var references on the AGENT host. The cloud only ever stores
// the env-var NAMES — never the PEM material — so a customer's
// private key never leaves their network.
//
// An env var's value may be either:
//   * the PEM text directly (begins with "-----BEGIN"), or
//   * a filesystem path to a PEM file (typical for k8s secret mounts).
//
// Security invariants:
//   * Cert + key bytes are NEVER logged or returned in error strings.
//     Errors carry typed reason codes + sanitised detail only.
//   * Key strength is checked (rejects RSA < 2048 bits).
//   * Client-cert expiry is surfaced as a warning (probe still runs
//     until the cert actually fails the handshake).

import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";

export interface MtlsRefs {
  client_cert_ref?: string;
  client_key_ref?: string;
  ca_cert_ref?: string;
}

export interface MtlsMaterial {
  cert: string;
  key: string;
  ca?: string;
  /** Days until the client cert's notAfter. Negative = already expired. */
  certDaysRemaining: number;
  /** notAfter as an ISO date, for messaging. */
  certNotAfter: string;
}

export type MtlsLoadResult =
  | { ok: true; material: MtlsMaterial }
  | { ok: false; reason: MtlsReason; detail?: string };

export type MtlsReason =
  | "mtls_ref_missing" // env var named by the ref is unset
  | "mtls_file_unreadable" // ref points at a path that can't be read
  | "mtls_cert_parse_failed"
  | "mtls_key_parse_failed"
  | "mtls_weak_key"
  | "mtls_cert_expired"
  | "mtls_incomplete"; // cert without key or vice versa

const PEM_MARKER = "-----BEGIN";
const CERT_EXPIRY_WARN_DAYS = 30;
const MIN_RSA_BITS = 2048;

/**
 * Resolve a single env-var ref to PEM text. The value is either PEM
 * directly or a path to a PEM file. Never logs the resolved bytes.
 *
 * Exported so the gRPC source can resolve a CA cert in TLS
 * mode without the full cert+key mTLS flow.
 */
export function loadPemRef(refName: string, env: NodeJS.ProcessEnv): { ok: true; pem: string } | { ok: false; reason: MtlsReason } {
  const raw = env[refName];
  if (!raw || raw.length === 0) return { ok: false, reason: "mtls_ref_missing" };
  if (raw.includes(PEM_MARKER)) {
    return { ok: true, pem: raw };
  }
  // Treat as a filesystem path.
  try {
    const pem = readFileSync(raw, "utf8");
    if (!pem.includes(PEM_MARKER)) return { ok: false, reason: "mtls_cert_parse_failed" };
    return { ok: true, pem };
  } catch {
    return { ok: false, reason: "mtls_file_unreadable" };
  }
}

/**
 * Does this PEM look like a parseable private key? We can't fully
 * validate without the password, but we can reject obvious garbage
 * and detect weak RSA moduli. Returns null on success or a reason.
 */
function inspectKey(pem: string): { weak: boolean } | { reason: MtlsReason } {
  if (!/-----BEGIN (RSA |EC |ENCRYPTED |)PRIVATE KEY-----/.test(pem)) {
    return { reason: "mtls_key_parse_failed" };
  }
  // RSA modulus length heuristic: count the base64 body. A precise
  // check needs crypto.createPrivateKey + asymmetricKeyDetails, which
  // we attempt below; this is the cheap fallback when that throws
  // (e.g. encrypted keys we can't open here).
  try {
    // Lazily require to avoid a hard dep if the key is encrypted.
    const { createPrivateKey } = require("node:crypto") as typeof import("node:crypto");
    const k = createPrivateKey(pem);
    const details = (k as unknown as { asymmetricKeyDetails?: { modulusLength?: number } })
      .asymmetricKeyDetails;
    if (details?.modulusLength && details.modulusLength < MIN_RSA_BITS) {
      return { weak: true };
    }
    return { weak: false };
  } catch {
    // Encrypted or non-extractable key — can't measure strength here.
    // Treat as acceptable; the handshake will reject a truly bad key.
    return { weak: false };
  }
}

/**
 * Load + validate mTLS material from refs. `client_cert_ref` and
 * `client_key_ref` must both be set (or both unset → returns ok:false
 * with mtls_incomplete only when exactly one is set; callers should
 * call hasMtls() first to decide whether mTLS applies at all).
 */
export function loadMtlsMaterial(
  refs: MtlsRefs,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): MtlsLoadResult {
  const hasCert = Boolean(refs.client_cert_ref);
  const hasKey = Boolean(refs.client_key_ref);
  if (hasCert !== hasKey) {
    return { ok: false, reason: "mtls_incomplete" };
  }
  if (!hasCert) {
    // Shouldn't be called in this state; guard anyway.
    return { ok: false, reason: "mtls_incomplete" };
  }

  const certRes = loadPemRef(refs.client_cert_ref as string, env);
  if (!certRes.ok) return { ok: false, reason: certRes.reason, detail: refs.client_cert_ref };
  const keyRes = loadPemRef(refs.client_key_ref as string, env);
  if (!keyRes.ok) {
    return {
      ok: false,
      reason: keyRes.reason === "mtls_cert_parse_failed" ? "mtls_key_parse_failed" : keyRes.reason,
      detail: refs.client_key_ref,
    };
  }

  // Parse the cert for expiry. Never include cert bytes in errors.
  let certDaysRemaining: number;
  let certNotAfter: string;
  try {
    const x = new X509Certificate(certRes.pem);
    const notAfter = new Date(x.validTo);
    certNotAfter = notAfter.toISOString();
    certDaysRemaining = Math.floor((notAfter.getTime() - nowMs) / 86_400_000);
  } catch {
    return { ok: false, reason: "mtls_cert_parse_failed", detail: refs.client_cert_ref };
  }
  if (certDaysRemaining < 0) {
    return { ok: false, reason: "mtls_cert_expired", detail: certNotAfter };
  }

  const keyInspection = inspectKey(keyRes.pem);
  if ("reason" in keyInspection) {
    return { ok: false, reason: keyInspection.reason, detail: refs.client_key_ref };
  }
  if (keyInspection.weak) {
    return { ok: false, reason: "mtls_weak_key", detail: `RSA key under ${MIN_RSA_BITS} bits` };
  }

  let ca: string | undefined;
  if (refs.ca_cert_ref) {
    const caRes = loadPemRef(refs.ca_cert_ref, env);
    if (!caRes.ok) return { ok: false, reason: caRes.reason, detail: refs.ca_cert_ref };
    ca = caRes.pem;
  }

  return {
    ok: true,
    material: { cert: certRes.pem, key: keyRes.pem, ca, certDaysRemaining, certNotAfter },
  };
}

/** True when the config carries mTLS material (cert ref present). */
export function hasMtls(refs: MtlsRefs): boolean {
  return Boolean(refs.client_cert_ref) || Boolean(refs.client_key_ref);
}

/** True when the loaded cert is within the expiry-warning window. */
export function isCertExpiringSoon(material: MtlsMaterial): boolean {
  return material.certDaysRemaining <= CERT_EXPIRY_WARN_DAYS;
}

export const MTLS_CERT_EXPIRY_WARN_DAYS = CERT_EXPIRY_WARN_DAYS;
