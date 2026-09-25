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
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/utils/role-target';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { resolve } from 'path';

// --- Controllable mock state ---
let mockTask: any = null;
let mockSession: any = null;
let hasUpstreamChangesValue = true;
/** Hook fired inside the upstream check, i.e. while sync is doing its slow work. */
let onUpstreamCheck: (() => Promise<void>) | null = null;
let launchSupervisorImpl: () => Promise<void> = async () => {};
let isRunningValue = false;
let writeCommandCalls = 0;
let consumeCommandCalls = 0;
let hostMergeOutcome: 'conflict' | 'merged' = 'conflict';
let checkAvailabilityCalls = 0;

const updateCalls: Array<{ method: string; args: any[] }> = [];

import { RpcError as RealRpcError } from '../../src/daemon/rpc-handlers';
import {
  DEFAULT_CONFIG as REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate as REAL_getDefaultConfigTemplate,
} from '../../src/config/loader';

await mockModule(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: async () => ({
    remote: { driver: 'local', git_remote: 'origin', auto_approve: false, offline: false },
    storage: { backend: 'external', external_path: '' },
    data: { path: '/tmp/fake-data' },
    ollama: { enabled: false, model: null },
    models: { default: 'claude-opus-4-7', roles: { builder: ANTHROPIC_DEFAULT_TARGET, agent: ANTHROPIC_DEFAULT_TARGET } },
    // Guard timeouts ride along on the sync command: a sync that hits conflicts
    // runs a real agent turn and must be guarded like any other.
    agent: REAL_DEFAULT_CONFIG.agent,
    // A sync that hits conflicts passes the [usage_pause] gate before its
    // agent launches; the default (pausing off) lets it through.
    usage_pause: REAL_DEFAULT_CONFIG.usage_pause,
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
  hasUpstreamChanges: async () => {
    if (onUpstreamCheck) await onUpstreamCheck();
    return hasUpstreamChangesValue;
  },
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

await mockModule(resolve(import.meta.dir, '../../src/task/identity.ts'), () => ({
  shortId: (id: string) => id.substring(0, 8),
  displayId: (task: any) => task.code ?? task.id.substring(0, 8),
  taskRef: (task: any) => task.code ?? task.id.substring(0, 8),
  taskRefFromId: (id: string) => id.substring(0, 8),
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
  runSyncWithRemote: async () => ({ remoteBranch: null, remoteCommentsCtx: null }),
  syncTaskFromRemote: async () => {},
}));
await mockModule(resolve(import.meta.dir, '../../src/task/cleanup.ts'), () => ({
  cleanupWorktree: () => {},
  cleanupWorktreeAndBranch: () => {},
  cleanupTaskContainer: async () => {},
}));

await mockModule(resolve(import.meta.dir, '../../src/daemon/self-sync.ts'), () => ({
  planSelfSyncSteps: () => [{ step: 2, ref: 'main', target: 'deadbeef' }],
  runSelfSync: async () => hostMergeOutcome === 'merged'
    ? {
        status: 'merged',
        message: 'Merged main into the task branch.',
        steps: [{ step: 2, of: 2, ref: 'main', outcome: 'merged' }],
      }
    : {
        status: 'conflict',
        message: 'Merge conflict.',
        steps: [{ step: 2, of: 2, ref: 'main', outcome: 'conflict' }],
      },
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
    checkAvailability: () => { checkAvailabilityCalls++; },
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
    getSession: async () => mockSession,
    getSessionTurns: async () => [],
    // Nobody asks for a sync turn, so the launch CLEARS the previous turn's
    // owner and then reads the session back to prove it — a clear that silently
    // did nothing would stamp this turn's rows with the last human who
    // unblocked the task (src/daemon/turn-owner.ts). The mock has to model both
    // halves or the launch refuses itself.
    setSessionTurnOwner: async (sessionId: string, owner: unknown) => {
      updateCalls.push({ method: 'setSessionTurnOwner', args: [sessionId, owner] });
      if (mockSession) {
        mockSession.turn_owner_email = (owner as { email?: string } | null)?.email ?? null;
        mockSession.turn_owner_name = (owner as { name?: string } | null)?.name ?? null;
      }
    },
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
    updateSessionRunnerType: async (sessionId: string, runnerType: string | null) => {
      updateCalls.push({ method: 'updateSessionRunnerType', args: [sessionId, runnerType] });
    },
    // A sync's conflict-resolution turn resolves its agent/model/effort through
    // resolveTurnLaunchIdentity like every other turn type, so the mock has to
    // answer the reads and writes that ladder makes: the project-settings
    // overlay it consults, and the two fields it pins on the task.
    getProjectSettings: async () => null,
    updateTaskModel: async (taskId: string, model: string) => {
      updateCalls.push({ method: 'updateTaskModel', args: [taskId, model] });
      if (mockTask) mockTask.model = model;
    },
    updateTaskMetadata: async (taskId: string, key: string, value: unknown) => {
      updateCalls.push({ method: 'updateTaskMetadata', args: [taskId, key, value] });
      if (mockTask) (mockTask.metadata as Record<string, unknown>)[key] = value;
    },
    resetTaskPendingSync: async () => {
      updateCalls.push({ method: 'resetTaskPendingSync', args: [] });
    },
    incrementTaskPendingSync: async () => {
      updateCalls.push({ method: 'incrementTaskPendingSync', args: [] });
    },
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
    container_agent_id: null,
    last_interaction_at: null,
  };
}

describe('syncTask state transitions', () => {
  beforeEach(() => {
    mockTask = makeTask();
    mockSession = makeSession();
    hasUpstreamChangesValue = true;
    onUpstreamCheck = null;
    isRunningValue = false;
    launchSupervisorImpl = async () => {};
    updateCalls.length = 0;
    writeCommandCalls = 0;
    consumeCommandCalls = 0;
    hostMergeOutcome = 'conflict';
    checkAvailabilityCalls = 0;
  });

  test('a clean host merge finishes without checking runner availability', async () => {
    hostMergeOutcome = 'merged';

    const result = await syncTask('/tmp/test', { taskId: 'test-task' });

    expect(result.status).toBe('merged');
    expect(checkAvailabilityCalls).toBe(0);
    expect(writeCommandCalls).toBe(0);
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

  // INVARIANT: sync does NOT pre-create a turn on the daemon side. Turn recording
  // is owned by the reconciler (recordSyncTurns), keyed on the merge OUTCOME — a
  // real merge becomes a `supervisor`-actored turn, a no-op merge records NO turn.
  // Pre-creating a turn here (before the supervisor reports whether it merged
  // anything) is exactly what left a spurious turn pair on no-op syncs.
  test('does not pre-create a turn when dispatching the sync', async () => {
    await syncTask('/tmp/test', { taskId: 'test-task' });

    const turnCreations = updateCalls.filter(c => c.method === 'createTurn');
    expect(turnCreations.length).toBe(0);
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

  // INVARIANT (investigate-merge-and-fix-on-ask): the status check at the top of
  // syncTask is advisory — parent resolution and the upstream fetch run between
  // it and the command write, and auto-sync calls syncTask from inside the daemon
  // where an ask/unblock can claim the task in that window. `writeCommand` DELETES
  // any pending response.json, so a sync that dispatches anyway destroys the
  // answer an in-flight ask is waiting for — the task then shows
  // `working:(harness:merge_and_fix)` and the human's question never gets an
  // answer. Sync must re-read the status INSIDE the lifecycle lock and stand
  // down, re-queueing itself via pending_sync rather than stomping the claim.
  test('stands down without writing a command when the task is claimed mid-fetch', async () => {
    onUpstreamCheck = async () => {
      // Someone else (an ask, an unblock, another sync) claimed the task while
      // this sync was resolving upstream.
      mockTask.status = 'working';
    };

    const result = await syncTask('/tmp/test', { taskId: 'test-task' });

    expect(result.status).toBe('pending_sync');
    // Nothing was dispatched: no command over the other turn's, no transition.
    expect(writeCommandCalls).toBe(0);
    expect(updateCalls.filter(c => c.method === 'updateTaskStatus')).toHaveLength(0);
    // The sync is not dropped — it goes back on the retry counter.
    expect(updateCalls.filter(c => c.method === 'incrementTaskPendingSync')).toHaveLength(1);
  });

  // INVARIANT (investigate-merge-and-fix-on-ask): the in-lock re-read is a
  // WHITELIST of the four dispatchable statuses, not a blacklist of the busy
  // ones. `pairing` (a human took the worktree) and `merging` become reachable
  // during the same fetch window, and neither has a `→ working` edge in
  // TASK_TRANSITIONS — so a blacklist gate would bind a turn credential in
  // prepareTurnLaunch and then throw an invalid-transition error for a turn that
  // never launches, instead of quietly re-queueing. Every non-dispatchable
  // status takes the graceful path.
  test('stands down for a non-busy status too (pairing) rather than failing the transition', async () => {
    onUpstreamCheck = async () => {
      // A human started pairing in the worktree while this sync was resolving
      // upstream. Not "busy with a turn" — but still not ours to dispatch on.
      mockTask.status = 'pairing';
    };

    const result = await syncTask('/tmp/test', { taskId: 'test-task' });

    expect(result.status).toBe('pending_sync');
    expect(result.message).toContain('pairing');
    expect(writeCommandCalls).toBe(0);
    expect(updateCalls.filter(c => c.method === 'updateTaskStatus')).toHaveLength(0);
    expect(updateCalls.filter(c => c.method === 'incrementTaskPendingSync')).toHaveLength(1);
  });
});

afterAll(() => {
  restoreMockedModules();
});
