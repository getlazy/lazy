/**
 * Unit tests: which turn carries the violation set, and what unblock does with it.
 *
 * TWO ERAS, both encoded here.
 *
 * WAS (fix-violation-turn-detection): both surfaces that gated an unblock on
 * unresolved file-permission violations hand-rolled
 *
 *     turns.filter(t => t.role === 'agent').pop()
 *
 * — the last agent turn, NOT the last agent turn *with violations*. A turn that
 * violates protections is followed by supervised push-back and maintained-files
 * nudges, each producing a further agent turn that carries no violations, so
 * `pop()` landed on a nudge reply and the guard saw nothing.
 *
 * IS (move-file-approval-to-accept): unblock has no guard and no approval
 * channel at all — it never reverts a file, so nothing it does depends on the
 * set. `latestViolationTurn` still has to be right, because ACCEPT reads it to
 * decide what must be approved before a merge, and the nudge-turn subtlety is
 * unchanged.
 *
 * INVARIANTS this file encodes:
 *
 *   1. `latestViolationTurn` finds the last agent turn that HAS violations,
 *      unmoved by any number of later violation-free turns. That is the
 *      PER-TURN question the push-back asks — its two former companions
 *      (`pendingViolations`, `violationRecords`) were deleted in
 *      move-file-approval-to-accept because reading one turn is not the answer
 *      to "what does this task still owe"; src/protection/outstanding.ts is,
 *      and test/unit/outstanding-violations.test.ts covers it.
 *   2. `lazy_unblock` unblocks a conflict task with nothing named — a pending
 *      violation neither blocks it nor is destroyed by it.
 *   3. Passing `approved_files` to `lazy_unblock` is a loud error naming
 *      accept, never a silently ignored parameter: the old `[]` meant "revert
 *      everything", and a caller that still sends it must not think it decided.
 *   4. `lazy_resume` does not refuse on a pending set.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { allTools, createAllHandlers, type McpToolContext } from '../../src/mcp/tools';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { latestViolationTurn } from '../../src/utils/turns';
import type { Turn, FileViolation } from '../../src/types';

// --- Invariant 1: the helper itself ---

function agentTurn(sequence: number, violations?: FileViolation[]): Turn {
  return {
    id: `t${sequence}`,
    session_id: 's1',
    sequence,
    role: 'agent',
    content: `turn ${sequence}`,
    timestamp: 1000 + sequence,
    ...(violations ? { violations } : {}),
  } as Turn;
}

function nudgePromptTurn(sequence: number): Turn {
  return {
    id: `t${sequence}`,
    session_id: 's1',
    sequence,
    role: 'human',
    content: '## Permission Violation Review',
    timestamp: 1000 + sequence,
    turn_type: 'nudge',
  } as Turn;
}

const PENDING: FileViolation[] = [
  { file: 'test/unit/foo.test.ts', base_sha: 'abc123', status: 'pending' },
];

describe('latestViolationTurn', () => {
  test('finds violations recorded before later violation-free agent turns', () => {
    // The real shape from the incident: work turn violates, then a permission
    // push-back exchange and a maintained-files nudge each add an agent reply
    // that carries no violations of its own.
    const turns = [
      agentTurn(1, PENDING),
      nudgePromptTurn(2),
      agentTurn(3), // push-back reply — no violations block
      nudgePromptTurn(4),
      agentTurn(5), // maintained-files reply — no violations block
    ];

    // The naive implementation this replaced — kept here to show the two
    // disagree on exactly this input, which is what made the bug invisible.
    const naive = turns.filter(t => t.role === 'agent').pop();
    expect(naive?.violations ?? []).toHaveLength(0);

    expect(latestViolationTurn(turns)?.sequence).toBe(1);
    expect(latestViolationTurn(turns)?.violations).toEqual(PENDING);
  });

  test('prefers the LATEST violation turn when several carry violations', () => {
    // The push-back turn re-detects violations; its set is the final one and
    // supersedes the work turn's stale set.
    const stale: FileViolation[] = [{ file: 'old.test.ts', base_sha: 'aaa', status: 'pending' }];
    const turns = [agentTurn(1, stale), nudgePromptTurn(2), agentTurn(3, PENDING), agentTurn(4)];

    expect(latestViolationTurn(turns)?.violations?.map(v => v.file)).toEqual(['test/unit/foo.test.ts']);
  });

  test('returns nothing when no turn ever carried violations', () => {
    expect(latestViolationTurn([agentTurn(1), agentTurn(2)])).toBeUndefined();
    expect(latestViolationTurn([])).toBeUndefined();
  });

  // INVARIANT: an explicit empty re-detect (violations: []) on a later turn is
  // this helper's answer — it IS what the most recent scan saw. Field ABSENT is
  // not a re-detect, so it does not move the answer.
  //
  // What an empty set no longer does is CLEAR what the task owes: that question
  // is answered across all turns and against the branch (outstanding.ts), after
  // a later empty record was found to have silently dropped an earlier turn's
  // unapproved file.
  test('a later turn with violations: [] is the latest violation turn', () => {
    const turns = [
      agentTurn(1, PENDING),
      nudgePromptTurn(2),
      agentTurn(3, []), // authoritative empty re-detect (push-back or react)
    ];
    expect(latestViolationTurn(turns)?.sequence).toBe(3);
    expect(latestViolationTurn(turns)?.violations).toEqual([]);
  });

  test('a later turn with the violations field absent does not move it', () => {
    // Same shape as maintain / react-without-redetect: agent reply, no field.
    const turns = [agentTurn(1, PENDING), nudgePromptTurn(2), agentTurn(3)];
    expect(latestViolationTurn(turns)?.sequence).toBe(1);
  });
});

// --- Invariants 2 and 3: the MCP surface ---

describe('lazy_unblock and protected-file violations', () => {
  let testDir: string;
  let storage: Storage;
  let ctx: McpToolContext;
  let taskId: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-violation-guard-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });

    spawnSyncUnsupervised(['git', 'init'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.email', 'test@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSyncUnsupervised(['git', 'add', '.'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'commit', '-m', 'Initial commit'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external' });
    ctx = { taskId: '', worktreePath: testDir, storage };

    // A conflict task shaped like the original incident: violations on the work
    // turn, then two supervised nudge exchanges whose agent replies carry none.
    const task = await storage.createTask('Do the thing');
    taskId = task.id;
    const session = await storage.createSession(task.id, 'claude', 'lazy/t', 'HEAD');

    await storage.createTurn({
      sessionId: session.id, sequence: 1, role: 'agent',
      content: 'work turn', violations: PENDING,
    });
    await storage.createTurn({
      sessionId: session.id, sequence: 2, role: 'human',
      content: '## Permission Violation Review', turnType: 'nudge',
    });
    await storage.createTurn({
      sessionId: session.id, sequence: 3, role: 'agent',
      content: 'push-back reply', turnType: 'nudge',
    });
    await storage.createTurn({
      sessionId: session.id, sequence: 4, role: 'human',
      content: '## Maintained Files Review', turnType: 'nudge',
    });
    await storage.createTurn({
      sessionId: session.id, sequence: 5, role: 'agent',
      content: 'maintain reply', turnType: 'nudge',
    });

    await storage.updateTaskStatus(task.id, 'working');
    await storage.updateTaskStatus(task.id, 'conflict');
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  // INVARIANT (approval-happens-at-accept — move-file-approval-to-accept): a
  // pending violation does not gate an unblock. This REPLACES the older rule
  // that a conflict unblock had to carry a decision; the engineer retired it on
  // 2026-09-13, because a mandatory decision on every turn made reviewers (and
  // loop agents) rule on files they had not read, and "none for now" destroyed
  // the agent's committed work.
  test('unblocks a conflict task with no file decision at all', async () => {
    const handler = createAllHandlers(ctx).get('lazy_unblock')!;

    const err = await handler({ task_id: taskId, feedback: 'please fix' }).catch(e => e as Error);
    // There is no daemon in this test, so the call fails further down. What it
    // must never be is a refusal about protected files.
    if (err instanceof Error) {
      expect(err.message).not.toMatch(/file permission violation/i);
      expect(err.message).not.toMatch(/approved_files/i);
    }
  });

  // INVARIANT: removed, not ignored. A stale caller still sending the old
  // parameter gets an error naming the surface that DOES decide.
  test('approved_files is refused with a pointer to accept', async () => {
    const handler = createAllHandlers(ctx).get('lazy_unblock')!;

    for (const value of [[], ['test/unit/foo.test.ts']]) {
      const err = await handler({ task_id: taskId, feedback: 'ok', approved_files: value })
        .catch(e => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/approved_files/);
      expect((err as Error).message).toMatch(/lazy_accept/);
    }
  });

  test('the schema no longer advertises approved_files', () => {
    const tool = allTools.find(t => t.name === 'lazy_unblock')!;
    expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('approved_files');
  });

  // INVARIANT (approval-happens-at-accept): resume routes through the unblock
  // path, which reverts nothing, so a pending set is no reason to refuse it.
  test('lazy_resume does not refuse while violations are pending', async () => {
    const handler = createAllHandlers(ctx).get('lazy_resume');
    if (!handler) return; // surface not present — nothing to pin

    const err = await handler({ task_id: taskId }).catch(e => e as Error);
    if (err instanceof Error) {
      expect(err.message).not.toMatch(/file permission violation/i);
    }
  });
});

// --- The status label drives nothing ---
//
// fix-ask-nukes-violations pinned here that a `conflict` task relabelled
// `blocked` by a side-channel turn (an ask, a sync, a pairing session) still
// accepted `approved_files` on unblock and still refused an unblock without
// one. Both halves are gone with the parameter: an unblock behaves identically
// on a `conflict` and a `blocked` task, with or without a pending set, so
// there is nothing left here for the label to get wrong. What still matters —
// that a drifted label never lets accept merge an undecided protected file — is
// pinned end-to-end in test/e2e/violations-survive-status-drift.test.ts.
