import { describe, expect, it } from "bun:test";
import {
  createDefinitionsRefresher,
  MAX_BACKOFF_MS,
  MIN_GAP_MS,
  STEADY_INTERVAL_MS,
  WARMUP_INTERVAL_MS,
  WARMUP_WINDOW_MS,
  type DefinitionsFetchOutcome,
} from "../src/definitions-refresh";

// Definitions refresher: when the agent re-fetches metric definitions.
// Driven by a fake clock + timer queue so cadence assertions are exact.

function fakeClock() {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number);
    },
    pending: () => timers.size,
    /** Advance the clock by `ms`, firing due timers in order. */
    async advance(ms: number) {
      const target = t + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of timers) if (e[1].at <= target && (!next || e[1].at < next[1].at)) next = e;
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        await flush();
      }
      t = target;
      await flush();
    },
  };
}

interface Harness {
  clock: ReturnType<typeof fakeClock>;
  fetchTimes: number[];
  refresher: ReturnType<typeof createDefinitionsRefresher>;
  /** What the next fetch returns (or throws). */
  next: { count: number; version: string | null; fail?: boolean };
  errors: unknown[];
}

function harness(initial: Partial<Harness["next"]> = {}): Harness {
  const clock = fakeClock();
  const h = {
    clock,
    fetchTimes: [] as number[],
    next: { count: 0, version: null as string | null, ...initial },
    errors: [] as unknown[],
  } as Harness;
  h.refresher = createDefinitionsRefresher({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (e) => h.errors.push(e),
    fetchAndApply: async (): Promise<DefinitionsFetchOutcome> => {
      h.fetchTimes.push(clock.now());
      if (h.next.fail) throw new Error("HTTP 503");
      return { count: h.next.count, version: h.next.version };
    },
  });
  return h;
}

const SEC = 1_000;
const MIN = 60 * SEC;

describe("warm-up cadence", () => {
  it("polls every 30s for the first 10 minutes while the agent has no definitions", async () => {
    const h = harness({ count: 0 });
    await h.refresher.start();
    expect(h.fetchTimes.length).toBe(1);
    expect(h.refresher.state().inWarmup).toBe(true);

    await h.clock.advance(WARMUP_INTERVAL_MS);
    expect(h.fetchTimes.length).toBe(2);

    await h.clock.advance(WARMUP_WINDOW_MS - WARMUP_INTERVAL_MS);
    // 1 at start + one per 30s for 10 min
    expect(h.fetchTimes.length).toBe(1 + WARMUP_WINDOW_MS / WARMUP_INTERVAL_MS);
    const gaps = h.fetchTimes.slice(1).map((t, i) => t - h.fetchTimes[i]);
    expect(new Set(gaps)).toEqual(new Set([WARMUP_INTERVAL_MS]));
  });

  it("drops to the 5 minute backstop after the warm-up window", async () => {
    const h = harness({ count: 0 });
    await h.refresher.start();
    await h.clock.advance(WARMUP_WINDOW_MS);
    expect(h.refresher.state().inWarmup).toBe(false);
    const before = h.fetchTimes.length;
    await h.clock.advance(STEADY_INTERVAL_MS - 1);
    expect(h.fetchTimes.length).toBe(before);
    await h.clock.advance(1);
    expect(h.fetchTimes.length).toBe(before + 1);
  });

  it("ends warm-up on the first non-empty fetch", async () => {
    const h = harness({ count: 0 });
    await h.refresher.start();
    await h.clock.advance(2 * WARMUP_INTERVAL_MS);
    expect(h.fetchTimes.length).toBe(3);

    h.next.count = 1; // operator created the first metric
    await h.clock.advance(WARMUP_INTERVAL_MS);
    expect(h.fetchTimes.length).toBe(4);
    expect(h.refresher.state().inWarmup).toBe(false);

    await h.clock.advance(STEADY_INTERVAL_MS - 1);
    expect(h.fetchTimes.length).toBe(4);
    await h.clock.advance(1);
    expect(h.fetchTimes.length).toBe(5);
  });

  it("skips warm-up entirely when the first fetch already has definitions", async () => {
    const h = harness({ count: 3 });
    await h.refresher.start();
    expect(h.refresher.state().inWarmup).toBe(false);
    await h.clock.advance(STEADY_INTERVAL_MS - 1);
    expect(h.fetchTimes.length).toBe(1);
  });
});

describe("change signal from the heartbeat", () => {
  it("re-fetches right away when the heartbeat version differs from the last fetch", async () => {
    const h = harness({ count: 2, version: "v1" });
    await h.refresher.start();
    expect(h.refresher.state().appliedVersion).toBe("v1");

    await h.clock.advance(30 * SEC);
    h.refresher.noteRemoteVersion("v1"); // unchanged: nothing to do
    await h.clock.advance(MIN_GAP_MS);
    expect(h.fetchTimes.length).toBe(1);

    h.next.version = "v2";
    h.refresher.noteRemoteVersion("v2");
    await h.clock.advance(0);
    expect(h.fetchTimes.length).toBe(2);
    expect(h.refresher.state().appliedVersion).toBe("v2");

    // Same version on later heartbeats: no further fetches until the backstop.
    h.refresher.noteRemoteVersion("v2");
    await h.clock.advance(MIN);
    expect(h.fetchTimes.length).toBe(2);
  });

  it("keeps at least MIN_GAP_MS between fetches", async () => {
    const h = harness({ count: 1, version: "v1" });
    await h.refresher.start();
    h.next.version = "v2";
    h.refresher.noteRemoteVersion("v2"); // right after the boot fetch
    await h.clock.advance(MIN_GAP_MS - 1);
    expect(h.fetchTimes.length).toBe(1);
    await h.clock.advance(1);
    expect(h.fetchTimes.length).toBe(2);
    expect(h.fetchTimes[1] - h.fetchTimes[0]).toBe(MIN_GAP_MS);
  });

  it("resets the backstop after a signal-driven fetch", async () => {
    const h = harness({ count: 1, version: "v1" });
    await h.refresher.start();
    await h.clock.advance(MIN);
    h.next.version = "v2";
    h.refresher.noteRemoteVersion("v2");
    await h.clock.advance(0);
    expect(h.fetchTimes.length).toBe(2);
    const signalFetchAt = h.fetchTimes[1];
    await h.clock.advance(STEADY_INTERVAL_MS);
    expect(h.fetchTimes.length).toBe(3);
    expect(h.fetchTimes[2] - signalFetchAt).toBe(STEADY_INTERVAL_MS);
  });

  it("re-fetches again when the version changes during an in-flight fetch", async () => {
    const clock = fakeClock();
    const fetchTimes: number[] = [];
    let release: (() => void) | null = null;
    let version = "v1";
    const r = createDefinitionsRefresher({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      fetchAndApply: async () => {
        fetchTimes.push(clock.now());
        const v = version;
        if (fetchTimes.length === 2) await new Promise<void>((res) => (release = res));
        return { count: 1, version: v };
      },
    });
    await r.start();
    await clock.advance(MIN);
    version = "v2";
    r.noteRemoteVersion("v2");
    await clock.advance(0);
    expect(fetchTimes.length).toBe(2); // in flight, returns v2
    version = "v3";
    r.noteRemoteVersion("v3"); // arrives mid-flight
    release!();
    await clock.advance(0);
    await clock.advance(MIN_GAP_MS);
    expect(fetchTimes.length).toBe(3);
    expect(r.state().appliedVersion).toBe("v3");
  });

  it("uses the heartbeat version when the definitions response has no header", async () => {
    const h = harness({ count: 1, version: null });
    await h.refresher.start();
    h.refresher.noteRemoteVersion("v1"); // first heartbeat after boot
    await h.clock.advance(MIN_GAP_MS);
    expect(h.fetchTimes.length).toBe(2);
    expect(h.refresher.state().appliedVersion).toBe("v1");
    h.refresher.noteRemoteVersion("v1");
    await h.clock.advance(MIN);
    expect(h.fetchTimes.length).toBe(2);
  });

  it("does not loop when header and heartbeat versions disagree", async () => {
    const h = harness({ count: 1, version: "header-x" });
    await h.refresher.start();
    for (let i = 0; i < 10; i++) {
      h.refresher.noteRemoteVersion("heartbeat-y");
      await h.clock.advance(30 * SEC);
    }
    // One fetch answers "heartbeat-y"; after that only the backstop runs.
    expect(h.fetchTimes.length).toBe(2);
  });
});

describe("fallback when the cloud sends no version", () => {
  it("ignores an absent or malformed definitions_version", async () => {
    const h = harness({ count: 1, version: null });
    await h.refresher.start();
    for (const v of [undefined, null, 42, "", {}, "x".repeat(500)]) {
      h.refresher.noteRemoteVersion(v);
    }
    await h.clock.advance(STEADY_INTERVAL_MS - 1);
    expect(h.fetchTimes.length).toBe(1);
    expect(h.refresher.state().remoteVersion).toBeNull();
    await h.clock.advance(1);
    expect(h.fetchTimes.length).toBe(2); // 5 minute backstop unchanged
  });
});

describe("resilience", () => {
  it("never throws on fetch failure and backs off warm-up retries", async () => {
    const h = harness({ count: 0, fail: true });
    await h.refresher.start(); // must resolve, not reject
    expect(h.errors.length).toBe(1);
    await h.clock.advance(WARMUP_WINDOW_MS);
    const gaps = h.fetchTimes.slice(1).map((t, i) => t - h.fetchTimes[i]);
    expect(gaps.slice(0, 4)).toEqual([30 * SEC, 60 * SEC, 120 * SEC, 240 * SEC]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });

  it("gates signal-driven retries by the backoff, then recovers", async () => {
    const h = harness({ count: 1, version: "v1" });
    await h.refresher.start();
    h.next = { count: 1, version: "v2", fail: true };
    await h.clock.advance(MIN);
    h.refresher.noteRemoteVersion("v2");
    await h.clock.advance(0);
    expect(h.fetchTimes.length).toBe(2); // fails
    // Heartbeats keep signalling every 30s; retries follow 30s, 60s, 120s.
    for (let i = 0; i < 8; i++) {
      h.refresher.noteRemoteVersion("v2");
      await h.clock.advance(30 * SEC);
    }
    const retryGaps = h.fetchTimes.slice(2).map((t, i) => t - h.fetchTimes[i + 1]);
    expect(retryGaps).toEqual([30 * SEC, 60 * SEC, 120 * SEC]);

    h.next.fail = false;
    await h.clock.advance(4 * MIN);
    expect(h.refresher.state().appliedVersion).toBe("v2");
    expect(h.refresher.state().consecutiveFailures).toBe(0);
  });

  it("stop() cancels every pending timer", async () => {
    const h = harness({ count: 0 });
    await h.refresher.start();
    h.refresher.stop();
    expect(h.clock.pending()).toBe(0);
    h.refresher.noteRemoteVersion("v9");
    await h.clock.advance(WARMUP_WINDOW_MS);
    expect(h.fetchTimes.length).toBe(1);
  });
});
