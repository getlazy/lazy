/**
 * When a command cannot reach the daemon, it says what it tried — never a bare
 * "Daemon is not running. Start it with: lazy daemon start".
 *
 * A recorded address that does not answer is not proof the daemon is down: a
 * stopped daemon, a moved port and an address this process cannot reach all
 * look the same, so the message names the address (and what its host name
 * resolved to). And a process with NO recorded address — a `lazy mcp` started
 * inside a container, where the daemon's markers are never mounted — is told
 * that this is expected there, instead of being sent to restart a daemon that is
 * running (2026-09-28: a leaked test server in a builder container did exactly
 * that).
 *
 * `LAZY_TEST` is emptied for the call: its default makes the CLI skip daemon
 * discovery entirely (see `src/preconditions.ts`), which is the path under test.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { startForeignProcess, type ForeignProcess } from '../helpers/foreign-process';
import { getDaemonDir, getPidPath, getTokenPath, getWebHostPath, getWebPortPath } from '../../src/daemon/paths';

describe('an unreachable recorded daemon address', () => {
  let ctx: TestContext;
  let tmpHome: string;
  let daemonBase: string;
  let unpin: () => void;
  let holder: ForeignProcess | undefined;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-unreachable-home-'));
    daemonBase = await mkdtemp(join(tmpdir(), 'lzd-unreachable-'));
    unpin = pinDaemonBaseDir(daemonBase);
  });

  afterEach(async () => {
    holder?.kill();
    holder = undefined;
    await ctx.cleanup();
    unpin();
    await rm(tmpHome, { recursive: true, force: true });
    await rm(daemonBase, { recursive: true, force: true });
  });

  async function recordUnreachableDaemon(): Promise<number> {
    // A port nothing listens on: bind one, note it, release it.
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = probe.port!;
    probe.stop(true);

    await mkdir(getDaemonDir(ctx.root), { recursive: true });
    await writeFile(getWebPortPath(ctx.root), String(port));
    await writeFile(getWebHostPath(ctx.root), '127.0.0.1');
    await writeFile(getTokenPath(ctx.root), 'not-a-real-token');
    // A live pid, so the CLI believes a daemon is running (as it was in the
    // incident) and does not start one of its own.
    holder = await startForeignProcess(tmpHome, 'fake-daemon');
    await writeFile(getPidPath(ctx.root), String(holder.pid));
    return port;
  }

  const env = () => ({ HOME: tmpHome, LAZY_DAEMON_BASE_DIR: daemonBase, LAZY_TEST: '', LAZY_IS_DAEMON: '' });

  // INVARIANT: a transport failure against the daemon's recorded address is
  // reported with that address, never as "Daemon is not running". The daemon
  // may be up and merely unreachable from here (a moved port, an address this
  // process cannot route), and "start it" sends a human to restart a healthy one.
  test('a storage command names the address that did not answer', async () => {
    const port = await recordUnreachableDaemon();
    const result = await ctx.lazy(['tag', 'some-task', 'x'], { env: env() });
    const output = result.stdout + result.stderr;
    expect(result.exitCode).not.toBe(0);
    expect(output).toContain(`The daemon at http://127.0.0.1:${port} did not answer`);
    expect(output).not.toContain('Daemon is not running');
  });

  test('a typed RPC command names the address that did not answer', async () => {
    const port = await recordUnreachableDaemon();
    const result = await ctx.lazy(['list'], { env: env() });
    const output = result.stdout + result.stderr;
    expect(result.exitCode).not.toBe(0);
    expect(output).toContain(`Daemon RPC to http://127.0.0.1:${port} failed`);
    expect(output).not.toContain('Restart it with');
  });

  // INVARIANT: with no recorded daemon address, the storage path names what it
  // looked for and says this is expected inside a container, where the markers
  // are never mounted — it does not just say "start the daemon".
  test('no recorded address: names what was looked for and the container case', async () => {
    // A live daemon.lock holder so the CLI believes a daemon runs and does not
    // start one; no port marker and no token, as inside a container.
    const lockHolder = Bun.spawn(
      ['bun', 'run', join(import.meta.dir, '../helpers/fake-daemon-driver.ts'), getDaemonDir(ctx.root)],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    try {
      const reader = lockHolder.stdout.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(value)).toContain('READY');

      const result = await ctx.lazy(['tag', 'some-task', 'x'], { env: env() });
      const output = result.stdout + result.stderr;
      expect(result.exitCode).not.toBe(0);
      expect(output).toContain(`No daemon address is recorded for this project (looked for ${getWebPortPath(ctx.root)})`);
      expect(output).toContain('Inside a container this is expected');
      expect(output).not.toContain('Daemon is not running');
    } finally {
      lockHolder.kill('SIGKILL');
      await lockHolder.exited;
    }
  });
});
