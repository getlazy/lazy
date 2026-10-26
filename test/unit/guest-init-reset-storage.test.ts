/**
 * lazy-guest-init --reset-storage: the safe form of `rm -rf /storage/docker/*`.
 *
 * INVARIANT: a reset never removes a single file while a mount remains under the
 * data-root. A killed dockerd leaves its overlay `merged` mounts in place; a plain
 * rm met hundreds of "Read-only file system" errors and left the store half
 * deleted. The reset unmounts deepest-first (lazy fallback), refuses to remove
 * anything if a mount survives, and always starts dockerd again.
 *
 * Drives the real script with fake docker/dockerd/umount/pkill/pgrep on PATH and a
 * mount-table seam (LAZY_GUEST_MOUNTS_FILE) that the fake umount edits.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, readFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

const INIT = join(import.meta.dir, '..', '..', 'src', 'guest', 'lazy-guest-init');

let dir: string, bin: string, runDir: string, logDir: string, state: string, dataRoot: string, mounts: string;

async function fake(name: string, body: string): Promise<void> {
  await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
  await chmod(join(bin, name), 0o755);
}

async function fakeDockerd(beforeReady = ''): Promise<void> {
  // Keep the fake alive until a readiness probe succeeds. Exiting immediately
  // raced a probe that saw "not ready": guest-init then saw the exit record
  // and correctly stopped waiting. Directory removal also releases it if a
  // test fails before probing readiness, so teardown cannot leave it running.
  await fake('dockerd', `echo start >>"${state}/starts"
${beforeReady}
touch "${state}/up"
while [ -d "${state}" ] && [ ! -f "${state}/ready-observed" ]; do sleep 0.01; done`);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'guest-init-reset-'));
  bin = join(dir, 'bin'); runDir = join(dir, 'run'); logDir = join(dir, 'log'); state = join(dir, 'state');
  dataRoot = join(dir, 'docker'); mounts = join(dir, 'mounts');
  for (const d of [bin, runDir, logDir, state, join(dataRoot, 'overlay2', 'a', 'merged'), join(dataRoot, 'volumes')]) await mkdir(d, { recursive: true });
  await writeFile(join(dataRoot, 'overlay2', 'a', 'merged', 'file'), 'x');
  await writeFile(join(dataRoot, 'volumes', 'v'), 'x');
  await writeFile(mounts, [
    `/dev/vda ${dir} ext4 rw 0 0`,
    `overlay ${dataRoot}/overlay2/a/merged overlay rw 0 0`,
    `overlay ${dataRoot}/overlay2/b/merged overlay rw 0 0`,
    `tmpfs ${dataRoot}/overlay2/b/merged/nested tmpfs rw 0 0`,
    `other /elsewhere tmpfs rw 0 0`,
  ].join('\n') + '\n');
  // The fake umount records the call and removes the mount from the table,
  // unless told it is "busy" (then only -l works) or "stuck" (nothing works).
  await fake('umount', `
echo "$*" >>"${state}/umounts"
lazy=""; [ "$1" = "-l" ] && { lazy=1; shift; }
[ -f "${state}/stuck" ] && exit 1
[ -f "${state}/busy" ] && [ -z "$lazy" ] && exit 1
grep -vF " $1 " "${mounts}" >"${mounts}.new"; mv "${mounts}.new" "${mounts}"`);
  await fake('pkill', `echo "$*" >>"${state}/pkills"; exit 0`);
  await fake('pgrep', 'exit 1');
  await fake('docker', `case "$1" in ps) [ -f "${state}/containers" ] && echo abc123; exit 0;; kill) echo "$*" >>"${state}/kills"; exit 0;; info) [ -f "${state}/up" ] || exit 1; touch "${state}/ready-observed"; [ "$2" = "--format" ] && echo overlay2; exit 0;; esac; exit 0`);
  await fakeDockerd();
  await fake('id', 'echo 0');
  await fake('ip', 'exit 0');
  await fake('dmesg', 'exit 0');
});

afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function run(mode: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSyncUnsupervised(['sh', INIT, mode, '--timeout', '5'], {
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`,
      LAZY_GUEST_RUN_DIR: runDir, LAZY_GUEST_LOG_DIR: logDir,
      LAZY_GUEST_CGROUP_ROOT: join(dir, 'no-cgroup'),
      LAZY_GUEST_DOCKER_DATA_ROOT: dataRoot, LAZY_GUEST_DOCKER_STORAGE_DRIVER: 'overlay2',
      LAZY_GUEST_OVERLAY_PARAMS_DIR: join(dir, 'overlay-params'),
      LAZY_GUEST_MOUNTS_FILE: mounts, LAZY_GUEST_STORAGE_ROOT: join(dir, 'nostorage'),
      ...extraEnv,
    },
    stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
  const out: Record<string, string> = {};
  const steps: string[] = [];
  for (const line of r.stdout.toString().split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq);
    if (k === 'reset_step') steps.push(line.slice(eq + 1)); else out[k] = line.slice(eq + 1);
  }
  return { code: r.exitCode, out, steps, stderr: r.stderr.toString() };
}

describe('lazy-guest-init --reset-storage', () => {
  test('unmounts deepest first, empties the data-root, restarts dockerd and narrates in order', async () => {
    const r = run('--reset-storage');
    expect(r.code).toBe(0);
    expect(r.out.source).toBe('reset-storage');
    expect(r.out.reset_result).toBe('done');
    const umounts = (await readFile(join(state, 'umounts'), 'utf8')).trim().split('\n');
    expect(umounts[0]).toBe(`${dataRoot}/overlay2/b/merged/nested`);
    expect(umounts).toHaveLength(3);
    expect(existsSync(join(dataRoot, 'overlay2'))).toBe(false);
    expect(existsSync(join(dataRoot, 'volumes'))).toBe(false);
    expect(existsSync(dataRoot)).toBe(true); // the directory itself stays
    expect(await readFile(join(state, 'starts'), 'utf8')).toContain('start');
    expect(r.steps[0]).toMatch(/Stopping dockerd and containerd/);
    expect(r.steps.some(s => /Unmounting 3 mount/.test(s))).toBe(true);
    expect(r.steps.findIndex(s => /Unmounting/.test(s))).toBeLessThan(r.steps.findIndex(s => /Removing/.test(s)));
    expect(r.steps.at(-1)).toMatch(/Starting dockerd on an empty store/);
    // Taken out of the way of the lock/marker afterwards.
    expect(existsSync(join(runDir, 'lazy-dockerd.reset-in-progress'))).toBe(false);
    expect(existsSync(join(runDir, 'lazy-guest-init.lock'))).toBe(false);
    expect(await readFile(join(logDir, 'lazy-dockerd-restarts.log'), 'utf8')).toContain('resetting docker storage');
  });

  test('a busy mount is detached lazily and said so', async () => {
    await writeFile(join(state, 'busy'), '');
    const r = run('--reset-storage');
    expect(r.out.reset_result).toBe('done');
    expect(r.steps.some(s => /3 mount\(s\) were busy and were detached lazily/.test(s))).toBe(true);
    expect(existsSync(join(dataRoot, 'overlay2'))).toBe(false);
  });

  // INVARIANT: nothing is removed while a mount remains under the data-root.
  test('a mount that will not go leaves every file in place, still starts dockerd, and fails', async () => {
    await writeFile(join(state, 'stuck'), '');
    const r = run('--reset-storage');
    expect(r.code).toBe(1);
    expect(r.out.reset_result).toBe('failed');
    expect(r.out.reset_reason).toBe('reset-unmount-failed');
    expect(existsSync(join(dataRoot, 'volumes', 'v'))).toBe(true);
    expect(existsSync(join(dataRoot, 'overlay2', 'a', 'merged', 'file'))).toBe(true);
    expect(r.out.ready).toBe('yes'); // dockerd was started again
    expect(r.steps.at(-1)).toMatch(/Starting dockerd again regardless/);
  });

  test('refuses a data-root that is not a directory named docker', async () => {
    const odd = join(dir, 'precious');
    await mkdir(odd);
    await writeFile(join(odd, 'keep'), 'x');
    const r = run('--reset-storage', { LAZY_GUEST_DOCKER_DATA_ROOT: odd });
    expect(r.code).toBe(1);
    expect(r.out.reason).toBe('reset-refused-data-root');
    expect(existsSync(join(odd, 'keep'))).toBe(true);
    expect(existsSync(join(state, 'umounts'))).toBe(false);
  });

  // INVARIANT: a `lazy` call's --ensure must not start dockerd against a store being removed.
  test('an --ensure during a live reset answers docker-storage-reset-running and starts nothing', async () => {
    await writeFile(join(runDir, 'lazy-dockerd.reset-in-progress'), `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
    const r = run('--ensure');
    expect(r.code).toBe(1);
    expect(r.out.reason).toBe('docker-storage-reset-running');
    expect(existsSync(join(state, 'starts'))).toBe(false);
  });

  test('a reset marker whose process is gone is ignored', async () => {
    await writeFile(join(runDir, 'lazy-dockerd.reset-in-progress'), `2147483000 ${Math.floor(Date.now() / 1000)}\n`);
    const r = run('--ensure');
    expect(r.code).toBe(0);
    expect(r.out.source).toBe('started-dockerd');
  });

  // INVARIANT: a failed readiness probe is not a daemon exit. A live daemon
  // becoming ready during that probe must still get its next readiness check.
  test('a dead reset marker is ignored when dockerd becomes ready during a failed probe', async () => {
    await writeFile(join(runDir, 'lazy-dockerd.reset-in-progress'), `2147483000 ${Math.floor(Date.now() / 1000)}\n`);
    // Force the first post-launch probe to see "not ready", then let dockerd
    // become ready before that probe returns. No scheduler timing is assumed.
    await fakeDockerd(`while [ -d "${state}" ] && [ ! -f "${state}/probe" ]; do sleep 0.01; done`);
    await fake('docker', `
[ "$1" = info ] || exit 0
if [ -f "${state}/up" ]; then
  touch "${state}/ready-observed"
  [ "$2" = --format ] && echo overlay2
  exit 0
fi
if [ -f "${runDir}/lazy-dockerd.pid" ]; then
  touch "${state}/probe"
  while [ -d "${state}" ] && [ ! -f "${state}/up" ]; do sleep 0.01; done
fi
exit 1`);
    const r = run('--ensure');
    expect(r.code).toBe(0);
    expect(r.out.source).toBe('started-dockerd');
    expect(existsSync(join(state, 'probe'))).toBe(true);
  });

  // INVARIANT: the removal cannot cross a mount point even if one were missed.
  test('removes with --one-file-system', async () => {
    expect(await readFile(INIT, 'utf8')).toContain('rm -rf --one-file-system');
  });
});

describe('lazy-guest-init --reset-storage: containers and a failed stop', () => {
  // INVARIANT: running containers are killed before dockerd and the shims are, because a killed shim leaves the container's processes (and their mounts and memory) running.
  test('kills running containers while dockerd can still name them', async () => {
    await writeFile(join(state, 'containers'), '');
    const r = run('--reset-storage');
    expect(r.out.reset_result).toBe('done');
    expect(await readFile(join(state, 'kills'), 'utf8')).toContain('kill abc123');
  });

  test('a dockerd that will not stop leaves the store alone, and is reported failed (exit 1)', async () => {
    await fake('pgrep', 'exit 0'); // dockerd "still running" after every kill
    const r = run('--reset-storage');
    expect(r.code).toBe(1);
    expect(r.out.reset_result).toBe('failed');
    expect(r.out.reset_reason).toBe('reset-stop-failed');
    expect(existsSync(join(dataRoot, 'volumes', 'v'))).toBe(true);
  }, 30_000);
});

// INVARIANT: the reset and the one-time cache prune work on the containerd image
// store, whose snapshots and container root filesystems also live under the
// data-root (containerd/daemon/io.containerd.snapshotter.v1.overlayfs/…, and
// rootfs/overlayfs/<container> while a container runs). A dockerd SIGKILLed with
// containers up leaves those mounted; the reset must take them down before it
// removes anything, exactly as it does overlay2's.
describe('lazy-guest-init --reset-storage on the containerd image store', () => {
  test('unmounts snapshot and container-rootfs mounts, empties the store, and records no prune', async () => {
    const snap = `${dataRoot}/containerd/daemon/io.containerd.snapshotter.v1.overlayfs/snapshots/7/fs`;
    const rootfs = `${dataRoot}/rootfs/overlayfs/abc123`;
    for (const d of [snap, rootfs, `${dataRoot}/buildkit`]) await mkdir(d, { recursive: true });
    await writeFile(join(snap, 'layer-file'), 'x');
    await writeFile(mounts, [
      `/dev/vda ${dir} ext4 rw 0 0`,
      `overlay ${rootfs} overlay rw 0 0`,
      `shm ${dataRoot}/containers/abc123/mounts/shm tmpfs rw 0 0`,
    ].join('\n') + '\n');
    await mkdir(join(dir, 'overlay-params'), { recursive: true });
    const r = run('--reset-storage', { LAZY_GUEST_DOCKER_STORAGE_DRIVER: 'overlayfs' });
    expect(r.code).toBe(0);
    expect(r.out.reset_result).toBe('done');
    expect(r.out.image_store).toBe('containerd');
    expect(r.steps.some(s => /Unmounting 2 mount/.test(s))).toBe(true);
    expect(existsSync(join(dataRoot, 'containerd'))).toBe(false);
    expect(existsSync(join(dataRoot, 'rootfs'))).toBe(false);
    // The store was just emptied: nothing to prune, the switch is recorded as done.
    expect(r.out.cache_migration).toBe('none');
    expect(existsSync(join(dataRoot, '.lazy-native-diff'))).toBe(true);
  });
});
