import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { storageDirFor } from '../helpers/storage';
import { FileStorage } from '../../src/storage/file-storage';
import { loadConfig } from '../../src/config/loader';
import { debugSyncLogger } from '../../src/daemon/remote-sync';
import {
  createOrAdoptReview,
  healUnrecordedReviews,
  resetReviewHealThrottle,
  REVIEW_CREATE_INTENT_KEY,
} from '../../src/daemon/review-self-heal';
import { GitHubDriver } from '../../src/remote/github-driver';
import { GitLabDriver } from '../../src/remote/gitlab-driver';
import type { RepositoryDriver } from '../../src/remote/driver';
import type { Storage } from '../../src/storage';

/**
 * A task never loses track of its own PR/MR. Real CLI and store; the forge is
 * a fake `gh` / `glab` injected into the real GitHub and GitLab drivers. The
 * fake keeps ONE PR for the branch (or none) and records every call, so a
 * test can assert that lazy only ever reads — and, for the create path, that
 * it never opens a second PR for the same head.
 */

type Forge = 'github' | 'gitlab';
type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

interface FakePr { state: PrState; base: string; number: number; head?: string }

class FakeForge {
  pr: FakePr | null = null;
  calls: string[][] = [];
  creates = 0;
  constructor(readonly forge: Forge, readonly branch: string) {}

  private url(): string {
    return this.forge === 'github'
      ? `https://github.com/acme/app/pull/${this.pr!.number}`
      : `https://gitlab.com/acme/app/-/merge_requests/${this.pr!.number}`;
  }

  private ok(body: unknown) {
    return { stdout: typeof body === 'string' ? body : JSON.stringify(body), stderr: '', exitCode: 0 };
  }

  reply(args: string[]) {
    this.calls.push(args);
    if (this.forge === 'github') {
      if (args[0] === 'pr' && args[1] === 'create') {
        this.creates++;
        const base = args[args.indexOf('--base') + 1]!;
        this.pr = { state: 'OPEN', base, number: 1836 };
        return this.ok(`${this.url()}\n`);
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        if (!this.pr) return { stdout: '', stderr: `no pull requests found for branch "${args[2]}"`, exitCode: 1 };
        return this.ok({ url: this.url(), number: this.pr.number, state: this.pr.state, baseRefName: this.pr.base, headRefOid: this.pr.head, isDraft: false });
      }
    } else {
      if (args[0] === 'mr' && args[1] === 'create') {
        this.creates++;
        const base = args[args.indexOf('--target-branch') + 1]!;
        this.pr = { state: 'OPEN', base, number: 1836 };
        return this.ok(`${this.url()}\n`);
      }
      const glState = this.pr ? { OPEN: 'opened', MERGED: 'merged', CLOSED: 'closed' }[this.pr.state] : '';
      if (args[0] === 'api' && args[1]?.includes('merge_requests?source_branch=')) {
        if (!args[1].includes(encodeURIComponent(this.branch))) return this.ok([]);
        return this.ok(this.pr ? [{ web_url: this.url(), iid: this.pr.number, state: glState, target_branch: this.pr.base, sha: this.pr.head }] : []);
      }
      if (args[0] === 'mr' && args[1] === 'view') {
        if (!this.pr) return { stdout: '', stderr: 'no open merge request available', exitCode: 1 };
        return this.ok({ web_url: this.url(), iid: this.pr.number, state: glState, target_branch: this.pr.base, draft: false });
      }
    }
    return { stdout: '', stderr: `fake ${this.forge}: unsupported ${args.join(' ')}`, exitCode: 1 };
  }

  driver(config: any): RepositoryDriver {
    return this.forge === 'github'
      ? new GitHubDriver(config, { runGh: async (a: string[]) => this.reply(a) } as any)
      : new GitLabDriver(config, { runGl: async (a: string[]) => this.reply(a) } as any);
  }

  /** Every call was a read (no create, edit, close, comment, review). */
  onlyReads(): boolean {
    return this.calls.every((a) => a[1] === 'view' || a[0] === 'api');
  }
}

describe('a task never loses track of its own PR/MR', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    resetReviewHealThrottle();
    const bare = mkdtempSync(join(tmpdir(), 'lazy-e2e-bare-'));
    Bun.spawnSync(['git', 'init', '--bare', bare]);
    ctx.git('remote', 'add', 'origin', bare);
    ctx.git('push', 'origin', 'HEAD:main');
    ctx.git('fetch', 'origin');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function withStorage<T>(fn: (s: Storage) => Promise<T>): Promise<T> {
    const storage = new FileStorage(ctx.root, { basePath: storageDirFor(ctx.root) });
    await storage.initialize();
    try {
      return await fn(storage);
    } finally {
      await storage.close();
    }
  }

  /** A blocked task with a branch carrying one commit of real work. */
  async function blockedTaskWithWork(code: string): Promise<{ id: string; branch: string }> {
    const id = await createTask(ctx, `Task ${code}`, 'Do it');
    const branch = `lazy/${code}`;
    const startSha = ctx.git('rev-parse', 'HEAD').stdout.trim();
    ctx.git('branch', branch);
    const wt = mkdtempSync(join(tmpdir(), 'lazy-e2e-wt-'));
    ctx.git('worktree', 'add', join(wt, 'w'), branch);
    writeFileSync(join(wt, 'w', `${code}.txt`), `work for ${code}\n`);
    ctx.git('-C', join(wt, 'w'), 'add', '.');
    ctx.git('-C', join(wt, 'w'), 'commit', '-m', `work for ${code}`);
    const sha = ctx.git('rev-parse', branch).stdout.trim();
    await withStorage(async (s) => {
      const full = (await s.resolveTask(id)).task!;
      const session = await s.createSession(full.id, 'claude', branch, startSha);
      await s.createCommit(session.id, sha, `work for ${code}`);
      await s.updateTaskStatus(full.id, 'blocked', 'human');
    });
    const full = await withStorage(async (s) => (await s.resolveTask(id)).task!.id);
    return { id: full, branch };
  }

  /** The forge merged the PR: main gets the branch's work and origin has it. */
  function landOnMain(branch: string): void {
    ctx.git('merge', '--no-ff', '-m', `Merge pull request from ${branch}`, branch);
    ctx.git('push', 'origin', 'HEAD:main');
    ctx.git('fetch', 'origin');
  }

  const tipOf = (branch: string) => ctx.git('rev-parse', branch).stdout.trim();

  async function heal(fake: FakeForge) {
    const config = await loadConfig(ctx.root);
    return await withStorage((s) => healUnrecordedReviews(s, fake.driver(config), debugSyncLogger, ctx.root));
  }

  async function taskOf(id: string) {
    return await withStorage(async (s) => (await s.getTask(id))!);
  }

  async function commentsOf(id: string): Promise<string[]> {
    return await withStorage(async (s) => (await s.getTaskComments(id)).map((c) => c.content));
  }

  const refKey = (forge: Forge) => (forge === 'github' ? 'github_remote_ref_id' : 'gitlab_remote_ref_id');

  for (const forge of ['github', 'gitlab'] as const) {
    // INVARIANT: the forge creating a PR and lazy recording it are two writes;
    // a failure between them must never leave a PR lazy cannot find. The intent
    // is saved first, a retry adopts instead of opening a second PR, and the
    // remote-sync heal finds the PR by its head branch.
    test(`${forge}: a create whose record write fails is recovered by head branch, never duplicated`, async () => {
      const { id, branch } = await blockedTaskWithWork(`${forge}-crash`);
      const fake = new FakeForge(forge, branch);
      const config = await loadConfig(ctx.root);

      await withStorage(async (real) => {
        // The store write of the PR record fails after the forge created it.
        const failing = new Proxy(real, {
          get(target, prop, recv) {
            if (prop === 'updateTaskMetadata') {
              return async (taskId: string, key: string, value: string) => {
                if (key === refKey(forge) || key.endsWith('_remote_ref_url')) throw new Error('disk full');
                return target.updateTaskMetadata(taskId, key, value);
              };
            }
            const v = Reflect.get(target, prop, recv);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        }) as Storage;
        const task = (await real.getTask(id))!;
        await expect(createOrAdoptReview(failing, fake.driver(config), task, branch)).rejects.toThrow('disk full');
      });
      expect(fake.creates).toBe(1);
      const afterCrash = await taskOf(id);
      expect(afterCrash.metadata?.[REVIEW_CREATE_INTENT_KEY]).toContain(branch);
      expect(afterCrash.metadata?.[refKey(forge)] ?? '').toBe('');

      // The next remote-sync pass adopts it.
      const result = await heal(fake);
      expect(result.adopted).toBe(1);
      const healed = await taskOf(id);
      expect(healed.metadata?.[refKey(forge)]).toBe('1836');
      expect(healed.metadata?.[REVIEW_CREATE_INTENT_KEY] ?? '').toBe('');
      expect((await commentsOf(id)).some((c) => c.startsWith('[PR adopted]'))).toBe(true);
      expect(fake.creates).toBe(1);
    });

    // INVARIANT: creation is idempotent by the head branch — an open PR already
    // on it is adopted, never a second create (which the forge refuses).
    test(`${forge}: creating a PR for a branch that already has one open adopts it`, async () => {
      const { id, branch } = await blockedTaskWithWork(`${forge}-idem`);
      const fake = new FakeForge(forge, branch);
      fake.pr = { state: 'OPEN', base: 'main', number: 1836 };
      const config = await loadConfig(ctx.root);
      const out = await withStorage(async (s) => createOrAdoptReview(s, fake.driver(config), (await s.getTask(id))!, branch));
      expect(out.adoptedUrl).toContain('1836');
      expect(fake.creates).toBe(0);
      expect((await taskOf(id)).metadata?.[refKey(forge)]).toBe('1836');
    });

    // INVARIANT: a PR a person opened by hand for the task's branch is adopted
    // by the sweep, so auto-react, accept and the PR link work — reads only.
    test(`${forge}: a hand-opened PR is adopted by head branch`, async () => {
      const { id, branch } = await blockedTaskWithWork(`${forge}-hand`);
      const fake = new FakeForge(forge, branch);
      fake.pr = { state: 'OPEN', base: 'main', number: 1836 };
      const result = await heal(fake);
      expect(result.adopted).toBe(1);
      const task = await taskOf(id);
      expect(task.status).toBe('blocked');
      expect(task.metadata?.[refKey(forge)]).toBe('1836');
      expect(fake.onlyReads()).toBe(true);
    });

    // INVARIANT: the case from the wild. The task's own PR merged on the forge
    // while lazy had no record; the task completes through the forge-merged
    // accept path and says exactly why — never sits blocked with 0 changes.
    test(`${forge}: a merged PR lazy never recorded completes the task`, async () => {
      const { id, branch } = await blockedTaskWithWork(`${forge}-merged`);
      const head = tipOf(branch);
      landOnMain(branch);
      const fake = new FakeForge(forge, branch);
      fake.pr = { state: 'MERGED', base: 'main', number: 1836, head };
      const result = await heal(fake);
      expect(result.errors).toEqual([]);
      expect(result.completed).toBe(1);
      const task = await taskOf(id);
      expect(task.status).toBe('complete');
      expect(task.metadata?.[refKey(forge)]).toBe('1836');
      expect((await commentsOf(id)).some((c) => c.includes("This task's own PR/MR") && c.includes('1836'))).toBe(true);
      expect(fake.onlyReads()).toBe(true);
    });

    // INVARIANT (src/daemon/review-base.ts): merged into a branch that is not
    // the task's target never completes the task; one alert says so.
    test(`${forge}: a merged PR into the wrong base files one alert and leaves the task`, async () => {
      const { id, branch } = await blockedTaskWithWork(`${forge}-wrongbase`);
      const fake = new FakeForge(forge, branch);
      fake.pr = { state: 'MERGED', base: 'release', number: 1836 };
      expect((await heal(fake)).wrongBase).toBe(1);
      resetReviewHealThrottle();
      await heal(fake);
      const task = await taskOf(id);
      expect(task.status).toBe('blocked');
      expect(task.metadata?.[refKey(forge)] ?? '').toBe('');
      const alerts = await withStorage(async (s) => (await s.listSystemMessages()).filter((m) => m.title.includes('merged into the wrong branch')));
      expect(alerts.length).toBe(1);
    });

    // INVARIANT: completing on a merged PR must never discard work the branch
    // gained after it — the trees decide, and the task is left open, said once.
    test(`${forge}: a merged PR with more work on the branch leaves the task open`, async () => {
      const { id, branch } = await blockedTaskWithWork(`${forge}-more`);
      const fake = new FakeForge(forge, branch);
      fake.pr = { state: 'MERGED', base: 'main', number: 1836, head: tipOf(branch) };
      // main never got the work: the branch has changes beyond the target.
      await heal(fake);
      resetReviewHealThrottle();
      await heal(fake);
      const task = await taskOf(id);
      expect(task.status).toBe('blocked');
      expect((await commentsOf(id)).filter((c) => c.startsWith('[PR merged]')).length).toBe(1);
    });

    // INVARIANT: a PR found by branch NAME completes a task only when it is
    // provably that task's own — recorded work and a head on the branch's
    // history. A just-started branch adds nothing to its target, so without
    // this a same-named merged PR from another store would complete it.
    test(`${forge}: a same-named merged PR unrelated to the branch leaves a zero-commit task alone`, async () => {
      const id = await createTask(ctx, `Task ${forge}-fresh`, 'Do it');
      const branch = `lazy/${forge}-fresh`;
      ctx.git('branch', branch);
      await withStorage(async (s) => {
        const full = (await s.resolveTask(id)).task!;
        await s.createSession(full.id, 'claude', branch, tipOf(branch));
        await s.updateTaskStatus(full.id, 'blocked', 'human');
      });
      const fullId = await withStorage(async (s) => (await s.resolveTask(id)).task!.id);
      const fake = new FakeForge(forge, branch);
      fake.pr = { state: 'MERGED', base: 'main', number: 7, head: 'deadbeef'.repeat(5) };
      const before = await commentsOf(fullId);
      const result = await heal(fake);
      expect(result.completed).toBe(0);
      const task = await taskOf(fullId);
      expect(task.status).toBe('blocked');
      expect(task.metadata?.[refKey(forge)] ?? '').toBe('');
      expect(await commentsOf(fullId)).toEqual(before);
    });
  }
});
