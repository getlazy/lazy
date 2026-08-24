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
 * Two renderings, chosen by whether stdout is a terminal:
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
import { theme } from './theme';

/** A live phase display; call {@link PhaseDisplay.close} when the op settles. */
export interface PhaseDisplay {
  /** Feed this to the daemon query as its progress sink. */
  onProgress: ProgressEmitter;
  /** Stop the ticker and leave the cursor on a fresh line. */
  close(): void;
}

const TICK_MS = 1000;

/**
 * Build a phase display writing to stdout.
 *
 * `force` overrides TTY detection (tests). When neither a TTY nor forced, the
 * append-only rendering is used.
 */
export function createPhaseDisplay(options?: { tty?: boolean }): PhaseDisplay {
  const tty = options?.tty ?? (process.stdout.isTTY ?? false);
  return tty ? createTtyDisplay() : createPlainDisplay();
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

function createPlainDisplay(): PhaseDisplay {
  const onProgress: ProgressEmitter = (event) => {
    if (event.kind === 'plan') {
      console.log(planHeader(event));
      return;
    }
    // Activity events belong to a live subscription (proxy traffic), not to a
    // phased operation — the subscriber renders those itself. See ../daemon/progress.ts.
    if (event.kind === 'activity') return;
    const pos = position(event);
    switch (event.state) {
      case 'start':
        console.log(`${theme.separator('·')} ${startText(event)}`);
        break;
      case 'done':
        console.log(`${theme.success('✓')} ${pos}${event.label} ${theme.duration(`(${formatDuration(event.elapsedMs ?? 0)})`)}${detailSuffix(event.detail)}`);
        break;
      case 'skipped':
        console.log(`${theme.separator('–')} ${pos}${event.label} ${theme.separator('skipped')}${detailSuffix(event.detail)}`);
        break;
      case 'failed':
        console.log(`${theme.error('✗')} ${pos}${event.label} ${theme.duration(`(${formatDuration(event.elapsedMs ?? 0)})`)}${detailSuffix(event.detail)}`);
        break;
    }
  };
  return { onProgress, close() { /* nothing buffered */ } };
}

function createTtyDisplay(): PhaseDisplay {
  let open: { line: string; startedAt: number } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const write = (s: string) => process.stdout.write(s);
  const clearLine = () => write('\r\x1b[2K');

  const paint = () => {
    if (!open) return;
    clearLine();
    write(`${theme.separator('·')} ${open.line} ${theme.duration(formatDuration(Date.now() - open.startedAt))}`);
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
    close() {
      clearOpen();
    },
  };
}
