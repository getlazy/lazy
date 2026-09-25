/**
 * Per-request phase timings and size counts for the daemon's HTML pages.
 *
 * WHY THIS EXISTS: the review page for a large release hub is slow immediately
 * — not by degradation — and nobody could say which phase spends the time. Is
 * it the git diff, parsing 12 MB of unified diff, or emitting HTML for 1,843
 * files? Every answer to that was a guess. So every page render now MEASURES
 * itself, permanently, and reports the numbers two ways:
 *
 *   - a `Server-Timing` response header, which browser dev tools render as a
 *     bar chart in the Network → Timing panel (no tooling to install), and
 *   - one `logger.debug` line per request with the same numbers, so a slow page
 *     leaves a trace in the daemon log after the tab is closed.
 *
 * MEASUREMENT ONLY. Nothing here caches, truncates or paginates, and no page
 * renders differently because it is being measured. Fixing what the numbers
 * expose is separate work — measure first, then fix root causes.
 *
 * COST. A page render performs a few dozen `performance.now()` calls (tens of
 * nanoseconds each) and one small Map per request. The only non-trivial work is
 * `Buffer.byteLength` over the response body, which the HTTP layer has to do
 * anyway to set Content-Length. Building the debug LINE is the one part worth
 * skipping, so callers gate it on `logger.isDebugEnabled()`.
 */

/** The response header phases and counts are published on. */
export const SERVER_TIMING_HEADER = 'Server-Timing';

/** Prefix of the one debug line each measured render emits. */
export const TIMING_LOG_PREFIX = 'web-timing';

/**
 * An open phase. `end()` is idempotent, so a phase closed in a `finally` and
 * again by a later `end()` is recorded once — never twice, never negative.
 */
export interface PhaseHandle {
  end(): void;
}

/**
 * Server-Timing metric names are RFC 7230 tokens: no spaces, no commas, no
 * semicolons. Phase names come from code literals here, so this is insurance
 * against a name that would corrupt a header we now emit on every response —
 * a malformed header is worse than an ugly metric name.
 */
function tokenize(name: string): string {
  return name.replace(/[^A-Za-z0-9!#$%&'*+\-.^_`|~]/g, '_') || 'unnamed';
}

/** Milliseconds at one decimal — enough to read, short enough for a header. */
function ms(value: number): string {
  return value.toFixed(1);
}

export class RenderTimings {
  /** Route PATTERN (`/review/:id`), not the concrete path — safe to group by. */
  private readonly route: string;
  private readonly startedAt = performance.now();
  /** Frozen by `finish()` so the header and the log line agree on the total. */
  private totalMs: number | null = null;

  /**
   * Phases currently open, innermost last. A phase's recorded key is its own
   * name prefixed by its ancestors (`render.changes`), which is what makes the
   * output a tree rather than a flat list of names that happen to overlap.
   */
  private readonly open: string[] = [];
  /** First-seen order, so the output reads in the order the work happened. */
  private readonly phaseOrder: string[] = [];
  /** Key → accumulated milliseconds. A phase entered twice sums. */
  private readonly phaseMs = new Map<string, number>();

  private readonly countOrder: string[] = [];
  private readonly counts = new Map<string, number>();

  constructor(route: string) {
    this.route = route;
  }

  /**
   * Open a phase. Purely additive at the call site — bracket an existing block
   * with `begin()`/`end()` and the block itself does not move, which is how
   * render blocks get measured without restructuring the code that builds them.
   */
  begin(name: string): PhaseHandle {
    const key = [...this.open, name].join('.');
    this.open.push(name);
    // Depth is captured rather than re-read at `end()`: a phase that ends while
    // a child is somehow still open must truncate the stack back to its OWN
    // parent, or every later sibling would be recorded under a stale prefix.
    const depth = this.open.length;
    const startedAt = performance.now();
    let ended = false;
    return {
      end: () => {
        if (ended) return;
        ended = true;
        this.record(key, performance.now() - startedAt);
        if (this.open.length >= depth) this.open.length = depth - 1;
      },
    };
  }

  /** Measure an async phase. The phase closes even if `work` throws. */
  async measure<T>(name: string, work: () => Promise<T>): Promise<T> {
    const phase = this.begin(name);
    try {
      return await work();
    } finally {
      phase.end();
    }
  }

  /** Measure a synchronous phase — the HTML renderers are all synchronous. */
  measureSync<T>(name: string, work: () => T): T {
    const phase = this.begin(name);
    try {
      return work();
    } finally {
      phase.end();
    }
  }

  /**
   * Record a size count: diff bytes, file count, turns, children, threads.
   * Last write wins (these describe the page, they do not accumulate), and a
   * count is only ever recorded for data the page ALREADY loaded — reading
   * something extra to print a number would change the cost being measured.
   */
  count(name: string, value: number): void {
    if (!this.counts.has(name)) this.countOrder.push(name);
    this.counts.set(name, value);
  }

  /**
   * Freeze the total. Idempotent, so a route that finishes on more than one
   * path (an early 404, then the happy path) still reports one total.
   */
  finish(): void {
    if (this.totalMs === null) this.totalMs = performance.now() - this.startedAt;
  }

  /** Total so far, or the frozen total once `finish()` has run. */
  private total(): number {
    return this.totalMs ?? performance.now() - this.startedAt;
  }

  private record(key: string, duration: number): void {
    const previous = this.phaseMs.get(key);
    if (previous === undefined) {
      this.phaseOrder.push(key);
      this.phaseMs.set(key, duration);
    } else {
      this.phaseMs.set(key, previous + duration);
    }
  }

  /**
   * The `Server-Timing` header value: `total` first, then phases in the order
   * the work happened, then counts.
   *
   * Durations use `dur` (milliseconds — what the header means by it). Counts
   * use `desc` instead: a file count is not a duration, and publishing 1843 as
   * `dur` would draw a 1.8-second bar in dev tools for something that took no
   * time at all.
   */
  header(): string {
    const metrics = [`total;dur=${ms(this.total())}`];
    for (const key of this.phaseOrder) {
      metrics.push(`${tokenize(key)};dur=${ms(this.phaseMs.get(key) ?? 0)}`);
    }
    for (const key of this.countOrder) {
      metrics.push(`${tokenize(key)};desc="${this.counts.get(key) ?? 0}"`);
    }
    return metrics.join(', ');
  }

  /**
   * The same numbers as one log line. Built only when debug logging is on —
   * see the gate at the call site.
   */
  logLine(): string {
    const parts = [`${TIMING_LOG_PREFIX} route=${this.route}`, `total=${ms(this.total())}ms`];
    for (const key of this.phaseOrder) {
      parts.push(`${key}=${ms(this.phaseMs.get(key) ?? 0)}ms`);
    }
    for (const key of this.countOrder) {
      parts.push(`${key}=${this.counts.get(key) ?? 0}`);
    }
    return parts.join(' ');
  }

  /**
   * Phase keys and durations, for tests and for anything that wants the numbers
   * without parsing a header back apart.
   */
  phases(): { name: string; ms: number }[] {
    return this.phaseOrder.map((name) => ({ name, ms: this.phaseMs.get(name) ?? 0 }));
  }
}

/**
 * A timings object for a render nobody is measuring.
 *
 * The HTML renderers take their timings as an optional argument so the ~40
 * existing unit tests that call them directly keep working unchanged. Handing
 * them a real-but-unread instance keeps the renderers free of
 * `timings?.measureSync(...) ?? work()` branching at every block: one
 * allocation and a few `performance.now()` calls per render, read by no one.
 */
export function unmeasured(): RenderTimings {
  return new RenderTimings('unmeasured');
}
