// Secret request headers (http + websocket) and secret call metadata (grpc).
//
// `header_refs` / `metadata_refs` map a header NAME / metadata KEY to the
// NAME of an env var on the agent host. The cloud stores only those names;
// the value is read from process.env here, at probe time, and never
// persisted, logged, or put in ProbeResult metadata / reason. Same model
// as connection_string_ref, client_cert_ref, token_ref.
//
// Resolution never throws. A ref whose env var is unset (or blank) yields
// `*_ref_missing`; a value carrying characters the transport forbids
// (CR/LF would be a header-injection vector, and fetch / WebSocket /
// grpc-js error messages can echo the offending value) yields
// `*_ref_invalid`. Both carry only the name and env var name, which are
// not secret.

export type SecretRefFailure = "missing" | "invalid";

export type SecretRefResolution =
  | { ok: true; values: Record<string, string>; secretValues: string[] }
  | { ok: false; failure: SecretRefFailure; name: string; ref: string };

// Generic resolver: resolve `refs` from `env` and merge them over `inline`.
// Names compare case-insensitively (HTTP field names and gRPC metadata
// keys both are). `isLegalValue` sees the trimmed value.
export function resolveSecretRefs(
  inline: Record<string, string> | undefined,
  refs: Record<string, string> | undefined,
  isLegalValue: (value: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): SecretRefResolution {
  const values: Record<string, string> = { ...(inline ?? {}) };
  const secretValues: string[] = [];
  for (const [name, ref] of Object.entries(refs ?? {})) {
    const raw = typeof ref === "string" && ref.length > 0 ? env[ref] : undefined;
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) return { ok: false, failure: "missing", name, ref: String(ref) };
    if (!isLegalValue(value)) return { ok: false, failure: "invalid", name, ref: String(ref) };
    // The schema already rejects a name present in both maps; drop any
    // case-insensitive inline duplicate anyway so the secret always wins
    // and a stale out-of-band config can't send two values.
    for (const k of Object.keys(values)) {
      if (k.toLowerCase() === name.toLowerCase()) delete values[k];
    }
    values[name] = value;
    secretValues.push(value);
  }
  return { ok: true, values, secretValues };
}

// ── headers (http + websocket) ─────────────────────────────────────

export type HeaderRefReason = "header_ref_missing" | "header_ref_invalid";

export type HeaderResolution =
  | { ok: true; headers: Record<string, string>; secretValues: string[] }
  | { ok: false; reason: HeaderRefReason; header: string; ref: string };

// Control characters other than HTAB are not legal in a field value
// (RFC 7230 section 3.2). Checked after trimming surrounding whitespace,
// so a trailing newline from `$(cat token-file)` style provisioning is fine.
const ILLEGAL_HEADER_VALUE_CHARS = /[\x00-\x08\x0a-\x1f\x7f]/;

export function resolveHeaderRefs(
  inline: Record<string, string> | undefined,
  refs: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): HeaderResolution {
  const r = resolveSecretRefs(inline, refs, (v) => !ILLEGAL_HEADER_VALUE_CHARS.test(v), env);
  if (r.ok) return { ok: true, headers: r.values, secretValues: r.secretValues };
  return {
    ok: false,
    reason: r.failure === "missing" ? "header_ref_missing" : "header_ref_invalid",
    header: r.name,
    ref: r.ref,
  };
}

// ── call metadata (grpc) ───────────────────────────────────────────

export type MetadataRefReason = "metadata_ref_missing" | "metadata_ref_invalid";

export type MetadataResolution =
  | { ok: true; metadata: Record<string, string>; secretValues: string[] }
  | { ok: false; reason: MetadataRefReason; key: string; ref: string };

// grpc-js accepts only printable ASCII (0x20-0x7E) in a non-binary
// metadata value, and its rejection message embeds the full value.
const LEGAL_METADATA_VALUE = /^[\x20-\x7e]*$/;

export function resolveMetadataRefs(
  inline: Record<string, string> | undefined,
  refs: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MetadataResolution {
  const r = resolveSecretRefs(inline, refs, (v) => LEGAL_METADATA_VALUE.test(v), env);
  if (r.ok) return { ok: true, metadata: r.values, secretValues: r.secretValues };
  return {
    ok: false,
    reason: r.failure === "missing" ? "metadata_ref_missing" : "metadata_ref_invalid",
    key: r.name,
    ref: r.ref,
  };
}

// Replace every occurrence of a resolved secret in a string (an error
// message we are about to surface) with a placeholder.
export function redactSecrets(text: string, secretValues: readonly string[]): string {
  let out = text;
  for (const v of secretValues) {
    if (v) out = out.split(v).join("[redacted]");
  }
  return out;
}
