/**
 * Unit tests: the builder capture monitor performs the resume-intent stamp, on
 * BOTH the graceful stop and the signal path.
 *
 * The upgrade-relaunch-resume bug: the stamp used to live after
 * `await proc.exited` in runBuilderSupervisor. A container stop signals the
 * supervisor, whose handler flushes capture and re-raises — it never reaches
 * that line — and `docker kill` did not even signal it. Either way nothing was
 * stamped and the relaunched builder had no session to resume. Hanging the stamp
 * off the monitor's memoized stop() makes both paths converge on one stamp.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import type { Storage } from '../../src/storage/interface';
import { startCaptureMonitor } from '../../src/supervisor/builder';
import { spawn } from '../../src/utils/spawn';

describe('startCaptureMonitor — onFinalSession stamp', () => {
  let lazyRoot: string;
  let basePath: string;
  let opened: Storage[];

  const factory = async (root: string): Promise<Storage> => {
    const s = new FileStorage(root, { basePath });
    await s.initialize();
    opened.push(s);
    return s;
  };

  beforeEach(async () => {
    lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-mon-root-'));
    basePath = await mkdtemp(join(tmpdir(), 'lazy-mon-store-'));
    opened = [];
    const s = new FileStorage(lazyRoot, { basePath });
    await s.initialize();
    await s.close();
  });

  afterEach(async () => {
    await Promise.all([
      rm(lazyRoot, { recursive: true, force: true }),
      rm(basePath, { recursive: true, force: true }),
    ]);
  });

  test('stop() invokes onFinalSession with the detected id and a LIVE storage', async () => {
    const seen: { sessionId: string; usable: boolean }[] = [];
    const monitor = startCaptureMonitor(
      lazyRoot, new Map(), factory, 'sess-1',
      async (storage, sessionId) => {
        // INVARIANT: the callback receives the monitor's own open handle and must
        // NOT close it. Reopening/closing storage here double-closed the handle
        // the monitor still needed for its own teardown.
        const intents = await storage.listBuilderResumeIntents();
        seen.push({ sessionId, usable: Array.isArray(intents) });
      },
    );

    expect(await monitor.stop()).toBe('sess-1');
    expect(seen).toEqual([{ sessionId: 'sess-1', usable: true }]);
  });

  // INVARIANT: a REAL SIGTERM must stamp. This is the exact path `lazy upgrade`
  // now takes (docker stop → SIGTERM → the supervisor's handler → re-raise). If
  // this regresses, an upgraded builder silently comes back into a brand-new
  // conversation.
  //
  // Run in a child process, not in-process: the handler re-raises the signal to
  // die with the conventional exit status, which would take the test runner with
  // it. A child also exercises the real teardown (the stamp must complete BEFORE
  // the re-raise), which an in-process stub of process.kill could not prove.
  test('a real SIGTERM stamps the resume intent before the process dies', async () => {
    const storage = new FileStorage(lazyRoot, { basePath });
    await storage.initialize();
    await storage.saveBuilderResumeIntent({
      builderId: 'bldr1',
      projectRoot: lazyRoot,
      createdAt: new Date().toISOString(),
    });
    await storage.close();

    const scriptPath = join(lazyRoot, 'sigterm-monitor.ts');
    const repoRoot = resolve(import.meta.dir, '../..');
    await writeFile(scriptPath, `
      import { FileStorage } from ${JSON.stringify(join(repoRoot, 'src/storage/index.ts'))};
      import { startCaptureMonitor, stampSessionIdOnStorage }
        from ${JSON.stringify(join(repoRoot, 'src/supervisor/builder.ts'))};

      const lazyRoot = ${JSON.stringify(lazyRoot)};
      const basePath = ${JSON.stringify(basePath)};

      startCaptureMonitor(
        lazyRoot,
        new Map(),
        async (root: string) => {
          const s = new FileStorage(root, { basePath });
          await s.initialize();
          return s;
        },
        'sess-from-signal',
        (s, sessionId) => stampSessionIdOnStorage(s, 'bldr1', lazyRoot, sessionId),
      );

      console.log('ready');
      // Stay alive like the supervisor waiting on its Claude child.
      setInterval(() => {}, 1000);
    `);

    const proc = spawn(['bun', 'run', scriptPath], { stdout: 'pipe', stderr: 'ignore' });
    // Wait for the monitor's signal handlers to be installed.
    const reader = proc.stdout.getReader();
    await reader.read();
    reader.releaseLock();

    proc.kill('SIGTERM');
    await proc.exited;

    const verify = new FileStorage(lazyRoot, { basePath });
    await verify.initialize();
    const intent = await verify.takeBuilderResumeIntent('bldr1');
    await verify.close();
    expect(intent?.sessionId).toBe('sess-from-signal');
  }, 30_000);

  test('no callback → stop() still returns the detected id', async () => {
    const monitor = startCaptureMonitor(lazyRoot, new Map(), factory, 'sess-2');
    expect(await monitor.stop()).toBe('sess-2');
  });

  // The stamp is best-effort: a failure must not break the exit path or lose the
  // conversation capture that already succeeded.
  test('a throwing callback does not fail stop()', async () => {
    const monitor = startCaptureMonitor(
      lazyRoot, new Map(), factory, 'sess-3',
      async () => { throw new Error('storage exploded'); },
    );
    expect(await monitor.stop()).toBe('sess-3');
  });
});
