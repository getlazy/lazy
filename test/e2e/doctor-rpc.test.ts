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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
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

  /** Point the project at a local bare \`origin\` with driver = "github"; returns a git-only PATH dir. */
  async function githubProjectWithGitOnlyPath(scratch: string): Promise<string> {
    const bare = join(scratch, 'remote.git');
    for (const argv of [['git', 'init', '--bare', '-q', bare], ['git', '-C', ctx.root, 'remote', 'add', 'origin', bare]]) {
      expect(Bun.spawnSync(argv).exitCode).toBe(0);
    }
    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(tomlPath, 'utf8');
    const edited = toml.replace('driver = "local"', 'driver = "github"');
    expect(edited).not.toBe(toml);
    await writeFile(tomlPath, edited);
    // git only — the shape of the microVM guest image, whatever this machine has installed.
    const binDir = join(scratch, 'bin');
    await mkdir(binDir);
    expect(Bun.spawnSync(['ln', '-s', Bun.which('git')!, join(binDir, 'git')]).exitCode).toBe(0);
    return binDir;
  }

  /** Run doctor.run with \`env\` applied to this process (the in-process daemon's env), restoring it after. */
  async function doctorRunWithEnv(env: Record<string, string>): Promise<any> {
    const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      const ran = await rpc('doctor.run', { alert: false });
      expect(ran.status).toBe(200);
      return ran.body;
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  // INVARIANT: a managed (Teams) daemon measures its repository host through git
  // and the credential helper, not a forge CLI login. The microVM daemon image has
  // no gh; failing on it told members a project whose git worked was unreachable.
  test('managed mode: reachable remote with no forge CLI reports no remote-driver error', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'lazy-doctor-managed-'));
    try {
      const binDir = await githubProjectWithGitOnlyPath(scratch);
      const store = /external_path = "([^"]+)"/.exec(await readFile(join(ctx.root, 'lazy.toml'), 'utf8'))?.[1];
      expect(store).toBeTruthy();
      const report = await doctorRunWithEnv({
        LAZY_TEST_FORCE_MANAGED: '1',
        LAZY_MANAGED_STORAGE_PATH: store!,
        GH_TOKEN: 'test-token',
        PATH: binDir,
      });
      const family = report.checks.filter((c: any) => c.family === 'remote-driver');
      expect(family.find((c: any) => c.title === 'Git can reach and authenticate to remote origin')?.status).toBe('ok');
      expect(family.filter((c: any) => c.status === 'error')).toEqual([]);
      expect(family.find((c: any) => String(c.title).startsWith('GitHub API features'))?.status).toBe('warning');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  // INVARIANT: with gh and the token present — what the microVM daemon image
  // ships — a managed daemon reports the forge API features OK and keeps the
  // driver's own checks as WARNINGS, never errors: none of them stops a push.
  test('managed mode: gh present reports API features OK and driver checks as warnings', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'lazy-doctor-managed-gh-'));
    try {
      const binDir = await githubProjectWithGitOnlyPath(scratch);
      // A gh that installs fine but whose every API call fails, so the driver's
      // own checks produce failures the managed check must downgrade.
      const gh = join(binDir, 'gh');
      await writeFile(gh, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gh version 2.101.0"; exit 0; fi\necho "stub gh: $*" >&2\nexit 1\n');
      expect(Bun.spawnSync(['chmod', '0755', gh]).exitCode).toBe(0);
      const store = /external_path = "([^"]+)"/.exec(await readFile(join(ctx.root, 'lazy.toml'), 'utf8'))?.[1];
      expect(store).toBeTruthy();
      const report = await doctorRunWithEnv({
        LAZY_TEST_FORCE_MANAGED: '1',
        LAZY_MANAGED_STORAGE_PATH: store!,
        GH_TOKEN: 'test-token',
        PATH: binDir,
      });
      const family = report.checks.filter((c: any) => c.family === 'remote-driver');
      expect(family.find((c: any) => String(c.title).startsWith('GitHub API features'))?.status).toBe('ok');
      expect(family.filter((c: any) => c.status === 'error')).toEqual([]);
      // The driver's own rows are kept: it finds the stub gh, and the stub's
      // failing `auth status` is downgraded from a failure to a warning.
      expect(family.find((c: any) => c.title === 'gh CLI installed')?.status).toBe('ok');
      expect(family.find((c: any) => String(c.title).startsWith('GitHub authentication'))?.status).toBe('warning');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  // INVARIANT: outside Teams the repository-host check is the driver's own —
  // a laptop's pushes and PRs go through the human's gh login, so no gh is an error there.
  test('unmanaged: the github driver still requires the gh CLI', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'lazy-doctor-laptop-'));
    try {
      const binDir = await githubProjectWithGitOnlyPath(scratch);
      const report = await doctorRunWithEnv({ PATH: binDir });
      const family = report.checks.filter((c: any) => c.family === 'remote-driver');
      expect(family.find((c: any) => c.title === 'gh CLI installed')?.status).toBe('error');
      expect(family.find((c: any) => String(c.title).startsWith('Git can reach'))).toBeUndefined();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

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

/**
 * INVARIANT: doctor run INSIDE the daemon (Teams' doctor.run, the dashboard's
 * Doctor page) reports a healthy daemon's storage lock as OK. In-process the
 * daemon must not RPC itself, so the storage probe has no remote client; it used
 * to read that absence as "did not answer a storage read" and told every Teams
 * member "Tasks in this project can't run right now" about a healthy daemon.
 */
describe('doctor RPC — storage lock inside the daemon', () => {
  let ctx: TestContext;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;
  let prevIsDaemon: string | undefined;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    prevIsDaemon = process.env.LAZY_IS_DAEMON;
    ctx = await setupTestLazy();
    restoreConfig = pinConfig(ctx.root);
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    daemon = await startDaemonServer({ token: TOKEN, projectRoot: ctx.root });
    process.env.LAZY_IS_DAEMON = '1';
  });

  afterEach(async () => {
    if (prevIsDaemon === undefined) delete process.env.LAZY_IS_DAEMON;
    else process.env.LAZY_IS_DAEMON = prevIsDaemon;
    if (daemon) await daemon.stop();
    daemon = undefined;
    restoreConfig?.();
    await ctx.cleanup();
    restoreDaemonBaseDir?.();
    await removeDaemonBaseDir(daemonBaseDir);
  });

  test('a healthy daemon is never reported as not serving storage', async () => {
    const resp = await fetch(`http://127.0.0.1:${daemon!.webPort}/rpc/doctor.run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'X-Lazy-Project': ctx.root,
      },
      body: JSON.stringify({ alert: false }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { checks: Array<{ title: string; status: string; family?: string }> };
    const lock = body.checks.filter(c => c.family === 'storage-lock');
    expect(lock.length).toBeGreaterThan(0);
    for (const c of lock) {
      expect(c.title).not.toContain('not serving storage');
      expect(c.status).toBe('ok');
    }
    expect(lock.some(c => c.title.includes('as designed'))).toBe(true);
    expect(body.checks.some(c => c.title.includes('(skipped —'))).toBe(false);
  }, 60_000);
});
