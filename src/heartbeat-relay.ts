// Heartbeat relay: a local, opt-in HTTP listener for jobs that run in private
// networks without internet egress.
//
//   job ──HTTP──▶ agent :10102 /heartbeat/<token>[/start|/fail|/<exit>]
//                   │ 202 right after the ping is queued
//                   ▼
//              durable SQLite queue (its own file next to BUFFER_PATH)
//                   │ drained in order, batched
//                   ▼
//   Observer Cloud  POST /api/agent/heartbeat-relay  (Agent-Key)
//
// The agent does not know whether a token is valid (the cloud does), so the
// local caller always gets the same 202 for a well-formed ping: the relay is
// no oracle for which tokens exist. It does enforce the URL shape (the same
// parser as the cloud's public ping URL), the 10 KB body cap, and a local
// rate limit. The cloud records a relayed ping only when its check belongs to
// this agent's org, at the ping's receive time (skew-corrected, at most an
// hour back), and lateness is still judged in the cloud: if this agent goes
// offline, its relayed checks go late and the agent-offline alert fires.
//
// Tokens never appear in a log line in full (redactHeartbeatToken).

import {
  HEARTBEAT_BODY_MAX_BYTES,
  HEARTBEAT_RELAY_MAX_BATCH,
  isWellFormedHeartbeatToken,
  parseHeartbeatPingPath,
  redactHeartbeatToken,
  type HeartbeatRelayBatch,
  type HeartbeatRelayPing,
} from "@observer/protocol";
import { createDrainController } from "./drain.ts";
import type { BufferAccess, DrainController } from "./types.ts";

export const DEFAULT_RELAY_HOST = "127.0.0.1";
export const DEFAULT_RELAY_PORT = 10102;
/** Queued pings kept while the cloud is unreachable (oldest evicted beyond). */
export const DEFAULT_RELAY_QUEUE_MAX_ROWS = 5000;
/** Pings per forwarded request. */
export const RELAY_FORWARD_BATCH = 25;
/** Local limits: per token (matches the cloud's per-check limit) and overall. */
export const DEFAULT_RELAY_PER_TOKEN_PER_MIN = 60;
export const DEFAULT_RELAY_GLOBAL_PER_MIN = 600;
const USER_AGENT_MAX = 256;
// Distinct tokens tracked per window; past it new tokens are refused until
// the window rolls (bounds memory under a token-spray).
const MAX_TRACKED_TOKENS = 10_000;

export interface RelayConfig {
  enabled: boolean;
  host: string;
  port: number;
  queuePath: string;
  queueMaxRows: number;
}

function isLoopbackHost(h: string): boolean {
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

/** The relay's own queue file, next to the metric buffer (same volume). */
export function relayQueuePath(bufferPath: string | undefined): string {
  const base = bufferPath && bufferPath.length > 0 ? bufferPath : "./observer-agent-buffer.db";
  return /\.db$/i.test(base) ? base.replace(/\.db$/i, "-relay.db") : `${base}-relay.db`;
}

export function resolveRelayConfig(env: Record<string, string | undefined>): RelayConfig {
  const port = Number(env.HEARTBEAT_RELAY_PORT);
  const host = (env.HEARTBEAT_RELAY_HOST ?? "").trim();
  return {
    enabled: env.HEARTBEAT_RELAY_ENABLED === "true",
    host: host.length > 0 ? host : DEFAULT_RELAY_HOST,
    // `Number(undefined)` is NaN: fall through to the default on anything
    // that is not a usable TCP port.
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_RELAY_PORT,
    queuePath: relayQueuePath(env.BUFFER_PATH),
    queueMaxRows: DEFAULT_RELAY_QUEUE_MAX_ROWS,
  };
}

// ───────────────────────── Rate limit ─────────────────────────────────

export interface RelayRateLimiter {
  /** true = allowed. Counts the attempt. */
  allow(token: string): boolean;
}

/** Fixed one-minute windows: per token and across all tokens. In memory only. */
export function createRelayRateLimiter({
  perTokenPerMinute = DEFAULT_RELAY_PER_TOKEN_PER_MIN,
  globalPerMinute = DEFAULT_RELAY_GLOBAL_PER_MIN,
  now = () => Date.now(),
}: { perTokenPerMinute?: number; globalPerMinute?: number; now?: () => number } = {}): RelayRateLimiter {
  let windowStart = now();
  let total = 0;
  const perToken = new Map<string, number>();
  return {
    allow(token: string): boolean {
      const t = now();
      if (t - windowStart >= 60_000 || t < windowStart) {
        windowStart = t;
        total = 0;
        perToken.clear();
      }
      if (total >= globalPerMinute) return false;
      const n = perToken.get(token);
      if (n == null && perToken.size >= MAX_TRACKED_TOKENS) return false;
      if ((n ?? 0) >= perTokenPerMinute) return false;
      perToken.set(token, (n ?? 0) + 1);
      total += 1;
      return true;
    },
  };
}

// ───────────────────────── Request handling ───────────────────────────

/** Read at most `max` bytes of a POST body as UTF-8; the rest is never read. */
export async function readCappedBody(request: Request, max = HEARTBEAT_BODY_MAX_BYTES): Promise<string | null> {
  if (request.method.toUpperCase() !== "POST" || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const take = value.byteLength > max - total ? value.subarray(0, max - total) : value;
      chunks.push(take);
      total += take.byteLength;
    }
  } catch {
    /* a broken body still records the ping */
  } finally {
    reader.cancel().catch(() => {});
  }
  if (total === 0) return null;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  // A multibyte char cut at the cap becomes U+FFFD; NUL bytes are dropped
  // (Postgres text cannot hold them).
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf).replace(/\u0000/g, "");
  return text.trim().length > 0 ? text : null;
}

function reply(status: number, text: string, method: string, extra: Record<string, string> = {}): Response {
  return new Response(method === "HEAD" ? null : `${text}\n`, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}

const METHODS = new Set(["GET", "POST", "HEAD"]);

/** Path segments after /heartbeat/ (or /api/heartbeat/, the cloud's path). */
export function relayPathSegments(pathname: string): string[] | null {
  for (const prefix of ["/heartbeat/", "/api/heartbeat/"]) {
    if (pathname.startsWith(prefix)) return pathname.slice(prefix.length).split("/");
  }
  return null;
}

export interface RelayStats {
  queued: number;
  rejected_rate_limited: number;
  rejected_invalid: number;
  enqueue_failures: number;
}

export interface RelayHandlerDeps {
  enqueue(ping: HeartbeatRelayPing): void;
  rateLimiter?: RelayRateLimiter;
  log?: (level: string, message: string) => void;
  now?: () => number;
}

export function createRelayHandler(deps: RelayHandlerDeps): {
  handle(request: Request): Promise<Response>;
  stats(): RelayStats;
} {
  const rateLimiter = deps.rateLimiter ?? createRelayRateLimiter();
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const stats: RelayStats = { queued: 0, rejected_rate_limited: 0, rejected_invalid: 0, enqueue_failures: 0 };
  let lastRateWarnAt = Number.NEGATIVE_INFINITY;

  async function handle(request: Request): Promise<Response> {
    const method = request.method.toUpperCase();
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return reply(200, "ok", method);

    const segments = relayPathSegments(url.pathname);
    if (!segments) return reply(404, "not found", method);
    if (!METHODS.has(method)) return reply(405, "method not allowed", method, { Allow: "GET, POST, HEAD" });

    const parsed = parseHeartbeatPingPath(segments, url.searchParams.get("exit"));
    if (parsed.ok === false) {
      stats.rejected_invalid += 1;
      return reply(parsed.status, parsed.error, method);
    }
    if (!isWellFormedHeartbeatToken(parsed.token)) {
      stats.rejected_invalid += 1;
      return reply(404, "not found", method);
    }
    if (!rateLimiter.allow(parsed.token)) {
      stats.rejected_rate_limited += 1;
      const t = now();
      if (t - lastRateWarnAt >= 60_000) {
        lastRateWarnAt = t;
        log("WARN", `Heartbeat relay: rate limited pings for ${redactHeartbeatToken(parsed.token)} (logged once a minute).`);
      }
      return reply(429, "rate limited", method, { "Retry-After": "60" });
    }

    const body = await readCappedBody(request);
    const ua = request.headers.get("user-agent");
    const ping: HeartbeatRelayPing = {
      token: parsed.token,
      kind: parsed.kind,
      exit_code: parsed.exitCode,
      body,
      received_at: new Date(now()).toISOString(),
      user_agent: ua ? ua.slice(0, USER_AGENT_MAX) : null,
    };
    try {
      deps.enqueue(ping);
    } catch (error) {
      stats.enqueue_failures += 1;
      const msg = error instanceof Error ? error.message : String(error);
      log("ERROR", `Heartbeat relay: could not queue a ping for ${redactHeartbeatToken(parsed.token)}: ${msg}`);
      return reply(503, "unavailable", method, { "Retry-After": "5" });
    }
    stats.queued += 1;
    log("DEBUG", `Heartbeat relay: queued ${parsed.kind} ping for ${redactHeartbeatToken(parsed.token)}`);
    return reply(202, "Accepted", method);
  }

  return { handle, stats: () => ({ ...stats }) };
}

// ───────────────────────── Forwarding ─────────────────────────────────

export interface RelayForwarderDeps {
  buffer: BufferAccess;
  /** POST the batch to the cloud; resolves to the parsed body, throws with
   *  `.status` on an HTTP error (same contract as the metric drain). */
  send(batch: HeartbeatRelayBatch): Promise<unknown>;
  log?: (level: string, message: string) => void;
  now?: () => number;
  batchSize?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}

/**
 * Drain the relay queue to the cloud in order. Reuses the metric drain's
 * contract: per-row rejects are logged and dropped, 4xx that will never
 * succeed drop the batch, everything else (network, 5xx, 429, 401) retries
 * with backoff. sent_at is stamped per attempt so the cloud can correct
 * received_at for this host's clock offset.
 */
export function createRelayForwarder(deps: RelayForwarderDeps): DrainController {
  const now = deps.now ?? (() => Date.now());
  const batchSize = Math.min(deps.batchSize ?? RELAY_FORWARD_BATCH, HEARTBEAT_RELAY_MAX_BATCH);
  return createDrainController({
    buffer: deps.buffer,
    batchSize,
    backoffMinMs: deps.backoffMinMs,
    backoffMaxMs: deps.backoffMaxMs,
    log: (level, message) => deps.log?.(level, `Heartbeat relay: ${message}`),
    post: (payloads) =>
      deps.send({ sent_at: new Date(now()).toISOString(), pings: payloads as HeartbeatRelayPing[] }),
  });
}

// ───────────────────────── Listener ───────────────────────────────────

export interface RelayServer {
  stop(): void;
  port: number;
  hostname: string;
}

export function startRelayServer(
  config: Pick<RelayConfig, "host" | "port">,
  handle: (request: Request) => Promise<Response>,
): RelayServer {
  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    // Never serve Bun's development error page (stack traces, paths).
    development: false,
    // Only the first 10 KB of a body is read and kept (like the cloud's
    // public URL); this just bounds what Bun accepts on the socket at all.
    maxRequestBodySize: 16 * 1024 * 1024,
    error() {
      return new Response("error\n", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    },
    fetch: (request) => handle(request),
  });
  return {
    port: server.port ?? config.port,
    hostname: typeof server.hostname === "string" ? server.hostname : config.host,
    stop() {
      server.stop(true);
    },
  };
}

/** Boot-time note about the bind address (no secrets). */
export function describeRelayBind(host: string): string {
  return isLoopbackHost(host)
    ? "loopback only: jobs on this host can ping it. Set HEARTBEAT_RELAY_HOST=0.0.0.0 to accept pings from other hosts or pods."
    : "reachable from the network. A ping token is the only credential; keep the port inside your private network.";
}
