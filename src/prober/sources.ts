// Guarded probe execution for managed-prober mode.
//
// Every executor resolves its target through vetHost() first and then
// connects to the vetted IP, never to the name, so the address that was
// checked is the address that is used (no DNS-rebinding window). HTTP keeps
// the original Host header and TLS identity, re-vets every redirect hop,
// caps the body it reads, and runs under one deadline covering DNS, every
// hop and the body. Like every agent source these never throw: failures
// resolve to no_data with a typed reason.
//
// Only http, tcp, dns, tls_cert and icmp exist here. There is no fallback
// to the general source registry, so prober mode cannot run anything else.

import tls from "node:tls";
import type { ProbeResult } from "../types.ts";
import {
  OUTSIDE_IN_MAX_BODY_BYTES,
  OUTSIDE_IN_MAX_REDIRECTS,
  checkResolverAddress,
  checkTargetHost,
  isForbiddenProberHeader,
  parseAndExtract,
  type DnsConfig,
  type HttpConfig,
  type IcmpConfig,
  type TcpConfig,
  type TlsCertConfig,
} from "@observer/probe-config";
import tcpSource from "../sources/tcp.ts";
import dnsSource from "../sources/dns.ts";
import icmpSource from "../sources/icmp.ts";
import { classifyNetError } from "../sources/net-errors.ts";
import { vetHost, type ResolveFn, type Vetted } from "./guard.ts";

const BODY_PREVIEW_BYTES = 4096;
const MS_PER_DAY = 86_400_000;

export interface ProberDeps {
  resolve: ResolveFn;
  /** Public resolvers used for dns checks without an explicit resolver. */
  dnsServers: string[];
  /** ICMP is only run when the host allows unprivileged/cap_net_raw ping. */
  icmpEnabled: boolean;
  userAgent: string;
  /**
   * Test seam: where to actually connect for a vetted target. Production
   * leaves it unset (connect to the vetted IP). Tests map a vetted public
   * address onto a local server AFTER the guard ran, so the guard itself is
   * exercised unchanged.
   */
  dialTarget?: (v: Vetted, port: number) => { ip: string; family: 4 | 6; port: number };
}

const now = (): string => new Date().toISOString();
function noData(reason: string, metadata?: Record<string, unknown>): ProbeResult {
  return { value: null, timestamp: now(), status_hint: "no_data", reason: reason.slice(0, 64), ...(metadata ? { metadata } : {}) };
}

function dial(deps: ProberDeps, v: Vetted, port: number) {
  return deps.dialTarget ? deps.dialTarget(v, port) : { ip: v.ip, family: v.family, port };
}

// ── HTTP ──────────────────────────────────────────────────────────────────

async function readCapped(res: Response, cap: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", bytes: 0, truncated: false };
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > cap) {
        truncated = true;
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return { text, bytes, truncated };
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }
}

export async function proberHttp(config: HttpConfig, deps: ProberDeps): Promise<ProbeResult> {
  const method = (config.method || "GET").toUpperCase();
  const timeoutMs = config.timeout_ms ?? 5_000;
  const expected = Array.isArray(config.expected_status) ? config.expected_status : [config.expected_status ?? 200];
  const verifyTls = config.verify_tls !== false;
  const followRedirects = config.follow_redirects !== false;

  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    return noData("invalid_url");
  }
  const userHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.headers ?? {})) {
    if (!isForbiddenProberHeader(k)) userHeaders[k] = String(v);
  }
  const origin0 = url.origin;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    let res: Response | null = null;
    let headers = { ...userHeaders };
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return noData("redirect_scheme_not_allowed", { hop });
      }
      if (url.username || url.password) return noData("url_credentials_not_allowed", { hop });
      const vetted = await vetHost(url.hostname.replace(/^\[|\]$/g, ""), deps.resolve);
      if (controller.signal.aborted) return noData("ETIMEDOUT");
      if (!vetted.ok) return noData(vetted.reason, { hop });

      const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
      const target = dial(deps, vetted, port);
      const pinned = new URL(url.toString());
      pinned.hostname = target.family === 6 ? `[${target.ip}]` : target.ip;
      pinned.port = String(target.port);
      const identity = vetted.hostname;

      res = await fetch(pinned.toString(), {
        method,
        headers: { "user-agent": deps.userAgent, ...headers, host: url.host },
        signal: controller.signal,
        redirect: "manual",
        tls: {
          rejectUnauthorized: verifyTls,
          // Verify the certificate against the name the tenant configured,
          // not the IP we dialled.
          ...(verifyTls
            ? { checkServerIdentity: (_h: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(identity, cert) }
            : {}),
        },
      } as RequestInit & { tls?: Record<string, unknown> });

      if (!followRedirects || res.status < 300 || res.status >= 400 || hop >= OUTSIDE_IN_MAX_REDIRECTS) break;
      const loc = res.headers.get("location");
      if (!loc) break;
      await discard(res);
      let next: URL;
      try {
        next = new URL(loc, url);
      } catch {
        return noData("redirect_invalid", { hop });
      }
      // Tenant headers go only to the origin they configured.
      if (next.origin !== origin0) headers = {};
      url = next;
    }
    const elapsed = Date.now() - start;
    if (!res) return noData("http_error");

    if (!expected.includes(res.status)) {
      await discard(res);
      return noData(`unexpected_status:${res.status}`, { status: res.status });
    }

    if (config.json_path) {
      const body = await readCapped(res, OUTSIDE_IN_MAX_BODY_BYTES);
      if (body.truncated) return noData("json_body_too_large", { status: res.status });
      if (config.body_match && !body.text.slice(0, BODY_PREVIEW_BYTES).includes(config.body_match)) {
        return noData("body_mismatch", { status: res.status });
      }
      const extracted = parseAndExtract(body.text, config.json_path);
      if (!extracted.ok) return noData(extracted.reason, { status: res.status });
      return { value: extracted.value, timestamp: now(), metadata: { status: res.status, response_time_ms: elapsed } };
    }
    if (config.body_match) {
      const body = await readCapped(res, BODY_PREVIEW_BYTES);
      if (!body.text.includes(config.body_match)) return noData("body_mismatch", { status: res.status });
    } else {
      await discard(res);
    }
    return { value: elapsed, timestamp: now(), metadata: { status: res.status } };
  } catch (err) {
    if (controller.signal.aborted) return noData("ETIMEDOUT");
    // Normalised codes only; an error message can echo the URL. The
    // request went to a vetted IP literal, so Bun's ambiguous
    // ConnectionRefused needs no DNS disambiguation here.
    return noData(classifyNetError(err, "http_error").reason);
  } finally {
    clearTimeout(timer);
  }
}

// ── TCP ───────────────────────────────────────────────────────────────────

export async function proberTcp(config: TcpConfig, deps: ProberDeps): Promise<ProbeResult> {
  const vetted = await vetHost(config.host, deps.resolve);
  if (!vetted.ok) return noData(vetted.reason);
  const target = dial(deps, vetted, config.port);
  return tcpSource.execute({ ...config, host: target.ip, port: target.port });
}

// ── TLS certificate ───────────────────────────────────────────────────────

export async function proberTlsCert(config: TlsCertConfig, deps: ProberDeps): Promise<ProbeResult> {
  const vetted = await vetHost(config.host, deps.resolve);
  if (!vetted.ok) return noData(vetted.reason);
  const target = dial(deps, vetted, config.port ?? 443);
  const servername = vetted.hostname === vetted.ip ? undefined : vetted.hostname;
  return await new Promise((resolve) => {
    let settled = false;
    let socket: tls.TLSSocket | undefined;
    const finish = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        /* torn down */
      }
      resolve(r);
    };
    const wall = setTimeout(() => finish(noData("ETIMEDOUT")), 10_000);
    try {
      socket = tls.connect(
        { host: target.ip, port: target.port, ...(servername ? { servername } : {}), rejectUnauthorized: false, timeout: 10_000 },
        () => {
          clearTimeout(wall);
          const cert = socket!.getPeerCertificate();
          if (!cert || !cert.valid_to) return finish(noData("no_cert"));
          const expiryMs = new Date(cert.valid_to).getTime();
          if (!Number.isFinite(expiryMs)) return finish(noData("bad_cert_date"));
          const days = Math.max(0, Math.floor((expiryMs - Date.now()) / MS_PER_DAY));
          finish({ value: days, timestamp: now(), metadata: { valid_to: cert.valid_to } });
        },
      );
      socket.once("timeout", () => {
        clearTimeout(wall);
        finish(noData("ETIMEDOUT"));
      });
      socket.once("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(wall);
        finish(noData(classifyNetError(err, "tls_error").reason));
      });
    } catch (err) {
      clearTimeout(wall);
      finish(noData(classifyNetError(err, "tls_error").reason));
    }
  });
}

// ── DNS ───────────────────────────────────────────────────────────────────

export async function proberDns(config: DnsConfig, deps: ProberDeps): Promise<ProbeResult> {
  const domain = checkTargetHost(config.domain);
  if (!domain.ok || domain.kind !== "name") return noData(domain.ok ? "invalid_host" : domain.code);
  let resolver: string;
  if (config.resolver) {
    const r = checkResolverAddress(config.resolver);
    if (!r.ok) return noData(r.code);
    const host = r.ip.includes(":") ? `[${r.ip}]` : r.ip;
    resolver = r.port === 53 && !r.ip.includes(":") ? r.ip : `${host}:${r.port}`;
  } else {
    resolver = deps.dnsServers[0];
  }
  return dnsSource.execute({ ...config, domain: domain.name, resolver });
}

// ── ICMP ──────────────────────────────────────────────────────────────────

export async function proberIcmp(config: IcmpConfig, deps: ProberDeps): Promise<ProbeResult> {
  if (!deps.icmpEnabled) return noData("icmp_unavailable_on_prober");
  const vetted = await vetHost(config.host, deps.resolve);
  if (!vetted.ok) return noData(vetted.reason);
  return icmpSource.execute({ ...config, host: dial(deps, vetted, 0).ip });
}
