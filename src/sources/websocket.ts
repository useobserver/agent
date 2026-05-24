// WebSocket probe source.
//
// Uses Bun's native (browser-compatible) WebSocket — no `ws` dep.
// Bun's constructor accepts an options bag with `headers` and
// `protocols`, which the browser API lacks, so auth headers + custom
// subprotocols work.
//
// Per evaluation: open the socket (handshake latency), optionally send
// an application message and await a matching reply (round-trip
// latency), then close cleanly. Protocol-level ping/pong control
// frames aren't exposed by the browser WebSocket API, so round-trip is
// measured with an application message.
//
// The connection is always closed and the timeout always cleared, on
// every path, so probes can't leak sockets or hang.

import type { ProbeResult, ProbeSource } from "../types.ts";
import { WebsocketConfigSchema, type WebsocketConfig } from "@observer/probe-config";
import { validateWithSchema } from "./_validate.ts";

export function validateConfig(config: unknown): null | string {
  return validateWithSchema(WebsocketConfigSchema, config);
}

interface WsOutcome {
  status: "open_failed" | "opened" | "round_trip" | "reply_mismatch" | "timeout" | "closed_early";
  handshakeMs?: number;
  roundTripMs?: number;
  closeCode?: number;
  errorCode?: string;
}

type BunWebSocketOptions = { headers?: Record<string, string>; protocols?: string[] };

function openProbe(config: WebsocketConfig): Promise<WsOutcome> {
  const timeoutMs = config.timeout_ms ?? 10_000;
  const pingMode = config.ping_mode ?? "none";
  return new Promise<WsOutcome>((resolve) => {
    const start = Date.now();
    let settled = false;
    let openedAt = 0;
    let sentAt = 0;
    let ws: WebSocket;

    const finish = (outcome: WsOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* already closed / never opened */
      }
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      finish({ status: "timeout", handshakeMs: openedAt ? openedAt - start : undefined });
    }, timeoutMs);

    try {
      ws = new WebSocket(
        config.url,
        // Bun-specific options bag; cast through unknown so lib.dom's
        // (url, protocols) signature doesn't reject it.
        ({ headers: config.headers, protocols: config.protocols } as BunWebSocketOptions) as unknown as string[],
      );
    } catch (e) {
      finish({ status: "open_failed", errorCode: (e as Error).message });
      return;
    }

    ws.addEventListener("open", () => {
      openedAt = Date.now();
      if (pingMode === "message" && config.send_message) {
        sentAt = Date.now();
        try {
          ws.send(config.send_message);
        } catch (e) {
          finish({ status: "open_failed", handshakeMs: openedAt - start, errorCode: (e as Error).message });
        }
        return;
      }
      finish({ status: "opened", handshakeMs: openedAt - start });
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      if (pingMode !== "message") return; // ignore unsolicited frames
      const data = typeof ev.data === "string" ? ev.data : "";
      if (config.expect_message && !data.includes(config.expect_message)) {
        finish({ status: "reply_mismatch", handshakeMs: openedAt - start, roundTripMs: Date.now() - sentAt });
        return;
      }
      finish({ status: "round_trip", handshakeMs: openedAt - start, roundTripMs: Date.now() - sentAt });
    });

    ws.addEventListener("error", () => {
      // The browser WebSocket error event carries no detail (by spec).
      // We surface a generic open failure; the close event often
      // carries a code.
      if (!openedAt) finish({ status: "open_failed" });
    });

    ws.addEventListener("close", (ev: CloseEvent) => {
      if (settled) return;
      if (!openedAt) {
        finish({ status: "open_failed", closeCode: ev.code });
      } else {
        finish({ status: "closed_early", handshakeMs: openedAt - start, closeCode: ev.code });
      }
    });
  });
}

export async function execute(config: WebsocketConfig): Promise<ProbeResult> {
  const ts = (): string => new Date().toISOString();
  const interpretation = config.interpretation ?? "handshake_latency";
  const outcome = await openProbe(config);

  const metadata: Record<string, unknown> = {
    interpretation,
    status: outcome.status,
    ...(outcome.closeCode !== undefined ? { close_code: outcome.closeCode } : {}),
    ...(outcome.errorCode ? { error: outcome.errorCode } : {}),
    ...(outcome.handshakeMs !== undefined ? { handshake_ms: outcome.handshakeMs } : {}),
    ...(outcome.roundTripMs !== undefined ? { round_trip_ms: outcome.roundTripMs } : {}),
  };

  // connection_success: 1 if the socket opened, else 0 — never no_data.
  if (interpretation === "connection_success") {
    const opened = outcome.handshakeMs !== undefined;
    return { value: opened ? 1 : 0, timestamp: ts(), metadata };
  }

  // Reason is always a typed code; any raw error detail rides in
  // metadata.error so the humanisation map stays exhaustive.
  if (outcome.status === "open_failed") {
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: "ws_open_failed", metadata };
  }
  if (outcome.status === "timeout") {
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: openedReason(outcome), metadata };
  }
  if (outcome.status === "closed_early") {
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: "ws_closed_early", metadata };
  }
  if (outcome.status === "reply_mismatch") {
    return { value: null, timestamp: ts(), status_hint: "no_data", reason: "ws_reply_mismatch", metadata };
  }

  if (interpretation === "handshake_latency") {
    return { value: outcome.handshakeMs ?? null, timestamp: ts(), metadata };
  }
  // round_trip_latency
  return { value: outcome.roundTripMs ?? null, timestamp: ts(), metadata };
}

// On timeout, distinguish "handshake never completed" from "opened but
// the awaited reply never arrived".
function openedReason(outcome: WsOutcome): string {
  return outcome.handshakeMs !== undefined ? "ws_reply_timeout" : "ws_handshake_timeout";
}

const source: ProbeSource<WebsocketConfig> = { execute, validateConfig };
export default source;
