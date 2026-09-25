/**
 * The daemon does not review a task the supervisor still owns — and a dispatch
 * it LOSES is not a review that failed.
 *
 * ENGINEER RULE (2026-09-20): the daemon must never act on a task before the
 * supervisor has returned control. The post-turn check, the wrap-up steps and
 * everything else the supervisor runs after the agent's last message are the
 * supervisor's own work; the daemon reacts to the turn only once the supervisor
 * has handed the task back and the task has parked.
 *
 * WHAT WENT WRONG (`teams-raised-cluster-row-one-size`, 2026-09-20). The child
 * parked with a standing final; a driver's own `lazy_review` took the task
 * ~11 seconds later; the catchup's dispatch, deciding off a status it had read
 * before that, was refused with "Task is 'working'" — and recorded a FAILED TO
 * START review, which GATES accept and whose only override is CLI-only. The
 * child could then neither be accepted by its driver nor reviewed, while the
 * review it was owed was running at that exact moment.
 *
 * Two properties are pinned here, both about what the catchup does NOT do:
 *
 *   1. It does not dispatch while the supervisor still owns the turn — a
 *      response not yet settled, a command pending in the mailbox, or a live
 *      supervisor inside a post-work phase. Each is a per-tick skip that
 *      records NOTHING, exactly like the in-flight-turn and worktree-lock gates
 *      above it (final-turn design §8.3: only walls that stand for HOURS get a
 *      record).
 *   2. It does not record a failed review when the launch was refused because
 *      another turn took the task first (`task_busy`). A genuine launch failure
 *      — docker down, no runner — still records, and that distinction is the
 *      whole point of the test below that asserts both directions.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { getWorktreePathForRef, taskRef } from '../../src/task/identity';
import { RpcError } from '../../src/daemon/rpc-error';

const journal: Array<{ taskId: string; content: string; actor: string }> = [];
let turns: any[] = [];
/** Task ids handed to `launchReviewTask`, i.e. the dispatches that happened. */
const launches: string[] = [];
/** What the mocked `launchReviewTask` throws, if anything. */
let launchError: unknown = null;

await mockModule(resolve(import.meta.dir, '../../src/daemon/task-lifecycle.ts'), () => ({
  REVIEWABLE_STATUSES: new Set(['blocked']),
  launchReviewTask: async (_root: string, options: any) => {
    launches.push(options.taskId);
    if (launchError) throw launchError;
  },
}));

await mockModule(resolve(import.meta.dir, '../../src/daemon/turn-credentials.ts'), () => ({
  systemTurnBlock: async () => null,
}));

/** Liveness of the task's work supervisor, as the handback check sees it. */
let supervisorAlive = false;
await mockModule(resolve(import.meta.dir, '../../src/runner/index.ts'), () => ({
  createRunner: async () => ({
    type: 'docker',
    runNameForTask: (ref: any) => `lazy-${ref.id ?? 'task'}`,
    isRunning: async () => supervisorAlive,
  }),
}));

const { runAutoReviewCatchup } = await import('../../src/daemon/auto-review');
const { protocolDir } = await import('../../src/protocol');

afterAll(() => restoreMockedModules());

const FINAL_SEQ = 4;
const FINAL_SHA = 'abcdef1234567890';
const TASK_ID = 'child-1';

function parkedTask(): any {
  return {
    id: TASK_ID,
    code: 'fix-thing',
    goal: 'Fix the thing',
    status: 'blocked',
    type: 'task',
    target: { kind: 'branch', branch: 'main' },
    // SEPARATE mode, explicitly: this suite is about the reviewer the DAEMON
    // dispatches after a final, and since 2026-09-21 only `separate` does that
    // (the default, `low_high`, has the writer review itself in session). The
    // dispatch reads the task's pinned mode, so the fixture states it.
    metadata: { review_mode: 'separate' },
  };
}

function makeStorage(): any {
  const t = parkedTask();
  let nextSequence = FINAL_SEQ + 1;
  return {
    listTasks: async () => [t],
    getTask: async () => t,
    getTaskRaisedItems: async () => [],
    getTaskMetadata: async () => null,
    updateTaskMetadata: async () => {},
    appendJournalEntry: async (taskId: string, content: string, actor: string) => {
      journal.push({ taskId, content, actor });
    },
    getSessionByTaskId: async () => ({ id: 'sess-1', container_name: null, runner_type: null }),
    getSessionTurns: async () => turns,
    reserveTurnSequences: async () => nextSequence++,
    createTurn: async (options: any) => {
      turns.push({
        sequence: options.sequence,
        role: options.role,
        turn_type: options.turnType,
        content: options.content,
        review: options.review,
      });
    },
  };
}

/** The review turn the catchup recorded for this final, if any. */
const recorded = () => turns.find((t) => t.turn_type === 'review');

let lazyRoot: string;
let protoDir: string;

beforeEach(async () => {
  lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-review-park-'));
  await mkdir(getWorktreePathForRef(lazyRoot, taskRef(parkedTask())), { recursive: true });
  await mkdir(join(lazyRoot, '.lazy'), { recursive: true });
  // Each case gets its own protocol base so a leftover mailbox cannot leak into
  // the next one (and so nothing here can see a real ~/.lazy/protocol).
  process.env.LAZY_PROTOCOL_BASE = join(lazyRoot, 'protocol');
  protoDir = protocolDir(TASK_ID);
  await mkdir(protoDir, { recursive: true });
  journal.length = 0;
  launches.length = 0;
  launchError = null;
  supervisorAlive = false;
  turns = [{
    sequence: FINAL_SEQ,
    role: 'agent',
    turn_type: 'work',
    final: { sha: FINAL_SHA, actor: 'agent', at: Date.now() },
  }];
});

afterAll(async () => {
  delete process.env.LAZY_PROTOCOL_BASE;
  if (lazyRoot) await rm(lazyRoot, { recursive: true, force: true });
});

describe('the supervisor has not handed the task back', () => {
  test('a clean mailbox and no live supervisor: the review dispatches', async () => {
    await runAutoReviewCatchup(makeStorage(), lazyRoot);
    expect(launches).toEqual([TASK_ID]);
    expect(recorded()).toBeUndefined();
  });

  // INVARIANT (engineer rule, 2026-09-20): the daemon waits for the supervisor
  // to return control. The settle PARKS the task before it consumes
  // `response.json`, so a parked status is not by itself proof the turn is over
  // — a dispatch landing in that window takes the task to `working` with the
  // previous turn's answer still in the slot.
  test('an unsettled response: no dispatch, and nothing recorded', async () => {
    await writeFile(join(protoDir, 'response.json'), JSON.stringify({ status: 'completed' }));
    await runAutoReviewCatchup(makeStorage(), lazyRoot);
    expect(launches).toEqual([]);
    expect(recorded()).toBeUndefined();
    expect(journal).toHaveLength(0);
  });

  // A turn is being launched right now: its own path owns the mailbox and will
  // flip the status a moment later.
  test('a pending command with a live supervisor: no dispatch, and nothing recorded', async () => {
    supervisorAlive = true;
    await writeFile(join(protoDir, 'command.json'), JSON.stringify({ type: 'unblock' }));
    await runAutoReviewCatchup(makeStorage(), lazyRoot);
    expect(launches).toEqual([]);
    expect(recorded()).toBeUndefined();
    expect(journal).toHaveLength(0);
  });

  // INVARIANT: same rule as the leftover phase below — a command nobody is left
  // to consume is DEBRIS, not ownership. An `interrupted` task's mailbox holds
  // its dead turn's own command, and replacing it is exactly what auto-resume
  // exists to do; reading that as "the supervisor still owns this" stopped
  // every automatic launch on the task for good.
  test('a pending command left by a DEAD supervisor: the review dispatches', async () => {
    supervisorAlive = false;
    await writeFile(join(protoDir, 'command.json'), JSON.stringify({ type: 'unblock' }));
    await runAutoReviewCatchup(makeStorage(), lazyRoot);
    expect(launches).toEqual([TASK_ID]);
    expect(recorded()).toBeUndefined();
  });

  // The plain reading of the rule: a `post_turn_check` can be a whole build, and
  // it is the supervisor's own work.
  test('a live supervisor still in post_turn_check: no dispatch', async () => {
    supervisorAlive = true;
    await writeFile(
      join(protoDir, 'status.json'),
      JSON.stringify({ phase: 'post_turn_check', task_id: TASK_ID }),
    );
    await runAutoReviewCatchup(makeStorage(), lazyRoot);
    expect(launches).toEqual([]);
    expect(recorded()).toBeUndefined();
    expect(journal).toHaveLength(0);
  });

  // INVARIANT: liveness decides, not the leftover file. A dead supervisor's
  // stale `status.json` must never be read as ownership — that would wedge every
  // automatic launch on the task permanently, which is worse than the race.
  test('a DEAD supervisor with a leftover phase: the review dispatches', async () => {
    supervisorAlive = false;
    await writeFile(
      join(protoDir, 'status.json'),
      JSON.stringify({ phase: 'post_turn_check', task_id: TASK_ID }),
    );
    await runAutoReviewCatchup(makeStorage(), lazyRoot);
    expect(launches).toEqual([TASK_ID]);
    expect(recorded()).toBeUndefined();
  });

  test('a settled turn with no phase recorded: the review dispatches', async () => {
    supervisorAlive = true;
    await runAutoReviewCatchup(makeStorage(), lazyRoot);
    expect(launches).toEqual([TASK_ID]);
  });
});

describe('a dispatch refused because another turn took the task', () => {
  // INVARIANT: a race lost is not a review that failed. Recording a FAILED TO
  // START review here gated `teams-raised-cluster-row-one-size` while its real
  // review was starting — and the override for that gate is CLI-only, so its
  // driver could neither accept the child nor get it reviewed.
  test('records nothing, and the next tick retries', async () => {
    launchError = new RpcError(
      409,
      `Task fix-thing is 'working' — a review cannot run while the task is busy`,
      'task_busy',
    );
    await runAutoReviewCatchup(makeStorage(), lazyRoot);

    expect(launches).toEqual([TASK_ID]);
    expect(recorded()).toBeUndefined();
    expect(journal).toHaveLength(0);

    // The retry is what makes recording nothing safe: with the other turn gone,
    // the same derived trigger dispatches again.
    launchError = null;
    await runAutoReviewCatchup(makeStorage(), lazyRoot);
    expect(launches).toEqual([TASK_ID, TASK_ID]);
  });

  test('an in-flight-claim refusal is the same kind of refusal', async () => {
    launchError = new RpcError(
      409,
      'Task fix-thing already has a synchronous turn in flight (review)',
      'task_busy',
    );
    await runAutoReviewCatchup(makeStorage(), lazyRoot);
    expect(recorded()).toBeUndefined();
    expect(journal).toHaveLength(0);
  });

  // The other direction, and the reason the code keys on a CODE rather than on
  // "was it a 409": a reviewer that genuinely cannot be launched must still land
  // as a FAILED review that gates, per §8.3.
  test('a real launch failure still records a FAILED review', async () => {
    launchError = new Error('docker daemon not running');
    await runAutoReviewCatchup(makeStorage(), lazyRoot);

    const review = recorded();
    expect(review).toBeDefined();
    expect(review.review.verdict).toContain('FAILED TO START');
    expect(review.review.verdict).toContain('docker daemon not running');
  });

  test('a non-busy 409 still records — the code is the signal, not the status', async () => {
    launchError = new RpcError(409, 'Task fix-thing is locked for pairing');
    await runAutoReviewCatchup(makeStorage(), lazyRoot);
    expect(recorded()).toBeDefined();
  });
});
