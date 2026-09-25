/**
 * INVARIANT: a live work supervisor must not be able to observe the review
 * command. Review writes into reviewProtocolDir (a sibling of the work
 * mailbox); the work supervisor only mounts/polls protocolDir. Sharing the
 * work mailbox let the idle implementer consume the review turn before
 * lazy-review-* finished starting.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  protocolDir,
  reviewProtocolDir,
  writeCommand,
  hasCommand,
  ensureProtocolDir,
  readCommand,
} from '../../src/protocol';
import type { ReviewCommand } from '../../src/protocol';

const LIFECYCLE = join(import.meta.dir, '../../src/daemon/task-lifecycle.ts');

describe('review protocol isolation', () => {
  let previousBase: string | undefined;
  let base: string;

  beforeEach(async () => {
    previousBase = process.env.LAZY_PROTOCOL_BASE;
    base = await mkdtemp(join(tmpdir(), 'lazy-review-proto-'));
    process.env.LAZY_PROTOCOL_BASE = base;
  });

  afterEach(async () => {
    if (previousBase === undefined) delete process.env.LAZY_PROTOCOL_BASE;
    else process.env.LAZY_PROTOCOL_BASE = previousBase;
    await rm(base, { recursive: true, force: true });
  });

  test('reviewProtocolDir is a sibling of the work mailbox, not nested in it', () => {
    const taskId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const work = protocolDir(taskId);
    const review = reviewProtocolDir(taskId);
    expect(review).toBe(join(base, `${taskId}-review`));
    expect(review).not.toBe(work);
    // Not nested: work supervisor bind-mount of `work` must not include review files.
    expect(review.startsWith(work + '/')).toBe(false);
    expect(review.startsWith(work + '\\')).toBe(false);
  });

  // INVARIANT: writing a review command must leave the work mailbox empty so a
  // live work supervisor cannot observe (or consume) it.
  test('a review command in the review mailbox is invisible on the work mailbox', () => {
    const taskId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
    const work = protocolDir(taskId);
    const review = reviewProtocolDir(taskId);
    ensureProtocolDir(work);
    ensureProtocolDir(review);

    const command: ReviewCommand = {
      type: 'review',
      task_id: taskId,
      goal: 'g',
      prompt: 'p',
      agent_id: 'cursor',
      harness: 'cursor',
      system_prompt: 's',
      model_id: 'auto',
      command_id: 'cmd-review-1',
    };
    writeCommand(review, command);

    expect(hasCommand(review)).toBe(true);
    expect(hasCommand(work)).toBe(false);
    expect(readCommand(work)).toBeNull();
    expect(readCommand(review)?.type).toBe('review');
  });

  test('launchReviewTaskRun writes and launches via reviewProtocolDir only', async () => {
    const source = await readFile(LIFECYCLE, 'utf-8');
    const start = source.indexOf('async function launchReviewTaskRun');
    expect(start).toBeGreaterThan(-1);
    const rest = source.slice(start);
    const nextFn = rest.search(/\n(?:export )?(?:async )?function |\nexport async function /);
    const body = nextFn > 0 ? rest.slice(0, nextFn) : rest;

    expect(body).toContain('reviewProtocolDir(task.id)');
    expect(body).toMatch(/const protoDir = reviewProtocolDir\(task\.id\)/);
    expect(body).toContain('writeCommand(protoDir, reviewCommand)');
    expect(body).toContain('launchSupervisor(sandbox, containerName, protoDir');
    // Must not fall back to the work mailbox for the review command.
    expect(body).not.toMatch(/writeCommand\(getProtocolDir/);
    expect(body).not.toMatch(/const protoDir = getProtocolDir\(task\.id\)/);
  });

  // INVARIANT: the unwind clears the review mailbox on whether THIS CALL WROTE
  // THE COMMAND, never on whether it moved the status. The two stop being the
  // same fact at the supervisor-launch failure, which puts the status back and
  // clears `movedToWorking` while the command it wrote is already in the
  // mailbox — keying the cleanup on that flag left this call's own command
  // there for whatever read it next. The opposite direction is the one that
  // cost an incident and must not regress either: `reviewProtocolDir` is per
  // TASK, so a dispatch refused before it wrote anything must not delete a
  // concurrent reviewer's command (2026-09-20,
  // `teams-raised-cluster-row-one-size`).
  //
  // Scanned from source, like the two cases above it: the rule is inline state
  // inside a function no unit test can reach without standing up a runner, a
  // worktree and a lock.
  test('the unwind clears the review mailbox on the WRITE, not on the status move', async () => {
    const source = await readFile(LIFECYCLE, 'utf-8');
    const start = source.indexOf('async function launchReviewTaskRun');
    expect(start).toBeGreaterThan(-1);
    const rest = source.slice(start);
    const nextFn = rest.search(/\n(?:export )?(?:async )?function |\nexport async function /);
    const body = nextFn > 0 ? rest.slice(0, nextFn) : rest;

    // The flag is its own fact, set where the command is written.
    expect(body).toMatch(/let wroteReviewCommand = false/);
    expect(body).toMatch(
      /writeCommand\(protoDir, reviewCommand\);\s*\n\s*wroteReviewCommand = true;/,
    );

    // The cleanup is guarded by that flag...
    expect(body).toMatch(
      /if \(wroteReviewCommand\) \{[\s\S]{0,400}?removeProtocolDir\(reviewProtocolDir\(task\.id\)\)/,
    );
    // ...and by nothing else. A bare cleanup would delete a concurrent
    // reviewer's command; one nested under `movedToWorking` would skip this
    // call's own on the launch-failure path.
    const cleanupCount = body.match(/removeProtocolDir\(reviewProtocolDir\(task\.id\)\)/g) ?? [];
    expect(cleanupCount).toHaveLength(1);
    const movedBlock = body.slice(body.indexOf('if (movedToWorking) {'));
    const movedBlockEnd = movedBlock.indexOf('if (wroteReviewCommand) {');
    expect(movedBlockEnd).toBeGreaterThan(-1);
    expect(movedBlock.slice(0, movedBlockEnd)).not.toContain('removeProtocolDir');

    // And the launch-failure path must not clear the write flag the way it
    // clears the status one — that is the bug this case exists for.
    expect(body).toMatch(/movedToWorking = false;/);
    expect(body).not.toMatch(/wroteReviewCommand = false;\s*\n\s*throw new RpcError\(500/);
  });

  test('settleInFlightTurn routes review responses to reviewProtocolDir', async () => {
    const source = await readFile(LIFECYCLE, 'utf-8');
    const start = source.indexOf('async function settleInFlightTurnLocked');
    expect(start).toBeGreaterThan(-1);
    const rest = source.slice(start);
    const nextFn = rest.search(/\n(?:export )?(?:async )?function |\nexport async function /);
    const body = nextFn > 0 ? rest.slice(0, nextFn) : rest;

    expect(body).toContain("record.owner === 'review'");
    expect(body).toContain('reviewProtocolDir(task.id)');
  });
});
