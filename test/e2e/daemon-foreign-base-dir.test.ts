/**
 * INVARIANT: a CLI whose daemon base dir differs from the running daemon's
 * (a shell in a managed guest without the daemon's LAZY_DAEMON_BASE_DIR) never
 * starts a SECOND daemon for the same project. It either talks to the running
 * one or refuses. A second daemon cannot take the store lock and answered every
 * RPC with a 500 — reproduced in a Teams guest, where the managed daemon runs
 * with its own base dir and a bare root shell resolved $HOME/.lazy/daemon.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';

/** PIDs whose argv is `… daemon start … --project <root>`. */
async function daemonPidsFor(root: string): Promise<number[]> {
  const pids: number[] = [];
  for (const e of await readdir('/proc')) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const argv = (await readFile(`/proc/${e}/cmdline`, 'utf-8')).split('\0');
      const p = argv.indexOf('--project');
      if (argv.includes('daemon') && argv.includes('start') && p >= 0 && argv[p + 1] === root) pids.push(Number(e));
    } catch {
      // exited mid-scan
    }
  }
  return pids;
}

// The process-table assertions read /proc. A skip is never a pass: say so.
const skipNonLinux = process.platform !== 'linux';
if (skipNonLinux) console.log('SKIP daemon-foreign-base-dir.test.ts: needs /proc (Linux only)');

describe.skipIf(skipNonLinux)('CLI with a divergent daemon base dir', () => {
  let ctx: TestContext;
  let otherBase: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    otherBase = await mkdtemp(join(tmpdir(), 'lazy-e2e-other-base-'));
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(otherBase, { recursive: true, force: true });
  });

  test('a command talks to the running daemon instead of starting another', async () => {
    const before = await daemonPidsFor(ctx.root);
    expect(before.length).toBe(1);

    const result = await ctx.lazy(['list'], { env: { LAZY_DAEMON_BASE_DIR: otherBase } });

    expect(result.stderr).toContain(`Using the running daemon (PID ${before[0]})`);
    expect(result.exitCode).toBe(0);
    expect(await daemonPidsFor(ctx.root)).toEqual(before);
    expect((await readdir(otherBase)).length).toBe(0);
  });

  test('`lazy daemon start` refuses and names the base dir to export', async () => {
    const before = await daemonPidsFor(ctx.root);
    const result = await ctx.lazy(['daemon', 'start'], { env: { LAZY_DAEMON_BASE_DIR: otherBase } });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('refusing to start a second one');
    expect(result.stdout + result.stderr).toContain('export LAZY_DAEMON_BASE_DIR=');
    expect(await daemonPidsFor(ctx.root)).toEqual(before);
  });

  // INVARIANT: two commands auto-starting at once in the SAME daemon dir share
  // one daemon and neither is refused — the foreign-daemon scan must never
  // mistake a sibling's still-starting daemon for a foreign one.
  test('parallel auto-starts in one dir share a daemon, neither refused', async () => {
    const stop = await ctx.lazy(['daemon', 'stop', '--yes']);
    expect(stop.exitCode).toBe(0);
    expect(await daemonPidsFor(ctx.root)).toEqual([]);

    const [a, b] = await Promise.all([ctx.lazy(['list']), ctx.lazy(['list'])]);

    expect(a.stderr + b.stderr).not.toContain('refusing to start a second one');
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect((await daemonPidsFor(ctx.root)).length).toBe(1);
  });
});
