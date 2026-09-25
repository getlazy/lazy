/**
 * INVARIANT: a fresh accept of a task a member is working in has NO effect
 * beyond the store. The member check runs at the top of the fresh-accept path,
 * before the accept check, the `[automation.pre_accept]` gate (project
 * commands run in the member's files), the branch push, PR/MR creation,
 * approveForMerge and the forge's gates — so a refused accept ran nothing on
 * the member's files and wrote nothing to the forge. Only the raised-item
 * resolutions come first: they are the human's own words, saved before
 * anything that can refuse.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/utils/role-target';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { resolve } from 'path';
import { RpcError as RealRpcError } from '../../src/daemon/rpc-handlers';
import {
  DEFAULT_CONFIG as REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate as REAL_getDefaultConfigTemplate,
} from '../../src/config/loader';
import {
  claimMemberTerminal,
  markMemberTerminalEntered,
  resetMemberTerminalsForTests,
} from '../../src/server/member-terminals';

let mockTask: any = null;
let mockSession: any = null;
/** Every effect-bearing step the accept reached, in order. */
let reached: string[] = [];
let preAcceptEnabled = true;

await mockModule(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: async () => ({
    remote: { driver: 'gitlab', git_remote: 'origin', auto_approve: true },
    storage: { backend: 'external', external_path: '' },
    review: { mode: 'separate', auto_fix: false, draft_effort: 'low', review_effort: 'xhigh' },
    automation: {
      maintain: [], react: [],
      pre_accept: { enabled: preAcceptEnabled, commands: ['make check'], timeout: 600 },
      accept_check: '', accept_check_timeout: 300,
    },
    models: { default: 'claude-opus-4-7', roles: { builder: ANTHROPIC_DEFAULT_TARGET, agent: ANTHROPIC_DEFAULT_TARGET } },
    git: { default_branch_prefix: 'lazy' },
    protection: { enabled: false, protected_branches: [], protected_tasks: [], gate_default_branch: true },
  }),
  DEFAULT_CONFIG: REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate: REAL_getDefaultConfigTemplate,
}));

await mockModule(resolve(import.meta.dir, '../../src/daemon/rpc-handlers.ts'), () => ({
  getOrCreateStorage: async () => createMockStorage(),
  RpcError: RealRpcError,
  initDaemonStorage: () => {},
}));

// A protected target with no MR yet: a fresh accept would push the branch,
// create the MR, approve it and ask the forge's gates — every one recorded.
await mockModule(resolve(import.meta.dir, '../../src/remote/index.ts'), () => {
  const LocalDriver = class {
    needsSync = false;
    validateAccept() { return null; }
    hasRemoteRef() { return false; }
    async isTargetBranchProtected() { return false; }
    async pushBranch() { reached.push('pushBranch'); }
    async markReadyForReview() { reached.push('markReadyForReview'); return {}; }
    async checkAcceptGates() { reached.push('checkAcceptGates'); return []; }
    async merge() { reached.push('merge'); return { status: 'merged' as const }; }
    async fastForwardLocal() { return { success: true }; }
    async approveForMerge() { reached.push('approveForMerge'); return null; }
    async getTaskUrl() { return null; }
    async updateRemoteBody() {}
  };
  return {
    detectRemote: () => null,
    createDriver: () => ({
      needsSync: true,
      validateAccept: () => 'no MR yet',
      hasRemoteRef: () => false,
      hasExternalApproval: async () => true,
      isTargetBranchProtected: async () => true,
      pushBranch: async () => { reached.push('pushBranch'); },
      markReadyForReview: async () => { reached.push('markReadyForReview'); return { metadata: { gitlab_remote_ref_id: '1' } }; },
      getPRState: async () => 'OPEN',
      getChecksStatus: async () => ({ status: 'passed' as const, failed: [] }),
      getTaskUrl: async () => 'https://gitlab/mr/1',
      approveForMerge: async () => { reached.push('approveForMerge'); return null; },
      checkAcceptGates: async () => { reached.push('checkAcceptGates'); return []; },
      merge: async () => { reached.push('merge'); return { status: 'pending' as const, metadata: {} }; },
      fastForwardLocal: async () => ({ success: true }),
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

// The gate's runner: stop the accept right there once the gate is reached.
await mockModule(resolve(import.meta.dir, '../../src/runner/index.ts'), () => ({
  createRunner: async () => { throw new Error('acceptance gate runner (test stops here)'); },
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
  // The acceptance gate ([automation.pre_accept]) takes the worktree lock
  // under this label before anything else it does: the gate was reached.
  acquireLock: (_path: string, label: string) => {
    if (label.includes('acceptance gate')) reached.push('launchAcceptanceGate');
  },
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
  reparentChildren: async () => [],
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
  cleanupWorktreeAndBranch: () => {},
  cleanupTaskContainer: async () => {},
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
  return {
    resolveTask: async () => ({ task: mockTask, ambiguousMatches: [] }),
    getTask: async () => mockTask,
    getSessionByTaskId: async () => mockSession,
    getSessionTurns: async () => [{
      id: 'seeded-final', sequence: 1, role: 'human', content: '[system] Finalize declared',
      timestamp: 1, turn_type: 'pre_accept',
      final: { sha: 'abc123', actor: 'human', at: 1, wrap_up_steps: [] },
    }],
    getSessionCommits: async () => [{ sha: 'commit1', message: 'work' }],
    getTaskComments: async () => [],
    getTaskReviewComments: async () => [],
    getChildTasks: async () => [],
    getTaskRaisedItems: async () => [],
    resolveRaisedItem: async () => { throw new Error('unexpected resolveRaisedItem'); },
    updateTaskStatus: async (_id: string, status: string) => { mockTask.status = status; },
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
    id: 'task-id-12345678',
    code: 'held-task',
    goal: 'Work a member is inside',
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

const ALICE = 'alice@example.com';
const EFFECTS = ['launchAcceptanceGate', 'pushBranch', 'markReadyForReview', 'approveForMerge', 'checkAcceptGates', 'merge'];

describe('accepting a task a member is working in', () => {
  beforeEach(() => {
    mockTask = makeTask();
    mockSession = {
      id: 'sess-id', task_id: mockTask.id, agent_id: 'test-agent', git_branch: 'lazy/held-branch',
      git_start_sha: 'abc123', started_at: 1, ended_at: null, outcome: null, claude_session_id: null,
    };
    reached = [];
    preAcceptEnabled = true;
  });
  afterEach(() => resetMemberTerminalsForTests());

  test('is refused before the acceptance gate, the push, the MR or any forge call', async () => {
    expect(claimMemberTerminal(mockTask.id, ALICE).ok).toBe(true);
    markMemberTerminalEntered(mockTask.id, ALICE);
    const err = await acceptTask('/tmp/test', { taskId: 'held-task' }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RealRpcError);
    expect((err as RealRpcError).status).toBe(409);
    expect((err as Error).message).toContain(ALICE);
    expect(reached.filter((r) => EFFECTS.includes(r))).toEqual([]);
    expect(mockTask.status).toBe('blocked');
  });

  // Controls: with nobody inside, the same accept DOES reach each recorder,
  // so the empty list above is the check's doing, not a fixture that never
  // gets that far.
  test('with nobody inside, the accept reaches the acceptance gate', async () => {
    await acceptTask('/tmp/test', { taskId: 'held-task' }).catch(() => {});
    expect(reached).toContain('launchAcceptanceGate');
  });

  test('with nobody inside and no gate configured, it pushes and opens the MR', async () => {
    preAcceptEnabled = false;
    await acceptTask('/tmp/test', { taskId: 'held-task' }).catch(() => {});
    expect(reached).toContain('pushBranch');
    expect(reached).toContain('markReadyForReview');
  });
});

afterAll(() => {
  restoreMockedModules();
});
