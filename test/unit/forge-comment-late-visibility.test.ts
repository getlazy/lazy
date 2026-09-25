/**
 * Forge comments that become visible AFTER a sync pass must still be imported.
 *
 * INVARIANT: every PR comment and review summary visible on the forge is
 * imported as a task comment exactly once, whenever it becomes visible.
 * Correctness rests on dedup by id, never on a timestamp window. A GitHub
 * line comment drafted inside a pending review carries its DRAFTING time as
 * `created_at` and appears only when the review is submitted, which is how
 * bot reviewers post. A created_at watermark that one pass had already moved
 * past that time dropped those comments for good. Review bodies (a bot's "Pull
 * request overview") live on `pulls/{n}/reviews`, which was never read at all.
 *
 * The forge boundary is faked at `runGh`: the real GitHubDriver and the real
 * syncTaskFromRemote run against it.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { resolve } from 'path';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import { GitHubDriver } from '../../src/remote/github-driver';
import type { GhResult } from '../../src/remote';
import type { ResolvedConfig } from '../../src/config/types';
import type { Task, Comment, CommentSource, CommentCreateOptions, CommentUpdate } from '../../src/types';

const config: ResolvedConfig = {
  ...DEFAULT_CONFIG,
  remote: { ...DEFAULT_CONFIG.remote, driver: 'github', github_auto_push: false },
};

// What the forge currently shows. Tests mutate these between passes.
let issueComments: Array<Record<string, unknown>> = [];
let lineComments: Array<Record<string, unknown>> = [];
let reviews: Array<Record<string, unknown>> = [];

const ok = (v: unknown): GhResult => ({ stdout: JSON.stringify(v), stderr: '', exitCode: 0 });
async function fakeGh(args: string[]): Promise<GhResult> {
  if (args[0] === 'repo' && args[1] === 'view') return ok({ isPrivate: true });
  if (args[0] === 'api') {
    const ep = args[1];
    if (ep.endsWith('/issues/42/comments')) return ok(issueComments);
    if (ep.endsWith('/pulls/42/comments')) return ok(lineComments);
    if (ep.endsWith('/pulls/42/reviews')) return ok(reviews);
  }
  if (args[0] === 'pr' && args[1] === 'view') return ok({ state: 'OPEN' });
  return { stdout: '', stderr: `unexpected gh call: ${args.join(' ')}`, exitCode: 1 };
}

const loaderPath = resolve(import.meta.dir, '../../src/config/loader.ts');
const realLoader = { ...(await import(loaderPath)) };
await mockModule(loaderPath, () => ({ ...realLoader, loadConfig: async () => config }));

const remotePath = resolve(import.meta.dir, '../../src/remote/index.ts');
const realRemote = { ...(await import(remotePath)) };
await mockModule(remotePath, () => ({
  ...realRemote,
  createDriver: () => new GitHubDriver(config, {
    runGh: fakeGh,
    runGit: async () => ({ stdout: '', stderr: 'no git', exitCode: 1 }),
  }),
}));

// The auto-unblock launch is auto-react's outward boundary; the budget is
// allowed so the test reaches it.
const unblocks: string[] = [];
const budgetPath = resolve(import.meta.dir, '../../src/daemon/auto-react-budget.ts');
const realBudget = { ...(await import(budgetPath)) };
await mockModule(budgetPath, () => ({
  ...realBudget,
  shouldAutoReact: async () => ({ allowed: true }),
  recordAutoReact: async () => {},
}));
const deliverPath = resolve(import.meta.dir, '../../src/daemon/auto-deliver.ts');
const realDeliver = { ...(await import(deliverPath)) };
await mockModule(deliverPath, () => ({
  ...realDeliver,
  autoUnblockTask: async (_s: unknown, _t: unknown, _sess: unknown, _root: unknown, feedback: string) => {
    unblocks.push(feedback);
    return true;
  },
}));

const { syncTaskFromRemote } = await import('../../src/task/sync-remote');
const { runAutoReact } = await import('../../src/daemon/auto-react');

afterAll(() => restoreMockedModules());

function makeStore() {
  const task: Task = {
    id: 'task-1', code: 'forge-late', goal: 'g', prompt: 'p', type: 'task',
    status: 'submitted', created_at: Date.parse('2026-09-01T00:00:00Z'), completed_at: null,
    target: { kind: 'branch', branch: 'main' }, branched_from_sha: null, close_reason: null,
    model: null, agent_id: 'claude-code',
    metadata: { github_remote_ref_id: '42', github_remote_ref_url: 'https://github.com/o/r/pull/42' },
    runner_type: null, tags: [], pending_sync: 0,
  } as Task;
  const notes: Array<Comment> = [];
  const meta = new Map<string, string>();
  let clock = Date.parse('2026-09-11T00:00:00Z');
  const storage = {
    getSessionByTaskId: async () => ({ id: 'sess-1' }),
    // The agent's last turn predates everything on the PR.
    getSessionTurns: async () => [{ role: 'agent', timestamp: Date.parse('2026-09-10T00:00:00Z') }],
    getTaskComments: async () => notes,
    createComment: async (_id: string, content: string, _actor?: unknown, source?: CommentSource, options?: CommentCreateOptions) => {
      const c: Comment = { id: `c${notes.length + 1}`, task_id: 'task-1', content, created_at: clock++, source, ...options };
      notes.push(c);
      return c;
    },
    updateComment: async (_id: string, commentId: string, update: CommentUpdate) => {
      const c = notes.find(n => n.id === commentId)!;
      if (update.content !== undefined) { c.content = update.content; c.edited_at = clock++; }
      if (update.external) c.external = update.external;
      return c;
    },
    listTasks: async () => [task],
    getTaskMetadata: async (_id: string, key: string) => meta.get(key) ?? null,
    updateTaskMetadata: async (_id: string, key: string, value: string) => {
      meta.set(key, value);
      task.metadata = { ...(task.metadata ?? {}), [key]: value };
    },
  };
  return { task, notes, storage, meta };
}

describe('forge comments that become visible late', () => {
  test('a line comment drafted before a completed pass, and a review body, both arrive', async () => {
    const { task, notes, storage } = makeStore();

    // Pass 1: a human's immediate comment is the only thing visible.
    issueComments = [{ id: 1, body: 'human says hi', user: { login: 'alice' }, created_at: '2026-09-10T10:00:00Z' }];
    lineComments = [];
    reviews = [];
    await syncTaskFromRemote(task, storage as never, '/nonexistent');
    expect(notes.map(n => n.content)).toEqual(['[PR #42 @alice] human says hi']);
    expect(notes[0].external).toMatchObject({ forge: 'github', kind: 'issue_comment', id: '1' });

    // A second pass that sees nothing new must not lose later arrivals either.
    await syncTaskFromRemote(task, storage as never, '/nonexistent');

    // The bot submits its review now: its line comment was DRAFTED before
    // pass 1 ran, and the review carries a summary body. Review 1 shares its
    // number with comment 1 on purpose: the two id spaces must not collide.
    lineComments = [{
      id: 2, body: 'bot: null check missing', user: { login: 'copilot[bot]' },
      created_at: '2026-09-10T09:59:00Z', path: 'src/a.ts', line: 3,
    }];
    reviews = [
      { id: 1, body: 'Pull request overview: looks fine', user: { login: 'copilot[bot]' }, state: 'COMMENTED', submitted_at: '2026-09-10T11:00:00Z' },
      { id: 8, body: '', user: { login: 'bob' }, state: 'APPROVED', submitted_at: '2026-09-10T11:01:00Z' },
      { id: 9, body: 'my draft', user: { login: 'bob' }, state: 'PENDING' },
      { id: 10, body: '<!-- lazy:review -->\nlazy own', user: { login: 'me' }, state: 'COMMENTED', submitted_at: '2026-09-10T11:02:00Z' },
    ];
    await syncTaskFromRemote(task, storage as never, '/nonexistent');

    const contents = notes.map(n => n.content);
    expect(contents).toHaveLength(3);
    expect(notes.some(n => n.content.includes('bot: null check missing') && n.external?.kind === 'line_comment' && n.external.id === '2')).toBe(true);
    expect(notes.some(n => n.content.includes('Pull request overview') && n.external?.kind === 'review_body' && n.external.id === '1')).toBe(true);

    // And exactly once: another pass imports nothing more.
    await syncTaskFromRemote(task, storage as never, '/nonexistent');
    expect(notes).toHaveLength(3);
  });

  test('a comment older than the last agent turn is imported on the first sync', async () => {
    // Nothing on a PR can be "already seen" by being old: the agent only ever
    // learns of a forge comment through its import.
    const { task, notes, storage } = makeStore();
    issueComments = [{ id: 5, body: 'early review', user: { login: 'bot[bot]' }, created_at: '2026-09-09T00:00:00Z' }];
    lineComments = [];
    reviews = [];
    await syncTaskFromRemote(task, storage as never, '/nonexistent');
    expect(notes.map(n => n.content)).toEqual([expect.stringContaining('early review')]);
  });

  test('comments a link already imported without an id marker are not imported again', async () => {
    // INVARIANT: `lazy link` and linked-PR attachment store a PR's existing
    // comments as unmarked "[author] body" notes. With no timestamp window,
    // the next sync sees those comments again and must recognise them, or
    // every linked task gets its PR history duplicated (and signalled).
    const { task, notes, storage } = makeStore();
    notes.push({ id: 'legacy-1', task_id: 'task-1', created_at: Date.parse('2026-09-09T00:00:00Z'), content: '[github-actions] Build passed', source: 'remote' });
    issueComments = [{ id: 11, body: 'Build passed', user: { login: 'github-actions[bot]' }, created_at: '2026-09-09T00:00:00Z' }];
    lineComments = [];
    reviews = [];
    await syncTaskFromRemote(task, storage as never, '/nonexistent');
    expect(notes).toHaveLength(1);
  });

  test('auto-react imports and reacts to a late comment older than the one it last reacted to', async () => {
    // INVARIANT: auto-react has no "newest id already reacted" shortcut — a
    // late-visible comment sorts BEFORE the newest one, so that shortcut hid it.
    const { task, notes, storage, meta } = makeStore();
    unblocks.length = 0;
    notes.push({ id: 'legacy-1', task_id: 'task-1', created_at: Date.parse('2026-09-09T00:00:00Z'), content: '[PR #42 @alice] {remote:1} human says hi', source: 'remote' });
    meta.set('auto_react_last_comment_id', '1');
    issueComments = [{ id: 1, body: 'human says hi', user: { login: 'alice' }, created_at: '2026-09-10T10:00:00Z' }];
    lineComments = [{ id: 2, body: 'bot: null check missing', user: { login: 'copilot[bot]' }, created_at: '2026-09-10T09:59:00Z', path: 'src/a.ts', line: 3 }];
    reviews = [];
    const cfg = { ...config, daemon: { ...config.daemon, auto_react_comments: true } };
    const result = await runAutoReact(storage as never, '/nonexistent', cfg);
    expect(result.errors).toEqual([]);
    expect(notes.some(n => n.content.includes('bot: null check missing') && n.external?.id === '2')).toBe(true);
    expect(unblocks).toHaveLength(1);
    expect(unblocks[0]).toContain('bot: null check missing');
  });
});
