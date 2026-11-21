// A hard deadline for a promise that might never settle.
//
// Timeouts inside a library (c-ares `timeout`, AbortSignal on fetch, a
// socket timeout) are not enough on their own: a prober once stopped
// producing results for days because one probe's promise never settled, so
// its check stayed "running" forever. Every await on network I/O in a loop
// that must keep going goes through this.

export class DeadlineError extends Error {
  readonly code = "ETIMEDOUT";
  constructor(readonly label: string, readonly ms: number) {
    super(`${label} did not settle within ${ms} ms`);
    this.name = "DeadlineError";
  }
}

/**
 * Settle with `p`, or reject with DeadlineError after `ms`. The abandoned
 * promise keeps running (it cannot be cancelled from here); its late
 * rejection is swallowed so it never surfaces as an unhandled rejection.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(label, ms)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}
