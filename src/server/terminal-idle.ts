/**
 * How long a member's terminal may sit unused, or stay open at all, before
 * the daemon closes it (src/server/session-attach-ws.ts).
 *
 * A member's open terminal keeps every turn off the task
 * (src/server/member-terminals.ts). A forgotten browser tab would otherwise do
 * that forever — auto-resume and auto-delivery included — so a member
 * terminal is closed after {@link MEMBER_TERMINAL_IDLE_MS} with nobody typing
 * in it, and after {@link MEMBER_TERMINAL_MAX_MS} in any case. Only INPUT
 * counts (./shell-ws.ts touches the watch on keystrokes alone): a terminal
 * printing away — a dev server's log — with nobody at the keyboard is idle. Closing it is the ordinary close: the 30-second grace, then the
 * member's environment is discarded.
 */

/** No keystroke for this long closes a member terminal, whatever it prints. */
export const MEMBER_TERMINAL_IDLE_MS = 60 * 60_000;
/** No member terminal stays open longer than this, busy or not. */
export const MEMBER_TERMINAL_MAX_MS = 12 * 60 * 60_000;

export interface TerminalLimits {
  idleMs: number;
  maxMs: number;
}

export interface IdleWatch {
  /** Somebody typed into the terminal. */
  touch(): void;
  stop(): void;
}

/**
 * Watch one terminal. `onExpire` is called at most once, with why, when it
 * has been idle for `idleMs` or open for `maxMs`.
 */
export function watchTerminalIdle(
  limits: TerminalLimits,
  onExpire: (reason: 'idle' | 'max') => void,
  opts: { now?: () => number; checkEveryMs?: number } = {},
): IdleWatch {
  const now = opts.now ?? Date.now;
  const opened = now();
  let last = opened;
  let done = false;
  const check = () => {
    if (done) return;
    const t = now();
    const reason = t - opened >= limits.maxMs ? 'max' : t - last >= limits.idleMs ? 'idle' : null;
    if (!reason) return;
    done = true;
    clearInterval(timer);
    onExpire(reason);
  };
  const timer = setInterval(check, opts.checkEveryMs ?? Math.max(1, Math.min(60_000, Math.floor(limits.idleMs / 4))));
  return {
    touch() { last = now(); },
    stop() { done = true; clearInterval(timer); },
  };
}

/** What the terminal is told as it closes. */
export function terminalExpiredMessage(reason: 'idle' | 'max', limits: TerminalLimits): string {
  return reason === 'idle'
    ? `This terminal was closed after ${Math.round(limits.idleMs / 60_000)} minutes with nobody typing in it, so the agent can work on the task again. Open a new one to continue.`
    : `This terminal was closed after ${Math.round(limits.maxMs / 3_600_000)} hours, so the agent can work on the task again. Open a new one to continue.`;
}
