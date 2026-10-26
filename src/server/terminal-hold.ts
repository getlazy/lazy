/**
 * A terminal outlives a dropped connection.
 *
 * A web terminal's program is the `docker exec` its socket opened, so closing
 * the socket used to HUP it — a shell, a Pair or Chat session, gone with the
 * Wi-Fi. "Reload to reattach" then opened a NEW one. Now a socket that closes
 * without the page saying it is done (`{type:"end"}`, ./shell-protocol.ts)
 * leaves its exec running here for {@link TERMINAL_RESUME_GRACE_MS}, keyed by
 * a one-time RESUME TOKEN the page was handed in its `ready` frame. The page
 * reconnects with `?resume=<token>&offset=<bytes it has drawn>` and gets the
 * output it missed, from {@link OutputLog}, then the live stream again — the
 * same program, the same screen, nothing drawn twice.
 *
 * A token is bound to an OWNER — the route, the target and, on a shared
 * daemon, the person — so it can only be claimed back through the same gate
 * that opened it, by the same caller; the route's own authorization runs on
 * every reattach before the token is even looked at. Tokens are rotated on
 * every claim. A claim while the old socket is still attached (a half-open
 * connection the server has not noticed yet, after a laptop sleep) takes the
 * terminal over and closes the old socket.
 *
 * Nothing here recreates anything: when the grace runs out, or the program
 * exits, the hold ends exactly the way a closed socket always ended it.
 */

import { randomBytes } from 'crypto';

/** How long a terminal whose connection dropped keeps running, waiting for its page. */
export const TERMINAL_RESUME_GRACE_MS = 5 * 60_000;

/** How much recent output a held terminal keeps for its page to catch up on. */
export const TERMINAL_REPLAY_BYTES = 1024 * 1024;

/** Tokens are URL-safe base64 of 24 random bytes. */
export const RESUME_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export function newResumeToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Every output byte a terminal produced, counted, with the most recent
 * {@link TERMINAL_REPLAY_BYTES} kept. Offsets are absolute byte counts since
 * the terminal opened — what the page counts as it draws.
 */
export class OutputLog {
  private chunks: Uint8Array[] = [];
  private kept = 0;
  /** Total bytes ever appended. */
  total = 0;

  constructor(private readonly capacity: number = TERMINAL_REPLAY_BYTES) {}

  append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    // Copied: the exec stream may reuse its buffer.
    this.chunks.push(bytes.slice());
    this.kept += bytes.length;
    this.total += bytes.length;
    while (this.kept - (this.chunks[0]?.length ?? 0) >= this.capacity && this.chunks.length > 1) {
      this.kept -= this.chunks.shift()!.length;
    }
  }

  /** The offset of the oldest byte still kept. */
  get start(): number {
    return this.total - this.kept;
  }

  /**
   * The bytes after `offset`. `lost` is how many the page missed that are no
   * longer kept (it was away longer than the log holds). An offset beyond what
   * was produced is a confused client: nothing is replayed.
   */
  since(offset: number): { bytes: Uint8Array; lost: number } {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= this.total) {
      return { bytes: new Uint8Array(0), lost: 0 };
    }
    const from = Math.max(offset, this.start);
    const out = new Uint8Array(this.total - from);
    let pos = this.start;
    let written = 0;
    for (const chunk of this.chunks) {
      const end = pos + chunk.length;
      if (end > from) {
        const slice = chunk.subarray(Math.max(0, from - pos));
        out.set(slice, written);
        written += slice.length;
      }
      pos = end;
    }
    return { bytes: out, lost: from - offset };
  }
}

interface Held<T> {
  owner: string;
  value: T;
  timer: ReturnType<typeof setTimeout> | null;
  onExpire: () => void;
}

/**
 * The registry of resumable terminals. One per daemon process; `T` is the
 * per-terminal state the relay keeps (its socket data).
 */
export class TerminalHolds<T> {
  private readonly held = new Map<string, Held<T>>();

  constructor(private readonly graceMs: () => number = () => TERMINAL_RESUME_GRACE_MS) {}

  /** Register a live terminal under a fresh token; returns the token. */
  register(owner: string, value: T, onExpire: () => void): string {
    const token = newResumeToken();
    this.held.set(token, { owner, value, timer: null, onExpire });
    return token;
  }

  /** The terminal's connection dropped: start its grace. */
  detach(token: string): void {
    const h = this.held.get(token);
    if (!h) return;
    if (h.timer) clearTimeout(h.timer);
    h.timer = setTimeout(() => {
      if (this.held.get(token) !== h) return;
      this.held.delete(token);
      h.onExpire();
    }, this.graceMs());
  }

  /**
   * Take a terminal back. Refused (null) for an unknown token or one opened by
   * a different owner — the same answer for both, so a token from someone
   * else's terminal tells the caller nothing. On success the old token is gone
   * and a new one is returned.
   */
  claim(token: string, owner: string): { value: T; token: string } | null {
    const h = this.held.get(token);
    if (!h || h.owner !== owner) return null;
    if (h.timer) clearTimeout(h.timer);
    h.timer = null;
    this.held.delete(token);
    const next = newResumeToken();
    this.held.set(next, h);
    return { value: h.value, token: next };
  }

  /** The terminal ended for good: forget it. */
  release(token: string | null | undefined): void {
    if (!token) return;
    const h = this.held.get(token);
    if (!h) return;
    if (h.timer) clearTimeout(h.timer);
    this.held.delete(token);
  }

  /**
   * End now every held terminal of `owner` that `matches` — the detached Pair
   * or Chat a page lost its token to (a reload while reconnecting), which
   * would otherwise keep the lock a new one needs for the whole grace.
   */
  endWhere(owner: string, matches: (value: T) => boolean): void {
    for (const [token, h] of [...this.held]) {
      if (h.owner !== owner || !matches(h.value)) continue;
      if (h.timer) clearTimeout(h.timer);
      this.held.delete(token);
      h.onExpire();
    }
  }

  /** Test seam. */
  get size(): number {
    return this.held.size;
  }
}
