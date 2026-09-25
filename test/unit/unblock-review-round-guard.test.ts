/**
 * Unit tests for the auto-review round-cap guard on the unblock path
 * (final-turn design §8.1/§8.2).
 *
 * INVARIANT: only a non-system actor resets the auto-review round counter.
 * The daemon's own auto-fix turn unblocks as actor `system`, so a reset
 * there would let it launder its own cap and review forever (§8.1) — the
 * counter must survive the daemon's own unblock untouched. A human unblock
 * starts a fresh cycle, and so does an agent's — for a loop's child the
 * loop is "the human" (§8.2): the loop hands a capped child back by
 * unblocking it over MCP with actor `agent`, which must start a fresh
 * round under the loop's judgement. (For actor `human` the auto-react
 * reset also clears the counter — both reset sites must keep holding.)
 *
 * Drives the REAL `launchUnblockTask` orchestration over an in-memory
 * storage, with the supervisor/protocol/config seams mocked out
 * (test/unit/accept-concurrent-race.test.ts is the established pattern);
 * the round-counter primitives in src/daemon/auto-react-budget run for
 * real against that storage, so the pin is on the GUARD's condition, not
 * on the counter primitives (pinned by test/unit/final-review-round.test.ts).
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
import { FINAL_REVIEW_ROUND_KEY, getFinalReviewRound } from '../../src/daemon/auto-react-budget';

// --- Shared, mutable scenario state (reset per test) ---
const metadata = new Map<string, string>();
const createdTurns: any[] = [];
const statusWrites: string[] = [];

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
  prepareTurnLaunch: async () => ({ mustRecreateContainer: false }),
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
    usesSandbox: () => false,
    isRunning: async () => false,
    launchSupervisor: async () => {},
  }),
}));

await mockModule(resolve(import.meta.dir, '../../src/runner/session-launch.ts'), () => ({
  stampSessionRunner: async () => {},
  removeTaskRun: async () => {},
  mustRecreateForContainerAgent: () => false,
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
  writeCommand: async () => {},
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

describe('the auto-review round-cap guard on unblock (final-turn §8.1/§8.2)', () => {
  beforeEach(() => {
    metadata.clear();
    createdTurns.length = 0;
    statusWrites.length = 0;
    loopParentId = null;
  });

  test('the daemon\u2019s own unblock (actor system) does NOT reset the counter', async () => {
    // Seed at the cap: the auto-fix turn of round 2 is what unblocks here.
    metadata.set('task-1:final_review_round', '2');

    await launchUnblockTask('/proj', {
      taskId: 'task-1',
      message: 'carry on',
      actor: 'system',
    } as any);

    // The feedback turn launched — the run went PAST the guard, so a stale
    // assertion is not hiding an early exit.
    expect(createdTurns.length).toBeGreaterThan(0);
    expect(statusWrites).toContain('working');

    // INVARIANT (final-turn §8.1): only a non-system actor resets the
    // auto-review round counter. The daemon's own auto-fix unblocks as
    // 'system', so a reset there would let it launder its own cap and
    // review forever.
    expect(await getFinalReviewRound({ getTaskMetadata: async (id: string, key: string) => metadata.get(`${id}:${key}`) ?? null } as any, 'task-1')).toBe(2);
    expect(metadata.get('task-1:final_review_round')).toBe(FINAL_REVIEW_ROUND_KEY === 'final_review_round' ? '2' : metadata.get('task-1:final_review_round'));
  });

  test('a human unblock resets the counter (fresh cycle)', async () => {
    metadata.set('task-1:final_review_round', '2');

    await launchUnblockTask('/proj', {
      taskId: 'task-1',
      message: 'taking over',
      actor: 'human',
    } as any);

    expect(createdTurns.length).toBeGreaterThan(0);
    expect(await getFinalReviewRound({ getTaskMetadata: async (id: string, key: string) => metadata.get(`${id}:${key}`) ?? null } as any, 'task-1')).toBe(0);
  });

  test('an agent unblock resets the counter too — the loop is "the human" for its child (§8.2)', async () => {
    metadata.set('task-1:final_review_round', '2');

    await launchUnblockTask('/proj', {
      taskId: 'task-1',
      message: 'loop hands the capped child back',
      actor: 'agent',
    } as any);

    expect(createdTurns.length).toBeGreaterThan(0);
    // INVARIANT (final-turn §8.2): a loop's MCP hand-back unblocks its
    // capped child with actor 'agent' — that must start a fresh round
    // under the loop's judgement, exactly like a human taking over.
    expect(await getFinalReviewRound({ getTaskMetadata: async (id: string, key: string) => metadata.get(`${id}:${key}`) ?? null } as any, 'task-1')).toBe(0);
  });
});
describe('the loop fix-round budget on unblock (§9.1)', () => {
  beforeEach(() => {
    metadata.clear();
    createdTurns.length = 0;
    statusWrites.length = 0;
    loopParentId = 'loop-1';
  });

  afterEach(() => {
    loopParentId = null;
  });

  // INVARIANT: a LOOP that has spent its budget on one child is refused, and the
  // refusal names what to do instead. Without a mechanical bound, one child that
  // keeps not-quite-passing review absorbs full agent turns indefinitely with
  // nobody watching — the engineer's reason for the key existing at all.
  test('an agent unblock at the budget is refused before anything is written', async () => {
    metadata.set('task-1:loop_fix_round', '3');

    let message = '';
    try {
      await launchUnblockTask('/proj', {
        taskId: 'task-1',
        message: 'one more round',
        actor: 'agent',
      } as any);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('max_child_fix_rounds = 3');
    expect(message).toContain('lazy_accept');
    expect(message).toContain('lazy_close');
    // Refused BEFORE the turn: no feedback turn, no status write, and the
    // counter is untouched, so a rejected unblock never burns a round.
    expect(createdTurns).toHaveLength(0);
    expect(statusWrites).not.toContain('working');
    expect(metadata.get('task-1:loop_fix_round')).toBe('3');
  });

  test('an agent unblock under the budget launches and spends one round', async () => {
    metadata.set('task-1:loop_fix_round', '1');

    await launchUnblockTask('/proj', {
      taskId: 'task-1',
      message: 'fix the findings',
      actor: 'agent',
    } as any);

    expect(createdTurns.length).toBeGreaterThan(0);
    expect(metadata.get('task-1:loop_fix_round')).toBe('2');
  });

  // INVARIANT: a HUMAN unblock is never refused, at any count, and it starts a
  // fresh budget. It carries feedback somebody has already typed, and refusing
  // it would discard that (CLAUDE.md, "Never Lose Human Feedback").
  test('a human unblock at the budget is allowed and resets it', async () => {
    metadata.set('task-1:loop_fix_round', '99');

    await launchUnblockTask('/proj', {
      taskId: 'task-1',
      message: 'taking this one over',
      actor: 'human',
    } as any);

    expect(createdTurns.length).toBeGreaterThan(0);
    expect(metadata.get('task-1:loop_fix_round')).toBe('');
  });

  // INVARIANT: the daemon's own turns are exempt, exactly as they are from
  // `assertLoopHasNoRunningChild`. A bound on the LOOP's judgement must not
  // strand an auto-resume, a sync or a review auto-fix the daemon started.
  test('the daemon’s own unblock at the budget is neither refused nor counted', async () => {
    metadata.set('task-1:loop_fix_round', '99');

    await launchUnblockTask('/proj', {
      taskId: 'task-1',
      message: 'auto-fix after review',
      actor: 'system',
    } as any);

    expect(createdTurns.length).toBeGreaterThan(0);
    expect(metadata.get('task-1:loop_fix_round')).toBe('99');
  });
});
