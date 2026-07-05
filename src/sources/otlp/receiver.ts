// OTLP/HTTP receiver — singleton Bun.serve listener that accepts OTLP
// JSON requests and routes data points into a per-stream ring buffer.
//
// Multi-tenancy model: one listener per agent process. Each metric_def
// with source_type=otlp subscribes with a filter; the subscription
// reads the latest matching sample on demand (when the scheduler calls
// `read()` on the metric's cron interval).
//
// Threat model: by default we bind 127.0.0.1 only. Operator can widen
// via OBSERVER_OTLP_LISTEN_ADDR. When the listener binds a non-loopback
// interface, OBSERVER_OTLP_BEARER_TOKEN MUST be set or the receiver
// refuses to start.
//
// Backpressure: we never block the sender. The buffer is fixed-size
// per stream; overflow drops the oldest sample and increments a
// per-receiver counter that surfaces on the dashboard heartbeat.

import crypto from "node:crypto";
import {
  decodeOtlpHttpJson,
  attributesFingerprint,
  attributesMatch,
  type OtlpAttributes,
  type OtlpDataPoint,
} from "./decode.ts";

export interface OtlpReceiverOptions {
  listenAddr: string;
  bearerToken: string | null;
  maxBufferPoints: number;
}

export interface OtlpReceiverHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(filter: OtlpSubscriptionFilter): OtlpSubscription;
  stats(): OtlpReceiverStats;
}

export interface OtlpSubscriptionFilter {
  metric_name: string;
  attribute_filters?: OtlpAttributes;
}

export interface OtlpSubscription {
  /**
   * Latest data point matching the filter, or null when nothing has
   * been received since this subscription opened.
   */
  latest(): OtlpDataPoint | null;
  unsubscribe(): void;
}

export interface OtlpReceiverStats {
  running: boolean;
  listen_addr: string | null;
  bearer_required: boolean;
  data_points_received: number;
  data_points_dropped: number;
  requests_authenticated: number;
  requests_rejected_auth: number;
  requests_rejected_payload: number;
  unique_streams: number;
  active_subscriptions: number;
}

// Per-stream entry. `latest_point` is the most recent point we ingested;
// we don't keep the full ring buffer in memory (we never query
// non-latest from inside the subscription), but we keep `points_seen`
// for diagnostics.
interface Stream {
  latest_point: OtlpDataPoint | null;
  points_seen: number;
}

function parseListenAddr(addr: string): { host: string; port: number } | null {
  // Support `host:port` and bare `:port`. IPv6 brackets supported.
  const m = addr.match(/^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/);
  if (!m) return null;
  const host = m[1] ?? m[2] ?? "127.0.0.1";
  const port = Number(m[3]);
  // Allow port 0 — Bun.serve treats it as "pick an ephemeral port",
  // which the tests + dev mode rely on.
  if (!Number.isFinite(port) || port < 0 || port > 65535) return null;
  return { host: host || "127.0.0.1", port };
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * Constant-time bearer token compare. Delegates to Node's
 * `crypto.timingSafeEqual`, which requires equal-length buffers. We
 * hash both sides with SHA-256 first so an attacker-controlled
 * `provided` length doesn't reach timingSafeEqual unequal (which
 * throws) and to avoid leaking the expected length via the success /
 * exception path.
 *
 * SHA-256 is preimage-resistant; comparing hashes is informationally
 * equivalent to comparing the plaintext tokens at our entropy budget
 * (>=32 random bytes).
 */
function safeBearerCompare(provided: string, expected: string): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createOtlpReceiver(opts: OtlpReceiverOptions): OtlpReceiverHandle {
  const addr = parseListenAddr(opts.listenAddr);
  if (!addr) throw new Error(`invalid OBSERVER_OTLP_LISTEN_ADDR "${opts.listenAddr}"`);

  // Safety: non-loopback bind requires a bearer token. Refuse to start
  // otherwise; the operator is one env var away from accepting metric
  // pushes from the open internet.
  if (!isLoopback(addr.host) && !opts.bearerToken) {
    throw new Error(
      `OBSERVER_OTLP_LISTEN_ADDR binds ${addr.host}; OBSERVER_OTLP_BEARER_TOKEN must be set for non-loopback binds`,
    );
  }

  const streams = new Map<string, Stream>();
  const subscriptions = new Set<{ filter: OtlpSubscriptionFilter }>();

  let server: { stop: (closeActiveConnections?: boolean) => void; hostname?: string; port?: number } | null = null;
  let dataPointsReceived = 0;
  let dataPointsDropped = 0;
  let requestsAuthenticated = 0;
  let requestsRejectedAuth = 0;
  let requestsRejectedPayload = 0;

  // Hard cap on the OTLP request body so a client (or misconfigured app)
  // spamming oversized payloads can't OOM the agent — which would silence
  // every metric that agent serves. Default 16MB, env-tunable down to a 1MB
  // floor.
  const maxBodyBytes = (() => {
    const v = Number(process.env.OBSERVER_OTLP_MAX_BODY_BYTES);
    const DEFAULT_MAX = 16 * 1024 * 1024;
    const FLOOR = 1 * 1024 * 1024;
    return Number.isFinite(v) && v >= FLOOR ? Math.trunc(v) : DEFAULT_MAX;
  })();

  function streamKey(name: string, attrs: OtlpAttributes): string {
    return `${name}\x1f${attributesFingerprint(attrs)}`;
  }

  function ingest(dp: OtlpDataPoint): void {
    const k = streamKey(dp.metric_name, dp.attributes);
    let s = streams.get(k);
    if (!s) {
      if (streams.size >= opts.maxBufferPoints) {
        // Bounded stream count too. Drop oldest by Map insertion order
        // — Map preserves it, and the LRU isn't worth tracking because
        // the cap protects against label-cardinality explosions, not
        // hot-path turnover.
        const firstKey = streams.keys().next().value;
        if (firstKey !== undefined) streams.delete(firstKey);
        dataPointsDropped += 1;
      }
      s = { latest_point: null, points_seen: 0 };
      streams.set(k, s);
    }
    s.latest_point = dp;
    s.points_seen += 1;
    dataPointsReceived += 1;
  }

  async function handleRequest(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    // OTLP/HTTP path. OpenTelemetry SDKs default to /v1/metrics; we
    // accept the root path too for clients that strip the suffix.
    const url = new URL(req.url);
    if (url.pathname !== "/v1/metrics" && url.pathname !== "/") {
      return new Response("not found", { status: 404 });
    }
    if (opts.bearerToken) {
      const header = req.headers.get("authorization") ?? "";
      const expected = `Bearer ${opts.bearerToken}`;
      if (!safeBearerCompare(header, expected)) {
        requestsRejectedAuth += 1;
        return new Response("unauthorized", { status: 401 });
      }
    }
    const ct = (req.headers.get("content-type") ?? "").toLowerCase();
    // protobuf binary is out of scope for v1; document and refuse so
    // the operator gets a clear error instead of a silent drop.
    if (ct.includes("application/x-protobuf")) {
      requestsRejectedPayload += 1;
      return new Response("protobuf encoding not supported; use application/json", {
        status: 415,
      });
    }
    // Reject on Content-Length before buffering anything.
    const declaredLen = Number(req.headers.get("content-length"));
    if (Number.isFinite(declaredLen) && declaredLen > maxBodyBytes) {
      requestsRejectedPayload += 1;
      return new Response("payload_too_large", { status: 413 });
    }
    let body: string;
    try {
      body = await req.text();
    } catch {
      requestsRejectedPayload += 1;
      return new Response("body read failed", { status: 400 });
    }
    // Backstop for chunked/unknown-length requests (Bun reports byte length).
    if (Buffer.byteLength(body) > maxBodyBytes) {
      requestsRejectedPayload += 1;
      return new Response("payload_too_large", { status: 413 });
    }
    const decoded = decodeOtlpHttpJson(body);
    if (!decoded.ok) {
      requestsRejectedPayload += 1;
      return new Response(`bad request: ${decoded.reason}`, { status: 400 });
    }
    requestsAuthenticated += 1;
    for (const dp of decoded.data_points) ingest(dp);
    // OTLP success response: empty object per the spec.
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return {
    async start() {
      if (server) return;
      // Bun.serve is the runtime contract. Node-compat fallbacks
      // would be tested in a separate codepath; agent is Bun-only.
      const bun = (globalThis as unknown as { Bun?: { serve: typeof Bun.serve } }).Bun;
      if (!bun?.serve) throw new Error("Bun.serve is required for the OTLP receiver");
      server = bun.serve({
        hostname: addr.host,
        port: addr.port,
        fetch: handleRequest,
        // Server-layer bound on request buffering. Before this, a
        // chunked body with no Content-Length was fully buffered by
        // req.text() before the in-handler byte check ran — unbounded
        // memory growth. The 8 MiB headroom above the handler cap keeps
        // the handler's Content-Length check as the operative surface
        // (it 413s AND increments requests_rejected_payload, which
        // feeds the heartbeat stats); Bun's own 413 only fires for
        // bodies that also blow past this hard ceiling.
        maxRequestBodySize: maxBodyBytes + 8 * 1024 * 1024,
      });
    },
    async stop() {
      if (!server) return;
      server.stop(true);
      server = null;
      // Drop buffered streams and active subscriptions so a subsequent
      // start() begins from a clean slate. Subscriptions that survived
      // past stop() get null reads, matching the "receiver gone" state.
      streams.clear();
      subscriptions.clear();
    },
    subscribe(filter) {
      const entry = { filter };
      subscriptions.add(entry);
      return {
        latest() {
          // Scan stream buckets matching name; pick the highest time_ms
          // among attribute-matching ones. Stream count is bounded by
          // maxBufferPoints (default 1k), so this is O(streams) per
          // read — acceptable for cron-driven reads (1-60 minute
          // intervals). If we ever read on the hot path, switch to a
          // name→Set<key> index.
          let best: OtlpDataPoint | null = null;
          for (const s of streams.values()) {
            const p = s.latest_point;
            if (!p) continue;
            if (p.metric_name !== filter.metric_name) continue;
            if (!attributesMatch(p.attributes, filter.attribute_filters)) continue;
            if (!best || p.time_ms > best.time_ms) best = p;
          }
          return best;
        },
        unsubscribe() {
          subscriptions.delete(entry);
        },
      };
    },
    stats() {
      return {
        running: server !== null,
        listen_addr: server ? `${server.hostname ?? addr.host}:${server.port ?? addr.port}` : null,
        bearer_required: opts.bearerToken !== null,
        data_points_received: dataPointsReceived,
        data_points_dropped: dataPointsDropped,
        requests_authenticated: requestsAuthenticated,
        requests_rejected_auth: requestsRejectedAuth,
        requests_rejected_payload: requestsRejectedPayload,
        unique_streams: streams.size,
        active_subscriptions: subscriptions.size,
      };
    },
  };
}

// ───────────────────────── Process-wide singleton ─────────────────

let singleton: OtlpReceiverHandle | null = null;
let singletonStartPromise: Promise<void> | null = null;

export function getOtlpReceiver(): OtlpReceiverHandle | null {
  return singleton;
}

export function configureOtlpReceiverFromEnv(env: NodeJS.ProcessEnv = process.env): OtlpReceiverHandle | null {
  if (singleton) return singleton;
  if (env.OBSERVER_OTLP_DISABLE === "true") return null;
  const listenAddr = env.OBSERVER_OTLP_LISTEN_ADDR ?? "127.0.0.1:4318";
  const bearerToken = env.OBSERVER_OTLP_BEARER_TOKEN ?? null;
  const maxBufferPoints = Number(env.OBSERVER_OTLP_MAX_BUFFER_POINTS ?? "1000");
  if (!Number.isFinite(maxBufferPoints) || maxBufferPoints < 1) {
    throw new Error(`OBSERVER_OTLP_MAX_BUFFER_POINTS must be a positive integer`);
  }
  singleton = createOtlpReceiver({ listenAddr, bearerToken, maxBufferPoints });
  return singleton;
}

/**
 * Ensure the singleton receiver is started exactly once across
 * concurrent callers. Returns the receiver handle, or null when the
 * receiver is disabled via OBSERVER_OTLP_DISABLE.
 */
export async function startOtlpReceiverOnce(): Promise<OtlpReceiverHandle | null> {
  const r = configureOtlpReceiverFromEnv();
  if (!r) return null;
  const inFlight = singletonStartPromise ?? (singletonStartPromise = r.start());
  try {
    await inFlight;
  } catch (e) {
    // A failed start (EADDRINUSE, bad listen addr at bind time) must not
    // poison the singleton forever: clear the cached promise so the next
    // tick retries. Successful starts keep the in-flight dedupe.
    if (singletonStartPromise === inFlight) singletonStartPromise = null;
    throw e;
  }
  return r;
}

export function resetOtlpReceiverForTests(): void {
  if (singleton) {
    void singleton.stop();
  }
  singleton = null;
  singletonStartPromise = null;
}
