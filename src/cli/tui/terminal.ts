/**
 * Low-level terminal control using ANSI escape codes.
 * Handles alternate screen buffer, cursor positioning, raw mode, and input.
 */

import * as readline from 'readline';

// ── ANSI escape sequences ──────────────────────────────────────────────

const ESC = '\x1b[';

export const ansi = {
  clearScreen: `${ESC}2J${ESC}H`,
  altScreenOn: `${ESC}?1049h`,
  altScreenOff: `${ESC}?1049l`,
  cursorHide: `${ESC}?25l`,
  cursorShow: `${ESC}?25h`,
  moveTo(row: number, col: number): string { return `${ESC}${row};${col}H`; },
  clearLine: `${ESC}2K`,
  clearToEOL: `${ESC}K`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  underline: `${ESC}4m`,
  inverse: `${ESC}7m`,
  reset: `${ESC}0m`,
  fg: {
    black: `${ESC}30m`,
    red: `${ESC}31m`,
    green: `${ESC}32m`,
    yellow: `${ESC}33m`,
    blue: `${ESC}34m`,
    magenta: `${ESC}35m`,
    cyan: `${ESC}36m`,
    white: `${ESC}37m`,
    brightBlack: `${ESC}90m`,
    brightWhite: `${ESC}97m`,
  },
  bg: {
    black: `${ESC}40m`,
    blue: `${ESC}44m`,
    cyan: `${ESC}46m`,
    white: `${ESC}47m`,
    brightBlack: `${ESC}100m`,
  },
};

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
