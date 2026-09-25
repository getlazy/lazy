import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/utils/role-target';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { resolve } from 'path';
import { RpcError as RealRpcError } from '../../src/daemon/rpc-handlers';
import {
  DEFAULT_CONFIG as REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate as REAL_getDefaultConfigTemplate,
} from '../../src/config/loader';
import type { FollowThroughStep } from '../../src/daemon/accept-intent';

/**
 * INVARIANT (accept-merge-is-commit-point, engineer 2026-09-22): the git merge
 * is the LAST fallible step of an accept. Once it lands the task becomes
 * `complete` (session `accepted`, `[Accepted]` comment) BEFORE anything else is
 * attempted; fast-forward, parent push, accept tag, reparenting and cleanup are
 * follow-through that may fail — loudly — without ever moving the task out of
 * `complete`, and are retried until done.
 *
 * Why: twice on 2026-09-22 (and before that on 2026-09-08) the merge went
 * through, a later step failed, and the task never reached accepted — merged
 * work on a task the store called `merging`/`blocked`.
 */

// --- Scenario switches ---
let mockTask: any = null;
let mockParent: any = null;
let mockSession: any = null;
let remoteProtected = false;
// The task records a PR/MR (a person submitted it), so a local merge owes the
// `close-review` step. A protected target needs one for its approval gate.
let taskHasPr = false;
let forgeClosed = 0;
/** What the forge reports for the task's PR after a close; null = could not ask. */
let prStateAfterClose: 'CLOSED' | null = 'CLOSED';
/** Set to make the forge report this base for the task's PR (src/daemon/review-base.ts). */
let reviewBaseOverride: string | null = null;
let failStep: FollowThroughStep | null = null;
let metadata: Record<string, string> = {};
let statuses: string[] = [];
let comments: string[] = [];
let endedAs: string[] = [];
let pushedBranches: string[] = [];
let tagged: string[] = [];
let cleaned = 0;
let revoked = 0;

function maybeFail(step: FollowThroughStep): void {
  if (failStep === step) throw new Error(`injected ${step} failure`);
}

await mockModule(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: async () => ({
    remote: { driver: 'gitlab', git_remote: 'origin', auto_approve: false, offline: false },
    storage: { backend: 'external', external_path: '' },
    review: { mode: 'separate', auto_fix: false, draft_effort: 'low', review_effort: 'xhigh' },
    automation: { maintain: [], react: [], pre_accept: { enabled: false, commands: [], timeout: 600 }, accept_check: '', accept_check_timeout: 300 },
    models: { default: 'claude-opus-4-7', roles: { builder: ANTHROPIC_DEFAULT_TARGET, agent: ANTHROPIC_DEFAULT_TARGET } },
    protection: { enabled: false, protected_branches: [], protected_tasks: [], gate_default_branch: true },
  }),
  DEFAULT_CONFIG: REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate: REAL_getDefaultConfigTemplate,
}));

await mockModule(resolve(import.meta.dir, '../../src/daemon/rpc-handlers.ts'), () => ({
  getOrCreateStorage: async () => storage,
  RpcError: RealRpcError,
  initDaemonStorage: () => {},
}));

await mockModule(resolve(import.meta.dir, '../../src/remote/index.ts'), () => {
  const LocalDriver = class {
    needsSync = false;
    validateAccept() { return null; }
    hasRemoteRef() { return false; }
    async isTargetBranchProtected() { return false; }
    async pushBranch() {}
    async markReadyForReview() { return {}; }
    async checkAcceptGates() { return []; }
    async merge() { return { status: 'merged' as const }; }
    async fastForwardLocal() { return { success: true }; }
    async approveForMerge() { return null; }
    async getTaskUrl() { return null; }
    async updateRemoteBody() {}
  };
  return {
    detectRemote: () => null,
    createDriver: () => ({
      needsSync: true,
      validateAccept: () => null,
      hasRemoteRef: () => remoteProtected || taskHasPr,
      hasExternalApproval: async () => true,
      isTargetBranchProtected: async () => remoteProtected,
      pushBranch: async (branch: string) => {
        // Before the merge (step 4, protected target) a push failure is a
        // pre-merge refusal; only the post-merge parent push is injected.
        if (statuses.includes('merging') && !statuses.includes('blocked-restored')) maybeFail('push-parent');
        pushedBranches.push(branch);
      },
      markReadyForReview: async () => ({ metadata: {} }),
      // The recorded PR merges into the task's own target (src/daemon/review-base.ts checks it).
      getReviewBase: async (t: any) => reviewBaseOverride ?? (t.target?.kind === 'branch' ? (t.target.branch || 'main') : null),
      // A task with a PR reads OPEN until lazy closes it; a task without one
      // has nothing for the forge to report.
      getPRState: async () => (taskHasPr ? (forgeClosed > 0 ? prStateAfterClose : 'OPEN') : null),
      getChecksStatus: async () => ({ status: 'passed' as const, failed: [] }),
      getTaskUrl: async () => null,
      approveForMerge: async () => null,
      checkAcceptGates: async () => [],
      merge: async () => ({ status: 'merged' as const, metadata: {} }),
      fastForwardLocal: async () => {
        if (failStep === 'fast-forward') return { success: false, warning: 'injected fast-forward failure' };
        return { success: true };
      },
      updateRemoteBody: async () => {},
      recoverRemoteRef: async () => null,
      // The task has a remote ref, so a local merge closes its PR/MR as
      // follow-through (the `close-review` step).
      cleanup: async () => { forgeClosed += 1; },
    }),
    LocalDriver,
  };
});

await mockModule(resolve(import.meta.dir, '../../src/git/operations.ts'), () => ({
  hasUncommittedChanges: async () => false,
  applyPatch: async () => true,
  hasUpstreamChanges: async () => false,
  getCurrentBranch: async () => 'main',
  recoverMissingWorktreeWithFetch: async () => ({ recovered: true, source: 'local' as const }),
  resolveDetachedHead: async (b: string) => (b === 'HEAD' ? 'main' : b),
  repoHasCommits: async () => true,
  getCurrentSha: async () => 'deadbeef',
  createAcceptTag: async (_id: string, commitish: string) => { maybeFail('accept-tag'); tagged.push(commitish); },
}));

await mockModule(resolve(import.meta.dir, '../../src/utils/fs.ts'), () => ({
  pathExists: async () => true,
  dirExists: async () => true,
  ensureDir: async () => {},
  readFileSafe: async () => null,
}));
await mockModule(resolve(import.meta.dir, '../../src/utils/pairing-lock.ts'), () => ({
  checkPairingLock: () => null,
}));
await mockModule(resolve(import.meta.dir, '../../src/utils/git.ts'), () => ({
  validateBranchInSyncWithRemote: async () => ({ inSync: true }),
  runGit: async (args: string[]) => ({
    stdout: args[0] === 'rev-parse' && String(args.at(-1)).endsWith('^{commit}') ? 'mergesha\n' : '',
    stderr: '', exitCode: 0,
  }),
}));
await mockModule(resolve(import.meta.dir, '../../src/utils/lock.ts'), () => ({
  checkLock: () => null,
  acquireLock: () => {},
  removeLock: () => {},
}));
await mockModule(resolve(import.meta.dir, '../../src/task/identity.ts'), () => ({
  shortId: (id: string) => id.substring(0, 8),
  displayId: (task: any) => task.code ?? task.id.substring(0, 8),
  taskRef: (task: any) => task.code ?? task.id.substring(0, 8),
  getWorktreePath: () => '/tmp/fake-worktree',
  getWorktreePathForRef: () => '/tmp/fake-worktree',
  getBranchNameFromId: async () => 'lazy/parent-branch',
}));
await mockModule(resolve(import.meta.dir, '../../src/task/orphan.ts'), () => ({
  checkOrphanedChild: async () => null,
  retargetOrphanedChild: async () => {},
  getActiveChildren: async () => [],
  reparentChildren: async () => { maybeFail('reparent'); return []; },
  formatReparentWarning: () => null,
}));
await mockModule(resolve(import.meta.dir, '../../src/task/turn-context.ts'), () => ({
  buildNotesContext: () => '',
  buildSystemPrompt: () => '',
  buildPromptWithInstructions: () => '',
  buildTurnHistoryContext: () => '',
  getNewNotesSince: async () => [],
}));
await mockModule(resolve(import.meta.dir, '../../src/task/sync-remote.ts'), () => ({
  runSyncWithRemote: async () => {},
  syncTaskFromRemote: async () => {},
}));
await mockModule(resolve(import.meta.dir, '../../src/task/cleanup.ts'), () => ({
  cleanupWorktree: () => {},
  cleanupWorktreeAndBranch: async () => { maybeFail('cleanup'); cleaned++; },
  cleanupTaskContainer: async () => {},
}));
await mockModule(resolve(import.meta.dir, '../../src/protocol/index.ts'), () => ({
  protocolDir: () => '/tmp/protocol',
  writeCommand: async () => {},
  ensureProtocolDir: () => {},
  commonCommandFields: () => ({}),
  removeProtocolDir: () => {},
}));

const realMcpTokens = await import('../../src/daemon/mcp-tokens');
await mockModule(resolve(import.meta.dir, '../../src/daemon/mcp-tokens.ts'), () => ({
  ...realMcpTokens,
  revokeTaskMcpTokens: async () => { revoked++; return 1; },
}));

const { acceptTask, runAcceptFollowThrough } = await import('../../src/daemon/task-lifecycle');

const storage: any = {
  resolveTask: async () => ({ task: current(), ambiguousMatches: [] }),
  getTask: async (id: string) => (mockParent && id === mockParent.id ? mockParent : current()),
  getSessionByTaskId: async () => mockSession,
  getSessionTurns: async () => [{
    id: 'turn-final', sequence: 1, role: 'human',
    content: '[system] Finalize declared', turn_type: 'pre_accept',
    created_at: Date.now(),
    final: { sha: 'abc123', actor: 'human', at: Date.now(), wrap_up_steps: [] },
  }],
  getSessionCommits: async () => [{ sha: 'commit1', message: 'work' }],
  getTaskReviewComments: async () => [],
  getTaskComments: async () => comments.map((content) => ({ content })),
  getChildTasks: async () => [],
  getTaskRaisedItems: async () => [],
  updateTaskStatus: async (_id: string, status: string) => { statuses.push(status); mockTask.status = status; },
  updateTaskMetadata: async (_id: string, key: string, value: string) => {
    if (value === '') delete metadata[key]; else metadata[key] = value;
  },
  updateTurnViolations: async () => {},
  createComment: async (_id: string, content: string) => { comments.push(content); },
  endSession: async (_id: string, outcome: string) => { endedAs.push(outcome); mockSession.ended_at = Date.now(); },
  incrementTaskPendingSync: async () => {},
  close: async () => {},
};

function current(): any {
  return mockTask ? { ...mockTask, metadata: { ...metadata } } : null;
}

function makeTask(target: any) {
  return {
    id: 'task-id-12345678', code: 'child-task', goal: 'Child work', prompt: '',
    status: 'blocked', type: 'task', model: 'claude-opus-4-7', agent_id: 'claude-code',
    created_at: Date.now(), completed_at: null, target, branched_from_sha: null,
    close_reason: null, metadata: {}, pending_sync: 0,
  };
}

function reset(): void {
  mockSession = {
    id: 'sess-id', task_id: 'task-id-12345678', agent_id: 'test-agent', git_branch: 'lazy/child-branch',
    git_start_sha: 'abc123', started_at: Date.now(), ended_at: null, outcome: null, claude_session_id: null,
  };
  mockParent = { ...makeTask({ kind: 'branch', branch: 'main' }), id: 'parent-id-87654321', code: 'parent' };
  mockTask = makeTask({ kind: 'task', parentTaskId: 'parent-id-87654321' });
  remoteProtected = false;
  taskHasPr = false;
  forgeClosed = 0;
  prStateAfterClose = 'CLOSED';
  reviewBaseOverride = null;
  failStep = null;
  metadata = {};
  statuses = [];
  comments = [];
  endedAs = [];
  pushedBranches = [];
  tagged = [];
  cleaned = 0;
  revoked = 0;
}

describe('accept: the merge is the commit point', () => {
  beforeEach(reset);

  // Local merge into an unprotected parent: push-parent, tag, reparent, cleanup
  // are all after the merge. A protected target (forge merge) adds fast-forward.
  const cases: Array<{ step: FollowThroughStep; protectedTarget: boolean }> = [
    { step: 'reparent', protectedTarget: false },
    { step: 'push-parent', protectedTarget: false },
    { step: 'accept-tag', protectedTarget: false },
    { step: 'cleanup', protectedTarget: false },
    { step: 'fast-forward', protectedTarget: true },
  ];

  for (const { step, protectedTarget } of cases) {
    // INVARIANT: a failure in any post-merge step leaves the task `complete`,
    // with the accept recorded, and names the pending step — then a retry
    // finishes it. Never a restore to `blocked`, never stuck in `merging`.
    test(`a failing ${step} leaves the task accepted, reports it, and a retry completes it`, async () => {
      if (protectedTarget) {
        remoteProtected = true;
        mockTask = makeTask({ kind: 'branch', branch: 'main' });
      }
      failStep = step;

      const result = await acceptTask('/tmp/test', { taskId: 'child-task', reason: 'ship it', actor: 'human' });

      expect(result.status).toBe('merged');
      expect(result.followThroughPending?.steps[0]).toBe(step);
      expect(result.followThroughPending?.error).toContain(step);
      expect(result.warnings.some((w) => w.includes('FAILED after the merge'))).toBe(true);
      // Accepted in the store despite the failure...
      expect(statuses.at(-1)).toBe('complete');
      expect(statuses).not.toContain('blocked');
      expect(endedAs).toEqual(['accepted']);
      expect(comments).toContain('[Accepted] ship it');
      // ...no longer marked as a merge in flight, but still owing follow-through.
      expect(metadata.accept_in_flight_from).toBeUndefined();
      expect(metadata.accept_intent).toBeUndefined();
      expect(JSON.parse(metadata.accept_followthrough).lastError).toContain(step);

      // The daemon's retry runs the same follow-through and finishes it.
      failStep = null;
      const retry = await runAcceptFollowThrough('/tmp/test', 'task-id-12345678');
      expect(retry.pending).toEqual([]);
      expect(metadata.accept_followthrough).toBeUndefined();
      expect(cleaned).toBe(1);
      expect(tagged.length).toBe(1);
      // A retry never touches status.
      expect(statuses.at(-1)).toBe('complete');
    });
  }

  // INVARIANT: a failing step blocks only what DEPENDS on it. Cleanup — container
  // teardown and MCP token revocation — never waits on a parent push that keeps
  // failing: an accepted task's credentials must not stay live while it reads
  // `complete`. The tag (which needs no push) lands too.
  test('a failing parent push still revokes tokens, cleans up and tags', async () => {
    failStep = 'push-parent';
    const result = await acceptTask('/tmp/test', { taskId: 'child-task', reason: 'ship it', actor: 'human' });
    expect(result.followThroughPending?.steps).toEqual(['push-parent']);
    expect(revoked).toBe(1);
    expect(cleaned).toBe(1);
    expect(tagged).toEqual(['mergesha']);
  });

  // INVARIANT: closing the task's PR/MR after a local merge waits for the parent
  // push. Closed first, the PR would read as settled while the base branch on
  // the forge still lacks the work — and the push may keep failing for a while.
  test('a failing parent push holds the PR close, and the retry closes it', async () => {
    taskHasPr = true;
    failStep = 'push-parent';
    const result = await acceptTask('/tmp/test', { taskId: 'child-task', reason: 'ship it', actor: 'human' });
    expect(result.followThroughPending?.steps).toEqual(['push-parent', 'close-review']);
    expect(forgeClosed).toBe(0);

    failStep = null;
    const retry = await runAcceptFollowThrough('/tmp/test', 'task-id-12345678');
    expect(retry.pending).toEqual([]);
    expect(forgeClosed).toBe(1);
  });

  // INVARIANT: after closing the task's PR, a forge that cannot report its
  // state has NOT confirmed the close. Marking the step done on that left the
  // PR open after a local accept, for good; the step stays owed and the
  // follow-through sweep retries it until the forge answers.
  test('a close the forge cannot confirm stays owed, and the retry finishes it', async () => {
    taskHasPr = true;
    prStateAfterClose = null;
    const result = await acceptTask('/tmp/test', { taskId: 'child-task', reason: 'ship it', actor: 'human' });
    expect(result.followThroughPending?.steps).toEqual(['close-review']);
    expect(statuses.at(-1)).toBe('complete');

    prStateAfterClose = 'CLOSED';
    const retry = await runAcceptFollowThrough('/tmp/test', 'task-id-12345678');
    expect(retry.pending).toEqual([]);
  });

  // INVARIANT: a step whose prerequisite failed does not run. The tag reads the
  // fast-forwarded target, so a failed fast-forward holds the tag — but not
  // cleanup, and not the parent notify, which posts SHA-less rather than make
  // the parent wait on a target that keeps failing to fast-forward.
  test('a failing fast-forward holds the tag but not cleanup or the parent notify', async () => {
    remoteProtected = true;
    mockTask = makeTask({ kind: 'branch', branch: 'main' });
    failStep = 'fast-forward';
    const result = await acceptTask('/tmp/test', { taskId: 'child-task', reason: 'ship it', actor: 'human' });
    expect(result.followThroughPending?.steps).toEqual(['fast-forward', 'accept-tag']);
    expect(tagged).toEqual([]);
    expect(cleaned).toBe(1);
    expect(revoked).toBe(1);
  });

  // INVARIANT: the accept tag points at the MERGE, not at whatever the parent
  // holds when a retried follow-through reaches it.
  test('a retried tag uses the SHA captured right after the local merge', async () => {
    failStep = 'accept-tag';
    await acceptTask('/tmp/test', { taskId: 'child-task', reason: 'ship it', actor: 'human' });
    failStep = null;
    await runAcceptFollowThrough('/tmp/test', 'task-id-12345678');
    expect(tagged).toEqual(['mergesha']);
  });

  // INVARIANT (src/daemon/review-base.ts): a forge accept refuses a PR lazy
  // opened whose base is not the accept's target — merging it would land the
  // work somewhere else.
  test('a forge accept refuses a PR that merges into another branch', async () => {
    remoteProtected = true;
    mockTask = makeTask({ kind: 'branch', branch: 'main' });
    reviewBaseOverride = 'develop';
    await expect(acceptTask('/tmp/test', { taskId: 'child-task', reason: 'ship it', actor: 'human' }))
      .rejects.toThrow('merges into `develop`');
    expect(statuses).not.toContain('complete');
  });

  // INVARIANT (src/daemon/review-base.ts): ...but never a LINKED task's PR
  // (`lazy link`). It is someone else's, lazy never opened or reparented it,
  // and its base is its owner's to decide; the refusal used to tell a person
  // to change a colleague's PR base.
  test('a forge accept of a linked task is not refused over its PR\'s base', async () => {
    remoteProtected = true;
    mockTask = makeTask({ kind: 'branch', branch: 'main' });
    metadata = {
      import_source_url: 'https://github.com/acme/widgets/pull/123',
      import_source_branch: 'feature/foreign',
    };
    reviewBaseOverride = 'develop';
    const result = await acceptTask('/tmp/test', { taskId: 'child-task', reason: 'ship it', actor: 'human' });
    expect(result.status).toBe('merged');
    expect(statuses.at(-1)).toBe('complete');
  });

  test('a clean accept owes nothing afterwards', async () => {
    const result = await acceptTask('/tmp/test', { taskId: 'child-task', reason: 'ship it', actor: 'human' });
    expect(result.followThroughPending).toBeUndefined();
    expect(metadata.accept_followthrough).toBeUndefined();
    expect(pushedBranches).toEqual(['lazy/parent-branch']);
    expect(statuses).toEqual(['merging', 'complete']);
  });
});

afterAll(() => {
  restoreMockedModules();
});
