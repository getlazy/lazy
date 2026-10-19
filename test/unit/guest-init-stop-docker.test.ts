/**
 * `lazy-guest-init --stop-docker` — run by Teams before every machine stop.
 *
 * INVARIANT: dockerd is stopped with SIGTERM and the disk is flushed with
 * `sync` before the machine goes down. A `machine stop` under a running dockerd
 * loses what the guest had not written yet, and a layer containerd recorded as
 * committed came back torn ("failed to extract layer … invalid tar header",
 * 2026-10-14/15) — every launch from that image then failed.
 *
 * Drives the real script with a fake dockerd process and fake `sync`, every
 * path redirected through its LAZY_GUEST_* seams.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INIT = join(import.meta.dir, '..', '..', 'src', 'guest', 'lazy-guest-init');

let dir: string;
let bin: string;
let runDir: string;
let logDir: string;
let dockerd: ReturnType<typeof Bun.spawn> | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'guest-init-stop-docker-'));
  bin = join(dir, 'bin');
  runDir = join(dir, 'run');
  logDir = join(dir, 'log');
  for (const d of [bin, runDir, logDir]) await mkdir(d, { recursive: true });
  await writeFile(join(bin, 'sync'), `#!/bin/sh\necho sync >>"${dir}/synced"\n`);
  await chmod(join(bin, 'sync'), 0o755);
  // Never the real pkill: it would signal a containerd on the machine running the tests.
  for (const name of ['pkill', 'pgrep']) {
    await writeFile(join(bin, name), `#!/bin/sh\necho "$0 $*" >>"${dir}/signals"\nexit 1\n`);
    await chmod(join(bin, name), 0o755);
  }
});

afterEach(async () => {
  dockerd?.kill('SIGKILL');
  dockerd = null;
  await rm(dir, { recursive: true, force: true });
});

// Async, so this process keeps reaping the fake dockerd: a sync spawn would
// leave it a zombie, which `kill -0` still finds alive.
async function run() {
  const p = Bun.spawn(['sh', INIT, '--stop-docker'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LAZY_GUEST_RUN_DIR: runDir, LAZY_GUEST_LOG_DIR: logDir },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, exitCode] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { stdout, exitCode };
}

test('stops a running dockerd with SIGTERM, then flushes the disk', async () => {
  // The fake says when its TERM trap is installed: a fixed sleep raced a loaded
  // machine, where the signal could arrive before the trap and kill it silently.
  dockerd = Bun.spawn(['sh', '-c', `trap 'echo term > "${dir}/got"; exit 0' TERM; : > "${dir}/trapped"; while :; do sleep 0.1; done`]);
  await writeFile(join(runDir, 'lazy-dockerd.pid'), String(dockerd.pid));
  for (let i = 0; i < 200 && !(await readFile(join(dir, 'trapped')).then(() => true, () => false)); i++) await Bun.sleep(25);
  const r = await run();
  expect(r.stdout).toContain('docker_stop=stopped');
  expect(await readFile(join(dir, 'got'), 'utf8')).toContain('term');
  expect(await readFile(join(dir, 'synced'), 'utf8')).toContain('sync');
  // Never SIGKILL: no better than the power-off that follows.
  expect(await readFile(join(dir, 'signals'), 'utf8')).not.toMatch(/-9|KILL/);
  // The marker that keeps --ensure from starting dockerd again (tested below).
  expect(await readFile(join(runDir, 'lazy-dockerd.machine-stopping'), 'utf8')).toMatch(/^\d+/);
});

test('with no dockerd running it still flushes the disk', async () => {
  const r = await run();
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('docker_stop=not-running');
  expect(await readFile(join(dir, 'synced'), 'utf8')).toContain('sync');
});

async function ensure() {
  // Root (the script refuses otherwise); any dockerd start is recorded.
  await writeFile(join(bin, 'id'), '#!/bin/sh\necho 0\n');
  await writeFile(join(bin, 'dockerd'), `#!/bin/sh\necho start >>"${dir}/dockerd-starts"\nexit 1\n`);
  for (const name of ['id', 'dockerd']) await chmod(join(bin, name), 0o755);
  const p = Bun.spawn(['sh', INIT, '--ensure', '--timeout', '1'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LAZY_GUEST_RUN_DIR: runDir, LAZY_GUEST_LOG_DIR: logDir },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return stdout;
}

// INVARIANT: once Teams has stopped Docker for a machine stop, nothing in the
// guest starts it again before the power-off — a build or launch's recovery
// and the daemon watchdog both run --ensure, and a dockerd they restarted
// would be running when the machine goes down, which is the damage this stop
// exists to prevent.
test('--ensure after --stop-docker starts no dockerd and records no death', async () => {
  await run();
  const out = await ensure();
  expect(out).toContain('reason=machine-stopping');
  expect(await readFile(join(dir, 'dockerd-starts'), 'utf8').catch(() => '')).toBe('');
  expect(await readFile(join(logDir, 'lazy-dockerd-restarts.log'), 'utf8').catch(() => '')).toBe('');
});

test('a stale machine-stopping marker (a stop that never happened) is dropped', async () => {
  await writeFile(join(runDir, 'lazy-dockerd.machine-stopping'), '1');
  const out = await ensure();
  expect(out).not.toContain('reason=machine-stopping');
  expect(await readFile(join(runDir, 'lazy-dockerd.machine-stopping'), 'utf8').catch(() => 'gone')).toBe('gone');
});

// INVARIANT: an --ensure that was already queued on the guest-init lock when
// the stop began does not start dockerd once it wins the lock. It had passed
// its marker check before the stop wrote the marker, so --stop-docker takes the
// lock too and --ensure reads the marker again after winning it — otherwise the
// queued run restarted dockerd right before the power-off.
test('an --ensure queued on the lock before --stop-docker starts no dockerd', async () => {
  await writeFile(join(bin, 'id'), '#!/bin/sh\necho 0\n');
  await writeFile(join(bin, 'dockerd'), `#!/bin/sh\necho start >>"${dir}/dockerd-starts"\nexit 1\n`);
  for (const name of ['id', 'dockerd']) await chmod(join(bin, name), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LAZY_GUEST_RUN_DIR: runDir, LAZY_GUEST_LOG_DIR: logDir };
  // Someone else holds the lock: the --ensure below queues on it.
  const lock = join(runDir, 'lazy-guest-init.lock');
  await mkdir(lock);
  const queued = Bun.spawn(['sh', INIT, '--ensure', '--timeout', '15'], { env, stdout: 'pipe', stderr: 'pipe' });
  const queuedOut = new Response(queued.stdout).text();
  await Bun.sleep(1500);
  const stop = Bun.spawn(['sh', INIT, '--stop-docker', '--timeout', '15'], { env, stdout: 'pipe', stderr: 'pipe' });
  const stopOut = new Response(stop.stdout).text();
  await Bun.sleep(1000);
  await rm(lock, { recursive: true, force: true });
  await Promise.all([queued.exited, stop.exited]);
  expect(await queuedOut).toContain('reason=machine-stopping');
  expect(await stopOut).toContain('docker_stop=');
  expect(await readFile(join(dir, 'dockerd-starts'), 'utf8').catch(() => '')).toBe('');
}, 30_000);

// INVARIANT: --stop-docker waits for the guest-init lock only within its own
// bound, then stops dockerd regardless. Teams gives the whole exec a fixed
// time; a stop still waiting on a slow or dead lock holder when that runs out
// leaves dockerd running at the power-off.
test('a lock nobody releases delays the stop only by its own bound, and dockerd still gets SIGTERM', async () => {
  dockerd = Bun.spawn(['sh', '-c', `trap 'echo term > "${dir}/got"; exit 0' TERM; : > "${dir}/trapped"; while :; do sleep 0.1; done`]);
  await writeFile(join(runDir, 'lazy-dockerd.pid'), String(dockerd.pid));
  for (let i = 0; i < 200 && !(await readFile(join(dir, 'trapped')).then(() => true, () => false)); i++) await Bun.sleep(25);
  await mkdir(join(runDir, 'lazy-guest-init.lock'));
  const started = Date.now();
  const p = Bun.spawn(['sh', INIT, '--stop-docker', '--timeout', '60'], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LAZY_GUEST_RUN_DIR: runDir, LAZY_GUEST_LOG_DIR: logDir, LAZY_GUEST_STOP_LOCK_WAIT: '2' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(stdout).toContain('docker_stop=stopped');
  expect(await readFile(join(dir, 'got'), 'utf8')).toContain('term');
}, 30_000);
