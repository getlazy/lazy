/**
 * Unit tests for external merge detection in sync.ts.
 *
 * Tests the key invariant: when a blocked/conflict task's PR is merged externally,
 * the status must transition through merging state before reaching complete
 * (blocked → merging → complete, never blocked → complete directly).
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { resolve } from 'path';

// Track calls to storage.updateTaskStatus to verify transition sequence
let statusTransitions: Array<{ taskId: string; status: string; actor: string }> = [];
let mockPRState: 'OPEN' | 'MERGED' | 'CLOSED' | null = null;
let mockTask: any = null;
let mockSession: any = null;
let mockSessionCommits: any[] = [];

// Import real exports so the mock doesn't lose their shape for other test files
import { DEFAULT_CONFIG as REAL_DEFAULT_CONFIG, getDefaultConfigTemplate as REAL_getDefaultConfigTemplate } from '../../src/config/loader';

// Mock the config loader to return a github driver config
mock.module(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: () => ({
    remote: {
      driver: 'github',
      git_remote: 'origin',
    },
  }),
  DEFAULT_CONFIG: REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate: REAL_getDefaultConfigTemplate,
}));

// Mock the remote module to return a controllable driver
mock.module(resolve(import.meta.dir, '../../src/remote/index.ts'), () => ({
  detectRemote: () => null,
  createDriver: () => ({
    hasRemoteRef: (task: any) => task.metadata?.github_pr_number !== undefined,
    recoverRemoteRef: async () => null,
    getPRState: async () => mockPRState,
    getChecksStatus: async () => ({ status: 'pending', failed: [] }),
    fetchRemoteState: async () => {},
    pushBranch: async () => {},
    markReadyForReview: async () => ({ metadata: {} }),
    getTaskUrl: async () => null,
    postTurnSummary: async () => {},
    postedTurnSeqKey: () => 'github_last_posted_turn_seq',
    getLastPostedTurnSeq: () => 0,
    postedNoteAtKey: () => 'github_last_posted_note_at',
    getLastPostedNoteAt: () => undefined,
    isImportedComment: () => false,
    ciFailureSyncedKey: () => 'github_ci_failure_synced',
    getLastCIFailureSynced: () => undefined,
    getFailedCIJobs: async () => [],
  }),
}));

// Mock the orphan reparenting function
mock.module(resolve(import.meta.dir, '../../src/cli/orphan.ts'), () => ({
  reparentChildren: async () => [],
}));

// Mock the shared cleanup functions
mock.module(resolve(import.meta.dir, '../../src/cli/commands/shared.ts'), () => ({
  syncTaskFromRemote: async () => {},
  cleanupWorktreeAndBranch: () => {},
  cleanupTaskContainer: async () => {},
}));

// Mock the lock utilities
mock.module(resolve(import.meta.dir, '../../src/utils/lock.ts'), () => ({
  removeLock: () => {},
}));

// Mock the protocol utilities
mock.module(resolve(import.meta.dir, '../../src/protocol/index.ts'), () => ({
  protocolDir: () => '/tmp/protocol',
  removeProtocolDir: () => {},
}));

// Import after mocking
const { runSync } = await import('../../src/daemon/remote-sync');

// Mock storage
function createMockStorage() {
  return {
    listTasks: async () => (mockTask ? [mockTask] : []),
    getSessionByTaskId: async () => mockSession,
    getSessionCommits: async () => mockSessionCommits,
    endSession: async () => {},
    updateTaskStatus: async (taskId: string, status: string, actor: string) => {
      statusTransitions.push({ taskId, status, actor });
    },
    createComment: async () => {},
    closeTask: async () => {},
    updateTaskMetadata: async () => {},
    getTaskComments: async () => [],
    getSessionTurns: async () => [],
    close: async () => {},
  } as any;
}

// Mock SyncLogger
function createMockLogger() {
  return {
    phase: () => {},
    detail: () => {},
    error: () => {},
    done: () => {},
  };
}

// Helper to create a task with given status
function makeTask(status: 'blocked' | 'conflict' | 'merging', hasRemoteRef = true) {
  return {
    id: 'test-task-id-12345678',
    code: 'test-task',
    goal: 'Test task',
    prompt: '',
    status,
    type: 'task' as const,
    model: 'claude-opus-4-6',
    created_at: Date.now(),
    completed_at: null,
    parent_task_id: null,
    branched_from_sha: null,
    close_reason: null,
    metadata: hasRemoteRef ? { github_pr_number: '123' } : null,
  };
}

function makeSession() {
  return {
    id: 'test-session-id',
    task_id: 'test-task-id-12345678',
    agent_id: 'test-agent',
    git_branch: 'lazy/test-branch',
    git_start_sha: 'abc123',
    started_at: Date.now(),
    ended_at: null,
    outcome: null,
    claude_session_id: null,
  };
}

describe('sync external merge detection', () => {
  beforeEach(() => {
    statusTransitions = [];
    mockPRState = null;
    mockTask = null;
    mockSession = null;
    mockSessionCommits = [];
  });

  // INVARIANT: blocked → merging → complete (never blocked → complete directly)
  test('blocked task with externally merged PR transitions through merging state', async () => {
    // Setup: blocked task with a PR that was merged externally
    mockTask = makeTask('blocked');
    mockSession = makeSession();
    mockSessionCommits = [{ sha: 'commit1' }]; // Non-zero commits = real merge
    mockPRState = 'MERGED';

    const storage = createMockStorage();
    const logger = createMockLogger();

    await runSync('/tmp/test', storage, logger);

    // Verify the transition sequence: blocked → merging → complete
    expect(statusTransitions).toHaveLength(2);
    expect(statusTransitions[0].status).toBe('merging');
    expect(statusTransitions[1].status).toBe('complete');
  });

  // INVARIANT: conflict → merging → complete (never conflict → complete directly)
  test('conflict task with externally merged PR transitions through merging state', async () => {
    // Setup: conflict task with a PR that was merged externally
    mockTask = makeTask('conflict');
    mockSession = makeSession();
    mockSessionCommits = [{ sha: 'commit1' }];
    mockPRState = 'MERGED';

    const storage = createMockStorage();
    const logger = createMockLogger();

    await runSync('/tmp/test', storage, logger);

    // Verify the transition sequence: conflict → merging → complete
    expect(statusTransitions).toHaveLength(2);
    expect(statusTransitions[0].status).toBe('merging');
    expect(statusTransitions[1].status).toBe('complete');
  });

  // Merging tasks that complete externally should only have one transition (merging → complete)
  test('merging task with externally merged PR transitions directly to complete', async () => {
    // Setup: merging task (already in merging state) with a PR that was merged
    mockTask = makeTask('merging');
    mockSession = makeSession();
    mockSessionCommits = [{ sha: 'commit1' }];
    mockPRState = 'MERGED';

    const storage = createMockStorage();
    const logger = createMockLogger();

    await runSync('/tmp/test', storage, logger);

    // Verify only one transition: merging → complete (no intermediate step needed)
    expect(statusTransitions).toHaveLength(1);
    expect(statusTransitions[0].status).toBe('complete');
  });

  // Spurious merges (zero commits) should be ignored
  test('spurious merge with zero commits is ignored', async () => {
    mockTask = makeTask('blocked');
    mockSession = makeSession();
    mockSessionCommits = []; // Zero commits = spurious merge
    mockPRState = 'MERGED';

    const storage = createMockStorage();
    const logger = createMockLogger();

    await runSync('/tmp/test', storage, logger);

    // No status transitions should occur for spurious merges
    expect(statusTransitions).toHaveLength(0);
  });
});
