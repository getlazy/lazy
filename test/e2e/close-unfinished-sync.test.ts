import { tmpdir } from 'os';
import { describe, test, expect, afterEach } from 'bun:test';
import { writeFile, mkdir, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess, expectFailure } from '../helpers/assertions';
import { successScenario, sessionStartEvent } from '../helpers/fake-claude';
import { worktreePathFor, readSessionJson, readTaskJson } from '../helpers/storage';
import { installFakeDocker } from '../helpers/fake-docker';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { RemoteStorage } from '../../src/storage/remote-storage';
import { consumeResponse, protocolDir } from '../../src/protocol';

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

async function eventually(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Opt-in (LAZY_SCREENSHOTS=1) review captures: the CLI refusal as text and
// the dashboard's Close dialog offering the confirmed abort, driven through
// chromedriver so the dialog's own script renders the refusal.
async function captureUnprovenMergeScreens(ctx: TestContext, command: string, taskId: string) {
  const out = join(import.meta.dir, '../../.lazy-task-sandbox');
  await mkdir(out, { recursive: true });
  const cli = await ctx.lazy([command, taskId, '--reason', 'Superseded', '--yes']);
  expectFailure(cli);
  await writeFile(join(out, `cli-${command}-unproven-merge.txt`), cli.stdout + cli.stderr);
  if (command !== 'close') return;
  const dashboard = await ctx.lazy(['dashboard', '--no-open']);
  expectSuccess(dashboard);
  const login = new URL((dashboard.stdout + dashboard.stderr).match(/https?:\/\/[^\s]+/)![0]);
  const port = 9600 + Math.floor(Math.random() * 300);
  const driver = Bun.spawn([process.env.CHROMEDRIVER_BIN ?? 'chromedriver', `--port=${port}`], { stdout: 'ignore', stderr: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return (await res.json() as { value: any }).value;
  };
  try {
    await eventually(async () => fetch(base + '/status').then(r => r.ok, () => false), 'chromedriver');
    const session = await call('POST', '/session', { capabilities: { alwaysMatch: { 'goog:chromeOptions': {
      binary: process.env.CHROME_BIN ?? '/usr/local/bin/chromium',
      args: ['--headless', '--no-sandbox', '--disable-gpu', '--window-size=1400,1100'] } } } });
    const sid = session.sessionId as string;
    const exec = (script: string) => call('POST', `/session/${sid}/execute/sync`, { script, args: [] });
    await call('POST', `/session/${sid}/url`, { url: login.toString() });
    const page = new URL(login.toString()); page.pathname = `/tasks/${taskId}`; page.search = '';
    await call('POST', `/session/${sid}/url`, { url: page.toString() });
    await exec(`document.querySelector('[data-lz-action-open="close"]').click();`);
    await eventually(async () => await exec(`return !!document.querySelector('dialog[open] textarea[name="reason"], dialog[open] input[name="reason"]')`), 'close dialog');
    await exec(`const f = document.querySelector('dialog[open] form[data-lz-action-form]'); f.querySelector('[name="reason"]').value = 'Superseded'; f.requestSubmit();`);
    await eventually(async () => await exec(`return !!document.querySelector('.lz-action-confirm button')`), 'abort-merge confirm');
    const png = await call('GET', `/session/${sid}/screenshot`);
    await writeFile(join(out, 'dashboard-close-unproven-merge.png'), Buffer.from(png, 'base64'));
    await call('DELETE', `/session/${sid}`);
  } finally {
    driver.kill();
  }
}

describe('abandon an unfinished sync', () => {
  let ctx: TestContext;
  const temporaryDirs: string[] = [];
  afterEach(async () => {
    if (ctx) await ctx.cleanup();
    await Promise.all(temporaryDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  for (const command of ['close', 'reject']) {
    // INVARIANT: abandoning an interrupted lazy sync discards the merge, never
    // a committed change. This exercises the real supervisor and its checkpoint.
    for (const stopFirst of [true, false]) {
      test(`${command} aborts a ${stopFirst ? 'stopped' : 'running'} sync and preserves the branch head`, async () => {
        ctx = await setupTestLazy({ fakeClaude: true });
        const configPath = join(ctx.root, 'lazy.toml');
        const config = await Bun.file(configPath).text();
        const updated = config.replace('# mode = "low_high"', 'mode = "off"');
        expect(updated).not.toBe(config);
        await writeFile(configPath, updated);
        const taskId = await createTask(ctx, 'Abandon this sync', 'Do some work');
        await ctx.setClaudeScenario(successScenario({
          commit: { message: 'Task work', files: [{ path: 'shared.txt', content: 'task\n' }] },
        }));
        expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
        expectSuccess(await ctx.lazy(['wait', taskId]));
        const worktree = worktreePathFor(ctx.root, taskId);
        const head = git(worktree, 'rev-parse', 'HEAD').stdout.trim();
        const branch = readSessionJson(ctx.root, taskId)!.git_branch as string;
        await writeFile(join(ctx.root, 'shared.txt'), 'parent\n');
        expect(ctx.git('add', 'shared.txt').exitCode).toBe(0);
        expect(ctx.git('commit', '-m', 'Conflicting parent work').exitCode).toBe(0);
        const hold = join(ctx.root, 'hold-sync');
        await writeFile(hold, 'hold');
        await ctx.setClaudeScenario({ steps: [
          { kind: 'emit', event: sessionStartEvent('held-sync') },
          { kind: 'hold-while-file', path: hold },
        ] });
        await ctx.clearClaudeInvocations();
        expectSuccess(await ctx.lazy(['sync', taskId]));
        await eventually(async () => (await ctx.claudeInvocations()).length > 0, 'conflict-resolution agent');
        await eventually(() => git(worktree, 'rev-parse', '--verify', 'MERGE_HEAD').exitCode === 0, 'sync merge');
        if (stopFirst) expectSuccess(await ctx.lazy(['stop', taskId, '--reason', 'Abandon the sync', '--yes']));
        expect(git(worktree, 'diff', '--name-only', '--diff-filter=U').stdout).toContain('shared.txt');
        const result = await ctx.lazy([command, taskId, '--reason', 'Superseded', '--yes']);
        expectSuccess(result);
        expect(result.stdout + result.stderr).toContain('Aborted the unfinished sync merge (1 conflict)');
        expect(result.stdout + result.stderr).toContain(head.substring(0, 7));
        if (process.env.LAZY_SCREENSHOTS === '1' && stopFirst) {
          await writeFile(join(tmpdir(), `lazy-${command}-unfinished-sync.txt`), result.stdout + result.stderr);
          if (command === 'close') {
            const dashboard = await ctx.lazy(['dashboard', '--no-open']);
            expectSuccess(dashboard);
            const address = (dashboard.stdout + dashboard.stderr).match(/https?:\/\/[^\s]+/)?.[0];
            expect(address).toBeDefined();
            const url = new URL(address!);
            url.pathname = `/tasks/${taskId}`;
            const notice = (result.stdout + result.stderr).split('\n').find(line => line.startsWith('Aborted the unfinished'))!;
            url.searchParams.set('flash', `Closed. ${notice}`);
            const out = join(import.meta.dir, '../../.lazy-task-sandbox');
            await mkdir(out, { recursive: true });
            const profile = join(tmpdir(), `lazy-dashboard-capture-${taskId}`);
            for (const [width, height, suffix] of [[1400, 1200, ''], [390, 844, '-phone']] as const) {
              const browser = Bun.spawn([process.env.CHROME_BIN ?? '/usr/bin/chromium', '--headless', '--disable-gpu', '--no-sandbox',
                `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
                `--screenshot=${join(out, `dashboard-close-unfinished-sync${suffix}.png`)}`, url.toString()],
                { stdout: 'ignore', stderr: 'ignore' });
              expect(await browser.exited).toBe(0);
              url.searchParams.delete('lazy_login');
            }
          }
        }
        expect(ctx.git('rev-parse', branch).stdout.trim()).toBe(head);
        const shown = await ctx.lazy(['show', taskId, '--json']);
        expectSuccess(shown);
        expect(JSON.parse(shown.stdout).status).toBe('abandoned');
        if (await Bun.file(join(worktree, '.git')).exists()) {
          expect(git(worktree, 'rev-parse', '--verify', 'MERGE_HEAD').exitCode).not.toBe(0);
        }
      }, 120_000);
    }

    // INVARIANT: resolving the origin conflict does not consume the ability
    // to abandon the parent conflict; only the unfinished merge is discarded.
    test(`${command} abandons the second conflict after the first sync step committed`, async () => {
      ctx = await setupTestLazy({ fakeClaude: true });
      const configPath = join(ctx.root, 'lazy.toml');
      const config = await Bun.file(configPath).text();
      const updated = config.replace('driver = "local"', 'driver = "github"')
        .replace('# mode = "low_high"', 'mode = "off"');
      expect(updated).not.toBe(config);
      await writeFile(configPath, updated);
      expect(ctx.git('add', 'lazy.toml').exitCode).toBe(0);
      expect(ctx.git('commit', '-m', 'Configure test origin').exitCode).toBe(0);
      const remote = await mkdtemp(join(tmpdir(), 'abandon-sync-origin-'));
      const colleague = await mkdtemp(join(tmpdir(), 'abandon-sync-colleague-'));
      temporaryDirs.push(remote, colleague);
      expect(git(remote, 'init', '--bare', '--initial-branch=main').exitCode).toBe(0);
      expect(ctx.git('remote', 'add', 'origin', remote).exitCode).toBe(0);
      expect(ctx.git('push', 'origin', 'main').exitCode).toBe(0);
      const taskId = await createTask(ctx, 'Two unfinished sync steps', 'Do work');
      await ctx.setClaudeScenario(successScenario({
        commit: { message: 'Shared base', files: [{ path: 'shared.txt', content: 'base\n' }] },
      }));
      expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
      expectSuccess(await ctx.lazy(['wait', taskId]));
      const worktree = worktreePathFor(ctx.root, taskId);
      const branch = readSessionJson(ctx.root, taskId)!.git_branch as string;
      expect(git(worktree, 'push', 'origin', branch).exitCode).toBe(0);
      expect(git(colleague, 'clone', remote, '.').exitCode).toBe(0);
      expect(git(colleague, 'config', 'user.email', 'colleague@lazy.test').exitCode).toBe(0);
      expect(git(colleague, 'config', 'user.name', 'Colleague').exitCode).toBe(0);
      expect(git(colleague, 'checkout', branch).exitCode).toBe(0);
      await writeFile(join(colleague, 'shared.txt'), 'colleague\n');
      expect(git(colleague, 'add', 'shared.txt').exitCode).toBe(0);
      expect(git(colleague, 'commit', '-m', 'Colleague edit').exitCode).toBe(0);
      expect(git(colleague, 'push', 'origin', branch).exitCode).toBe(0);
      const originHead = git(colleague, 'rev-parse', 'HEAD').stdout.trim();
      await writeFile(join(worktree, 'shared.txt'), 'task\n');
      expect(git(worktree, 'add', 'shared.txt').exitCode).toBe(0);
      expect(git(worktree, 'commit', '-m', 'Task edit').exitCode).toBe(0);
      const beforeSync = git(worktree, 'rev-parse', 'HEAD').stdout.trim();
      await writeFile(join(ctx.root, 'shared.txt'), 'parent\n');
      expect(ctx.git('add', 'shared.txt').exitCode).toBe(0);
      expect(ctx.git('commit', '-m', 'Parent conflict').exitCode).toBe(0);
      expect(ctx.git('push', 'origin', 'main').exitCode).toBe(0);
      const parentHead = ctx.git('rev-parse', 'HEAD').stdout.trim();
      const hold = join(ctx.root, 'hold-second-sync-step');
      await writeFile(hold, 'hold');
      await ctx.clearClaudeInvocations();
      await ctx.setClaudeScenario({ sequence: [
        successScenario({ commit: { message: 'Resolve origin conflict',
          files: [{ path: 'shared.txt', content: 'resolved origin\n' }] } }),
        { steps: [{ kind: 'emit', event: sessionStartEvent('held-parent-sync') },
          { kind: 'hold-while-file', path: hold }] },
      ] });
      expectSuccess(await ctx.lazy(['sync', taskId]));
      await eventually(async () => (await ctx.claudeInvocations()).length >= 2, 'parent conflict resolver');
      expect(git(worktree, 'rev-parse', 'MERGE_HEAD').stdout.trim()).toBe(parentHead);
      const resolvedOriginHead = git(worktree, 'rev-parse', 'HEAD').stdout.trim();
      expect(resolvedOriginHead).not.toBe(beforeSync);
      expect(git(worktree, 'merge-base', '--is-ancestor', originHead, 'HEAD').exitCode).toBe(0);
      expectSuccess(await ctx.lazy(['stop', taskId, '--reason', 'Abandon only the parent merge', '--yes']));
      const result = await ctx.lazy([command, taskId, '--reason', 'Superseded', '--yes']);
      expectSuccess(result);
      expect(result.stdout + result.stderr).toContain('Aborted the unfinished sync merge');
      expect(result.stdout + result.stderr).toContain(resolvedOriginHead.substring(0, 7));
      expect(ctx.git('rev-parse', branch).stdout.trim()).toBe(resolvedOriginHead);
      const shown = await ctx.lazy(['show', taskId, '--json']);
      expectSuccess(shown);
      expect(JSON.parse(shown.stdout).status).toBe('abandoned');
    }, 120_000);

    // INVARIANT: a refused or unconfirmed stop cannot authorize aborting a
    // live agent's merge. A positively absent run is safe to abandon.
    for (const runtime of ['refuses-stop', 'unreachable', 'already-gone'] as const) {
      test(`${command} handles a runner that is ${runtime} without guessing it stopped`, async () => {
        const fakeDir = await mkdtemp(join(tmpdir(), 'abandon-sync-docker-'));
        temporaryDirs.push(fakeDir);
        const docker = await installFakeDocker(fakeDir);
        ctx = await setupTestLazy({ fakeClaude: true,
          daemonEnv: { PATH: `${docker.binDir}:${process.env.PATH ?? ''}` } });
        const taskId = await createTask(ctx, 'Sync stop failure', 'Do work');
        await ctx.setClaudeScenario(successScenario({
          commit: { message: 'Task work', files: [{ path: 'shared.txt', content: 'task\n' }] },
        }));
        expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
        expectSuccess(await ctx.lazy(['wait', taskId]));
        const worktree = worktreePathFor(ctx.root, taskId);
        const head = git(worktree, 'rev-parse', 'HEAD').stdout.trim();
        await writeFile(join(ctx.root, 'shared.txt'), 'parent\n');
        expect(ctx.git('add', 'shared.txt').exitCode).toBe(0);
        expect(ctx.git('commit', '-m', 'Parent conflict').exitCode).toBe(0);
        const hold = join(ctx.root, 'hold-sync');
        await writeFile(hold, 'hold');
        await ctx.clearClaudeInvocations();
        await ctx.setClaudeScenario({ steps: [
          { kind: 'emit', event: sessionStartEvent('held-sync') },
          { kind: 'hold-while-file', path: hold },
        ] });
        expectSuccess(await ctx.lazy(['sync', taskId]));
        await eventually(async () => (await ctx.claudeInvocations()).length > 0, 'sync conflict resolver');
        const mergeHead = git(worktree, 'rev-parse', 'MERGE_HEAD').stdout.trim();
        expectSuccess(await ctx.lazy(['stop', taskId, '--reason', 'Test runtime stop failure', '--yes']));
        const fullId = readTaskJson(ctx.root, taskId).id as string;
        consumeResponse(protocolDir(fullId));
        const client = DaemonClient.fromTarget(getDaemonTcpTarget(ctx.root)!, readToken(ctx.root)!);
        const storage = new RemoteStorage(client, ctx.root, '');
        const session = (await storage.getSessionByTaskId(fullId))!;
        const runName = `lazy-failed-stop-${taskId}`;
        // Only the external runtime is fake: the merge and daemon are real.
        // Give that runtime the stopped fixture's task so it can refuse a kill.
        await storage.updateSessionRunnerType(session.id, 'docker');
        await storage.updateSessionContainerName(session.id, runName);
        if (runtime !== 'already-gone') {
          await docker.seedContainer(runName, { state: 'running', project: ctx.root });
        }
        await docker.failStops();
        if (runtime === 'unreachable') await docker.failInspect();
        try {
          await storage.updateTaskStatus(fullId, 'working', 'human');
          const request = client.rpc(`${command}Task`, ctx.root, { taskId: fullId, reason: 'Superseded' });
          if (runtime === 'already-gone') {
            const result = await request as { warnings: string[] };
            expect(result.warnings.join(' ')).toContain('Aborted the unfinished sync merge');
            expect((await storage.getTask(fullId))?.status).toBe('abandoned');
            expect(ctx.git('rev-parse', session.git_branch).stdout.trim()).toBe(head);
          } else {
            try {
              await request;
              throw new Error('Expected the runtime stop failure to refuse abandonment');
            } catch (err) {
              expect(err).toBeInstanceOf(RpcApplicationError);
              expect((err as RpcApplicationError).status).toBe(502);
              expect((err as Error).message).toContain('Could not confirm that task run');
            }
            expect(git(worktree, 'rev-parse', 'HEAD').stdout.trim()).toBe(head);
            expect(git(worktree, 'rev-parse', 'MERGE_HEAD').stdout.trim()).toBe(mergeHead);
            expect(git(worktree, 'diff', '--name-only', '--diff-filter=U').stdout).toContain('shared.txt');
            expect((await storage.getTask(fullId))?.status).toBe('working');
            expect((await storage.getSessionByTaskId(fullId))?.ended_at).toBeNull();
            if (process.env.LAZY_SCREENSHOTS === '1' && runtime === 'refuses-stop') {
              const result = await ctx.lazy([command, taskId, '--reason', 'Superseded', '--yes']);
              expectFailure(result);
              expect(result.stdout + result.stderr).toContain('Could not confirm that task run');
              await writeFile(join(tmpdir(), `lazy-${command}-sync-stop-refused.txt`), result.stdout + result.stderr);
            }
          }
          expect((await docker.invocations()).some(line => line === `kill ${runName}`)).toBe(true);
        } finally {
          await docker.failInspect(false);
        }
      }, 120_000);
    }

    // INVARIANT: a merge without lazy sync provenance is never aborted.
    test(`${command} refuses an unrelated unfinished merge`, async () => {
      ctx = await setupTestLazy();
      const taskId = await createTask(ctx, 'Other merge', 'Do work');
      expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
        env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
      }));
      const worktree = worktreePathFor(ctx.root, taskId);
      await writeFile(join(ctx.root, 'shared.txt'), 'parent\n');
      expect(ctx.git('add', 'shared.txt').exitCode).toBe(0);
      expect(ctx.git('commit', '-m', 'Parent work').exitCode).toBe(0);
      await writeFile(join(worktree, 'shared.txt'), 'task\n');
      expect(git(worktree, 'add', 'shared.txt').exitCode).toBe(0);
      expect(git(worktree, 'commit', '-m', 'Task work').exitCode).toBe(0);
      expect(git(worktree, 'merge', 'main', '--no-ff').exitCode).not.toBe(0);
      const head = git(worktree, 'rev-parse', 'HEAD').stdout;
      const result = await ctx.lazy([command, taskId, '--reason', 'Superseded', '--yes']);
      expectFailure(result);
      expect(git(worktree, 'rev-parse', '--verify', 'MERGE_HEAD').exitCode).toBe(0);
      expect(git(worktree, 'rev-parse', 'HEAD').stdout).toBe(head);
    }, 60_000);

    // A legacy-style mid-merge task: no marker, no supervisor status, no run
    // log — nothing proves the merge is lazy's own sync.
    async function legacyMidMergeTask() {
      ctx = await setupTestLazy({ fakeClaude: true });
      const taskId = await createTask(ctx, 'Legacy merge', 'Do work');
      await ctx.setClaudeScenario(successScenario({
        commit: { message: 'Task work', files: [{ path: 'shared.txt', content: 'task\n' }] },
      }));
      expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
      expectSuccess(await ctx.lazy(['wait', taskId]));
      const worktree = worktreePathFor(ctx.root, taskId);
      await writeFile(join(ctx.root, 'shared.txt'), 'parent\n');
      expect(ctx.git('add', 'shared.txt').exitCode).toBe(0);
      expect(ctx.git('commit', '-m', 'Parent work').exitCode).toBe(0);
      // Merged by hand, outside any lazy sync: no marker, status or run log.
      expect(git(worktree, 'merge', 'main', '--no-ff').exitCode).not.toBe(0);
      const head = git(worktree, 'rev-parse', 'HEAD').stdout.trim();
      const mergeHead = git(worktree, 'rev-parse', 'MERGE_HEAD').stdout.trim();
      const branch = readSessionJson(ctx.root, taskId)!.git_branch as string;
      return { taskId, worktree, head, mergeHead, branch };
    }

    // INVARIANT: a merge lazy cannot prove is its own is shown (HEAD, incoming
    // commit, conflicts) and the refusal names the confirmed way past it —
    // never "run lazy sync" or git by hand. Without confirmation nothing moves.
    test(`${command} shows an unproven merge and names the confirmed abort`, async () => {
      const { taskId, worktree, head, mergeHead } = await legacyMidMergeTask();
      const result = await ctx.lazy([command, taskId, '--reason', 'Superseded', '--yes']);
      expectFailure(result);
      const out = result.stdout + result.stderr;
      expect(out).toContain(head);
      expect(out).toContain(mergeHead);
      expect(out).toContain('1 file');
      expect(out).toContain('keeps every commit');
      expect(out).toContain(`lazy ${command} ${taskId} --accept-dirty-worktree`);
      expect(out).not.toContain('Run `lazy sync');
      expect(git(worktree, 'rev-parse', 'MERGE_HEAD').stdout.trim()).toBe(mergeHead);
      expect(git(worktree, 'rev-parse', 'HEAD').stdout.trim()).toBe(head);
    }, 60_000);

    // INVARIANT: the DAEMON refuses an unproven merge on its own (MCP, the
    // dashboard and Teams have no CLI pre-flight) with the unproven-merge
    // remedy, and aborts it only when acceptDirtyWorktree confirms it.
    test(`${command} over RPC refuses an unproven merge, then aborts it when confirmed`, async () => {
      const { taskId, worktree, head, mergeHead, branch } = await legacyMidMergeTask();
      const fullId = readTaskJson(ctx.root, taskId).id as string;
      const client = DaemonClient.fromTarget(getDaemonTcpTarget(ctx.root)!, readToken(ctx.root)!);
      try {
        await client.rpc(`${command}Task`, ctx.root, { taskId: fullId, reason: 'Superseded' });
        throw new Error('Expected the unproven merge to be refused');
      } catch (err) {
        expect(err).toBeInstanceOf(RpcApplicationError);
        expect((err as RpcApplicationError).status).toBe(409);
        expect((err as RpcApplicationError).remedy?.reason).toBe('unproven-merge');
        expect((err as Error).message).toContain(head);
        expect((err as Error).message).toContain(mergeHead);
      }
      expect(git(worktree, 'rev-parse', 'MERGE_HEAD').stdout.trim()).toBe(mergeHead);
      if (process.env.LAZY_SCREENSHOTS === '1') await captureUnprovenMergeScreens(ctx, command, taskId);
      const result = await client.rpc(`${command}Task`, ctx.root,
        { taskId: fullId, reason: 'Superseded', acceptDirtyWorktree: true }) as { warnings: string[] };
      expect(result.warnings.join(' ')).toContain('Aborted the merge in progress');
      expect(ctx.git('rev-parse', branch).stdout.trim()).toBe(head);
      expect(readTaskJson(ctx.root, taskId).status).toBe('abandoned');
    }, 120_000);

    // INVARIANT: declining the terminal prompt (default no) changes nothing.
    test(`${command} declined at the prompt leaves the merge in place`, async () => {
      const { taskId, worktree, head, mergeHead } = await legacyMidMergeTask();
      const result = await ctx.lazy([command, taskId, '--reason', 'Superseded'], {
        env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'decline' },
      });
      expectFailure(result);
      expect(git(worktree, 'rev-parse', 'MERGE_HEAD').stdout.trim()).toBe(mergeHead);
      expect(git(worktree, 'rev-parse', 'HEAD').stdout.trim()).toBe(head);
      expect(readTaskJson(ctx.root, taskId).status).not.toBe('abandoned');
    }, 60_000);

    // INVARIANT: on explicit confirmation (prompt yes, or the named flag) the
    // unproven merge is aborted, every commit kept, and the task ends.
    for (const how of ['flag', 'prompt'] as const) {
      test(`${command} aborts an unproven merge when confirmed by ${how}`, async () => {
        const { taskId, head, branch } = await legacyMidMergeTask();
        const result = how === 'flag'
          ? await ctx.lazy([command, taskId, '--reason', 'Superseded', '--yes', '--accept-dirty-worktree'])
          : await ctx.lazy([command, taskId, '--reason', 'Superseded'], {
            env: { LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'accept' },
          });
        expectSuccess(result);
        expect(result.stdout + result.stderr).toContain('Aborted the merge in progress');
        expect(ctx.git('rev-parse', branch).stdout.trim()).toBe(head);
        expect(readTaskJson(ctx.root, taskId).status).toBe('abandoned');
      }, 120_000);
    }

    // INVARIANT: ordinary uncommitted work has no sync provenance and remains
    // protected by the existing refusal, even when the person wants to abandon.
    test(`${command} still refuses ordinary uncommitted edits`, async () => {
      ctx = await setupTestLazy();
      const taskId = await createTask(ctx, 'Dirty task', 'Do work');
      expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
        env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
      }));
      const worktree = worktreePathFor(ctx.root, taskId);
      await writeFile(join(worktree, 'loose.txt'), 'keep this\n');
      const result = await ctx.lazy([command, taskId, '--reason', 'Superseded', '--yes']);
      expectFailure(result);
      expect(result.stdout + result.stderr).toContain('uncommitted changes');
      expect(await Bun.file(join(worktree, 'loose.txt')).text()).toBe('keep this\n');
    }, 60_000);
  }
});
