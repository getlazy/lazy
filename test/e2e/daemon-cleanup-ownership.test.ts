/**
 * Who is allowed to delete daemon state files, and what "running" is decided from.
 *
 * THE BUG THIS FILE EXISTS FOR
 * ---------------------------
 * `lazy daemon start` was run while a healthy daemon was already up. The start
 * lost (the incumbent held the storage lock) — but before losing it had already
 * unlinked `lazy.pid` and `lazy.sock`, which belonged to the LIVE daemon. Because
 * liveness was then decided from those very files, every subsequent CLI command
 * reported "Daemon is not running." against a daemon that was serving requests
 * fine, and every start attempt failed because the live daemon still held the
 * lock. A unix socket file exists only while its listener holds it, so it could
 * not be restored by hand: the only way out was killing a healthy daemon, which
 * strands every running builder, agent and pair session on a dead proxy address.
 *
 * The three invariants below are each independently sufficient to prevent that,
 * and are asserted separately on purpose — a regression in any one of them is a
 * regression, even if the other two happen to mask it.
 *
 * Isolation notes (see CLAUDE.md): daemon state is redirected with
 * `LAZY_DAEMON_BASE_DIR`, never `HOME`, and config resolution is pinned with
 * `pinConfig` so the in-process daemon cannot adopt lazy's OWN lazy.toml. The
 * `bun test` process deliberately does NOT have `LAZY_TEST=1`, which is what
 * makes `startDaemonServer` really acquire the flock here — the whole subject of
 * this file.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { existsSync, openSync, closeSync, constants } from 'fs';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import {
  cleanupStaleFiles,
  isDaemonRunning,
  checkDaemonHealth,
  probeDaemonLockSync,
  readDaemonLockPid,
  readPid,
  acquireDaemonLock,
  releaseDaemonLock,
  tryFlockNonBlocking,
} from '../../src/daemon/lifecycle';
import { spawn } from '../../src/utils/spawn';
import { inspectDaemonStateFiles } from '../../src/daemon/state-files';
import { getDaemonDir, getPidPath, getSocketPath } from '../../src/daemon/paths';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { pinConfig } from '../helpers/pin-config';
import { DEAD_PID } from '../helpers/dead-pid';

/** How long to wait for the daemon's own state-file repair to run (interval is 5s). */
const REPAIR_TIMEOUT_MS = 20_000;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  pollMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

describe('daemon state-file ownership', () => {
  let ctx: TestContext;
  let daemonBaseDir: string;
  let restoreBaseDir: string | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemon: RunningDaemon | undefined;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    daemonBaseDir = await makeDaemonBaseDir();
    restoreBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = daemonBaseDir;
    restoreConfig = pinConfig(ctx.root);
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop().catch(() => { /* already stopped by the test */ });
      daemon = undefined;
    }
    restoreConfig?.();
    if (restoreBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = restoreBaseDir;
    await removeDaemonBaseDir(daemonBaseDir);
    await ctx.cleanup();
  });

  /**
   * INVARIANT: a process that does not own the daemon directory may not delete
   * the daemon's state files, and a live daemon stays discoverable when one
   * tries. This is the reproduction of the original wedge: `cleanupStaleFiles`
   * is exactly what a losing `lazy daemon start` used to call, unconditionally,
   * before it had proved anything about ownership. It must now refuse — and the
   * incumbent must remain discoverable both in-process and to the real CLI.
   */
  test('a losing start cannot delete the live daemon files, and the CLI still works', async () => {
    daemon = await startDaemonServer({ projectRoot: ctx.root, noWeb: true });

    const pidPath = getPidPath(ctx.root);
    const socketPath = getSocketPath(ctx.root);
    expect(existsSync(pidPath)).toBe(true);
    expect(existsSync(socketPath)).toBe(true);

    // The daemon really holds its lock — otherwise the rest of this test would
    // be asserting on the wrong mechanism (see the LAZY_TEST note in the header).
    expect(probeDaemonLockSync(ctx.root)).toBe('held');
    expect(readDaemonLockPid(ctx.root)).toBe(process.pid);

    // What the losing start does. Refusal is the fix.
    expect(cleanupStaleFiles(ctx.root)).toBe('refused-lock-held');

    expect(existsSync(pidPath)).toBe(true);
    expect(existsSync(socketPath)).toBe(true);
    expect(isDaemonRunning(ctx.root)).toBe(true);

    const health = await checkDaemonHealth(ctx.root);
    expect(health.running).toBe(true);

    // And the observable symptom the human hit: `lazy daemon status` must not
    // claim the daemon is gone.
    const status = await ctx.lazy(['daemon', 'status'], {
      env: { LAZY_DAEMON_BASE_DIR: daemonBaseDir },
    });
    expectSuccess(status);
    expectOutput(status, 'Daemon is running.');
  });

  /**
   * INVARIANT: liveness rests on evidence a losing racer cannot destroy.
   * Deleting the PID and socket files must not make a running daemon look dead,
   * because those files are precisely what the old failure mode removed. The
   * daemon lock is the authoritative signal — it cannot be faked, and it cannot
   * be taken away from its holder.
   */
  test('liveness survives deletion of the PID and socket files', async () => {
    daemon = await startDaemonServer({ projectRoot: ctx.root, noWeb: true });

    await rm(getPidPath(ctx.root), { force: true });
    await rm(getSocketPath(ctx.root), { force: true });

    expect(isDaemonRunning(ctx.root)).toBe(true);

    // And doctor can name the state in these terms rather than "not running".
    const report = await inspectDaemonStateFiles(ctx.root);
    expect(report.lock).toBe('held');
    expect(report.filesDeletedUnderLiveDaemon).toBe(true);
    expect(report.lockPid).toBe(process.pid);
  });

  /**
   * INVARIANT: the state is recoverable without killing a healthy daemon. A
   * socket file cannot be re-created by hand — only its listener can make one —
   * so the daemon repairs its own files, and the CLI can reach it again with no
   * restart and no interrupted agent sessions.
   */
  test('the daemon re-creates its own PID and socket files and answers again', async () => {
    daemon = await startDaemonServer({ projectRoot: ctx.root, noWeb: true });
    const pidPath = getPidPath(ctx.root);
    const socketPath = getSocketPath(ctx.root);

    await rm(pidPath, { force: true });
    await rm(socketPath, { force: true });
    expect(existsSync(socketPath)).toBe(false);

    const repaired = await waitFor(
      () => existsSync(pidPath) && existsSync(socketPath),
      REPAIR_TIMEOUT_MS,
    );
    expect(repaired).toBe(true);
    expect(readPid(ctx.root)).toBe(process.pid);

    const health = await checkDaemonHealth(ctx.root);
    expect(health.running).toBe(true);
  }, REPAIR_TIMEOUT_MS + 15_000);

  /**
   * INVARIANT: the ownership guard must not become a leak. Files left behind by
   * a daemon that really is gone (no lock holder, recorded PID dead) still get
   * removed — otherwise a crashed daemon would leave debris that nothing ever
   * cleans, and the guard would have traded one wedge for another.
   */
  test('genuinely stale files from a dead daemon are still removed', async () => {
    const daemonDir = getDaemonDir(ctx.root);
    await mkdir(daemonDir, { recursive: true });
    await writeFile(join(daemonDir, 'lazy.pid'), String(DEAD_PID));
    await writeFile(join(daemonDir, 'lazy.sock'), 'leftover');

    expect(cleanupStaleFiles(ctx.root)).toBe('removed');
    expect(existsSync(getPidPath(ctx.root))).toBe(false);
    expect(existsSync(getSocketPath(ctx.root))).toBe(false);
  });

  /**
   * INVARIANT: the state-file diagnostic must stay silent whenever the lock
   * cannot testify. A missing PID/socket pair is only evidence of the wedge if a
   * daemon demonstrably OWNS the directory — with no lock file (daemons started
   * under LAZY_TEST=1 skip the lock, and directories predating flock
   * enforcement have none) or a free lock (the daemon really is gone), absent
   * files are ordinary. `lock === 'held'` is load-bearing in that condition: a
   * future refactor to `lock !== 'free'` would make `lazy doctor` cry wolf over
   * every stopped daemon, which is a bad trade for a diagnostic.
   */
  test('the state-file diagnostic stays quiet when the lock cannot testify', async () => {
    const daemonDir = getDaemonDir(ctx.root);
    await mkdir(daemonDir, { recursive: true });

    // No lock file at all, and no PID/socket either.
    expect(probeDaemonLockSync(ctx.root)).toBe('unknown');
    const noLock = await inspectDaemonStateFiles(ctx.root);
    expect(noLock.lock).toBe('unknown');
    expect(noLock.filesDeletedUnderLiveDaemon).toBe(false);

    // A lock file nobody holds — a daemon that has exited.
    await writeFile(join(daemonDir, 'daemon.lock'), String(DEAD_PID));
    expect(probeDaemonLockSync(ctx.root)).toBe('free');
    const freeLock = await inspectDaemonStateFiles(ctx.root);
    expect(freeLock.lock).toBe('free');
    expect(freeLock.filesDeletedUnderLiveDaemon).toBe(false);
  });

  /**
   * INVARIANT: a liveness PROBE must never be mistaken for an incumbent daemon.
   *
   * Probing proves a lock is free by momentarily TAKING it — flock(2) offers no
   * way to ask who holds a lock, so there is no alternative. A single-shot
   * acquire therefore has a window in which a legitimate daemon start is refused
   * by a probe rather than by a daemon, and reports `Another daemon is already
   * running` when none is. That is the same false-liveness-verdict bug this file
   * exists for, pointing the other way, so acquireDaemonLock retries briefly.
   *
   * Driven from the probe side, not by racing the two: THIS process plays the
   * probe and owns the release, so the ordering is guaranteed rather than hoped
   * for. The lock is already held when the child starts, and it is released only
   * after the child has signalled that it is about to acquire — so the child's
   * first attempt provably lands on a held lock, which is exactly the condition
   * that made a single-shot acquire report a phantom daemon. The acquire must
   * therefore be the side that retries; a one-shot acquire fails this test.
   *
   * The acquire has to run in a child because its retry loop uses Bun.sleepSync,
   * which blocks this thread's timers — a same-thread release could never fire.
   */
  test('a start still wins the lock while a liveness probe holds it', async () => {
    const daemonDir = getDaemonDir(ctx.root);
    await mkdir(daemonDir, { recursive: true });

    const lockPath = join(daemonDir, 'daemon.lock');
    const attemptingPath = join(ctx.root, 'child-attempting');
    const acquirerPath = join(ctx.root, 'acquirer.ts');
    const lifecycleModule = join(import.meta.dir, '..', '..', 'src', 'daemon', 'lifecycle.ts');

    // Take the lock the way probeDaemonLockSync does — open the file, flock it,
    // release by closing — and hold it across the child's first attempt.
    const probeFd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR, 0o644);
    let probeFdOpen = true;
    try {
      expect(tryFlockNonBlocking(probeFd)).toBe(true);

      await writeFile(
        acquirerPath,
        [
          `import { writeFileSync } from 'fs';`,
          `import { acquireDaemonLock, releaseDaemonLock } from ${JSON.stringify(lifecycleModule)};`,
          `writeFileSync(${JSON.stringify(attemptingPath)}, 'now');`,
          `const fd = acquireDaemonLock(${JSON.stringify(ctx.root)});`,
          `if (fd === null) { console.error('acquire refused'); process.exit(1); }`,
          `releaseDaemonLock(fd);`,
        ].join('\n'),
      );

      // process.execPath, not 'bun' — the container's PATH does not necessarily
      // resolve the interpreter by name, and the subject here is the lock, not
      // binary discovery.
      //
      // cwd is explicit because startDaemonServer chdir()s into the project
      // root: an earlier test in this file leaves cwd inside a root its own
      // teardown then deletes, and posix_spawn reports an invalid cwd as ENOENT
      // against the BINARY — which reads as "bun is missing" and is thoroughly
      // misleading.
      const acquirer = spawn([process.execPath, 'run', acquirerPath], {
        cwd: ctx.root,
        env: { ...process.env, LAZY_DAEMON_BASE_DIR: daemonBaseDir },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Poll tightly: the child's first acquire attempt follows this marker by
      // microseconds, and we must still be holding the lock when it lands.
      const attempting = await waitFor(() => existsSync(attemptingPath), 10_000, 1);
      expect(attempting).toBe(true);

      // Keep holding well past that first attempt, then release. The hold is a
      // fraction of the acquire's retry budget, so a retrying acquire wins and a
      // single-shot one has already given up.
      await new Promise((r) => setTimeout(r, 40));
      closeSync(probeFd);
      probeFdOpen = false;

      const exitCode = await acquirer.exited;
      if (exitCode !== 0) {
        // Surface the child's own message — a bare exit code here would send the
        // next reader hunting through an empty stderr.
        const stderr = await new Response(acquirer.stderr as ReadableStream).text();
        throw new Error(`acquire lost to a probe (exit ${exitCode}): ${stderr.trim()}`);
      }
    } finally {
      if (probeFdOpen) closeSync(probeFd);
    }
  }, 30_000);

  /**
   * INVARIANT: the retry above must not weaken singleton enforcement, and must
   * actually happen. A real incumbent holds its lock for its whole lifetime, so
   * a second acquire still returns null — it just takes the retry window to say
   * so. The elapsed-time floor is what distinguishes a retrying acquire from a
   * single-shot one; it is a LOWER bound on purpose, so a slow machine cannot
   * make it flake.
   */
  test('a real incumbent still refuses a second acquire, after retrying', async () => {
    daemon = await startDaemonServer({ projectRoot: ctx.root, noWeb: true });

    const startedAt = Date.now();
    expect(acquireDaemonLock(ctx.root)).toBeNull();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
  });
});
