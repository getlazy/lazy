/**
 * Unit test for the merging-race fix in acceptTask().
 *
 * Background:
 * After driver.merge() succeeds in acceptTask, we transition the task
 * blocked → merging → complete. The remote-sync reconciler concurrently
 * polls the remote MR/PR; if it observes the merged state first, it
 * transitions the task directly to `complete`. When acceptTask then runs
 * its blocked→merging step on a task already in `complete`, the state
 * machine throws "Invalid status transition: 'complete' → 'merging'" —
 * even though the merge actually succeeded.
 *
 * The fix re-reads the task status before the final transitions and skips
 * any transitions already applied by the reconciler. This test locks in
 * that idempotent behavior.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { resolve } from 'path';
import { RpcError as RealRpcError } from '../../src/daemon/rpc-handlers';
import {
  DEFAULT_CONFIG as REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate as REAL_getDefaultConfigTemplate,
} from '../../src/config/loader';
import { assertValidTransition } from '../../src/task-state-machine';
import type { TaskStatus } from '../../src/types';

let mockTask: any = null;
let mockSession: any = null;
let mockCommits: any[] = [];
// When set, getTask returns a task whose status is this value (simulating
// reconciler having raced ahead).
let raceTaskStatusOverride: TaskStatus | null = null;
// Records of state transitions attempted so we can assert what acceptTask did.
let transitionLog: Array<{ from: TaskStatus; to: TaskStatus }> = [];

await mockModule(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: async () => ({
    remote: { driver: 'github', git_remote: 'origin', auto_approve: false },
    storage: { backend: 'external', external_path: '' },
    models: { default: 'claude-opus-4-7' },
  }),
  DEFAULT_CONFIG: REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate: REAL_getDefaultConfigTemplate,
}));

await mockModule(resolve(import.meta.dir, '../../src/daemon/rpc-handlers.ts'), () => ({
  getOrCreateStorage: async () => createMockStorage(),
  RpcError: RealRpcError,
  initDaemonStorage: () => {},
}));

// validateAccept returns null → skip auto-create branch and go straight to merge.
await mockModule(resolve(import.meta.dir, '../../src/remote/index.ts'), () => ({
  detectRemote: () => null,
  createDriver: () => ({
    needsSync: false,
    validateAccept: () => null,
    hasRemoteRef: () => true,
    hasExternalApproval: async () => true,
    isTargetBranchProtected: async () => false,
    pushBranch: async () => {},
    markReadyForReview: async () => ({}),
    getPRState: async () => null,
    getChecksStatus: async () => ({ status: 'passed' as const, failed: [] }),
    getTaskUrl: async () => null,
    postAcceptReview: async () => null,
    checkAcceptGates: async () => [],
    merge: async () => ({ status: 'merged' as const, metadata: {} }),
    fastForwardLocal: async () => ({ success: true }),
    postTurnSummary: async () => {},
    fetchRemoteState: async () => {},
    getFailedCIJobs: async () => [],
    recoverRemoteRef: async () => null,
  }),
}));

await mockModule(resolve(import.meta.dir, '../../src/git/operations.ts'), () => ({
  hasUncommittedChanges: async () => false,
  applyPatch: async () => true,
  hasUpstreamChanges: async () => false,
  getCurrentBranch: async () => 'main',
  recoverMissingWorktreeWithFetch: async () => ({ recovered: true, source: 'local' as const }),
  resolveDetachedHead: async (b: string) => (b === 'HEAD' ? 'main' : b),
  repoHasCommits: async () => true,
  getCurrentSha: async () => 'deadbeef',
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

const { acceptTask } = await import('../../src/daemon/task-lifecycle');

function createMockStorage() {
  // The "live" status as tracked by storage. Starts at the task's status
  // and is updated by updateTaskStatus calls.
  let liveStatus: TaskStatus = mockTask?.status ?? 'blocked';
  return {
    resolveTask: async () => ({ task: mockTask, ambiguousMatches: [] }),
    getTask: async () => {
      // Simulate the reconciler race: when override is set, getTask returns
      // a task whose status has already been moved to that value externally.
      if (raceTaskStatusOverride) {
        return { ...mockTask, status: raceTaskStatusOverride };
      }
      return { ...mockTask, status: liveStatus };
    },
    getSessionByTaskId: async () => mockSession,
    getSessionTurns: async () => [],
    getSessionCommits: async () => mockCommits,
    // Consumed by the fidelity summarizer (regenerateFidelity) during accept.
    getTaskComments: async () => [],
    getChildTasks: async () => [],
    updateTaskStatus: async (_id: string, to: TaskStatus) => {
      // Use the "true" current status — overridden by race when set, else live.
      const from = raceTaskStatusOverride ?? liveStatus;
      assertValidTransition(from, to);
      transitionLog.push({ from, to });
      liveStatus = to;
      // The race condition only applies up to the point acceptTask reads
      // the task in the finalize step — after that the override is moot.
      raceTaskStatusOverride = null;
    },
    updateTaskMetadata: async () => {},
    updateTurnViolations: async () => {},
    createComment: async () => {},
    endSession: async () => {},
    incrementTaskPendingSync: async () => {},
    close: async () => {},
  } as any;
}

function makeTask() {
  return {
    id: 'race-task-id-12345678',
    code: 'race-task',
    goal: 'Race test',
    prompt: '',
    status: 'blocked' as const,
    type: 'task' as const,
    model: 'claude-opus-4-6',
    agent_id: 'claude-code',
    created_at: Date.now(),
    completed_at: null,
    target: { kind: 'branch' as const, branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    metadata: {},
    pending_sync: 0,
  };
}

function makeSession() {
  return {
    id: 'race-session-id',
    task_id: 'race-task-id-12345678',
    agent_id: 'test-agent',
    git_branch: 'lazy/race-branch',
    git_start_sha: 'abc123',
    started_at: Date.now(),
    ended_at: null,
    outcome: null,
    claude_session_id: null,
  };
}

describe('acceptTask: race with remote-sync reconciler', () => {
  beforeEach(() => {
    mockTask = makeTask();
    mockSession = makeSession();
    mockCommits = [{ sha: 'commit1', message: 'work' }];
    raceTaskStatusOverride = null;
    transitionLog = [];
  });

  // INVARIANT: When the remote-sync reconciler races ahead of acceptTask
  // and marks the task `complete` between driver.merge() and the final
  // status transition, acceptTask MUST still return success — not throw
  // "Invalid status transition: 'complete' → 'merging'". The merge actually
  // succeeded; throwing a state-machine error leaves the agent thinking
  // the operation failed when in fact it landed.
  test('returns merged success when reconciler races task to complete', async () => {
    // Simulate the reconciler having marked the task complete by the time
    // acceptTask reads the task to perform the final transitions.
    raceTaskStatusOverride = 'complete';

    const result = await acceptTask('/tmp/test', { taskId: 'race-task' });

    expect(result.status).toBe('merged');
    // No invalid transitions attempted.
    for (const t of transitionLog) {
      expect(() => assertValidTransition(t.from, t.to)).not.toThrow();
    }
    // We did not try blocked→merging→complete on top of complete.
    const tried = transitionLog.map(t => `${t.from}→${t.to}`);
    expect(tried).not.toContain('complete→merging');
  });

  // Normal path still does the merging → complete transitions.
  test('still transitions blocked → merging → complete in normal case', async () => {
    const result = await acceptTask('/tmp/test', { taskId: 'race-task' });

    expect(result.status).toBe('merged');
    const tried = transitionLog.map(t => `${t.from}→${t.to}`);
    expect(tried).toContain('blocked→merging');
    expect(tried).toContain('merging→complete');
  });
});

afterAll(() => {
  restoreMockedModules();
});
