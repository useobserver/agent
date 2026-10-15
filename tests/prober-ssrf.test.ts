import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import net from "node:net";
import { checkResolverAddress, checkTargetHost, classifyIp, validateOutsideInConfig } from "@observer/probe-config";
import { vetHost, parseDnsServers, type ResolveFn } from "../src/prober/guard";
import { proberDns, proberHttp, proberIcmp, proberTcp, proberTlsCert, type ProberDeps } from "../src/prober/sources";

// Managed-prober SSRF suite. Each blocked class is asserted on its own so a
// regression names the exact range that reopened.

describe("classifyIp: IPv4 blocked ranges", () => {
  const cases: Array<[string, string]> = [
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "unspecified"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.254", "private"],
    ["192.168.1.1", "private"],
    ["127.0.0.1", "loopback"],
    ["127.255.0.9", "loopback"],
    ["169.254.1.1", "link_local"],
    ["100.64.0.1", "carrier_grade_nat"],
    ["100.127.255.254", "carrier_grade_nat"],
    ["169.254.169.254", "cloud_metadata"],
    ["169.254.170.2", "cloud_metadata"],
    ["168.63.129.16", "cloud_metadata"],
    ["100.100.100.200", "cloud_metadata"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
    ["192.0.2.10", "documentation"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    ["198.18.0.1", "benchmarking"],
    ["192.0.0.8", "ietf_special"],
    ["192.88.99.1", "reserved"],
  ];
  for (const [ip, reason] of cases) {
    it(`${ip} → ${reason}`, () => {
      const c = classifyIp(ip);
      expect(c.blocked).toBe(true);
      if (c.blocked) expect(c.reason).toBe(reason);
    });
  }
  it("allows public addresses at range edges", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0", "169.253.255.255", "11.0.0.1", "223.255.255.254"]) {
      expect(classifyIp(ip).blocked).toBe(false);
    }
  });
  it("fails closed on malformed / non-canonical input", () => {
    for (const ip of ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "0x7f.0.0.1", "2130706433", "localhost"]) {
      const c = classifyIp(ip);
      expect(c.blocked).toBe(true);
    }
  });
});

describe("classifyIp: IPv6 blocked ranges", () => {
  const cases: Array<[string, string]> = [
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["[::1]", "loopback"],
    ["fe80::1", "link_local"],
    ["febf::1", "link_local"],
    ["fec0::1", "site_local"],
    ["fc00::1", "unique_local"],
    ["fd12:3456::1", "unique_local"],
    ["fd00:ec2::254", "cloud_metadata"],
    ["ff02::1", "multicast"],
    ["ff05::2", "multicast"],
    ["::ffff:127.0.0.1", "ipv4_mapped"],
    ["::ffff:7f00:1", "ipv4_mapped"],
    ["::ffff:169.254.169.254", "ipv4_mapped"],
    ["::ffff:8.8.8.8", "ipv4_mapped"],
    ["::ffff:0:10.0.0.1", "ipv4_mapped"],
    ["::127.0.0.1", "ipv4_compatible"],
    ["::a00:1", "ipv4_compatible"],
    ["64:ff9b::10.0.0.1", "nat64"],
    ["64:ff9b::a9fe:a9fe", "nat64"],
    ["64:ff9b:1::1", "nat64"],
    ["2002:7f00:1::", "6to4"],
    ["2002:a9fe:a9fe::1", "6to4"],
    ["2001:0:4136:e378::1", "teredo"],
    ["2001:db8::1", "documentation"],
    ["3fff::1", "documentation"],
    ["2001:2::1", "ietf_special"],
    ["100::1", "not_global_unicast"],
    ["4000::1", "not_global_unicast"],
  ];
  for (const [ip, reason] of cases) {
    it(`${ip} → ${reason}`, () => {
      const c = classifyIp(ip);
      expect(c.blocked).toBe(true);
      if (c.blocked) expect(c.reason).toBe(reason);
    });
  }
  it("allows global unicast", () => {
    for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "2620:fe::fe"]) {
      expect(classifyIp(ip).blocked).toBe(false);
    }
  });
  it("rejects zone ids and garbage", () => {
    for (const ip of ["fe80::1%eth0", "2606:4700::1111%1", ":::", "1::2::3", "12345::1", "::ffff:999.1.1.1"]) {
      expect(classifyIp(ip).blocked).toBe(true);
    }
  });
});

describe("checkTargetHost", () => {
  it("canonicalises legacy numeric IPv4 spellings before classifying", () => {
    for (const h of ["2130706433", "0x7f.1", "127.1", "0177.0.0.1", "0x7f000001", "017700000001"]) {
      const r = checkTargetHost(h);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("host_not_public");
    }
  });
  it("blocks internal names and single labels", () => {
    for (const h of ["localhost", "foo.localhost", "db.internal", "metadata.google.internal", "api.svc", "pg.observer.svc.cluster.local", "printer.local", "router.lan", "nas.home.arpa", "intranet"]) {
      expect(checkTargetHost(h).ok).toBe(false);
    }
  });
  it("blocks bracketed / bare IPv6 literals in private ranges", () => {
    expect(checkTargetHost("[::1]").ok).toBe(false);
    expect(checkTargetHost("fd00:ec2::254").ok).toBe(false);
  });
  it("rejects paths, userinfo and ports smuggled in the host", () => {
    for (const h of ["example.com/x", "user@example.com", "example.com#x", "exa mple.com"]) {
      expect(checkTargetHost(h).ok).toBe(false);
    }
  });
  it("accepts public names and IPs (IDN normalised)", () => {
    expect(checkTargetHost("api.example.com")).toEqual({ ok: true, kind: "name", name: "api.example.com" });
    expect(checkTargetHost("API.Example.COM.")).toEqual({ ok: true, kind: "name", name: "api.example.com" });
    expect(checkTargetHost("8.8.8.8")).toMatchObject({ ok: true, kind: "ip", ip: "8.8.8.8" });
    const idn = checkTargetHost("bücher.de");
    expect(idn.ok && idn.kind === "name" && idn.name).toBe("xn--bcher-kva.de");
  });
});

describe("checkResolverAddress", () => {
  it("accepts public IPs with optional port", () => {
    expect(checkResolverAddress("1.1.1.1")).toEqual({ ok: true, ip: "1.1.1.1", port: 53 });
    expect(checkResolverAddress("9.9.9.9:53")).toEqual({ ok: true, ip: "9.9.9.9", port: 53 });
    expect(checkResolverAddress("9.9.9.9:5353").ok).toBe(false);
    expect(checkResolverAddress("[2606:4700:4700::1111]:53").ok).toBe(true);
  });
  it("rejects private resolvers and hostnames", () => {
    for (const r of ["10.0.0.2", "127.0.0.53", "169.254.169.253", "[::1]:53", "dns.google", "kube-dns.kube-system.svc"]) {
      expect(checkResolverAddress(r).ok).toBe(false);
    }
  });
});

describe("parseDnsServers", () => {
  it("defaults to public resolvers and refuses private ones", () => {
    expect(parseDnsServers(undefined)).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(parseDnsServers("9.9.9.9, 1.0.0.1")).toEqual(["9.9.9.9", "1.0.0.1"]);
    expect(() => parseDnsServers("10.96.0.10")).toThrow();
  });
});

// ── vetHost: resolution + every-answer vetting ────────────────────────────

const zone: Record<string, { v4: string[]; v6: string[] }> = {
  "public.example.com": { v4: ["93.184.216.34"], v6: [] },
  "public6.example.com": { v4: [], v6: ["2606:2800:220:1:248:1893:25c8:1946"] },
  "private.example.com": { v4: ["10.1.2.3"], v6: [] },
  "loop.example.com": { v4: ["127.0.0.1"], v6: [] },
  "meta.example.com": { v4: ["169.254.169.254"], v6: [] },
  "mixed.example.com": { v4: ["93.184.216.34", "192.168.0.10"], v6: [] },
  "mixed6.example.com": { v4: ["93.184.216.34"], v6: ["::ffff:127.0.0.1"] },
  "ula.example.com": { v4: [], v6: ["fd00:ec2::254"] },
  "cgnat.example.com": { v4: ["100.64.1.1"], v6: [] },
  "empty.example.com": { v4: [], v6: [] },
};
const fakeResolve: ResolveFn = async (name) => {
  const z = zone[name];
  if (!z) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return z;
};

describe("vetHost", () => {
  it("pins the first public v4 answer", async () => {
    expect(await vetHost("public.example.com", fakeResolve)).toEqual({ ok: true, hostname: "public.example.com", ip: "93.184.216.34", family: 4 });
  });
  it("pins a v6 answer when there is no v4", async () => {
    const v = await vetHost("public6.example.com", fakeResolve);
    expect(v.ok && v.family).toBe(6);
  });
  const blocked: Array<[string, string]> = [
    ["private.example.com", "target_not_public:private"],
    ["loop.example.com", "target_not_public:loopback"],
    ["meta.example.com", "target_not_public:cloud_metadata"],
    ["mixed.example.com", "target_not_public:private"],
    ["mixed6.example.com", "target_not_public:ipv4_mapped"],
    ["ula.example.com", "target_not_public:cloud_metadata"],
    ["cgnat.example.com", "target_not_public:carrier_grade_nat"],
    ["empty.example.com", "dns_no_answer"],
    ["nxdomain.example.com", "dns_failed"],
    ["127.0.0.1", "target_not_public:loopback"],
    ["169.254.169.254", "target_not_public:cloud_metadata"],
    ["db.internal", "host_internal"],
  ];
  for (const [host, reason] of blocked) {
    it(`${host} → ${reason}`, async () => {
      expect(await vetHost(host, fakeResolve)).toEqual({ ok: false, reason });
    });
  }
});

// ── HTTP: pinning, redirects, caps ────────────────────────────────────────

let server: Server;
let port = 0;
let lastHeaders: IncomingHttpHeaders = {};
let lastRemote = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    lastHeaders = req.headers;
    lastRemote = req.socket.remoteAddress ?? "";
    const u = req.url ?? "/";
    if (u === "/ok") return void res.writeHead(200).end("hello world");
    if (u === "/redirect-loopback") return void res.writeHead(302, { location: `http://127.0.0.1:${port}/ok` }).end();
    if (u === "/redirect-metadata") return void res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    if (u === "/redirect-private-name") return void res.writeHead(301, { location: "http://private.example.com/ok" }).end();
    if (u === "/redirect-v6-mapped") return void res.writeHead(302, { location: "http://[::ffff:127.0.0.1]/" }).end();
    if (u === "/redirect-file") return void res.writeHead(302, { location: "file:///etc/passwd" }).end();
    if (u === "/redirect-public") return void res.writeHead(302, { location: "http://public6.example.com/ok" }).end();
    if (u === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
    if (u === "/big") {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = "x".repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent < 4 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      return void pump();
    }
    if (u === "/slow") return; // never answers
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

// Vetting runs against the fake public zone; only AFTER a target passes is
// the connection redirected to the local test server (the dialTarget seam).
function deps(over: Partial<ProberDeps> = {}): ProberDeps {
  return {
    resolve: fakeResolve,
    dnsServers: ["1.1.1.1"],
    icmpEnabled: true,
    userAgent: "ObserverProber/test",
    dialTarget: (_v, _p) => ({ ip: "127.0.0.1", family: 4, port }),
    ...over,
  };
}

describe("proberHttp", () => {
  it("connects to the vetted address and keeps the original Host header", async () => {
    const r = await proberHttp({ url: "http://public.example.com/ok", timeout_ms: 3000 } as never, deps());
    expect(r.status_hint).toBeUndefined();
    expect(lastHeaders.host).toBe("public.example.com");
    expect(lastHeaders["user-agent"]).toBe("ObserverProber/test");
    expect(lastRemote).toContain("127.0.0.1");
  });
  it("keeps a non-default port in the Host header", async () => {
    await proberHttp({ url: "http://public.example.com:8080/ok", timeout_ms: 3000 } as never, deps());
    expect(lastHeaders.host).toBe("public.example.com:8080");
  });
  it("refuses a private target before connecting", async () => {
    let dialed = false;
    const r = await proberHttp({ url: "http://private.example.com/ok" } as never, deps({ dialTarget: () => ((dialed = true), { ip: "127.0.0.1", family: 4, port }) }));
    expect(r.reason).toBe("target_not_public:private");
    expect(dialed).toBe(false);
  });
  it("re-vets a redirect to a loopback IP", async () => {
    const r = await proberHttp({ url: "http://public.example.com/redirect-loopback" } as never, deps());
    expect(r.reason).toBe("target_not_public:loopback");
  });
  it("re-vets a redirect to cloud metadata", async () => {
    const r = await proberHttp({ url: "http://public.example.com/redirect-metadata" } as never, deps());
    expect(r.reason).toBe("target_not_public:cloud_metadata");
  });
  it("re-vets a redirect to a name that resolves private", async () => {
    const r = await proberHttp({ url: "http://public.example.com/redirect-private-name" } as never, deps());
    expect(r.reason).toBe("target_not_public:private");
  });
  it("re-vets a redirect to an IPv4-mapped IPv6 literal", async () => {
    const r = await proberHttp({ url: "http://public.example.com/redirect-v6-mapped" } as never, deps());
    expect(r.reason).toBe("target_not_public:ipv4_mapped");
  });
  it("refuses a redirect to a non-http scheme", async () => {
    const r = await proberHttp({ url: "http://public.example.com/redirect-file" } as never, deps());
    expect(r.reason).toBe("redirect_scheme_not_allowed");
  });
  it("follows a redirect to another public host and drops tenant headers cross-origin", async () => {
    const r = await proberHttp(
      { url: "http://public.example.com/redirect-public", headers: { "x-tenant": "secret-ish" } } as never,
      deps(),
    );
    expect(r.status_hint).toBeUndefined();
    expect(lastHeaders.host).toBe("public6.example.com");
    expect(lastHeaders["x-tenant"]).toBeUndefined();
  });
  it("stops after the redirect cap", async () => {
    const r = await proberHttp({ url: "http://public.example.com/loop" } as never, deps());
    expect(r.reason).toBe("unexpected_status:302");
  });
  it("drops framing / Host headers a tenant tries to set", async () => {
    await proberHttp(
      { url: "http://public.example.com/ok", headers: { Host: "169.254.169.254", "X-Forwarded-For": "127.0.0.1", "Transfer-Encoding": "chunked", "X-Ok": "1" } } as never,
      deps(),
    );
    expect(lastHeaders.host).toBe("public.example.com");
    expect(lastHeaders["x-forwarded-for"]).toBeUndefined();
    expect(lastHeaders["x-ok"]).toBe("1");
  });
  it("caps the response body it reads", async () => {
    const r = await proberHttp({ url: "http://public.example.com/big", json_path: "$.a", timeout_ms: 8000 } as never, deps());
    expect(r.reason).toBe("json_body_too_large");
  });
  it("caps total time", async () => {
    const t0 = Date.now();
    const r = await proberHttp({ url: "http://public.example.com/slow", timeout_ms: 300 } as never, deps());
    expect(r.reason).toBe("ETIMEDOUT");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("tcp / tls_cert / icmp / dns use the same guard", () => {
  it("tcp refuses private and metadata targets", async () => {
    expect((await proberTcp({ host: "10.0.0.1", port: 22 } as never, deps())).reason).toBe("target_not_public:private");
    expect((await proberTcp({ host: "meta.example.com", port: 80 } as never, deps())).reason).toBe("target_not_public:cloud_metadata");
    expect((await proberTcp({ host: "2130706433", port: 80 } as never, deps())).reason).toBe("target_not_public:loopback");
  });
  it("tcp connects to the vetted address", async () => {
    const r = await proberTcp({ host: "public.example.com", port: 1, timeout_ms: 2000 } as never, deps());
    expect(r.status_hint).toBeUndefined();
  });
  it("tls_cert refuses private targets", async () => {
    expect((await proberTlsCert({ host: "loop.example.com", port: 443 } as never, deps())).reason).toBe("target_not_public:loopback");
    expect((await proberTlsCert({ host: "fd00:ec2::254", port: 443 } as never, deps())).reason).toBe("target_not_public:cloud_metadata");
  });
  it("icmp refuses private targets and respects the host capability", async () => {
    expect((await proberIcmp({ host: "192.168.0.1" } as never, deps())).reason).toBe("target_not_public:private");
    expect((await proberIcmp({ host: "public.example.com" } as never, deps({ icmpEnabled: false }))).reason).toBe("icmp_unavailable_on_prober");
  });
  it("dns refuses private resolvers and internal names", async () => {
    expect((await proberDns({ domain: "example.com", resolver: "10.96.0.10" } as never, deps())).reason).toBe("resolver_not_public");
    expect((await proberDns({ domain: "kube-dns.kube-system.svc.cluster.local" } as never, deps())).reason).toBe("host_internal");
  });
});

describe("validateOutsideInConfig (shared cloud + prober policy)", () => {
  it("allows the five public-safe types", () => {
    expect(validateOutsideInConfig("http", { url: "https://example.com" }).ok).toBe(true);
    expect(validateOutsideInConfig("tcp", { host: "example.com", port: 443 }).ok).toBe(true);
    expect(validateOutsideInConfig("dns", { domain: "example.com" }).ok).toBe(true);
    expect(validateOutsideInConfig("tls_cert", { host: "example.com" }).ok).toBe(true);
    expect(validateOutsideInConfig("icmp", { host: "example.com" }).ok).toBe(true);
  });
  it("refuses every other source type", () => {
    for (const t of ["custom", "database", "prometheus", "loki", "elasticsearch", "cloudwatch", "otlp", "host", "grpc", "websocket", "mtls_http", "heartbeat", "manual"]) {
      const r = validateOutsideInConfig(t, {});
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("source_type_not_allowed");
    }
  });
  it("refuses env-var references (they would read the prober host's env)", () => {
    for (const cfg of [
      { url: "https://example.com", header_refs: { Authorization: "AWS_SECRET_ACCESS_KEY" } },
      { url: "https://example.com", client_cert_ref: "A", client_key_ref: "B" },
      { url: "https://example.com", ca_cert_ref: "CA" },
    ]) {
      const r = validateOutsideInConfig("http", cfg);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("secret_refs_not_allowed");
    }
  });
  it("refuses private targets per type", () => {
    expect(validateOutsideInConfig("http", { url: "http://169.254.169.254/latest" }).ok).toBe(false);
    expect(validateOutsideInConfig("http", { url: "http://[::1]:8080/" }).ok).toBe(false);
    expect(validateOutsideInConfig("http", { url: "http://localhost/" }).ok).toBe(false);
    expect(validateOutsideInConfig("tcp", { host: "10.0.0.5", port: 5432 }).ok).toBe(false);
    expect(validateOutsideInConfig("tls_cert", { host: "kubernetes.default.svc" }).ok).toBe(false);
    expect(validateOutsideInConfig("icmp", { host: "192.168.1.1" }).ok).toBe(false);
    expect(validateOutsideInConfig("dns", { domain: "example.com", resolver: "127.0.0.53" }).ok).toBe(false);
  });
  it("caps timeouts and refuses Host overrides", () => {
    expect(validateOutsideInConfig("http", { url: "https://example.com", timeout_ms: 30_000 }).ok).toBe(false);
    expect(validateOutsideInConfig("http", { url: "https://example.com", headers: { Host: "internal" } }).ok).toBe(false);
  });
});
