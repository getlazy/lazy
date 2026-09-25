/**
 * Unit tests: a supervisor log write NEVER takes the supervisor down.
 *
 * WHY (the bug this guards): a builder session crashed inside its own failure
 * logger. The stack was writeLog → logError → the capture-failure recorder's
 * `record` → the anonymous capture-timer callback: a 30-second capture tick
 * failed, the supervisor tried to log why, `appendFileSync` threw on the log
 * file, and because that throw happened inside a `catch` in an async callback
 * nobody awaits, it became an unhandled rejection that killed the interactive
 * builder session. The capture error it was in the middle of recording died
 * with it, so the ORIGINAL failure was never seen by anyone.
 *
 * The invariant is therefore not "handle ENOENT" but the broader one: writeLog
 * reports a failed write once through the central logger and returns normally.
 * A dropped log line is a cost worth paying; a dropped session is not.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { log, logError, logWarn, setLogFile } from '../../src/supervisor/log';

describe('supervisor log — unwritable target', () => {
  let dir: string;
  let consoleErrors: string[];
  let realConsoleError: typeof console.error;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-supervisor-logfail-'));
    consoleErrors = [];
    realConsoleError = console.error;
    console.error = (...args: unknown[]) => { consoleErrors.push(args.join(' ')); };
  });

  afterEach(async () => {
    console.error = realConsoleError;
    // Put the module-global target back before the directory goes away, or the
    // redirect outlives the test and later writes land in a deleted temp dir.
    setLogFile(null);
    await rm(dir, { recursive: true, force: true });
  });

  // INVARIANT: a log write never throws into its caller. The crash this
  // reproduces reached the supervisor through exactly this call.
  test('logError does not throw when the log file cannot be written', () => {
    setLogFile(join(dir, 'no-such-dir', 'supervisor.log'));
    expect(() => logError('[builder] Incremental capture failed: 401 Unauthorized')).not.toThrow();
  });

  test('every level survives an unwritable target', () => {
    setLogFile(join(dir, 'no-such-dir', 'supervisor.log'));
    expect(() => { log('info'); logWarn('warn'); logError('error'); }).not.toThrow();
  });

  // A directory in place of the log file is a different errno (EISDIR) than a
  // missing parent (ENOENT); neither may reach the caller.
  test('a directory in place of the log file is survived too', () => {
    setLogFile(dir);
    expect(() => logError('boom')).not.toThrow();
  });

  test('the failure is reported through the central logger, naming path and reason', () => {
    const target = join(dir, 'no-such-dir', 'supervisor.log');
    setLogFile(target);
    logError('[builder] Final capture failed: connection refused');

    const reported = consoleErrors.join('\n');
    expect(reported).toContain('log write failed');
    expect(reported).toContain(target);
    // The errno is the whole diagnostic value: without it the next report is
    // "logging broke" and nobody can act on it.
    expect(reported).toMatch(/ENOENT/);
  });

  // INVARIANT: reported ONCE per distinct reason. A target broken for the rest
  // of the session would otherwise put a line on the human's terminal for every
  // log call the supervisor makes — mid-session console output corrupts Claude
  // Code's TUI, which is why supervisor output goes to a file at all.
  test('a repeating failure is reported once, not per line', () => {
    setLogFile(join(dir, 'no-such-dir', 'supervisor.log'));
    for (let i = 0; i < 20; i++) logError(`capture failed #${i}`);
    expect(consoleErrors.filter(l => l.includes('log write failed'))).toHaveLength(1);
  });

  test('a new target reports its own first failure', () => {
    setLogFile(join(dir, 'gone-a', 'supervisor.log'));
    logError('one');
    setLogFile(join(dir, 'gone-b', 'supervisor.log'));
    logError('two');
    expect(consoleErrors.filter(l => l.includes('log write failed'))).toHaveLength(2);
  });

  // INVARIANT: the reset means "the target changed", not "the setter was
  // called". Re-setting the same broken path must not re-arm reporting for a
  // target already known to be broken — that would put the per-line flood back.
  test('re-setting the SAME target does not re-arm reporting', () => {
    const target = join(dir, 'no-such-dir', 'supervisor.log');
    setLogFile(target);
    logError('one');
    setLogFile(target);
    logError('two');
    expect(consoleErrors.filter(l => l.includes('log write failed'))).toHaveLength(1);
  });

  // INVARIANT: dedupe is per distinct REASON, never a cap on how many are
  // reported. A long session that has already reported one failure mode and
  // then hits a genuinely different one must still say so — the new mode is the
  // informative one, and suppressing it would be the silent swallow this change
  // exists to remove.
  test('a genuinely different failure on the SAME target is reported too', async () => {
    const target = join(dir, 'later', 'supervisor.log');

    setLogFile(target);
    logError('one');                       // parent missing        -> ENOENT

    await mkdir(target, { recursive: true }); // target is now a directory -> EISDIR
    logError('two');

    const reports = consoleErrors.filter(l => l.includes('log write failed'));
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatch(/ENOENT/);
    expect(reports[1]).toMatch(/EISDIR/);
  });

  test('a writable target still logs normally — the guard changes nothing there', async () => {
    const target = join(dir, 'supervisor.log');
    setLogFile(target);
    log('[builder] Starting builder supervisor');

    expect(await readFile(target, 'utf-8')).toContain('[builder] Starting builder supervisor');
    expect(consoleErrors.filter(l => l.includes('log write failed'))).toHaveLength(0);
  });
});
