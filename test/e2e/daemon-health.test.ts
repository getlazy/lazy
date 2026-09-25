/**
 * `lazy daemon health` — the daemon's own report on whether its moving parts
 * are alive.
 *
 * Two halves. The CLI half runs the real command against a real daemon
 * subprocess (host-process runner via the fake agent binary, so the runner rows
 * have something real to diagnose) and asserts every row the report promises is
 * there and OK. The RPC half starts a daemon in-process, which is the only way
 * a test can reach inside it and stop its proxy while everything else keeps
 * running — the state the command exists to catch.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';
import type { DaemonHealthReport, DaemonHealthRow } from '../../src/daemon/daemon-health-rows';

/** Every row the report promises on a daemon that has completed a tick. */
const PROMISED_ROW_IDS = [
  'daemon:version',
  'daemon:build-match',
  'loop:reconcile',
  'loop:sync-retry',
  'loop:remote-sync',
  'proxy:listening',
  'proxy:audit-log',
  'storage:lock',
  'storage:writes',
  'runner:image',
  'tasks:working-not-alive',
  'tasks:held-syncs',
  'tasks:interrupted',
  'dashboard:bound',
];

function row(report: DaemonHealthReport, id: string): DaemonHealthRow {
  const found = report.rows.find(r => r.id === id);
  if (!found) throw new Error(`no row ${id} in: ${report.rows.map(r => r.id).join(', ')}`);
  return found;
}

describe('lazy daemon health (CLI against a live daemon)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Run the command until the loops have completed a tick (a fresh daemon may not have yet). */
  async function healthAfterFirstTicks(): Promise<{ report: DaemonHealthReport; exitCode: number }> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const result = await ctx.lazy(['daemon', 'health', '--json']);
      const report = JSON.parse(result.stdout) as DaemonHealthReport;
      const ticked = ['loop:reconcile', 'loop:sync-retry'].every(id =>
        report.rows.find(r => r.id === id)?.reason.includes('last tick finished'));
      const swept = report.rows.some(r => r.group === 'sweeps' && r.id !== 'sweep:none');
      if ((ticked && swept) || Date.now() > deadline) return { report, exitCode: result.exitCode };
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }

  // INVARIANT: on a healthy daemon every promised row is present and OK, and the
  // command exits 0. A row that silently disappears is a check nobody runs any
  // more; one that is not OK on a healthy daemon teaches people to ignore it.
  test('every row is present and OK on a healthy daemon', async () => {
    const { report, exitCode } = await healthAfterFirstTicks();

    for (const id of PROMISED_ROW_IDS) row(report, id);
    expect(report.rows.some(r => r.group === 'runner' && r.id !== 'runner:image')).toBe(true);
    expect(report.rows.filter(r => r.group === 'sweeps').map(r => r.name)).toEqual(
      expect.arrayContaining(['working-tasks', 'stranded-working', 'reconcileTasks']),
    );

    const notOk = report.rows.filter(r => r.state !== 'ok');
    expect(notOk).toEqual([]);
    expect(report.state).toBe('ok');
    expect(exitCode).toBe(0);

    // The proxy self-check really went through the proxy.
    expect(row(report, 'proxy:listening').reason).toMatch(/self-check answered in \d+ms/);
    // This daemon holds its own storage lock, as designed.
    expect(row(report, 'storage:lock').reason).toContain('held by this daemon');
  }, 60_000);

  test('human output is grouped, one line per row, with a summary', async () => {
    await healthAfterFirstTicks();
    const result = await ctx.lazy(['daemon', 'health']);
    expect(result.exitCode).toBe(0);
    for (const heading of ['Daemon', 'Loops', 'Reconciler sweeps', 'Proxy', 'Storage', 'Runner', 'Tasks', 'Dashboard']) {
      expect(result.stdout).toContain(`\n${heading}`);
    }
    expect(result.stdout).toContain('Reconcile loop — last tick finished');
    // Healthy sweeps fold into one line unless --verbose.
    expect(result.stdout).toMatch(/\d+ sweeps? healthy/);
    expect(result.stdout).toMatch(/\d+ OK, 0 WARN, 0 FAIL/);

    const verbose = await ctx.lazy(['daemon', 'health', '--verbose']);
    expect(verbose.stdout).toContain('stranded-working — last ran');
  }, 60_000);

  // INVARIANT: doctor carries ONE line for the daemon's health and points at
  // `lazy daemon health` for the rows — the same finding is never explained
  // on two surfaces (doctor-single-warning-surface).
  test('lazy doctor summarises the report in one line', async () => {
    await healthAfterFirstTicks();
    const result = await ctx.lazy(['doctor']);
    const lines = result.stdout.split('\n').filter(l => l.includes('Daemon health'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Daemon health: all \d+ checks OK/);
  }, 60_000);

  // INVARIANT: the command never starts a daemon. With none running it reports
  // exactly that, as a FAIL, and exits non-zero.
  test('with no daemon running it says so and exits 1, without starting one', async () => {
    const stop = await ctx.lazy(['daemon', 'stop', '--yes']);
    expect(stop.exitCode).toBe(0);

    const result = await ctx.lazy(['daemon', 'health', '--json']);
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as DaemonHealthReport;
    expect(report.state).toBe('fail');
    expect(row(report, 'daemon:running').remedy).toContain('lazy daemon start');

    const status = await ctx.lazy(['daemon', 'status']);
    expect(status.stdout).toContain('Daemon is not running');
  }, 60_000);
});

isolateInProcessDaemonEnv();

describe('daemonHealth RPC (in-process daemon)', () => {
  const TOKEN = 'test-token-daemon-health';
  let ctx: TestContext;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    ctx = await setupTestLazy();
    restoreConfig = pinConfig(ctx.root);
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    daemon = await startDaemonServer({ token: TOKEN, projectRoot: ctx.root, reconcileIntervalSeconds: 1 });
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    restoreConfig?.();
    restoreConfig = undefined;
    await ctx.cleanup();
    restoreDaemonBaseDir?.();
    restoreDaemonBaseDir = undefined;
    await removeDaemonBaseDir(daemonBaseDir);
  });

  async function health(): Promise<DaemonHealthReport> {
    const resp = await fetch(`http://127.0.0.1:${daemon!.webPort}/rpc/daemonHealth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(200);
    return await resp.json() as DaemonHealthReport;
  }

  test('the proxy row is OK while the proxy answers', async () => {
    const report = await health();
    expect(row(report, 'proxy:listening').state).toBe('ok');
    expect(row(report, 'proxy:audit-log').state).toBe('ok');
  });

  // INVARIANT: a daemon whose proxy has stopped answering reports it as a FAIL
  // with a remedy, while the daemon itself keeps serving. This is the failure
  // the command exists for: nothing crashes, and every agent turn fails.
  test('stopping the proxy turns its row into a FAIL with a remedy', async () => {
    await daemon!.proxyServer!.stop(true);

    const report = await health();
    const proxy = row(report, 'proxy:listening');
    expect(proxy.state).toBe('fail');
    expect(proxy.reason).toContain('did not answer');
    expect(proxy.remedy).toContain('lazy daemon restart');
    expect(report.state).toBe('fail');
    // Everything else is still reported — one failing part never hides the rest.
    row(report, 'storage:lock');
    row(report, 'dashboard:bound');
  });

  test('a caller on a different build is told the daemon is not running its code', async () => {
    const resp = await fetch(`http://127.0.0.1:${daemon!.webPort}/rpc/daemonHealth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify({ clientVersion: '0.0.0-elsewhere' }),
    });
    const report = await resp.json() as DaemonHealthReport;
    const match = row(report, 'daemon:build-match');
    expect(match.state).toBe('warn');
    expect(match.reason).toContain('0.0.0-elsewhere');
  });

  test('a malformed parameter is refused, not ignored', async () => {
    const resp = await fetch(`http://127.0.0.1:${daemon!.webPort}/rpc/daemonHealth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify({ clientVersion: 42 }),
    });
    expect(resp.status).toBe(400);
  });
});
