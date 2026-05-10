// HTTP probe source.

import type { ProbeResult, ProbeSource } from "../types.ts";
import { HttpConfigSchema, type HttpConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";

const BODY_PREVIEW_BYTES = 4096;

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const res = await fetch(config.url, {
      method,
      headers,
      signal: controller.signal,
      redirect: followRedirects ? "follow" : "manual",
      // Bun-specific knob — node-fetch ignores.
      tls: { rejectUnauthorized: verifyTls },
    } as RequestInit & { tls?: { rejectUnauthorized: boolean } });
    const elapsed = Date.now() - start;

    if (!expected.includes(res.status)) {
      return {
        value: null,
        timestamp: ts(),
        status_hint: "no_data",
        reason: `unexpected_status:${res.status}`,
        metadata: { status: res.status },
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

    return { value: elapsed, timestamp: ts(), metadata: { status: res.status } };
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string }; code?: string; message?: string };
    if (e?.name === "AbortError") {
      return { value: null, timestamp: ts(), status_hint: "no_data", reason: "ETIMEDOUT" };
    }
    const code = e?.cause?.code ?? e?.code ?? e?.message ?? "http_error";
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: code };
  } finally {
    clearTimeout(timer);
  }
}

const source: ProbeSource<HttpConfig> = { execute, validateConfig };
export default source;
