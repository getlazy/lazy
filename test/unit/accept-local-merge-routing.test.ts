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
// When true, createDriver returns a LocalDriver (needsSync === false), simulating
// lazy configured offline/local — there is no remote, so accept must push nothing.
let localConfigDriver = false;

// --- Call recorders ---
let remoteCalls: string[] = [];
let pushedBranches: string[] = [];
let localMergeTargets: string[] = [];
let localDriverInstantiated = 0;

await mockModule(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: async () => ({
    remote: { driver: 'gitlab', git_remote: 'origin', auto_approve: false },
    storage: { backend: 'external', external_path: '' },
    models: { default: 'claude-opus-4-7', roles: { builder: { backend: 'anthropic', model: '', endpoint: '' }, agent: { backend: 'anthropic', model: '', endpoint: '' } } },
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
await mockModule(resolve(import.meta.dir, '../../src/remote/index.ts'), () => {
  // The LocalDriver mock records the merge target so we can assert the local
  // merge ran, and (critically) its pushBranch is a no-op — exactly like the
  // real LocalDriver — so a local merge never touches a remote.
  const LocalDriver = class {
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
  };
  return {
    detectRemote: () => null,
    // createDriver returns a LocalDriver when lazy is configured offline/local,
    // and the recording remote driver otherwise — mirroring the real factory.
    createDriver: () => localConfigDriver ? new LocalDriver() : ({
      needsSync: true,
      validateAccept: () => { remoteCalls.push('validateAccept'); return null; },
      hasRemoteRef: () => true,
      hasExternalApproval: async () => true,
      isTargetBranchProtected: async () => { remoteCalls.push('isTargetBranchProtected'); return remoteProtected; },
      pushBranch: async (branch: string) => { remoteCalls.push('pushBranch'); pushedBranches.push(branch); },
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
    pushedBranches = [];
    localMergeTargets = [];
    localDriverInstantiated = 0;
    remoteProtected = false;
    localConfigDriver = false;
    mockParent = null;
  });

  // INVARIANT: PRs only for protected branches / subtask→parent merges are local,
  // BUT a local merge into a remote-backed unprotected parent MUST still push the
  // merged parent branch to origin (a plain branch push, NOT a PR/MR).
  //
  // This test previously asserted pushBranch was NEVER called — that encoded the
  // "local-always-ahead" bug as correct behavior. The bug: a local squash merge
  // wrote the merge commit only to local <parent>, never pushing it, so local
  // <parent> drifted permanently ahead of origin/<parent> AND `lazy sync` read a
  // stale origin/<parent> and falsely reported "Already up to date". The fix
  // (task fix-push-after-local-merge): after a successful local merge, push the
  // parent branch via the ORIGINAL remote driver. We still open NO MR and run NO
  // remote merge — only a plain branch push.
  test('child task into unprotected lazy/ parent does a LOCAL merge then pushes the parent (NO MR)', async () => {
    mockParent = { ...makeTask({ kind: 'branch', branch: 'main' }), id: 'parent-id-87654321', status: 'blocked' };
    mockTask = makeTask({ kind: 'task', parentTaskId: 'parent-id-87654321' });

    const result = await acceptTask('/tmp/test', { taskId: 'child-task' });

    expect(result.status).toBe('merged');
    // The local merge ran against the parent branch...
    expect(localDriverInstantiated).toBe(1);
    expect(localMergeTargets).toEqual(['lazy/parent-branch']);
    // ...NO MR was opened and NO remote merge ran...
    expect(remoteCalls).not.toContain('markReadyForReview');
    expect(remoteCalls).not.toContain('merge');
    // ...but the merged parent branch WAS pushed to origin (plain branch push)
    // so local and origin stay in lockstep and sync reads a fresh upstream.
    expect(remoteCalls).toContain('pushBranch');
    expect(pushedBranches).toEqual(['lazy/parent-branch']);
    // No PR URL for a local merge.
    expect(result.prUrl).toBeUndefined();
  });

  // INVARIANT: when lazy is configured offline/local there is NO remote, so a
  // local merge MUST NOT attempt any push. `createDriver` returns a LocalDriver
  // (needsSync === false), making useLocalMerge false, so the post-merge parent
  // push is skipped entirely.
  test('local/offline config does a LOCAL merge and pushes nothing', async () => {
    localConfigDriver = true;
    mockParent = { ...makeTask({ kind: 'branch', branch: 'main' }), id: 'parent-id-87654321', status: 'blocked' };
    mockTask = makeTask({ kind: 'task', parentTaskId: 'parent-id-87654321' });

    const result = await acceptTask('/tmp/test', { taskId: 'child-task' });

    expect(result.status).toBe('merged');
    // The merge ran locally against the parent branch...
    expect(localMergeTargets).toEqual(['lazy/parent-branch']);
    // ...and nothing was ever pushed — there is no remote.
    expect(remoteCalls).not.toContain('pushBranch');
    expect(pushedBranches).toEqual([]);
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
