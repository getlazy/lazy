/**
 * Terminal rendering for daemon phase progress.
 *
 * The daemon narrates long operations as {@link ProgressEvent}s (see
 * src/daemon/progress.ts); this turns them into the thing a human actually
 * watches. It is the CLI half of the "human-facing commands must never sit
 * silent" rule — before this, `lazy accept` printed nothing between the
 * confirmation prompt and the merge result, which for a multi-minute accept is
 * indistinguishable from a hang.
 *
 * Two renderings, chosen by whether the chosen stream is a terminal:
 *
 *   TTY      one line per phase, rewritten in place with a live elapsed
 *            counter while the phase runs, then settled to its final form.
 *   non-TTY  plain append-only lines (a start line and a settle line), so
 *            piped output, CI logs and e2e assertions stay readable.
 *
 * INVARIANT: the elapsed counter is a local clock ticking on top of events the
 * DAEMON sent. It never invents a phase change and never claims progress the
 * daemon did not report — if the daemon goes quiet, the counter keeps counting
 * on the same phase, which is exactly the honest signal ("still on Merge, 94s").
 */

import type { ProgressEvent, ProgressEmitter } from '../daemon/progress';
import { formatDuration } from '../daemon/progress';
import { HEARTBEAT_INTERVAL_MS } from '../daemon/heartbeat';
import { theme } from '../render/theme';

/** A live phase display; call {@link PhaseDisplay.close} when the op settles. */
export interface PhaseDisplay {
  /** Feed this to the daemon query as its progress sink. */
  onProgress: ProgressEmitter;
  /**
   * Feed this the daemon's liveness ticks. Shape matches `RpcObservers`, so a
   * command hands the whole display to the query rather than picking callbacks
   * off it one at a time.
   */
  onHeartbeat: (elapsedMs: number, phase?: string) => void;
  /** Stop the ticker and leave the cursor on a fresh line. */
  close(): void;
}

const TICK_MS = 1000;

/**
 * How long the append-only rendering may print nothing before a heartbeat
 * line is due.
 *
 * Derived from the daemon's heartbeat interval, minus a second of slack: the
 * ticks are the only input this rendering has, so a threshold at or above the
 * interval would push the first line out to the SECOND tick (a tick arriving
 * 4.999s after the phase's start line would be judged "not quiet yet"). One
 * second under means the tick that crosses five seconds of silence prints.
 */
const QUIET_PHASE_MS = HEARTBEAT_INTERVAL_MS - 1_000;

/**
 * Build a phase display, writing to stdout by default.
 *
 * `tty` overrides TTY detection (tests). When neither a TTY nor forced, the
 * append-only rendering is used.
 *
 * `stream: 'stderr'` is for commands whose stdout is a PAYLOAD rather than a
 * transcript — `lazy ask` prints the agent's answer there, and a checklist
 * mixed into it would corrupt anything piping the answer somewhere.
 *
 * `now` is the clock the quiet-phase check reads; injectable so a test can
 * exercise a five-second silence without waiting five seconds.
 */
export function createPhaseDisplay(options?: {
  tty?: boolean;
  stream?: 'stdout' | 'stderr';
  now?: () => number;
}): PhaseDisplay {
  const toStderr = options?.stream === 'stderr';
  const out = toStderr ? process.stderr : process.stdout;
  const tty = options?.tty ?? (out.isTTY ?? false);
  return tty
    ? createTtyDisplay((s: string) => out.write(s))
    : createPlainDisplay(
      toStderr ? (s: string) => console.error(s) : (s: string) => console.log(s),
      options?.now ?? Date.now,
    );
}

/** `[3/9]` position prefix, or '' for an unplanned prelude phase. */
function position(event: Extract<ProgressEvent, { kind: 'phase' }>): string {
  return event.total > 0 && event.index > 0 ? `[${event.index}/${event.total}] ` : '';
}

function detailSuffix(detail?: string): string {
  return detail ? theme.separator(` — ${detail}`) : '';
}

/**
 * `[7/9] Merge (lazy/x → main)…` — a phase that is starting.
 *
 * The detail goes INSIDE, before the ellipsis: `Merge… — lazy/x → main` reads as
 * if the arrow were a result, when it is what the phase is about to do.
 */
function startText(event: Extract<ProgressEvent, { kind: 'phase' }>): string {
  const detail = event.detail ? theme.separator(` (${event.detail})`) : '';
  return `${position(event)}${event.label}${detail}…`;
}

function planHeader(event: Extract<ProgressEvent, { kind: 'plan' }>): string {
  const target = event.target ? ` ${theme.taskId(event.target)}` : '';
  const names = event.phases
    .map((p, i) => `  ${String(i + 1).padStart(2)}. ${p.label}${p.optional ? theme.separator(' (if needed)') : ''}`)
    .join('\n');
  return `\n${theme.header(`${event.operation}${target} — ${event.phases.length} phases`)}\n${names}\n`;
}

function createPlainDisplay(log: (line: string) => void, now: () => number): PhaseDisplay {
  // The phase currently running, and when this rendering last put anything on
  // screen. There is no cursor to rewrite here, so a long phase would print its
  // start line and then nothing at all — which is the silence this display
  // exists to prevent. See `onHeartbeat` below.
  let open: { text: string; startedAt: number } | null = null;
  let lastLineAt = now();

  const emit = (line: string) => {
    log(line);
    lastLineAt = now();
  };

  const onProgress: ProgressEmitter = (event) => {
    if (event.kind === 'plan') {
      emit(planHeader(event));
      return;
    }
    // Activity events belong to a live subscription (proxy traffic), not to a
    // phased operation — the subscriber renders those itself. See ../daemon/progress.ts.
    if (event.kind === 'activity') return;
    const pos = position(event);
    if (event.state === 'start') open = { text: `${pos}${event.label}`, startedAt: now() };
    else if (event.state !== 'progress') open = null;
    switch (event.state) {
      case 'start':
        emit(`${theme.separator('·')} ${startText(event)}`);
        break;
      case 'progress':
        // Append-only: no cursor to rewrite. Indented under the phase's start
        // line so a long interior (a docker build) reads as belonging to it.
        emit(`${theme.separator('  ↳')} ${event.detail ?? ''} ${theme.duration(`(${formatDuration(event.elapsedMs ?? 0)})`)}`);
        break;
      case 'done':
        emit(`${theme.success('✓')} ${pos}${event.label} ${theme.duration(`(${formatDuration(event.elapsedMs ?? 0)})`)}${detailSuffix(event.detail)}`);
        break;
      case 'skipped':
        emit(`${theme.separator('–')} ${pos}${event.label} ${theme.separator('skipped')}${detailSuffix(event.detail)}`);
        break;
      case 'failed':
        emit(`${theme.error('✗')} ${pos}${event.label} ${theme.duration(`(${formatDuration(event.elapsedMs ?? 0)})`)}${detailSuffix(event.detail)}`);
        break;
    }
  };

  /**
   * A daemon liveness tick. Prints "still here, still on this phase" only when
   * the screen has actually gone quiet, so a phase that settles in under a
   * second adds no noise.
   *
   * INVARIANT: driven by the DAEMON's ticks, never by a local timer. The
   * elapsed number is local (it counts the open phase, where the daemon's
   * counts the whole request), but the LINE only exists because the daemon
   * wrote a heartbeat — if the daemon stops, so does this, which is the honest
   * signal. See readHeartbeatEnvelope in ../daemon/heartbeat.ts.
   */
  const onHeartbeat = () => {
    if (!open) return;
    if (now() - lastLineAt < QUIET_PHASE_MS) return;
    emit(`${theme.separator('  ⋯')} ${open.text} ${theme.separator('still running')} ${theme.duration(`(${formatDuration(now() - open.startedAt)})`)}`);
  };

  return { onProgress, onHeartbeat, close() { /* nothing buffered */ } };
}

function createTtyDisplay(write: (s: string) => void): PhaseDisplay {
  let open: { line: string; note?: string; startedAt: number } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const clearLine = () => write('\r\x1b[2K');

  const paint = () => {
    if (!open) return;
    clearLine();
    const note = open.note ? theme.separator(` ↳ ${open.note}`) : '';
    write(`${theme.separator('·')} ${open.line}${note} ${theme.duration(formatDuration(Date.now() - open.startedAt))}`);
  };

  const stopTicker = () => {
    if (timer) { clearInterval(timer); timer = null; }
  };

  /** Erase the in-place line and stop its ticker, leaving the cursor at col 0. */
  const clearOpen = () => {
    stopTicker();
    if (open) clearLine();
    open = null;
  };

  /** Settle the open line (if any) and print `finalLine` on its own row. */
  const settle = (finalLine: string) => {
    clearOpen();
    write(`${finalLine}\n`);
  };

  const onProgress: ProgressEmitter = (event) => {
    if (event.kind === 'plan') {
      settle(planHeader(event));
      return;
    }
    // See the plain display: not a phase, not this renderer's business.
    if (event.kind === 'activity') return;
    const pos = position(event);
    const elapsed = theme.duration(`(${formatDuration(event.elapsedMs ?? 0)})`);
    switch (event.state) {
      case 'start': {
        // A start with a phase already open means the reporter auto-closed the
        // previous one; the settle event for it has already been rendered.
        clearOpen();
        open = { line: startText(event), startedAt: Date.now() };
        paint();
        timer = setInterval(paint, TICK_MS);
        // Never hold the process open for narration.
        (timer as unknown as { unref?: () => void }).unref?.();
        break;
      }
      case 'progress':
        // A note updates the open row in place — the phase has not finished, so
        // it must not settle onto its own line. Ignored when nothing is open:
        // the daemon closed the phase before this note reached us.
        if (open) {
          open.note = event.detail;
          paint();
        }
        break;
      case 'done':
        settle(`${theme.success('✓')} ${pos}${event.label} ${elapsed}${detailSuffix(event.detail)}`);
        break;
      case 'skipped':
        settle(`${theme.separator('–')} ${pos}${event.label} ${theme.separator('skipped')}${detailSuffix(event.detail)}`);
        break;
      case 'failed':
        settle(`${theme.error('✗')} ${pos}${event.label} ${elapsed}${detailSuffix(event.detail)}`);
        break;
    }
  };

  return {
    onProgress,
    // Nothing to do: the in-place line is already repainted every second with a
    // live counter, so this rendering is never silent and a heartbeat has
    // nothing to add. Present so both renderings satisfy the same interface.
    onHeartbeat() { /* the ticker already shows liveness */ },
    close() {
      clearOpen();
    },
  };
}
