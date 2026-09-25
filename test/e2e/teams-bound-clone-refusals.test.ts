/**
 * A bound clone refuses the commands that operate the LOCAL machine, by name,
 * rather than failing obscurely against infrastructure that was never there
 * (design doc §4.4, §4.7, §7.2 task 9).
 *
 * The login record itself is written directly with `writeTeamsLogin` rather
 * than driven through the full device-authorization flow — that round trip is
 * already proven end to end in `test/e2e/teams-login.test.ts`; this suite is
 * about what a clone that IS bound does with commands that were never part of
 * that flow.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { writeTeamsLogin } from '../../src/teams/login';
import { runGit } from '../../src/utils/git';

describe('a bound clone refuses local-machine commands', () => {
  let ctx: TestContext;
  let tmpHome: string;
  let daemonBase: string;
  let unpin: () => void;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-bound-home-'));
    daemonBase = await mkdtemp(join(tmpdir(), 'lzd-bound-'));
    unpin = pinDaemonBaseDir(daemonBase);

    await writeTeamsLogin(ctx.root, {
      teamsUrl: 'https://teams.example.com',
      token: 'lz_cli_token_abc',
      project: 'acme/lazy-toy',
      projectId: '42',
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
    unpin();
    await rm(tmpHome, { recursive: true, force: true });
    await rm(daemonBase, { recursive: true, force: true });
  });

  const env = () => ({ HOME: tmpHome, LAZY_DAEMON_BASE_DIR: daemonBase });

  test('daemon start refuses by name, naming lazy logout', async () => {
    const result = await ctx.lazy(['daemon', 'start'], { env: env() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bound to https://teams.example.com');
    expect(result.stderr).toContain('lazy logout');
  });

  test('daemon status and daemon stop refuse the same way', async () => {
    const status = await ctx.lazy(['daemon', 'status'], { env: env() });
    expect(status.exitCode).toBe(1);
    expect(status.stderr).toContain('lazy logout');

    const stop = await ctx.lazy(['daemon', 'stop'], { env: env() });
    expect(stop.exitCode).toBe(1);
    expect(stop.stderr).toContain('lazy logout');
  });

  test('the dashboard refuses — there is no local daemon to serve it', async () => {
    const result = await ctx.lazy(['dashboard'], { env: env() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('lazy logout');
  });

  test('doctor refuses — there is no local machine to diagnose', async () => {
    const result = await ctx.lazy(['doctor'], { env: env() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bound to https://teams.example.com');
    expect(result.stderr).toContain('lazy logout');
  });

  test('a fleet-wide command like `daemon list` is left alone', async () => {
    // Host-diagnostic, not "operate my daemon" — a bound clone is still one
    // machine that might have OTHER, unbound projects on it.
    const result = await ctx.lazy(['daemon', 'list'], { env: env() });

    expect(result.stderr).not.toContain('bound to');
  });

  test('init refuses in a fresh directory the clone is bound at, before .lazy/ exists', async () => {
    const freshDir = await mkdtemp(join(tmpdir(), 'lazy-bound-fresh-'));
    try {
      await runGit(['init'], { cwd: freshDir });
      await writeTeamsLogin(freshDir, {
        teamsUrl: 'https://teams.example.com',
        token: 'lz_cli_token_xyz',
        project: 'acme/other',
        projectId: '7',
      });

      const result = await ctx.lazy(['init'], { cwd: freshDir, env: env() });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('bound to https://teams.example.com');
      expect(result.stderr).toContain('lazy logout');
    } finally {
      await rm(freshDir, { recursive: true, force: true });
    }
  });
});
