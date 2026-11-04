// "The env value is inline content or a file path."
//
// Secrets reach the agent as env-var references: the metric config names an
// env var, and the var's value is either the secret itself (PEM text, a
// service-account JSON key, ...) or a path to a file holding it (typical for
// Kubernetes secret mounts). The caller says what inline content looks like.
//
// Never logs or returns the value in an error; failures are a typed
// `failure` the caller maps to its own reason code.

import { readFileSync } from "node:fs";

export type SecretValueFailure =
  | "missing" // the env var named by the ref is unset or empty
  | "unreadable"; // the value is a path that can't be read

export type SecretValueResult =
  | { ok: true; value: string; source: "inline" | "file" }
  | { ok: false; failure: SecretValueFailure };

export type ReadFileText = (path: string) => string;

const readUtf8: ReadFileText = (path) => readFileSync(path, "utf8");

/**
 * Resolve `refName` from `env`. When `isContent(raw)` the raw value is the
 * secret; otherwise it is read as a file path. `readFile` is a test seam.
 */
export function readSecretValue(
  refName: string,
  env: NodeJS.ProcessEnv,
  isContent: (raw: string) => boolean,
  readFile: ReadFileText = readUtf8,
): SecretValueResult {
  const raw = env[refName];
  if (!raw || raw.length === 0) return { ok: false, failure: "missing" };
  if (isContent(raw)) return { ok: true, value: raw, source: "inline" };
  try {
    return { ok: true, value: readFile(raw), source: "file" };
  } catch {
    return { ok: false, failure: "unreadable" };
  }
}
