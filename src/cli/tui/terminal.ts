/**
 * Low-level terminal control using ANSI escape codes.
 * Handles alternate screen buffer, cursor positioning, raw mode, and input.
 */

import * as readline from 'readline';
import { ansi } from '../../utils/ansi';

// Re-export ansi for backward compatibility with existing imports
export { ansi };

// ── ANSI stripping ─────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

/**
 * Truncate a string (which may contain ANSI codes) to a given visible width.
 * Preserves ANSI codes but ensures the visible character count doesn't exceed width.
 */
export function truncateVisible(s: string, width: number): string {
  let visible = 0;
  let result = '';
  let inEscape = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\x1b') {
      inEscape = true;
      result += ch;
    } else if (inEscape) {
      result += ch;
      if (ch === 'm') inEscape = false;
    } else {
      if (visible >= width) break;
      result += ch;
      visible++;
    }
  }

  return result + ansi.reset;
}

// ── Terminal size ──────────────────────────────────────────────────────

export function getTerminalSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

// ── Key input types ────────────────────────────────────────────────────

export type KeyPress = {
  name: string;
  ctrl: boolean;
  shift: boolean;
  raw: string;
};

// ── Terminal session ───────────────────────────────────────────────────

export class Terminal {
  private rl: readline.Interface | null = null;
  private keyHandler: ((key: KeyPress) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private wasRaw = false;

  /** Enter TUI mode: alternate screen, hide cursor, raw input. */
  enter(): void {
    process.stdout.write(ansi.altScreenOn + ansi.cursorHide);
    this.wasRaw = process.stdin.isRaw ?? false;

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    readline.emitKeypressEvents(process.stdin);

    process.stdin.on('keypress', this._onKeypress);
    process.stdout.on('resize', this._onResize);
    process.stdin.resume();
  }

  /** Exit TUI mode: restore terminal. */
  exit(): void {
    process.stdin.removeListener('keypress', this._onKeypress);
    process.stdout.removeListener('resize', this._onResize);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(this.wasRaw);
    }

    process.stdout.write(ansi.cursorShow + ansi.altScreenOff);
    process.stdin.pause();
    process.stdin.unref();
  }

  onKey(handler: (key: KeyPress) => void): void {
    this.keyHandler = handler;
  }

  onResize(handler: () => void): void {
    this.resizeHandler = handler;
  }

  /** Write text at a specific position (1-based row/col). */
  writeAt(row: number, col: number, text: string): void {
    process.stdout.write(ansi.moveTo(row, col) + text);
  }

  /** Clear the entire screen and move cursor to top-left. */
  clear(): void {
    process.stdout.write(ansi.clearScreen);
  }

  /** Write raw ANSI to stdout. */
  write(s: string): void {
    process.stdout.write(s);
  }

  private _onKeypress = (_ch: string, key: readline.Key | undefined): void => {
    if (!key) return;
    const kp: KeyPress = {
      name: key.name ?? '',
      ctrl: key.ctrl ?? false,
      shift: key.shift ?? false,
      raw: key.sequence ?? '',
    };
    this.keyHandler?.(kp);
  };

  private _onResize = (): void => {
    this.resizeHandler?.();
  };
}
