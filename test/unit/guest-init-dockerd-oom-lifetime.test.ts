/**
 * lazy-guest-init attributes a dockerd death to the OOM killer only when the
 * kernel kill belongs to THAT dockerd instance, not an older process that
 * shares its (reused) pid and name.
 *
 * Same harness as guest-init-dockerd-supervision.test.ts: the real script with
 * fake docker/dockerd/id/ip/dmesg on PATH and its paths redirected to a temp dir.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, readFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { settleDockerdWrapper } from '../helpers/guest-dockerd-wrapper';
import { existsSync } from 'node:fs';

const INIT = join(import.meta.dir, '..', '..', 'src', 'guest', 'lazy-guest-init');

let dir: string;
let bin: string;
let runDir: string;
let logDir: string;
let state: string;

async function fake(name: string, body: string): Promise<void> {
  const p = join(bin, name);
  await writeFile(p, `#!/bin/sh\n${body}\n`);
  await chmod(p, 0o755);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'guest-init-oom-lifetime-'));
  bin = join(dir, 'bin');
  runDir = join(dir, 'run');
  logDir = join(dir, 'log');
  state = join(dir, 'state');
  for (const d of [bin, runDir, logDir, state]) await mkdir(d, { recursive: true });
  await fake('docker', `
case "$1" in
  info) [ -f "${state}/up" ] || exit 1; [ "$2" = "--format" ] && echo overlay2; exit 0 ;;
esac
exit 0`);
  await fake('dockerd', `touch "${state}/up"; exec sleep 3`);
  await fake('id', 'echo 0');
  await fake('ip', 'exit 0');
  await fake('dmesg', `[ -f "${state}/dmesg" ] && cat "${state}/dmesg"; exit 0`);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ensure(): Record<string, string> {
  const result = spawnSyncUnsupervised(['sh', INIT, '--ensure', '--timeout', '5'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      LAZY_GUEST_RUN_DIR: runDir,
      LAZY_GUEST_CGROUP_ROOT: join(dir, "no-cgroup"), // never touch the real /sys/fs/cgroup; the cgroup path has its own tests
      LAZY_GUEST_LOG_DIR: logDir,
      LAZY_GUEST_DOCKER_DATA_ROOT: join(dir, 'docker'),
      LAZY_GUEST_DOCKER_STORAGE_DRIVER: 'overlay2',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  const out: Record<string, string> = {};
  for (const line of result.stdout.toString().split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** Boot dockerd once, then kill it: exit 137 and a dmesg line at `kernelTs`. */
async function dieWith(kernelTs: string, startedAt: string | null): Promise<string> {
  ensure();
  await settleDockerdWrapper(runDir, { kill: true });
  await rm(join(state, 'up'));
  await writeFile(join(runDir, 'lazy-dockerd.exit'), '137\n');
  const pid = (await readFile(join(runDir, 'lazy-dockerd.pid'), 'utf8')).trim();
  const startFile = join(runDir, 'lazy-dockerd.start');
  if (startedAt === null) await rm(startFile, { force: true });
  else await writeFile(startFile, `${startedAt}\n`);
  await writeFile(join(state, 'dmesg'), `[${kernelTs}] Out of memory: Killed process ${pid} (dockerd) total-vm:9kB\n`);
  return ensure().dockerd_died;
}

describe('dockerd OOM attribution is bound to the process instance', () => {
  // /proc/<pid>/stat is Linux-only (the guest is Linux); macOS has no start time to read.
  test.skipIf(!existsSync('/proc/self/stat'))('the launch records the instance start time', async () => {
    ensure();
    await settleDockerdWrapper(runDir, { kill: true });
    const start = (await readFile(join(runDir, 'lazy-dockerd.start'), 'utf8')).trim();
    expect(Number(start)).toBeGreaterThan(0);
  });

  // INVARIANT: a kernel kill older than this dockerd's start belongs to a previous
  // holder of the same pid and name, and is never published as this death's cause.
  test('an old kill of a previous same-pid dockerd is rejected', async () => {
    expect(await dieWith('  100.000000', '5000.00')).toBe('exited-137');
    expect(await readFile(join(logDir, 'lazy-dockerd-restarts.log'), 'utf8')).toContain('NOT matched');
  });

  test('a kill inside this instance lifetime is accepted', async () => {
    expect(await dieWith(' 6000.000000', '5000.00')).toBe('exited-137+oom-killer');
  });

  // INVARIANT: with no start metadata the lifetime cannot be checked, so the
  // evidence stays unconfirmed rather than guessed.
  test('missing start metadata leaves the kill unconfirmed', async () => {
    expect(await dieWith(' 6000.000000', null)).toBe('exited-137');
  });

  test('a kernel line without a timestamp is unconfirmed', async () => {
    ensure();
    await settleDockerdWrapper(runDir, { kill: true });
    await rm(join(state, 'up'));
    await writeFile(join(runDir, 'lazy-dockerd.exit'), '137\n');
    const pid = (await readFile(join(runDir, 'lazy-dockerd.pid'), 'utf8')).trim();
    await writeFile(join(runDir, 'lazy-dockerd.start'), '5000.00\n');
    await writeFile(join(state, 'dmesg'), `Out of memory: Killed process ${pid} (dockerd)\n`);
    expect(ensure().dockerd_died).toBe('exited-137');
  });
});

// INVARIANT: the start time the script records itself (never hand-written) is on
// the same clock and unit as dmesg's stamps, so a kill just after it is confirmed
// and one just before it is not. Guards a ticks-vs-seconds conversion slip.
describe.skipIf(!existsSync('/proc/self/stat'))('the recorded start time is comparable with dmesg stamps', () => {
  async function dieAtOffset(offset: number): Promise<string> {
    ensure();
    await settleDockerdWrapper(runDir, { kill: true });
    const start = Number((await readFile(join(runDir, 'lazy-dockerd.start'), 'utf8')).trim());
    expect(start).toBeGreaterThan(0);
    await rm(join(state, 'up'));
    await writeFile(join(runDir, 'lazy-dockerd.exit'), '137\n');
    const pid = (await readFile(join(runDir, 'lazy-dockerd.pid'), 'utf8')).trim();
    const ts = (start + offset).toFixed(6).padStart(12);
    await writeFile(join(state, 'dmesg'), `[${ts}] Out of memory: Killed process ${pid} (dockerd) total-vm:9kB\n`);
    return ensure().dockerd_died;
  }

  test('a kill just after the real start is confirmed', async () => {
    expect(await dieAtOffset(1)).toBe('exited-137+oom-killer');
  });

  test('a kill just before the real start is not', async () => {
    expect(await dieAtOffset(-1)).toBe('exited-137');
  });
});
