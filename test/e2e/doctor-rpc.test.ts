/**
 * Doctor report over the daemon RPC — the surface the Settings page will call.
 *
 * Talks to an in-process daemon over its TCP port, same contract as
 * project-settings-rpc.test.ts. `doctor.run` executes the shared sweep;
 * `doctor.report` returns the last snapshot.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { readSystemMessagesFile } from '../helpers/storage';

const TOKEN = 'test-token-doctor-rpc';

isolateInProcessDaemonEnv();

describe('doctor RPC', () => {
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
    daemon = await startDaemonServer({ token: TOKEN, projectRoot: ctx.root });
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

  async function rpc(command: string, params: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
    const resp = await fetch(`http://127.0.0.1:${daemon!.webPort}/rpc/${command}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify(params),
    });
    return { status: resp.status, body: await resp.json() };
  }

  test('doctor.report is null before any run', async () => {
    const { status, body } = await rpc('doctor.report');
    expect(status).toBe(200);
    expect(body).toBeNull();
  });

  test('doctor.run returns a structured report and doctor.report remembers it', async () => {
    const ran = await rpc('doctor.run');
    expect(ran.status).toBe(200);
    expect(ran.body.ranAt).toBeTruthy();
    expect(Array.isArray(ran.body.checks)).toBe(true);
    expect(ran.body.checks.length).toBeGreaterThan(0);
    expect(ran.body.checks[0]).toHaveProperty('id');
    expect(ran.body.checks[0]).toHaveProperty('title');
    expect(ran.body.checks[0]).toHaveProperty('status');
    expect(typeof ran.body.errorCount).toBe('number');

    const remembered = await rpc('doctor.report');
    expect(remembered.status).toBe(200);
    expect(remembered.body.report.ranAt).toBe(ran.body.ranAt);
    expect(remembered.body.report.checks).toEqual(ran.body.checks);
  });

  test('doctor.run files an inbox alert when a check fails', async () => {
    // Break lazy.toml AFTER the daemon is up — it already loaded a valid
    // file, so it keeps serving, but the sweep's first project check is
    // "lazy.toml parses" and that becomes an error. (A stranded `merging`
    // task cannot force this: the daemon recovers those on startup.)
    const tomlPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(tomlPath, 'utf-8');
    await writeFile(tomlPath, before + '\nthis is not = toml\n');

    const ran = await rpc('doctor.run');
    expect(ran.status).toBe(200);
    expect(ran.body.errorCount).toBeGreaterThan(0);
    expect(ran.body.checks.some((c: { id: string; status: string }) =>
      c.status === 'error' && (c.id === 'lazy-toml-parses' || c.id.includes('toml')),
    )).toBe(true);

    const stored = readSystemMessagesFile(ctx.root);
    const alerts = stored.filter(m => m.source === 'doctor' && m.title === 'lazy doctor found issues');
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts[0]!.body).toContain('lazy.toml');

    // Put a valid file back so afterEach cleanup can still read lazy.toml.
    await writeFile(tomlPath, before);
  });

  // INVARIANT: `alert: false` runs the sweep without filing the inbox alert.
  // Lazy Teams passes it: its members read the project inbox, and the alert
  // tells them to run `lazy doctor` — an ops instruction they must never get.
  test('doctor.run with alert:false files no inbox alert but still stores the report', async () => {
    const tomlPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(tomlPath, 'utf-8');
    await writeFile(tomlPath, before + '\nthis is not = toml\n');

    const ran = await rpc('doctor.run', { alert: false });
    expect(ran.status).toBe(200);
    expect(ran.body.errorCount).toBeGreaterThan(0);

    const stored = readSystemMessagesFile(ctx.root);
    expect(stored.filter(m => m.source === 'doctor')).toEqual([]);
    const remembered = await rpc('doctor.report');
    expect(remembered.body.report.ranAt).toBe(ran.body.ranAt);

    await writeFile(tomlPath, before);
  });

  test('doctor.run refuses a non-boolean alert', async () => {
    const ran = await rpc('doctor.run', { alert: 'no' });
    expect(ran.status).toBe(400);
  });
});
