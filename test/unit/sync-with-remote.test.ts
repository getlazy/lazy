/**
 * Unit tests for runSyncWithRemote in shared.ts.
 *
 * These tests verify the key invariant: branch fetching runs regardless of
 * MR/PR existence, while PR comment fetching only runs when hasRemoteRef is true.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { resolve } from 'path';

// Track calls to driver methods
let fetchBranchCalls: { branch: string; worktreePath: string }[] = [];
let syncCommentsCalls: { sinceTimestamp: string }[] = [];
let mockFetchBranchResult = false;
let mockHasRemoteRef = false;

// Mock the config loader to return a github driver config
// Uses absolute paths to .ts files, matching the pattern in preload-mocks.ts
mock.module(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: () => ({
    remote: {
      driver: 'github',
      git_remote: 'origin',
    },
  }),
  DEFAULT_CONFIG: {},
  getDefaultConfigTemplate: () => '',
}));

// Mock the remote module to return a controllable driver
mock.module(resolve(import.meta.dir, '../../src/remote/index.ts'), () => ({
  createDriver: () => ({
    hasRemoteRef: () => mockHasRemoteRef,
    fetchBranch: async (branch: string, worktreePath: string) => {
      fetchBranchCalls.push({ branch, worktreePath });
      return mockFetchBranchResult;
    },
    syncComments: async (_task: unknown, sinceTimestamp: string) => {
      syncCommentsCalls.push({ sinceTimestamp });
      return [];
    },
  }),
}));

// Import after mocking
const { runSyncWithRemote } = await import('../../src/cli/commands/shared');

// Minimal task and session objects for testing
function makeTask() {
  return {
    id: 'test-task-id',
    code: 'test-task',
    goal: 'Test task',
    prompt: '',
    status: 'working' as const,
    type: 'task' as const,
    model: 'opus' as const,
    created_at: Date.now(),
    completed_at: null,
    parent_task_id: null,
    branched_from_sha: null,
    close_reason: null,
    metadata: null,
  };
}

function makeSession() {
  return {
    id: 'test-session-id',
    task_id: 'test-task-id',
    agent_id: 'test-agent',
    git_branch: 'lazy/test-branch',
    git_start_sha: 'abc123',
    started_at: Date.now(),
    ended_at: null,
    outcome: null,
    claude_session_id: null,
  };
}

function makeStorage() {
  return {
    getSessionTurns: async () => [],
  } as any;
}

describe('runSyncWithRemote', () => {
  beforeEach(() => {
    fetchBranchCalls = [];
    syncCommentsCalls = [];
    mockFetchBranchResult = false;
    mockHasRemoteRef = false;
  });

  // INVARIANT: fetchBranch runs for non-local drivers regardless of MR/PR existence.
  // The branch may have been pushed to the remote without creating an MR/PR yet.
  // Without this, remote branch divergence can't be resolved when there's no MR.
  test('fetches remote branch even when task has no MR/PR (hasRemoteRef=false)', async () => {
    mockHasRemoteRef = false;
    mockFetchBranchResult = true;

    const result = await runSyncWithRemote(
      makeTask() as any,
      makeSession() as any,
      '/tmp/test-root',
      makeStorage(),
      '/tmp/test-worktree',
    );

    // fetchBranch should have been called despite no MR
    expect(fetchBranchCalls).toHaveLength(1);
    expect(fetchBranchCalls[0].branch).toBe('lazy/test-branch');

    // Should return remoteBranch since fetchBranch returned true (ahead)
    expect(result.remoteBranch).toBe('origin/lazy/test-branch');
  });

  // INVARIANT: PR comment sync only runs when there's an actual MR/PR.
  // syncComments needs PR context (PR number) to query the API.
  test('does NOT fetch PR comments when task has no MR/PR', async () => {
    mockHasRemoteRef = false;
    mockFetchBranchResult = false;

    await runSyncWithRemote(
      makeTask() as any,
      makeSession() as any,
      '/tmp/test-root',
      makeStorage(),
      '/tmp/test-worktree',
    );

    // fetchBranch should be called (always runs)
    expect(fetchBranchCalls).toHaveLength(1);
    // syncComments should NOT be called (no MR)
    expect(syncCommentsCalls).toHaveLength(0);
  });

  test('fetches both branch and PR comments when task has MR/PR', async () => {
    mockHasRemoteRef = true;
    mockFetchBranchResult = false;

    await runSyncWithRemote(
      makeTask() as any,
      makeSession() as any,
      '/tmp/test-root',
      makeStorage(),
      '/tmp/test-worktree',
    );

    // Both should be called
    expect(fetchBranchCalls).toHaveLength(1);
    expect(syncCommentsCalls).toHaveLength(1);
  });

  test('returns no remoteBranch when remote is up-to-date', async () => {
    mockHasRemoteRef = false;
    mockFetchBranchResult = false;

    const result = await runSyncWithRemote(
      makeTask() as any,
      makeSession() as any,
      '/tmp/test-root',
      makeStorage(),
      '/tmp/test-worktree',
    );

    expect(result.remoteBranch).toBeUndefined();
  });
});
