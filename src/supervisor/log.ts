/**
 * Timestamped console logging for supervisor modules.
 *
 * Shows elapsed time since the turn started (MM:SS) so that
 * `lazy wait --follow` output conveys how long each phase takes.
 * Call resetTimer() at the start of each turn.
 *
 * In builder mode, call setLogFile() to redirect all output to a file
 * so log messages don't leak into the interactive Claude session.
 */

import { appendFileSync } from 'fs';

let startTime = Date.now();
let logFilePath: string | null = null;

/** Reset the elapsed timer to a given ISO timestamp, or now if omitted. */
export function resetTimer(isoTimestamp?: string): void {
  startTime = isoTimestamp ? new Date(isoTimestamp).getTime() : Date.now();
}

/** Redirect all log output to a file instead of console. */
export function setLogFile(filePath: string): void {
  logFilePath = filePath;
}

function ts(): string {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  return `[${m}:${s}]`;
}

export function log(message: string): void {
  const line = `${ts()} ${message}`;
  if (logFilePath) {
    appendFileSync(logFilePath, line + '\n');
  } else {
    console.log(line);
  }
}

export function logError(message: string): void {
  const line = `${ts()} ${message}`;
  if (logFilePath) {
    appendFileSync(logFilePath, line + '\n');
  } else {
    console.error(line);
  }
}

export function logWarn(message: string): void {
  const line = `${ts()} ${message}`;
  if (logFilePath) {
    appendFileSync(logFilePath, line + '\n');
  } else {
    console.warn(line);
  }
}
