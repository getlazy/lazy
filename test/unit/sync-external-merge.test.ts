/**
 * Unit tests for external merge detection in sync.ts.
 *
 * Tests the key invariant: when a blocked/conflict task's PR is merged externally,
 * the status must transition through merging state before reaching complete
 * (blocked → merging → complete, never blocked → complete directly).
 */

import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/utils/role-target';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { resolve } from 'path';

// Track calls to storage.updateTaskStatus to verify transition sequence
let statusTransitions: Array<{ taskId: string; status: string; actor: string }> = [];
let mockPRState: 'OPEN' | 'MERGED' | 'CLOSED' | null = null;
let mockTask: any = null;
let mockLinkedTask: any = null;
let mockSession: any = null;
let mockSessionCommits: any[] = [];
let mockSessionTurns: any[] = [];
let metadataWrites: Array<{ taskId: string; key: string; value: string }> = [];
// Driver-call recording for the no-comment-posting invariant below. The Proxy
// records every method NAME the sync pass touches on the driver mock.
let driverMethodCalls: string[] = [];
let updateRemoteBodyBodies: string[] = [];
// Set to simulate a forge outage: updateRemoteBody rejects with this message.
let updateRemoteBodyError: string | null = null;
// Set to make synthesis fail for ONE task (see getChildTasks in the storage mock).
let failSynthesisForTaskId: string | null = null;
let gatherEventsAttempts = 0;
// What a CLOSED PR did to the task: abandoned it, or moved its children away.
let abandonedTasks: string[] = [];
let reparentedFrom: string[] = [];
// Set to make the forge report this base for the task's PR (src/daemon/review-base.ts).
let mockReviewBase: string | null = null;
let systemMessages: Array<{ title: string }> = [];

// Import real exports so the mock doesn't lose their shape for other test files
import { DEFAULT_CONFIG as REAL_DEFAULT_CONFIG, getDefaultConfigTemplate as REAL_getDefaultConfigTemplate } from '../../src/config/loader';

// Mock the config loader to return a github driver config
await mockModule(resolve(import.meta.dir, '../../src/config/loader.ts'), () => ({
  loadConfig: () => ({
    remote: {
      driver: 'github',
      git_remote: 'origin',
    },
    models: { default: 'claude-opus-4-7', roles: { builder: ANTHROPIC_DEFAULT_TARGET, agent: ANTHROPIC_DEFAULT_TARGET } },
  }),
  DEFAULT_CONFIG: REAL_DEFAULT_CONFIG,
  getDefaultConfigTemplate: REAL_getDefaultConfigTemplate,
}));

// Mock the remote module to return a controllable driver
await mockModule(resolve(import.meta.dir, '../../src/remote/index.ts'), () => ({
  detectRemote: () => null,
  createDriver: () => {
    const base = {
      hasRemoteRef: (task: any) => task.metadata?.github_pr_number !== undefined,
      recoverRemoteRef: async () => null,
      // The recorded PR merges into the task's own target (src/daemon/review-base.ts checks it).
      getReviewBase: async (t: any) => mockReviewBase ?? (t.target?.kind === 'branch' ? (t.target.branch || 'main') : null),
      getPRState: async () => mockPRState,
      getChecksStatus: async () => ({ status: 'pending', failed: [] }),
      fetchRemoteState: async () => {},
      pushBranch: async () => {},
      markReadyForReview: async () => ({ metadata: {} }),
      getTaskUrl: async () => null,
      needsSync: true,
      fidelityTurnSeqKey: () => 'github_fidelity_turn_seq',
      // Reads the task's own metadata, as the real drivers do, so a test can
      // run two sync passes and have the second one see what the first wrote
      // (the mock storage's updateTaskMetadata mirrors into task.metadata).
      getLastFidelityTurnSeq: (task: any) => Number(task.metadata?.github_fidelity_turn_seq ?? 0),
      isImportedComment: () => false,
      ciFailureSyncedKey: () => 'github_ci_failure_synced',
      getLastCIFailureSynced: () => undefined,
      getFailedCIJobs: async () => [],
      updateRemoteBody: async (_task: any, body: string) => {
        if (updateRemoteBodyError) throw new Error(updateRemoteBodyError);
        updateRemoteBodyBodies.push(body);
      },
      // The interface's posting surfaces (src/remote/driver.ts). Defined on
      // the base so the recording Proxy can see them: a mock missing a
      // real method makes the no-comment invariant blind to a sync pass
      // calling it (optional-chained or not, an absent property is never
      // recorded and never observed).
      approveForMerge: async () => null,
    };
    return new Proxy(base, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function' && typeof prop === 'string') {
          driverMethodCalls.push(prop);
        }
        return value;
      },
    });
  },
}));

// Mock the orphan reparenting function
await mockModule(resolve(import.meta.dir, '../../src/task/orphan.ts'), () => ({
  reparentChildren: async (task: any) => { reparentedFrom.push(task.id); return []; },
  formatReparentWarning: () => '',
}));

// Mock the shared cleanup functions
await mockModule(resolve(import.meta.dir, '../../src/task/sync-remote.ts'), () => ({
  syncTaskFromRemote: async () => {},
}));
await mockModule(resolve(import.meta.dir, '../../src/task/cleanup.ts'), () => ({
  cleanupWorktreeAndBranch: async () => {},
  cleanupTaskContainer: async () => {},
}));

// Mock the lock utilities
await mockModule(resolve(import.meta.dir, '../../src/utils/lock.ts'), () => ({
  removeLock: () => {},
}));

// Mock the protocol utilities
await mockModule(resolve(import.meta.dir, '../../src/protocol/index.ts'), () => ({
  protocolDir: () => '/tmp/protocol',
  removeProtocolDir: () => {},
}));

// Import after mocking
const { runSync, clearPendingFidelity } = await import('../../src/daemon/remote-sync');
const { withTaskLifecycleLock } = await import('../../src/daemon/task-lifecycle-lock');

// Mock storage
function createMockStorage() {
  return {
    listTasks: async () => [mockTask, mockLinkedTask].filter((t) => t !== null),
    // The forge-merge completion re-reads the task under its lifecycle lock.
    getTask: async (id: string) => [mockTask, mockLinkedTask].find((t) => t?.id === id) ?? null,
    getSessionByTaskId: async () => mockSession,
    getSessionCommits: async () => mockSessionCommits,
    endSession: async () => {},
    updateTaskStatus: async (taskId: string, status: string, actor: string) => {
      statusTransitions.push({ taskId, status, actor });
    },
    createComment: async () => {},
    abandonTask: async (taskId: string) => { abandonedTasks.push(taskId); },
    createSystemMessage: async (msg: { title: string }) => { systemMessages.push(msg); },
    updateTaskMetadata: async (taskId: string, key: string, value: string) => {
      metadataWrites.push({ taskId, key, value });
      // Mirror into the task object so a later read (e.g. the driver's
      // getLastFidelityTurnSeq on a second sync pass) sees the write.
      for (const t of [mockTask, mockLinkedTask]) {
        if (t && t.id === taskId) t.metadata = { ...(t.metadata ?? {}), [key]: value };
      }
    },
    getTaskComments: async () => [],
    getSessionTurns: async () => mockSessionTurns,
    // gatherEvents (src/synthesis/fidelity.ts) calls this, so throwing for one
    // task id makes synthesis fail for THAT task only while others synthesize
    // normally — the shape of a task-local failure (a malformed turn record,
    // an oversized history), which no global summarizer seam can express.
    getChildTasks: async (taskId: string) => {
      if (taskId === failSynthesisForTaskId) {
        gatherEventsAttempts++;
        throw new Error('malformed turn record');
      }
      return [];
    },
    close: async () => {},
  } as any;
}

// Mock SyncLogger. Records errors so a test can assert what the sweep told the
// operator — the give-up message below is the whole point of giving up loudly.
let loggedErrors: string[] = [];
function createMockLogger() {
  return {
    phase: () => {},
    detail: () => {},
    error: (msg: string) => { loggedErrors.push(msg); },
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
    target: { kind: 'branch' as const, branch: 'main' },
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

// Counting synthesis runs is how the cost claims below are checked: the stub
// summarizer appends one line per invocation to LAZY_SUMMARIZER_STUB_LOG.
// Sync fs calls are fine here — test setup only.
const summarizerLogDir = mkdtempSync(join(tmpdir(), 'lazy-fidelity-log-'));
const summarizerLogPath = join(summarizerLogDir, 'summarize.log');

function resetSynthesisLog() {
  writeFileSync(summarizerLogPath, '');
  process.env.LAZY_SUMMARIZER_STUB_LOG = summarizerLogPath;
}

function synthesisRuns(): number {
  return readFileSync(summarizerLogPath, 'utf8').split('\n').filter(Boolean).length;
}

describe('sync external merge detection', () => {
  beforeEach(() => {
    statusTransitions = [];
    mockPRState = null;
    mockTask = null;
    mockLinkedTask = null;
    mockSession = null;
    mockSessionCommits = [];
    mockSessionTurns = [];
    metadataWrites = [];
    driverMethodCalls = [];
    updateRemoteBodyBodies = [];
    updateRemoteBodyError = null;
    failSynthesisForTaskId = null;
    gatherEventsAttempts = 0;
    abandonedTasks = [];
    reparentedFrom = [];
    mockReviewBase = null;
    systemMessages = [];
    loggedErrors = [];
    // Carried retry state is module-level and keyed by task id, which these
    // tests share: clear it so one case's failed write cannot put the next
    // case on the "retry the cached body" path.
    clearPendingFidelity();
  });

  // INVARIANT: remote-sync completes a merged task only under the task's
  // lifecycle lock. A live accept (or a daemon resume) holding it owns the
  // transition; racing it doubled the [Accepted] comment and ran follow-through
  // twice at once. Held lock → leave the task for its owner.
  test('a merged PR on a task whose accept is running is left to that accept', async () => {
    mockTask = makeTask('merging');
    mockSession = makeSession();
    mockSessionCommits = [{ sha: 'commit1' }];
    mockPRState = 'MERGED';

    await withTaskLifecycleLock(mockTask.id, async () => {
      await runSync('/tmp/test', createMockStorage(), createMockLogger());
    });

    expect(statusTransitions).toHaveLength(0);
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

  // INVARIANT (src/daemon/review-base.ts): a PR lazy opened that was merged
  // on the forge into a branch other than the task's target never completes
  // the task, and says so once — its work is not where the task integrates.
  test('a PR merged into another branch does not complete the task and files one alert', async () => {
    mockTask = makeTask('blocked');
    mockSession = makeSession();
    mockSessionCommits = [{ sha: 'commit1' }];
    mockPRState = 'MERGED';
    mockReviewBase = 'develop';

    await runSync('/tmp/test', createMockStorage(), createMockLogger());

    expect(statusTransitions).toHaveLength(0);
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].title).toContain('merged into the wrong branch');
  });

  // INVARIANT (src/daemon/review-base.ts): a LINKED task's PR (`lazy link`) is
  // someone else's, and wherever its owner merges it is theirs to decide — the
  // wrong-base guard protects PRs lazy opened and then reparented, which a
  // linked PR never is. So its merge completes the task and files no alert,
  // exactly as before the guard existed.
  test('a linked task whose PR was merged into a non-default branch still completes, with no alert', async () => {
    mockTask = makeTask('blocked');
    mockTask.metadata = {
      github_pr_number: '123',
      import_source_url: 'https://github.com/acme/widgets/pull/123',
      import_source_branch: 'feature/foreign',
    };
    mockSession = makeSession();
    mockSessionCommits = [{ sha: 'commit1' }];
    mockPRState = 'MERGED';
    mockReviewBase = 'develop';

    await runSync('/tmp/test', createMockStorage(), createMockLogger());

    expect(statusTransitions.map((t) => t.status)).toEqual(['merging', 'complete']);
    expect(systemMessages).toHaveLength(0);
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

  // INVARIANT: forge comments are for people. A sync pass posts NO comment —
  // the per-turn mirroring ("### Turn N — Agent Summary" and friends) was
  // removed as reported noise. The ONLY forge write a sync pass makes (besides
  // branch export) is the lazy-owned fidelity section of the PR/MR BODY, and
  // only when substantive work (agent work turn or genuine human feedback)
  // landed since the last pass.
  test('sync after a work turn posts no comment and refreshes the PR body exactly once', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'Implemented the feature', created_at: Date.now() },
        // Auto review turns are not work — they alone would not refresh.
        { id: 'turn-2', session_id: mockSession.id, sequence: 2, role: 'agent', turn_type: 'review', auto_triggered: true, actor: 'supervisor', content: 'Review passed', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing\n\nbody' }];
      mockPRState = 'OPEN'; // PR still open — external-merge path must stay out of the way

      const storage = createMockStorage();
      const logger = createMockLogger();

      await runSync('/tmp/test', storage, logger);

      // Exactly one forge write: the fidelity body refresh for the task's new work.
      expect(updateRemoteBodyBodies).toHaveLength(1);

      // No comment-posting surface was touched — sync never posts comments.
      const postingCalls = driverMethodCalls.filter(name => name.startsWith('post'));
      expect(postingCalls).toEqual([]);

      // The watermark advanced past EVERY unreflected turn (skipped ones too),
      // under the driver's fidelity key — not the removed posted-turn keys.
      const watermark = metadataWrites.find(w => w.key === 'github_fidelity_turn_seq');
      expect(watermark).toBeDefined();
      expect(watermark!.value).toBe('2');
    } finally {
      delete process.env.LAZY_SUMMARIZER_STUB;
    }
  });

  // INVARIANT: a linked task never writes another task's PR/MR. Its remote
  // ref points at a PR/MR adopted from someone else (`lazy link`), so the
  // fidelity sweep must skip it entirely — otherwise a worked linked task
  // rewrites the PR owner's lazy body section with the linked task's own
  // turn history, racing the owner task's refresh of the same section.
  test('a linked task is skipped by the fidelity refresh — its foreign PR body is never rewritten', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    try {
      // The PR owner task: same shape as the test above — its own refresh
      // fires, giving exactly one body write for the whole pass.
      mockTask = makeTask('blocked');
      // The linked task: a foreign PR attached via `lazy link`, with the
      // same status and (via the shared mock session) the same substantive
      // work turn — every condition the sweep would act on.
      mockLinkedTask = makeTask('blocked');
      mockLinkedTask.id = 'linked-task-id-12345678';
      mockLinkedTask.code = 'linked-task';
      mockLinkedTask.metadata = {
        github_pr_number: '456',
        import_source_url: 'https://github.com/acme/widgets/pull/456',
        import_source_branch: 'feature/foreign',
      };
      mockSession = makeSession();
      mockSessionTurns = [
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'Work on the linked PR', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      const storage = createMockStorage();
      const logger = createMockLogger();

      await runSync('/tmp/test', storage, logger);

      // The owner task's refresh happened; the linked task contributed
      // nothing — one body write total, and no watermark write for it.
      expect(updateRemoteBodyBodies).toHaveLength(1);
      expect(metadataWrites.filter(w => w.taskId === 'linked-task-id-12345678')).toEqual([]);
      expect(metadataWrites.some(w => w.taskId === 'test-task-id-12345678' && w.key === 'github_fidelity_turn_seq')).toBe(true);
    } finally {
      delete process.env.LAZY_SUMMARIZER_STUB;
    }
  });

  // INVARIANT: turns that are not WORK never refresh the body, however many of
  // them arrive. This is the substantive-turn check itself, reached only when
  // unreflected turns EXIST — the empty-turn case below exits at the earlier
  // `turns.length === 0` guard and never tests this. The check is what stops a
  // regeneration (a model call) firing per task per tick at `sync_interval`,
  // and it replaced an exported, separately unit-tested predicate
  // (`shouldPostTurnToRemote`) with an inline closure, so its three refusals —
  // a non-work turn_type, auto_triggered, and a system/supervisor actor —
  // are asserted here or nowhere. The watermark must still advance past them,
  // or every later tick re-inspects the same turns forever.
  test('sync with only non-substantive turns never refreshes the body, but still advances the watermark', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [
        // Not work: a review turn records no commits and never touches the forge.
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'review', auto_triggered: true, actor: 'supervisor', content: 'Review passed', created_at: Date.now() },
        // Not genuine human feedback: auto-triggered, so no person wrote it.
        { id: 'turn-2', session_id: mockSession.id, sequence: 2, role: 'human', turn_type: 'work', auto_triggered: true, actor: 'system', content: 'Auto-react nudge', created_at: Date.now() },
        // Not genuine human feedback: a supervisor prompt, not a person —
        // auto_triggered false, so ONLY the actor check can refuse it.
        { id: 'turn-3', session_id: mockSession.id, sequence: 3, role: 'human', turn_type: 'work', auto_triggered: false, actor: 'supervisor', content: 'Supervisor prompt', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      const storage = createMockStorage();
      const logger = createMockLogger();

      await runSync('/tmp/test', storage, logger);

      // No forge body write: none of the three turns is new work.
      expect(updateRemoteBodyBodies).toHaveLength(0);

      // ...but the watermark advanced past all of them, so the next tick does
      // not pay to inspect them again.
      const watermark = metadataWrites.find(w => w.key === 'github_fidelity_turn_seq');
      expect(watermark).toBeDefined();
      expect(watermark!.value).toBe('3');
    } finally {
      delete process.env.LAZY_SUMMARIZER_STUB;
    }
  });

  // INVARIANT: the fidelity watermark advances only after the description
  // write SUCCEEDED. regenerateFidelity never throws — a failed
  // updateRemoteBody comes back as a warning the sync pass only logs — so
  // advancing first left the watermark past turns whose work never reached the
  // PR/MR, and a brief forge outage silently froze the description until the
  // next substantive turn arrived. With the per-turn comment mirroring gone,
  // that description is all a cold reader of the PR sees, so nothing else
  // covers the gap. The retry is one attempt per task per pass — bounded by
  // the sync cadence, not a spin.
  test('a failed body write leaves the watermark put, and the next pass writes the body and advances it', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    resetSynthesisLog();
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'Implemented the feature', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      const logger = createMockLogger();

      // Pass 1 — the forge is unreachable.
      updateRemoteBodyError = 'connect ECONNREFUSED api.github.com:443';
      await runSync('/tmp/test', createMockStorage(), logger);

      // Nothing reached the PR, so nothing may be recorded as reflected.
      expect(updateRemoteBodyBodies).toHaveLength(0);
      expect(metadataWrites.filter(w => w.key === 'github_fidelity_turn_seq')).toEqual([]);

      // Pass 2 — the forge is back. The same turn is still unreflected, so it
      // is retried rather than silently skipped.
      updateRemoteBodyError = null;
      await runSync('/tmp/test', createMockStorage(), logger);

      expect(updateRemoteBodyBodies).toHaveLength(1);
      const watermark = metadataWrites.find(w => w.key === 'github_fidelity_turn_seq');
      expect(watermark).toBeDefined();
      expect(watermark!.value).toBe('1');

      // INVARIANT: the retry re-writes the body the failed pass already
      // synthesized — it does NOT synthesize again. Nothing landed between the
      // passes, so a second run would spend a model one-shot to re-derive
      // identical text. A task can sit in `blocked` for days against a
      // permanently broken remote (deleted PR, revoked token), so a per-tick
      // re-synthesis would be ~1440 one-shots/day/task; only the forge write
      // needs retrying, and that is one cheap API call.
      expect(synthesisRuns()).toBe(1);
    } finally {
      delete process.env.LAZY_SUMMARIZER_STUB;
      delete process.env.LAZY_SUMMARIZER_STUB_LOG;
    }
  });

  // INVARIANT: a write that keeps failing is REPORTED once per (task,
  // watermark), though it is RETRIED every pass. The retry is unbounded by
  // design — it is one cheap API call — but an unfixable write (deleted PR,
  // revoked token) on a task sitting in review for days would otherwise raise
  // an identical error on every tick. Before the watermark fix this was logged
  // once and the watermark moved past, so unbounded reporting would be a
  // regression in noise. A CHANGED message is news and is reported again.
  test('a write that keeps failing is retried every pass but reported once, until the message changes', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    resetSynthesisLog();
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'Implemented the feature', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      const logger = createMockLogger();

      updateRemoteBodyError = 'connect ECONNREFUSED api.github.com:443';
      await runSync('/tmp/test', createMockStorage(), logger);
      await runSync('/tmp/test', createMockStorage(), logger);
      await runSync('/tmp/test', createMockStorage(), logger);

      // Reported once across three passes...
      const refused = loggedErrors.filter(e => e.includes('ECONNREFUSED'));
      expect(refused).toHaveLength(1);
      // ...and the write itself was attempted on every one of them.
      expect(driverMethodCalls.filter(name => name === 'updateRemoteBody')).toHaveLength(3);
      // Still nothing recorded as reflected.
      expect(metadataWrites.filter(w => w.key === 'github_fidelity_turn_seq')).toEqual([]);

      // A different failure is news, so it is reported.
      updateRemoteBodyError = 'HTTP 404: Not Found (pull request deleted)';
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(loggedErrors.some(e => e.includes('404'))).toBe(true);
    } finally {
      delete process.env.LAZY_SUMMARIZER_STUB;
      delete process.env.LAZY_SUMMARIZER_STUB_LOG;
    }
  });

  // INVARIANT: the repeat check compares the failure's SIGNATURE, not the
  // formatted message. Forge errors carry detail that changes every attempt
  // while the failure does not — the resolved address in an ECONNREFUSED, a
  // request id in a 5xx — so a whole-string comparison made each tick "a
  // different failure" and re-reported it, which is exactly the recurring
  // noise the dedup exists to prevent. A different error CLASS must still be
  // reported, so status codes and the like survive normalisation.
  test('a repeat failure whose message carries a varying address or request id is reported once', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    resetSynthesisLog();
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'Implemented the feature', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      const logger = createMockLogger();

      // The same failure three times over, each naming a different resolved
      // address — what a real DNS-round-robin forge outage looks like.
      updateRemoteBodyError = 'connect ECONNREFUSED 140.82.121.4:443';
      await runSync('/tmp/test', createMockStorage(), logger);
      updateRemoteBodyError = 'connect ECONNREFUSED 140.82.113.22:443';
      await runSync('/tmp/test', createMockStorage(), logger);
      updateRemoteBodyError = 'connect ECONNREFUSED 20.26.156.215:443';
      await runSync('/tmp/test', createMockStorage(), logger);

      expect(loggedErrors.filter(e => e.includes('ECONNREFUSED'))).toHaveLength(1);
      // The write was still attempted every pass — only the reporting is deduped.
      expect(driverMethodCalls.filter(name => name === 'updateRemoteBody')).toHaveLength(3);

      // A varying request id on an otherwise identical 5xx is likewise one failure.
      updateRemoteBodyError = 'HTTP 502: Bad Gateway (request id: 9f2c1ab4d77e)';
      await runSync('/tmp/test', createMockStorage(), logger);
      updateRemoteBodyError = 'HTTP 502: Bad Gateway (request id: 31de90bb0c15)';
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(loggedErrors.filter(e => e.includes('502'))).toHaveLength(1);

      // But a different status is a different failure, and is reported.
      updateRemoteBodyError = 'HTTP 404: Not Found (request id: 77aa10cc93b2)';
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(loggedErrors.filter(e => e.includes('404'))).toHaveLength(1);
    } finally {
      delete process.env.LAZY_SUMMARIZER_STUB;
      delete process.env.LAZY_SUMMARIZER_STUB_LOG;
    }
  });

  // INVARIANT: the carried retry state holds EXACTLY the tasks whose refresh
  // failed on the most recent pass. It must be pruned against what the sweep
  // re-affirmed, NOT against storage.listTasks(), which returns every task
  // whatever its status: a task accepted after a failed write is still in that
  // list, so pruning against it would keep the task's whole description body
  // in daemon memory for the life of the process.
  test('carried state for a task the sweep no longer refreshes is dropped', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    resetSynthesisLog();
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'Implemented the feature', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      const logger = createMockLogger();

      // Pass 1: the write fails, so a body is carried for the retry.
      updateRemoteBodyError = 'connect ECONNREFUSED api.github.com:443';
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(driverMethodCalls.filter(name => name === 'updateRemoteBody')).toHaveLength(1);

      // The task is accepted: still returned by listTasks(), but no longer a
      // status the sweep refreshes. Nothing should be carried for it.
      mockTask.status = 'complete';
      await runSync('/tmp/test', createMockStorage(), logger);

      // Back to a syncable status with the forge healthy. If the entry had
      // been kept, this would take the cached-body path and never synthesize
      // again; the second synthesis run is what proves it was dropped.
      mockTask.status = 'blocked';
      updateRemoteBodyError = null;
      await runSync('/tmp/test', createMockStorage(), logger);

      expect(updateRemoteBodyBodies).toHaveLength(1);
      expect(synthesisRuns()).toBe(2);
      const watermark = metadataWrites.find(w => w.key === 'github_fidelity_turn_seq');
      expect(watermark!.value).toBe('1');
    } finally {
      delete process.env.LAZY_SUMMARIZER_STUB;
      delete process.env.LAZY_SUMMARIZER_STUB_LOG;
    }
  });

  // INVARIANT: a SYNTHESIS failure also holds the watermark — it is the other
  // way the description ends up untouched. regenerateFidelity returns no
  // warning on that path (it deliberately declines to downgrade a synthesized
  // description to a commit list), so a warning-only check would read it as
  // success and lose the work from the description exactly as the pre-fix
  // ordering did. The hold is BOUNDED, unlike the write retry above: there is
  // no body to cache, so each attempt is a fresh summarizer one-shot, and a
  // permanently unavailable summarizer (no credential, no model) must not pay
  // that on every tick forever. After the budget the sweep advances the
  // watermark and says so loudly.
  test('an unavailable summarizer trips a per-task breaker after a bounded number of attempts, and a new turn does not re-arm it', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    process.env.LAZY_SUMMARIZER_FAIL = '1';
    resetSynthesisLog();
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'Implemented the feature', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      const logger = createMockLogger();

      // Passes 1 and 2: synthesis falls back, nothing is written to the forge,
      // so the turns stay unreflected and are retried.
      await runSync('/tmp/test', createMockStorage(), logger);
      await runSync('/tmp/test', createMockStorage(), logger);

      expect(updateRemoteBodyBodies).toHaveLength(0);
      expect(metadataWrites.filter(w => w.key === 'github_fidelity_turn_seq')).toEqual([]);
      expect(synthesisRuns()).toBe(2);

      // Pass 3 spends the last attempt and trips the breaker, loudly.
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(synthesisRuns()).toBe(3);
      expect(loggedErrors.filter(e => e.includes('left stale') && e.includes('synthesis unavailable'))).toHaveLength(1);

      // Pass 4 attempts nothing at all, and does not repeat the give-up.
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(synthesisRuns()).toBe(3);
      expect(loggedErrors.filter(e => e.includes('left stale'))).toHaveLength(1);

      // INVARIANT: the budget is per TASK, not per watermark. A new substantive
      // turn arriving mid-failure must NOT re-arm it. Keying the count to the
      // watermark meant an active task paid the full budget again on every
      // turn — three one-shots each, serially inside the sweep, against a
      // summarizer that was never coming back: worse than the single attempt
      // the unbounded-but-unheld original spent. This is the case the suite
      // could not see before.
      mockSessionTurns.push({
        id: 'turn-2', session_id: mockSession.id, sequence: 2, role: 'agent', turn_type: 'work',
        auto_triggered: false, actor: 'agent', content: 'More work', created_at: Date.now(),
      });
      await runSync('/tmp/test', createMockStorage(), logger);
      await runSync('/tmp/test', createMockStorage(), logger);

      expect(synthesisRuns()).toBe(3);
      // And nothing was silently marked as reflected while it was tripped —
      // the watermark is HELD, so the work is not lost, it is waiting.
      expect(metadataWrites.filter(w => w.key === 'github_fidelity_turn_seq')).toEqual([]);
    } finally {
      delete process.env.LAZY_SUMMARIZER_STUB;
      delete process.env.LAZY_SUMMARIZER_FAIL;
      delete process.env.LAZY_SUMMARIZER_STUB_LOG;
    }
  });

  // INVARIANT: a cached body is only ever written against the watermark it was
  // synthesized for. Carried retry state must never be rebound to a newer
  // watermark: a body covering turn 1, written and then recorded as covering
  // turn 2, loses turn 2's work from the description permanently while the
  // store says it is reflected — the exact false record this task exists to
  // eliminate, reached through the retry machinery itself. The fields are
  // nested under `forSeq` so the rebind is not expressible.
  test('a body cached for an older watermark is never written against a newer one', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    resetSynthesisLog();
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'FIRST-TURN-WORK', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      const logger = createMockLogger();

      // Pass 1: synthesis succeeds for turn 1 and the forge write fails, so
      // that body (B1) is cached against watermark 1. The stub echoes the turn
      // bundle, so B1 mentions turn 1 and cannot mention turn 2.
      updateRemoteBodyError = 'connect ECONNREFUSED api.github.com:443';
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(synthesisRuns()).toBe(1);

      // Turn 2 lands. B1 no longer describes the task.
      mockSessionTurns.push({
        id: 'turn-2', session_id: mockSession.id, sequence: 2, role: 'agent', turn_type: 'work',
        auto_triggered: false, actor: 'agent', content: 'SECOND-TURN-WORK', created_at: Date.now(),
      });

      // Pass 2: the watermark moved, so the cache misses and a fresh synthesis
      // is attempted — and the summarizer is down. This is the pass that used
      // to relabel B1 as covering watermark 2.
      process.env.LAZY_SUMMARIZER_FAIL = '1';
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(updateRemoteBodyBodies).toHaveLength(0);
      expect(metadataWrites.filter(w => w.key === 'github_fidelity_turn_seq')).toEqual([]);

      // Pass 3: everything recovers. The old code took the cached-body path
      // here and wrote B1 — a description covering turn 1 — then advanced the
      // watermark to 2, losing turn 2 for good.
      delete process.env.LAZY_SUMMARIZER_FAIL;
      updateRemoteBodyError = null;
      await runSync('/tmp/test', createMockStorage(), logger);

      expect(updateRemoteBodyBodies).toHaveLength(1);
      const written = updateRemoteBodyBodies[0];
      expect(written).toContain('SECOND-TURN-WORK');
      expect(written).toContain('FIRST-TURN-WORK');

      // Independent witness, so this cannot pass for the wrong reason: pass 3
      // had to SYNTHESIZE (three runs: one per pass, the stub logs its failed
      // attempt too). Taking the cached-body path there — which is what the
      // rebind enabled — would leave this at two.
      expect(synthesisRuns()).toBe(3);

      // ...and only now does the watermark reach 2, because only now does a
      // body covering turn 2 exist on the forge.
      const watermarks = metadataWrites.filter(w => w.key === 'github_fidelity_turn_seq');
      expect(watermarks).toHaveLength(1);
      expect(watermarks[0].value).toBe('2');
    } finally {
      delete process.env.LAZY_SUMMARIZER_STUB;
      delete process.env.LAZY_SUMMARIZER_FAIL;
      delete process.env.LAZY_SUMMARIZER_STUB_LOG;
    }
  });

  // INVARIANT: a failure that is the TASK's own does not get re-armed by a
  // sibling's success. The process-wide success signal is evidence about
  // AVAILABILITY; it says nothing about a task whose own history breaks
  // synthesis (a malformed turn record, an oversized bundle, a prompt the
  // model rejects). Honouring it blindly meant such a task re-armed on every
  // pass in which any sibling succeeded — no bound at all on an active
  // project, and the give-up error recurring forever with the wrong cause
  // named.
  //
  // But ONE probe does not settle which it is: rate limits, timeouts and an
  // overloaded model fail some calls and succeed others, so "a sibling
  // succeeded and then we failed once" is also what an outage looks like. The
  // classification therefore requires TWO probes, each after a further
  // demonstrated success, and it EXPIRES — see the following test.
  test('a task-local synthesis failure is classified only after two probes, and then stops re-arming on sibling successes', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    resetSynthesisLog();
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'Implemented the feature', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      // A healthy sibling that synthesizes successfully on every pass, so the
      // process-wide success count moves constantly — the active-project case.
      mockLinkedTask = makeTask('blocked');
      mockLinkedTask.id = 'sibling-task-id-12345678';
      mockLinkedTask.code = 'sibling-task';
      mockLinkedTask.metadata = { github_pr_number: '789' };

      // Our task, and only our task, cannot synthesize.
      failSynthesisForTaskId = mockTask.id;

      const logger = createMockLogger();

      // The sibling only synthesizes when it has unreflected work, so give it
      // some before each pass — this is what keeps the process-wide success
      // count moving, as it does on a project where something is always
      // happening.
      let nextSeq = 2;
      const landATurn = () => {
        mockSessionTurns.push({
          id: `turn-${nextSeq}`, session_id: mockSession.id, sequence: nextSeq, role: 'agent',
          turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'More work', created_at: Date.now(),
        });
        nextSeq++;
      };

      // Three passes spend the budget and trip the breaker.
      await runSync('/tmp/test', createMockStorage(), logger);
      landATurn();
      await runSync('/tmp/test', createMockStorage(), logger);
      landATurn();
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(gatherEventsAttempts).toBe(3);
      expect(loggedErrors.filter(e => e.includes('left stale')).length).toBe(1);

      // The sibling succeeded again inside that same pass — after our task, so
      // the count had already moved by the time the breaker was consulted next.
      // The re-arm therefore buys exactly ONE more attempt on the following
      // pass. It fails while the capability is demonstrably healthy: that is
      // the FIRST probe, and on its own it is not enough to blame the task, so
      // nothing is said and the task stays merely tripped.
      landATurn();
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(gatherEventsAttempts).toBe(4);
      expect(loggedErrors.filter(e => e.includes('left stale'))).toHaveLength(1);

      // The sibling keeps succeeding, so the count moves again and buys a
      // SECOND probe. It fails too — two independent failures after two
      // demonstrated successes — and only now is the cause called, as a
      // likelihood.
      landATurn();
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(gatherEventsAttempts).toBe(5);

      // From here the sibling's successes are no longer evidence about this
      // task: no further attempts, however many passes run and however much
      // the success count moves (within the retry horizon — the next test
      // covers crossing it).
      landATurn();
      await runSync('/tmp/test', createMockStorage(), logger);
      landATurn();
      await runSync('/tmp/test', createMockStorage(), logger);
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(gatherEventsAttempts).toBe(5);

      // Exactly two lines ever for this task: the first give-up, then the one
      // that corrects the likely cause. No recurrence.
      const stale = loggedErrors.filter(e => e.includes('left stale'));
      expect(stale).toHaveLength(2);
      expect(stale[1]).toContain('PROBABLY specific to this task');
      // INVARIANT: the message is a likelihood, not a determination, and it
      // says how the task gets retried. A flat "the cause is specific to this
      // task" plus "no further attempts will be made" was both overclaimed and
      // a dead end.
      expect(stale[1]).not.toContain('No further attempts');
      expect(stale[1]).toContain('retried automatically');

      // Nothing was ever recorded as reflected for it.
      expect(metadataWrites.filter(w => w.taskId === mockTask.id && w.key === 'github_fidelity_turn_seq')).toEqual([]);
    } finally {
      delete process.env.LAZY_SUMMARIZER_STUB;
      delete process.env.LAZY_SUMMARIZER_STUB_LOG;
    }
  });

  // INVARIANT: the task-local classification is a LIKELIHOOD with a way back,
  // not a life-of-the-process verdict. The cause it names can be fixed with
  // nothing in the daemon to notice (a turn record repaired, history trimmed,
  // the summarizer's model changed), and the evidence behind it — two failures
  // after two demonstrated successes — is not proof. So after a further
  // TASK_LOCAL_RETRY_AFTER_SUCCESSES successes elsewhere the task probes once
  // more, and a task whose cause has gone catches up.
  test('a task classified as task-local is retried after enough further successes elsewhere', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    resetSynthesisLog();
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'Implemented the feature', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      mockLinkedTask = makeTask('blocked');
      mockLinkedTask.id = 'sibling-task-id-12345678';
      mockLinkedTask.code = 'sibling-task';
      mockLinkedTask.metadata = { github_pr_number: '789' };

      failSynthesisForTaskId = mockTask.id;
      const logger = createMockLogger();

      let nextSeq = 2;
      const landATurn = () => {
        mockSessionTurns.push({
          id: `turn-${nextSeq}`, session_id: mockSession.id, sequence: nextSeq, role: 'agent',
          turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'More work', created_at: Date.now(),
        });
        nextSeq++;
      };

      // Budget (3) + two probes (5) gets it classified, exactly as above.
      for (let i = 0; i < 5; i++) {
        await runSync('/tmp/test', createMockStorage(), logger);
        landATurn();
      }
      expect(gatherEventsAttempts).toBe(5);
      expect(loggedErrors.filter(e => e.includes('left stale'))).toHaveLength(2);

      // The task-local cause is fixed. The daemon has no way to know, and
      // within the retry horizon it keeps its hands off: the sibling is
      // succeeding every pass, and none of that buys an attempt.
      failSynthesisForTaskId = null;
      for (let i = 0; i < 5; i++) {
        await runSync('/tmp/test', createMockStorage(), logger);
        landATurn();
      }
      expect(metadataWrites.filter(w => w.taskId === mockTask.id && w.key === 'github_fidelity_turn_seq')).toEqual([]);

      // Past the horizon (25 further sibling successes) it probes again — and
      // this time it works, so the description catches up covering everything
      // that landed while it was written off, and no further line is raised.
      for (let i = 0; i < 25; i++) {
        await runSync('/tmp/test', createMockStorage(), logger);
        landATurn();
      }
      const watermark = metadataWrites.filter(w => w.taskId === mockTask.id && w.key === 'github_fidelity_turn_seq');
      expect(watermark.length).toBeGreaterThan(0);
      expect(loggedErrors.filter(e => e.includes('left stale'))).toHaveLength(2);
    } finally {
      failSynthesisForTaskId = null;
      delete process.env.LAZY_SUMMARIZER_STUB;
      delete process.env.LAZY_SUMMARIZER_STUB_LOG;
    }
  });

  // INVARIANT: the expiring classification is a RATE LIMIT, not an open gate.
  // It replaced a permanent stop, so the bound it puts in its place is the
  // load-bearing half: a task that stays broken costs ONE one-shot per
  // TASK_LOCAL_RETRY_AFTER_SUCCESSES successes elsewhere, because each failed
  // probe pushes the horizon out again from the CURRENT count. Holding the
  // horizon fixed instead — or comparing against it the wrong way round —
  // would have such a task probing on every pass forever, which is exactly the
  // unbounded cost the classification exists to prevent and which no other
  // case here would catch.
  test('a task that stays broken past the horizon probes once, not once per pass', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    resetSynthesisLog();
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'Implemented the feature', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      mockLinkedTask = makeTask('blocked');
      mockLinkedTask.id = 'sibling-task-id-12345678';
      mockLinkedTask.code = 'sibling-task';
      mockLinkedTask.metadata = { github_pr_number: '789' };

      // The cause never goes away, unlike in the test above.
      failSynthesisForTaskId = mockTask.id;
      const logger = createMockLogger();

      let nextSeq = 2;
      const landATurn = () => {
        mockSessionTurns.push({
          id: `turn-${nextSeq}`, session_id: mockSession.id, sequence: nextSeq, role: 'agent',
          turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'More work', created_at: Date.now(),
        });
        nextSeq++;
      };

      // Budget (3) + two probes (5) gets it classified.
      for (let i = 0; i < 5; i++) {
        await runSync('/tmp/test', createMockStorage(), logger);
        landATurn();
      }
      expect(gatherEventsAttempts).toBe(5);

      // Thirty more passes, each one a sibling success — comfortably past the
      // 25-success horizon, and comfortably short of a second one. Exactly ONE
      // further attempt is spent: the probe at the horizon, which fails and
      // pushes the next one out by another 25.
      for (let i = 0; i < 30; i++) {
        await runSync('/tmp/test', createMockStorage(), logger);
        landATurn();
      }
      expect(gatherEventsAttempts).toBe(6);

      // And that failed probe says nothing new: still the two lines from
      // before, the give-up and the one correcting the likely cause.
      expect(loggedErrors.filter(e => e.includes('left stale'))).toHaveLength(2);
      expect(metadataWrites.filter(w => w.taskId === mockTask.id && w.key === 'github_fidelity_turn_seq')).toEqual([]);
    } finally {
      failSynthesisForTaskId = null;
      delete process.env.LAZY_SUMMARIZER_STUB;
      delete process.env.LAZY_SUMMARIZER_STUB_LOG;
    }
  });

  // INVARIANT: the breaker re-arms on evidence, not on a timer and not on a
  // probe call of its own. Summarizer availability is process-wide — one
  // builder target, one credential — so ONE synthesis succeeding anywhere (another
  // task's refresh, or an accept, which also regenerates fidelity) proves the
  // capability is back for everyone. The held watermark then pays off: the
  // catch-up covers every turn that landed while it was tripped.
  test('a tripped task resumes once synthesis succeeds anywhere, covering everything since', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    process.env.LAZY_SUMMARIZER_FAIL = '1';
    resetSynthesisLog();
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'Implemented the feature', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      const logger = createMockLogger();

      // Trip it.
      await runSync('/tmp/test', createMockStorage(), logger);
      await runSync('/tmp/test', createMockStorage(), logger);
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(synthesisRuns()).toBe(3);

      // A second turn lands while the task is tripped, and the summarizer comes
      // back. The tripped task still attempts nothing on its own...
      mockSessionTurns.push({
        id: 'turn-2', session_id: mockSession.id, sequence: 2, role: 'agent', turn_type: 'work',
        auto_triggered: false, actor: 'agent', content: 'More work', created_at: Date.now(),
      });
      delete process.env.LAZY_SUMMARIZER_FAIL;
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(synthesisRuns()).toBe(3);
      expect(updateRemoteBodyBodies).toHaveLength(0);

      // ...until a second, healthy task synthesizes successfully in the same
      // sweep. (A plain second task, NOT a linked one — no import markers.)
      mockLinkedTask = makeTask('blocked');
      mockLinkedTask.id = 'second-task-id-12345678';
      mockLinkedTask.code = 'second-task';
      mockLinkedTask.metadata = { github_pr_number: '789' };
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(synthesisRuns()).toBe(4);

      // The next pass sees the success count has moved and resumes, catching up
      // on BOTH turns at once — nothing was lost while it was tripped.
      await runSync('/tmp/test', createMockStorage(), logger);
      const watermark = metadataWrites.filter(w => w.taskId === 'test-task-id-12345678' && w.key === 'github_fidelity_turn_seq');
      expect(watermark).toHaveLength(1);
      expect(watermark[0].value).toBe('2');
    } finally {
      delete process.env.LAZY_SUMMARIZER_STUB;
      delete process.env.LAZY_SUMMARIZER_FAIL;
      delete process.env.LAZY_SUMMARIZER_STUB_LOG;
    }
  });

  // INVARIANT: without NEW substantive work the body is never rewritten — the
  // watermark is what keeps the per-tick sync pass from paying for a
  // regeneration (a model call) on every task on every tick.
  test('sync with no new work does not touch the PR body', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      const storage = createMockStorage();
      const logger = createMockLogger();

      await runSync('/tmp/test', storage, logger);

      expect(updateRemoteBodyBodies).toHaveLength(0);
    } finally {
      delete process.env.LAZY_SUMMARIZER_STUB;
    }
  });

  // INVARIANT: the breaker has a re-arm that depends on NOTHING outside the
  // task. Watching the process-wide success count is free, but in the
  // commonest failure — an expired credential, no model configured, a provider
  // outage — synthesis fails for every task alike, so once they have all spent
  // their budget there is nobody left who can succeed and the count can never
  // move again. Every description would then stay frozen for the life of the
  // daemon process, and fixing the credential would change nothing because
  // nothing ever attempts one to notice. So a tripped task probes once every
  // FIDELITY_SYNTHESIS_PROBE_EVERY_PASSES passes — bounded, and enough to
  // recover.
  test('a summarizer down for every task still re-arms, by probing every N passes', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    process.env.LAZY_SUMMARIZER_FAIL = '1';
    resetSynthesisLog();
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'Implemented the feature', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      const logger = createMockLogger();

      // Three passes spend the budget and trip the breaker. Nothing else is
      // running, so no success can ever re-arm it.
      for (let i = 0; i < 3; i++) await runSync('/tmp/test', createMockStorage(), logger);
      expect(synthesisRuns()).toBe(3);
      expect(loggedErrors.filter(e => e.includes('left stale'))).toHaveLength(1);

      // Nineteen skipped passes cost nothing at all...
      for (let i = 0; i < 19; i++) await runSync('/tmp/test', createMockStorage(), logger);
      expect(synthesisRuns()).toBe(3);

      // ...and the twentieth probes. It fails — the summarizer is still down —
      // so the task re-trips and the operator is NOT told again: the give-up
      // line already stands and already says this is retried.
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(synthesisRuns()).toBe(4);
      expect(loggedErrors.filter(e => e.includes('left stale'))).toHaveLength(1);

      // The credential is fixed. Nothing signals that; the next probe is what
      // finds out, and the description then catches up covering everything
      // that landed while it was frozen.
      delete process.env.LAZY_SUMMARIZER_FAIL;
      for (let i = 0; i < 19; i++) await runSync('/tmp/test', createMockStorage(), logger);
      expect(synthesisRuns()).toBe(4);
      expect(updateRemoteBodyBodies).toHaveLength(0);

      await runSync('/tmp/test', createMockStorage(), logger);
      expect(synthesisRuns()).toBe(5);
      expect(updateRemoteBodyBodies).toHaveLength(1);
      const watermark = metadataWrites.filter(w => w.taskId === mockTask.id && w.key === 'github_fidelity_turn_seq');
      expect(watermark).toHaveLength(1);
      expect(watermark[0].value).toBe('1');
    } finally {
      delete process.env.LAZY_SUMMARIZER_STUB;
      delete process.env.LAZY_SUMMARIZER_FAIL;
      delete process.env.LAZY_SUMMARIZER_STUB_LOG;
    }
  });

  // INVARIANT: a failure on a PERIODIC probe is not evidence about the task.
  // The task-local classification is earned only by failures that followed a
  // demonstrated success elsewhere — a probe fires precisely because nothing
  // has demonstrated anything, so counting it would let a global outage
  // classify every task in the sweep as broken in itself and point the
  // operator at their turn records instead of their credential.
  test('a failed periodic probe does not count towards the task-local classification', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    resetSynthesisLog();
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'Implemented the feature', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      mockLinkedTask = makeTask('blocked');
      mockLinkedTask.id = 'sibling-task-id-12345678';
      mockLinkedTask.code = 'sibling-task';
      mockLinkedTask.metadata = { github_pr_number: '789' };

      failSynthesisForTaskId = mockTask.id;
      const logger = createMockLogger();

      let nextSeq = 2;
      const landATurn = () => {
        mockSessionTurns.push({
          id: `turn-${nextSeq}`, session_id: mockSession.id, sequence: nextSeq, role: 'agent',
          turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'More work', created_at: Date.now(),
        });
        nextSeq++;
      };

      // Three passes spend the budget. The sibling succeeds inside pass 3
      // (after our task), which buys the FIRST task-local probe on pass 4 —
      // and from there the sibling goes quiet, with no new work of its own, so
      // nothing more can re-arm by the count.
      for (let i = 0; i < 3; i++) {
        await runSync('/tmp/test', createMockStorage(), logger);
        // No turn after the last pass: the sibling must have nothing left to
        // synthesize from pass 4 on, or its success would re-arm by the count
        // and this test would never reach a periodic probe.
        if (i < 2) landATurn();
      }
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(gatherEventsAttempts).toBe(4);
      expect(loggedErrors.filter(e => e.includes('PROBABLY specific to this task'))).toHaveLength(0);

      // With the sibling quiet, nothing re-arms by the count. Twenty passes
      // later the PERIODIC probe fires and fails. That must not be read as a
      // second probe — the capability demonstrated nothing in between.
      for (let i = 0; i < 20; i++) await runSync('/tmp/test', createMockStorage(), logger);
      expect(gatherEventsAttempts).toBe(5);
      expect(loggedErrors.filter(e => e.includes('PROBABLY specific to this task'))).toHaveLength(0);

      // A real second probe — one that follows a further demonstrated success
      // — is what earns the classification. The sibling lands work and
      // succeeds on the next pass; ours probes on the one after.
      landATurn();
      await runSync('/tmp/test', createMockStorage(), logger);
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(gatherEventsAttempts).toBe(6);
      expect(loggedErrors.filter(e => e.includes('PROBABLY specific to this task'))).toHaveLength(1);
    } finally {
      failSynthesisForTaskId = null;
      delete process.env.LAZY_SUMMARIZER_STUB;
      delete process.env.LAZY_SUMMARIZER_STUB_LOG;
    }
  });

  // INVARIANT: the periodic probe reaches a task that has ALREADY been called
  // task-local, and a failed probe leaves that classification exactly as it
  // found it. Both are load-bearing and they pull in opposite directions:
  //
  //  - reaching it at all is what stops the classification being a dead end in
  //    the one case its own horizon cannot escape. That horizon is counted in
  //    SUCCESSES ELSEWHERE, so if the summarizer then goes down for everyone
  //    there is nobody left to move it and the task waits for a count that can
  //    never arrive — the same trap as the breaker itself, one level down.
  //  - leaving the verdict alone is what keeps the probe cheap. A probe that
  //    cleared the latch would hand the task back to the sibling-success
  //    re-arm, which on an active project means an attempt every pass: the
  //    unbounded cost the classification exists to prevent.
  test('a task-local classification still probes, and survives a failed probe, with the summarizer down for everyone', async () => {
    process.env.LAZY_SUMMARIZER_STUB = '1';
    resetSynthesisLog();
    try {
      mockTask = makeTask('blocked');
      mockSession = makeSession();
      mockSessionTurns = [
        { id: 'turn-1', session_id: mockSession.id, sequence: 1, role: 'agent', turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'Implemented the feature', created_at: Date.now() },
      ];
      mockSessionCommits = [{ sha: 'commit1', message: 'Do the thing' }];
      mockPRState = 'OPEN';

      mockLinkedTask = makeTask('blocked');
      mockLinkedTask.id = 'sibling-task-id-12345678';
      mockLinkedTask.code = 'sibling-task';
      mockLinkedTask.metadata = { github_pr_number: '789' };

      failSynthesisForTaskId = mockTask.id;
      const logger = createMockLogger();

      let nextSeq = 2;
      const landATurn = () => {
        mockSessionTurns.push({
          id: `turn-${nextSeq}`, session_id: mockSession.id, sequence: nextSeq, role: 'agent',
          turn_type: 'work', auto_triggered: false, actor: 'agent', content: 'More work', created_at: Date.now(),
        });
        nextSeq++;
      };

      // Passes 1-5 get the task classified the ordinary way: three budgeted
      // attempts, then two probes each bought by a sibling success. Turns stop
      // landing after pass 3, so the sibling's last one is consumed in pass 4
      // and the process-wide count is FROZEN from the classification onwards —
      // the summarizer is now effectively down for everyone, which is the
      // situation this test is about.
      for (let i = 0; i < 5; i++) {
        await runSync('/tmp/test', createMockStorage(), logger);
        if (i < 3) landATurn();
      }
      expect(gatherEventsAttempts).toBe(5);
      const staleAfterClassification = loggedErrors.filter(e => e.includes('left stale'));
      expect(staleAfterClassification).toHaveLength(2);
      expect(staleAfterClassification[1]).toContain('PROBABLY specific to this task');

      // Nineteen passes buy nothing: the horizon is counted in successes
      // elsewhere and there are none to come.
      for (let i = 0; i < 19; i++) await runSync('/tmp/test', createMockStorage(), logger);
      expect(gatherEventsAttempts).toBe(5);

      // The twentieth probes anyway — the escape the horizon alone cannot
      // provide — and fails, silently: a summarizer that is still down is not
      // news, and the two lines already on the record stand.
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(gatherEventsAttempts).toBe(6);
      expect(loggedErrors.filter(e => e.includes('left stale'))).toHaveLength(2);

      // And the classification survived it. If the failed probe had dropped
      // `taskLocalRetryAt`, this single sibling success — nowhere near the
      // 25-success horizon — would immediately buy another attempt on the pass
      // after it, which is precisely the per-pass cost the latch prevents.
      landATurn();
      await runSync('/tmp/test', createMockStorage(), logger);
      await runSync('/tmp/test', createMockStorage(), logger);
      expect(gatherEventsAttempts).toBe(6);

      // Nothing was ever recorded as reflected for it.
      expect(metadataWrites.filter(w => w.taskId === mockTask.id && w.key === 'github_fidelity_turn_seq')).toEqual([]);
    } finally {
      failSynthesisForTaskId = null;
      delete process.env.LAZY_SUMMARIZER_STUB;
      delete process.env.LAZY_SUMMARIZER_STUB_LOG;
    }
  });
});

afterAll(() => {
  restoreMockedModules();
  rmSync(summarizerLogDir, { recursive: true, force: true });
});

describe('a CLOSED PR: lazy\'s own close vs somebody else\'s', () => {
  beforeEach(() => {
    statusTransitions = [];
    metadataWrites = [];
    abandonedTasks = [];
    reparentedFrom = [];
    mockLinkedTask = null;
    mockSession = makeSession();
    mockSessionCommits = [];
    mockSessionTurns = [];
    mockPRState = 'CLOSED';
    clearPendingFidelity();
  });

  // INVARIANT (src/daemon/lazy-closed-review.ts): a PR lazy closed itself — a
  // reparent could not move it, and the close was requested but not confirmed,
  // so the task kept its record and the marker — reads CLOSED on a later pass.
  // That is lazy's own close: the task is settled (record and marker dropped, a
  // still-submitted task back to blocked), never abandoned, and its children
  // are never moved away.
  test('a marked task is settled, not abandoned, and keeps its children', async () => {
    mockTask = {
      ...makeTask('blocked'),
      status: 'submitted',
      metadata: { github_pr_number: '123', lazy_closed_review: 'https://github.com/o/r/pull/123' },
    };
    await runSync('/tmp/test', createMockStorage(), createMockLogger());

    expect(abandonedTasks).toEqual([]);
    expect(reparentedFrom).toEqual([]);
    expect(statusTransitions.map((t) => t.status)).toEqual(['blocked']);
    expect(mockTask.metadata.github_pr_number).toBe('');
    expect(mockTask.metadata.lazy_closed_review).toBe('');
  });

  // INVARIANT: a PR closed by somebody else — no marker — still ends the task
  // and moves its children, exactly as before the marker existed.
  test('an unmarked task whose PR was closed on the forge is abandoned as before', async () => {
    mockTask = makeTask('blocked');
    await runSync('/tmp/test', createMockStorage(), createMockLogger());

    expect(abandonedTasks).toEqual([mockTask.id]);
    expect(reparentedFrom).toEqual([mockTask.id]);
  });
});
