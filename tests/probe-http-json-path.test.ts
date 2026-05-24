// JSONPath extraction on the HTTP probe.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { HttpConfig } from "@observer/probe-config";
import http from "../src/sources/http.ts";
import {
  extractByJsonPath,
  parseAndExtract,
} from "../src/sources/_json-path.ts";

describe("extractByJsonPath", () => {
  it("returns the numeric leaf for a direct path", () => {
    const r = extractByJsonPath({ queue_depth: 42 }, "$.queue_depth");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it("casts boolean true to 1, false to 0", () => {
    const t = extractByJsonPath({ ok: true }, "$.ok");
    const f = extractByJsonPath({ ok: false }, "$.ok");
    expect(t.ok && t.value).toBe(1);
    expect(f.ok && f.value).toBe(0);
  });

  it("coerces numeric strings", () => {
    const r = extractByJsonPath({ count: "17" }, "$.count");
    expect(r.ok && r.value).toBe(17);
  });

  it("rejects non-numeric strings", () => {
    const r = extractByJsonPath({ status: "healthy" }, "$.status");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("json_path_non_numeric");
  });

  it("rejects missing paths", () => {
    const r = extractByJsonPath({ a: 1 }, "$.b");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("json_path_no_match");
  });

  it("rejects multi-match paths", () => {
    const r = extractByJsonPath({ a: [1, 2, 3] }, "$.a[*]");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("json_path_multi_match");
  });

  it("rejects arrays as the matched value", () => {
    const r = extractByJsonPath({ a: [1] }, "$.a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("json_path_unsupported_type");
  });

  it("rejects objects as the matched value", () => {
    const r = extractByJsonPath({ a: { x: 1 } }, "$.a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("json_path_unsupported_type");
  });

  it("rejects null leaves", () => {
    const r = extractByJsonPath({ a: null }, "$.a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("json_path_unsupported_type");
  });

  it("rejects non-finite numbers (Infinity, NaN parse)", () => {
    const inf = extractByJsonPath({ x: "Infinity" }, "$.x");
    // Number("Infinity") is Infinity (not finite) → non_numeric
    expect(inf.ok).toBe(false);
    if (!inf.ok) expect(inf.reason).toBe("json_path_non_numeric");
  });

  it("walks deeply nested paths", () => {
    const r = extractByJsonPath({ a: { b: { c: 99 } } }, "$.a.b.c");
    expect(r.ok && r.value).toBe(99);
  });

  it("handles array-index paths", () => {
    const r = extractByJsonPath({ items: [10, 20, 30] }, "$.items[1]");
    expect(r.ok && r.value).toBe(20);
  });
});

describe("parseAndExtract", () => {
  it("fails on invalid JSON", () => {
    const r = parseAndExtract("not json", "$.a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("json_parse_failed");
  });

  it("succeeds on valid JSON + path", () => {
    const r = parseAndExtract('{"x":7}', "$.x");
    expect(r.ok && r.value).toBe(7);
  });
});

describe("HTTP probe with json_path", () => {
  // Stand up a tiny test server. Bun.serve is the canonical way.
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let lastAuthHeader: string | null = null;
  const responses: Record<string, { status: number; body: string; contentType: string }> = {
    "/queue": { status: 200, body: JSON.stringify({ queue_depth: 42, ok: true }), contentType: "application/json" },
    "/missing": { status: 200, body: JSON.stringify({ other: 1 }), contentType: "application/json" },
    "/multi": { status: 200, body: JSON.stringify({ items: [1, 2, 3] }), contentType: "application/json" },
    "/string": { status: 200, body: JSON.stringify({ status: "healthy" }), contentType: "application/json" },
    "/non-json": { status: 200, body: "queue_depth=42", contentType: "text/plain" },
    "/garbage": { status: 200, body: "{ this is not json", contentType: "application/json" },
    "/bool": { status: 200, body: JSON.stringify({ paused: false }), contentType: "application/json" },
    "/match-then-extract": {
      status: 200,
      body: JSON.stringify({ status: "ok", queue_depth: 5 }),
      contentType: "application/json",
    },
  };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        lastAuthHeader = req.headers.get("authorization");
        if (url.pathname === "/large") {
          // Stream a body that exceeds the 10 MB cap so we can drive
          // the json_body_too_large branch.
          const stream = new ReadableStream({
            start(controller) {
              const chunk = new Uint8Array(64 * 1024).fill(0x78); // 'x'
              const total = 11 * 1024 * 1024;
              let sent = 0;
              while (sent < total) {
                controller.enqueue(chunk);
                sent += chunk.byteLength;
              }
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        const r = responses[url.pathname];
        if (!r) return new Response("404", { status: 404 });
        return new Response(r.body, {
          status: r.status,
          headers: { "content-type": r.contentType },
        });
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
  });

  // Typed builder so tests don't reach for `as any`.
  const cfg = (overrides: Partial<HttpConfig>): HttpConfig => ({
    url: `${baseUrl}/queue`,
    method: "GET",
    expected_status: 200,
    timeout_ms: 5000,
    follow_redirects: true,
    verify_tls: true,
    ...overrides,
  });

  it("extracts a numeric value from the JSON response", async () => {
    const res = await http.execute(cfg({ json_path: "$.queue_depth" }));
    expect(res.value).toBe(42);
    expect(res.status_hint).toBeUndefined();
  });

  it("falls back to response time when json_path is absent", async () => {
    const res = await http.execute(cfg({}));
    expect(typeof res.value).toBe("number");
    expect(res.value).toBeGreaterThanOrEqual(0);
  });

  it("returns no_data with reason json_path_no_match for missing fields", async () => {
    const res = await http.execute(
      cfg({ url: `${baseUrl}/missing`, json_path: "$.queue_depth" }),
    );
    expect(res.status_hint).toBe("no_data");
    expect(res.reason).toBe("json_path_no_match");
  });

  it("returns no_data with reason json_path_multi_match for multi-value paths", async () => {
    const res = await http.execute(
      cfg({ url: `${baseUrl}/multi`, json_path: "$.items[*]" }),
    );
    expect(res.status_hint).toBe("no_data");
    expect(res.reason).toBe("json_path_multi_match");
  });

  it("returns no_data with reason json_path_non_numeric for non-numeric leaves", async () => {
    const res = await http.execute(
      cfg({ url: `${baseUrl}/string`, json_path: "$.status" }),
    );
    expect(res.status_hint).toBe("no_data");
    expect(res.reason).toBe("json_path_non_numeric");
  });

  it("returns no_data with reason json_parse_failed for malformed JSON", async () => {
    const res = await http.execute(
      cfg({ url: `${baseUrl}/garbage`, json_path: "$.x" }),
    );
    expect(res.status_hint).toBe("no_data");
    expect(res.reason).toBe("json_parse_failed");
  });

  it("casts booleans to 0 / 1", async () => {
    const res = await http.execute(
      cfg({ url: `${baseUrl}/bool`, json_path: "$.paused" }),
    );
    expect(res.value).toBe(0);
  });

  it("treats non-JSON content_type the same (try parse, fail on invalid JSON)", async () => {
    const res = await http.execute(
      cfg({ url: `${baseUrl}/non-json`, json_path: "$.queue_depth" }),
    );
    expect(res.status_hint).toBe("no_data");
    expect(res.reason).toBe("json_parse_failed");
  });

  it("body_match runs first; failure short-circuits before extraction", async () => {
    const res = await http.execute(
      cfg({
        url: `${baseUrl}/match-then-extract`,
        body_match: "not-present",
        json_path: "$.queue_depth",
      }),
    );
    expect(res.status_hint).toBe("no_data");
    expect(res.reason).toBe("body_mismatch");
  });

  it("body_match passes + json_path extracts: returns the numeric value", async () => {
    const res = await http.execute(
      cfg({
        url: `${baseUrl}/match-then-extract`,
        body_match: "ok",
        json_path: "$.queue_depth",
      }),
    );
    expect(res.value).toBe(5);
    expect(res.status_hint).toBeUndefined();
  });

  it("returns no_data with reason json_body_too_large when body exceeds 10 MB", async () => {
    const res = await http.execute(
      cfg({ url: `${baseUrl}/large`, json_path: "$.x", timeout_ms: 30_000 }),
    );
    expect(res.status_hint).toBe("no_data");
    expect(res.reason).toBe("json_body_too_large");
  });

  it("forwards configured headers to the probed endpoint", async () => {
    lastAuthHeader = null;
    await http.execute(
      cfg({
        url: `${baseUrl}/queue`,
        headers: { Authorization: "Bearer test-token" },
        json_path: "$.queue_depth",
      }),
    );
    expect(lastAuthHeader).toBe("Bearer test-token");
  });

  it("returns no_data with reason json_path_invalid for malformed JSONPath expressions", () => {
    // Pure helper test — easier than exercising via http.execute, but
    // the integrated path goes through the same coercion.
    const r = parseAndExtract('{"a":1}', "$[?(@");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("json_path_invalid");
  });
});
