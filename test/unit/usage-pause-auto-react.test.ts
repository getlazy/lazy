/**
 * A PR comment on a submitted task that arrives during a [usage_pause] is
 * DELAYED, never lost: the reaction turn runs after the window resets.
 *
 * The forge is faked at `runGh` (the real GitHubDriver, the real runAutoReact,
 * the real usage-pause gate against a real reading in the daemon's usage
 * tracker). The auto-unblock launch is the outward boundary and is recorded.
 * Same shape as test/unit/forge-comment-late-visibility.test.ts.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { resolve, join } from 'path';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import { GitHubDriver } from '../../src/remote/github-driver';
import { daemonUsageLimits } from '../../src/proxy/usage-limits';
import { USAGE_PAUSE_HELD_KEY } from '../../src/usage-pause/hold';
import type { GhResult } from '../../src/remote';
import type { ResolvedConfig } from '../../src/config/types';
import type { Task, Comment, CommentSource, CommentCreateOptions } from '../../src/types';

const config: ResolvedConfig = {
  ...DEFAULT_CONFIG,
  remote: { ...DEFAULT_CONFIG.remote, driver: 'github', github_auto_push: false },
  usage_pause: { threshold_percent: 95, credentials: {} },
};

let issueComments: Array<Record<string, unknown>> = [];
const ok = (v: unknown): GhResult => ({ stdout: JSON.stringify(v), stderr: '', exitCode: 0 });
async function fakeGh(args: string[]): Promise<GhResult> {
  if (args[0] === 'repo' && args[1] === 'view') return ok({ isPrivate: true });
  if (args[0] === 'api') {
    const ep = args[1];
    if (ep.endsWith('/issues/42/comments')) return ok(issueComments);
    if (ep.endsWith('/pulls/42/comments')) return ok([]);
    if (ep.endsWith('/pulls/42/reviews')) return ok([]);
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

let recordedAttempts = 0;
const budgetPath = resolve(import.meta.dir, '../../src/daemon/auto-react-budget.ts');
const realBudget = { ...(await import(budgetPath)) };
await mockModule(budgetPath, () => ({
  ...realBudget,
  shouldAutoReact: async () => ({ allowed: true }),
  recordAutoReact: async () => { recordedAttempts++; },
}));

const unblocks: string[] = [];
const deliverPath = resolve(import.meta.dir, '../../src/daemon/auto-deliver.ts');
const realDeliver = { ...(await import(deliverPath)) };
await mockModule(deliverPath, () => ({
  ...realDeliver,
  autoUnblockTask: async (_s: unknown, _t: unknown, _sess: unknown, _root: unknown, feedback: string) => {
    unblocks.push(feedback);
    return true;
  },
}));

const { runAutoReact } = await import('../../src/daemon/auto-react');
const { turnSpendCredential } = await import('../../src/daemon/usage-pause');

afterAll(() => restoreMockedModules());

function makeStore() {
  const task: Task = {
    id: 'task-paused-pr', code: 'paused-pr', goal: 'g', prompt: 'p', type: 'task',
    status: 'submitted', created_at: Date.parse('2026-09-01T00:00:00Z'), completed_at: null,
    target: { kind: 'branch', branch: 'main' }, branched_from_sha: null, close_reason: null,
    model: null, agent_id: 'claude-code',
    metadata: { github_remote_ref_id: '42', github_remote_ref_url: 'https://github.com/o/r/pull/42' },
    runner_type: null, tags: [], pending_sync: 0,
  } as Task;
  const notes: Comment[] = [];
  const meta = new Map<string, string>();
  let clock = Date.parse('2026-09-11T00:00:00Z');
  const storage = {
    getSessionByTaskId: async () => ({ id: 'sess-1' }),
    getSessionTurns: async () => [{ role: 'agent', timestamp: Date.parse('2026-09-10T00:00:00Z') }],
    getTaskComments: async () => notes,
    createComment: async (_id: string, content: string, _actor?: unknown, source?: CommentSource, options?: CommentCreateOptions) => {
      const c: Comment = { id: `c${notes.length + 1}`, task_id: task.id, content, created_at: clock++, source, ...options };
      notes.push(c);
      return c;
    },
    updateComment: async () => { throw new Error('no edits expected'); },
    listTasks: async () => [task],
    getTaskMetadata: async (_id: string, key: string) => meta.get(key) ?? null,
    updateTaskMetadata: async (_id: string, key: string, value: string) => {
      meta.set(key, value);
      task.metadata = { ...(task.metadata ?? {}), [key]: value };
    },
    createSystemMessage: async (input: unknown) => input,
  };
  return { task, notes, storage, meta };
}

function observe(credential: string, ts: number, utilization: string, resetSec: number): void {
  daemonUsageLimits.observeReading({
    credential, ts, upstream: 'https://api.anthropic.com', backend: 'proxy', status: 200,
    taskId: null, model: null,
    headers: {
      'anthropic-ratelimit-unified-5h-utilization': utilization,
      'anthropic-ratelimit-unified-5h-reset': String(resetSec),
    },
  });
}

describe('forge comments during a usage pause', () => {
  // INVARIANT: a held auto-react consumes nothing it retries from. The comment
  // is neither imported nor counted against the auto-react budget while the
  // pause holds, so the pass after the reset still sees it as new and runs the
  // reaction turn. Importing first (the old order) made that pass see nothing.
  test('a PR comment during the pause is reacted to after the reset', async () => {
    // ANTHROPIC_API_KEY, with no OAuth token in the way: a credential key of its
    // own in the process-wide tracker (usage-pause-slow-lane uses the OAuth one).
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = 'sk-test-usage-pause-auto-react';
    const root = await mkdtemp(join(tmpdir(), 'lazy-usage-pause-auto-react-'));
    try {
      const { task, notes, storage, meta } = makeStore();
      const spend = await turnSpendCredential(root, config, task);
      expect(spend?.credential).toBe('credential:ANTHROPIC_API_KEY');
      const now = Date.now();
      observe(spend!.credential, now, '0.97', Math.floor(now / 1000) + 3600);

      // Pass 1, paused: a reviewer comments on the PR.
      issueComments = [{ id: 7, body: 'please fix the typo', user: { login: 'alice' }, created_at: '2026-09-12T10:00:00Z' }];
      const first = await runAutoReact(storage as never, root, config);
      expect(first.errors).toEqual([]);
      expect(first.commentUnblocked).toEqual([]);
      expect(unblocks).toEqual([]);
      expect(notes).toEqual([]);
      expect(recordedAttempts).toBe(0);
      expect(JSON.parse(meta.get(USAGE_PAUSE_HELD_KEY) ?? 'null')?.held).toBe('auto-react (PR comment)');

      // The window resets (a fresher reading, well under the threshold).
      observe(spend!.credential, now + 1, '0.02', Math.floor(now / 1000) + 5 * 3600);

      // Pass 2: the same comment is still new, and the reaction turn runs.
      const second = await runAutoReact(storage as never, root, config);
      expect(second.commentUnblocked).toEqual([task.id.substring(0, 8)]);
      expect(unblocks).toHaveLength(1);
      expect(unblocks[0]).toContain('please fix the typo');
      expect(notes.map((n) => n.content)).toEqual(['[PR #42 @alice] please fix the typo']);
      expect(recordedAttempts).toBe(1);
      expect(meta.get(USAGE_PAUSE_HELD_KEY) ?? '').toBe('');
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
      if (savedOauth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOauth;
    }
  });
});
