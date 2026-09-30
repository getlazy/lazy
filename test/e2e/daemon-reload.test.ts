/**
 * `lazy daemon status` names the lazy.toml in force and the startup-only
 * settings pending from it; `lazy daemon reload` applies what needs no
 * restart; and a lazy.toml that stops loading leaves the daemon on its last
 * good config, reported rather than fatal.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile, writeFile, realpath } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { checkDaemonHealth } from '../../src/daemon/lifecycle';

const CONFIGURED = 'https://lazy.example.com';

describe('lazy daemon status / reload', () => {
  let ctx: TestContext;
  let configPath: string;
  let original: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    configPath = `${ctx.root}/lazy.toml`;
    original = await readFile(configPath, 'utf-8');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function setDashboardUrl(): Promise<void> {
    const edited = original.replace('[server]\n', `[server]\ndashboard_url = "${CONFIGURED}"\n`);
    expect(edited).not.toBe(original);
    await writeFile(configPath, edited);
  }

  async function breakConfig(): Promise<void> {
    await writeFile(configPath, `${original}\n[server\nthis is not toml\n`);
  }

  test('status names the config file in force and the rule that chose it', async () => {
    const status = await ctx.lazy(['daemon', 'status']);
    expectSuccess(status);
    expect(status.stdout).toContain('Config:');
    expect(status.stdout).toContain('lazy.toml');
    expect(status.stdout).toContain("project root's lazy.toml");

    const json = await ctx.lazy(['daemon', 'status', '--json']);
    expectSuccess(json);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.running).toBe(true);
    expect(await realpath(parsed.config.path)).toBe(await realpath(configPath));
    expect(parsed.config.rule).toBe('project-root');
    expect(parsed.config.pending).toEqual([]);
    expect(parsed.config.lastKnownGood).toBeNull();
  });

  // INVARIANT: a startup-only setting edited on a running daemon is shown as
  // pending, with the command that applies it. Before this, nothing said the
  // edit had not taken effect.
  test('status shows an edited dashboard_url as pending, applied by reload', async () => {
    await setDashboardUrl();
    const status = await ctx.lazy(['daemon', 'status']);
    expectSuccess(status);
    const line = status.stdout.split('\n').find((l) => l.includes('server.dashboard_url'));
    expect(line).toBeDefined();
    expect(line).toContain(CONFIGURED);
    expect(line).toContain('pending');
    expect(line).toContain('lazy daemon reload');

    const json = JSON.parse((await ctx.lazy(['daemon', 'status', '--json'])).stdout);
    expect(json.config.pending).toContainEqual(expect.objectContaining({
      key: 'server.dashboard_url', configured: CONFIGURED, applyBy: 'reload',
    }));
  });

  // INVARIANT: reload applies dashboard_url in place — every surface that
  // prints the address uses the new origin with no restart.
  test('reload applies dashboard_url without a restart', async () => {
    const before = (await ctx.lazy(['daemon', 'status', '--json']));
    const pidBefore = JSON.parse(before.stdout).pid;
    await setDashboardUrl();

    const reload = await ctx.lazy(['daemon', 'reload']);
    expectSuccess(reload);
    expect(reload.stdout).toContain('Applied: server.dashboard_url');
    expect(reload.stdout).toContain(CONFIGURED);

    const address = await ctx.lazy(['daemon', 'dashboard-url']);
    expectSuccess(address);
    expect(address.stdout.trim()).toBe(CONFIGURED);
    expect(address.stderr).not.toContain('dashboard_url');

    const after = JSON.parse((await ctx.lazy(['daemon', 'status', '--json'])).stdout);
    expect(after.pid).toBe(pidBefore);
    expect(after.dashboardUrl).toBe(CONFIGURED);
    expect(after.config.pending).toEqual([]);

    // Sign-in links follow the new origin, with nothing to warn about.
    const printed = await ctx.lazy(['dashboard', '--print']);
    expectSuccess(printed);
    expect(new URL(printed.stdout.trim()).origin).toBe(CONFIGURED);
    expect(printed.stderr).not.toContain('dashboard_url');

    // The dashboard's host gate moved with it: the configured host is let
    // through, the local address it replaced is refused.
    const port = (await checkDaemonHealth(ctx.root)).webPort!;
    const hostStatus = async (host: string) => (await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      headers: { host }, redirect: 'manual',
    })).status;
    expect(await hostStatus('lazy.example.com')).not.toBe(421);
    expect(await hostStatus(`lazy.localhost:${port}`)).toBe(421);
  });

  test('reload re-arms an edited sync_interval', async () => {
    // The init template only carries a commented-out sync_interval.
    const edited = original.replace('[server]\n', '[server]\nsync_interval = 17\n');
    expect(edited).not.toBe(original);
    await writeFile(configPath, edited);
    const before = JSON.parse((await ctx.lazy(['daemon', 'status', '--json'])).stdout);
    expect(before.config.pending).toContainEqual(expect.objectContaining({ key: 'server.sync_interval', applyBy: 'reload' }));
    const reload = await ctx.lazy(['daemon', 'reload']);
    expectSuccess(reload);
    expect(reload.stdout).toContain('Applied: server.sync_interval');
    const after = JSON.parse((await ctx.lazy(['daemon', 'status', '--json'])).stdout);
    expect(after.config.pending).toEqual([]);
  });

  test('reload names what still needs a restart and changes nothing for it', async () => {
    await writeFile(configPath, original.replace(/port = \d+/, 'port = 26999'));
    const reload = await ctx.lazy(['daemon', 'reload', '--json']);
    expectSuccess(reload);
    const result = JSON.parse(reload.stdout);
    expect(result.reloaded).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.needsRestart).toContainEqual(expect.objectContaining({ key: 'server.port', applyBy: 'restart' }));
  });

  // INVARIANT: a broken lazy.toml never takes a running daemon down — it keeps
  // the last config it loaded from the same file, and says so.
  test('a broken lazy.toml keeps the daemon on its last good config, reported', async () => {
    await breakConfig();

    // Still serving commands that read config.
    expectSuccess(await ctx.lazy(['list']));

    const status = await ctx.lazy(['daemon', 'status']);
    expectSuccess(status);
    expect(status.stdout).toContain('does NOT load');
    expect(status.stdout).toContain('last');
    expect(status.stdout).toContain('good config');

    const json = JSON.parse((await ctx.lazy(['daemon', 'status', '--json'])).stdout);
    expect(json.config.lastKnownGood).not.toBeNull();
    expect(await realpath(json.config.lastKnownGood.path)).toBe(await realpath(configPath));
    expect(json.config.lastKnownGood.error.length).toBeGreaterThan(0);

    const doctor = await ctx.lazy(['doctor']);
    expect(doctor.stdout).toContain('lazy.toml parses');
    expect(doctor.stdout).toContain('last good config');

    // Reported ONCE per episode, however many reads hit the broken file.
    await ctx.lazy(['daemon', 'status']);
    const messages = await ctx.lazy(['messages']);
    expect(messages.stdout.split('running on its last good config').length - 1).toBe(1);

    // While broken, nothing points at a restart, which could not start.
    const brokenStatus = await ctx.lazy(['daemon', 'status']);
    expect(brokenStatus.stdout).toContain('a daemon cannot START on this file');

    // Fixed: back on the file, nothing reported.
    await writeFile(configPath, original);
    const healed = JSON.parse((await ctx.lazy(['daemon', 'status', '--json'])).stdout);
    expect(healed.config.lastKnownGood).toBeNull();
  });

  // INVARIANT: reload of a file that does not load is refused with its error,
  // and the running config stays.
  test('reload of a broken lazy.toml is refused and changes nothing', async () => {
    const served = JSON.parse((await ctx.lazy(['daemon', 'status', '--json'])).stdout).dashboardUrl;
    await breakConfig();

    const reload = await ctx.lazy(['daemon', 'reload']);
    expect(reload.exitCode).not.toBe(0);
    expect(reload.stderr).toContain('does not load');
    expect(reload.stderr).toContain('keeps its running config');

    const address = await ctx.lazy(['daemon', 'dashboard-url']);
    expectSuccess(address);
    expect(address.stdout.trim()).toBe(served);
  });
});
