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
import { spawnSync } from '../../src/utils/spawn';
import { pendingViolations, latestViolationTurn } from '../../src/utils/turns';
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

// --- Invariants 2 and 3: the MCP surface ---

describe('lazy_unblock conflict guard', () => {
  let testDir: string;
  let storage: Storage;
  let ctx: McpToolContext;
  let taskId: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-violation-guard-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });

    spawnSync(['git', 'init'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSync(['git', 'add', '.'], { cwd: testDir });
    spawnSync(['git', 'commit', '-m', 'Initial commit'], { cwd: testDir });

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
