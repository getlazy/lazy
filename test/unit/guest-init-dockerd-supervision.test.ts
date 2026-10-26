/**
 * lazy-guest-init supervises the guest's dockerd.
 *
 * INVARIANT: `--ensure` never answers "ready" from the boot marker alone — it
 * asks dockerd. There is no init system in the guest, so a dockerd that dies
 * mid-boot (seen on a small Teams machine during a long image build) stayed dead
 * until the VM rebooted, and every later build and launch failed with "Docker is
 * not installed". `--ensure` records why it died, restarts it with a backoff,
 * and stops (reason=dockerd-crash-loop) rather than flapping once the restart
 * budget is spent.
 *
 * The script runs only inside a microVM, so this drives the real script with
 * fake `docker`, `dockerd`, `id`, `ip` and `dmesg` on PATH and every path it
 * writes redirected into a temp dir through its LAZY_GUEST_* seams.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { symlink, mkdtemp, writeFile, rm, readFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { settleDockerdWrapper } from '../helpers/guest-dockerd-wrapper';

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
  dir = await mkdtemp(join(tmpdir(), 'guest-init-dockerd-'));
  bin = join(dir, 'bin');
  runDir = join(dir, 'run');
  logDir = join(dir, 'log');
  state = join(dir, 'state');
  for (const d of [bin, runDir, logDir, state]) await mkdir(d, { recursive: true });
  // `docker info` answers while the "up" flag exists, like a live socket.
  await fake('docker', `
echo "$*" >>"${state}/docker-calls"
case "$1" in
  builder) [ -f "${state}/prune-fails" ] && exit 1; exit 0 ;;
  info) [ -f "${state}/up" ] || { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
        [ "$2" = "--format" ] && echo overlay2; exit 0 ;;
  buildx) exit 0 ;;
esac
exit 0`);
  // dockerd comes up (unless told to die at once) and counts its starts.
  await fake('dockerd', `
echo start >>"${state}/starts"
echo "$*" >"${state}/argv"
# What each start was configured with: the --config-file it was handed.
prev=""; for a in "$@"; do [ "$prev" = "--config-file" ] && { cat "$a"; echo "---"; } >>"${state}/configs"; prev="$a"; done
echo "dockerd: fake starting $*"
# Real dockerd takes no positional arguments.
case "$1" in --*) ;; *) echo "dockerd: unexpected argument $1"; exit 1 ;; esac
if [ -f "${state}/die-on-start" ]; then echo "dockerd: fatal" ; exit 1; fi
touch "${state}/up"
[ -f "${state}/stay" ] && exec sleep 30
# Alive exactly as long as it answers, like a real dockerd: a fake that exited
# at once while \`docker info\` still answered let --ensure see an exit status
# beside an answering daemon, and report a first boot as dockerd-timeout.
while [ -f "${state}/up" ]; do sleep 0.05; done
exit 0`);
  await fake('id', 'echo 0');
  await fake('ip', 'exit 0'); // no link address: the forwarder is skipped
  // The kernel ring buffer: whatever the test wrote to state/dmesg.
  await fake('dmesg', `[ -f "${state}/dmesg" ] && cat "${state}/dmesg"; exit 0`);
});

afterEach(async () => {
  // A fake dockerd runs until stopped (a "stay" one sleeps); stop whichever is still running.
  const pidFile = join(runDir, 'lazy-dockerd.pid');
  if (existsSync(pidFile)) {
    const pid = Number((await readFile(pidFile, 'utf8')).trim());
    try { if (pid > 0) process.kill(pid); } catch { /* already gone — nothing to stop */ }
  }
  await rm(dir, { recursive: true, force: true });
});

function ensure(extraEnv: Record<string, string> = {}, mode = '--ensure'): { code: number | null; out: Record<string, string>; stderr: string } {
  const result = spawnSyncUnsupervised(['sh', INIT, mode, '--timeout', '5'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      LAZY_GUEST_RUN_DIR: runDir,
      LAZY_GUEST_CGROUP_ROOT: join(dir, "no-cgroup"), // never touch the real /sys/fs/cgroup; the cgroup path has its own tests
      LAZY_GUEST_LOG_DIR: logDir,
      LAZY_GUEST_DOCKER_DATA_ROOT: join(dir, 'docker'),
      LAZY_GUEST_DOCKER_STORAGE_DRIVER: 'overlay2',
      LAZY_GUEST_OVERLAY_PARAMS_DIR: join(dir, 'overlay-params'),
      ...extraEnv,
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
  return { code: result.exitCode, out, stderr: result.stderr.toString() };
}

/**
 * dockerd stops answering. A non-"stay" fake then exits, and its wrapper writes
 * lazy-dockerd.exit on its own schedule: wait for that, so a test that plays a
 * death by writing its own exit status is never overwritten by the wrapper's
 * late one. A "stay" fake keeps running (alive, not answering).
 */
async function stopFakeDockerd(): Promise<void> {
  await rm(join(state, 'up'));
  if (!existsSync(join(state, 'stay')) && existsSync(join(runDir, 'lazy-dockerd.pid'))) await settleDockerdWrapper(runDir);
}

async function starts(): Promise<number> {
  return existsSync(join(state, 'starts')) ? (await readFile(join(state, 'starts'), 'utf8')).trim().split('\n').length : 0;
}

describe('lazy-guest-init --ensure with a dead dockerd', () => {
  test('a first boot starts dockerd and sets the marker', async () => {
    const r = ensure();
    expect(r.code).toBe(0);
    expect(r.out.source).toBe('started-dockerd');
    expect(existsSync(join(runDir, 'lazy-guest-ready'))).toBe(true);
    // Exactly dockerd's flags: nothing from the wrapping shell leaks in.
    expect((await readFile(join(state, 'argv'), 'utf8')).trim()).toBe(
      `--data-root ${join(dir, 'docker')} --config-file ${join(runDir, 'lazy-dockerd.json')} --host unix:///var/run/docker.sock`,
    );
  });

  test('a running dockerd that is slow to answer is left alone until the hung period', async () => {
    await writeFile(join(state, 'stay'), '');
    ensure();
    await stopFakeDockerd();
    const slow = ensure();
    expect(slow.code).toBe(1);
    expect(slow.out.reason).toBe('dockerd-not-answering');
    expect(await starts()).toBe(1);
    expect(existsSync(join(logDir, 'lazy-dockerd-restarts.log'))).toBe(false);

    const hung = ensure({ LAZY_GUEST_DOCKERD_HUNG_SECONDS: '0' });
    expect(hung.out.source).toBe('restarted-dockerd');
    expect(hung.out.dockerd_died).toBe('not-answering');
    expect(await starts()).toBe(2);
    // Stop the second sleeping fake so nothing outlives the test.
    const pid = (await readFile(join(runDir, 'lazy-dockerd.pid'), 'utf8')).trim();
    try { process.kill(Number(pid)); } catch { /* already gone — verified by nothing depending on it */ }
  });

  test('a live dockerd behind the marker is left alone', async () => {
    ensure();
    const r = ensure();
    expect(r.code).toBe(0);
    expect(r.out.source).toBe('marker');
    expect(await starts()).toBe(1);
  });

  test('a dockerd that died after the marker is recorded and restarted', async () => {
    ensure();
    await stopFakeDockerd();
    await writeFile(join(runDir, 'lazy-dockerd.exit'), '137\n');
    const pid = (await readFile(join(runDir, 'lazy-dockerd.pid'), 'utf8')).trim();
    // Pin the start time so the kernel timestamp below falls inside this instance.
    await writeFile(join(runDir, 'lazy-dockerd.start'), '10.00\n');
    await writeFile(join(state, 'dmesg'), `[ 812.3] Out of memory: Killed process ${pid} (dockerd) total-vm:2048kB\n`);

    const r = ensure();
    expect(r.code).toBe(0);
    expect(r.out.source).toBe('restarted-dockerd');
    expect(r.out.dockerd_died).toBe('exited-137+oom-killer');
    expect(r.out.dockerd_restarts).toBe('1');
    expect(await starts()).toBe(2);

    const history = await readFile(join(logDir, 'lazy-dockerd-restarts.log'), 'utf8');
    expect(history).toContain('cause=exited-137+oom-killer');
    expect(history).toContain('kernel OOM kill of this dockerd');
    expect(history).toContain(`Killed process ${pid} (dockerd)`);
    expect(history).toContain('dockerd: fake starting'); // tail of the dockerd log
    expect(history).toContain('restarting dockerd (restart 1 of 3');
  });

  // INVARIANT: an OOM kill is diagnosed only when it is attributable to THIS dockerd
  // instance (see the cgroup/instance-window rule below). The ring buffer keeps stale
  // kills and kills of other processes; calling those the cause would tell an admin to
  // resize a machine for the wrong reason.
  test('a stale or unrelated OOM line is kept as context but never diagnosed', async () => {
    ensure();
    await stopFakeDockerd();
    await writeFile(join(runDir, 'lazy-dockerd.exit'), '1\n');
    const pid = Number((await readFile(join(runDir, 'lazy-dockerd.pid'), 'utf8')).trim());
    await writeFile(join(state, 'dmesg'),
      `[  12.0] Out of memory: Killed process ${pid + 1} (bun) total-vm:9kB\n` +
      `[   3.0] Out of memory: Killed process ${pid}0 (dockerd) total-vm:9kB\n`);

    const r = ensure();
    expect(r.out.source).toBe('restarted-dockerd');
    expect(r.out.dockerd_died).toBe('exited-1');
    const history = await readFile(join(logDir, 'lazy-dockerd-restarts.log'), 'utf8');
    expect(history).toContain('NOT matched to this dockerd');
    expect(history).toContain('(bun)');
    expect(history).not.toContain('oom-killer');
  });

  test('a matched OOM kill is found even behind later OOM activity', async () => {
    ensure();
    await stopFakeDockerd();
    await writeFile(join(runDir, 'lazy-dockerd.exit'), '137\n');
    const pid = (await readFile(join(runDir, 'lazy-dockerd.pid'), 'utf8')).trim();
    await writeFile(join(runDir, 'lazy-dockerd.start'), '10.00\n'); // pinned so the kill at 80.0 is inside this instance
    const later = Array.from({ length: 6 }, (_, i) => `[ 9${i}.0] oom_reaper: reaped process 7${i} (bun)`).join('\n');
    await writeFile(join(state, 'dmesg'),
      `[ 80.0] Out of memory: Killed process ${pid} (dockerd) total-vm:9kB\n${later}\n`);
    expect(ensure().out.dockerd_died).toBe('exited-137+oom-killer');
  });

  // INVARIANT: exact pid equality cannot attribute an OOM kill: `machine exec` runs in a nested pid namespace whose offset is not constant, so the kernel names a different pid than /run/lazy-dockerd.pid (seen ~1600 higher). Attribution is, in order: the cgroup oom_kill counter, a kill naming the recorded/kernel pid, and (no cgroup only) exit 137 with exactly one distinct dockerd pid killed after the instance start.
  test('an OOM kill under a different pid is matched by instance when it exited 137, with the memory figures', async () => {
    ensure();
    await stopFakeDockerd();
    await writeFile(join(runDir, 'lazy-dockerd.exit'), '137\n');
    const pid = Number((await readFile(join(runDir, 'lazy-dockerd.pid'), 'utf8')).trim());
    await writeFile(join(runDir, 'lazy-dockerd.start'), '10.00\n');
    await writeFile(join(state, 'dmesg'), `[ 80.0] Out of memory: Killed process ${pid + 1600} (dockerd) total-vm:9kB, anon-rss:7276440kB, file-rss:968kB\n`);
    const r = ensure();
    expect(r.out.dockerd_died).toBe('exited-137+oom-killer');
    expect(r.out.dockerd_oom_used_kb).toBe('7276440');
    expect(Number(r.out.dockerd_oom_machine_kb)).toBeGreaterThan(0);
    const history = await readFile(join(logDir, 'lazy-dockerd-restarts.log'), 'utf8');
    expect(history).toContain('dockerd memory at the kill: used 7276440 kB');
  });

  async function withCgroup(): Promise<{ env: Record<string, string>; events: string }> {
    const root = join(dir, 'cg');
    await mkdir(join(root, 'lazy-dockerd'), { recursive: true });
    await writeFile(join(root, 'cgroup.controllers'), 'memory\n');
    await writeFile(join(root, 'lazy-dockerd', 'cgroup.procs'), '');
    const events = join(root, 'lazy-dockerd', 'memory.events');
    await writeFile(events, 'low 0\noom 0\noom_kill 0\n');
    return { env: { LAZY_GUEST_CGROUP_ROOT: root }, events };
  }

  // INVARIANT: with a cgroup v2 counter, an OOM of THIS instance is named by oom_kill rising across its lifetime - no pid involved, so a pid mismatch cannot hide it, and a counter that did not move rules an OOM out even if a lone dockerd kill is in the log.
  test('the cgroup oom_kill counter names a SIGKILL-ended OOM with no pid match', async () => {
    const { env, events } = await withCgroup();
    ensure(env);
    expect(await readFile(join(runDir, 'lazy-dockerd.oom-kill-base'), 'utf8')).toBe('0\n');
    expect(await readFile(join(dir, 'cg', 'lazy-dockerd', 'cgroup.procs'), 'utf8')).toMatch(/^\d+/); // dockerd's wrapper joined it
    await stopFakeDockerd();
    await writeFile(join(runDir, 'lazy-dockerd.exit'), '137\n');
    await writeFile(events, 'oom_kill 1\n');
    await writeFile(join(runDir, 'lazy-dockerd.start'), '10.00\n');
    await writeFile(join(state, 'dmesg'), '[ 80.0] Out of memory: Killed process 99999 (dockerd) total-vm:9kB, anon-rss:2048000kB\n');
    const r = ensure(env);
    expect(r.out.dockerd_died).toBe('exited-137+oom-killer');
    expect(r.out.dockerd_oom_used_kb).toBe('2048000');
    expect(await readFile(join(logDir, 'lazy-dockerd-restarts.log'), 'utf8')).toContain('oom_kill 0 -> 1');
  });

  // INVARIANT: a counter rise from a child's earlier OOM must not be blamed for an unrelated exit (exit 1), and a failed cgroup join leaves no counter, so attribution falls back to the kernel-log rules.
  test('a counter rise with a non-SIGKILL exit is not diagnosed', async () => {
    const { env, events } = await withCgroup();
    ensure(env);
    await stopFakeDockerd();
    await writeFile(join(runDir, 'lazy-dockerd.exit'), '1\n');
    await writeFile(events, 'oom_kill 1\n');
    expect(ensure(env).out.dockerd_died).toBe('exited-1');
  });

  test('a cgroup the dockerd wrapper could not join is ignored and the fallback applies', async () => {
    const { env } = await withCgroup();
    const procs = join(dir, 'cg', 'lazy-dockerd', 'cgroup.procs');
    await rm(procs);
    await symlink('/dev/null', procs); // writes succeed but never list the pid
    ensure(env);
    await new Promise(r => setTimeout(r, 500)); // the wrapper removes the base asynchronously
    await stopFakeDockerd();
    await writeFile(join(runDir, 'lazy-dockerd.exit'), '137\n');
    await writeFile(join(runDir, 'lazy-dockerd.start'), '10.00\n');
    await writeFile(join(state, 'dmesg'), '[ 80.0] Out of memory: Killed process 99999 (dockerd) total-vm:9kB, anon-rss:1kB\n');
    expect(ensure(env).out.dockerd_died).toBe('exited-137+oom-killer');
  });

  test('a cgroup counter that did not move disables the lone-kill fallback', async () => {
    const { env } = await withCgroup();
    ensure(env);
    await stopFakeDockerd();
    await writeFile(join(runDir, 'lazy-dockerd.exit'), '137\n');
    await writeFile(join(runDir, 'lazy-dockerd.start'), '10.00\n');
    await writeFile(join(state, 'dmesg'), '[ 80.0] Out of memory: Killed process 99999 (dockerd) total-vm:9kB, anon-rss:1kB\n');
    expect(ensure(env).out.dockerd_died).toBe('exited-137');
  });

  async function dieWithKills(exit: string, kills: (pid: number) => string): Promise<string> {
    ensure();
    await stopFakeDockerd();
    await writeFile(join(runDir, 'lazy-dockerd.exit'), `${exit}\n`);
    const pid = Number((await readFile(join(runDir, 'lazy-dockerd.pid'), 'utf8')).trim());
    await writeFile(join(runDir, 'lazy-dockerd.start'), '10.00\n');
    await writeFile(join(state, 'dmesg'), kills(pid));
    return ensure().out.dockerd_died;
  }

  test('a different-pid dockerd kill is not matched when the instance did not exit 137', async () => {
    expect(await dieWithKills('1', pid => `[ 80.0] Out of memory: Killed process ${pid + 1600} (dockerd) anon-rss:1kB\n`)).toBe('exited-1');
  });

  test('two distinct dockerd pids killed in the lifetime are ambiguous and not matched', async () => {
    expect(await dieWithKills('137', pid =>
      `[ 80.0] Out of memory: Killed process ${pid + 1600} (dockerd) anon-rss:1kB\n` +
      `[ 81.0] Out of memory: Killed process ${pid + 1700} (dockerd) anon-rss:1kB\n`)).toBe('exited-137');
  });

  test('an exact pid match still wins among several dockerd kills', async () => {
    expect(await dieWithKills('137', pid =>
      `[ 80.0] Out of memory: Killed process ${pid + 1600} (dockerd) anon-rss:1kB\n` +
      `[ 81.0] Out of memory: Killed process ${pid} (dockerd) anon-rss:1kB\n`)).toBe('exited-137+oom-killer');
  });

  test('a different-pid dockerd kill from before this instance started is not matched', async () => {
    ensure();
    await stopFakeDockerd();
    await writeFile(join(runDir, 'lazy-dockerd.exit'), '137\n');
    const pid = Number((await readFile(join(runDir, 'lazy-dockerd.pid'), 'utf8')).trim());
    await writeFile(join(runDir, 'lazy-dockerd.start'), '100.00\n');
    await writeFile(join(state, 'dmesg'), `[ 80.0] Out of memory: Killed process ${pid + 1600} (dockerd) total-vm:9kB, anon-rss:1kB\n`);
    expect(ensure().out.dockerd_died).toBe('exited-137');
  });

  test('a reused pid killed under another name is not diagnosed', async () => {
    ensure();
    await stopFakeDockerd();
    await writeFile(join(runDir, 'lazy-dockerd.exit'), '137\n');
    const pid = (await readFile(join(runDir, 'lazy-dockerd.pid'), 'utf8')).trim();
    await writeFile(join(state, 'dmesg'), `[ 5.0] Out of memory: Killed process ${pid} (bun) total-vm:9kB\n`);
    const r = ensure();
    expect(r.out.dockerd_died).toBe('exited-137');
    expect(await readFile(join(logDir, 'lazy-dockerd-restarts.log'), 'utf8')).toContain('NOT matched to this dockerd');
  });

  test('stops restarting once the budget is spent instead of flapping', async () => {
    ensure();
    const env = { LAZY_GUEST_DOCKERD_MAX_RESTARTS: '1' };
    await stopFakeDockerd();
    expect(ensure(env).out.source).toBe('restarted-dockerd');

    await stopFakeDockerd();
    const r = ensure(env);
    expect(r.code).toBe(1);
    expect(r.out.ready).toBe('no');
    expect(r.out.reason).toBe('dockerd-crash-loop');
    expect(r.stderr).toContain('not restarting it');
    expect(await starts()).toBe(2);
    const history = await readFile(join(logDir, 'lazy-dockerd-restarts.log'), 'utf8');
    expect(history).toContain('NOT restarting dockerd');

    // Asking again repeats the refusal without growing the RAM-backed log.
    const again = ensure(env);
    expect(again.out.reason).toBe('dockerd-crash-loop');
    expect(await readFile(join(logDir, 'lazy-dockerd-restarts.log'), 'utf8')).toBe(history);
  });

  test('a dockerd that dies on start fails fast with its exit status, not after the timeout', async () => {
    ensure();
    await stopFakeDockerd();
    await writeFile(join(state, 'die-on-start'), '');
    const t0 = Date.now();
    const r = ensure({ LAZY_GUEST_DOCKERD_MAX_RESTARTS: '5' });
    expect(r.code).toBe(1);
    expect(r.out.reason).toBe('dockerd-timeout');
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect((await readFile(join(runDir, 'lazy-dockerd.exit'), 'utf8')).trim()).toBe('1');
  });
});

describe('a dockerd restart requested from god mode', () => {
  /** What the project daemon's god-mode restart does: write the request, then SIGTERM dockerd and wait for it. */
  async function requestAndStop(at = Math.floor(Date.now() / 1000)): Promise<void> {
    await writeFile(join(runDir, 'lazy-dockerd.restart-requested'), `${at}\n`);
    const pid = Number((await readFile(join(runDir, 'lazy-dockerd.pid'), 'utf8')).trim());
    process.kill(pid, 'SIGTERM');
    await rm(join(state, 'up'), { force: true });
    const deadline = Date.now() + 5_000;
    while (!existsSync(join(runDir, 'lazy-dockerd.exit'))) {
      if (Date.now() > deadline) throw new Error('the stopped fake dockerd never recorded its exit status');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const history = () => readFile(join(logDir, 'lazy-dockerd-restarts.log'), 'utf8');

  // INVARIANT: a restart a person asked for is never recorded as a crash. A
  // god-mode Restart used to SIGTERM dockerd and run --force, which wrote a
  // death record (cause=exited-143) into the history project admins read and
  // spent the crash budget — the third restart in 15 minutes failed as a
  // crash loop.
  test('is logged as requested, with no death record and no budget entry', async () => {
    await writeFile(join(state, 'stay'), '');
    expect(ensure().out.source).toBe('started-dockerd');
    const env = { LAZY_GUEST_DOCKERD_MAX_RESTARTS: '1' };
    for (let i = 1; i <= 3; i++) {
      await requestAndStop();
      const r = ensure(env, '--force');
      expect(r.code, r.stderr).toBe(0);
      expect(r.out.source).toBe('requested-restart');
      expect(r.out.dockerd_died).toBeUndefined();
    }
    expect(await starts()).toBe(4);
    const log = await history();
    expect(log.match(/restart requested from god mode/g)?.length).toBe(3);
    expect(log).not.toContain('stopped answering');
    expect(log).not.toContain('cause=');
    expect(existsSync(join(runDir, 'lazy-dockerd.restarts'))).toBe(false);
    expect(existsSync(join(runDir, 'lazy-dockerd.restart-requested'))).toBe(false);
  });

  // INVARIANT: while god mode's stopped dockerd is still exiting, an --ensure
  // from any other `lazy` call leaves it alone — no early SIGKILL of a graceful
  // stop, no second dockerd, and the request stays for the daemon's --force.
  test('an --ensure during the stop leaves the stopping dockerd and the request alone', async () => {
    await writeFile(join(state, 'stay'), '');
    ensure();
    const pid = Number((await readFile(join(runDir, 'lazy-dockerd.pid'), 'utf8')).trim());
    await writeFile(join(runDir, 'lazy-dockerd.restart-requested'), `${Math.floor(Date.now() / 1000)}\n`);
    await stopFakeDockerd(); // stopping: alive, no longer answering

    const r = ensure();
    expect(r.code).toBe(1);
    expect(r.out.reason).toBe('dockerd-restart-requested');
    expect(process.kill(pid, 0)).toBe(true);
    expect(existsSync(join(runDir, 'lazy-dockerd.restart-requested'))).toBe(true);
    expect(existsSync(join(logDir, 'lazy-dockerd-restarts.log'))).toBe(false);
    expect(await starts()).toBe(1);
  });

  test('a later crash is still recorded and counted', async () => {
    await writeFile(join(state, 'stay'), '');
    ensure();
    await requestAndStop();
    expect(ensure({}, '--force').out.source).toBe('requested-restart');
    // Now it dies on its own.
    const pid = Number((await readFile(join(runDir, 'lazy-dockerd.pid'), 'utf8')).trim());
    process.kill(pid, 'SIGKILL');
    await stopFakeDockerd();
    while (!existsSync(join(runDir, 'lazy-dockerd.exit'))) await new Promise((r) => setTimeout(r, 25));
    const r = ensure();
    expect(r.out.source).toBe('restarted-dockerd');
    expect(r.out.dockerd_died).toBe('exited-137');
    expect(r.out.dockerd_restarts).toBe('1');
  });

  // INVARIANT: only a FRESH request is honoured — one a daemon left behind
  // when it died mid-restart must not pass a real crash off as requested.
  test('a stale request is ignored and the death recorded', async () => {
    await writeFile(join(state, 'stay'), '');
    ensure();
    await requestAndStop(Math.floor(Date.now() / 1000) - 3600);
    const r = ensure();
    expect(r.out.source).toBe('restarted-dockerd');
    expect(r.out.dockerd_died).toBe('exited-143');
    expect(await history()).toContain('cause=exited-143');
  });

  test('lifts a crash-loop refusal: the maintainer asked', async () => {
    ensure();
    const env = { LAZY_GUEST_DOCKERD_MAX_RESTARTS: '1' };
    await stopFakeDockerd();
    ensure(env);
    await stopFakeDockerd();
    expect(ensure(env).out.reason).toBe('dockerd-crash-loop');
    expect(existsSync(join(runDir, 'lazy-dockerd.gave-up'))).toBe(true);

    await writeFile(join(runDir, 'lazy-dockerd.restart-requested'), `${Math.floor(Date.now() / 1000)}\n`);
    const r = ensure(env, '--force');
    expect(r.code, r.stderr).toBe(0);
    expect(r.out.source).toBe('requested-restart');
    expect(existsSync(join(runDir, 'lazy-dockerd.gave-up'))).toBe(false);
  });
});

async function waitFor(path: string, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(path)) return true;
    await Bun.sleep(50);
  }
  return existsSync(path);
}

async function dockerCalls(): Promise<string> {
  return existsSync(join(state, 'docker-calls')) ? readFile(join(state, 'docker-calls'), 'utf8') : '';
}

describe('lazy-guest-init bounds the build cache', () => {
  // INVARIANT: dockerd starts with BuildKit GC enabled under a CAP (Docker 29's
  // defaultMaxUsedSpace — defaultKeepStorage is only a reserved floor since
  // Docker 28) and with the overlay module's redirect_dir/metacopy defaults off.
  // With either on, Docker's overlay2 sizes cache records with the naive diff,
  // and BuildKit's disk-usage pass over a Rust-sized cache OOM-killed the guest
  // dockerd on every start.
  test('turns redirect_dir and metacopy off, follows old redirects, and writes a capped GC config', async () => {
    const params = join(dir, 'overlay-params');
    await mkdir(params);
    await writeFile(join(params, 'redirect_dir'), 'Y\n');
    await writeFile(join(params, 'metacopy'), 'Y\n');
    await writeFile(join(params, 'redirect_always_follow'), 'N\n');
    const r = ensure({ LAZY_GUEST_BUILD_CACHE_MAX: '6GB' });
    expect(r.code).toBe(0);
    expect(r.out.overlay_diff).toBe('native');
    expect(r.out.build_cache_max).toBe('6GB');
    expect((await readFile(join(params, 'redirect_dir'), 'utf8')).trim()).toBe('N');
    expect((await readFile(join(params, 'metacopy'), 'utf8')).trim()).toBe('N');
    expect((await readFile(join(params, 'redirect_always_follow'), 'utf8')).trim()).toBe('Y');
    const gc = JSON.parse(await readFile(join(runDir, 'lazy-dockerd.json'), 'utf8')).builder.gc;
    expect(gc.enabled).toBe(true);
    expect(gc.defaultMaxUsedSpace).toBe('6GB');
    expect(gc.defaultReservedSpace).toBe('1GB');
    expect(gc.defaultMinFreeSpace).toMatch(/^\d+GB$/);
    expect(gc.defaultKeepStorage).toBeUndefined();
  });

  test('by default the cap is sized from the data-root disk', async () => {
    await mkdir(join(dir, 'overlay-params'));
    const r = ensure();
    expect(r.code).toBe(0);
    expect(r.out.build_cache_max).toMatch(/^\d+GB$/);
    expect(JSON.parse(await readFile(join(runDir, 'lazy-dockerd.json'), 'utf8')).builder.gc.defaultMaxUsedSpace).toBe(r.out.build_cache_max);
  });

  // INVARIANT: live disk growth recomputes DESIRED limits without restarting
  // Docker. Its embedded BuildKit policy cannot reload and stays at its old cap.
  test('live resize reports new limits pending restart and a later start applies them', async () => {
    await fake('df', `echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'\necho "fake $(cat '${state}/disk-kb') 0 1 1% /storage"`);
    await writeFile(join(state, 'disk-kb'), String(32 * 1048576));
    expect(ensure().out.build_cache_max).toBe('12GB');
    await writeFile(join(state, 'disk-kb'), String(64 * 1048576));
    const plan = ensure({}, '--print-plan');
    expect(plan.out.build_cache_max).toBe('25GB');
    expect(plan.out.build_cache_min_free).toBe('12GB');
    expect(plan.out.dockerd_config_state).toBe('pending-restart');
    expect(JSON.parse(await readFile(join(runDir, 'lazy-dockerd.json'), 'utf8')).builder.gc.defaultMaxUsedSpace).toBe('12GB');
    expect((await readFile(join(state, 'starts'), 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(ensure().out.dockerd_config_state).toBe('pending-restart');
    await stopFakeDockerd();
    expect(ensure().code).toBe(0);
    expect(JSON.parse(await readFile(join(runDir, 'lazy-dockerd.json'), 'utf8')).builder.gc.defaultMaxUsedSpace).toBe('25GB');
  });

  test('a cap that is not a size is ignored instead of breaking dockerd', async () => {
    await mkdir(join(dir, 'overlay-params'));
    const r = ensure({ LAZY_GUEST_BUILD_CACHE_MAX: '1"; rm' });
    expect(r.code).toBe(0);
    expect(r.out.build_cache_max).toMatch(/^\d+GB$/);
    expect(r.stderr).toContain('is not a size');
  });

  test('reports unknown, not native, when the overlay parameters are not visible', () => {
    const r = ensure(); // LAZY_GUEST_OVERLAY_PARAMS_DIR points at a directory that does not exist
    expect(r.code).toBe(0);
    expect(r.out.overlay_diff).toBe('unknown');
    expect(r.out.cache_migration).toBe('skipped');
  });

  const asRoot = process.getuid?.() === 0;
  if (asRoot) console.log('skip: "reports naive diff when it cannot be turned off" — root ignores file modes, so the read-only parameter cannot be simulated');
  test.skipIf(asRoot)('reports naive diff when it cannot be turned off', async () => {
    const params = join(dir, 'overlay-params');
    await mkdir(params);
    await writeFile(join(params, 'redirect_dir'), 'Y\n');
    await chmod(join(params, 'redirect_dir'), 0o444);
    const r = ensure();
    expect(r.code).toBe(0);
    expect(r.out.overlay_diff).toBe('naive');
    expect(r.stderr).toContain('naive diff');
    // The write's own error is in the warning, so a machine that keeps
    // redirect_dir=Y says why (a field machine said nothing, 2026-10-15).
    expect(r.stderr).toMatch(/redirect_dir \(.*: .*[Pp]ermission denied/);
  });

  // INVARIANT: --print-plan reports the diff the overlay module gives dockerd
  // NOW, without changing it — the plan is what a diagnosis reads, and a
  // machine stuck on the naive diff went unnoticed because it said nothing.
  test('--print-plan reports the current overlay diff and changes nothing', async () => {
    const params = join(dir, 'overlay-params');
    await mkdir(params);
    await writeFile(join(params, 'redirect_dir'), 'Y\n');
    await writeFile(join(params, 'metacopy'), 'N\n');
    const naive = ensure({}, '--print-plan');
    expect(naive.out.overlay_diff).toBe('naive');
    expect(naive.out.overlay_params).toBe('writable');
    expect((await readFile(join(params, 'redirect_dir'), 'utf8')).trim()).toBe('Y');
    await writeFile(join(params, 'redirect_dir'), 'N\n');
    expect(ensure({}, '--print-plan').out.overlay_diff).toBe('native');
  });

  // INVARIANT: the plan says whether lazy CAN change the parameters, so a
  // machine stuck on the naive diff says why. smolvm's guest /sys is
  // read-only (token-watch, 2026-10-15), and nothing reported it.
  test.skipIf(process.getuid?.() === 0)('--print-plan reports read-only overlay parameters', async () => {
    const params = join(dir, 'overlay-params');
    await mkdir(params);
    await writeFile(join(params, 'redirect_dir'), 'Y\n');
    await chmod(join(params, 'redirect_dir'), 0o444);
    const r = ensure({}, '--print-plan');
    expect(r.out.overlay_diff).toBe('naive');
    expect(r.out.overlay_params).toBe('read-only');
  });
});

describe('lazy-guest-init resets a build cache made under the naive diff, once', () => {
  // INVARIANT: the first native-diff start of a data-root that has BuildKit
  // state prunes the build cache once. Records committed while redirect_dir was
  // on can hold overlay redirects the native diff cannot represent; exported
  // into an image they would silently lose files.
  const marker = () => join(dir, 'docker', '.lazy-native-diff');

  test('prunes once when there is cache state and no marker, and not on the next start', async () => {
    await mkdir(join(dir, 'overlay-params'));
    await mkdir(join(dir, 'docker', 'buildkit'), { recursive: true });
    const r = ensure();
    expect(r.out.cache_migration).toBe('pruning');
    expect(await waitFor(marker())).toBe(true);
    expect(await dockerCalls()).toContain('builder prune --all --force');

    await rm(join(state, 'docker-calls'));
    await rm(join(runDir, 'lazy-guest-ready'));
    await stopFakeDockerd();
    const again = ensure({}, '--force');
    expect(again.out.cache_migration).toBe('done');
    expect(await dockerCalls()).not.toContain('builder prune');
  });

  test('on the overlayfs image store, cache state is pruned once and then marked done', async () => {
    await mkdir(join(dir, 'overlay-params'));
    await mkdir(join(dir, 'docker', 'buildkit'), { recursive: true });
    const env = { LAZY_GUEST_DOCKER_STORAGE_DRIVER: 'overlayfs' };
    const r = ensure(env);
    expect(r.out.image_store).toBe('containerd');
    expect(r.out.cache_migration).toBe('pruning');
    expect(await waitFor(marker())).toBe(true);
    await rm(join(runDir, 'lazy-guest-ready'));
    await stopFakeDockerd();
    expect(ensure(env, '--force').out.cache_migration).toBe('done');
  });

  test('a fresh data-root gets the marker without a prune', async () => {
    await mkdir(join(dir, 'overlay-params'));
    const r = ensure();
    expect(r.out.cache_migration).toBe('none');
    expect(existsSync(marker())).toBe(true);
    expect(await dockerCalls()).not.toContain('builder prune');
  });

  test('a failed prune leaves no marker, so the next start retries', async () => {
    await mkdir(join(dir, 'overlay-params'));
    await mkdir(join(dir, 'docker', 'buildkit'), { recursive: true });
    await writeFile(join(state, 'prune-fails'), '');
    const r = ensure();
    expect(r.out.cache_migration).toBe('pruning');
    const until = Date.now() + 5000;
    while (Date.now() < until && !(await dockerCalls()).includes('builder prune')) await Bun.sleep(50);
    await Bun.sleep(200);
    expect(await dockerCalls()).toContain('builder prune');
    expect(existsSync(marker())).toBe(false);
  });
});

describe('lazy-guest-init dockerd settings', () => {
  // INVARIANT: dockerd runs on the containerd image store with every setting in
  // lazy's own --config-file, and a watchdog restart is handed the SAME settings.
  // The legacy overlay2 store killed dockerd exporting a big image's layers; a
  // restart that dropped the feature would bring that back mid-incident.
  test('the first start and a watchdog restart get the same lazy-owned config with the image store', async () => {
    const env = { LAZY_GUEST_DOCKER_STORAGE_DRIVER: 'overlayfs' };
    expect(ensure(env).out.image_store).toBe('containerd');
    await stopFakeDockerd();
    await writeFile(join(runDir, 'lazy-dockerd.exit'), '1\n');
    const r = ensure(env);
    expect(r.out.source).toBe('restarted-dockerd');
    const configs = (await readFile(join(state, 'configs'), 'utf8')).split('---\n').filter(c => c.trim());
    expect(configs.length).toBe(2);
    expect(configs[0]).toBe(configs[1]);
    const cfg = JSON.parse(configs[0]);
    expect(cfg['storage-driver']).toBe('overlayfs');
    expect(cfg.features['containerd-snapshotter']).toBe(true);
    expect(cfg.builder.gc.enabled).toBe(true);
    expect(cfg.builder.gc.defaultMaxUsedSpace).toMatch(/GB$/);
    // No setting is ALSO passed as a flag: a flag plus a config key is "conflicting options".
    expect((await readFile(join(state, 'argv'), 'utf8'))).not.toContain('--storage-driver');
  });

  test('a forced legacy graph driver turns the image store off instead of making dockerd refuse it', async () => {
    const r = ensure();
    expect(r.out.image_store).toBe('graphdriver');
    const cfg = JSON.parse((await readFile(join(state, 'configs'), 'utf8')).split('---\n')[0]);
    expect(cfg['storage-driver']).toBe('overlay2');
    expect(cfg.features['containerd-snapshotter']).toBe(false);
  });

  test('the native snapshotter leaves the overlay module alone', async () => {
    const params = join(dir, 'overlay-params');
    await mkdir(params, { recursive: true });
    await writeFile(join(params, 'redirect_dir'), 'Y');
    const r = ensure({ LAZY_GUEST_DOCKER_STORAGE_DRIVER: 'native' });
    expect(r.out.overlay_diff).toBe('none');
    expect((await readFile(join(params, 'redirect_dir'), 'utf8')).trim()).toBe('Y');
  });

  // INVARIANT: a hand-written /etc/docker/daemon.json never collides with lazy's
  // settings — dockerd is always given --config-file, which replaces it.
  test('a hand-written daemon.json is not read: dockerd is always handed lazy\'s file', async () => {
    const daemonJson = join(dir, 'daemon.json');
    await writeFile(daemonJson, '{ "storage-driver": "overlay2", "features": { "containerd-snapshotter": true } }');
    const r = ensure({ LAZY_GUEST_DOCKER_DAEMON_JSON: daemonJson, LAZY_GUEST_DOCKER_STORAGE_DRIVER: 'overlayfs' });
    expect(r.code).toBe(0);
    expect(await readFile(join(state, 'argv'), 'utf8')).toContain(`--config-file ${join(runDir, 'lazy-dockerd.json')}`);
    expect(await readFile(daemonJson, 'utf8')).toContain('overlay2'); // untouched
  });
});
