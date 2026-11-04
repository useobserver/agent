// Access-token cache for sources that trade a credential for a short-lived
// bearer token (Google Cloud, Azure).
//
// - Keyed by credential identity: a SHA-256 of the non-secret identity fields
//   (project, tenant, client id, auth mode, ...) plus the env-var ref NAME.
//   Never the secret itself, so the key is safe to hold in memory and logs.
// - A token is reused until `expiresAt - 60s`, then refreshed.
// - Single-flight: concurrent probes that miss on the same key share one
//   token request.
// - LRU-bounded (64 entries by default) so config churn can't grow it.
// - Failures are not cached; the next probe retries.

import { createHash } from "node:crypto";

export interface AccessToken {
  token: string;
  /** Absolute expiry, epoch milliseconds. */
  expiresAt: number;
}

export type TokenFetchResult =
  | ({ ok: true } & AccessToken)
  | { ok: false; reason: string; metadata?: Record<string, unknown> };

export interface TokenCacheOptions {
  /** Max cached credentials (default 64). */
  max?: number;
  /** Refresh this long before expiry (default 60s). */
  refreshSkewMs?: number;
  /** Clock seam for tests (epoch ms). */
  now?: () => number;
}

/**
 * Stable cache key for a credential: SHA-256 over the identity fields,
 * sorted by name. Pass only non-secret fields and ref names.
 */
export function tokenCacheKey(identity: Record<string, string | null | undefined>): string {
  const canonical = Object.keys(identity)
    .sort()
    .map((k) => [k, identity[k] ?? null]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export class TokenCache {
  private readonly max: number;
  private readonly skewMs: number;
  private readonly now: () => number;
  // Map iteration order is insertion order: re-inserting on hit makes the
  // first key the least recently used.
  private readonly tokens = new Map<string, AccessToken>();
  private readonly inflight = new Map<string, Promise<TokenFetchResult>>();

  constructor(opts: TokenCacheOptions = {}) {
    this.max = Math.max(1, opts.max ?? 64);
    this.skewMs = opts.refreshSkewMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * A valid token for `key`, from the cache or from `fetchToken`. The fetcher
   * should resolve failures as `{ ok: false }`; if it rejects, every waiter
   * sees the rejection and the caller's own catch handles it.
   */
  async get(key: string, fetchToken: () => Promise<TokenFetchResult>): Promise<TokenFetchResult> {
    const cached = this.tokens.get(key);
    if (cached && this.now() < cached.expiresAt - this.skewMs) {
      this.tokens.delete(key);
      this.tokens.set(key, cached);
      return { ok: true, token: cached.token, expiresAt: cached.expiresAt };
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const p = (async () => {
      try {
        const res = await fetchToken();
        if (res.ok) this.store(key, { token: res.token, expiresAt: res.expiresAt });
        else this.tokens.delete(key);
        return res;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  /** Drop one credential's token (e.g. after the API answered 401). */
  invalidate(key: string): void {
    this.tokens.delete(key);
  }

  clear(): void {
    this.tokens.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.tokens.size;
  }

  private store(key: string, token: AccessToken): void {
    this.tokens.delete(key);
    this.tokens.set(key, token);
    while (this.tokens.size > this.max) {
      const oldest = this.tokens.keys().next().value as string;
      this.tokens.delete(oldest);
    }
  }
}
