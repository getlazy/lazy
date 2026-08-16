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
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Storage } from '../../src/storage/interface';
import {
  createCaptureFailureRecorder,
  startCaptureMonitor,
  preflightBuilderCapture,
} from '../../src/supervisor/builder';

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
    expect(rec.list()).toEqual(['a', 'b']);
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

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-capfail-'));
  });

  afterEach(async () => {
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
});
