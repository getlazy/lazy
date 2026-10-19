import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { storageDirFor } from '../helpers/storage';
import { FileStorage } from '../../src/storage/file-storage';
import { loadConfig } from '../../src/config/loader';
import { detectExternalChanges, debugSyncLogger } from '../../src/daemon/remote-sync';
import { GitHubDriver } from '../../src/remote/github-driver';
import { GitLabDriver } from '../../src/remote/gitlab-driver';
import { linkedBranchUnpushedCount } from '../../src/daemon/task-lifecycle';
import type { RepositoryDriver } from '../../src/remote/driver';

/**
 * A task created by `lazy link` follows the fate of the PR/MR it adopted:
 * merged on the forge → complete, closed unmerged → abandoned, still open →
 * untouched. Real CLI and store; the forge is a fake `gh` / `glab` injected
 * into the real GitHub and GitLab drivers, recording every call it receives.
 */

type Forge = 'github' | 'gitlab';
type Fate = 'merged' | 'closed' | 'open';

const GH_STATE: Record<Fate, string> = { merged: 'MERGED', closed: 'CLOSED', open: 'OPEN' };
const GL_STATE: Record<Fate, string> = { merged: 'merged', closed: 'closed', open: 'opened' };

function fakeForgeDriver(forge: Forge, fate: Fate, config: any, calls: string[][]): RepositoryDriver {
  const reply = (args: string[]) => {
    calls.push(args);
    const isView = forge === 'github' ? args[0] === 'pr' && args[1] === 'view' : args[0] === 'mr' && args[1] === 'view';
    if (!isView) return { stdout: '', stderr: `fake ${forge}: unsupported ${args.join(' ')}`, exitCode: 1 };
    const state = forge === 'github' ? GH_STATE[fate] : GL_STATE[fate];
    return { stdout: JSON.stringify({ state, baseRefName: 'main', target_branch: 'main' }), stderr: '', exitCode: 0 };
  };
  return forge === 'github'
    ? new GitHubDriver(config, { runGh: async (a: string[]) => reply(a) } as any)
    : new GitLabDriver(config, { runGl: async (a: string[]) => reply(a) } as any);
}

describe('linked task follows its PR/MR', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function linkWithPr(forge: Forge, code: string): Promise<string> {
    const branch = `feature/${code}`;
    const bare = mkdtempSync(join(tmpdir(), 'lazy-e2e-bare-'));
    Bun.spawnSync(['git', 'init', '--bare', bare]);
    ctx.git('remote', 'add', 'origin', bare);
    ctx.git('branch', branch);
    ctx.git('push', 'origin', branch);
    expectSuccess(await ctx.lazy(['link', branch, '--code', code]));

    const storage = new FileStorage(ctx.root, { basePath: storageDirFor(ctx.root) });
    await storage.initialize();
    try {
      const task = (await storage.listTasks()).find((t) => t.code === code)!;
      const prefix = forge === 'github' ? 'github' : 'gitlab';
      await storage.updateTaskMetadata(task.id, `${prefix}_remote_ref_id`, '42');
      await storage.updateTaskMetadata(task.id, `${prefix}_remote_ref_url`, `https://example.test/${code}/42`);
      return task.id;
    } finally {
      await storage.close();
    }
  }

  async function runSweep(forge: Forge, fate: Fate, calls: string[][], root?: string) {
    const config = await loadConfig(ctx.root);
    const storage = new FileStorage(ctx.root, { basePath: storageDirFor(ctx.root) });
    await storage.initialize();
    try {
      return await detectExternalChanges(storage, fakeForgeDriver(forge, fate, config, calls), debugSyncLogger, root);
    } finally {
      await storage.close();
    }
  }

  async function followThroughOf(taskId: string): Promise<string> {
    const storage = new FileStorage(ctx.root, { basePath: storageDirFor(ctx.root) });
    await storage.initialize();
    try {
      return (await storage.getTask(taskId))?.metadata?.accept_followthrough ?? '';
    } finally {
      await storage.close();
    }
  }

  async function commentsOf(taskId: string): Promise<string[]> {
    const storage = new FileStorage(ctx.root, { basePath: storageDirFor(ctx.root) });
    await storage.initialize();
    try {
      return (await storage.getTaskComments(taskId)).map((c) => c.content);
    } finally {
      await storage.close();
    }
  }

  for (const forge of ['github', 'gitlab'] as const) {
    // INVARIANT: a linked task's PR merged on the forge completes the task,
    // even though the task recorded no commits of its own (the work is the PR
    // author's). It used to be read as a "spurious" merge and left open forever.
    test(`${forge}: merged linked PR completes the task, with no forge write`, async () => {
      const taskId = await linkWithPr(forge, `${forge}-merged`);
      const calls: string[][] = [];
      // With the project root, so the accept follow-through runs too.
      const result = await runSweep(forge, 'merged', calls, ctx.root);
      expect(result.merged).toBe(1);
      expect(result.spurious).toBe(0);

      const show = await ctx.lazy(['show', `${forge}-merged`]);
      expectSuccess(show);
      expectOutput(show, 'complete');
      expect((await commentsOf(taskId)).some((c) => c.includes('linked PR/MR was merged on the forge'))).toBe(true);
      // Reads only: lazy never writes to a linked PR/MR.
      for (const args of calls) expect(args[1]).toBe('view');
      // Follow-through ran for the linked task. Daemonless, its cleanup cannot
      // revoke the task's tokens (no daemon proxy), so cleanup alone stays owed
      // for the daemon's sweep; every other step must be done.
      const owed = JSON.parse(await followThroughOf(taskId));
      expect(owed.done).toEqual(expect.arrayContaining(['reparent', 'notify-parent', 'fast-forward', 'accept-tag']));
      expect(owed.done).not.toContain('cleanup');
      expect(owed.lastError).toContain('cleanup');
      expect(owed.lastError).not.toMatch(/fast-forward|accept-tag|reparent/);
    });

    // INVARIANT: lazy never pushes a linked branch, so commits on it that the
    // remote lacks may exist nowhere else — a forge merge never deletes them.
    test(`${forge}: a linked branch is deletable only when origin has all its commits`, async () => {
      const code = `${forge}-unpushed`;
      const taskId = await linkWithPr(forge, code);
      const wt = ctx.git('worktree', 'list', '--porcelain').stdout
        .split('\n\n').find((b) => b.includes(`refs/heads/feature/${code}`))!
        .split('\n')[0].replace('worktree ', '');
      expect(ctx.git('-C', wt, 'commit', '--allow-empty', '-m', 'local only').exitCode).toBe(0);

      // The decision follow-through cleanup makes for a linked branch.
      expect(await linkedBranchUnpushedCount(`feature/${code}`, ctx.root, 'origin')).toBe(1);
      expect(await linkedBranchUnpushedCount(`feature/${forge}-gone`, ctx.root, 'origin')).toBeNull();
      ctx.git('-C', wt, 'push', 'origin', `feature/${code}`);
      expect(await linkedBranchUnpushedCount(`feature/${code}`, ctx.root, 'origin')).toBe(0);
      expect(taskId).toBeTruthy();
    });

    // INVARIANT: a linked PR closed unmerged abandons the task with a comment
    // saying so — and lazy still never touches the PR itself.
    test(`${forge}: closed linked PR abandons the task, with no forge write`, async () => {
      const taskId = await linkWithPr(forge, `${forge}-closed`);
      const calls: string[][] = [];
      const result = await runSweep(forge, 'closed', calls);
      expect(result.closed).toBe(1);

      const show = await ctx.lazy(['show', `${forge}-closed`]);
      expectSuccess(show);
      expectOutput(show, 'abandoned');
      expect((await commentsOf(taskId)).some((c) => c.includes('linked PR/MR was closed on the forge without being merged'))).toBe(true);
      for (const args of calls) expect(args[1]).toBe('view');
    });

    test(`${forge}: open linked PR leaves the task untouched`, async () => {
      const taskId = await linkWithPr(forge, `${forge}-open`);
      const before = await commentsOf(taskId);
      const calls: string[][] = [];
      const result = await runSweep(forge, 'open', calls);
      expect(result.merged + result.closed).toBe(0);

      const show = await ctx.lazy(['show', `${forge}-open`]);
      expectSuccess(show);
      expectOutput(show, 'blocked');
      expect(await commentsOf(taskId)).toEqual(before);
      for (const args of calls) expect(args[1]).toBe('view');
    });
  }
});
