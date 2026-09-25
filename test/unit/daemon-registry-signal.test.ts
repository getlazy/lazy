/**
 * Unit tests: the daemon-registry SIGINT/SIGTERM path runs a bounded command-line
 * sweep in-handler, then re-raises — never process.exit(), and never relying on
 * `process.on('exit')` (which does not run on signal death under bun 1.4.0).
 *
 * THE BUG THIS ENCODES
 * --------------------
 * Pre-fix: reapAllTestDaemons() (full /proc scan) in SIGINT, then process.exit(),
 * then exit handler ran the same sweep again — blocking Ctrl-C on busy machines.
 * First fix attempt only did pidfile reaping before re-raise, dropping command-line
 * sweep coverage on interrupt. Correct fix: ONE bounded sweep in the signal
 * handler, then re-raise.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { getPidPath, getDaemonDir } from '../../src/daemon/paths';

const DRIVER = resolve(import.meta.dir, '../helpers/daemon-registry-driver.ts');
const BENCHMARK = resolve(import.meta.dir, '../helpers/daemon-registry-benchmark.ts');
const EXIT_PROBE = resolve(import.meta.dir, '../helpers/daemon-registry-exit-probe.ts');

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

async function waitForReady(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<void> {
  if (proc.stdout == null) {
    throw new Error('expected piped stdout from subprocess driver');
  }
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    if (decoder.decode(value).includes('ready')) {
      reader.releaseLock();
      return;
    }
  }
  reader.releaseLock();
  throw new Error('benchmark subprocess never became ready');
}

describe('daemon-registry signal re-raise', () => {
  // INVARIANT: SIGINT must re-raise (signalCode SIGINT), not swallow the interrupt
  // behind a blocking sweep. Run in a child — re-raising would take the test runner too.
  test('SIGINT re-raises promptly and reaps pidfile-registered daemon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lazy-sigint-'));
    const dummy = Bun.spawn(['sleep', '3600'], { stdout: 'ignore', stderr: 'ignore' });
    await mkdir(getDaemonDir(root), { recursive: true });
    await writeFile(getPidPath(root), String(dummy.pid));

    const proc = Bun.spawn(['bun', 'run', DRIVER, root, 'hang'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await waitForReady(proc);

    const t0 = Date.now();
    proc.kill('SIGINT');
    await proc.exited;
    const elapsed = Date.now() - t0;

    expect(proc.exitCode === 130 || proc.signalCode === 'SIGINT').toBe(true);
    expect(elapsed).toBeLessThan(2000);
    expect(await waitUntilDead(dummy.pid)).toBe(true);

    if (isAlive(dummy.pid)) {
      try { dummy.kill('SIGKILL'); } catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true });
    await rm(getDaemonDir(root), { recursive: true, force: true });
  }, 15_000);

  // INVARIANT: command-line sweep runs on SIGINT, not only pidfile reaping.
  test('SIGINT reaps a pidfile-less disguised daemon via command-line sweep', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lazy-sigint-sweep-'));
    const disguised = Bun.spawn(
      ['bash', '-c', `exec -a "bun /repo/src/index.ts daemon start --foreground --project ${root}" sleep 300`],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    await new Promise(r => setTimeout(r, 300));

    const proc = Bun.spawn(['bun', 'run', DRIVER, root, 'hang'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await waitForReady(proc);

    proc.kill('SIGINT');
    await proc.exited;

    expect(await waitUntilDead(disguised.pid)).toBe(true);
    if (isAlive(disguised.pid)) {
      try { disguised.kill('SIGKILL'); } catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true });
    await rm(getDaemonDir(root), { recursive: true, force: true });
  }, 15_000);

  // INVARIANT: on bun 1.4.0, re-raise does NOT run process.on('exit') handlers.
  test('SIGINT re-raise does not run the exit handler', async () => {
    const marker = join(tmpdir(), `lazy-exit-probe-${process.pid}-${Date.now()}.txt`);
    await rm(marker, { force: true });

    const proc = Bun.spawn(['bun', 'run', EXIT_PROBE, marker], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await waitForReady(proc);
    proc.kill('SIGINT');
    await proc.exited;

    expect(proc.signalCode === 'SIGINT' || proc.exitCode === 130).toBe(true);
    let exists = false;
    try {
      await readFile(marker, 'utf-8');
      exists = true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    expect(exists).toBe(false);
    await rm(marker, { force: true });
  }, 15_000);

  test('second SIGINT while hanging kills the driver without a long delay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lazy-sigint2-'));

    const proc = Bun.spawn(['bun', 'run', DRIVER, root, 'hang'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await waitForReady(proc);

    const t0 = Date.now();
    proc.kill('SIGINT');
    proc.kill('SIGINT');
    await proc.exited;
    const elapsed = Date.now() - t0;

    const interrupted =
      proc.exitCode === 130 ||
      proc.signalCode === 'SIGINT' ||
      proc.exitCode === 137 ||
      proc.signalCode === 'SIGKILL';
    expect(interrupted).toBe(true);
    expect(elapsed).toBeLessThan(2000);

    await rm(root, { recursive: true, force: true });
  }, 15_000);

  // INVARIANT: with artificial per-proc delay, old double-sweep blocks longer than
  // new single bounded sweep. Distinguishes fixed from unfixed in sparse containers.
  test('new SIGINT path is faster than old double-sweep under artificial delay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lazy-sigint-ab-'));
    const delayMs = '15';
    const env = {
      ...process.env,
      LAZY_TEST_REGISTRY_SWEEP_DELAY_MS: delayMs,
      LAZY_TEST_REGISTRY_SKIP_AUTO_INSTALL: '1',
    };

    async function timeMode(mode: 'old' | 'new'): Promise<number> {
      const proc = Bun.spawn(['bun', 'run', BENCHMARK, root, mode], {
        stdout: 'pipe',
        stderr: 'pipe',
        env,
      });
      await waitForReady(proc);
      const t0 = Date.now();
      proc.kill('SIGINT');
      await proc.exited;
      return Date.now() - t0;
    }

    const oldMs = await timeMode('old');
    const newMs = await timeMode('new');

    // Old runs two unbounded sweeps; new runs one bounded sweep (≤2s budget).
    expect(oldMs).toBeGreaterThan(newMs);
    expect(newMs).toBeLessThan(2500);

    await rm(root, { recursive: true, force: true });
  }, 30_000);
});
