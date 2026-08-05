/**
 * Reproduction + regression test for the concurrent-accept race condition.
 *
 * THE BUG (field incident, recurring):
 *   A human runs `lazy accept <task>` while the builder simultaneously accepts
 *   the same task. The git merge IS applied, but the task is left in a `blocked`
 *   state — the merge and the status write get out of sync under concurrency.
 *
 * ROOT CAUSE:
 *   `acceptTask` is a long multi-step async orchestration (preflight → merge →
 *   fast-forward → endSession → status transition → cleanup) with many `await`
 *   points and NO per-task mutual exclusion. The daemon serves RPCs concurrently
 *   (Bun.serve), so two accepts on the same task interleave at every await. Both
 *   pass the preflight TOCTOU guards (`task.status`, `sess.outcome === 'accepted'`)
 *   because neither has committed its terminal transition yet, and both proceed
 *   into the merge + status-write section. The merge runs twice and the racing
 *   status writes can land the task in `blocked` while the merge is applied.
 *
 * THE FIX (src/daemon/task-lifecycle-lock.ts):
 *   Serialize the whole accept orchestration per canonical task id with a
 *   process-level async mutex. The second concurrent accept then waits, re-runs
 *   preflight after the first has committed, observes the accepted session
 *   outcome, and returns a clean deterministic "already accepted" — the merge
 *   runs exactly once and the task is never left blocked with the merge applied.
 *
 * INVARIANT: accept is mutually exclusive per task. Two concurrent accepts must
 * never both execute the merge. Do NOT weaken this without understanding the
 * field incident above.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { resolve } from 'path';
import { RpcError as RealRpcError } from '../../src/daemon/rpc-handlers';
import {
  DEFAULT_CONFIG as REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate as REAL_getDefaultConfigTemplate,
} from '../../src/config/loader';

// --- Shared, mutable scenario state (stateful storage) ---
let mockTask: any = null;
let mockSession: any = null;
let mockCommits: any[] = [];

// --- Recorders ---
let mergeCallCount = 0;
let statusHistory: string[] = [];
let endSessionCount = 0;

await mockModule(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: async () => ({
    remote: { driver: 'gitlab', git_remote: 'origin', auto_approve: false },
    storage: { backend: 'external', external_path: '' },
    // ResolvedConfig always carries a fully-populated `automation` section, and
    // acceptTask reads `config.automation.pre_accept` unguarded like every other
    // required section. This test is about concurrent-accept mutual exclusion,
    // not the pre-accept turn, so the step is disabled here.
    automation: { maintain: [], pre_accept: { enabled: false, commands: [], timeout: 600 } },
    models: { default: 'claude-opus-4-7', roles: { builder: { backend: 'anthropic', model: '', endpoint: '' }, agent: { backend: 'anthropic', model: '', endpoint: '' } } },
    git: { default_branch_prefix: 'lazy' },
    // Race behavior under test is orthogonal to the edge gate; gate scenarios
    // are covered by test/unit/edge-gate.test.ts + test/e2e/approve.test.ts.
    protection: { enabled: false, protected_branches: [], protected_tasks: [], gate_default_branch: true, passphrase_file: '.lazy/approve-passphrase' },
  }),
  DEFAULT_CONFIG: REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate: REAL_getDefaultConfigTemplate,
}));

await mockModule(resolve(import.meta.dir, '../../src/daemon/rpc-handlers.ts'), () => ({
  getOrCreateStorage: async () => createMockStorage(),
  RpcError: RealRpcError,
  initDaemonStorage: () => {},
}));

// Remote driver targeting a protected `main`. merge() yields (setTimeout) so two
// concurrent accepts both reach the merge before either finalizes — this is what
// turns the missing mutual exclusion into an observable double-merge.
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
    async postAcceptReview() { return null; }
    async getTaskUrl() { return null; }
    async updateRemoteBody() {}
  };
  return {
    detectRemote: () => null,
    createDriver: () => ({
      needsSync: true,
      validateAccept: () => null,
      hasRemoteRef: () => true,
      hasExternalApproval: async () => true,
      isTargetBranchProtected: async () => true,
      pushBranch: async () => {},
      markReadyForReview: async () => ({ metadata: { gitlab_remote_ref_id: '1' } }),
      getPRState: async () => 'MERGED',
      getChecksStatus: async () => ({ status: 'passed' as const, failed: [] }),
      getTaskUrl: async () => 'https://gitlab/mr/1',
      postAcceptReview: async () => null,
      checkAcceptGates: async () => [],
      merge: async () => {
        mergeCallCount++;
        // Yield long enough that a concurrent accept also clears preflight and
        // reaches its own merge — exposing the missing mutual exclusion.
        await new Promise((r) => setTimeout(r, 50));
        return { status: 'merged' as const, metadata: {} };
      },
      fastForwardLocal: async () => ({ success: true }),
      postTurnSummary: async () => {},
      updateRemoteBody: async () => {},
      recoverRemoteRef: async () => null,
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
  createAcceptTag: async () => {},
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
  runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
}));

await mockModule(resolve(import.meta.dir, '../../src/utils/lock.ts'), () => ({
  checkLock: () => null,
  acquireLock: () => {},
  removeLock: () => {},
}));

await mockModule(resolve(import.meta.dir, '../../src/cli/helpers.ts'), () => ({
  shortId: (id: string) => id.substring(0, 8),
  displayId: (task: any) => task.code ?? task.id.substring(0, 8),
  taskRef: (task: any) => task.code ?? task.id.substring(0, 8),
  getWorktreePath: () => '/tmp/fake-worktree',
  getWorktreePathForRef: () => '/tmp/fake-worktree',
  getBranchNameFromId: async () => 'lazy/parent-branch',
}));

await mockModule(resolve(import.meta.dir, '../../src/cli/orphan.ts'), () => ({
  checkOrphanedChild: async () => null,
  retargetOrphanedChild: async () => {},
  getActiveChildren: async () => [],
  reparentChildren: async () => [],
  formatReparentWarning: () => null,
}));

await mockModule(resolve(import.meta.dir, '../../src/cli/commands/shared.ts'), () => ({
  buildNotesContext: () => '',
  buildSystemPrompt: () => '',
  buildPromptWithInstructions: () => '',
  buildTurnHistoryContext: () => '',
  getNewNotesSince: async () => [],
  runSyncWithRemote: async () => {},
  cleanupWorktree: () => {},
  cleanupWorktreeAndBranch: () => {},
  cleanupTaskContainer: async () => {},
  syncTaskFromRemote: async () => {},
}));

await mockModule(resolve(import.meta.dir, '../../src/protocol/index.ts'), () => ({
  protocolDir: () => '/tmp/protocol',
  writeCommand: async () => {},
  ensureProtocolDir: () => {},
  commonCommandFields: () => ({}),
  removeProtocolDir: () => {},
}));

// Synthesis is exercised by acceptTask (regenerateFidelity / regenerateParentFidelity).
// Stub it so the test stays focused on the concurrency behavior.
await mockModule(resolve(import.meta.dir, '../../src/synthesis/fidelity.ts'), () => ({
  regenerateFidelity: async () => ({ fidelityBody: 'body', warning: null }),
  regenerateParentFidelity: async () => {},
}));

const { acceptTask } = await import('../../src/daemon/task-lifecycle');

function createMockStorage() {
  // Closures over the shared module-level mockTask/mockSession so both concurrent
  // accepts see each other's writes (a real shared store).
  return {
    resolveTask: async () => ({ task: mockTask, ambiguousMatches: [] }),
    getTask: async () => mockTask,
    getSessionByTaskId: async () => mockSession,
    getSessionTurns: async () => [],
    getSessionCommits: async () => mockCommits,
    getTaskComments: async () => [],
    getChildTasks: async () => [],
    updateTaskStatus: async (_id: string, status: string) => {
      mockTask.status = status;
      statusHistory.push(status);
    },
    updateTaskMetadata: async () => {},
    updateTurnViolations: async () => {},
    createComment: async () => {},
    endSession: async (_sid: string, outcome: string) => {
      endSessionCount++;
      mockSession.ended_at = 1;
      mockSession.outcome = outcome;
    },
    incrementTaskPendingSync: async () => {},
    close: async () => {},
  } as any;
}

function makeSession() {
  return {
    id: 'sess-id',
    task_id: 'task-id-12345678',
    agent_id: 'test-agent',
    git_branch: 'lazy/child-branch',
    git_start_sha: 'abc123',
    started_at: 1,
    ended_at: null,
    outcome: null,
    claude_session_id: null,
  };
}

function makeTask() {
  return {
    id: 'task-id-12345678',
    code: 'race-task',
    goal: 'Concurrent accept work',
    prompt: '',
    status: 'blocked' as const,
    type: 'task' as const,
    model: 'claude-opus-4-6',
    agent_id: 'claude-code',
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    metadata: {},
    pending_sync: 0,
  };
}

describe('acceptTask: concurrent accepts are mutually exclusive', () => {
  beforeEach(() => {
    mockTask = makeTask();
    mockSession = makeSession();
    mockCommits = [{ sha: 'commit1', message: 'work' }];
    mergeCallCount = 0;
    endSessionCount = 0;
    statusHistory = [];
  });

  // INVARIANT: two concurrent accepts on the same task must execute the merge
  // EXACTLY ONCE. Before the fix, both cleared preflight and both called
  // driver.merge() — the double merge / racing status writes are what left a
  // task `blocked` while its merge was already applied.
  test('two concurrent accepts merge exactly once; the loser sees already-accepted', async () => {
    const [a, b] = await Promise.allSettled([
      acceptTask('/tmp/test', { taskId: 'race-task' }),
      acceptTask('/tmp/test', { taskId: 'race-task' }),
    ]);

    // The merge must have run exactly once.
    expect(mergeCallCount).toBe(1);
    // The session is ended exactly once (no double finalize).
    expect(endSessionCount).toBe(1);

    // Exactly one accept reports a successful merge; the other is rejected with
    // a clean "already accepted" — never a silent success that hides a second merge.
    const outcomes = [a, b];
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled.length).toBe(1);
    expect(fulfilled[0].value.status).toBe('merged');
    expect(rejected.length).toBe(1);
    expect(String(rejected[0].reason?.message ?? rejected[0].reason)).toMatch(/already accepted/i);

    // The task ended up complete — NEVER blocked-with-merge-applied.
    expect(mockTask.status).toBe('complete');
  });
});

afterAll(() => {
  restoreMockedModules();
});
