// Minimal in-memory sliding-window rate limiting for a single-instance demo.
// State lives in module scope: it resets on redeploy/restart and is not
// shared across serverless instances — acceptable here by design.

export class SlidingWindow {
  private hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000
  ) {}

  /** Consumes a slot if available. Returns false when the limit is hit. */
  tryHit(now = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.limit) {
      return false;
    }
    this.hits.push(now);
    return true;
  }

  /** Currently counted hits inside the window. */
  count(now = Date.now()): number {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    return this.hits.length;
  }
}

export class KeyedSlidingWindow {
  private readonly windows = new Map<string, SlidingWindow>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000
  ) {}

  tryHit(key: string, now = Date.now()): boolean {
    // Opportunistic cleanup so the map can't grow without bound.
    if (this.windows.size > 1_000) {
      for (const [k, w] of this.windows) {
        if (w.count(now) === 0) {
          this.windows.delete(k);
        }
      }
    }
    let window = this.windows.get(key);
    if (!window) {
      window = new SlidingWindow(this.limit, this.windowMs);
      this.windows.set(key, window);
    }
    return window.tryHit(now);
  }
}

/** Best-effort client identity behind proxies; good enough for a demo cap. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return request.headers.get("x-real-ip") ?? "local";
}
