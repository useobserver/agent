// Heartbeat ping contract shared by the cloud's public ping URL and the
// agent's local heartbeat relay.
//
// Public URL (cloud):  /api/heartbeat/<token>[/start|/fail|/<exit>][?exit=<n>]
// Relay URL (agent):   /heartbeat/<token>[/start|/fail|/<exit>][?exit=<n>]
//
// The relay accepts a ping from a job that has no internet egress, queues it
// in the agent's durable local buffer, and forwards batches to
// POST /api/agent/heartbeat-relay over the agent's existing Agent-Key channel.
// The agent never validates a token against the cloud (it cannot); it only
// checks the shape, caps the body and rate-limits locally. The cloud resolves
// each token and accepts it only when the check belongs to the relaying
// agent's org.
//
// Pure: types, constants and parsing only (zero runtime dependencies).

export type HeartbeatPingKind = "success" | "start" | "fail";

export type ParsedHeartbeatPing =
  | { ok: true; token: string; kind: HeartbeatPingKind; exitCode: number | null }
  | { ok: false; status: 400 | 404; error: string };

/** Ping body excerpt cap (bytes, UTF-8), on both the public URL and the relay. */
export const HEARTBEAT_BODY_MAX_BYTES = 10 * 1024;

/** Cloud endpoint the agent forwards relayed pings to (Agent-Key auth). */
export const HEARTBEAT_RELAY_CLOUD_PATH = "/api/agent/heartbeat-relay";

/** Max pings per forwarded batch; the cloud 413s anything larger. */
export const HEARTBEAT_RELAY_MAX_BATCH = 50;

/**
 * A relayed ping is recorded at its (skew-corrected) agent receive time,
 * clamped to [now - this, now]. Bounds how far a queued ping, or a broken
 * agent clock, can move a check's history.
 */
export const HEARTBEAT_RELAY_MAX_AGE_MS = 60 * 60 * 1000;

/** One queued ping as the agent forwards it. */
export interface HeartbeatRelayPing {
  /** The check's ping token, exactly as the job sent it. */
  token: string;
  kind: HeartbeatPingKind;
  /** 0..255, or null when the job sent none. */
  exit_code: number | null;
  /** POST body, at most HEARTBEAT_BODY_MAX_BYTES of UTF-8; null when empty. */
  body: string | null;
  /** ISO time the agent received the ping (agent clock). */
  received_at: string;
  /** The local caller's User-Agent, truncated; optional. */
  user_agent?: string | null;
}

/** Body of POST /api/agent/heartbeat-relay. Pings are in receive order. */
export interface HeartbeatRelayBatch {
  /**
   * ISO time the agent sent this request (agent clock). The cloud uses
   * now - sent_at as the agent's clock offset, so received_at is corrected
   * for skew before clamping.
   */
  sent_at: string;
  pings: HeartbeatRelayPing[];
}

/**
 * Per-ping reject codes. "not_found" covers unknown tokens AND tokens that
 * belong to another org: the agent cannot tell them apart.
 */
export type HeartbeatRelayRejectCode = "invalid" | "not_found" | "rate_limited";

/** 200 response: same per-row shape as /api/agent/receiver/batch. */
export interface HeartbeatRelayResponse {
  accepted: number;
  rejected: Array<{ index: number; code: HeartbeatRelayRejectCode }>;
}

const TOKEN_RE = /^[A-Za-z0-9]{22,64}$/;

/** Shape check for a ping token (mirrors the heartbeat_checks CHECK). */
export function isWellFormedHeartbeatToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

/** "AbCd…": the only form of a token that may appear in a log line. */
export function redactHeartbeatToken(token: unknown): string {
  if (typeof token !== "string" || token.length === 0) return "[none]";
  return `${token.slice(0, 4)}…`;
}

const EXIT_RE = /^\d{1,3}$/;

function parseExit(raw: string): number | null {
  if (!EXIT_RE.test(raw)) return null;
  const n = Number(raw);
  return n >= 0 && n <= 255 ? n : null;
}

/**
 * Parse ping path segments (after the /heartbeat/ prefix) plus the optional
 * ?exit= value into { token, kind, exitCode }.
 *
 *   <token>              success
 *   <token>/start        a run started
 *   <token>/fail         the run failed
 *   <token>/<n>          finished with exit code n (0 = success)
 *   ?exit=<n> on the bare or /fail URL  same as /<n>
 *
 * Exit codes are integers 0..255 (POSIX); anything else is rejected so a
 * typo'd URL is a 400, not a silently recorded success.
 */
export function parseHeartbeatPingPath(
  segments: string[] | null | undefined,
  exitParam?: string | null,
): ParsedHeartbeatPing {
  const parts = (segments ?? []).filter((s) => s !== "");
  if (parts.length === 0 || parts.length > 2) {
    return { ok: false, status: 404, error: "not found" };
  }
  const [token, action] = parts;

  let kind: HeartbeatPingKind = "success";
  let exitCode: number | null = null;

  if (action != null) {
    if (action === "start") kind = "start";
    else if (action === "fail") kind = "fail";
    else {
      const code = parseExit(action);
      if (code == null) return { ok: false, status: 404, error: "not found" };
      exitCode = code;
      kind = code === 0 ? "success" : "fail";
    }
  }

  if (exitParam != null && exitParam !== "") {
    if (kind === "start" || (action != null && exitCode != null)) {
      return { ok: false, status: 400, error: "exit is only valid on the success or /fail URL" };
    }
    const code = parseExit(exitParam);
    if (code == null) return { ok: false, status: 400, error: "exit must be an integer 0-255" };
    exitCode = code;
    // /fail stays a failure whatever the code; the bare URL follows the code.
    if (kind === "success") kind = code === 0 ? "success" : "fail";
  }

  return { ok: true, token, kind, exitCode };
}
