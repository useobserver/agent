import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { execute, validateConfig } from "../src/sources/tcp";

// TCP probe runtime.

let server;
let port;

beforeAll(async () => {
  server = createServer((sock) => {
    sock.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("validateConfig", () => {
  it("requires host and port", () => {
    expect(validateConfig({})).toMatch(/host/);
    expect(validateConfig({ host: "x" })).toMatch(/port/);
  });
  it("rejects port out of range", () => {
    expect(validateConfig({ host: "x", port: 0 })).toMatch(/port/);
    expect(validateConfig({ host: "x", port: 70_000 })).toMatch(/port/);
  });
});

describe("execute", () => {
  it("connects to a live listener and returns a numeric connect time", async () => {
    const r = await execute({ host: "127.0.0.1", port });
    expect(r.status_hint).toBeUndefined();
    expect(typeof r.value).toBe("number");
    expect(r.value).toBeGreaterThanOrEqual(0);
  });

  it("returns no_data with reason='ECONNREFUSED' on a closed port", async () => {
    const r = await execute({ host: "127.0.0.1", port: 1, timeout_ms: 500 });
    expect(r.status_hint).toBe("no_data");
    expect(r.reason).toMatch(/ECONNREFUSED|ECONN/);
  });

  // Note: a "routable-but-unresponsive" timeout test (192.0.2.0/24) is
  // intentionally skipped here — its behaviour depends on the host's
  // local network configuration (some macs return success for unrouted
  // dest IPs immediately) and produces flakes. The HTTP probe suite
  // covers the timeout branch through a real hung server.
});
