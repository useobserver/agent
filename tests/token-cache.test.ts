// _token-cache.ts: identity-keyed, refreshed 60s before expiry, single-flight, LRU.
import { describe, expect, it } from "bun:test";
import { TokenCache, tokenCacheKey, type TokenFetchResult } from "../src/sources/_token-cache.ts";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("tokenCacheKey", () => {
  it("is a stable SHA-256 regardless of field order", () => {
    const a = tokenCacheKey({ tenant: "t", client: "c", ref: "AZ_SECRET" });
    const b = tokenCacheKey({ ref: "AZ_SECRET", client: "c", tenant: "t" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenCacheKey({ tenant: "t", client: "other", ref: "AZ_SECRET" })).not.toBe(a);
    expect(tokenCacheKey({ a: undefined })).toBe(tokenCacheKey({ a: null }));
  });
});

describe("TokenCache", () => {
  it("reuses a token until 60s before expiry, then refreshes", async () => {
    const c = clock();
    const cache = new TokenCache({ now: c.now });
    let calls = 0;
    const fetchToken = async (): Promise<TokenFetchResult> => {
      calls++;
      return { ok: true, token: `t${calls}`, expiresAt: c.now() + 3_600_000 };
    };
    expect(await cache.get("k", fetchToken)).toMatchObject({ ok: true, token: "t1" });
    expect(await cache.get("k", fetchToken)).toMatchObject({ ok: true, token: "t1" });
    expect(calls).toBe(1);
    c.advance(3_600_000 - 60_001);
    expect(await cache.get("k", fetchToken)).toMatchObject({ token: "t1" });
    c.advance(1);
    expect(await cache.get("k", fetchToken)).toMatchObject({ token: "t2" });
    expect(calls).toBe(2);
  });

  it("concurrent misses share one request", async () => {
    const cache = new TokenCache();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchToken = async (): Promise<TokenFetchResult> => {
      calls++;
      await gate;
      return { ok: true, token: "shared", expiresAt: Date.now() + 3_600_000 };
    };
    const all = Promise.all(Array.from({ length: 10 }, () => cache.get("k", fetchToken)));
    release();
    const results = await all;
    expect(calls).toBe(1);
    expect(results.every((r) => r.ok && r.token === "shared")).toBe(true);
  });

  it("does not cache failures", async () => {
    const cache = new TokenCache();
    let calls = 0;
    const failing = async (): Promise<TokenFetchResult> => {
      calls++;
      return { ok: false, reason: "token_error" };
    };
    expect(await cache.get("k", failing)).toEqual({ ok: false, reason: "token_error" });
    expect(await cache.get("k", failing)).toEqual({ ok: false, reason: "token_error" });
    expect(calls).toBe(2);
    expect(cache.size).toBe(0);
  });

  it("a rejecting fetcher rejects every waiter and leaves nothing in flight", async () => {
    const cache = new TokenCache();
    const boom = async (): Promise<TokenFetchResult> => {
      throw new Error("boom");
    };
    await expect(cache.get("k", boom)).rejects.toThrow("boom");
    expect(await cache.get("k", async () => ({ ok: true, token: "ok", expiresAt: Date.now() + 3_600_000 }))).toMatchObject({
      token: "ok",
    });
  });

  it("evicts the least recently used credential past the bound", async () => {
    const cache = new TokenCache({ max: 2 });
    let calls = 0;
    const f = async (): Promise<TokenFetchResult> => {
      calls++;
      return { ok: true, token: `t${calls}`, expiresAt: Date.now() + 3_600_000 };
    };
    await cache.get("a", f);
    await cache.get("b", f);
    await cache.get("a", f); // a is now most recent
    await cache.get("c", f); // evicts b
    expect(cache.size).toBe(2);
    expect(calls).toBe(3);
    await cache.get("a", f);
    expect(calls).toBe(3);
    await cache.get("b", f);
    expect(calls).toBe(4);
  });

  it("defaults to 64 entries", async () => {
    const cache = new TokenCache();
    for (let i = 0; i < 100; i++) {
      await cache.get(`k${i}`, async () => ({ ok: true, token: "t", expiresAt: Date.now() + 3_600_000 }));
    }
    expect(cache.size).toBe(64);
  });

  it("invalidate drops one credential", async () => {
    const cache = new TokenCache();
    let calls = 0;
    const f = async (): Promise<TokenFetchResult> => ({ ok: true, token: `t${++calls}`, expiresAt: Date.now() + 3_600_000 });
    await cache.get("k", f);
    cache.invalidate("k");
    expect(await cache.get("k", f)).toMatchObject({ token: "t2" });
  });
});
