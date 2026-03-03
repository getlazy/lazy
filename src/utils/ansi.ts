/**
 * ANSI escape code constants for terminal styling.
 * Shared by both TUI components and CLI utilities.
 */

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
