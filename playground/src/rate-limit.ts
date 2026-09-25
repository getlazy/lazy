// A small fixed-window rate limiter for link creation, so one script cannot
// fill the database. Windows are whole wall-clock seconds.

export class RateLimiter {
  private window = -1;
  private count = 0;

  constructor(private readonly perSecond: number) {}

  /** Returns true if the request is allowed, and counts it. */
  allow(now = Date.now()): boolean {
    const window = Math.floor(now / 1000);
    if (window !== this.window) {
      this.window = window;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.perSecond;
  }
}
