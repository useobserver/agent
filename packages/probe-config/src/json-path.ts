// JSON path extraction helper.
//
// The HTTP probe uses this to extract a numeric value from a JSON
// response body. It lives in the shared config package so the same
// extraction + coercion semantics are available wherever a JSON path
// needs evaluating.

import { JSONPath } from "jsonpath-plus";

export type ExtractError =
  | "json_parse_failed"
  | "json_path_no_match"
  | "json_path_multi_match"
  | "json_path_non_numeric"
  | "json_path_unsupported_type"
  | "json_path_invalid";

export interface ExtractResult {
  ok: true;
  value: number;
}
export interface ExtractFailure {
  ok: false;
  reason: ExtractError;
  detail?: string;
}

/**
 * Apply a JSONPath expression to a parsed JSON value and coerce the
 * single result to a number. Booleans → 0 / 1. Strings that parse
 * as finite numbers are accepted; everything else fails.
 */
export function extractByJsonPath(json: unknown, path: string): ExtractResult | ExtractFailure {
  let matches: unknown[];
  try {
    matches = JSONPath({ path, json: json as object, wrap: true }) as unknown[];
  } catch (e) {
    return { ok: false, reason: "json_path_invalid", detail: (e as Error).message };
  }
  if (!Array.isArray(matches) || matches.length === 0) {
    return { ok: false, reason: "json_path_no_match" };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "json_path_multi_match", detail: `matched ${matches.length} values` };
  }
  const raw = matches[0];
  return coerceNumeric(raw);
}

/**
 * Parse a response body string as JSON, apply the path, return the
 * extracted numeric value. Combines the two steps so callers don't
 * have to thread the parse error through two return shapes.
 */
export function parseAndExtract(body: string, path: string): ExtractResult | ExtractFailure {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, reason: "json_parse_failed" };
  }
  return extractByJsonPath(json, path);
}

function coerceNumeric(raw: unknown): ExtractResult | ExtractFailure {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "json_path_unsupported_type", detail: String(raw) };
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      return { ok: false, reason: "json_path_non_numeric", detail: "non-finite number" };
    }
    return { ok: true, value: raw };
  }
  if (typeof raw === "boolean") {
    return { ok: true, value: raw ? 1 : 0 };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: "json_path_non_numeric", detail: "empty string" };
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return { ok: true, value: parsed };
    }
    return { ok: false, reason: "json_path_non_numeric", detail: `string "${trimmed.slice(0, 32)}"` };
  }
  return { ok: false, reason: "json_path_unsupported_type", detail: Array.isArray(raw) ? "array" : typeof raw };
}
