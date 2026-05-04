/**
 * Unit tests for detectExternalChanges handling of working/interrupted tasks.
 *
 * INVARIANT: When a task's MR/PR is merged externally while the task is in
 * `working` or `interrupted` status (e.g., agent crashed), detectExternalChanges
 * must still detect the merge and transition the task to complete.
 *
 * ROOT CAUSE: Previously, detectExternalChanges used a status allowlist
 * (blocked/conflict/submitted/merging) that skipped working/interrupted/pairing
 * tasks. This caused reparent-on-merge to not fire when an MR was merged
 * externally while the task was still working (e.g., crashed builder).
 *
 * Fix: Changed the filter from an allowlist to `isTerminalStatus()` — all
 * non-terminal tasks are now checked for external state changes.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { resolve } from 'path';

// --- Track storage mutations ---
let statusUpdates: Array<{ taskId: string; status: string }> = [];
let sessionEnds: Array<{ sessionId: string; outcome: string }> = [];
let commentsCreated: Array<{ taskId: string; content: string }> = [];
let parentUpdates: Array<{ taskId: string; parentId: string | null }> = [];
let taskStatuses: Map<string, string> = new Map();

// Mock tasks for tests
let mockTasks: any[] = [];
let mockSessions: Map<string, any> = new Map();
let mockSessionCommits: Map<string, any[]> = new Map();
let mockChildren: Map<string, any[]> = new Map();

// Mock storage
const mockStorage = {
  listTasks: async () => mockTasks,
  getTask: async (id: string) => mockTasks.find(t => t.id === id) ?? null,
  getSessionByTaskId: async (taskId: string) => mockSessions.get(taskId) ?? null,
  getSessionCommits: async (sessionId: string) => mockSessionCommits.get(sessionId) ?? [],
  getSessionTurns: async () => [],
  getTaskComments: async () => [],
  endSession: async (sessionId: string, outcome: string) => {
    sessionEnds.push({ sessionId, outcome });
  },
  updateTaskStatus: async (taskId: string, status: string, _actor: string) => {
    statusUpdates.push({ taskId, status });
    taskStatuses.set(taskId, status);
  },
  updateTaskMetadata: async () => {},
  createComment: async (taskId: string, content: string) => {
    commentsCreated.push({ taskId, content });
  },
  closeTask: async () => {},
  updateTaskParent: async (taskId: string, parentId: string | null) => {
    parentUpdates.push({ taskId, parentId });
  },
  getActiveChildren: async (taskId: string) => mockChildren.get(taskId) ?? [],
  close: async () => {},
};

// Mock config loader
mock.module(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: async () => ({
    remote: { driver: 'github', git_remote: 'origin' },
  }),
  DEFAULT_CONFIG: {},
  getDefaultConfigTemplate: () => '',
}));

// Mock driver — controlled per-test via mockPRStates
let mockPRStates: Map<string, string> = new Map();
const mockDriver = {
  hasRemoteRef: (task: any) => mockPRStates.has(task.id),
  getPRState: async (task: any) => mockPRStates.get(task.id) ?? null,
  getChecksStatus: async () => ({ status: 'passed', failed: [] }),
  getFailedCIJobs: async () => [],
  fetchRemoteState: async () => {},
  pushBranch: async () => {},
  fetchBranch: async () => false,
  syncComments: async () => [],
  recoverRemoteRef: async () => null,
  getLastPostedTurnSeq: () => 0,
  getLastPostedNoteAt: () => null,
  getLastCIFailureSynced: () => null,
  postedTurnSeqKey: () => 'last_posted_turn_seq',
  postedNoteAtKey: () => 'last_posted_note_at',
  ciFailureSyncedKey: () => 'last_ci_failure_synced',
  isImportedComment: () => false,
  postTurnSummary: async () => {},
};

mock.module(resolve(import.meta.dir, '../../src/remote/index.ts'), () => ({
  createDriver: () => mockDriver,
  detectRemote: () => null,
}));

// Mock orphan module — track reparent calls
mock.module(resolve(import.meta.dir, '../../src/cli/orphan.ts'), () => ({
  reparentChildren: async (task: any, _storage: any) => {
    const children = mockChildren.get(task.id) ?? [];
    for (const child of children) {
      parentUpdates.push({ taskId: child.id, parentId: task.parent_task_id });
    }
    return children;
  },
}));

// Mock shared module (cleanup functions)
mock.module(resolve(import.meta.dir, '../../src/cli/commands/shared.ts'), () => ({
  syncTaskFromRemote: async () => {},
  cleanupWorktreeAndBranch: async () => {},
  cleanupTaskContainer: async () => {},
}));

// Mock git operations
mock.module(resolve(import.meta.dir, '../../src/git/operations.ts'), () => ({
  localBranchExists: async () => false,
}));

// Mock logger
mock.module(resolve(import.meta.dir, '../../src/utils/logger.ts'), () => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
}));

// Mock lock/protocol
mock.module(resolve(import.meta.dir, '../../src/utils/lock.ts'), () => ({
  removeLock: async () => {},
}));
mock.module(resolve(import.meta.dir, '../../src/protocol.ts'), () => ({
  protocolDir: () => '/tmp/protocol',
  removeProtocolDir: () => {},
}));

// Mock constants
mock.module(resolve(import.meta.dir, '../../src/constants.ts'), () => ({
  getActor: () => 'test',
}));

// Mock signals
mock.module(resolve(import.meta.dir, '../../src/daemon/signals.ts'), () => ({
  emitSignal: () => {},
}));

// Mock helpers — import real functions to avoid breaking other tests when run together
// (bun's mock.module replaces the entire module, so we must re-export everything)
import { deriveTaskRef as realDeriveTaskRef, taskRef as realTaskRef } from '../../src/cli/helpers';
mock.module(resolve(import.meta.dir, '../../src/cli/helpers.ts'), () => ({
  shortId: (id: string) => id.substring(0, 8),
  displayId: (task: any) => task.code ?? task.id.substring(0, 8),
  getWorktreePath: () => '/tmp/worktree',
  taskRef: realTaskRef,
  deriveTaskRef: realDeriveTaskRef,
}));

// Mock theme
mock.module(resolve(import.meta.dir, '../../src/cli/theme.ts'), () => ({
  theme: {
    taskId: (s: string) => s,
    success: (s: string) => s,
  },
}));

// Import the function under test AFTER all mocks are registered
const { runSync } = await import('../../src/daemon/remote-sync');

// Capture log output
const logOutput: string[] = [];
const testLogger = {
  phase: (msg: string) => logOutput.push(msg),
  detail: (msg: string) => logOutput.push(msg),
  error: (msg: string) => logOutput.push(msg),
  done: (msg: string) => logOutput.push(msg),
};

describe('detectExternalChanges handles working/interrupted tasks', () => {
  beforeEach(() => {
    statusUpdates = [];
    sessionEnds = [];
    commentsCreated = [];
    parentUpdates = [];
    taskStatuses.clear();
    mockTasks = [];
    mockSessions.clear();
    mockSessionCommits.clear();
    mockChildren.clear();
    mockPRStates.clear();
    logOutput.length = 0;
  });

  // INVARIANT: A task in `working` status whose MR was merged externally
  // (e.g., agent crashed, human merged the MR manually) must be detected
  // and transitioned to complete. Previously this was missed because
  // detectExternalChanges only checked blocked/conflict/submitted/merging.
  test('detects externally merged MR for working task and transitions to complete', async () => {
    const task = {
      id: 'working-task-1234',
      code: 'release-v011',
      status: 'working',
      parent_task_id: null,
      metadata: { gitlab_mr_iid: '42' },
    };
    mockTasks.push(task);
    mockPRStates.set(task.id, 'MERGED');

    // Task has a session with commits (not spurious)
    mockSessions.set(task.id, {
      id: 'session-1',
      task_id: task.id,
      git_branch: 'lazy/release-v011',
      ended_at: null,
    });
    mockSessionCommits.set('session-1', [{ id: 'commit-1', message: 'fix: something' }]);

    await runSync('/tmp/project', mockStorage as any, testLogger);

    // Should transition: working → merging → complete
    expect(statusUpdates).toEqual([
      { taskId: task.id, status: 'merging' },
      { taskId: task.id, status: 'complete' },
    ]);

    // Session should be ended
    expect(sessionEnds).toEqual([{ sessionId: 'session-1', outcome: 'accepted' }]);
  });

  // INVARIANT: Same behavior for interrupted tasks — a crashed agent whose MR
  // was merged externally should still be detected.
  test('detects externally merged MR for interrupted task', async () => {
    const task = {
      id: 'interrupted-task-1',
      code: 'crashed-task',
      status: 'interrupted',
      parent_task_id: null,
      metadata: { gitlab_mr_iid: '43' },
    };
    mockTasks.push(task);
    mockPRStates.set(task.id, 'MERGED');

    mockSessions.set(task.id, {
      id: 'session-2',
      task_id: task.id,
      git_branch: 'lazy/crashed-task',
      ended_at: null,
    });
    mockSessionCommits.set('session-2', [{ id: 'commit-2', message: 'feat: work' }]);

    await runSync('/tmp/project', mockStorage as any, testLogger);

    expect(statusUpdates).toEqual([
      { taskId: task.id, status: 'merging' },
      { taskId: task.id, status: 'complete' },
    ]);
  });

  // INVARIANT: When a working task's MR is merged externally, its unfinished
  // children must be reparented — this is the exact scenario that caused
  // release-v012 to still point to completed release-v011.
  test('reparents children when working task MR is merged externally', async () => {
    const parent = {
      id: 'parent-working-id',
      code: 'release-v011',
      status: 'working',
      parent_task_id: null,
      metadata: { gitlab_mr_iid: '44' },
    };
    const child = {
      id: 'child-task-id-1',
      code: 'release-v012',
      status: 'backlog',
      parent_task_id: parent.id,
    };
    mockTasks.push(parent);
    mockPRStates.set(parent.id, 'MERGED');
    mockChildren.set(parent.id, [child]);

    mockSessions.set(parent.id, {
      id: 'session-3',
      task_id: parent.id,
      git_branch: 'lazy/release-v011',
      ended_at: null,
    });
    mockSessionCommits.set('session-3', [{ id: 'commit-3', message: 'release prep' }]);

    await runSync('/tmp/project', mockStorage as any, testLogger);

    // Parent should be completed
    expect(statusUpdates).toContainEqual({ taskId: parent.id, status: 'complete' });

    // Child should be reparented to top-level (parent has no grandparent)
    expect(parentUpdates).toContainEqual({ taskId: child.id, parentId: null });

    // Log should mention reparenting
    const reparentLog = logOutput.find(l => l.includes('Re-parented'));
    expect(reparentLog).toBeTruthy();
  });

  // INVARIANT: Terminal tasks (complete, closed, abandoned) should still be
  // skipped — the fix changes from an allowlist to isTerminalStatus, not
  // to "check everything".
  test('still skips terminal tasks', async () => {
    const completedTask = {
      id: 'completed-task-id',
      status: 'complete',
      parent_task_id: null,
      metadata: { gitlab_mr_iid: '99' },
    };
    mockTasks.push(completedTask);
    mockPRStates.set(completedTask.id, 'MERGED');

    await runSync('/tmp/project', mockStorage as any, testLogger);

    // No status updates — terminal task should be skipped entirely
    expect(statusUpdates).toEqual([]);
  });

  // INVARIANT: Backlog tasks have no session, branch, or remote ref.
  // They are explicitly skipped — no point checking remote state.
  test('skips backlog tasks', async () => {
    const backlogTask = {
      id: 'backlog-task-id',
      status: 'backlog',
      parent_task_id: null,
      metadata: { gitlab_mr_iid: '100' },
    };
    mockTasks.push(backlogTask);
    mockPRStates.set(backlogTask.id, 'MERGED');

    await runSync('/tmp/project', mockStorage as any, testLogger);

    // Backlog tasks are skipped even if they somehow have a remote ref
    expect(statusUpdates).toEqual([]);
  });

  // INVARIANT: Pairing tasks are skipped — a human is actively driving the
  // session. When pairing ends (→ blocked), the normal blocked → merging
  // path handles external merge detection on the next sync cycle.
  test('skips pairing tasks', async () => {
    const pairingTask = {
      id: 'pairing-task-id',
      status: 'pairing',
      parent_task_id: null,
      metadata: { gitlab_mr_iid: '101' },
    };
    mockTasks.push(pairingTask);
    mockPRStates.set(pairingTask.id, 'MERGED');

    mockSessions.set(pairingTask.id, {
      id: 'session-pairing',
      task_id: pairingTask.id,
      git_branch: 'lazy/pairing-task',
      ended_at: null,
    });
    mockSessionCommits.set('session-pairing', [{ id: 'commit-p', message: 'pairing work' }]);

    await runSync('/tmp/project', mockStorage as any, testLogger);

    // Pairing task should NOT be transitioned — human is driving
    expect(statusUpdates).toEqual([]);
  });
});
