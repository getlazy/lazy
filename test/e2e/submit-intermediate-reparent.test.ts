/**
 * A subtask submitted into its parent's branch, whose parent is then ACCEPTED
 * into a protected target — the subtask is reparented onto that target, but
 * the PR/MR a person opened for it still names the old parent branch as base.
 *
 * Remote task branches are never deleted, so a forge merge of that PR lands
 * the work in the dead parent branch, not in the subtask's target. These
 * suites pin that lazy never records such a merge as the task being accepted,
 * and that the reparent retargets the PR (or closes it) so the situation does
 * not arise in the first place.
 *
 * Harness: a real daemon with the fake forge (test/mocks/remote.ts) as a
 * hosted driver whose every named branch is protected, plus a bare `origin`
 * with `main` pushed — a root task's forge accept checks it is in step with
 * origin. The one mock PR's state (and base) is `mock-pr-state.json`; forge
 * merges are logged, with the base they would land in, to `mock-merges.jsonl`.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readSessionJson, readTaskJson, readTaskStatus, readSystemMessagesFile, setTaskMetadata, setTaskStatus } from '../helpers/storage';
import { seedFinal } from '../helpers/final';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

const PR_URL = 'https://github.com/o/r/pull/7';

describe('a submitted subtask whose parent is accepted into a protected target', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_NEEDS_SYNC: '1', LAZY_MOCK_PROTECTED_BRANCH: '1' },
    });
    const bare = join(ctx.root, '.test-remote.git');
    const init = spawnSyncUnsupervised(['git', 'init', '--bare', bare], { stdout: 'pipe', stderr: 'pipe' });
    if (init.exitCode !== 0) throw new Error(`git init --bare failed: ${init.stderr}`);
    ctx.git('remote', 'add', 'origin', bare);
    const push = ctx.git('push', 'origin', 'main');
    if (push.exitCode !== 0) throw new Error(`git push origin main failed: ${push.stderr}`);
    // The protected target needs a forge approval; the child's PR is the only
    // one with a remote ref, so hasRemoteRef is left to the task's metadata.
    writeForge('mock-approval.json', { hasExternalApproval: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  function writeForge(name: string, payload: unknown): void {
    writeFileSync(join(ctx.protocolBase, name), JSON.stringify(payload));
  }

  function readForge<T>(name: string): T {
    return JSON.parse(readFileSync(join(ctx.protocolBase, name), 'utf-8')) as T;
  }

  function merges(): Array<{ taskId: string; target: string; prBase: string | null }> {
    const path = join(ctx.protocolBase, 'mock-merges.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  async function startAndWait(taskId: string): Promise<void> {
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    // This suite's daemon has a remote, so right after the first turn its sync
    // can run a short sync turn: `lazy wait` then reports `working` (exit 1)
    // and the task is `blocked` again a moment later. Wait until it settles.
    for (let attempt = 0; ; attempt++) {
      const waitResult = await ctx.lazy(['wait', taskId]);
      if (waitResult.exitCode === 0) return;
      if (attempt >= 3 || !waitResult.stdout.includes('is now working')) {
        throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
      }
    }
  }

  /**
   * Parent P and child C; C submitted by a person (PR base = P's branch); P
   * accepted into `main`, which reparents C onto `main`.
   */
  async function submittedChildOfAcceptedParent(
    opts: { retargetFails?: boolean; stateUnreadable?: boolean; grandchild?: boolean } = {},
  ): Promise<{ parentId: string; childId: string; parentBranch: string; childBranch: string; childFullId: string; grandchildId: string | null }> {
    const parentId = await createTask(ctx, 'Parent work', 'Do the parent part');
    await startAndWait(parentId);
    const created = await ctx.lazy(['create', '--goal', 'Child work', '--prompt', 'Do the child part', '--parent', parentId]);
    expectSuccess(created);
    const childId = created.stdout.match(/([0-9a-f]{8})/)![1];
    await startAndWait(childId);
    const parentBranch = readSessionJson(ctx.root, parentId)!.git_branch as string;

    writeForge('mock-review-create.json', { url: PR_URL, id: '7' });
    writeForge('mock-remote-branches.json', { [parentBranch]: 'abc123' });
    expectSuccess(await ctx.lazy(['submit', childId, '--yes']));
    expect(readForge<{ base: string }>('mock-pr-state.json').base).toBe(parentBranch);

    // The parent has no PR of its own; the protected target wants an approved
    // one. The override lasts only for the parent's accept.
    writeForge('mock-approval.json', { hasRemoteRef: true, hasExternalApproval: true });
    if (opts.retargetFails) writeForge('mock-retarget-fails.json', {});
    if (opts.stateUnreadable) writeForge('mock-pr-state-unreadable-after-close.json', {});
    let grandchildId: string | null = null;
    if (opts.grandchild) {
      const g = await ctx.lazy(['create', '--goal', 'Grandchild work', '--prompt', 'Later', '--parent', childId]);
      expectSuccess(g);
      grandchildId = g.stdout.match(/([0-9a-f]{8})/)![1];
    }
    seedFinal(ctx, parentId);
    expectSuccess(await ctx.lazy(['accept', parentId, '--reason', 'Parent done', '--allow-queued-comments']));
    writeForge('mock-approval.json', { hasExternalApproval: true });
    expect(readTaskStatus(ctx.root, parentId)).toBe('complete');
    // Reparented onto the parent's own target.
    expect(readTaskJson(ctx.root, childId).target).toEqual({ kind: 'branch', branch: 'main' });
    const childBranch = readSessionJson(ctx.root, childId)!.git_branch as string;
    return { parentId, childId, parentBranch, childBranch, childFullId: readTaskJson(ctx.root, childId).id, grandchildId };
  }

  function forgeCloses(): string[] {
    const path = join(ctx.protocolBase, 'mock-forge-write-calls.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; taskId: string })
      .filter((w) => w.kind === 'close')
      .map((w) => w.taskId);
  }

  // INVARIANT (src/daemon/review-retarget.ts): accepting the parent retargets
  // the child's open PR onto the child's new target, so the child's forge
  // accept then merges into that target — the work lands where the task goes.
  test('accepting the parent retargets the child\'s PR, and the child then merges into main', async () => {
    const { childId, childFullId } = await submittedChildOfAcceptedParent();
    expect(readForge<{ state: string; base: string }>('mock-pr-state.json')).toEqual({ state: 'OPEN', base: 'main' });
    expect(readTaskStatus(ctx.root, childId)).toBe('submitted');

    seedFinal(ctx, childId);
    expectSuccess(await ctx.lazy(['accept', childId, '--reason', 'Ship it', '--allow-queued-comments']));
    expect(readTaskStatus(ctx.root, childId)).toBe('complete');
    expect(merges().filter((m) => m.taskId === childFullId)).toEqual([{ taskId: childFullId, target: 'main', prBase: 'main' }]);
  }, 240_000);

  // INVARIANT (src/daemon/review-retarget.ts): `lazy reparent` of a submitted
  // task moves its open PR too — the same rule as a reparent by accept.
  test('lazy reparent of a submitted child retargets its PR onto the new parent', async () => {
    const parentId = await createTask(ctx, 'Parent work', 'Do the parent part');
    await startAndWait(parentId);
    const created = await ctx.lazy(['create', '--goal', 'Child work', '--prompt', 'Do the child part', '--parent', parentId]);
    expectSuccess(created);
    const childId = created.stdout.match(/([0-9a-f]{8})/)![1];
    await startAndWait(childId);
    const parentBranch = readSessionJson(ctx.root, parentId)!.git_branch as string;
    writeForge('mock-review-create.json', { url: PR_URL, id: '7' });
    writeForge('mock-remote-branches.json', { [parentBranch]: 'abc123' });
    expectSuccess(await ctx.lazy(['submit', childId, '--yes']));

    const reparented = await ctx.lazyMocked(['reparent', childId, '--parent', 'main', '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(reparented);
    expect(readForge<{ base: string }>('mock-pr-state.json').base).toBe('main');
    expect(reparented.stdout + reparented.stderr).toContain('[PR retargeted]');
  }, 240_000);

  // INVARIANT (src/daemon/lazy-closed-review.ts): lazy's own close is never
  // read as somebody else's. The forge refuses the retarget, lazy closes the
  // PR, and the forge's answer cannot be read — so the task keeps its PR record
  // and the "lazy closed this PR" marker. When the next remote-sync pass reads
  // CLOSED, the task lives on: it goes back to blocked, is NOT abandoned, and
  // its own subtask stays under it. Before the marker, that pass abandoned the
  // live task and moved its children away over lazy's own close.
  test('an unconfirmed close read as CLOSED later settles the child instead of abandoning it', async () => {
    const { childId, grandchildId } = await submittedChildOfAcceptedParent({
      retargetFails: true, stateUnreadable: true, grandchild: true,
    });
    const afterAccept = readTaskJson(ctx.root, childId);
    expect(readTaskStatus(ctx.root, childId)).toBe('submitted');
    expect(afterAccept.metadata.github_remote_ref_id).toBe('7');
    expect(afterAccept.metadata.lazy_closed_review).toBe(PR_URL);

    // The forge answers again; the PR is closed. The daemon's first remote-sync
    // runs 5s after it starts.
    rmSync(join(ctx.protocolBase, 'mock-pr-state-unreadable.json'));
    rmSync(join(ctx.protocolBase, 'mock-pr-state-unreadable-after-close.json'));
    await ctx.restartDaemon();
    const deadline = Date.now() + 60_000;
    while (readTaskStatus(ctx.root, childId) === 'submitted' && Date.now() < deadline) await Bun.sleep(500);

    expect(readTaskStatus(ctx.root, childId)).toBe('blocked');
    const settled = readTaskJson(ctx.root, childId);
    expect(settled.metadata.github_remote_ref_id ?? '').toBe('');
    expect(settled.metadata.lazy_closed_review ?? '').toBe('');
    expect(readTaskJson(ctx.root, grandchildId!).target).toEqual({ kind: 'task', parentTaskId: settled.id });
  }, 240_000);

  // INVARIANT (src/daemon/lazy-closed-review.ts): a resubmit never reuses the
  // record of a PR lazy closed. The close could not be confirmed, so the task
  // kept the record and the marker; the forge now says the PR is closed. Submit
  // must drop that dead record and open a NEW PR against the current target —
  // reusing it wiped the marker while the recorded PR stayed CLOSED, and the
  // next remote-sync pass read an unmarked CLOSED on a live task and abandoned
  // it (the round-7 hazard, reopened through submit).
  test('resubmitting after an unconfirmed close opens a new PR and the task is never abandoned', async () => {
    const { childId } = await submittedChildOfAcceptedParent({ retargetFails: true, stateUnreadable: true });
    expect(readTaskJson(ctx.root, childId).metadata.lazy_closed_review).toBe(PR_URL);

    // A person picks the task back up. While the forge still cannot say what
    // became of the PR, submit refuses and the marker stays.
    setTaskStatus(ctx.root, childId, 'blocked');
    const refused = await ctx.lazy(['submit', childId, '--yes']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('has not confirmed that close');
    expect(readTaskJson(ctx.root, childId).metadata.lazy_closed_review).toBe(PR_URL);

    // The forge answers again: the PR lazy closed IS closed.
    rmSync(join(ctx.protocolBase, 'mock-pr-state-unreadable.json'));
    rmSync(join(ctx.protocolBase, 'mock-pr-state-unreadable-after-close.json'));
    rmSync(join(ctx.protocolBase, 'mock-retarget-fails.json'));
    expect(readForge<{ state: string }>('mock-pr-state.json').state).toBe('CLOSED');
    writeForge('mock-review-create.json', { url: 'https://github.com/o/r/pull/8', id: '8' });

    const resubmitted = await ctx.lazy(['submit', childId, '--yes']);
    expectSuccess(resubmitted);
    const meta = readTaskJson(ctx.root, childId).metadata;
    expect(meta.github_remote_ref_id).toBe('8');
    expect(meta.lazy_closed_review ?? '').toBe('');
    expect(readTaskStatus(ctx.root, childId)).toBe('submitted');

    // The daemon's first remote-sync runs 5s after it starts: the live task
    // must survive it.
    await ctx.restartDaemon();
    const deadline = Date.now() + 15_000;
    while (readTaskStatus(ctx.root, childId) !== 'abandoned' && Date.now() < deadline) await Bun.sleep(500);
    expect(readTaskStatus(ctx.root, childId)).toBe('submitted');
  }, 240_000);

  function created(): number {
    const path = join(ctx.protocolBase, 'mock-review-created.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).length : 0;
  }

  /**
   * The reparent's retarget was refused and lazy's close went unconfirmed; the
   * forge now answers again and the PR turns out to be OPEN, still merging
   * into the dead parent branch. The child is picked back up (blocked).
   */
  async function openPrOnOldBase(): Promise<{ childId: string; parentBranch: string }> {
    const { childId, parentBranch } = await submittedChildOfAcceptedParent({ retargetFails: true, stateUnreadable: true });
    expect(readTaskJson(ctx.root, childId).metadata.lazy_closed_review).toBe(PR_URL);
    rmSync(join(ctx.protocolBase, 'mock-pr-state-unreadable.json'));
    rmSync(join(ctx.protocolBase, 'mock-pr-state-unreadable-after-close.json'));
    writeForge('mock-pr-state.json', { state: 'OPEN', base: parentBranch });
    setTaskStatus(ctx.root, childId, 'blocked');
    return { childId, parentBranch };
  }

  // INVARIANT (src/daemon/submit-target.ts): submit never reports `submitted`
  // with a PR that merges somewhere other than the task's current target. The
  // close never happened and the PR still merges into the dead parent branch;
  // markReadyForReview never changes an existing PR's base, so a resubmit that
  // only cleared the marker said "submitted" with a PR a reviewer could merge
  // into a branch the task no longer goes to. Submit moves it first.
  test('resubmitting a task whose kept PR still merges into the old parent moves the PR to the current target', async () => {
    const { childId } = await openPrOnOldBase();
    rmSync(join(ctx.protocolBase, 'mock-retarget-fails.json'));
    const before = created();

    const resubmitted = await ctx.lazy(['submit', childId, '--yes']);
    expectSuccess(resubmitted);
    expect(resubmitted.stdout + resubmitted.stderr).toContain('to `main`, where the task integrates now');
    expect(readForge<{ state: string; base: string }>('mock-pr-state.json')).toEqual({ state: 'OPEN', base: 'main' });
    expect(created()).toBe(before);
    const meta = readTaskJson(ctx.root, childId).metadata;
    expect(meta.github_remote_ref_id).toBe('7');
    expect(meta.lazy_closed_review ?? '').toBe('');
    expect(readTaskStatus(ctx.root, childId)).toBe('submitted');
  }, 240_000);

  // INVARIANT (src/daemon/submit-target.ts): when the forge will not move the
  // kept PR, submit REFUSES, naming both branches — never `submitted` on the
  // old base, and never a second PR for the same head.
  test('when the forge refuses to move the kept PR, the resubmit is refused and the task stays blocked', async () => {
    const { childId, parentBranch } = await openPrOnOldBase();
    const before = created();

    const refused = await ctx.lazy(['submit', childId, '--yes']);
    expect(refused.exitCode).not.toBe(0);
    const out = refused.stdout + refused.stderr;
    expect(out).toContain(`merges into \`${parentBranch}\``);
    expect(out).toContain('now integrates into `main`');
    expect(out).toContain('refused to change its base');
    expect(readForge<{ base: string }>('mock-pr-state.json').base).toBe(parentBranch);
    expect(created()).toBe(before);
    expect(readTaskStatus(ctx.root, childId)).toBe('blocked');
  }, 240_000);

  function retargets(): Array<{ taskId: string; base: string; ok: boolean }> {
    const path = join(ctx.protocolBase, 'mock-retargets.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  // INVARIANT (src/daemon/submit-target.ts): a LINKED task's PR (`lazy link`)
  // is someone else's, and submit never changes its base — the reparent
  // retarget and the close-review step keep the same rule. When its base is
  // not where the task integrates, submit refuses and says the base is the
  // owner's to change; no retarget reaches the forge. The round-9 base check
  // used to move it, re-pointing a colleague's PR.
  test('resubmitting a linked task whose PR merges elsewhere is refused and never retargets the PR', async () => {
    const taskId = await createTask(ctx, 'Linked work', 'Carry on with the linked branch');
    await startAndWait(taskId);
    const branch = readSessionJson(ctx.root, taskId)!.git_branch as string;
    writeForge('mock-review-create.json', { url: PR_URL, id: '7' });
    expectSuccess(await ctx.lazy(['submit', taskId, '--yes']));

    // The task is linked (what `lazy link <pr-url>` records), and the PR's
    // owner has pointed it at `develop`.
    setTaskMetadata(ctx.root, taskId, 'import_source_url', PR_URL);
    setTaskMetadata(ctx.root, taskId, 'import_source_branch', branch);
    writeForge('mock-pr-state.json', { state: 'OPEN', base: 'develop' });
    setTaskStatus(ctx.root, taskId, 'blocked');

    const refused = await ctx.lazy(['submit', taskId, '--yes']);
    expect(refused.exitCode).not.toBe(0);
    const out = refused.stdout + refused.stderr;
    expect(out).toContain('was linked, not opened by lazy');
    expect(out).toContain('merges into `develop`');
    expect(retargets()).toEqual([]);
    expect(readForge<{ base: string }>('mock-pr-state.json').base).toBe('develop');
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  }, 240_000);

  // INVARIANT: a PR closed by somebody else on the forge (no marker) still
  // closes the task and moves its subtasks, exactly as before the marker.
  test('a PR closed on the forge by someone else still abandons the task and moves its children', async () => {
    const { childId, grandchildId } = await submittedChildOfAcceptedParent({ grandchild: true });
    writeForge('mock-pr-state.json', { state: 'CLOSED', base: 'main' });
    await ctx.restartDaemon();
    const deadline = Date.now() + 60_000;
    while (readTaskStatus(ctx.root, childId) !== 'abandoned' && Date.now() < deadline) await Bun.sleep(500);

    expect(readTaskStatus(ctx.root, childId)).toBe('abandoned');
    expect(readTaskJson(ctx.root, grandchildId!).target).toEqual({ kind: 'branch', branch: 'main' });
  }, 240_000);

  // INVARIANT (src/daemon/review-retarget.ts): when the forge refuses to move
  // the PR, lazy CLOSES it rather than leave an open PR merging into a branch
  // the task no longer goes to, drops it from the task (so remote-sync does not
  // read the close as the task being closed), and the task goes back to blocked.
  test('when the forge refuses the retarget, the child\'s PR is closed and the child is blocked again', async () => {
    const { childId, childBranch } = await submittedChildOfAcceptedParent({ retargetFails: true });
    expect(forgeCloses()).toEqual([childBranch]);
    expect(readForge<{ state: string }>('mock-pr-state.json').state).toBe('CLOSED');
    expect(readTaskStatus(ctx.root, childId)).toBe('blocked');
    expect(readTaskJson(ctx.root, childId).metadata.github_remote_ref_id ?? '').toBe('');
  }, 240_000);

  // INVARIANT (src/daemon/review-base.ts): a forge accept never merges a PR
  // whose base is not the accept's target. The PR of a reparented subtask
  // still pointing at the old parent branch would land the work there — and
  // the task used to read `complete` with its work missing from `main`.
  test('accepting the child refuses while its PR still merges into the old parent branch', async () => {
    const { childId, parentBranch, childFullId } = await submittedChildOfAcceptedParent();
    // The PR's base as a person may have left it: the old parent branch.
    writeForge('mock-pr-state.json', { state: 'OPEN', base: parentBranch });

    seedFinal(ctx, childId);
    const accepted = await ctx.lazy(['accept', childId, '--reason', 'Ship it', '--allow-queued-comments']);
    expectFailure(accepted);
    expect(accepted.stderr).toContain(`merges into \`${parentBranch}\``);
    expect(accepted.stderr).toContain('integrates into `main`');
    expect(readTaskStatus(ctx.root, childId)).not.toBe('complete');
    expect(merges().filter((m) => m.taskId === childFullId)).toEqual([]);
  }, 240_000);

  // INVARIANT (src/daemon/review-base.ts): the wrong-base check refuses only a
  // WRONG base. A reviewer merging a submitted subtask's PR on the forge into
  // its LIVE parent's branch — exactly where the subtask integrates — completes
  // it like any forge-merged PR, and files no alert.
  test('remote-sync completes a child whose PR was merged into its live parent branch', async () => {
    const parentId = await createTask(ctx, 'Parent work', 'Do the parent part');
    await startAndWait(parentId);
    const created = await ctx.lazy(['create', '--goal', 'Child work', '--prompt', 'Do the child part', '--parent', parentId]);
    expectSuccess(created);
    const childId = created.stdout.match(/([0-9a-f]{8})/)![1];
    await startAndWait(childId);
    const parentBranch = readSessionJson(ctx.root, parentId)!.git_branch as string;
    writeForge('mock-review-create.json', { url: PR_URL, id: '7' });
    writeForge('mock-remote-branches.json', { [parentBranch]: 'abc123' });
    expectSuccess(await ctx.lazy(['submit', childId, '--yes']));

    // The reviewer merges it on the forge, into the parent's branch.
    writeForge('mock-pr-state.json', { state: 'MERGED', base: parentBranch });
    // The daemon's first remote-sync runs 5s after it starts.
    await ctx.restartDaemon();
    const deadline = Date.now() + 60_000;
    while (readTaskStatus(ctx.root, childId) !== 'complete' && Date.now() < deadline) await Bun.sleep(500);

    expect(readTaskStatus(ctx.root, childId)).toBe('complete');
    expect(readTaskStatus(ctx.root, parentId)).not.toBe('complete');
    expect(readTaskJson(ctx.root, childId).metadata.forge_merged_wrong_base).toBeUndefined();
    expect(readSystemMessagesFile(ctx.root).some((m) => String(m.title).includes('merged into the wrong branch'))).toBe(false);
  }, 240_000);

  // INVARIANT (src/daemon/review-base.ts): the daemon's remote-sync never
  // completes a task because its PR was merged INTO ANOTHER BRANCH — a
  // reviewer clicking Merge on a PR still based on the old parent branch.
  // It files one alert instead, and the task stays open.
  test('remote-sync does not complete the child when its PR was merged into the old parent branch', async () => {
    const { childId, parentBranch } = await submittedChildOfAcceptedParent();
    writeForge('mock-pr-state.json', { state: 'MERGED', base: parentBranch });

    // The daemon's first remote-sync runs 5s after it starts.
    await ctx.restartDaemon();
    const deadline = Date.now() + 60_000;
    const alerted = () => readSystemMessagesFile(ctx.root).some((m) => String(m.title).includes('merged into the wrong branch'));
    while (!alerted() && Date.now() < deadline) await Bun.sleep(500);

    expect(alerted()).toBe(true);
    expect(readTaskStatus(ctx.root, childId)).not.toBe('complete');
    expect(readTaskJson(ctx.root, childId).metadata.forge_merged_wrong_base).toBe(parentBranch);
  }, 240_000);
});
