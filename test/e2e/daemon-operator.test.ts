/**
 * E2E tests for the operator tools `lazy daemon list` and `lazy daemon
 * kill-stray`.
 *
 * These commands are HOST-WIDE: they enumerate every daemon under the daemon
 * base dir. To keep the test deterministic — and to make sure we never reap a
 * real daemon on the host — every CLI call points `LAZY_DAEMON_BASE_DIR` at a
 * temp dir we fully control (see getDaemonBaseDir's override seam).
 *
 * SLUG / REALPATH GOTCHA: a daemon dir's name (the slug) is lossy, so we can't
 * recover the project root from it — the daemon writes its absolute root to the
 * `root` file at startup. These tests fabricate that file directly. The roots
 * we point at are realpath()'d temp dirs (mirroring setupTestLazy) so a
 * "live-root" daemon's root genuinely exists on disk and is NEVER classified
 * stray, while a "stray" daemon's root is a path we deleted.
 *
 * DEATH-RESILIENT PROCESSES: the "live" daemons here are real `sleep`
 * subprocesses we spawn so the CLI's liveness check (kill -0) and actual
 * SIGTERM/SIGKILL have something real to act on. afterEach kills any survivors
 * so a crashed test run can't leak them — the same pattern daemon-registry.ts
 * applies to test daemons.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, realpath, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes } from '../helpers/assertions';

/** Track sleep subprocesses we spawn so afterEach can reap survivors. */
let liveProcs: { pid: number }[] = [];

/** Spawn a long-lived process we can use as a stand-in daemon PID. */
function spawnLiveProc(): number {
  const proc = Bun.spawn(['sleep', '300'], { stdout: 'ignore', stderr: 'ignore' });
  liveProcs.push(proc);
  return proc.pid;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Fabricate a daemon state dir under `baseDir`. Writes a pidfile and (unless
 * root is null) a root marker. Returns the dir path.
 */
async function fabricateDaemon(
  baseDir: string,
  slug: string,
  opts: { pid: number; root: string | null },
): Promise<string> {
  const dir = join(baseDir, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'lazy.pid'), String(opts.pid));
  if (opts.root !== null) await writeFile(join(dir, 'root'), opts.root);
  return dir;
}

describe('lazy daemon list / kill-stray', () => {
  let ctx: TestContext;
  let baseDir: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    baseDir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-daemon-base-')));
    liveProcs = [];
  });

  afterEach(async () => {
    for (const p of liveProcs) {
      try { process.kill(p.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    liveProcs = [];
    await rm(baseDir, { recursive: true, force: true });
    await ctx.cleanup();
  });

  /** Run a daemon subcommand against the isolated base dir. */
  function lazyDaemon(args: string[]) {
    return ctx.lazy(['daemon', ...args], { env: { LAZY_DAEMON_BASE_DIR: baseDir } });
  }

  test('list reports no daemons when the base dir is empty', async () => {
    const result = await lazyDaemon(['list']);
    expectSuccess(result);
    expectOutput(result, 'No running lazy daemons.');
  });

  test('list shows running daemons, marks strays, and counts orphan dirs', async () => {
    const liveRoot = await realpath(await mkdtemp(join(tmpdir(), 'lazy-live-root-')));
    const goneRoot = await mkdtemp(join(tmpdir(), 'lazy-gone-root-'));
    await rm(goneRoot, { recursive: true, force: true }); // root no longer exists → stray

    const livePid = spawnLiveProc();
    const strayPid = spawnLiveProc();

    await fabricateDaemon(baseDir, 'live-aaaa1111', { pid: livePid, root: liveRoot });
    await fabricateDaemon(baseDir, 'stray-bbbb2222', { pid: strayPid, root: goneRoot });
    // Dead-pid dir: pid that is not alive → orphaned state dir, not "running".
    await fabricateDaemon(baseDir, 'dead-cccc3333', { pid: 2 ** 22, root: '/tmp/does-not-matter' });

    const result = await lazyDaemon(['list']);
    expectSuccess(result);
    // Two running daemons, one of them stray.
    expectOutput(result, 'Running lazy daemons (2, 1 stray):');
    expectOutput(result, String(livePid));
    expectOutput(result, String(strayPid));
    expectOutput(result, liveRoot);
    expectOutput(result, `${goneRoot} (stray — root missing)`);
    // The dead-pid dir is reported as an orphan, not as a running daemon.
    expectOutput(result, '1 orphaned daemon state dir');
    expectOutputExcludes(result, String(2 ** 22));

    await rm(liveRoot, { recursive: true, force: true });
  });

  test('kill-stray reaps only gone-root daemons and never a live-root daemon', async () => {
    const liveRoot = await realpath(await mkdtemp(join(tmpdir(), 'lazy-live-root-')));
    const goneRoot = await mkdtemp(join(tmpdir(), 'lazy-gone-root-'));
    await rm(goneRoot, { recursive: true, force: true });

    const livePid = spawnLiveProc();
    const strayPid = spawnLiveProc();

    const liveDir = await fabricateDaemon(baseDir, 'live-aaaa1111', { pid: livePid, root: liveRoot });
    const strayDir = await fabricateDaemon(baseDir, 'stray-bbbb2222', { pid: strayPid, root: goneRoot });

    const result = await lazyDaemon(['kill-stray', '--yes']);
    expectSuccess(result);
    expectOutput(result, `Killed PID ${strayPid} — ${goneRoot}`);
    expectOutput(result, 'reaped 1 stray daemon');

    // Give the kill a beat to land.
    await new Promise(r => setTimeout(r, 200));

    // INVARIANT: a daemon whose project root STILL exists is never killed
    // (CLAUDE.md principle of least surprise — kill-stray reaps only strays).
    expect(isAlive(livePid)).toBe(true);
    expect(existsSync(liveDir)).toBe(true);

    // The stray was killed and its now-useless state dir removed.
    expect(isAlive(strayPid)).toBe(false);
    expect(existsSync(strayDir)).toBe(false);

    await rm(liveRoot, { recursive: true, force: true });
  });

  test('kill-stray without --yes refuses in a non-interactive context and kills nothing', async () => {
    const goneRoot = await mkdtemp(join(tmpdir(), 'lazy-gone-root-'));
    await rm(goneRoot, { recursive: true, force: true });
    const strayPid = spawnLiveProc();
    const strayDir = await fabricateDaemon(baseDir, 'stray-bbbb2222', { pid: strayPid, root: goneRoot });

    // ctx.lazy pipes no stdin → not a TTY. Without --yes the command must bail.
    const result = await lazyDaemon(['kill-stray']);
    expectFailure(result);
    expect(result.stderr).toContain('Refusing to reap without confirmation');

    // Nothing was touched.
    expect(isAlive(strayPid)).toBe(true);
    expect(existsSync(strayDir)).toBe(true);
  });

  test('kill-stray --prune-dirs removes dead-pid orphan dirs but leaves live ones', async () => {
    const liveRoot = await realpath(await mkdtemp(join(tmpdir(), 'lazy-live-root-')));
    const livePid = spawnLiveProc();
    const liveDir = await fabricateDaemon(baseDir, 'live-aaaa1111', { pid: livePid, root: liveRoot });
    const deadDir = await fabricateDaemon(baseDir, 'dead-cccc3333', { pid: 2 ** 22, root: '/tmp/gone' });

    const result = await lazyDaemon(['kill-stray', '--yes', '--prune-dirs']);
    expectSuccess(result);
    expectOutput(result, `Removed orphaned state dir ${deadDir}`);

    // Dead-pid dir is gone; the live daemon's dir and process are untouched.
    expect(existsSync(deadDir)).toBe(false);
    expect(existsSync(liveDir)).toBe(true);
    expect(isAlive(livePid)).toBe(true);

    await rm(liveRoot, { recursive: true, force: true });
  });

  test('kill-stray reports nothing to do when there are no strays', async () => {
    const liveRoot = await realpath(await mkdtemp(join(tmpdir(), 'lazy-live-root-')));
    const livePid = spawnLiveProc();
    await fabricateDaemon(baseDir, 'live-aaaa1111', { pid: livePid, root: liveRoot });

    const result = await lazyDaemon(['kill-stray', '--yes']);
    expectSuccess(result);
    expectOutput(result, 'No stray daemons to reap.');
    expect(isAlive(livePid)).toBe(true);

    await rm(liveRoot, { recursive: true, force: true });
  });
});
