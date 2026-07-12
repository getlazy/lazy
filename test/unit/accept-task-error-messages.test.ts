/**
 * Unit tests for acceptTask()'s handling of push / PR-creation failures
 * during automatic remote-ref creation.
 *
 * Background:
 * When a task has no remote ref yet, acceptTask auto-creates one by pushing
 * the branch and then calling markReadyForReview() (which runs `gh pr create`
 * or `glab mr create`). A previous bug collapsed both failures into a single
 * misleading message ("Failed to create remote reference. Try running: lazy
 * submit") that did not tell the user which step failed. The fix splits
 * these into two distinct error paths:
 *
 *   - push fails          → "Failed to push branch <name>: <stderr>"
 *   - push ok, PR fails   → "Branch <name> was pushed, but PR creation failed: <stderr>"
 *
 * These tests lock in those two messages at the acceptTask level so future
 * refactors do not re-collapse them.
 */

import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { resolve } from 'path';

// --- Controllable state for the mocks ---
let pushBranchImpl: (branch: string) => Promise<void> = async () => {};
let markReadyForReviewImpl: () => Promise<{ metadata?: Record<string, string> }> =
  async () => ({ metadata: { github_remote_ref_id: '42' } });
let mockTask: any = null;
let mockSession: any = null;
let mockCommits: any[] = [];

// Import real exports so we keep types and module shape where needed.
import { RpcError as RealRpcError } from '../../src/daemon/rpc-handlers';
import {
  DEFAULT_CONFIG as REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate as REAL_getDefaultConfigTemplate,
} from '../../src/config/loader';

// --- Mock config loader ---
await mockModule(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: async () => ({
    // auto_approve + a protected target is the configuration under which accept
    // exercises the remote-ref auto-creation path (push + markReadyForReview).
    // After the "PRs only for protected branches" routing fix, an UNPROTECTED
    // target is merged locally and never pushes/creates a PR — so to test the
    // push/PR-creation error messages we must model a protected target.
    remote: {
      driver: 'github',
      git_remote: 'origin',
      auto_approve: true,
      offline: false,
    },
    storage: { backend: 'external', external_path: '' },
  }),
  DEFAULT_CONFIG: REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate: REAL_getDefaultConfigTemplate,
}));

// --- Mock rpc-handlers to avoid daemon storage init ---
await mockModule(resolve(import.meta.dir, '../../src/daemon/rpc-handlers.ts'), () => ({
  getOrCreateStorage: async () => createMockStorage(),
  RpcError: RealRpcError,
  initDaemonStorage: () => {},
}));

// --- Mock remote driver factory ---
// validateAccept returns an error string → acceptTask enters the
// push + markReadyForReview branch. hasRemoteRef returns false initially and
// (for the push-fails case) stays false, so we never try to merge.
await mockModule(resolve(import.meta.dir, '../../src/remote/index.ts'), () => ({
  detectRemote: () => null,
  createDriver: () => ({
    needsSync: true,
    validateAccept: () => 'Task has no remote reference',
    hasRemoteRef: () => false,
    hasExternalApproval: async () => false,
    // Protected target → accept stays on the remote MR path (push +
    // markReadyForReview), which is what these error-message tests exercise.
    isTargetBranchProtected: async () => true,
    pushBranch: (branch: string) => pushBranchImpl(branch),
    markReadyForReview: () => markReadyForReviewImpl(),
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

// --- Mock git operations ---
await mockModule(resolve(import.meta.dir, '../../src/git/operations.ts'), () => ({
  hasUncommittedChanges: async () => false,
  applyPatch: async () => true,
  hasUpstreamChanges: async () => false,
  getCurrentBranch: async () => 'main',
  recoverMissingWorktreeWithFetch: async () => ({ recovered: true, source: 'local' as const }),
  resolveDetachedHead: async (b: string) => (b === 'HEAD' ? 'main' : b),
  // Keep a passthrough for anything else that might be touched — safe no-ops.
  repoHasCommits: async () => true,
  getCurrentSha: async () => 'deadbeef',
}));

// --- Mock fs helpers ---
await mockModule(resolve(import.meta.dir, '../../src/utils/fs.ts'), () => ({
  pathExists: async () => true,
  dirExists: async () => true,
  ensureDir: async () => {},
  readFileSafe: async () => null,
}));

// --- Mock pairing lock ---
await mockModule(resolve(import.meta.dir, '../../src/utils/pairing-lock.ts'), () => ({
  checkPairingLock: () => null,
}));

// --- Mock git utilities (validateBranchInSyncWithRemote + runGit) ---
await mockModule(resolve(import.meta.dir, '../../src/utils/git.ts'), () => ({
  validateBranchInSyncWithRemote: async () => ({ inSync: true }),
  runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
}));

// --- Mock lock utilities ---
await mockModule(resolve(import.meta.dir, '../../src/utils/lock.ts'), () => ({
  checkLock: () => null,
  acquireLock: () => {},
  removeLock: () => {},
}));

// --- Mock cli/helpers for branch name resolution ---
await mockModule(resolve(import.meta.dir, '../../src/cli/helpers.ts'), () => ({
  shortId: (id: string) => id.substring(0, 8),
  displayId: (task: any) => task.code ?? task.id.substring(0, 8),
  taskRef: (task: any) => task.code ?? task.id.substring(0, 8),
  getWorktreePath: () => '/tmp/fake-worktree',
  getWorktreePathForRef: () => '/tmp/fake-worktree',
  getBranchNameFromId: async () => 'lazy/parent-branch',
}));

// --- Mock orphan helpers (not reached in our error paths, but still imported) ---
await mockModule(resolve(import.meta.dir, '../../src/cli/orphan.ts'), () => ({
  checkOrphanedChild: async () => null,
  retargetOrphanedChild: async () => {},
  getActiveChildren: async () => [],
  reparentChildren: async () => [],
  formatReparentWarning: () => null,
}));

// --- Mock shared cleanup (not reached in error paths) ---
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

// --- Mock protocol helpers ---
await mockModule(resolve(import.meta.dir, '../../src/protocol/index.ts'), () => ({
  protocolDir: () => '/tmp/protocol',
  writeCommand: async () => {},
  ensureProtocolDir: () => {},
  commonCommandFields: () => ({}),
  removeProtocolDir: () => {},
}));

// Import acceptTask AFTER mocks are set up.
const { acceptTask } = await import('../../src/daemon/task-lifecycle');

// --- Storage factory used by the rpc-handlers mock ---
function createMockStorage() {
  return {
    resolveTask: async () => ({ task: mockTask, ambiguousMatches: [] }),
    getTask: async () => mockTask,
    getSessionByTaskId: async () => mockSession,
    getSessionTurns: async () => [],
    getSessionCommits: async () => mockCommits,
    updateTaskStatus: async () => {},
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
    id: 'test-task-id-12345678',
    code: 'test-task',
    goal: 'Test task',
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

describe('acceptTask remote-ref creation error messages', () => {
  beforeEach(() => {
    mockTask = makeTask();
    mockSession = makeSession();
    mockCommits = [{ sha: 'commit1', message: 'work' }];
    pushBranchImpl = async () => {};
    markReadyForReviewImpl = async () => ({
      metadata: { github_remote_ref_id: '42' },
    });
  });

  // INVARIANT: When `git push` itself fails, the error the user sees MUST
  // identify the failing step as the push — not as "PR creation" or a
  // generic "failed to create remote reference". Misattributing the failure
  // sends the user down the wrong debugging path (e.g. re-running `lazy
  // submit` when the remote was rejecting the push all along).
  test('push failure surfaces "Failed to push branch" (not PR creation)', async () => {
    pushBranchImpl = async () => {
      throw new Error('remote rejected: pre-receive hook declined');
    };
    // markReadyForReview must not be reached — guard against that too.
    let markReadyCalled = false;
    markReadyForReviewImpl = async () => {
      markReadyCalled = true;
      return {};
    };

    await expect(acceptTask('/tmp/test', { taskId: 'test-task' })).rejects.toThrow(
      /Failed to push branch lazy\/test-branch/,
    );
    await expect(acceptTask('/tmp/test', { taskId: 'test-task' })).rejects.toThrow(
      /pre-receive hook declined/,
    );
    // INVARIANT: A push failure must NOT mention "PR creation" — the user
    // needs to know the push is what failed, not a later step.
    await expect(acceptTask('/tmp/test', { taskId: 'test-task' })).rejects.not.toThrow(
      /PR creation failed/,
    );

    expect(markReadyCalled).toBe(false);
  });

  // INVARIANT: When `git push` succeeds but `gh pr create` fails, the user
  // MUST learn two things from the error: (1) the branch is already pushed
  // (so they don't re-push or assume they need to retry with submit), and
  // (2) the underlying gh/glab stderr, so they can diagnose the real cause
  // (auth, validation, permissions, etc.). Swallowing the stderr was the
  // original bug; stating "was pushed" is the fix for the misdirection.
  test('PR-creation failure surfaces "was pushed, but PR creation failed" with underlying stderr', async () => {
    pushBranchImpl = async () => {}; // push succeeds
    markReadyForReviewImpl = async () => {
      throw new Error(
        'gh pr create failed (exit 1) for branch lazy/test-branch → main: HTTP 422: Validation Failed — Head sha can\'t be blank',
      );
    };

    await expect(acceptTask('/tmp/test', { taskId: 'test-task' })).rejects.toThrow(
      /Branch lazy\/test-branch was pushed, but PR creation failed/,
    );
    // INVARIANT: the underlying gh/glab stderr must flow through to the user
    // so they can act on the real problem.
    await expect(acceptTask('/tmp/test', { taskId: 'test-task' })).rejects.toThrow(
      /Head sha can't be blank/,
    );
    // INVARIANT: The message must NOT be misattributed to the push step.
    await expect(acceptTask('/tmp/test', { taskId: 'test-task' })).rejects.not.toThrow(
      /Failed to push branch/,
    );
  });
});

afterAll(() => {
  restoreMockedModules();
});
