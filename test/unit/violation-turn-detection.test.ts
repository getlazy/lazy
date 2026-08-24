/**
 * Unit tests: which turn a conflict guard reads its violations from.
 *
 * THE BUG (fix-violation-turn-detection). Both external surfaces that gate an
 * unblock on unresolved file-permission violations hand-rolled
 *
 *     turns.filter(t => t.role === 'agent').pop()
 *
 * — the last agent turn, NOT the last agent turn *with violations*. A turn that
 * violates protections is followed by supervised push-back and maintained-files
 * nudges, and each of those produces a further agent turn that carries no
 * violations. So `pop()` landed on a nudge reply, the guard saw zero violations
 * and let the caller through with no decision recorded. The daemon then used
 * `latestViolationTurn` (correct), found the violations, and reverted every
 * unapproved file — silently, because the surface that was supposed to demand
 * an explicit decision never asked.
 *
 * INVARIANTS this file encodes:
 *
 *   1. `pendingViolations` reads the last agent turn that HAS violations, and is
 *      unmoved by any number of later violation-free agent turns.
 *   2. The MCP `lazy_unblock` handler refuses when `approved_files` is omitted
 *      on a conflict task WITH nudge turns after the violation turn. A fixture
 *      whose violation turn is last passes even against the bug and proves
 *      nothing — the nudge turns are the point of these tests.
 *   3. `approved_files: []` is an explicit revert-all and gets through; omission
 *      is an error. There is no implicit default, because a protected file the
 *      reviewer never ruled on must not be destroyed on their behalf.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createAllHandlers, type McpToolContext } from '../../src/mcp/tools';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { pendingViolations, latestViolationTurn, violationRecords } from '../../src/utils/turns';
import violationRevertNotice from '../../src/prompts/violation-revert-notice.md' with { type: 'text' };
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

describe('pendingViolations', () => {
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

    expect(pendingViolations(turns)).toHaveLength(1);
    expect(pendingViolations(turns)[0].file).toBe('test/unit/foo.test.ts');
    expect(latestViolationTurn(turns)?.sequence).toBe(1);
  });

  test('prefers the LATEST violation turn when several carry violations', () => {
    // The push-back turn re-detects violations; its set is the final one and
    // supersedes the work turn's stale set.
    const stale: FileViolation[] = [{ file: 'old.test.ts', base_sha: 'aaa', status: 'pending' }];
    const turns = [agentTurn(1, stale), nudgePromptTurn(2), agentTurn(3, PENDING), agentTurn(4)];

    expect(pendingViolations(turns).map(v => v.file)).toEqual(['test/unit/foo.test.ts']);
  });

  test('ignores already-resolved violations', () => {
    const resolved: FileViolation[] = [
      { file: 'a.test.ts', base_sha: 'aaa', status: 'approved' },
      { file: 'b.test.ts', base_sha: 'bbb', status: 'rejected' },
    ];
    expect(pendingViolations([agentTurn(1, resolved), agentTurn(2)])).toHaveLength(0);
  });

  test('returns empty when the agent resolved everything', () => {
    expect(pendingViolations([agentTurn(1), agentTurn(2)])).toHaveLength(0);
    expect(pendingViolations([])).toHaveLength(0);
  });
});

describe('violationRecords', () => {
  // INVARIANT (approval-is-re-assertable — fix-violation-approval-sticky):
  // `violationRecords` reports the violation turn's records WHATEVER their
  // status, and that — not `pendingViolations` — is what the reviewer-facing
  // guards ask before refusing an approval. A task whose records are all
  // approved has nothing pending, but naming those files again is still a
  // meaningful call; refusing it is what left the reviewer with only the
  // destructive one.
  test('reports decided records that pendingViolations filters out', () => {
    const decided: FileViolation[] = [
      { file: 'a.test.ts', base_sha: 'aaa', status: 'approved' },
      { file: 'b.test.ts', base_sha: 'bbb', status: 'rejected' },
    ];
    // The verification-only turn that made the incident possible: no violations
    // of its own, so the decided set is still the latest violation turn.
    const turns = [agentTurn(1, decided), agentTurn(2)];

    expect(pendingViolations(turns)).toHaveLength(0);
    expect(violationRecords(turns).map(v => v.file)).toEqual(['a.test.ts', 'b.test.ts']);
  });

  test('is empty when no turn ever carried violations', () => {
    expect(violationRecords([agentTurn(1), agentTurn(2)])).toHaveLength(0);
    expect(violationRecords([])).toHaveLength(0);
  });
});

// --- Invariants 2 and 3: the MCP surface ---

describe('lazy_unblock conflict guard', () => {
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

    // A conflict task shaped like the incident: violations on the work turn,
    // then two supervised nudge exchanges whose agent replies carry none.
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

  test('refuses when approved_files is omitted, despite later nudge turns', async () => {
    const handler = createAllHandlers(ctx).get('lazy_unblock')!;

    // Against the pre-fix code this call SUCCEEDS (the guard sees no violations
    // on the last nudge reply) and the daemon then reverts foo.test.ts with no
    // one having decided. That is the regression under test.
    await expect(handler({ task_id: taskId, feedback: 'please fix' }))
      .rejects.toThrow(/file permission violation/i);
  });

  test('the refusal names the file and both explicit options', async () => {
    const handler = createAllHandlers(ctx).get('lazy_unblock')!;

    const err = await handler({ task_id: taskId, feedback: 'please fix' }).catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('test/unit/foo.test.ts');
    expect(msg).toContain('approved_files: []');
    // Prose approval is not a channel — the incident's unblock said it was
    // approving the files while omitting the parameter that does it.
    expect(msg).toMatch(/feedback text has no effect/i);
  });

  test('approved_files: [] is accepted as an explicit revert-all', async () => {
    const handler = createAllHandlers(ctx).get('lazy_unblock')!;

    // The guard must let this through. It gets past the guard and then fails
    // reaching the daemon (there is none in this test) — asserting only that
    // the failure is NOT the guard keeps this test about the guard.
    const err = await handler({ task_id: taskId, feedback: 'revert them', approved_files: [] })
      .catch(e => e as Error);
    if (err instanceof Error) {
      expect(err.message).not.toMatch(/file permission violation/i);
    }
  });

  test('naming the violated file is accepted', async () => {
    const handler = createAllHandlers(ctx).get('lazy_unblock')!;

    const err = await handler({
      task_id: taskId, feedback: 'keep them', approved_files: ['test/unit/foo.test.ts'],
    }).catch(e => e as Error);
    if (err instanceof Error) {
      expect(err.message).not.toMatch(/file permission violation/i);
    }
  });

  test('passing approved_files on a task with no violations is an error', async () => {
    const clean = await storage.createTask('No violations here');
    const session = await storage.createSession(clean.id, 'claude', 'lazy/c', 'HEAD');
    await storage.createTurn({ sessionId: session.id, sequence: 1, role: 'agent', content: 'work' });
    await storage.updateTaskStatus(clean.id, 'working');
    await storage.updateTaskStatus(clean.id, 'blocked');

    const handler = createAllHandlers(ctx).get('lazy_unblock')!;
    await expect(handler({ task_id: clean.id, feedback: 'ok', approved_files: ['x.ts'] }))
      .rejects.toThrow(/no file permission violations/i);
  });

  // INVARIANT (approval-is-re-assertable — fix-violation-approval-sticky): the
  // guard asks two different questions of two different sets. "Must a decision
  // be supplied?" is about the PENDING set; "may one be supplied at all?" is
  // about every violation record on the turn, decided or not.
  //
  // THE BUG: after the reviewer approved a set, the next turn touched no
  // protected file and so recorded no violations of its own — leaving the
  // decided set as the latest violation turn with nothing pending. Re-passing
  // the approvals was then REFUSED ("has no file permission violations"), while
  // the daemon, on a call without them, re-labelled every approved record
  // `rejected` and reverted the agent's committed work. The refusal and the
  // revert together made the correct call unexpressible.
  test('re-passing already-approved files is accepted when nothing is pending', async () => {
    const decided = await storage.createTask('Approved already');
    const session = await storage.createSession(decided.id, 'claude', 'lazy/d', 'HEAD');
    await storage.createTurn({
      sessionId: session.id, sequence: 1, role: 'agent', content: 'work turn',
      violations: [{ file: 'test/unit/foo.test.ts', base_sha: 'abc123', status: 'approved' }],
    });
    // The verification-only turn: no file changed, so no violations recorded.
    await storage.createTurn({ sessionId: session.id, sequence: 2, role: 'agent', content: 'verified' });
    await storage.updateTaskStatus(decided.id, 'working');
    await storage.updateTaskStatus(decided.id, 'blocked');

    const handler = createAllHandlers(ctx).get('lazy_unblock')!;
    const err = await handler({
      task_id: decided.id, feedback: 'carry on', approved_files: ['test/unit/foo.test.ts'],
    }).catch(e => e as Error);
    // Past the guard is all this asserts — there is no daemon in this test, so
    // the call fails later. It must not fail with the guard's refusal.
    if (err instanceof Error) {
      expect(err.message).not.toMatch(/no file permission violations/i);
    }
  });

  // INVARIANT: with nothing pending, omitting the parameter is NOT an error —
  // there is no decision owed. What the daemon must not do is read that silence
  // as "revert"; that half is pinned by test/e2e/violation-approval-sticky.ts.
  test('omitting approved_files is fine once every violation is decided', async () => {
    const decided = await storage.createTask('Approved already');
    const session = await storage.createSession(decided.id, 'claude', 'lazy/d2', 'HEAD');
    await storage.createTurn({
      sessionId: session.id, sequence: 1, role: 'agent', content: 'work turn',
      violations: [{ file: 'test/unit/foo.test.ts', base_sha: 'abc123', status: 'approved' }],
    });
    await storage.updateTaskStatus(decided.id, 'working');
    await storage.updateTaskStatus(decided.id, 'blocked');

    const handler = createAllHandlers(ctx).get('lazy_unblock')!;
    const err = await handler({ task_id: decided.id, feedback: 'carry on' }).catch(e => e as Error);
    if (err instanceof Error) {
      expect(err.message).not.toMatch(/file permission violation/i);
    }
  });
});

// --- The notice injected into the agent's next prompt after a revert ---

describe('violation revert notice', () => {
  // INVARIANT: the notice must give the agent something to DO when the reverted
  // tree is incoherent, and that something is REPORT AND STOP.
  //
  // The old text was an absolute "do NOT modify them again". In the incident the
  // revert restored a test suite for methods the task had deleted, so the tree no
  // longer compiled: obeying literally means shipping a broken branch. The agent
  // disobeyed and explained itself, and was right — but a more literal agent
  // ships the breakage.
  //
  // The escape hatch is deliberately NOT "re-apply if you think the revert was
  // wrong". That opens a churn loop: agent re-applies, reviewer reverts again.
  // Re-approval is the reviewer's move — they unblock again with the files in
  // --approve-file / approved_files.

  test('substitutes the reverted file list', () => {
    const rendered = violationRevertNotice
      .trim()
      .replace('{{files}}', ['a.test.ts', 'b.test.ts'].map(f => `  - ${f}`).join('\n'));

    expect(rendered).toContain('  - a.test.ts');
    expect(rendered).toContain('  - b.test.ts');
    expect(rendered).not.toContain('{{files}}');
  });

  test('the revert stands and re-applying is not the agent\'s move', () => {
    expect(violationRevertNotice).toMatch(/revert stands/i);
    expect(violationRevertNotice).toMatch(/do not re-apply/i);
    // The reviewer, not the agent, resolves a disputed revert.
    expect(violationRevertNotice).toMatch(/unblocking again/i);
  });

  test('tells the agent to report and hand back when the revert breaks the tree', () => {
    expect(violationRevertNotice).toMatch(/does not compile|tests fail/i);
    expect(violationRevertNotice).toMatch(/hand the task back/i);
    // The absolute phrasing that left no room for an incoherent tree.
    expect(violationRevertNotice).not.toMatch(/do NOT modify them again/);
  });

  test('stays short — it is injected into every post-revert prompt', () => {
    expect(violationRevertNotice.trim().split(/\s+/).length).toBeLessThan(120);
  });
});

// --- The status label may drift; the pending set is what the guards read ---
//
// THE BUG (fix-ask-nukes-violations): a read-only `lazy_ask` left a `conflict`
// task reading `blocked` while its violation was still pending. Every reviewer
// guard keyed on `task.status`, so the correct call became unexpressible:
// passing `approved_files` was REFUSED ("this task has no file permission
// violations") and omitting it was ACCEPTED — after which the daemon's revert,
// which reads the SET, destroyed the agent's committed work.
//
// These tests seed exactly that drifted state (status `blocked`, one pending
// violation) and pin both halves of the fix.
describe('guards read the violation set, not the status label', () => {
  let testDir: string;
  let storage: Storage;
  let ctx: McpToolContext;
  let taskId: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-violation-drift-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });

    spawnSyncUnsupervised(['git', 'init'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.email', 'test@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSyncUnsupervised(['git', 'add', '.'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'commit', '-m', 'Initial commit'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external' });
    ctx = { taskId: '', worktreePath: testDir, storage };

    const task = await storage.createTask('Do the thing');
    taskId = task.id;
    const session = await storage.createSession(task.id, 'claude', 'lazy/t', 'HEAD');
    await storage.createTurn({
      sessionId: session.id, sequence: 1, role: 'agent',
      content: 'work turn', violations: PENDING,
    });
    // The side-channel turn: an ask records its own turn and detects nothing,
    // because an ask runs no permission check at all.
    await storage.createTurn({
      sessionId: session.id, sequence: 2, role: 'human', content: 'a question', turnType: 'ask',
    });
    await storage.createTurn({
      sessionId: session.id, sequence: 3, role: 'agent', content: 'an answer', turnType: 'ask',
    });

    await storage.updateTaskStatus(task.id, 'working');
    // The drift itself: parked as `blocked` with the violation still pending.
    await storage.updateTaskStatus(task.id, 'blocked');
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  // INVARIANT: an unblock can never revert a file the caller was refused
  // permission to approve. If violations are pending, `approved_files` MUST be
  // accepted — whatever the status label says.
  test('approved_files is accepted on a drifted (blocked) task with a pending set', async () => {
    const handler = createAllHandlers(ctx).get('lazy_unblock')!;

    const err = await handler({
      task_id: taskId, feedback: 'keep them', approved_files: ['test/unit/foo.test.ts'],
    }).catch(e => e as Error);

    // This is the refusal the incident hit. Anything else here is the guard
    // getting past the status label and reaching the daemon (there is none in
    // this test), which is what we are asserting.
    if (err instanceof Error) {
      expect(err.message).not.toMatch(/no file permission violations/i);
    }
  });

  // The other half: if the approval is expressible, the refusal for omitting it
  // must still fire. Otherwise the drifted state silently reverts as before.
  test('omitting a decision on a drifted task is still refused', async () => {
    const handler = createAllHandlers(ctx).get('lazy_unblock')!;

    await expect(handler({ task_id: taskId, feedback: 'please fix' }))
      .rejects.toThrow(/file permission violation/i);
  });

  // `lazy_resume` cannot express an approval decision at all, so it must refuse
  // rather than hand the daemon an unblock with no decision attached.
  test('resume refuses while violations are pending and points at unblock', async () => {
    const handler = createAllHandlers(ctx).get('lazy_resume');
    if (!handler) return; // surface not present — nothing to pin

    const err = await handler({ task_id: taskId }).catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/violation/i);
    expect((err as Error).message).toMatch(/unblock/i);
  });
});
