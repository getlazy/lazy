/**
 * Invariant tests for accept's merge-routing decision.
 *
 * Background (CLAUDE.md invariants):
 *   - "PRs only for protected branches."
 *   - "Subtask→parent merges should be local git operations, not remote MRs."
 *
 * The bug this locks down: a CHILD task whose lazy parent is an intermediate
 * branch (e.g. `lazy/release-v017`) used to be accepted via a remote MR — and
 * the MR was silently retargeted to `main`, so the forge evaluated conflicts
 * against the wrong base. The fix routes accept through a LOCAL merge whenever
 * the merge target is NOT a protected branch, and never opens an MR for it.
 *
 * These tests mock the remote driver (createDriver) and the LocalDriver so we
 * can assert WHICH driver performed the merge, without touching real git/forge.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { resolve } from 'path';
import { RpcError as RealRpcError } from '../../src/daemon/rpc-handlers';
import {
  DEFAULT_CONFIG as REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate as REAL_getDefaultConfigTemplate,
} from '../../src/config/loader';

// --- Scenario switches (set per-test) ---
let mockTask: any = null;
let mockParent: any = null;
let mockSession: any = null;
let mockCommits: any[] = [];
let remoteProtected = false;

// --- Call recorders ---
let remoteCalls: string[] = [];
let localMergeTargets: string[] = [];
let localDriverInstantiated = 0;

await mockModule(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: async () => ({
    remote: { driver: 'gitlab', git_remote: 'origin', auto_approve: false },
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

// The remote driver (createDriver) records every call so we can assert that the
// MR/PR path was NOT taken for an unprotected target. A real LocalDriver mock
// records the merge target so we can assert the local merge actually ran.
await mockModule(resolve(import.meta.dir, '../../src/remote/index.ts'), () => ({
  detectRemote: () => null,
  createDriver: () => ({
    needsSync: true,
    validateAccept: () => { remoteCalls.push('validateAccept'); return null; },
    hasRemoteRef: () => true,
    hasExternalApproval: async () => true,
    isTargetBranchProtected: async () => { remoteCalls.push('isTargetBranchProtected'); return remoteProtected; },
    pushBranch: async () => { remoteCalls.push('pushBranch'); },
    markReadyForReview: async () => { remoteCalls.push('markReadyForReview'); return { metadata: { gitlab_remote_ref_id: '1' } }; },
    getPRState: async () => null,
    getChecksStatus: async () => ({ status: 'passed' as const, failed: [] }),
    getTaskUrl: async () => 'https://gitlab/mr/1',
    postAcceptReview: async () => null,
    checkAcceptGates: async () => { remoteCalls.push('checkAcceptGates'); return []; },
    merge: async () => { remoteCalls.push('merge'); return { status: 'merged' as const, metadata: {} }; },
    fastForwardLocal: async () => ({ success: true }),
    postTurnSummary: async () => {},
    updateRemoteBody: async () => {},
    recoverRemoteRef: async () => null,
  }),
  LocalDriver: class {
    needsSync = false;
    constructor() { localDriverInstantiated++; }
    validateAccept() { return null; }
    hasRemoteRef() { return false; }
    async isTargetBranchProtected() { return false; }
    async pushBranch() {}
    async markReadyForReview() { return {}; }
    async checkAcceptGates() { return []; }
    async merge(opts: any) { localMergeTargets.push(opts.targetBranch); return { status: 'merged' as const }; }
    async fastForwardLocal() { return { success: true }; }
    async postAcceptReview() { return null; }
    async getTaskUrl() { return null; }
    async updateRemoteBody() {}
  },
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

const { acceptTask } = await import('../../src/daemon/task-lifecycle');

function createMockStorage() {
  return {
    resolveTask: async () => ({ task: mockTask, ambiguousMatches: [] }),
    getTask: async (id: string) => {
      if (mockParent && id === mockParent.id) return mockParent;
      return mockTask;
    },
    getSessionByTaskId: async () => mockSession,
    getSessionTurns: async () => [],
    getSessionCommits: async () => mockCommits,
    getTaskComments: async () => [],
    getChildTasks: async () => [],
    updateTaskStatus: async () => {},
    updateTaskMetadata: async () => {},
    updateTurnViolations: async () => {},
    createComment: async () => {},
    endSession: async () => {},
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
    started_at: Date.now(),
    ended_at: null,
    outcome: null,
    claude_session_id: null,
  };
}

function makeTask(target: any) {
  return {
    id: 'task-id-12345678',
    code: 'child-task',
    goal: 'Child work',
    prompt: '',
    status: 'blocked' as const,
    type: 'task' as const,
    model: 'claude-opus-4-6',
    agent_id: 'claude-code',
    created_at: Date.now(),
    completed_at: null,
    target,
    branched_from_sha: null,
    close_reason: null,
    metadata: {},
    pending_sync: 0,
  };
}

describe('acceptTask: merge routing (PRs only for protected branches)', () => {
  beforeEach(() => {
    mockSession = makeSession();
    mockCommits = [{ sha: 'commit1', message: 'work' }];
    remoteCalls = [];
    localMergeTargets = [];
    localDriverInstantiated = 0;
    remoteProtected = false;
    mockParent = null;
  });

  // INVARIANT: PRs only for protected branches / subtask→parent merges are local.
  // A child task whose parent is an unprotected `lazy/...` branch must be merged
  // LOCALLY into that parent branch — no MR is created and no remote merge runs.
  test('child task into unprotected lazy/ parent does a LOCAL merge, opens NO MR', async () => {
    mockParent = { ...makeTask({ kind: 'branch', branch: 'main' }), id: 'parent-id-87654321', status: 'blocked' };
    mockTask = makeTask({ kind: 'task', parentTaskId: 'parent-id-87654321' });

    const result = await acceptTask('/tmp/test', { taskId: 'child-task' });

    expect(result.status).toBe('merged');
    // The local merge ran against the parent branch...
    expect(localDriverInstantiated).toBe(1);
    expect(localMergeTargets).toEqual(['lazy/parent-branch']);
    // ...and NOTHING on the remote driver opened or merged an MR.
    expect(remoteCalls).not.toContain('markReadyForReview');
    expect(remoteCalls).not.toContain('merge');
    expect(remoteCalls).not.toContain('pushBranch');
    // No PR URL for a local merge.
    expect(result.prUrl).toBeUndefined();
  });

  // INVARIANT: The intermediate-parent merge target must NEVER require a network
  // protection check — a `lazy/...` target is unprotected by definition, so we
  // short-circuit and a transient forge failure can never misroute the merge.
  test('child task into lazy/ parent never calls isTargetBranchProtected', async () => {
    mockParent = { ...makeTask({ kind: 'branch', branch: 'main' }), id: 'parent-id-87654321', status: 'blocked' };
    mockTask = makeTask({ kind: 'task', parentTaskId: 'parent-id-87654321' });

    await acceptTask('/tmp/test', { taskId: 'child-task' });

    expect(remoteCalls).not.toContain('isTargetBranchProtected');
  });

  // INVARIANT: PRs only for protected branches — the protected case still uses
  // the remote MR path. A root task targeting a protected `main` merges via the
  // remote driver, and the LocalDriver is never instantiated.
  test('root task into protected main uses the remote MR path', async () => {
    remoteProtected = true;
    mockTask = makeTask({ kind: 'branch', branch: 'main' });

    const result = await acceptTask('/tmp/test', { taskId: 'child-task' });

    expect(result.status).toBe('merged');
    // Remote driver performed the merge; LocalDriver was never used.
    expect(remoteCalls).toContain('merge');
    expect(localDriverInstantiated).toBe(0);
    expect(localMergeTargets).toEqual([]);
  });
});

afterAll(() => {
  restoreMockedModules();
});
