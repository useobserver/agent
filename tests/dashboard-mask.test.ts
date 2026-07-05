// @ts-nocheck — matches the queue-lag suite; tighten test types per-file later.
//
// F6: maskValue must not leak most of a short secret (old rule showed
// first4+last4 for anything >8 chars — 8 of a 9-char password), and the
// dashboard must never render its own bearer token, even masked.
// F13: /api/state degrades to a minimal JSON 500 when the snapshot
// provider throws, instead of surfacing a stack trace / killing the page.
import { describe, expect, it } from "bun:test";
import { maskEnv, startDashboard } from "../src/dashboard";

describe("dashboard env masking", () => {
  it("fully masks a 9-char value (old rule leaked 8 of 9 chars)", () => {
    expect(maskEnv({ AGENT_KEY: "123456789" }).AGENT_KEY).toBe("****");
  });

  it("fully masks values up to 19 chars (boundary)", () => {
    expect(maskEnv({ AGENT_KEY: "a".repeat(19) }).AGENT_KEY).toBe("****");
  });

  it("20-char value shows first 4 + ellipsis + last 2 (boundary)", () => {
    const v = "abcd" + "x".repeat(14) + "yz"; // exactly 20 chars
    expect(maskEnv({ AGENT_KEY: v }).AGENT_KEY).toBe("abcd…yz");
  });

  it("long value shows first 4 + ellipsis + last 2", () => {
    const v = "obs_live_" + "k".repeat(40) + "Q7";
    expect(maskEnv({ AGENT_KEY: v }).AGENT_KEY).toBe("obs_…Q7");
  });

  it("empty value renders empty", () => {
    expect(maskEnv({ AGENT_KEY: "" }).AGENT_KEY).toBe("");
  });

  it("DEBUG_DASHBOARD_TOKEN is never rendered, even masked", () => {
    const out = maskEnv({ DEBUG_DASHBOARD_TOKEN: "supersecretbearertokenvalue-123456" });
    expect(out.DEBUG_DASHBOARD_TOKEN).toBe("•hidden•");
    expect(out.DEBUG_DASHBOARD_TOKEN).not.toContain("supe");
  });

  it("other DEBUG_DASHBOARD_* vars stay visible (masked)", () => {
    expect(maskEnv({ DEBUG_DASHBOARD_PORT: "10101" }).DEBUG_DASHBOARD_PORT).toBe("****");
  });

  it("non-allowlisted keys stay invisible", () => {
    expect(maskEnv({ SOME_RANDOM_SECRET: "x".repeat(30) })).toEqual({});
  });
});

describe("dashboard /api/state resilience", () => {
  it("returns a minimal JSON 500 when getSnapshot throws", async () => {
    const dash = startDashboard({
      port: 0, // ephemeral
      hostname: "127.0.0.1",
      state: {
        getSnapshot() {
          throw new Error("buffer exploded");
        },
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${dash.port}/api/state`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "snapshot_failed" });
      const body = JSON.stringify(await (await fetch(`http://127.0.0.1:${dash.port}/healthz`)).text());
      expect(body).toContain("ok"); // rest of the server still serves
    } finally {
      dash.stop();
    }
  });
});
