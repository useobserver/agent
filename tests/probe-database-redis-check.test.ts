// Redis command allowlist parser tests.

import { describe, expect, it } from "bun:test";
import { checkRedisCommand, REDIS_ALLOWED_COMMANDS } from "../src/sources/database/_redis-check.ts";

describe("checkRedisCommand — accepts", () => {
  it("DBSIZE", () => {
    const r = checkRedisCommand("DBSIZE");
    expect(r.ok).toBe(true);
    expect(r.command).toBe("DBSIZE");
    expect(r.args).toEqual([]);
  });
  it("lowercase llen with arg", () => {
    const r = checkRedisCommand("llen myqueue");
    expect(r.ok).toBe(true);
    expect(r.command).toBe("LLEN");
    expect(r.args).toEqual(["myqueue"]);
  });
  it("EXISTS with multiple keys", () => {
    const r = checkRedisCommand("EXISTS a b c");
    expect(r.ok).toBe(true);
    expect(r.args).toEqual(["a", "b", "c"]);
  });
  it("GET with a quoted key", () => {
    const r = checkRedisCommand('GET "config:version"');
    expect(r.ok).toBe(true);
    expect(r.args).toEqual(["config:version"]);
  });
  it("BITCOUNT with key + range args", () => {
    const r = checkRedisCommand("BITCOUNT mybits 0 -1");
    expect(r.ok).toBe(true);
    expect(r.args).toEqual(["mybits", "0", "-1"]);
  });
  it("trims surrounding whitespace", () => {
    const r = checkRedisCommand("   DBSIZE  ");
    expect(r.ok).toBe(true);
  });
});

describe("checkRedisCommand — rejects", () => {
  it("empty string", () => {
    expect(checkRedisCommand("").ok).toBe(false);
    expect(checkRedisCommand("   ").ok).toBe(false);
  });
  it("non-string", () => {
    expect(checkRedisCommand(undefined as unknown as string).ok).toBe(false);
  });
  it("SET (mutating)", () => {
    const r = checkRedisCommand("SET key value");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/SET/);
  });
  it("FLUSHALL", () => {
    expect(checkRedisCommand("FLUSHALL").ok).toBe(false);
  });
  it("DEL", () => {
    expect(checkRedisCommand("DEL key").ok).toBe(false);
  });
  it("KEYS (excluded due to O(N) cost)", () => {
    expect(checkRedisCommand("KEYS *").ok).toBe(false);
  });
  it("SCAN (excluded — multi-call cursor protocol)", () => {
    expect(checkRedisCommand("SCAN 0").ok).toBe(false);
  });
  it("INFO (excluded v1)", () => {
    expect(checkRedisCommand("INFO replication").ok).toBe(false);
  });
  it("CONFIG GET", () => {
    expect(checkRedisCommand("CONFIG GET maxmemory").ok).toBe(false);
  });
  it("a command with an embedded newline (RESP-injection guard)", () => {
    const r = checkRedisCommand("DBSIZE\r\nFLUSHALL");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/newline/);
  });
  it("a command with unbalanced quotes", () => {
    const r = checkRedisCommand('GET "unterminated');
    expect(r.ok).toBe(false);
  });
});

describe("REDIS_ALLOWED_COMMANDS", () => {
  it("contains the expected read-only commands", () => {
    expect(REDIS_ALLOWED_COMMANDS).toContain("DBSIZE");
    expect(REDIS_ALLOWED_COMMANDS).toContain("LLEN");
    expect(REDIS_ALLOWED_COMMANDS).toContain("GET");
    expect(REDIS_ALLOWED_COMMANDS).not.toContain("SET");
    expect(REDIS_ALLOWED_COMMANDS).not.toContain("DEL");
    expect(REDIS_ALLOWED_COMMANDS).not.toContain("KEYS");
  });
});
