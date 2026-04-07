/**
 * Timestamped logging for supervisor modules.
 *
 * Uses ISO8601 timestamps matching the daemon's logger format
 * (e.g., "2026-04-03T11:07:49.286Z [INFO ] : [supervisor] ...").
 *
 * In builder mode, call setLogFile() to redirect all output to a file
 * so log messages don't leak into the interactive Claude session.
 */

import { appendFileSync } from 'fs';

let logFilePath: string | null = null;

/** Reset the elapsed timer. Kept for API compatibility — now a no-op. */
export function resetTimer(_isoTimestamp?: string): void {
  // No-op: ISO8601 timestamps don't need a reference point.
}

/** Redirect all log output to a file instead of console. */
export function setLogFile(filePath: string): void {
  logFilePath = filePath;
}

function writeLog(level: string, message: string): void {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} [${level.padEnd(5)}] : ${message}`;
  if (logFilePath) {
    appendFileSync(logFilePath, line + '\n');
  } else {
    if (level === 'ERROR') {
      console.error(line);
    } else if (level === 'WARN') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}

export function log(message: string): void {
  writeLog('INFO', message);
}

export function logError(message: string): void {
  writeLog('ERROR', message);
}

export function logWarn(message: string): void {
  writeLog('WARN', message);
}
