/**
 * Timestamped logging for supervisor modules.
 *
 * Uses ISO8601 timestamps matching the daemon's logger format
 * (e.g., "2026-04-03T11:07:49.286Z [INFO ] : [supervisor] ...").
 *
 * In builder mode, call setLogFile() to redirect all output to a file
 * so log messages don't leak into the interactive Claude session.
 *
 * This is a SECOND logger, independent of src/utils/logger.ts — supervisor
 * modules use these functions, not `logger`. It therefore needs its own
 * credential scrub: the one in Logger does not cover a single line written
 * here. See writeLog().
 */

import { appendFileSync } from 'fs';
import { redactSecretValues } from '../utils/redact';
import { logger } from '../utils/logger';

let logFilePath: string | null = null;

/**
 * Distinct write failures already reported for the CURRENT target, so a target
 * that is broken for the rest of the session says so once instead of on every
 * line.
 *
 * Bounded by construction, with no cap and therefore no way to go quiet: the
 * target is fixed for the life of the process (setLogFile clears this set when
 * it changes), and for a fixed path the message an fs write throws is
 * `<ERRNO>: <description>, open '<path>'` — one entry per distinct errno, out of
 * a finite list. A cap would have been the wrong shape here: it would make the
 * FIRST genuinely new failure mode late in a long session the one nobody hears
 * about, which is the silent swallow this whole change exists to remove.
 */
const reportedWriteFailures = new Set<string>();

/** Reset the elapsed timer. Kept for API compatibility — now a no-op. */
export function resetTimer(_isoTimestamp?: string): void {
  // No-op: ISO8601 timestamps don't need a reference point.
}

/**
 * Redirect all log output to a file instead of console.
 *
 * Pass null to send output back to the console. This module's target is global
 * state, so a test that redirects it must be able to put it back — otherwise
 * the redirect outlives the file and later writes land in a deleted temp dir.
 */
export function setLogFile(filePath: string | null): void {
  // A new target is a new failure domain: the previous target's "already
  // reported" entries must not silence the first failure of this one.
  //
  // Only on an actual CHANGE, so the reset means "new target" rather than
  // "someone called the setter". Production calls this once per builder process
  // (src/supervisor/builder.ts), but a re-set to the same path must not
  // re-arm the reporting for a target already known to be broken.
  if (filePath !== logFilePath) {
    reportedWriteFailures.clear();
  }
  logFilePath = filePath;
}

/**
 * Say — once per distinct reason — that supervisor log output is being dropped.
 *
 * Through the CENTRAL logger deliberately: this module's own target is the
 * thing that just failed, so reporting through it would be reporting into the
 * void. `logger` guards its own file write, and its console half does not throw
 * on a broken pipe (measured on Bun 1.4.2: neither `console.error` nor a raw
 * `process.stdout.write` throws once the reader is gone — both are swallowed).
 * The try/catch is therefore defence in depth, not a known path: this function's
 * whole purpose is that the supervisor survives, so it must not depend on
 * another module's current behaviour to deliver that.
 */
function emitReport(message: string): void {
  try {
    logger.error(message);
  } catch {
    // Nothing left that can carry the message. Dropping it is the only option
    // that keeps the supervisor alive, which is the point.
  }
}

function reportWriteFailure(target: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  // Keyed on the target too, not just the reason: the clear in setLogFile and
  // this key each keep a new target's first failure audible on their own, so
  // neither one silently depends on the other still being there.
  const key = `${target}: ${reason}`;
  if (reportedWriteFailures.has(key)) return;
  reportedWriteFailures.add(key);
  emitReport(`[supervisor] log write failed — supervisor log lines are being dropped (${key})`);
}

/**
 * Last line of defence against a credential reaching the supervisor log file or
 * the console — the counterpart of Logger.scrub() for supervisor modules.
 *
 * Real paths in, not hypothetical ones: `[builder] Claude args: …` echoes the
 * whole agent argv under `[session] debug`, and four call sites log a tail of
 * agent or git stderr (`${stderr.slice(-500)}` in maintain.ts, merge.ts and
 * pushback.ts), which can carry an env echo or a remote URL with userinfo. One
 * scrub here covers every level, so no call site has to remember.
 */
function writeLog(level: string, rawMessage: string): void {
  // INVARIANT: writing a log line NEVER throws into the caller.
  //
  // The whole body is guarded, not just the file append: every call site here
  // is a supervisor reporting that something else already went wrong, and
  // several of them sit in a `catch` inside an async callback nobody awaits —
  // so a throw from here becomes an unhandled rejection that kills the
  // supervisor. That is not hypothetical: a builder session died on
  // `appendFileSync` inside the capture timer's own failure handler, taking the
  // interactive session down and destroying the capture error it was recording.
  //
  // A failed write costs one log line; a thrown one costs the session.
  const target = logFilePath;
  try {
    const message = redactSecretValues(rawMessage);
    const timestamp = new Date().toISOString();
    const line = `${timestamp} [${level.padEnd(5)}] : ${message}`;
    if (target) {
      appendFileSync(target, line + '\n');
    } else {
      if (level === 'ERROR') {
        console.error(line);
      } else if (level === 'WARN') {
        console.warn(line);
      } else {
        console.log(line);
      }
    }
  } catch (err) {
    reportWriteFailure(target ?? '<console>', err);
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
