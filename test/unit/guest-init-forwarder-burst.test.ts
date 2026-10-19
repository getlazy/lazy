/**
 * The guest's port forwarder survives a dev server's page load.
 *
 * INVARIANT: lazy-guest-init's socat forwarder (link address → the daemon on
 * guest loopback) accepts a burst of hundreds of simultaneous connections
 * without resetting any. Every request a browser makes to a task service
 * through Lazy Teams is a fresh connection through this forwarder, and a dev
 * server (Vite and friends) serves each source module as its own request — so
 * one page load opens hundreds at once. With socat's default listen backlog
 * of 5, about half were reset and Teams answered each with a 502 (seen
 * 2026-10-13 on a real app behind a smolvm machine).
 *
 * Drives the REAL script and the REAL socat: the link address is a second
 * loopback address (127.0.0.2) and the "daemon" a Bun server on 127.0.0.1 at
 * the same port, exactly the two sides of the guest's forwarder. Everything
 * the script would do to dockerd is answered by fakes on PATH.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, readFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { pickPortFreeEverywhere } from '../helpers/port-free-everywhere';
import { SECOND_LOOPBACK_HOST, secondLoopbackSuiteSkipped } from '../helpers/second-loopback';

const INIT = join(import.meta.dir, '..', '..', 'src', 'guest', 'lazy-guest-init');

function socatMissing(): boolean {
  if (Bun.which('socat')) return false;
  console.log('SKIP guest-init forwarder burst: socat is not on PATH (it ships in Dockerfile.lazy)');
  return true;
}

const skip = secondLoopbackSuiteSkipped('guest-init forwarder burst') || socatMissing();

describe.skipIf(skip)('lazy-guest-init forwarder under a burst of connections', () => {
  let dir: string;
  let runDir: string;
  let daemon: Server<unknown>;

  async function fake(bin: string, name: string, body: string): Promise<void> {
    const p = join(bin, name);
    await writeFile(p, `#!/bin/sh\n${body}\n`);
    await chmod(p, 0o755);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'guest-init-forwarder-'));
    const bin = join(dir, 'bin');
    runDir = join(dir, 'run');
    for (const d of [bin, runDir, join(dir, 'log')]) await mkdir(d, { recursive: true });
    await fake(bin, 'docker', 'case "$1" in info) [ "$2" = "--format" ] && echo overlay2; exit 0 ;; esac\nexit 0');
    await fake(bin, 'dockerd', 'exit 0');
    await fake(bin, 'id', 'echo 0');
    await fake(bin, 'dmesg', 'exit 0');

    // A kernel-chosen port that is also free on 0.0.0.0 and 127.0.0.2.
    const port = pickPortFreeEverywhere();
    // The daemon: a module-sized answer, a little later for some requests, as
    // a dev server compiling on demand would give.
    daemon = Bun.serve({
      hostname: '127.0.0.1',
      port,
      async fetch(req) {
        await Bun.sleep(new URL(req.url).pathname.endsWith('0.jsx') ? 300 : Math.random() * 20);
        return new Response('x'.repeat(4096), { headers: { 'content-type': 'text/javascript' } });
      },
    });

    const result = spawnSyncUnsupervised(['sh', INIT, '--ensure', '--timeout', '5'], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LAZY_GUEST_RUN_DIR: runDir,
        LAZY_GUEST_LOG_DIR: join(dir, 'log'),
        LAZY_GUEST_CGROUP_ROOT: join(dir, 'no-cgroup'),
        LAZY_GUEST_DOCKER_DATA_ROOT: join(dir, 'docker'),
        LAZY_GUEST_DOCKER_STORAGE_DRIVER: 'overlay2',
        LAZY_GUEST_OVERLAY_PARAMS_DIR: join(dir, 'overlay-params'),
        LAZY_GUEST_LINK_ADDRESS: SECOND_LOOPBACK_HOST,
        LAZY_GUEST_DAEMON_PORT: String(daemon.port),
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
    });
    // The script trusts `ss` to confirm the bind and says "started" without it
    // (this image has no iproute2), so check the forwarder itself: alive, and
    // accepting on the link address.
    const pid = Number((await readFile(join(runDir, 'lazy-guest-forwarder.pid'), 'utf8').catch(() => '')).trim());
    let alive = false;
    try {
      alive = pid > 0 && process.kill(pid, 0);
    } catch {
      // Dead: reported below with the forwarder log.
    }
    const accepting = await new Promise<boolean>((resolve) => {
      Bun.connect({
        hostname: SECOND_LOOPBACK_HOST,
        port,
        socket: { open: (sock) => (sock.end(), resolve(true)), data() {}, connectError: () => resolve(false) },
      }).catch(() => resolve(false));
    });
    if (!/^forwarder=started$/m.test(result.stdout.toString()) || !alive || !accepting) {
      const fwdLog = await readFile(join(dir, 'log', 'lazy-forwarder.log'), 'utf8').catch(() => '(no forwarder log)');
      throw new Error(
        `the forwarder did not come up on ${SECOND_LOOPBACK_HOST}:${port} (alive=${alive}, accepting=${accepting}; a bind failure means another listener holds the port)\n` +
          `stdout: ${result.stdout}\nstderr: ${result.stderr}\nforwarder log: ${fwdLog}`,
      );
    }
  });

  afterEach(async () => {
    const pid = Number((await readFile(join(runDir, 'lazy-guest-forwarder.pid'), 'utf8').catch(() => '')).trim());
    // The forwarder is `setsid socat … fork`: its own process group, with a
    // forked child per connection. Kill the GROUP — killing only the listener
    // left children (and their sockets) behind for the rest of the run.
    try {
      if (pid > 0) process.kill(-pid);
    } catch {
      // Already gone: the only thing this cleanup is for is a forwarder still running.
    }
    daemon?.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test('300 parallel module requests, each on its own connection, all arrive', async () => {
    for (let round = 0; round < 2; round++) {
      const outcomes = await Promise.all(
        Array.from({ length: 300 }, (_, i) =>
          fetch(`http://${SECOND_LOOPBACK_HOST}:${daemon.port}/src/module-${i}.jsx`, {
            headers: { connection: 'close' },
          })
            .then(async (res) => (res.status === 200 && (await res.text()).length === 4096 ? 'ok' : `status ${res.status}`))
            .catch((err: Error & { code?: string }) => err.code ?? err.message),
        ),
      );
      const failed = outcomes.filter((o) => o !== 'ok');
      expect({ round, failed: failed.length, sample: failed.slice(0, 3) }).toEqual({ round, failed: 0, sample: [] });
    }
  }, 60_000);
});
