// Definitions refresher: decides WHEN the agent re-fetches its metric
// definitions from the cloud. The fetch + apply itself lives in index.ts
// and is injected, so the scheduling rules are unit-testable with a fake
// clock.
//
// Three triggers, one fetch path (single-flight, one timer):
//
//   1. Change signal. Clouds that support it return `definitions_version`
//      in every heartbeat response (every 30s) and the same value in the
//      definitions response header. When the heartbeat's version differs
//      from the version of the last fetch, the agent re-fetches right away,
//      so a new or edited metric is picked up within one heartbeat.
//   2. Warm-up. For the first WARMUP_WINDOW_MS after start, until the first
//      non-empty fetch, poll every WARMUP_INTERVAL_MS. A fresh install picks
//      up its first metric quickly even against a cloud without the signal.
//   3. Backstop. Every STEADY_INTERVAL_MS regardless, exactly as before the
//      signal existed. Clouds that never send a version get this alone.
//
// Resilience: fetch failures never throw out of here (onError reports
// them); consecutive failures back off (30s, 60s, 120s, ... capped at
// MAX_BACKOFF_MS) for signal-driven and warm-up retries alike, and any two
// fetch attempts are at least MIN_GAP_MS apart. Worst case ~4 req/min,
// well under the cloud's per-agent rate limit on the definitions route.

export const WARMUP_WINDOW_MS = 10 * 60_000;
export const WARMUP_INTERVAL_MS = 30_000;
export const STEADY_INTERVAL_MS = 5 * 60_000;
export const MIN_GAP_MS = 10_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
// Versions are short opaque hex strings; anything else is ignored.
const MAX_VERSION_LENGTH = 128;

export interface DefinitionsFetchOutcome {
  /** Number of definitions the cloud returned (and the agent applied). */
  count: number;
  /** Version from the definitions response header; null when absent. */
  version: string | null;
}

export interface DefinitionsRefresherOptions {
  /** Fetch definitions from the cloud and apply them. Throws on failure. */
  fetchAndApply: () => Promise<DefinitionsFetchOutcome>;
  onError?: (error: unknown) => void;
  log?: (level: string, message: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  warmupWindowMs?: number;
  warmupIntervalMs?: number;
  steadyIntervalMs?: number;
  minGapMs?: number;
  maxBackoffMs?: number;
}

export interface DefinitionsRefresherState {
  appliedVersion: string | null;
  remoteVersion: string | null;
  inWarmup: boolean;
  consecutiveFailures: number;
  fetches: number;
  /** Absolute time (per `now`) the next attempt is armed for, or null. */
  nextAttemptAt: number | null;
}

export interface DefinitionsRefresher {
  /** First fetch immediately, then keeps itself scheduled. Never rejects. */
  start(): Promise<void>;
  stop(): void;
  /** Feed `definitions_version` from a heartbeat response. Anything that
   *  is not a non-empty string (absent field, older cloud) is ignored. */
  noteRemoteVersion(version: unknown): void;
  state(): DefinitionsRefresherState;
}

export function createDefinitionsRefresher(opts: DefinitionsRefresherOptions): DefinitionsRefresher {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const warmupWindowMs = opts.warmupWindowMs ?? WARMUP_WINDOW_MS;
  const warmupIntervalMs = opts.warmupIntervalMs ?? WARMUP_INTERVAL_MS;
  const steadyIntervalMs = opts.steadyIntervalMs ?? STEADY_INTERVAL_MS;
  const minGapMs = opts.minGapMs ?? MIN_GAP_MS;
  const maxBackoffMs = opts.maxBackoffMs ?? MAX_BACKOFF_MS;

  let startedAt = now();
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let timer: unknown = null;
  let timerAt: number | null = null;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let failures = 0;
  let fetches = 0;
  let sawNonEmpty = false;
  // Version of the set the agent last applied (header, else the heartbeat
  // version known when that fetch started).
  let appliedVersion: string | null = null;
  // Heartbeat version a successful fetch has already answered. Guards
  // against a refetch loop if header and heartbeat ever disagree: each
  // distinct heartbeat version costs at most one successful fetch.
  let satisfiedRemote: string | null = null;
  let remoteVersion: string | null = null;

  const inWarmup = (): boolean => !sawNonEmpty && now() - startedAt < warmupWindowMs;

  const retryDelay = (): number =>
    failures === 0 ? 0 : Math.min(maxBackoffMs, warmupIntervalMs * 2 ** (failures - 1));

  const periodicDelay = (): number => {
    const base = inWarmup() ? warmupIntervalMs : steadyIntervalMs;
    return failures === 0 ? base : Math.max(base, retryDelay());
  };

  const needsFetch = (): boolean =>
    remoteVersion !== null && remoteVersion !== appliedVersion && remoteVersion !== satisfiedRemote;

  function arm(delayMs: number): void {
    if (stopped) return;
    if (timer !== null) clearTimer(timer);
    const ms = Math.max(0, delayMs);
    timerAt = now() + ms;
    timer = setTimer(() => {
      timer = null;
      timerAt = null;
      attempt().catch(() => {});
    }, ms);
  }

  // Pull the next attempt forward to the earliest moment the gap/backoff
  // allows. Never pushes an already-sooner timer later.
  function requestSoon(): void {
    if (stopped || inFlight) return; // completion re-checks needsFetch()
    const earliest = lastAttemptAt + Math.max(minGapMs, retryDelay());
    const at = Math.max(now(), earliest);
    if (timerAt !== null && timerAt <= at) return;
    arm(at - now());
  }

  async function attempt(): Promise<void> {
    if (stopped) return;
    if (inFlight) return inFlight;
    const remoteAtStart = remoteVersion;
    lastAttemptAt = now();
    fetches++;
    inFlight = (async () => {
      try {
        const out = await opts.fetchAndApply();
        failures = 0;
        if (out.count > 0) sawNonEmpty = true;
        appliedVersion =
          typeof out.version === "string" && out.version.length > 0 ? out.version : remoteAtStart;
        satisfiedRemote = remoteAtStart;
      } catch (error) {
        failures++;
        try {
          opts.onError?.(error);
        } catch {
          /* reporting must never break scheduling */
        }
      }
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
    if (stopped) return;
    arm(periodicDelay());
    if (needsFetch()) requestSoon();
  }

  return {
    async start() {
      stopped = false;
      startedAt = now();
      await attempt();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      timerAt = null;
    },
    noteRemoteVersion(version: unknown) {
      if (typeof version !== "string" || version.length === 0 || version.length > MAX_VERSION_LENGTH) {
        return;
      }
      const changed = version !== remoteVersion;
      remoteVersion = version;
      if (!needsFetch()) return;
      if (changed) opts.log?.("INFO", "Metric definitions changed on the cloud; re-fetching.");
      requestSoon();
    },
    state() {
      return {
        appliedVersion,
        remoteVersion,
        inWarmup: inWarmup(),
        consecutiveFailures: failures,
        fetches,
        nextAttemptAt: timerAt,
      };
    },
  };
}
