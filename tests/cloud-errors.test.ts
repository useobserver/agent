import { describe, expect, test } from "bun:test";
import { AGENT_SUSPENDED_CODE, cloudErrorCode, createSuspendedNotice } from "../src/cloud-errors.ts";

describe("cloudErrorCode", () => {
  test("reads the error code from the cloud's JSON body", () => {
    expect(cloudErrorCode(JSON.stringify({ error: "agent_suspended_plan", message: "paused" }))).toBe(AGENT_SUSPENDED_CODE);
    expect(cloudErrorCode(JSON.stringify({ code: "agent_suspended_plan" }))).toBe(AGENT_SUSPENDED_CODE);
  });
  test("is null for non-JSON, empty or odd bodies", () => {
    expect(cloudErrorCode("")).toBeNull();
    expect(cloudErrorCode(null)).toBeNull();
    expect(cloudErrorCode("<html>")).toBeNull();
    expect(cloudErrorCode(JSON.stringify({ error: 42 }))).toBeNull();
  });
});

describe("createSuspendedNotice", () => {
  test("logs once per interval, not on every retry", () => {
    const lines: string[] = [];
    let t = 0;
    const notice = createSuspendedNotice((_lvl, msg) => lines.push(msg), { intervalMs: 1000, now: () => t });
    expect(notice.note()).toBe(true);
    t = 500;
    expect(notice.note()).toBe(false);
    t = 999;
    expect(notice.note()).toBe(false);
    t = 1000;
    expect(notice.note()).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("more agents than its plan allows");
  });
  test("a successful call resets it so the next suspension logs at once", () => {
    const lines: string[] = [];
    let t = 0;
    const notice = createSuspendedNotice((_lvl, msg) => lines.push(msg), { intervalMs: 1000, now: () => t });
    notice.note();
    notice.reset();
    t = 10;
    expect(notice.note()).toBe(true);
    expect(lines).toHaveLength(2);
  });
});
