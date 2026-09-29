/**
 * The environment-replaced notice through the REAL unblock launch.
 *
 * INVARIANT: when a launch recreates a RUNNING task container — for a credential
 * change or an agent change — the prompt that launch sends opens with the
 * environment-replaced line exactly once, and the next launch does not repeat
 * it. A launch that fails keeps the fact for the turn that eventually runs.
 * A host-process run is never "replaced": its environment is the host.
 *
 * Drives `launchUnblockTask` with the same seams as
 * test/unit/unblock-review-round-guard.test.ts; the command's prompt is
 * captured at `writeCommand`.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { resolve } from 'path';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/utils/role-target';
import { RpcError as RealRpcError } from '../../src/daemon/rpc-handlers';
import {
  DEFAULT_CONFIG as REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate as REAL_getDefaultConfigTemplate,
} from '../../src/config/loader';
import { ENVIRONMENT_REPLACED_KEY, REASON_AGENT_CHANGED, REASON_CREDENTIAL_CHANGED, REASON_TASK_ENV_CHANGED, environmentReplacedLine } from '../../src/task/environment-replaced';

// --- Shared, mutable scenario state (reset per test) ---
const metadata = new Map<string, string>();
const createdTurns: any[] = [];
const statusWrites: string[] = [];
const prompts: string[] = [];
let recreateForCredential = false;
let recreateForAgent = false;
let recreateForEnv = false;
let running = true;
let sandboxed = true;
let launchFails = false;

function makeTask(): any {
  return {
    id: 'task-1',
    code: 'guard-task',
    goal: 'Ship it',
    status: 'blocked',
    agent_id: 'claude',
    runner_type: null,
    type: 'task',
    prompt: 'Do the work',
    target: { kind: 'branch', branch: 'main' },
  };
}

function makeSession(): any {
  return {
    id: 'sess-1',
    task_id: 'task-1',
    git_branch: 'lazy/guard-task',
    // Present → the handler skips the agent-switch handoff rebuild.
    agent_session_id: 'sess-file',
    ended_at: null,
    container_agent_id: 'claude',
    git_start_sha: 'abc123',
  };
}

/**
 * When set, the task under test is a child of this LOOP parent — which is what
 * arms the `[loop] max_child_fix_rounds` guard. Reset per test.
 */
let loopParentId: string | null = null;

function createMockStorage(): any {
  const task = makeTask();
  if (loopParentId) task.target = { kind: 'task', parentTaskId: loopParentId };
  const sess = makeSession();
  const loopParent = { id: loopParentId, code: 'the-loop', type: 'cluster', status: 'working' };
  return {
    resolveTask: async () => ({ task, ambiguousMatches: [] }),
    getTask: async (id: string) => (loopParentId && id === loopParentId ? loopParent : task),
    getSessionByTaskId: async () => sess,
    getTaskMetadata: async (taskId: string, key: string) => metadata.get(`${taskId}:${key}`) ?? null,
    updateTaskMetadata: async (taskId: string, key: string, value: string) => {
      metadata.set(`${taskId}:${key}`, value);
    },
    resetConsecutiveInterruptions: async () => {},
    getTaskReviewComments: async () => [],
    getTaskComments: async () => [],
    getTaskJournal: async () => [],
    getSessionTurns: async () => [],
    listTaskArtifacts: async () => [],
    getLatestWorktreeSnapshot: async () => null,
    getNextTurnSequence: async () => 4,
    createTurn: async (turn: any) => {
      createdTurns.push(turn);
    },
    updateTaskStatus: async (_id: string, status: string) => {
      statusWrites.push(status);
    },
    updateSessionContainerName: async () => {},
    updateSessionInteraction: async () => {},
    updateTaskTarget: async () => {},
    createComment: async () => {},
    close: async () => {},
  } as any;
}

// --- Module mocks along the unblock path (storage is NOT mocked here —
// the real round-counter code in auto-react-budget.ts must run against it) ---

await mockModule(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: async () => ({
    remote: { driver: 'gitlab', git_remote: 'origin', auto_approve: false },
    storage: { backend: 'external', external_path: '' },
    // ResolvedConfig always carries a fully-populated `review` section, and
    // the accept gate reads `config.review.mode` unguarded like every other
    // required section. `separate` keeps these doubles on the pre-2026-09-21
    // behaviour, where every recorded review turn gates.
    review: { mode: 'separate', auto_fix: false, draft_effort: 'low', review_effort: 'xhigh' },
    automation: { maintain: [], react: [], pre_accept: { enabled: false, commands: [], timeout: 600 }, accept_check: '', accept_check_timeout: 300 },
    models: { default: 'claude-opus-4-7', roles: { builder: ANTHROPIC_DEFAULT_TARGET, agent: ANTHROPIC_DEFAULT_TARGET } },
    git: { default_branch_prefix: 'lazy' },
    protection: { enabled: false, protected_branches: [], protected_tasks: [], gate_default_branch: true },
    limits: { max_turns_without_human: 999 },
    // The loop fix-round budget (§9.1). Only arms when the task has a LOOP
    // parent, which `loopParentId` decides per test.
    cluster: { max_child_fix_rounds: 3 },
    usage_pause: { threshold_percent: 0, credentials: {} },
    memory: { warn_bytes: 20000 },
  }),
  DEFAULT_CONFIG: REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate: REAL_getDefaultConfigTemplate,
}));

await mockModule(resolve(import.meta.dir, '../../src/daemon/rpc-handlers.ts'), () => ({
  getOrCreateStorage: async () => createMockStorage(),
  RpcError: RealRpcError,
  initDaemonStorage: () => {},
}));

await mockModule(resolve(import.meta.dir, '../../src/daemon/launch-identity.ts'), () => ({
  resolveTurnLaunchIdentity: async () => ({ model: 'test-model', effort: 'medium' }),
  resolveOneOffTurnIdentity: async () => ({ model: 'test-model', effort: 'medium' }),
}));

await mockModule(resolve(import.meta.dir, '../../src/daemon/effort.ts'), () => ({
  resolveAndPersistLowHighLoop: async () => null,
}));

await mockModule(resolve(import.meta.dir, '../../src/daemon/upstream-command-ref.ts'), () => ({
  resolveUpstreamMergeRefForCommand: async () => ({ ref: 'main', warnings: [] }),
}));

await mockModule(resolve(import.meta.dir, '../../src/daemon/wrap-up-plan.ts'), () => ({
  resolveWrapUpCommandFields: async () => ({}),
}));

await mockModule(resolve(import.meta.dir, '../../src/daemon/turn-credentials.ts'), () => ({
  prepareTurnLaunch: async () => ({ mustRecreateContainer: recreateForCredential }),
  releaseTurnCredential: async () => {},
}));

await mockModule(resolve(import.meta.dir, '../../src/daemon/task-harness.ts'), () => ({
  setRunnerAgentForTask: (runner: any) => {
    runner.harness = 'claude';
    return 'claude';
  },
}));

await mockModule(resolve(import.meta.dir, '../../src/runner/index.ts'), () => ({
  createRunner: async () => ({
    type: 'claude',
    runLabel: 'test-runner',
    runNameForTask: () => 'run-1',
    runDisplayName: () => 'run-1 (test)',
    getAgentInstructions: () => 'instructions',
    checkAvailability: async () => {},
    usesSandbox: () => sandboxed,
    isRunning: async () => running,
    launchSupervisor: async () => { if (launchFails) throw new Error('docker run failed'); },
  }),
}));

const realTaskEnv = { ...(await import('../../src/daemon/task-env')) };
await mockModule(resolve(import.meta.dir, '../../src/daemon/task-env.ts'), () => ({
  ...realTaskEnv,
  mustRecreateForTaskEnv: async () => recreateForEnv,
}));

await mockModule(resolve(import.meta.dir, '../../src/runner/session-launch.ts'), () => ({
  stampSessionRunner: async () => {},
  removeTaskRun: async () => {},
  mustRecreateForContainerAgent: () => recreateForAgent,
}));

await mockModule(resolve(import.meta.dir, '../../src/utils/fs.ts'), () => ({
  pathExists: async () => true,
  dirExists: async () => true,
  ensureDir: async () => {},
  readFileSafe: async () => null,
}));

await mockModule(resolve(import.meta.dir, '../../src/utils/lock.ts'), () => ({
  checkLock: async () => null,
  acquireLock: async () => {},
  removeLock: async () => {},
}));

await mockModule(resolve(import.meta.dir, '../../src/utils/pairing-lock.ts'), () => ({
  checkPairingLock: () => null,
}));

await mockModule(resolve(import.meta.dir, '../../src/utils/sandbox.ts'), () => ({
  setupSandbox: async () => ({}),
}));

await mockModule(resolve(import.meta.dir, '../../src/utils/features.ts'), () => ({
  isFeatureEnabled: () => false,
}));

await mockModule(resolve(import.meta.dir, '../../src/config/chattiness.ts'), () => ({
  resolveAgentChattiness: () => 'normal',
  renderChattinessSnippet: () => '',
}));

await mockModule(resolve(import.meta.dir, '../../src/task/identity.ts'), () => ({
  shortId: (id: string) => id.substring(0, 8),
  displayId: (task: any) => task.code ?? task.id.substring(0, 8),
  displayIdFor: (task: any) => task.code ?? task.id.substring(0, 8),
  taskRef: (task: any) => task.code ?? task.id.substring(0, 8),
  getWorktreePath: () => '/tmp/fake-worktree',
  getWorktreePathForRef: () => '/tmp/fake-worktree',
  getBranchName: (id: string) => `lazy/${id}`,
  getBranchNameFromId: async () => 'lazy/guard-task',
}));

await mockModule(resolve(import.meta.dir, '../../src/git/operations.ts'), () => ({
  getRemoteDefaultBranch: async () => 'main',
  getCurrentBranch: async () => 'main',
  resolveDetachedHead: async (b: string) => b,
  getCurrentSha: async () => 'abc123',
  branchExists: async () => false,
  hasUpstreamChanges: async () => false,
  hasUncommittedChanges: async () => false,
  recoverMissingWorktreeWithFetch: async () => ({ recovered: true, source: 'local' as const }),
  applyPatch: async () => true,
  createAcceptTag: async () => {},
  getNewCommits: async () => [],
  getMergeBase: async () => 'abc123',
  readWorktreeMergeState: async () => null,
  isMidMerge: async () => false,
  describeMergeState: () => 'clean',
}));

await mockModule(resolve(import.meta.dir, '../../src/utils/git.ts'), () => ({
  validateBranchInSyncWithRemote: async () => ({ inSync: true }),
  runGit: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
}));

await mockModule(resolve(import.meta.dir, '../../src/task/sync-remote.ts'), () => ({
  runSyncWithRemote: async () => ({ remoteCommentsCtx: undefined, remoteBranch: null }),
  syncTaskFromRemote: async () => {},
}));

await mockModule(resolve(import.meta.dir, '../../src/daemon/raised-items.ts'), () => ({
  applyRaisedResolutions: async () => ({ resolved: [], warnings: [] }),
  buildRaisedResolvedNotice: () => null,
  materializePendingRaisedComments: async () => ({ warnings: [], deliveredItemIds: [] }),
  openRaisedItems: async () => [],
  allOpenRaisedItems: async () => [],
  validateRaisedResolutions: async () => ({ errors: [] }),
}));

await mockModule(resolve(import.meta.dir, '../../src/task/turn-context.ts'), () => ({
  buildNotesContext: () => '',
  buildJournalNotice: () => '',
  buildArtifactNotice: () => '',
  buildSystemPrompt: () => 'SYSTEM PROMPT',
  buildPromptWithInstructions: () => 'FULL PROMPT',
  buildTurnHistoryContext: () => '',
  resolveNotesCutoff: () => ({ newNotes: [], deliveredThrough: null }),
  selectNotesForDelivery: () => ({ newNotes: [], deliveredThrough: null }),
  getNewJournalSince: () => [],
}));

await mockModule(resolve(import.meta.dir, '../../src/memory/index.ts'), () => ({
  buildMemorySection: async () => '',
}));

await mockModule(resolve(import.meta.dir, '../../src/task/lazy-md.ts'), () => ({
  buildLazyMdSection: async () => '',
}));

await mockModule(resolve(import.meta.dir, '../../src/protocol/index.ts'), () => ({
  protocolDir: () => '/tmp/protocol-guard-test',
  reviewProtocolDir: () => '/tmp/protocol-guard-test/review',
  acceptGateProtocolDir: () => '/tmp/protocol-guard-test/accept',
  writeCommand: (_dir: string, cmd: any) => { prompts.push(cmd.prompt); },
  writeResponse: async () => {},
  consumeCommand: async () => null,
  ensureProtocolDir: () => {},
  commonCommandFields: () => ({}),
  newCommandId: () => 'cmd-1',
  removeProtocolDir: () => {},
  consumeResponse: async () => null,
  clearStatus: async () => {},
  completedResponses: async () => [],
  readResponse: async () => null,
  inFlightResponseCorrelates: () => false,
}));

await mockModule(resolve(import.meta.dir, '../../src/capture/claude.ts'), () => ({
  reviewContainerNameForTask: () => 'review-container',
  acceptGateContainerNameForTask: () => 'accept-gate-container',
}));


const { launchUnblockTask } = await import('../../src/daemon/task-lifecycle');

afterAll(async () => {
  restoreMockedModules();
});

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function unblock(): Promise<string> {
  await launchUnblockTask('/proj', { taskId: 'task-1', message: 'carry on', actor: 'human' } as any);
  return prompts[prompts.length - 1];
}

describe('environment-replaced notice on the unblock launch', () => {
  beforeEach(() => {
    metadata.clear();
    createdTurns.length = 0;
    statusWrites.length = 0;
    prompts.length = 0;
    recreateForCredential = false;
    recreateForAgent = false;
    recreateForEnv = false;
    running = true;
    sandboxed = true;
    launchFails = false;
  });

  for (const [name, set, reason] of [
    ['credential change', () => { recreateForCredential = true; }, REASON_CREDENTIAL_CHANGED],
    ['agent change', () => { recreateForAgent = true; }, REASON_AGENT_CHANGED],
    // `lazy env set` while the container was alive: the recreate that delivers
    // the new value takes the old container's installs with it, so it is told.
    ['task env change', () => { recreateForEnv = true; }, REASON_TASK_ENV_CHANGED],
  ] as const) {
    test(`${name}: the recreating launch carries the line once, the next does not`, async () => {
      set();
      const first = await unblock();
      expect(count(first, environmentReplacedLine(reason))).toBe(1);
      expect(first.startsWith(environmentReplacedLine(reason))).toBe(true);

      recreateForCredential = false;
      recreateForAgent = false;
      recreateForEnv = false;
      const second = await unblock();
      expect(count(second, 'Your environment was replaced')).toBe(0);
    });
  }

  test('a failed launch keeps the fact for the next turn', async () => {
    recreateForAgent = true;
    launchFails = true;
    await expect(unblock()).rejects.toThrow('Failed to launch supervisor');
    expect(metadata.get(`task-1:${ENVIRONMENT_REPLACED_KEY}`)).toBe(REASON_AGENT_CHANGED);

    recreateForAgent = false;
    launchFails = false;
    running = false;
    expect(count(await unblock(), environmentReplacedLine(REASON_AGENT_CHANGED))).toBe(1);
  });

  test('a container that was not running is not reported replaced', async () => {
    recreateForCredential = true;
    running = false;
    expect(count(await unblock(), 'Your environment was replaced')).toBe(0);
  });

  test('a host-process run is never reported replaced', async () => {
    recreateForAgent = true;
    sandboxed = false;
    expect(count(await unblock(), 'Your environment was replaced')).toBe(0);
  });
});
