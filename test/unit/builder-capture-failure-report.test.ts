/**
 * Unit tests: builder conversation capture FAILS LOUD — at the boundary before
 * the session starts, and on the terminal when it ends.
 *
 * WHY (the bug this guards): capture posted to the wrong daemon surface and
 * 401'd on every 30-second tick of every containerized builder session. The
 * failure was real, repeated, and completely invisible: the only place it
 * appeared was a log file inside the container. Hours of lost history looked
 * exactly like a healthy session.
 *
 * The fix has two halves and this file covers the reporting one. The remedy is
 * NOT to silence or rate-limit the log — every occurrence still logs — but to
 * accumulate the distinct reasons and say them out loud once the TUI is gone
 * (printing mid-session would corrupt Claude Code's terminal), plus a preflight
 * that refuses to start a session whose history cannot be saved.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Storage } from '../../src/storage/interface';
import {
  createCaptureFailureRecorder,
  describeError,
  startCaptureMonitor,
  preflightBuilderCapture,
} from '../../src/supervisor/builder';

/**
 * INVARIANT: a capture failure carries the machine detail, not just the prose.
 *
 * These reports are read once, hours later, by someone who cannot reproduce the
 * failure. Bun's refused-connection TypeError says "Unable to connect. Is the
 * computer able to access the url?" and names neither address nor errno — the
 * errno is on `code`. A report built from `err.message` alone is unactionable
 * for the single most likely container failure there is.
 */
describe('describeError', () => {
  test('appends an errno-style code the message omits', () => {
    const err = Object.assign(new TypeError('Unable to connect. Is the computer able to access the url?'), {
      code: 'ConnectionRefused',
    });
    expect(describeError(err)).toContain('ConnectionRefused');
  });

  test('does not repeat a code the message already carries', () => {
    const err = Object.assign(new Error("ENOENT: no such file or directory, open '/x'"), { code: 'ENOENT' });
    expect(describeError(err)).toBe("ENOENT: no such file or directory, open '/x'");
  });

  test('surfaces a wrapped cause', () => {
    const err = new Error('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND host.docker.internal') });
    expect(describeError(err)).toContain('ENOTFOUND host.docker.internal');
  });

  test('a non-Error throw still renders', () => {
    expect(describeError('plain string')).toBe('plain string');
  });
});

describe('createCaptureFailureRecorder', () => {
  // INVARIANT: dedup is for the human-facing SUMMARY only. The log keeps every
  // occurrence — "the log line is noisy" is not a reason to lose the signal.
  test('logs every occurrence but reports each distinct reason once', () => {
    const logged: string[] = [];
    const rec = createCaptureFailureRecorder(m => logged.push(m));

    rec.record('401 Unauthorized');
    rec.record('401 Unauthorized');
    rec.record('401 Unauthorized');
    rec.record('connection refused');

    expect(logged).toHaveLength(4);
    expect(rec.list()).toEqual(['401 Unauthorized', 'connection refused']);
  });

  test('caps the report so a pathological session cannot flood the terminal', () => {
    const rec = createCaptureFailureRecorder(() => {}, 2);
    rec.record('a');
    rec.record('b');
    rec.record('c');
    expect(rec.list().slice(0, 2)).toEqual(['a', 'b']);
  });

  // INVARIANT: the cap TRUNCATES VISIBLY. Messages embed the failing session id,
  // so distinct ones are ordinary — six failing conversations reach the cap on
  // their own. A report that showed the first five and silently dropped the rest
  // would recreate, one layer up, the invisible loss this recorder exists for.
  test('a truncated report says how many it is not showing, and count() counts them', () => {
    const rec = createCaptureFailureRecorder(() => {}, 2);
    rec.record('a');
    rec.record('b');
    rec.record('c');
    rec.record('d');
    rec.record('d');   // a repeat is not a new distinct failure

    expect(rec.list()).toEqual(['a', 'b', expect.stringContaining('2 further distinct capture failures')]);
    expect(rec.count()).toBe(4);
  });

  test('an untruncated report has no notice line, and count() matches', () => {
    const rec = createCaptureFailureRecorder(() => {}, 5);
    rec.record('a');
    rec.record('b');
    expect(rec.list()).toEqual(['a', 'b']);
    expect(rec.count()).toBe(2);
  });

  // INVARIANT: the report is the durable half, so it must not depend on the log
  // write succeeding. A builder session died exactly this way — logFailure threw
  // out of record(), inside the capture timer's catch, killing the supervisor and
  // destroying the capture error it was recording. src/supervisor/log.ts no
  // longer throws; this keeps the guarantee whatever logger a caller injects.
  test('a throwing logger neither escapes record() nor loses the failure', () => {
    const rec = createCaptureFailureRecorder(() => { throw new Error('ENOSPC: no space left on device'); });

    expect(() => rec.record('401 Unauthorized')).not.toThrow();
    expect(rec.list()).toEqual(['401 Unauthorized']);
  });

  test('a clean session reports nothing', () => {
    expect(createCaptureFailureRecorder(() => {}).list()).toEqual([]);
  });

  test('list() returns a copy — a caller cannot mutate the record', () => {
    const rec = createCaptureFailureRecorder(() => {});
    rec.record('x');
    rec.list().push('forged');
    expect(rec.list()).toEqual(['x']);
  });
});

describe('startCaptureMonitor — failures reach the caller', () => {
  let lazyRoot: string;
  let savedScratchDir: string | undefined;

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-capfail-'));
    // Pinned to an empty dir of this test's own: stopping the monitor syncs the
    // scratch dir it resolves, and an inherited LAZY_SCRATCH_DIR (any builder
    // session) points it at a real, non-empty one the stubs cannot serve.
    savedScratchDir = process.env.LAZY_SCRATCH_DIR;
    process.env.LAZY_SCRATCH_DIR = join(lazyRoot, 'scratch');
    await mkdir(process.env.LAZY_SCRATCH_DIR);
  });

  afterEach(async () => {
    if (savedScratchDir === undefined) delete process.env.LAZY_SCRATCH_DIR;
    else process.env.LAZY_SCRATCH_DIR = savedScratchDir;
    await rm(lazyRoot, { recursive: true, force: true });
  });

  // The exact shape of the original bug: storage is unreachable, capture fails,
  // and the session used to end without a word about it.
  test('an unreachable store surfaces through failures() after stop()', async () => {
    const monitor = startCaptureMonitor(
      lazyRoot,
      new Map(),
      async (): Promise<Storage> => { throw new Error('RPC storage failed: 401 {"error":"Unauthorized"}'); },
      'sess-1',
    );

    // stop() must still resolve — a broken capture must not wedge the exit path.
    await monitor.stop();

    const failures = monitor.failures();
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.join('\n')).toContain('401');
  });

  test('a healthy session reports no failures', async () => {
    const stub = { close: async () => {}, listBuilderResumeIntents: async () => [] } as unknown as Storage;
    const monitor = startCaptureMonitor(lazyRoot, new Map(), async () => stub, 'sess-2');
    await monitor.stop();
    expect(monitor.failures()).toEqual([]);
  });
});

describe('preflightBuilderCapture', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-capprefl-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // INVARIANT: throw, never warn. A builder session whose history cannot be
  // saved is not a degraded session to start anyway — the whole point of the
  // builder is that its conversations are its long-term memory, and `lazy
  // upgrade` needs the resume stamp that rides the same storage handle.
  test('an unreachable daemon fails the launch with an actionable error', async () => {
    const cfg = join(dir, 'daemon-mcp.json');
    await writeFile(cfg, JSON.stringify({
      token: 'tok',
      projectRoot: dir,
      taskId: '',
      target: 'http://127.0.0.1:1', // unroutable
    }));

    await expect(preflightBuilderCapture(cfg)).rejects.toThrow(/conversation capture cannot reach the lazy store/);
  });

  test('the error names the config file and explains what a 401 would mean', async () => {
    const cfg = join(dir, 'daemon-mcp.json');
    await writeFile(cfg, JSON.stringify({
      token: 'tok', projectRoot: dir, taskId: '', target: 'http://127.0.0.1:1',
    }));

    // `.then(onOk, onErr)` rather than `.catch()`: the preflight resolves to
    // void, so a bare catch yields `void | Error` and reading `.message` off it
    // is neither type-safe nor a real assertion — a preflight that wrongly
    // SUCCEEDED would fail here on a confusing TypeError instead of on the
    // thing under test. Assert it rejected first, then read the message.
    const err = await preflightBuilderCapture(cfg).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(cfg);
    expect(err!.message).toContain('/builder/storage');
  });

  // INVARIANT: the failure names the TARGET it could not reach. The same
  // handshake failure is what a mid-session capture tick records, and there it
  // is all the human gets — "unable to connect" without an address cannot
  // distinguish an unreachable host.docker.internal from a wrong port.
  test('an unreachable daemon is reported with the address and the errno', async () => {
    const cfg = join(dir, 'daemon-mcp.json');
    await writeFile(cfg, JSON.stringify({
      token: 'tok', projectRoot: dir, taskId: '', target: 'http://127.0.0.1:1',
    }));

    const err = await preflightBuilderCapture(cfg).then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('http://127.0.0.1:1');
    expect(err!.message).toContain('ConnectionRefused');
  });
});
