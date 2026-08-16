/**
 * Unit-level tests for the daemon registry (src/daemon/registry.ts) — the
 * host-wide enumeration that powers `lazy daemon list/kill-stray`.
 *
 * These run in-process and drive the registry directly via the
 * `LAZY_DAEMON_BASE_DIR` override, so they exercise classification logic
 * (stray vs live-root vs dead vs unknown-root vs reused-pid) without spawning
 * the CLI.
 *
 * A LIVE DAEMON IS NOT JUST A LIVE PID. The registry verifies that the process
 * behind a pidfile really is a lazy daemon, so a stand-in must reproduce one of
 * the signals a real daemon leaves: an flock held on the dir's `daemon.lock`
 * (spawnLockHolder — what acquireDaemonLock does), or a daemon-shaped command
 * line (spawnDisguisedLockHolder). A bare `sleep` is the stand-in for the
 * OPPOSITE case — a pid the OS recycled out from under a dead daemon.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { enumerateDaemons, writeDaemonRoot } from '../../src/daemon/registry';
import { getRootPath, getDaemonDir } from '../../src/daemon/paths';
import { commandLooksLikeDaemon } from '../../src/daemon/process-identity';

const FAKE_DAEMON = resolve(__dirname, '../helpers/fake-daemon-driver.ts');

describe('daemon registry enumeration', () => {
  let baseDir: string;
  let prevBaseDir: string | undefined;
  let procs: { pid: number; kill: (sig?: any) => void }[] = [];

  beforeEach(async () => {
    baseDir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-reg-base-')));
    prevBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = baseDir;
    procs = [];
  });

  afterEach(async () => {
    for (const p of procs) {
      try { process.kill(p.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    procs = [];
    if (prevBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = prevBaseDir;
    await rm(baseDir, { recursive: true, force: true });
  });

  /** Fabricate a state dir: pidfile plus (unless null) a root marker. */
  async function fab(slug: string, pid: number, root: string | null): Promise<string> {
    const dir = join(baseDir, slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'lazy.pid'), String(pid));
    if (root !== null) await writeFile(join(dir, 'root'), root);
    return dir;
  }

  /** Wait for the fake daemon's READY line, i.e. the lock is actually held. */
  async function awaitReady(proc: Bun.Subprocess<any, 'pipe', any>, dir: string): Promise<void> {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('READY')) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`fake daemon in ${dir} exited before locking: ${seen}`);
      seen += decoder.decode(value);
    }
    reader.releaseLock();
  }

  /** A stand-in daemon holding `<dir>/daemon.lock` — identity signal: lock. */
  async function spawnLockHolder(dir: string): Promise<number> {
    await mkdir(dir, { recursive: true });
    const proc = Bun.spawn(['bun', 'run', FAKE_DAEMON, dir], { stdout: 'pipe', stderr: 'ignore' });
    procs.push(proc);
    await awaitReady(proc, dir);
    return proc.pid;
  }

  /**
   * The same stand-in, but with argv rewritten to look like a real daemon
   * launch (`exec -a`). Used to give ONE process both a held lock and a
   * daemon-shaped command line, so two dirs can plausibly claim its pid.
   */
  async function spawnDisguisedLockHolder(dir: string): Promise<number> {
    await mkdir(dir, { recursive: true });
    const proc = Bun.spawn(
      ['bash', '-c', `exec -a "lazy daemon start --foreground" bun run ${FAKE_DAEMON} ${dir}`],
      { stdout: 'pipe', stderr: 'ignore' },
    );
    procs.push(proc);
    await awaitReady(proc, dir);
    return proc.pid;
  }

  /** A process that is NOT a daemon — stands in for a pid the OS recycled. */
  function spawnUnrelated(): number {
    const proc = Bun.spawn(['sleep', '300'], { stdout: 'ignore', stderr: 'ignore' });
    procs.push(proc);
    return proc.pid;
  }

  test('returns [] when the base dir does not exist', async () => {
    await rm(baseDir, { recursive: true, force: true });
    expect(await enumerateDaemons()).toEqual([]);
  });

  test('writeDaemonRoot writes the root marker enumerate reads back', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'lazy-proj-')));
    // The marker lands in the slug dir for this root; the dir must exist first.
    const dir = getDaemonDir(projectRoot);
    await mkdir(dir, { recursive: true });
    await writeDaemonRoot(projectRoot);
    // A real, identity-verifiable daemon so the record counts as running.
    const pid = await spawnLockHolder(dir);
    await writeFile(join(dir, 'lazy.pid'), String(pid));

    const records = await enumerateDaemons();
    const rec = records.find(r => r.projectRoot === projectRoot);
    expect(rec).toBeDefined();
    expect(rec!.alive).toBe(true);
    expect(rec!.rootKnown).toBe(true);
    expect(rec!.rootExists).toBe(true);
    expect(rec!.stray).toBe(false);
    expect(existsSync(getRootPath(projectRoot))).toBe(true);

    await rm(projectRoot, { recursive: true, force: true });
  });

  test('classifies stray, live-root, dead-pid, and unknown-root daemons', async () => {
    const liveRoot = await realpath(await mkdtemp(join(tmpdir(), 'lazy-live-')));
    const goneRoot = await mkdtemp(join(tmpdir(), 'lazy-gone-'));
    await rm(goneRoot, { recursive: true, force: true });

    const livePid = await spawnLockHolder(join(baseDir, 'live-1'));
    const strayPid = await spawnLockHolder(join(baseDir, 'stray-1'));
    const unknownPid = await spawnLockHolder(join(baseDir, 'unknown-1'));

    await fab('live-1', livePid, liveRoot);      // alive + root exists
    await fab('stray-1', strayPid, goneRoot);    // alive + root gone  → stray
    await fab('dead-1', 2 ** 22, '/tmp/whatever'); // dead pid          → not alive
    await fab('unknown-1', unknownPid, null);    // alive + no root file

    const bySlug = Object.fromEntries((await enumerateDaemons()).map(r => [r.slug, r]));

    expect(bySlug['live-1'].alive).toBe(true);
    expect(bySlug['live-1'].identity).toBe('lock');
    expect(bySlug['live-1'].stray).toBe(false);

    expect(bySlug['stray-1'].alive).toBe(true);
    expect(bySlug['stray-1'].stray).toBe(true);

    expect(bySlug['dead-1'].alive).toBe(false);
    expect(bySlug['dead-1'].pidAlive).toBe(false);
    expect(bySlug['dead-1'].identity).toBe('no-process');
    expect(bySlug['dead-1'].stray).toBe(false);

    // INVARIANT: a live daemon with an UNKNOWN root is never classified stray —
    // we can't prove its root is gone, so kill-stray must leave it alone. This
    // survives identity verification: the daemon is verified alive, and an
    // unknown root is still not evidence its project was deleted.
    expect(bySlug['unknown-1'].alive).toBe(true);
    expect(bySlug['unknown-1'].rootKnown).toBe(false);
    expect(bySlug['unknown-1'].stray).toBe(false);

    await rm(liveRoot, { recursive: true, force: true });
  });

  // INVARIANT: liveness is an identity check, not `kill -0`. The OS recycles
  // pids, so a state dir whose recorded pid now names an unrelated process is
  // DEAD — otherwise months-dead dirs stay "running" forever and --prune-dirs
  // can never reach them. This is the bug that showed 11 daemons where one ran.
  test('a dir whose pid was recycled by an unrelated process is dead', async () => {
    const strangerPid = spawnUnrelated();
    await fab('ancient-1', strangerPid, null);

    const [rec] = await enumerateDaemons();
    expect(rec.pid).toBe(strangerPid);
    expect(rec.pidAlive).toBe(true);   // the pid IS alive …
    expect(rec.alive).toBe(false);     // … but it is not a lazy daemon
    expect(rec.identity).toBe('pid-reused');
    expect(rec.stray).toBe(false);     // never stray → never signalled
  });

  // INVARIANT: an unheld daemon.lock is proof no daemon owns that dir, whatever
  // the pidfile says. This is the strongest reuse signal and must outrank a
  // command line that happens to look daemon-ish.
  test('a dir whose daemon.lock is unheld is dead even with a live pid', async () => {
    const strangerPid = spawnUnrelated();
    const dir = await fab('unlocked-1', strangerPid, null);
    // A lock file nobody holds — exactly what a crashed daemon leaves behind.
    await writeFile(join(dir, 'daemon.lock'), String(strangerPid));

    const [rec] = await enumerateDaemons();
    expect(rec.alive).toBe(false);
    expect(rec.identity).toBe('pid-reused');
  });

  // INVARIANT: one pid belongs to one process, so at most one dir claiming it
  // can be a live daemon. The live report showed the same pid listed twice;
  // the weaker claimant must be reclassified dead, not printed as a daemon.
  test('two dirs claiming one pid keep only the strongest claimant', async () => {
    const realDir = join(baseDir, 'real-1');
    const pid = await spawnDisguisedLockHolder(realDir);
    await fab('real-1', pid, null);      // holds the lock       → identity 'lock'
    await fab('impostor-1', pid, null);  // same pid, no lock    → identity 'command'

    const bySlug = Object.fromEntries((await enumerateDaemons()).map(r => [r.slug, r]));

    expect(bySlug['real-1'].alive).toBe(true);
    expect(bySlug['real-1'].identity).toBe('lock');

    expect(bySlug['impostor-1'].alive).toBe(false);
    expect(bySlug['impostor-1'].identity).toBe('duplicate');
  });
});

describe('daemon command-line identity', () => {
  // The daemon is always spawned as `<lazy…> daemon start --foreground
  // --project <root>`, and the `lazy` part can be a binary at any path or
  // `bun run <repo>/src/index.ts` — so the ARGUMENTS carry the signal.
  test('recognizes real daemon command lines', () => {
    expect(commandLooksLikeDaemon('/usr/local/bin/lazy daemon start --foreground --project /p', null)).toBe(true);
    expect(commandLooksLikeDaemon('bun run /repo/src/index.ts daemon start --foreground', null)).toBe(true);
    // The dir's own root in the command line is proof on its own.
    expect(commandLooksLikeDaemon('lazy-0.20 d start --project /home/me/proj', '/home/me/proj')).toBe(true);
  });

  test('rejects unrelated processes that merely mention a daemon', () => {
    expect(commandLooksLikeDaemon('sleep 300', null)).toBe(false);
    expect(commandLooksLikeDaemon('/usr/bin/containerd --config /etc/containerd.toml', null)).toBe(false);
    expect(commandLooksLikeDaemon('tail -f daemon.log', null)).toBe(false);
    // A different project's daemon is a daemon — but not proof for THIS dir's
    // root; the generic rule still matches, which is the conservative side.
    expect(commandLooksLikeDaemon('vim /tmp/notes-about-daemon', '/home/me/proj')).toBe(false);
  });
});
