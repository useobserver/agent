// Cloud error bodies the agent understands.
//
// 403 `agent_suspended_plan` (cloud migration 0166): the key is valid, but
// the organization has more agents than its plan allows and this agent is
// not one of the active ones. It is NOT a bad key (that is 401) and retrying
// faster will not help. The agent keeps its normal backoff (the drain caps at
// 5 minutes, the definitions refresher has its own) and logs one clear line
// at most every 15 minutes instead of a bare "HTTP 403" on every attempt.
// Nothing is lost on the cloud side: choosing this agent as active, or an
// upgrade, lifts it and the next heartbeat succeeds.

export const AGENT_SUSPENDED_CODE = "agent_suspended_plan";

const SUSPENDED_LOG_INTERVAL_MS = 15 * 60 * 1000;

/** The `error` code from a cloud JSON error body, or null. Never throws. */
export function cloudErrorCode(bodyText: string | null | undefined): string | null {
  if (!bodyText) return null;
  try {
    const j = JSON.parse(bodyText) as { error?: unknown; code?: unknown };
    const code = typeof j?.code === "string" ? j.code : typeof j?.error === "string" ? j.error : null;
    return code && code.length <= 64 ? code : null;
  } catch {
    return null;
  }
}

export function suspendedMessage(): string {
  return (
    "This agent is paused by Observer: the organization has more agents than its plan allows and this agent is not one " +
    "of the active ones. Nothing was deleted. Choose which agents stay active in Billing, or upgrade; the agent resumes " +
    "on its own. Retrying in the background."
  );
}

/** Logs the suspended notice at most once per interval. */
export function createSuspendedNotice(
  log: (level: string, message: string) => void,
  { intervalMs = SUSPENDED_LOG_INTERVAL_MS, now = () => Date.now() }: { intervalMs?: number; now?: () => number } = {},
) {
  let lastAt = Number.NEGATIVE_INFINITY;
  return {
    /** Call on every agent_suspended_plan response. Returns true when it logged. */
    note(): boolean {
      const t = now();
      if (t - lastAt < intervalMs) return false;
      lastAt = t;
      log("WARN", suspendedMessage());
      return true;
    },
    /** Call on any successful cloud call: the next suspension logs immediately. */
    reset(): void {
      lastAt = Number.NEGATIVE_INFINITY;
    },
  };
}
