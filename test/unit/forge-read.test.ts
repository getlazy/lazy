import { describe, test, expect, beforeEach } from 'bun:test';
import { DEFAULT_CONFIG } from '../../src/config/loader';
import { GitHubDriver, type DriverDeps, type GhResult } from '../../src/remote/github-driver';
import { GitLabDriver, type GitLabDriverDeps, type GlResult } from '../../src/remote/gitlab-driver';
import { LocalDriver } from '../../src/remote/local-driver';
import { readTaskForge, resetForgeReadCacheForTest, forgeReadCacheSizeForTest, FORGE_READ_TTL_MS } from '../../src/daemon/forge-read';
import type { RepositoryDriver } from '../../src/remote/driver';
import type { ResolvedConfig } from '../../src/config/types';
import type { Storage } from '../../src/storage';
import type { Task } from '../../src/types';

/**
 * The read-only forge tools (`lazy_review_comments`, `lazy_review_status`):
 * the driver reads and the daemon-side scoping and cache.
 */

function makeTask(id: string, metadata: Record<string, string>): Task {
  return {
    id, code: id, goal: 'g', prompt: '', type: 'task', status: 'submitted', model: null, agent_id: 'claude-code',
    created_at: 0, completed_at: null, target: { kind: 'branch', branch: 'main' }, branched_from_sha: null,
    close_reason: null, metadata, pending_sync: 0, runner_type: null, tags: [],
  } as Task;
}

function config(publicOptIn = false): ResolvedConfig {
  return {
    ...DEFAULT_CONFIG,
    remote: {
      ...DEFAULT_CONFIG.remote,
      github_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: publicOptIn,
      gitlab_dangerously_sync_comments_in_public_repos_and_open_yourself_to_prompt_injection: publicOptIn,
    },
  } as ResolvedConfig;
}

const ok = (v: unknown): GhResult => ({ stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '', exitCode: 0 });
const gitOk = async () => ({ stdout: 'git@github.com:o/r.git', stderr: '', exitCode: 0 });

describe('GitHubDriver on-demand review reads', () => {
  const task = makeTask('t1', { github_remote_ref_id: '7', github_remote_ref_url: 'https://github.com/o/r/pull/7' });

  function driver(isPrivate: boolean, publicOptIn = false, override?: (args: string[]) => GhResult | null): GitHubDriver {
    const deps: DriverDeps = {
      runGh: async (args) => {
        const overridden = override?.(args);
        if (overridden) return overridden;
        if (args[0] === 'repo') return ok({ isPrivate });
        const path = args.find((a) => a.startsWith('repos/') || a === 'graphql');
        if (path?.endsWith('/issues/7/comments')) return ok([{ id: 1, body: 'top', user: { login: 'amy' }, created_at: '2026-01-01T00:00:01Z' }]);
        if (path?.endsWith('/pulls/7/comments')) return ok([{ id: 2, body: 'nit', user: { login: 'bo' }, created_at: '2026-01-01T00:00:02Z', path: 'a.ts', line: 3 }]);
        if (path?.endsWith('/pulls/7/reviews')) {
          return ok([
            { id: 3, body: 'fix it', state: 'CHANGES_REQUESTED', user: { login: 'bo' }, submitted_at: '2026-01-01T00:00:03Z' },
            { id: 4, body: '', state: 'PENDING', user: { login: 'me' } },
          ]);
        }
        if (path === 'graphql') {
          return ok({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true, comments: { nodes: [{ databaseId: 2 }] } }] } } } } });
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          return ok({
            state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED',
            reviews: [
              { author: { login: 'bo' }, state: 'COMMENTED', submittedAt: '1' },
              { author: { login: 'bo' }, state: 'APPROVED', submittedAt: '2' },
            ],
            statusCheckRollup: [
              { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'u' },
              { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', targetUrl: 'v' },
              { __typename: 'StatusContext', context: 'ci/slow', state: 'PENDING', targetUrl: 'w' },
            ],
          });
        }
        return { stdout: '', stderr: `unexpected: ${args.join(' ')}`, exitCode: 1 };
      },
      runGit: gitOk,
    };
    return new GitHubDriver(config(publicOptIn), deps);
  }

  test('reads comments, inline comments with resolution, and submitted reviews, oldest first', async () => {
    const items = await driver(true).readReviewConversation(task);
    expect(items.map((i) => [i.kind, i.id, i.author])).toEqual([
      ['comment', '1', 'amy'], ['inline', '2', 'bo'], ['review', '3', 'bo'],
    ]);
    expect(items[1]).toMatchObject({ path: 'a.ts', line: 3, resolved: true });
    expect(items[2].state).toBe('CHANGES_REQUESTED');
  });

  // INVARIANT: a public repo's PR comments are refused unless the human opted
  // in with the same flag the import path uses. Anyone can write them, and this
  // read puts them straight into an agent's context (prompt injection).
  test('refuses a public repo without the opt-in, reads it with one', async () => {
    await expect(driver(false).readReviewConversation(task)).rejects.toThrow(/public/);
    expect((await driver(false, true).readReviewConversation(task)).length).toBe(3);
  });

  test('status keeps the latest verdict per reviewer and maps both check kinds', async () => {
    const status = await driver(true).readReviewStatus(task);
    expect(status).toMatchObject({ state: 'OPEN', decision: 'CHANGES_REQUESTED', mergeable: 'BLOCKED' });
    expect(status.reviews).toEqual([{ author: 'bo', state: 'APPROVED', submittedAt: '2' }]);
    expect(status.checks).toEqual([
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', url: 'u' },
      { name: 'ci/legacy', status: 'COMPLETED', conclusion: 'SUCCESS', url: 'v' },
      { name: 'ci/slow', status: 'PENDING', conclusion: null, url: 'w' },
    ]);
  });

  // A failed visibility lookup is a forge/auth failure, and must be reported
  // as one — never as "public", which would point at the prompt-injection opt-in.
  test('a failed visibility lookup names the failure, not "public"', async () => {
    const d = driver(true, false, (args) => (args[0] === 'repo' ? { stdout: '', stderr: 'gh auth: not logged in', exitCode: 1 } : null));
    const err = await d.readReviewConversation(task).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('could not read repository visibility: gh auth: not logged in');
    expect(err?.message).not.toContain('public');
  });

  test('a failed thread-resolution query still returns the comments, without resolved', async () => {
    const d = driver(true, false, (args) => (args.includes('graphql') ? { stdout: '', stderr: 'HTTP 403', exitCode: 1 } : null));
    const items = await d.readReviewConversation(task);
    expect(items.length).toBe(3);
    expect(items[1].resolved).toBeUndefined();
  });

  // INVARIANT: a failed forge read THROWS. An empty list would tell the agent
  // "nobody commented" when the truth is "lazy could not ask".
  test('a failing forge call throws rather than answering empty', async () => {
    const d = new GitHubDriver(config(), {
      runGh: async (args) => (args[0] === 'repo' ? ok({ isPrivate: true }) : { stdout: '', stderr: 'HTTP 502', exitCode: 1 }),
      runGit: gitOk,
    });
    await expect(d.readReviewConversation(task)).rejects.toThrow(/HTTP 502/);
    await expect(d.readReviewStatus(task)).rejects.toThrow(/HTTP 502/);
  });
});

describe('GitLabDriver on-demand review reads', () => {
  const task = makeTask('t2', { gitlab_remote_ref_id: '9', gitlab_remote_ref_url: 'https://gitlab.com/o/r/-/merge_requests/9' });
  const gl = (v: unknown): GlResult => ({ stdout: JSON.stringify(v), stderr: '', exitCode: 0 });
  const deps: GitLabDriverDeps = {
    runGl: async (args) => {
      const path = args[1] ?? '';
      if (args[0] === 'repo' || path === 'projects/:id') return gl({ visibility: 'private' });
      if (path.endsWith('/merge_requests/9/notes')) {
        return gl([
          { id: 1, body: 'sys', system: true, created_at: '0' },
          { id: 2, body: 'top', author: { username: 'amy' }, created_at: '1' },
          { id: 3, body: 'nit', author: { username: 'bo' }, created_at: '2', position: { new_path: 'a.ts', new_line: 4 }, resolvable: true, resolved: false },
        ]);
      }
      if (path.endsWith('/merge_requests/9')) return gl({ state: 'opened', detailed_merge_status: 'not_approved' });
      if (path.endsWith('/merge_requests/9/approvals')) return gl({ approved_by: [{ user: { username: 'cy' } }] });
      if (path.endsWith('/merge_requests/9/pipelines')) return gl([{ id: 55, status: 'failed' }]);
      if (path.endsWith('/pipelines/55/jobs')) return gl([{ name: 'lint', status: 'failed', web_url: 'j' }]);
      return { stdout: '', stderr: `unexpected: ${args.join(' ')}`, exitCode: 1 };
    },
    runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  };

  test('reads non-system notes with inline position and resolution', async () => {
    const items = await new GitLabDriver(config(), deps).readReviewConversation(task);
    expect(items.map((i) => [i.kind, i.id])).toEqual([['comment', '2'], ['inline', '3']]);
    expect(items[0].resolved).toBeUndefined();
    expect(items[1]).toMatchObject({ path: 'a.ts', line: 4, resolved: false });
  });

  test('status carries state, approvers, merge status and the latest pipeline jobs', async () => {
    const status = await new GitLabDriver(config(), deps).readReviewStatus(task);
    expect(status).toMatchObject({ state: 'OPEN', mergeable: 'not_approved' });
    expect(status.reviews).toEqual([{ author: 'cy', state: 'APPROVED', submittedAt: '' }]);
    expect(status.checks).toEqual([{ name: 'lint', status: 'failed', conclusion: null, url: 'j' }]);
  });
});

test('the local driver has no forge to read', async () => {
  const t = makeTask('t3', {});
  await expect(new LocalDriver().readReviewConversation(t)).rejects.toThrow(/no forge/);
  await expect(new LocalDriver().readReviewStatus(t)).rejects.toThrow(/no forge/);
});

describe('readTaskForge scoping and cache', () => {
  const mine = makeTask('mine', { github_remote_ref_id: '1' });
  const other = makeTask('other', { github_remote_ref_id: '2' });
  const bare = makeTask('bare', {});
  const tasks = [mine, other, bare];
  const storage = {
    getTask: async (id: string) => tasks.find((t) => t.id === id) ?? null,
    resolveTask: async (ref: string) => ({ task: tasks.find((t) => t.id === ref) ?? null }),
  } as unknown as Storage;

  let reads: string[];
  const fake = {
    hasRemoteRef: (t: Task) => Boolean(t.metadata?.github_remote_ref_id),
    getRemoteRefUrl: (t: Task) => `https://forge/pr/${t.metadata?.github_remote_ref_id}`,
    readReviewConversation: async (t: Task) => { reads.push(`c:${t.id}`); return []; },
    readReviewStatus: async (t: Task) => { reads.push(`s:${t.id}`); return { state: 'OPEN', decision: null, reviews: [], mergeable: null, checks: [] }; },
  } as unknown as RepositoryDriver;

  beforeEach(() => {
    reads = [];
    resetForgeReadCacheForTest();
  });

  // INVARIANT: a task agent reads ONLY its own task's PR/MR. Scope comes from
  // the token (the caller), never an argument, so the daemon's forge
  // credential cannot be pointed at another task's review.
  test('a task agent reads its own PR and is refused another task', async () => {
    const caller = { kind: 'task' as const, taskId: 'mine' };
    const r = await readTaskForge('/p', storage, caller, 'status', { driver: fake });
    expect(r).toMatchObject({ task: 'mine', url: 'https://forge/pr/1', cached: false });
    expect((await readTaskForge('/p', storage, caller, 'conversation', { driver: fake, taskRef: 'mine' })).task).toBe('mine');
    await expect(readTaskForge('/p', storage, caller, 'status', { driver: fake, taskRef: 'other' })).rejects.toThrow(/only its own/);
    expect(reads).not.toContain('s:other');
  });

  test('the builder may read any task, and must name one', async () => {
    const builder = { kind: 'builder' as const };
    expect((await readTaskForge('/p', storage, builder, 'status', { driver: fake, taskRef: 'other' })).task).toBe('other');
    await expect(readTaskForge('/p', storage, builder, 'status', { driver: fake })).rejects.toThrow(/`task` is required/);
  });

  test('a task with no recorded PR/MR is refused without asking the forge', async () => {
    await expect(readTaskForge('/p', storage, { kind: 'builder' }, 'conversation', { driver: fake, taskRef: 'bare' }))
      .rejects.toThrow(/no PR\/MR recorded/);
    expect(reads).toEqual([]);
  });

  // INVARIANT: answers are cached per task and kind for FORGE_READ_TTL_MS, so a
  // polling agent cannot burn the forge's rate limit through the daemon.
  test('a repeat read within the TTL is served from cache; after it the forge is asked again', async () => {
    const caller = { kind: 'task' as const, taskId: 'mine' };
    await readTaskForge('/p', storage, caller, 'status', { driver: fake, now: 1_000 });
    const again = await readTaskForge('/p', storage, caller, 'status', { driver: fake, now: 1_000 + FORGE_READ_TTL_MS - 1 });
    expect(again.cached).toBe(true);
    expect(again.fetchedAt).toBe(new Date(1_000).toISOString());
    await readTaskForge('/p', storage, caller, 'conversation', { driver: fake, now: 2_000 });
    expect(reads).toEqual(['s:mine', 'c:mine']);
    await readTaskForge('/p', storage, caller, 'status', { driver: fake, now: 1_000 + FORGE_READ_TTL_MS });
    expect(reads).toEqual(['s:mine', 'c:mine', 's:mine']);
  });

  test('expired answers are evicted, so the cache holds only the last TTL', async () => {
    const builder = { kind: 'builder' as const };
    await readTaskForge('/p', storage, builder, 'status', { driver: fake, taskRef: 'mine', now: 0 });
    await readTaskForge('/p', storage, builder, 'conversation', { driver: fake, taskRef: 'mine', now: 0 });
    expect(forgeReadCacheSizeForTest()).toBe(2);
    await readTaskForge('/p', storage, builder, 'status', { driver: fake, taskRef: 'other', now: FORGE_READ_TTL_MS });
    expect(forgeReadCacheSizeForTest()).toBe(1);
  });
});
