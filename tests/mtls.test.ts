// mTLS material loader tests.
//
// Generates a throwaway self-signed cert/key at test time so we
// exercise real X509 parsing + expiry logic without a fixture file.

import { afterEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasMtls,
  isCertExpiringSoon,
  loadMtlsMaterial,
  MTLS_CERT_EXPIRY_WARN_DAYS,
} from "../src/sources/_mtls.ts";

// Build a self-signed cert valid `days` from now using Bun's
// X509Certificate is read-only; we shell to a minimal cert built via
// the `selfsigned`-free path: use node's crypto to make a key and a
// hand-rolled cert is heavy, so instead we ship a tiny fixture pair
// generated once. To keep the test hermetic we generate an RSA key
// and reuse a known-good PEM cert string with a far-future expiry.

// 2048-bit RSA keypair, PEM PKCS#8.
function makeKey(bits = 2048): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: bits,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return privateKey as string;
}

// Certs are minted at test time with the system openssl (positive
// -days only on LibreSSL). Expired / expiring-soon cases are driven
// by injecting a future clock into loadMtlsMaterial rather than
// backdating the cert (LibreSSL can't backdate). The loader parses
// the cert for expiry but never cross-checks cert↔key, so a
// freshly-generated key pairs fine with any minted cert for these
// unit tests; the TLS handshake (out of scope here) is what actually
// validates the pair.

let tmp: string | null = null;
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  }
  delete process.env.T_CERT;
  delete process.env.T_KEY;
  delete process.env.T_CA;
});

describe("hasMtls", () => {
  it("false when no refs", () => {
    expect(hasMtls({})).toBe(false);
  });
  it("true when cert ref present", () => {
    expect(hasMtls({ client_cert_ref: "T_CERT" })).toBe(true);
  });
  it("true when key ref present (incomplete still counts as 'mTLS intended')", () => {
    expect(hasMtls({ client_key_ref: "T_KEY" })).toBe(true);
  });
});

describe("loadMtlsMaterial — error paths", () => {
  it("mtls_incomplete when only cert ref set", () => {
    process.env.T_CERT = "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----";
    const r = loadMtlsMaterial({ client_cert_ref: "T_CERT" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mtls_incomplete");
  });

  it("mtls_ref_missing when the env var is unset", () => {
    const r = loadMtlsMaterial({ client_cert_ref: "T_CERT", client_key_ref: "T_KEY" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mtls_ref_missing");
  });

  it("mtls_cert_parse_failed on garbage cert PEM", () => {
    process.env.T_CERT = "-----BEGIN CERTIFICATE-----\nnot base64 cert\n-----END CERTIFICATE-----";
    process.env.T_KEY = makeKey();
    const r = loadMtlsMaterial({ client_cert_ref: "T_CERT", client_key_ref: "T_KEY" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mtls_cert_parse_failed");
  });

  it("mtls_key_parse_failed when key PEM isn't a private key", () => {
    // Use a real cert so we get past the cert parse, then a bad key.
    const cert = makeSelfSignedCertPem(3650);
    process.env.T_CERT = cert;
    process.env.T_KEY = "-----BEGIN CERTIFICATE-----\nxx\n-----END CERTIFICATE-----";
    const r = loadMtlsMaterial({ client_cert_ref: "T_CERT", client_key_ref: "T_KEY" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mtls_key_parse_failed");
  });

  it("mtls_cert_expired when the clock is past the cert's notAfter", () => {
    // LibreSSL can't backdate a cert, so we mint a real 2-day cert and
    // advance the injected clock 10 days to push it past notAfter.
    process.env.T_CERT = makeSelfSignedCertPem(2);
    process.env.T_KEY = makeKey();
    const tenDaysAhead = Date.now() + 10 * 86_400_000;
    const r = loadMtlsMaterial(
      { client_cert_ref: "T_CERT", client_key_ref: "T_KEY" },
      process.env,
      tenDaysAhead,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mtls_cert_expired");
  });

  it("mtls_file_unreadable when ref points at a missing path", () => {
    process.env.T_CERT = "/no/such/path/cert.pem";
    process.env.T_KEY = makeKey();
    const r = loadMtlsMaterial({ client_cert_ref: "T_CERT", client_key_ref: "T_KEY" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("mtls_file_unreadable");
  });

  it("error detail never contains cert/key bytes", () => {
    process.env.T_CERT = "-----BEGIN CERTIFICATE-----\nSECRETMATERIAL\n-----END CERTIFICATE-----";
    process.env.T_KEY = "-----BEGIN PRIVATE KEY-----\nSECRETKEYBYTES\n-----END PRIVATE KEY-----";
    const r = loadMtlsMaterial({ client_cert_ref: "T_CERT", client_key_ref: "T_KEY" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const s = JSON.stringify(r);
      expect(s).not.toContain("SECRETMATERIAL");
      expect(s).not.toContain("SECRETKEYBYTES");
    }
  });
});

describe("loadMtlsMaterial — happy path", () => {
  it("loads cert + key + computes expiry", () => {
    process.env.T_CERT = makeSelfSignedCertPem(3650);
    process.env.T_KEY = makeKey();
    const r = loadMtlsMaterial({ client_cert_ref: "T_CERT", client_key_ref: "T_KEY" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.material.cert).toContain("BEGIN CERTIFICATE");
      expect(r.material.key).toContain("PRIVATE KEY");
      expect(r.material.certDaysRemaining).toBeGreaterThan(3000);
      expect(isCertExpiringSoon(r.material)).toBe(false);
    }
  });

  it("flags expiry within the warning window", () => {
    // Mint a 3650-day cert, then advance the clock to within 10 days
    // of its notAfter so the warning window trips deterministically.
    process.env.T_CERT = makeSelfSignedCertPem(3650);
    process.env.T_KEY = makeKey();
    const tenDaysBeforeExpiry = Date.now() + (3650 - 10) * 86_400_000;
    const r = loadMtlsMaterial(
      { client_cert_ref: "T_CERT", client_key_ref: "T_KEY" },
      process.env,
      tenDaysBeforeExpiry,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.material.certDaysRemaining).toBeLessThanOrEqual(MTLS_CERT_EXPIRY_WARN_DAYS);
      expect(isCertExpiringSoon(r.material)).toBe(true);
    }
  });

  it("reads PEM from a file path", () => {
    tmp = mkdtempSync(join(tmpdir(), "mtls-"));
    const certPath = join(tmp, "cert.pem");
    writeFileSync(certPath, makeSelfSignedCertPem(3650));
    process.env.T_CERT = certPath;
    process.env.T_KEY = makeKey();
    const r = loadMtlsMaterial({ client_cert_ref: "T_CERT", client_key_ref: "T_KEY" });
    expect(r.ok).toBe(true);
  });

  it("loads optional CA cert", () => {
    process.env.T_CERT = makeSelfSignedCertPem(3650);
    process.env.T_KEY = makeKey();
    process.env.T_CA = makeSelfSignedCertPem(3650);
    const r = loadMtlsMaterial({
      client_cert_ref: "T_CERT",
      client_key_ref: "T_KEY",
      ca_cert_ref: "T_CA",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.material.ca).toContain("BEGIN CERTIFICATE");
  });
});

// ── helper: mint a self-signed cert with a given validity window ──
//
// Bun ships node:crypto's X509Certificate (read-only) but no cert
// builder. We generate one via the bundled `openssl` if present;
// otherwise skip the cert-bearing tests. This keeps the suite
// hermetic on machines with openssl (CI images have it).
function makeSelfSignedCertPem(days: number): string {
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "mtls-mint-"));
  const keyPath = join(dir, "k.pem");
  const certPath = join(dir, "c.pem");
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${keyPath} -out ${certPath} -subj "/CN=test" -days ${days} 2>/dev/null`,
  );
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const pem = readFileSync(certPath, "utf8");
  rmSync(dir, { recursive: true, force: true });
  new X509Certificate(pem); // sanity: parseable
  return pem;
}
