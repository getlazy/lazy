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
import { mkdir, mkdtemp, readFile, rm, writeFile, rename } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readSystemMessagesFile, taskFilePath, tasksDirFor } from '../helpers/storage';
import { installFakeDocker } from '../helpers/fake-docker';
import { applyRemedy } from '../../src/doctor/remedies';
import { withTaskLifecycleLock, isTaskLifecycleLocked } from '../../src/daemon/task-lifecycle-lock';

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

  test('doctor.run streams the checklist through the heartbeat envelope', async () => {
    const response = await fetch(`http://127.0.0.1:${daemon!.webPort}/rpc/doctor.run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TOKEN}`,
        'X-Lazy-Project': ctx.root,
        'X-Lazy-Heartbeat': '1',
      },
      body: JSON.stringify({ alert: false }),
    });
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const frames = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    const events = frames.filter(frame => frame.progress).map(frame => frame.progress);
    expect(events[0].kind).toBe('plan');
    expect(events[0].operation).toBe('doctor');
    expect(events[0].phases).toHaveLength(8);
    expect(events.some(event => event.kind === 'phase' && event.id === 'runner' && event.state === 'start')).toBe(true);
    expect(frames.at(-1).status).toBe(200);
    expect(frames.at(-1).body.checks.length).toBeGreaterThan(0);
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

  // INVARIANT: the remedy Teams applies unattended cannot delete an open
  // task's container, running or stopped. Exercise the real daemon boundary.
  test('Teams unattended orphan cleanup keeps open tasks and removes only finished or deleted tasks', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'lazy-doctor-orphans-'));
    const docker = await installFakeDocker(scratch);
    const savedPath = process.env.PATH;
    try {
      const storage = await import('../../src/daemon/rpc-handlers').then(m => m.getOrCreateStorage());
      const open = await storage.createTask('Paused work');
      await storage.updateTaskStatus(open.id, 'working', 'system');
      await storage.updateTaskStatus(open.id, 'blocked', 'system');
      const finished = await storage.createTask('Finished work');
      await storage.updateTaskStatus(finished.id, 'abandoned', 'system');
      const runner = await import('../../src/runner').then(m => m.createRunnerFromType('docker'));
      const { taskRef } = await import('../../src/task/identity');
      const openName = runner.runNameForTask(taskRef(open));
      const finishedName = runner.runNameForTask(taskRef(finished));
      const gateName = `lazy-gate-${taskRef(open)}`;
      process.env.PATH = `${docker.binDir}:${savedPath ?? ''}`;
      for (const state of ['running', 'exited']) {
        await docker.seedContainer(openName, { state, project: ctx.root });
        await docker.seedContainer(gateName, { state, project: ctx.root });
        await docker.seedContainer(finishedName, { state, project: ctx.root });
        await docker.seedContainer('lazy-deleted-task', { state, project: ctx.root });
        const preview = await rpc('doctor.previewRemedy', { flag: 'clean-orphaned-containers' });
        expect(preview.status).toBe(200);
        expect(JSON.stringify(preview.body)).not.toContain(openName);
        expect(JSON.stringify(preview.body)).not.toContain(gateName);
        const result = await rpc('doctor.applyRemedy', { flag: 'clean-orphaned-containers' });
        expect(result.status).toBe(200);
        expect(result.body.failed).toBe(false);
        expect(result.body.done).toBe(2);
        expect(await docker.containers()).toEqual([openName, gateName]);
      }
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  // INVARIANT: an incomplete task scan must refuse unattended destruction.
  // Exercise enumeration AFTER the daemon opened its store, so init cannot
  // mask the very listTasks error that formerly turned live tasks into deleted ones.
  test('unattended orphan cleanup refuses unreadable records and task enumeration failures', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'lazy-doctor-unreadable-'));
    const docker = await installFakeDocker(scratch);
    const savedPath = process.env.PATH;
    const storage = await import('../../src/daemon/rpc-handlers').then(m => m.getOrCreateStorage());
    const task = await storage.createTask('Paused work');
    const record = taskFilePath(ctx.root, task.id, 'task.json');
    const original = await readFile(record, 'utf8');
    const tasksDir = tasksDirFor(ctx.root);
    try {
      process.env.PATH = `${docker.binDir}:${savedPath ?? ''}`;
      await docker.seedContainer(`lazy-${task.id.slice(0, 8)}`, { project: ctx.root });
      await writeFile(record, '{broken json');
      const unreadable = await rpc('doctor.applyRemedy', { flag: 'clean-orphaned-containers' });
      expect(unreadable.status).toBe(500);
      expect(JSON.stringify(unreadable.body)).toContain('unreadable task record');
      await writeFile(record, original);
      await rename(tasksDir, `${tasksDir}-saved`);
      try {
        await writeFile(tasksDir, 'not a directory');
        const unlisted = await rpc('doctor.applyRemedy', { flag: 'clean-orphaned-containers' });
        expect(unlisted.status).toBe(500);
        expect(JSON.stringify(unlisted.body)).toContain('could not read tasks directory');
      } finally {
        await rm(tasksDir, { force: true });
        await rename(`${tasksDir}-saved`, tasksDir);
      }
      expect(await docker.containers()).toEqual([`lazy-${task.id.slice(0, 8)}`]);
      expect((await docker.invocations()).some(line => line.startsWith('rm '))).toBe(false);
    } finally {
      await writeFile(record, original);
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  // INVARIANT: the scan is a proposal, never permission to delete after a
  // task reopens. Re-read ownership under the lifecycle lock before removal.
  test('orphan cleanup preserves a task reopened after scanning, including its session pointer', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'lazy-doctor-reopen-'));
    const docker = await installFakeDocker(scratch);
    const savedPath = process.env.PATH;
    const storage = await import('../../src/daemon/rpc-handlers').then(m => m.getOrCreateStorage());
    const task = await storage.createTask('Reopened during cleanup');
    const name = `lazy-${task.id.slice(0, 8)}`;
    const head = (await ctx.git('rev-parse', 'HEAD')).stdout.trim();
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/reopen-fixture', head);
    await storage.updateSessionContainerName(session.id, name);
    await storage.updateTaskStatus(task.id, 'abandoned', 'system');
    let reopening: Promise<unknown> | undefined;
    try {
      process.env.PATH = `${docker.binDir}:${savedPath ?? ''}`;
      await docker.seedContainer(name, { project: ctx.root });
      const result = await applyRemedy('clean-orphaned-containers', {
        root: ctx.root,
        storage,
        onProgress: event => {
          if (event.state === 'start' && event.label.startsWith('Removing ')) {
            // Queue the reopen transition first, deterministically, after the
            // candidate scan. Fixture writes use the real Storage backend.
            reopening = withTaskLifecycleLock(task.id, () => storage.reopenTask(task.id));
          }
        },
      });
      await reopening;
      expect(reopening).toBeDefined();
      expect((await storage.getTask(task.id))?.status).toBe('blocked');
      expect(result.failed).toBe(false);
      expect(result.done).toBe(0);
      expect(result.lines.join('\n')).toContain(`Kept ${name}`);
      expect(await docker.containers()).toEqual([name]);
      expect((await storage.getSession(session.id))?.container_name).toBe(name);
      expect((await docker.invocations()).some(line => line.startsWith('rm '))).toBe(false);
    } finally {
      await reopening;
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  // INVARIANT: reopening and destruction cannot interleave after the final
  // ownership check. A reopen arriving during runtime removal waits for it.
  test('reopen waits until an in-flight orphan removal and pointer update finish', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'lazy-doctor-removing-'));
    const docker = await installFakeDocker(scratch);
    const savedPath = process.env.PATH;
    const storage = await import('../../src/daemon/rpc-handlers').then(m => m.getOrCreateStorage());
    const task = await storage.createTask('Reopen behind removal');
    const name = `lazy-${task.id.slice(0, 8)}`;
    const branch = `lazy/${task.id.slice(0, 8)}`;
    expect((await ctx.git('branch', branch)).exitCode).toBe(0);
    const head = (await ctx.git('rev-parse', 'HEAD')).stdout.trim();
    const session = await storage.createSession(task.id, 'claude-code', branch, head);
    await storage.updateSessionContainerName(session.id, name);
    await storage.updateTaskStatus(task.id, 'abandoned', 'system');
    const marker = join(scratch, 'removing');
    const release = join(scratch, 'release');
    // Paths are generated temporary paths, shell-quoted rather than JSON-quoted.
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await docker.onRm(`touch ${quote(marker)}\nfor i in {1..1000}; do\n  test -f ${quote(release)} && exit 0\n  sleep 0.01\ndone\nexit 1\n`);
    let cleaning: ReturnType<typeof applyRemedy> | undefined;
    let reopening: ReturnType<typeof rpc> | undefined;
    try {
      process.env.PATH = `${docker.binDir}:${savedPath ?? ''}`;
      await docker.seedContainer(name, { project: ctx.root });
      cleaning = applyRemedy('clean-orphaned-containers', { root: ctx.root, storage });
      const deadline = Date.now() + 5000;
      while (!(await Bun.file(marker).exists()) && Date.now() < deadline) await Bun.sleep(10);
      expect(await Bun.file(marker).exists()).toBe(true);
      expect(isTaskLifecycleLocked(task.id)).toBe(true);
      reopening = rpc('reopenTask', { taskId: task.id, reason: 'More work' });
      const settled = await Promise.race([
        reopening.then(() => true),
        Bun.sleep(100).then(() => false),
      ]);
      expect(settled).toBe(false);
      expect((await storage.getTask(task.id))?.status).toBe('abandoned');
      await writeFile(release, 'go');
      expect((await cleaning).done).toBe(1);
      expect((await reopening).status).toBe(200);
      expect((await storage.getTask(task.id))?.status).toBe('blocked');
      expect((await storage.getSession(session.id))?.container_name).toBeNull();
      expect(await docker.containers()).toEqual([]);
    } finally {
      await writeFile(release, 'go');
      await Promise.allSettled([cleaning, reopening]);
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      await rm(scratch, { recursive: true, force: true });
    }
  });

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

  // INVARIANT: Teams assigns the project store and its members use their own
  // terminals; the managed Doctor report must not diagnose the daemon's shell.
  test('managed doctor omits terminal checks and repository storage notices', async () => {
    const store = /external_path = "([^"]+)"/.exec(await readFile(join(ctx.root, 'lazy.toml'), 'utf8'))?.[1];
    expect(store).toBeTruthy();
    const report = await doctorRunWithEnv({
      LAZY_TEST_FORCE_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: store!, SHELL: '',
    });
    const titles = report.checks.map((check: any) => check.title);
    expect(titles.some((title: string) => title.startsWith('Shell detected'))).toBe(false);
    expect(titles.some((title: string) => title.startsWith('Completions installed'))).toBe(false);
    expect(titles.some((title: string) => title.startsWith('tmux'))).toBe(false);
    expect(titles.some((title: string) => title.startsWith("lazy.toml 'storage."))).toBe(false);
  });

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
      expect(family.find((c: any) => c.title === "gh CLI isn't installed")?.status).toBe('error');
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
    expect(lock.some(c => c.title.includes('(skipped —'))).toBe(false);
  }, 60_000);
});
