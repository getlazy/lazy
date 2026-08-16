/**
 * Regression tests for the stray-daemon safety net (test/helpers/daemon-registry.ts).
 *
 * INVARIANT: a daemon spawned by the e2e suite must be reaped even when the test
 * process dies WITHOUT running afterEach. Detached test daemons do not die with
 * the test process, so a teardown that depends only on afterEach leaks them on
 * Ctrl-C / crash / kill. This is the bug that left 100+ orphan daemons squatting
 * the 26024–26123 web-port window. The net reaps registered roots from
 * process-level exit/SIGINT/SIGTERM handlers; these tests assert it does.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { getPidPath, getDaemonDir } from '../../src/daemon/paths';
import { isDaemonCommandForRoot, killDaemonsForRoot } from '../helpers/daemon-registry';

const DRIVER = resolve(__dirname, '../helpers/daemon-registry-driver.ts');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

describe('daemon-registry safety net', () => {
  let root: string;
  let dummy: ReturnType<typeof Bun.spawn> | null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-e2e-registry-'));
    // Stand in for a real daemon: a long-lived process whose pid is recorded in
    // the root's daemon pidfile, exactly where readPid/the reaper look for it.
    dummy = Bun.spawn(['sleep', '3600'], { stdout: 'ignore', stderr: 'ignore' });
    await mkdir(getDaemonDir(root), { recursive: true });
    await writeFile(getPidPath(root), String(dummy.pid));
  });

  afterEach(async () => {
    if (dummy && isAlive(dummy.pid)) {
      try { dummy.kill('SIGKILL'); } catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true });
    await rm(getDaemonDir(root), { recursive: true, force: true });
  });

  // INVARIANT: normal process exit (no afterEach) still reaps the daemon.
  test('reaps registered daemon on normal exit', async () => {
    const proc = Bun.spawn(['bun', 'run', DRIVER, root, 'exit'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;

    expect(await waitUntilDead(dummy!.pid)).toBe(true);
  });

  // INVARIANT: Ctrl-C (SIGINT) — the common local-iteration interrupt that
  // skips afterEach — still reaps the daemon, and the driver exits 130.
  test('reaps registered daemon on SIGINT', async () => {
    const proc = Bun.spawn(['bun', 'run', DRIVER, root, 'hang'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Wait for the driver to register the root and signal readiness.
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 5000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      if (decoder.decode(value).includes('ready')) ready = true;
    }
    reader.releaseLock();
    expect(ready).toBe(true);

    proc.kill('SIGINT');
    await proc.exited;

    expect(await waitUntilDead(dummy!.pid)).toBe(true);
    expect(proc.exitCode).toBe(130);
  });
});

/**
 * The pidfile is not the only way a test daemon can hide. A straggler CLI
 * subprocess can auto-start a fresh daemon for a root AFTER that root's
 * cleanup() already deleted the daemon dir — the resulting daemon has no
 * pidfile the harness can find, and no reaper keyed on one will ever see it.
 * The command-line sweep is what catches it.
 */
describe('daemon-registry command-line sweep', () => {
  let root: string;
  let disguised: ReturnType<typeof Bun.spawn> | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-e2e-sweep-'));
  });

  afterEach(async () => {
    if (disguised && isAlive(disguised.pid)) {
      try { disguised.kill('SIGKILL'); } catch { /* already gone */ }
    }
    disguised = null;
    await rm(root, { recursive: true, force: true });
    await rm(getDaemonDir(root), { recursive: true, force: true });
  });

  test('matches only a daemon command line naming this exact root', () => {
    const cmd = `bun /repo/src/index.ts daemon start --foreground --project ${root}`;
    expect(isDaemonCommandForRoot(cmd, root)).toBe(true);
    // A sibling temp root must never match — a substring test would let one
    // test's teardown kill another test's daemon.
    expect(isDaemonCommandForRoot(cmd, `${root}-other`)).toBe(false);
    expect(isDaemonCommandForRoot(`${cmd}x`, root)).toBe(false);
    // Not a daemon at all — a plain CLI call that merely names the same root
    // must survive the sweep, even though the root appears in its argv.
    expect(isDaemonCommandForRoot(`bun run src/index.ts list --project ${root}`, root)).toBe(false);
    // A daemon SUBCOMMAND is not a running daemon either.
    expect(isDaemonCommandForRoot(`bun run src/index.ts daemon status --project ${root}`, root)).toBe(false);
  });

  // INVARIANT: a daemon with NO pidfile is still reaped, by command line.
  test('kills a pidfile-less daemon for the root', async () => {
    // A process whose argv looks exactly like a daemon serving `root`. `exec -a`
    // is how the enum suite fabricates the same signal (see
    // daemon-registry-enum.test.ts) — no real daemon needed to prove the match.
    disguised = Bun.spawn(
      ['bash', '-c', `exec -a "bun /repo/src/index.ts daemon start --foreground --project ${root}" sleep 300`],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    // Give the exec a moment to replace bash's argv.
    await new Promise(r => setTimeout(r, 300));

    const killed = killDaemonsForRoot(root);
    expect(killed).toContain(disguised.pid);
    expect(await waitUntilDead(disguised.pid)).toBe(true);
  });

  test('leaves processes for other roots alone', async () => {
    disguised = Bun.spawn(
      ['bash', '-c', `exec -a "bun /repo/src/index.ts daemon start --foreground --project ${root}" sleep 300`],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    await new Promise(r => setTimeout(r, 300));

    const killed = killDaemonsForRoot(`${root}-someone-elses-run`);
    expect(killed).toEqual([]);
    expect(isAlive(disguised.pid)).toBe(true);
  });
});
