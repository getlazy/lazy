/**
 * `lazy submit` on a task that integrates into an INTERMEDIATE branch — a task
 * stacked on another task, whose merge target is the parent task's branch.
 *
 * The rule (engineer decision 2026-09-24, CLAUDE.md "PRs only for protected
 * branches"): by DEFAULT lazy never opens a PR/MR for an intermediate branch —
 * accept merges locally and no automatic path creates one. An explicit submit
 * by a PERSON is the request, and it is honoured: the PR/MR opens against the
 * parent's branch and is tracked like any submitted task. The MCP door keeps
 * the refusal.
 *
 * Harness: a real daemon with the fake forge (test/mocks/remote.ts) armed as a
 * hosted driver (`LAZY_MOCK_NEEDS_SYNC`). Per-test forge state lives in files
 * under the protocol base, because the daemon's env is fixed at startup:
 *   - mock-review-create.json   arms PR creation; creations are logged, with
 *                               their base, to mock-review-created.jsonl
 *   - mock-remote-branches.json which branches the remote has
 *   - mock-open-review.json     a PR a person opened by hand
 *   - mock-pr-state.json        the PR's state (the close step flips it)
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readSessionJson, readTaskJson, readTaskStatus, setTaskMetadata } from '../helpers/storage';
import { seedFinal } from '../helpers/final';
import { runMcpSession } from '../helpers/mcp-session';

const PR_URL = 'https://github.com/o/r/pull/7';

describe('lazy submit into an intermediate branch', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_NEEDS_SYNC: '1' },
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function writeForge(name: string, payload: unknown): void {
    writeFileSync(join(ctx.protocolBase, name), JSON.stringify(payload));
  }

  function createdReviews(): Array<{ taskId: string; base: string | null }> {
    const path = join(ctx.protocolBase, 'mock-review-created.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  function forgeCloses(): string[] {
    const path = join(ctx.protocolBase, 'mock-forge-write-calls.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; taskId: string })
      .filter((w) => w.kind === 'close')
      .map((w) => w.taskId);
  }

  async function startAndWait(taskId: string): Promise<void> {
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    const waitResult = await ctx.lazy(['wait', taskId]);
    if (waitResult.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
    }
  }

  /** A started parent and a blocked child with committed work, stacked on it. */
  async function parentAndChild(): Promise<{ parentId: string; childId: string; parentBranch: string; childBranch: string }> {
    const parentId = await createTask(ctx, 'Parent work', 'Do the parent part');
    await startAndWait(parentId);

    const created = await ctx.lazy(['create', '--goal', 'Child work', '--prompt', 'Do the child part', '--parent', parentId]);
    expectSuccess(created);
    const match = created.stdout.match(/([0-9a-f]{8})/);
    if (!match) throw new Error(`no child id in: ${created.stdout}`);
    const childId = match[1];
    await startAndWait(childId);
    expect(readTaskStatus(ctx.root, childId)).toBe('blocked');

    const parentBranch = readSessionJson(ctx.root, parentId)!.git_branch as string;
    const childBranch = readSessionJson(ctx.root, childId)!.git_branch as string;
    return { parentId, childId, parentBranch, childBranch };
  }

  // INVARIANT: an explicit `lazy submit` by a person on a stacked task opens
  // the PR/MR against the PARENT task's branch — never main, never refused —
  // and records it on the task like any other submitted task. The reviewer is
  // waiting on that PR; "nope, can't do" is what the engineer hit.
  test('a person\'s submit opens the PR against the parent branch and tracks it', async () => {
    const { childId, parentBranch } = await parentAndChild();
    writeForge('mock-review-create.json', { url: PR_URL, id: '7' });
    writeForge('mock-remote-branches.json', { [parentBranch]: 'abc123' });

    const result = await ctx.lazy(['submit', childId, '--yes']);
    expectSuccess(result);
    expect(result.stdout).toContain(PR_URL);

    expect(createdReviews()).toEqual([{ taskId: readTaskJson(ctx.root, childId).id, base: parentBranch }]);
    expect(readTaskStatus(ctx.root, childId)).toBe('submitted');
    const meta = readTaskJson(ctx.root, childId).metadata;
    expect(meta.github_remote_ref_url).toBe(PR_URL);
    expect(meta.github_remote_ref_id).toBe('7');
  }, 120_000);

  // INVARIANT: submit never pushes the PARENT branch to make a base exist.
  // When the parent's branch is not on the remote, submit refuses and says
  // exactly that and how to fix it — before any PR is attempted. The fix is
  // worded for every surface that shows it: a Lazy Teams member reads the same
  // text and has no shell, so it names no command to run.
  test('refuses, naming the fix, when the parent branch is not on the remote', async () => {
    const { childId, parentBranch } = await parentAndChild();
    writeForge('mock-review-create.json', { url: PR_URL, id: '7' });
    writeForge('mock-remote-branches.json', {});

    const result = await ctx.lazy(['submit', childId, '--yes']);
    expectFailure(result);
    expect(result.stderr).toContain(`\`${parentBranch}\` is not on origin`);
    expect(result.stderr).toContain('never pushes a parent task\'s branch');
    expect(result.stderr).toContain(`once someone has pushed \`${parentBranch}\` to origin`);
    expect(result.stderr).not.toContain('git push');
    expect(result.stderr).not.toContain('lazy submit');
    expect(createdReviews()).toEqual([]);
    expect(readTaskStatus(ctx.root, childId)).toBe('blocked');
  }, 120_000);

  // INVARIANT: the default is unchanged — the MCP door (builder or agent)
  // still refuses an intermediate target, and says a person can ask for it.
  test('lazy_submit over MCP still refuses an intermediate target', async () => {
    const { childId, parentBranch } = await parentAndChild();
    writeForge('mock-review-create.json', { url: PR_URL, id: '7' });
    writeForge('mock-remote-branches.json', { [parentBranch]: 'abc123' });

    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_submit', arguments: { task_id: childId } } },
    ]);
    const reply = responses.find((r) => r.id === 2);
    expect(reply?.result?.isError).toBe(true);
    const text = reply?.result?.content?.[0]?.text ?? '';
    expect(text).toContain('intermediate task branch');
    expect(text).toContain(`lazy submit ${childId}`);
    expect(text).not.toContain('confirmation_code');
    expect(createdReviews()).toEqual([]);
  }, 120_000);

  // INVARIANT: accept of a task submitted into an intermediate branch still
  // merges LOCALLY (mergeLandsLocally is unchanged), and the PR is then
  // CLOSED — the forge cannot see a local squash as a merge of it, and a PR
  // left open would say the work had not landed. Store and forge agree.
  test('accept after such a submit merges locally and closes the PR', async () => {
    const { parentId, childId, parentBranch, childBranch } = await parentAndChild();
    writeForge('mock-review-create.json', { url: PR_URL, id: '7' });
    writeForge('mock-remote-branches.json', { [parentBranch]: 'abc123' });
    expectSuccess(await ctx.lazy(['submit', childId, '--yes']));
    const parentHeadBefore = ctx.git('rev-parse', parentBranch).stdout.trim();

    seedFinal(ctx, childId);
    // --allow-queued-comments: submit's own "[Submitted]" record is written as
    // the person's comment and counts as undelivered feedback — true of every
    // submitted task, not just this path, and raised separately.
    const accepted = await ctx.lazy(['accept', childId, '--reason', 'Reviewed on the PR', '--allow-queued-comments']);
    expectSuccess(accepted);

    expect(readTaskStatus(ctx.root, childId)).toBe('complete');
    // Landed on the local parent branch — not through the forge.
    expect(ctx.git('rev-parse', parentBranch).stdout.trim()).not.toBe(parentHeadBefore);
    expect(readTaskStatus(ctx.root, parentId)).not.toBe('complete');
    // Closed, exactly once, and the follow-through owes nothing.
    expect(forgeCloses()).toEqual([childBranch]);
    expect(JSON.parse(readFileSync(join(ctx.protocolBase, 'mock-pr-state.json'), 'utf-8')).state).toBe('CLOSED');
    expect(readTaskJson(ctx.root, childId).metadata?.accept_followthrough ?? '').toBe('');
  }, 180_000);

  // INVARIANT: an accept made while lazy is OFFLINE still owes the PR close.
  // Offline, the merge driver is local and cannot see the task's PR, so the
  // decision to close must come from the CONFIGURED forge; the close itself
  // waits (the step refuses offline) and runs once lazy is back online.
  test('an offline accept closes the PR once lazy is back online', async () => {
    const { childId, parentBranch, childBranch } = await parentAndChild();
    writeForge('mock-review-create.json', { url: PR_URL, id: '7' });
    writeForge('mock-remote-branches.json', { [parentBranch]: 'abc123' });
    expectSuccess(await ctx.lazy(['submit', childId, '--yes']));

    expectSuccess(await ctx.lazy(['system', 'offline']));
    seedFinal(ctx, childId);
    const accepted = await ctx.lazy(['accept', childId, '--reason', 'Reviewed on the PR', '--allow-queued-comments']);
    // Accepted all the same — the close is follow-through the accept reports as owed.
    expect(readTaskStatus(ctx.root, childId)).toBe('complete');
    expect(accepted.stdout + accepted.stderr).toContain('close-review');
    expect(forgeCloses()).toEqual([]);
    const owed = JSON.parse(readTaskJson(ctx.root, childId).metadata.accept_followthrough);
    expect(owed.closeReview).toBe(true);
    expect(owed.done).not.toContain('close-review');

    // Back online; skip the backoff and let the daemon's sweep retry.
    expectSuccess(await ctx.lazy(['system', 'online']));
    setTaskMetadata(ctx.root, childId, 'accept_followthrough', JSON.stringify({ ...owed, nextAttemptAt: 0 }));
    const deadline = Date.now() + 60_000;
    while (readTaskJson(ctx.root, childId).metadata?.accept_followthrough && Date.now() < deadline) {
      await Bun.sleep(500);
    }
    expect(readTaskJson(ctx.root, childId).metadata?.accept_followthrough ?? '').toBe('');
    expect(forgeCloses()).toEqual([childBranch]);
    expect(JSON.parse(readFileSync(join(ctx.protocolBase, 'mock-pr-state.json'), 'utf-8')).state).toBe('CLOSED');
  }, 180_000);

  // INVARIANT: "the PR exists but lazy doesn't know about it" is adopted, not
  // duplicated: a PR a person opened by hand for the task's branch becomes the
  // task's PR, and no second one is created.
  test('adopts a PR a person opened by hand instead of opening a second one', async () => {
    const { childId, parentBranch, childBranch } = await parentAndChild();
    writeForge('mock-review-create.json', { url: 'https://github.com/o/r/pull/999', id: '999' });
    writeForge('mock-remote-branches.json', { [parentBranch]: 'abc123' });
    writeForge('mock-open-review.json', {
      branch: childBranch,
      url: PR_URL,
      baseBranch: parentBranch,
      metadata: { github_remote_ref_url: PR_URL, github_remote_ref_id: '7' },
    });

    const result = await ctx.lazy(['submit', childId, '--yes']);
    expectSuccess(result);
    expect(result.stdout).toContain('Adopted the existing PR/MR');
    expect(createdReviews()).toEqual([]);
    expect(readTaskStatus(ctx.root, childId)).toBe('submitted');
    expect(readTaskJson(ctx.root, childId).metadata.github_remote_ref_url).toBe(PR_URL);
  }, 120_000);

  // INVARIANT: a hand-opened PR whose base is NOT where the task integrates is
  // never silently adopted — lazy's record would then disagree with the forge
  // about where the work goes. Submit refuses and names both branches.
  test('refuses to adopt a hand-opened PR with the wrong base', async () => {
    const { childId, parentBranch, childBranch } = await parentAndChild();
    writeForge('mock-review-create.json', { url: 'https://github.com/o/r/pull/999', id: '999' });
    writeForge('mock-remote-branches.json', { [parentBranch]: 'abc123' });
    writeForge('mock-open-review.json', {
      branch: childBranch,
      url: PR_URL,
      baseBranch: 'main',
      metadata: { github_remote_ref_url: PR_URL, github_remote_ref_id: '7' },
    });

    const result = await ctx.lazy(['submit', childId, '--yes']);
    expectFailure(result);
    expect(result.stderr).toContain('merges into `main`');
    expect(result.stderr).toContain(`integrates into \`${parentBranch}\``);
    // Worded for every surface, Lazy Teams included: no shell command in it.
    expect(result.stderr).not.toContain('lazy submit');
    expect(createdReviews()).toEqual([]);
    expect(readTaskStatus(ctx.root, childId)).toBe('blocked');
  }, 120_000);

  // INVARIANT: no AUTOMATIC path opens a PR for an intermediate branch. An
  // accept with no submit before it merges locally and creates nothing, even
  // with PR creation armed on the forge.
  test('accept without a submit opens no PR for a stacked task', async () => {
    const { childId, parentBranch } = await parentAndChild();
    writeForge('mock-review-create.json', { url: PR_URL, id: '7' });
    writeForge('mock-remote-branches.json', { [parentBranch]: 'abc123' });

    seedFinal(ctx, childId);
    expectSuccess(await ctx.lazy(['accept', childId, '--reason', 'Fine']));
    expect(readTaskStatus(ctx.root, childId)).toBe('complete');
    expect(createdReviews()).toEqual([]);
    expect(forgeCloses()).toEqual([]);
  }, 180_000);
});
