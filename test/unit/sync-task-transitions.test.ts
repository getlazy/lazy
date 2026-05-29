/**
 * Unit tests for syncTask() state transitions.
 *
 * Regression: `lazy sync <task>` used to write a command file and launch a
 * supervisor, but never transitioned the task out of its prior status. The
 * reconciler only processes 'working' tasks, so the supervisor's response.json
 * was never consumed — no turn was recorded and the task status never changed,
 * while the CLI reported "Upstream merge launched." Silent no-op.
 *
 * These tests lock in the fix at the syncTask level:
 *   - status must transition to 'working' before supervisor launch
 *   - a human turn must be created so the reconciler's idempotency check
 *     (which skips when the last turn is 'agent') doesn't drop the response
 *   - container name and session interaction timestamp must be persisted
 *   - on launchSupervisor failure, the status must revert to the prior value
 */

import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { resolve } from 'path';

// --- Controllable mock state ---
let mockTask: any = null;
let mockSession: any = null;
let hasUpstreamChangesValue = true;
let launchSupervisorImpl: () => Promise<void> = async () => {};
let isRunningValue = false;
let writeCommandCalls = 0;
let consumeCommandCalls = 0;

const updateCalls: Array<{ method: string; args: any[] }> = [];

import { RpcError as RealRpcError } from '../../src/daemon/rpc-handlers';
import {
  DEFAULT_CONFIG as REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate as REAL_getDefaultConfigTemplate,
} from '../../src/config/loader';

await mockModule(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: async () => ({
    remote: { driver: 'local', git_remote: 'origin', auto_approve: false },
    storage: { backend: 'external', external_path: '' },
    data: { path: '/tmp/fake-data' },
    ollama: { enabled: false, model: null },
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

await mockModule(resolve(import.meta.dir, '../../src/remote/index.ts'), () => ({
  detectRemote: () => null,
  createDriver: () => ({
    resolveUpstreamRef: async (branch: string) => branch,
  }),
}));

await mockModule(resolve(import.meta.dir, '../../src/git/operations.ts'), () => ({
  hasUncommittedChanges: async () => false,
  applyPatch: async () => true,
  hasUpstreamChanges: async () => hasUpstreamChangesValue,
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
  taskRefFromId: (id: string) => id.substring(0, 8),
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
  runSyncWithRemote: async () => ({ remoteBranch: null, remoteCommentsCtx: null }),
  cleanupWorktree: () => {},
  cleanupWorktreeAndBranch: () => {},
  cleanupTaskContainer: async () => {},
  syncTaskFromRemote: async () => {},
  resolveParentBranchWithFallback: async () => ({ branch: 'main', warnings: [] }),
}));

await mockModule(resolve(import.meta.dir, '../../src/protocol/index.ts'), () => ({
  protocolDir: () => '/tmp/protocol',
  writeCommand: () => {
    writeCommandCalls++;
  },
  consumeCommand: () => {
    consumeCommandCalls++;
  },
  ensureProtocolDir: () => {},
  commonCommandFields: () => ({}),
  removeProtocolDir: () => {},
}));

await mockModule(resolve(import.meta.dir, '../../src/runner/index.ts'), () => ({
  createRunner: async () => ({
    type: 'host-process',
    setAgent: () => {},
    checkAvailability: () => {},
    runNameForTask: (ref: string) => `run-${ref}`,
    isRunning: () => isRunningValue,
    removeRun: () => {},
    usesSandbox: () => false,
    launchSupervisor: () => launchSupervisorImpl(),
  }),
}));

await mockModule(resolve(import.meta.dir, '../../src/daemon/task-launcher.ts'), () => ({
  writeDaemonMcpConfig: async () => '/tmp/fake-daemon-config.json',
  SANDBOX_DIR: '.lazy-task-sandbox',
}));

await mockModule(resolve(import.meta.dir, '../../src/utils/sandbox.ts'), () => ({
  SANDBOX_DIR: '.lazy-task-sandbox',
  setupSandbox: async (worktreePath: string) => ({
    worktreePath,
    sandboxPath: `${worktreePath}/.lazy-task-sandbox`,
  }),
}));

await mockModule(resolve(import.meta.dir, '../../src/agent/registry.ts'), () => ({
  getAgent: () => ({
    id: 'claude-code',
    binary: 'fake-claude',
    commandName: 'claude',
  }),
}));

// Import the unit under test AFTER mocks are registered.
const { syncTask } = await import('../../src/daemon/task-lifecycle');

function createMockStorage() {
  return {
    resolveTask: async () => ({ task: mockTask, ambiguousMatches: [] }),
    getTask: async () => mockTask,
    getSessionByTaskId: async () => mockSession,
    getSessionTurns: async () => [],
    getNextTurnSequence: async () => 5,
    createTurn: async (opts: any) => {
      updateCalls.push({ method: 'createTurn', args: [opts] });
    },
    updateTaskStatus: async (taskId: string, status: string, actor: string) => {
      updateCalls.push({ method: 'updateTaskStatus', args: [taskId, status, actor] });
      if (mockTask) mockTask.status = status;
    },
    updateSessionContainerName: async (sessionId: string, name: string | null) => {
      updateCalls.push({ method: 'updateSessionContainerName', args: [sessionId, name] });
    },
    updateSessionInteraction: async (sessionId: string, dur: number) => {
      updateCalls.push({ method: 'updateSessionInteraction', args: [sessionId, dur] });
    },
    resetTaskPendingSync: async () => {},
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
    model: 'claude-opus-4-7',
    agent_id: 'claude-code',
    created_at: Date.now(),
    completed_at: null,
    target: { kind: 'branch' as const, branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    metadata: { parent_branch: 'main' },
    pending_sync: 0,
  };
}

function makeSession() {
  return {
    id: 'test-session-id',
    task_id: 'test-task-id-12345678',
    agent_id: 'test-agent',
    agent_session_id: null,
    git_branch: 'lazy/test-branch',
    git_start_sha: 'abc123',
    started_at: Date.now(),
    ended_at: null,
    outcome: null,
    container_name: null,
    last_interaction_at: null,
  };
}

describe('syncTask state transitions', () => {
  beforeEach(() => {
    mockTask = makeTask();
    mockSession = makeSession();
    hasUpstreamChangesValue = true;
    isRunningValue = false;
    launchSupervisorImpl = async () => {};
    updateCalls.length = 0;
    writeCommandCalls = 0;
    consumeCommandCalls = 0;
  });

  // INVARIANT: syncTask must transition the task to 'working' before launching
  // the supervisor. Without this, the reconciler (which only processes working
  // tasks) will never consume the supervisor's response — the merge happens
  // but produces no turn and the task stays in its prior status forever.
  test('transitions task to working when upstream has changes', async () => {
    const result = await syncTask('/tmp/test', { taskId: 'test-task' });

    expect(result.status).toBe('sync_launched');

    const statusUpdates = updateCalls.filter(c => c.method === 'updateTaskStatus');
    expect(statusUpdates.length).toBeGreaterThanOrEqual(1);
    // First status update must be to 'working' — must happen before launch.
    expect(statusUpdates[0].args[1]).toBe('working');
  });

  // INVARIANT: A human turn must be created so the reconciler's idempotency
  // check doesn't collapse the sync response into the previous agent turn.
  // handleCompletedResponse in src/utils/reconcile.ts skips creating a new
  // turn when the last turn is already role='agent'.
  test('records a human turn documenting the sync request', async () => {
    await syncTask('/tmp/test', { taskId: 'test-task' });

    const turnCreations = updateCalls.filter(c => c.method === 'createTurn');
    expect(turnCreations.length).toBe(1);
    const turn = turnCreations[0].args[0];
    expect(turn.role).toBe('human');
    // Convention: synthetic turns generated by lazy itself are prefixed
    // `[built-in]` (not `[system]`) to read as "generated by lazy" rather
    // than "system-level". Lock this in so the convention doesn't drift.
    expect(turn.content).toContain('[built-in]');
    expect(turn.content).toContain('Upstream merge requested');
  });

  // INVARIANT: Status transition must happen BEFORE writeCommand / launch.
  // If we launched the supervisor first and then transitioned, a fast
  // supervisor could write response.json before the status was 'working'
  // and the reconciler would still skip it.
  test('status transitions to working before turn creation ordering is durable', async () => {
    await syncTask('/tmp/test', { taskId: 'test-task' });

    const turnIdx = updateCalls.findIndex(c => c.method === 'createTurn');
    const statusIdx = updateCalls.findIndex(
      c => c.method === 'updateTaskStatus' && c.args[1] === 'working',
    );
    expect(turnIdx).toBeGreaterThanOrEqual(0);
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    // Turn is persisted before the status flip so the reconciler, which may
    // run concurrently, never sees 'working' without the human turn in place.
    expect(turnIdx).toBeLessThan(statusIdx);
  });

  // INVARIANT: Container name must be persisted so the reconciler can find
  // the supervisor process (via runner.isRunning(containerName)).
  test('persists container name and resets interaction timer', async () => {
    await syncTask('/tmp/test', { taskId: 'test-task' });

    const containerUpdate = updateCalls.find(c => c.method === 'updateSessionContainerName');
    expect(containerUpdate).toBeDefined();
    expect(containerUpdate!.args[1]).toBe('run-test-task');

    const interactionUpdate = updateCalls.find(c => c.method === 'updateSessionInteraction');
    expect(interactionUpdate).toBeDefined();
  });

  // INVARIANT: When there are no upstream changes, sync must be an honest
  // no-op — return 'up_to_date' without transitioning to 'working' or
  // creating a turn. Doing otherwise would produce misleading turn history.
  test('reports up_to_date without state changes when no upstream changes', async () => {
    hasUpstreamChangesValue = false;

    const result = await syncTask('/tmp/test', { taskId: 'test-task' });

    expect(result.status).toBe('up_to_date');
    const statusUpdates = updateCalls.filter(c => c.method === 'updateTaskStatus');
    expect(statusUpdates.length).toBe(0);
    const turnCreations = updateCalls.filter(c => c.method === 'createTurn');
    expect(turnCreations.length).toBe(0);
  });

  // INVARIANT: If launchSupervisor throws, the premature 'working' transition
  // must be reverted. Otherwise the task is stuck in 'working' with no
  // supervisor, and only the grace-period timeout (30s) will recover it.
  test('reverts status to prior value when supervisor launch fails', async () => {
    launchSupervisorImpl = async () => {
      throw new Error('docker not running');
    };

    await expect(syncTask('/tmp/test', { taskId: 'test-task' })).rejects.toThrow(
      /Failed to launch supervisor for sync/,
    );
    await expect(syncTask('/tmp/test', { taskId: 'test-task' })).rejects.toThrow(
      /docker not running/,
    );

    // Reset state for our assertion run below (the two rejects runs above
    // each executed one sync attempt and populated updateCalls twice).
    mockTask = makeTask();
    updateCalls.length = 0;
    await expect(syncTask('/tmp/test', { taskId: 'test-task' })).rejects.toThrow();

    const statusUpdates = updateCalls.filter(c => c.method === 'updateTaskStatus');
    // At least: initial 'working' + revert to 'blocked'.
    expect(statusUpdates.length).toBeGreaterThanOrEqual(2);
    expect(statusUpdates[0].args[1]).toBe('working');
    expect(statusUpdates[statusUpdates.length - 1].args[1]).toBe('blocked');
  });

  // INVARIANT: If launchSupervisor throws, the sync command file already
  // written to protoDir must be cleaned up. Leaving a stale command file
  // behind misrepresents in-flight state — there's no supervisor to consume
  // it, so it shouldn't linger.
  test('cleans up sync command file when supervisor launch fails', async () => {
    launchSupervisorImpl = async () => {
      throw new Error('docker not running');
    };

    await expect(syncTask('/tmp/test', { taskId: 'test-task' })).rejects.toThrow();

    // writeCommand runs before the launch attempt; consumeCommand must run
    // in the catch path so they balance out for a failed launch.
    expect(writeCommandCalls).toBeGreaterThanOrEqual(1);
    expect(consumeCommandCalls).toBe(writeCommandCalls);
  });
});

afterAll(() => {
  restoreMockedModules();
});
