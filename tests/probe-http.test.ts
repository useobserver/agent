import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer } from "node:http";
import { execute, validateConfig } from "../src/sources/http";

// HTTP probe runtime.
//
// Spins up a tiny local http server with routes that mimic the failure
// modes a real probe sees (200 OK, 500, body that doesn't contain a
// match, slow response triggering timeout). All assertions go through
// the standard probe interface so any future refactor that preserves
// the contract keeps these tests green.

let server;
let baseUrl;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/healthy") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("OK");
      return;
    }
    if (req.url === "/error") {
      res.writeHead(500);
      res.end("kaboom");
      return;
    }
    if (req.url === "/body") {
      res.writeHead(200);
      res.end("hello world");
      return;
    }
    if (req.url === "/slow") {
      // Hang the response so the client times out.
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("validateConfig", () => {
  it("rejects missing url", () => {
    expect(validateConfig({})).toMatch(/url/);
  });
  it("rejects malformed url", () => {
    expect(validateConfig({ url: "not-a-url" })).toMatch(/url/);
  });
  it("accepts a well-formed url", () => {
    expect(validateConfig({ url: "https://example.test/healthz" })).toBeNull();
  });
});

describe("execute — success and failure shapes", () => {
  it("200 returns a numeric value (response time ms) and no status_hint", async () => {
    const r = await execute({ url: `${baseUrl}/healthy` });
    expect(r.status_hint).toBeUndefined();
    expect(typeof r.value).toBe("number");
    expect(r.value).toBeGreaterThanOrEqual(0);
    expect(r.metadata?.status).toBe(200);
  });

  it("500 returns no_data with reason carrying the unexpected status code", async () => {
    const r = await execute({ url: `${baseUrl}/error` });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toMatch(/unexpected_status:500/);
    expect(r.value).toBeNull();
  });

  it("body_match present in body returns success", async () => {
    const r = await execute({ url: `${baseUrl}/body`, body_match: "hello" });
    expect(r.status_hint).toBeUndefined();
    expect(typeof r.value).toBe("number");
  });

  it("body_match absent from body returns no_data with reason='body_mismatch'", async () => {
    const r = await execute({ url: `${baseUrl}/body`, body_match: "goodbye" });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBe("body_mismatch");
  });

  it("slow endpoint trips the timeout and returns no_data", async () => {
    const r = await execute({ url: `${baseUrl}/slow`, timeout_ms: 200 });
    expect(r.status_hint).toBe("no_data");
    // node-emitted 'timeout' message OR socket-level ETIMEDOUT — either is acceptable.
    expect(r.reason).toMatch(/timeout|ETIMEDOUT|ECONN/i);
  }, 5_000);

  it("network error (closed port) returns no_data with a code", async () => {
    const r = await execute({ url: "http://127.0.0.1:1/never-listens", timeout_ms: 500 });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toBeTruthy();
  });

  it("expected_status accepts an array", async () => {
    const r = await execute({ url: `${baseUrl}/healthy`, expected_status: [200, 204] });
    expect(r.status_hint).toBeUndefined();
  });
});
