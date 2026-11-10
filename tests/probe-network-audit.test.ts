// Regressions from the 2026-11-10 network-probe audit. Each case runs the
// real source against a local server shaped like the one that broke it.

import { afterAll, describe, expect, it } from "bun:test";
import dgram from "node:dgram";
import net from "node:net";
import { execute as tlsCert } from "../src/sources/tls_cert.ts";
import { execute as dnsProbe } from "../src/sources/dns.ts";
import ws from "../src/sources/websocket.ts";
import http from "../src/sources/http.ts";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) {
    try {
      c();
    } catch {
      /* already down */
    }
  }
});

describe("tls_cert", () => {
  it("times out on a port that accepts TCP but never answers TLS", async () => {
    const s = net.createServer(() => {});
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    cleanups.push(() => s.close());
    const t = Date.now();
    const r = await tlsCert({ host: "127.0.0.1", port: (s.address() as net.AddressInfo).port } as never);
    expect(r.reason).toBe("ETIMEDOUT");
    expect(Date.now() - t).toBeLessThan(13_000);
  }, 20_000);
});

describe("dns", () => {
  function txtServer(chunks: string[]): Promise<number> {
    const s = dgram.createSocket("udp4");
    s.on("message", (q, rinfo) => {
      let i = 12;
      while (q[i] !== 0) i += q[i]! + 1;
      const qEnd = i + 5;
      const rdata = Buffer.concat(chunks.map((c) => Buffer.concat([Buffer.from([c.length]), Buffer.from(c)])));
      const hdr = Buffer.from(q.subarray(0, 12));
      hdr[2] = 0x81;
      hdr[3] = 0x80;
      hdr.writeUInt16BE(1, 6);
      hdr.writeUInt16BE(0, 8);
      hdr.writeUInt16BE(0, 10);
      const ans = Buffer.concat([
        Buffer.from([0xc0, 0x0c, 0, 16, 0, 1, 0, 0, 0, 60]),
        Buffer.from([rdata.length >> 8, rdata.length & 255]),
        rdata,
      ]);
      s.send(Buffer.concat([hdr, q.subarray(12, qEnd), ans]), rinfo.port, rinfo.address);
    });
    cleanups.push(() => s.close());
    return new Promise((r) => s.bind(0, "127.0.0.1", () => r(s.address().port)));
  }

  it("matches expected_value across a TXT record split into strings", async () => {
    const port = await txtServer(["v=spf1 include:_spf.a.example include:_spf.b", ".example ~all"]);
    const r = await dnsProbe({
      domain: "t.example",
      record_type: "TXT",
      resolver: `127.0.0.1:${port}`,
      expected_value: "_spf.b.example",
    } as never);
    expect(r.reason).toBeUndefined();
    expect(typeof r.value).toBe("number");
  });

  it("stops at timeout_ms on a resolver that never answers", async () => {
    const s = dgram.createSocket("udp4");
    s.on("message", () => {});
    await new Promise<void>((r) => s.bind(0, "127.0.0.1", () => r()));
    cleanups.push(() => s.close());
    const t = Date.now();
    const r = await dnsProbe({ domain: "example.com", resolver: `127.0.0.1:${s.address().port}`, timeout_ms: 1000 } as never);
    expect(r.status_hint).toBe("no_data");
    expect(Date.now() - t).toBeLessThan(1_800);
  });
});

describe("websocket", () => {
  function server(onMessage: (sock: { send: (d: string | Uint8Array) => void }, msg: string) => void, banner?: string) {
    const s = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("no", { status: 426 });
      },
      websocket: {
        open(sock) {
          if (banner) sock.send(banner);
        },
        message(sock, msg) {
          onMessage(sock, String(msg));
        },
      },
    });
    cleanups.push(() => s.stop(true));
    return `ws://127.0.0.1:${s.port}`;
  }
  const rt = (url: string, extra: Record<string, unknown> = {}) => ({
    url,
    interpretation: "round_trip_latency",
    ping_mode: "message",
    send_message: "ping",
    expect_message: "pong",
    timeout_ms: 1500,
    ...extra,
  });

  it("waits past a banner frame for the reply", async () => {
    const url = server((sock) => setTimeout(() => sock.send("pong"), 50), '0{"sid":"x"}');
    const r = await ws.execute(rt(url) as never);
    expect(r.reason).toBeUndefined();
    expect(typeof r.value).toBe("number");
  });

  it("still reports a mismatch when only other frames arrive", async () => {
    const url = server((sock) => sock.send("nope"));
    const r = await ws.execute(rt(url) as never);
    expect(r.reason).toBe("ws_reply_mismatch");
  });

  it("matches a binary reply", async () => {
    const url = server((sock) => sock.send(new TextEncoder().encode("pong")));
    const r = await ws.execute(rt(url) as never);
    expect(r.reason).toBeUndefined();
  });
});

describe("http", () => {
  it("names an endless redirect", async () => {
    const s = Bun.serve({
      port: 0,
      fetch(req) {
        const n = Number(new URL(req.url).searchParams.get("n") ?? 0);
        return new Response(null, { status: 302, headers: { location: `/?n=${n + 1}` } });
      },
    });
    cleanups.push(() => s.stop(true));
    const r = await http.execute({ url: `http://127.0.0.1:${s.port}/` } as never);
    expect(r.reason).toBe("too_many_redirects");
  });

  it("keeps an expected 302 at the redirect limit as a success", async () => {
    const s = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 302, headers: { location: "/" } }) });
    cleanups.push(() => s.stop(true));
    const r = await http.execute({ url: `http://127.0.0.1:${s.port}/`, expected_status: [302] } as never);
    expect(r.reason).toBeUndefined();
  });
});

describe("icmp", () => {
  it("lets ping finish its summary when count x timeout is under ping's 1s spacing", async () => {
    // Its own process: probe-icmp.test.ts mocks node:child_process, and
    // Bun's module mocks are process-wide.
    const src = new URL("../src/sources/icmp.ts", import.meta.url).pathname;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const m = await import(${JSON.stringify(src)}); console.log(JSON.stringify(await m.default.execute({ host: "127.0.0.1", count: 5, timeout_ms: 200, interpretation: "packet_loss" })))`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const r = JSON.parse((await new Response(child.stdout).text()).trim()) as { reason?: string; value: number | null };
    // A missing ping binary or raw-socket permission (some CI sandboxes) is
    // its own reason; the bug was icmp_error from killing ping mid-run.
    expect(r.reason).not.toBe("icmp_error");
    if (r.reason === undefined) expect(r.value).toBe(0);
  }, 15_000);
});

const nodeBin = Bun.which("node");

describe("http mTLS", () => {
  it.skipIf(!nodeBin)("names a server that refuses the client cert", async () => {
    const { execSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "mtls-reset-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const mint = (name: string, extra = "") =>
      execSync(
        `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/${name}.key -out ${dir}/${name}.crt -subj "/CN=${name}" -days 2 ${extra} 2>/dev/null`,
      );
    mint("server", `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`);
    mint("trusted");
    mint("stranger");
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    // The server is Node's https server in its own process: Bun's TLS server
    // (Bun.serve and node:https under Bun, 1.3.6) accepts an untrusted
    // client certificate even with rejectUnauthorized, so it can't stand in
    // for nginx / Envoy refusing one.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "srv.mjs"),
      `import https from "node:https"; import { readFileSync } from "node:fs";
const r = (f) => readFileSync(${JSON.stringify(dir)} + "/" + f);
const s = https.createServer({ cert: r("server.crt"), key: r("server.key"), ca: r("trusted.crt"), requestCert: true, rejectUnauthorized: true }, (q, res) => res.end("ok"));
s.listen(0, "127.0.0.1", () => console.log(s.address().port));`,
    );
    const child = Bun.spawn([nodeBin!, join(dir, "srv.mjs")], { stdout: "pipe", stderr: "ignore" });
    cleanups.push(() => child.kill());
    const reader = child.stdout.getReader();
    const first = await reader.read();
    const port = Number(new TextDecoder().decode(first.value).trim());
    const s = { port };
    process.env.T_NET_CERT = read("stranger.crt");
    process.env.T_NET_KEY = read("stranger.key");
    process.env.T_NET_CA = read("server.crt");
    try {
      const r = await http.execute({
        url: `https://localhost:${s.port}/`,
        client_cert_ref: "T_NET_CERT",
        client_key_ref: "T_NET_KEY",
        ca_cert_ref: "T_NET_CA",
      } as never);
      expect(r.status_hint).toBe("no_data");
      expect(r.reason).toBe("mtls_client_cert_rejected");
    } finally {
      delete process.env.T_NET_CERT;
      delete process.env.T_NET_KEY;
      delete process.env.T_NET_CA;
    }
  }, 15_000);
});
