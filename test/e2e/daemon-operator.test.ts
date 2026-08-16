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
 * DEATH-RESILIENT PROCESSES: the "live" daemons here are real subprocesses we
 * spawn so the CLI's liveness check and actual SIGTERM/SIGKILL have something
 * real to act on. afterEach kills any survivors so a crashed test run can't
 * leak them — the same pattern daemon-registry.ts applies to test daemons.
 *
 * IDENTITY, NOT `kill -0`: a stand-in daemon must hold its dir's `daemon.lock`
 * (spawnFakeDaemon), because the registry no longer believes a pidfile on its
 * own — the OS recycles pids. A plain `sleep` process is now the model of the
 * OPPOSITE case: a months-dead dir whose recorded pid was handed to something
 * unrelated (spawnUnrelatedProc).
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, realpath, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

const FAKE_DAEMON = resolve(__dirname, '../helpers/fake-daemon-driver.ts');

/** Track subprocesses we spawn so afterEach can reap survivors. */
let liveProcs: { pid: number }[] = [];

/**
 * Spawn a stand-in daemon that holds `<dir>/daemon.lock`, the same lifetime
 * lock a real daemon holds. Resolves once the lock is actually held.
 */
async function spawnFakeDaemon(dir: string): Promise<number> {
  await mkdir(dir, { recursive: true });
  const proc = Bun.spawn(['bun', 'run', FAKE_DAEMON, dir], { stdout: 'pipe', stderr: 'pipe' });
  liveProcs.push(proc);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  while (!seen.includes('READY')) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`fake daemon in ${dir} exited before holding the lock: ${seen}`);
    seen += decoder.decode(value);
  }
  reader.releaseLock();
  return proc.pid;
}

/**
 * Spawn a process that is NOT a lazy daemon — the stand-in for a pid the OS
 * recycled after the daemon that recorded it died months ago.
 */
function spawnUnrelatedProc(): number {
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

/**
 * Fabricate a state dir served by a real lock-holding stand-in daemon — a dir
 * that passes identity verification.
 */
async function fabricateLiveDaemon(
  baseDir: string,
  slug: string,
  root: string | null,
): Promise<{ dir: string; pid: number }> {
  const pid = await spawnFakeDaemon(join(baseDir, slug));
  const dir = await fabricateDaemon(baseDir, slug, { pid, root });
  return { dir, pid };
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

    const { pid: livePid } = await fabricateLiveDaemon(baseDir, 'live-aaaa1111', liveRoot);
    const { pid: strayPid } = await fabricateLiveDaemon(baseDir, 'stray-bbbb2222', goneRoot);
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

    const { pid: livePid, dir: liveDir } = await fabricateLiveDaemon(baseDir, 'live-aaaa1111', liveRoot);
    const { pid: strayPid, dir: strayDir } = await fabricateLiveDaemon(baseDir, 'stray-bbbb2222', goneRoot);

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
    const { pid: strayPid, dir: strayDir } = await fabricateLiveDaemon(baseDir, 'stray-bbbb2222', goneRoot);

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
    const { pid: livePid, dir: liveDir } = await fabricateLiveDaemon(baseDir, 'live-aaaa1111', liveRoot);
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

  // INVARIANT: a pid alone never proves a daemon is running — the OS recycles
  // pids. A months-dead state dir whose recorded pid now belongs to an
  // unrelated process must read as an ORPHAN, not as a running daemon. Before
  // identity verification these dirs were immortal: never dead (so
  // --prune-dirs skipped them) and never stray (unknown root is never reaped).
  test('list reports a reused-pid dir as an orphan, not a running daemon', async () => {
    const strangerPid = spawnUnrelatedProc();
    // Pre-v0.19 shape: a live-looking pid and NO root marker.
    await fabricateDaemon(baseDir, 'ancient-dddd4444', { pid: strangerPid, root: null });

    const result = await lazyDaemon(['list']);
    expectSuccess(result);
    expectOutput(result, 'No running lazy daemons.');
    expectOutput(result, '1 orphaned daemon state dir');
    expectOutput(result, 'PID reuse');
    expectOutputExcludes(result, '(unknown root)');
  });

  // INVARIANT: --prune-dirs must be able to reap a reused-pid dir, and must do
  // it WITHOUT signalling the unrelated process that now owns that pid.
  test('kill-stray --prune-dirs removes a reused-pid dir and never touches its process', async () => {
    const strangerPid = spawnUnrelatedProc();
    const ancientDir = await fabricateDaemon(baseDir, 'ancient-dddd4444', { pid: strangerPid, root: null });

    const result = await lazyDaemon(['kill-stray', '--yes', '--prune-dirs']);
    expectSuccess(result);
    expectOutput(result, `Removed orphaned state dir ${ancientDir}`);
    expectOutput(result, 'reaped 0 stray daemons');

    expect(existsSync(ancientDir)).toBe(false);
    // The stranger's process is untouched — we never SIGTERM an unverified pid.
    await new Promise(r => setTimeout(r, 200));
    expect(isAlive(strangerPid)).toBe(true);
  });

  test('kill-stray reports nothing to do when there are no strays', async () => {
    const liveRoot = await realpath(await mkdtemp(join(tmpdir(), 'lazy-live-root-')));
    const { pid: livePid } = await fabricateLiveDaemon(baseDir, 'live-aaaa1111', liveRoot);

    const result = await lazyDaemon(['kill-stray', '--yes']);
    expectSuccess(result);
    expectOutput(result, 'No stray daemons to reap.');
    expect(isAlive(livePid)).toBe(true);

    await rm(liveRoot, { recursive: true, force: true });
  });
});

/**
 * The fabricated dirs above prove the classifier's dead paths. This block
 * proves the live path against a REAL daemon: identity verification must never
 * hide a running daemon from the operator, which would be a far worse failure
 * than the phantoms it removes.
 */
describe('lazy daemon list with a real running daemon', () => {
  let ctx: TestContext;
  let daemonBaseDir: string;
  let prevBaseDir: string | undefined;

  beforeEach(async () => {
    // Set before setupTestLazy so the daemon it starts — and every CLI call
    // afterwards — agrees on a private base dir and never sees (or reports)
    // the developer's real daemons.
    daemonBaseDir = await makeDaemonBaseDir();
    prevBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = daemonBaseDir;
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
    if (prevBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = prevBaseDir;
    await removeDaemonBaseDir(daemonBaseDir);
  });

  // INVARIANT: a genuinely running daemon is always listed. Identity
  // verification tightens what counts as alive; it must never demote a real
  // daemon, which would make `--prune-dirs` delete a live socket and token.
  test('lists the running daemon with its project root', async () => {
    const result = await ctx.lazy(['daemon', 'list']);
    expectSuccess(result);
    expectOutput(result, 'Running lazy daemons (1)');
    expectOutput(result, ctx.root);
    expectOutputExcludes(result, 'orphaned daemon state dir');
  });
});
