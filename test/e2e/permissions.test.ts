/**
 * E2E tests for file permission violation detection.
 *
 * Verifies that the supervisor detects when agents modify or delete
 * protected files, while allowing pure additions.
 *
 * Harness notes: this suite is daemonless, so every followed turn is a
 * two-step dance.
 *  - `--follow` makes `lazy start`/`lazy unblock` WAIT for the mock supervisor
 *    to write response.json instead of returning the moment the agent launches.
 *  - `runReconcile` then processes that response (records the agent turn,
 *    detects violations, sets the status). Post-v0.11 only the daemon's
 *    reconcile loop does this — `--follow` no longer reconciles on the way out,
 *    so without the explicit pass no agent turn or violation is ever recorded.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError, expectOutput } from '../helpers/assertions';
import { createTask, disablePreAccept, MOCK_CLAUDE_SUCCESS, setProtectedPatterns } from '../helpers/fixtures';
import { runReconcile } from '../helpers/reconcile';
import { readTaskStatus, readTurns, writeTurns, type StoredTurn } from '../helpers/storage';

/**
 * The agent turn carrying the FINAL violation set. With the bundle model
 * violations are re-detected after push-back and attributed to the PUSH-BACK turn
 * (a turn_type 'nudge' agent turn), NOT the work turn — so tests must look for the
 * latest agent turn that actually recorded violations.
 */
function violationTurn(turns: StoredTurn[]) {
  return [...turns].reverse().find(t => t.role === 'agent' && t.violations && t.violations.length > 0);
}

describe('file permission violations', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // The accept tests here assert on the violation gate, not on pre-accept;
    // daemonless there is no runner to execute that extra agent turn.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    // ctx.cleanup() removes the external storage dir too (see setup.ts).
    await ctx.cleanup();
  });

  // INVARIANT: Modifying a protected test file triggers a violation.
  // Agents must not modify existing test content without human review.
  test('detects violations when agent modifies a test file', async () => {
    // Enable permissions with test file patterns
    setProtectedPatterns(ctx.root, ["*.spec.*"]);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns for spec files');

    // Create an existing test file that the agent will modify
    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("existing tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // Mock agent modifies the existing test file
    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified tests", () => { /* changed */ });\n' },
    ]);

    // Use --follow so that lazy start waits for the mock supervisor to finish,
    // then reconciles (processes response.json → creates agent turn, sets status)
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(result);

    // Verify violations are stored on the push-back turn (the FINAL re-detected set)
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = violationTurn(turns);
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations).toBeDefined();
    expect(agentTurn!.violations!.length).toBe(1);
    expect(agentTurn!.violations![0].file).toBe('test.spec.ts');
    expect(agentTurn!.violations![0].status).toBe('pending');

    // The WORK turn carries NO violations and no violation text.
    const workTurn = turns.find(t => t.role === 'agent');
    expect(workTurn!.violations ?? []).toHaveLength(0);
    expect(workTurn!.content).not.toContain('## Permission Violations');

    // INVARIANT: Tasks with violations transition to 'conflict', not 'blocked'.
    // This makes permission violations visible at a glance in task listings.
    const status = readTaskStatus(ctx.root, taskId);
    expect(status).toBe('conflict');
  });

  // INVARIANT: Adding new test files is allowed — pure additions don't violate permissions.
  // Agents should be free to create new tests without triggering violations.
  test('allows pure additions to test files without violations', async () => {
    // Enable permissions with test file patterns
    setProtectedPatterns(ctx.root, ["test/**"]);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns for test dir');

    const taskId = await createTask(ctx, 'Add tests', 'Write new tests');

    // Mock agent creates a brand new test file (pure addition)
    const mockFiles = JSON.stringify([
      { path: 'test/new-feature.test.ts', content: 'describe("new feature", () => { test("works", () => {}); });\n' },
    ]);

    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(result);

    // Verify no violations on the agent turn
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations).toBeUndefined();

    // No violations → no violation text anywhere
    expect(agentTurn!.content).not.toContain('## Permission Violations');

    // No violations means task should be in 'blocked', not 'conflict'
    const status = readTaskStatus(ctx.root, taskId);
    expect(status).toBe('blocked');
  });

  // INVARIANT: protected files are protected by DEFAULT — neither approving nor
  // reverting is inferred. Omitting both flags on a conflict task is an ERROR, and
  // --no-approve-files is the explicit way to revert every violated file.
  //
  // This test previously asserted the opposite ("omission reverts all"), encoding
  // the pre-fix-unblock-conflict-guard behavior. The guard that superseded it
  // shipped in da2b1d0c, was silently dropped by the v0.11 daemon-lifecycle-rpc
  // refactor (leaving the help text describing a guard that no longer existed),
  // and is restored by fix-violation-turn-detection. Approve-by-omission destroys
  // protected files the reviewer never ruled on — the destructive direction.
  test('unblock refuses without a decision, and --no-approve-files reverts all', async () => {
    // Set up protected pattern and existing file
    setProtectedPatterns(ctx.root, ["*.spec.*"]);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    const originalContent = 'describe("existing tests", () => {});\n';
    writeFileSync(join(ctx.root, 'test.spec.ts'), originalContent);
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // Mock agent modifies the protected file
    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified tests", () => { /* changed */ });\n' },
    ]);

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(startResult);

    // Verify task is in conflict with pending violations
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // Unblock with NEITHER flag → refused, nothing touched.
    const refused = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Fix the issue without modifying tests', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    expectFailure(refused);
    expectError(refused, 'file permission violation');
    expectError(refused, 'test.spec.ts');
    // Prose approval is not a channel — the incident's unblock said it was
    // approving the files while passing no flag at all.
    expectError(refused, 'feedback text has no effect');
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // Unblock with the explicit revert-all → all violations rejected and reverted.
    const unblockResult = await ctx.lazyMocked(
      [
        'unblock', taskId, '--message', 'Fix the issue without modifying tests',
        '--no-approve-files', '--follow',
      ],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(unblockResult);

    // Verify violations are marked as rejected
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent' && t.violations?.length);
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations!.every(v => v.status === 'rejected')).toBe(true);

    // Verify the file was reverted in the worktree
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const fileContent = readFileSync(join(worktreePath, 'test.spec.ts'), 'utf-8');
    expect(fileContent).toBe(originalContent);
  });

  // INVARIANT (violations-come-from-the-violation-turn): the CLI guard must read
  // violations from the latest agent turn that HAS them, not from the latest agent
  // turn. A supervised push-back or maintained-files nudge adds a further agent
  // turn carrying no violations, and the naive `.pop()` the guard used to do landed
  // on that nudge reply, saw none, and let the unblock through with no decision —
  // after which the daemon (which reads the right turn) reverted every file.
  //
  // The nudge turn is the whole point of this test: a fixture whose violation turn
  // is last passes even against the buggy code. Real nudge turns need a live
  // supervisor, so the shape is seeded directly into storage.
  test('unblock is still refused when nudge turns follow the violation turn', async () => {
    setProtectedPatterns(ctx.root, ["*.spec.*"]);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("existing tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified tests", () => { /* changed */ });\n' },
    ]);
    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(startResult);
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // Seed the incident's shape: the violation turn, then a permission push-back
    // exchange and a maintained-files exchange whose agent replies carry none.
    const turns = readTurns(ctx.root, taskId);
    expect(violationTurn(turns)).toBeDefined();
    const nextSeq = Math.max(...turns.map(t => Number(t.sequence ?? 0))) + 1;
    writeTurns(ctx.root, taskId, [
      ...turns,
      { role: 'human', content: '## Permission Violation Review', turn_type: 'nudge', sequence: nextSeq },
      { role: 'agent', content: 'push-back reply', turn_type: 'nudge', sequence: nextSeq + 1 },
      { role: 'human', content: '## Maintained Files Review', turn_type: 'nudge', sequence: nextSeq + 2 },
      { role: 'agent', content: 'maintain reply', turn_type: 'nudge', sequence: nextSeq + 3 },
    ]);
    // The naive lookup this replaced finds nothing on this input.
    const seeded = readTurns(ctx.root, taskId);
    expect(seeded.filter(t => t.role === 'agent').pop()?.violations ?? []).toHaveLength(0);

    // Against the pre-fix guard this SUCCEEDS and the file is silently reverted.
    const refused = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'approving the test changes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    expectFailure(refused);
    expectError(refused, 'file permission violation');
    expectError(refused, 'test.spec.ts');
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');
  });

  // INVARIANT: --approve-file allows selective approval of violated files.
  // Only non-approved files are reverted; approved files keep their changes.
  test('unblock with --approve-file approves specified files and reverts others', async () => {
    // Set up protected pattern and two existing files
    setProtectedPatterns(ctx.root, ["*.spec.*"]);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    const originalA = 'describe("tests A", () => {});\n';
    const originalB = 'describe("tests B", () => {});\n';
    writeFileSync(join(ctx.root, 'a.spec.ts'), originalA);
    writeFileSync(join(ctx.root, 'b.spec.ts'), originalB);
    ctx.git('add', 'a.spec.ts', 'b.spec.ts');
    ctx.git('commit', '-m', 'Add test files');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // Mock agent modifies both protected files
    const mockFiles = JSON.stringify([
      { path: 'a.spec.ts', content: 'describe("modified A", () => {});\n' },
      { path: 'b.spec.ts', content: 'describe("modified B", () => {});\n' },
    ]);

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(startResult);

    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // Approve a.spec.ts, reject b.spec.ts (default)
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--approve-file', 'a.spec.ts', '--message', 'Approved A only', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(unblockResult);

    // Verify violation statuses
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent' && t.violations?.length);
    expect(agentTurn).toBeDefined();
    const violationA = agentTurn!.violations!.find(v => v.file === 'a.spec.ts');
    const violationB = agentTurn!.violations!.find(v => v.file === 'b.spec.ts');
    expect(violationA!.status).toBe('approved');
    expect(violationB!.status).toBe('rejected');

    // Verify b.spec.ts was reverted but a.spec.ts kept agent changes
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    const contentA = readFileSync(join(worktreePath, 'a.spec.ts'), 'utf-8');
    const contentB = readFileSync(join(worktreePath, 'b.spec.ts'), 'utf-8');
    expect(contentA).toBe('describe("modified A", () => {});\n');
    expect(contentB).toBe(originalB);
  });

  // INVARIANT: Accept refuses tasks with pending (unresolved) violations.
  // All violations must be explicitly approved or rejected before merging.
  test('accept refuses task with pending violations', async () => {
    // Set up protected pattern and existing file
    setProtectedPatterns(ctx.root, ["*.spec.*"]);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // Mock agent modifies protected file → violations pending
    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified", () => {});\n' },
    ]);

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(startResult);

    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // Try to accept — should fail because violations are pending
    const acceptResult = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(acceptResult);
    expectError(acceptResult, 'unresolved file permission violations');
  });

  // INVARIANT: Accept succeeds after violations are resolved (approved or rejected).
  test('accept succeeds after violations are resolved via unblock', async () => {
    // Set up protected pattern and existing file
    setProtectedPatterns(ctx.root, ["*.spec.*"]);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // Mock agent modifies protected file AND a non-protected file
    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified", () => {});\n' },
      { path: 'fix.ts', content: 'export const fix = true;\n' },
    ]);

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(startResult);

    // Resolve violations by unblocking. There is no default — the revert has to be
    // asked for explicitly (--no-approve-files); omitting it is refused.
    // Second mock turn creates another non-protected file so the branch has real changes to merge.
    const mockFiles2 = JSON.stringify([
      { path: 'fix2.ts', content: 'export const fix2 = true;\n' },
    ]);
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Fix without modifying tests', '--no-approve-files', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles2 } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(unblockResult);

    // Now accept should work — violations are resolved.
    // Mocked: accept generates a merge description via a one-shot agent call.
    const acceptResult = await ctx.lazyMocked(['accept', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {});
    expectSuccess(acceptResult);
  });

  // INVARIANT: Accept with --approve-file covering ALL pending violations succeeds.
  // This allows direct accept of conflict tasks without an unnecessary unblock round-trip.
  test('accept with --approve-file covering all violations succeeds', async () => {
    setProtectedPatterns(ctx.root, ["*.spec.*"]);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // Mock agent modifies protected file AND a non-protected file (so there's something to merge)
    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified", () => {});\n' },
      { path: 'fix.ts', content: 'export const fix = true;\n' },
    ]);

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(startResult);
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // Accept with --approve-file covering the violated file → should succeed
    // Mocked: accept generates a merge description via a one-shot agent call.
    const acceptResult = await ctx.lazyMocked(
      ['accept', taskId, '--approve-file', 'test.spec.ts', '--yes'],
      MOCK_CLAUDE_SUCCESS,
      {},
    );
    expectSuccess(acceptResult);
    expectOutput(acceptResult, 'Approved 1 protected file change(s)');

    // Verify violations are marked as approved
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent' && t.violations?.length);
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations!.every(v => v.status === 'approved')).toBe(true);
  });

  // INVARIANT: Accept with partial --approve-file refuses with specific missing files.
  // Partial approval at accept time is not allowed — all or nothing.
  test('accept with partial --approve-file fails listing missing files', async () => {
    setProtectedPatterns(ctx.root, ["*.spec.*"]);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'a.spec.ts'), 'describe("A", () => {});\n');
    writeFileSync(join(ctx.root, 'b.spec.ts'), 'describe("B", () => {});\n');
    ctx.git('add', 'a.spec.ts', 'b.spec.ts');
    ctx.git('commit', '-m', 'Add test files');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    const mockFiles = JSON.stringify([
      { path: 'a.spec.ts', content: 'describe("modified A", () => {});\n' },
      { path: 'b.spec.ts', content: 'describe("modified B", () => {});\n' },
    ]);

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(startResult);
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // Approve only a.spec.ts — b.spec.ts is missing → should fail
    const acceptResult = await ctx.lazy([
      'accept', taskId, '--approve-file', 'a.spec.ts', '--yes',
    ]);
    expectFailure(acceptResult);
    expectError(acceptResult, 'Missing approval');
    expectError(acceptResult, 'b.spec.ts');
  });

  // INVARIANT: User-specified protected patterns in lazy.toml are respected
  // and merged with built-in defaults.
  test('respects custom protected patterns from lazy.toml', async () => {
    // Add a custom protected pattern to lazy.toml
    setProtectedPatterns(ctx.root, ["docs/**"]);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Add custom protected pattern');

    // Create an existing docs file
    mkdirSync(join(ctx.root, 'docs'), { recursive: true });
    writeFileSync(join(ctx.root, 'docs', 'api.md'), '# API Docs\n');
    ctx.git('add', 'docs/api.md');
    ctx.git('commit', '-m', 'Add docs file');

    const taskId = await createTask(ctx, 'Update docs', 'Update the docs');

    // Mock agent modifies existing content in the docs file (not a pure addition).
    // Changing "# API Docs" to "# Updated API Docs" triggers a violation because
    // the original line is removed and replaced — isPureAddition returns false.
    const mockFiles = JSON.stringify([
      { path: 'docs/api.md', content: '# Updated API Docs\n' },
    ]);

    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(result);

    // Verify the custom pattern triggered a violation (on the push-back turn)
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = violationTurn(turns);
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations).toBeDefined();
    expect(agentTurn!.violations!.length).toBe(1);
    expect(agentTurn!.violations![0].file).toBe('docs/api.md');

    // The work turn carries no violations.
    expect(turns.find(t => t.role === 'agent')!.violations ?? []).toHaveLength(0);
  });

  // INVARIANT: Push-back fires when violations are detected, giving the agent one chance
  // to self-correct. If the agent reverts the file, no violations remain in the output.
  test('push-back allows agent to revert violation and clear it', async () => {
    setProtectedPatterns(ctx.root, ["*.spec.*"]);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("existing tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // Mock agent modifies the protected file
    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified tests", () => { /* changed */ });\n' },
    ]);

    // Mock push-back: agent reverts the file
    const pushbackReverts = JSON.stringify(['test.spec.ts']);

    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {
        env: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FILES: mockFiles,
          LAZY_MOCK_PUSHBACK_REVERTS: pushbackReverts,
          LAZY_MOCK_PUSHBACK_RESPONSE: 'I reverted the test file change as it was unnecessary.',
        },
      },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(result);

    // Verify NO violations remain on the work turn (agent reverted)
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations).toBeUndefined();

    // The work turn's content is CLEAN — the push-back exchange is NOT appended.
    expect(agentTurn!.content).not.toContain('## Permission Violation Review');
    expect(agentTurn!.content).not.toContain('I reverted the test file change as it was unnecessary.');

    // The push-back is recorded as its own discrete nudge turn pair so reviewers
    // can see the agent's justification.
    const nudgeTurns = turns.filter(t => t.turn_type === 'nudge');
    expect(nudgeTurns).toHaveLength(2);
    expect(nudgeTurns[0].role).toBe('human');
    expect(nudgeTurns[0].content).toContain('## Permission Violation Review');
    expect(nudgeTurns[1].role).toBe('agent');
    expect(nudgeTurns[1].content).toContain('I reverted the test file change as it was unnecessary.');

    // No violations means task goes to 'blocked', not 'conflict'
    const status = readTaskStatus(ctx.root, taskId);
    expect(status).toBe('blocked');
  });

  // INVARIANT: When push-back fires and the agent keeps the file, violations persist
  // and the task enters 'conflict' status with the agent's justification.
  test('push-back with agent keeping changes preserves violations with justification', async () => {
    setProtectedPatterns(ctx.root, ["*.spec.*"]);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("existing tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified tests", () => { /* changed */ });\n' },
    ]);

    // Mock push-back: agent keeps the file, provides justification
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      {
        env: {
          LAZY_MOCK_SHOULD_COMMIT: '1',
          LAZY_MOCK_FILES: mockFiles,
          // No LAZY_MOCK_PUSHBACK_REVERTS → agent keeps all changes
          LAZY_MOCK_PUSHBACK_RESPONSE: 'The test file change is essential for the bug fix.',
        },
      },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(result);

    // Violations persist on the PUSH-BACK turn (the final re-detected set), not
    // the work turn.
    const turns = readTurns(ctx.root, taskId);
    const violTurn = violationTurn(turns);
    expect(violTurn).toBeDefined();
    expect(violTurn!.violations!.length).toBe(1);
    expect(violTurn!.violations![0].file).toBe('test.spec.ts');

    // The WORK turn carries no violations and no push-back text.
    const workTurn = turns.find(t => t.role === 'agent');
    expect(workTurn!.violations ?? []).toHaveLength(0);
    expect(workTurn!.content).not.toContain('## Permission Violation Review');
    expect(workTurn!.content).not.toContain('The test file change is essential for the bug fix.');

    // Push-back recorded as its own discrete nudge turn pair with the justification.
    const nudgeTurns = turns.filter(t => t.turn_type === 'nudge');
    expect(nudgeTurns).toHaveLength(2);
    expect(nudgeTurns[0].content).toContain('## Permission Violation Review');
    expect(nudgeTurns[1].content).toContain('The test file change is essential for the bug fix.');

    // Violations remain → task goes to 'conflict'
    const status = readTaskStatus(ctx.root, taskId);
    expect(status).toBe('conflict');
  });

  // INVARIANT: Push-back only happens once per turn (no infinite loop).
  // Even after push-back, the result is final and the turn completes.
  test('push-back happens only once — no re-push-back after agent response', async () => {
    setProtectedPatterns(ctx.root, ["*.spec.*"]);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("existing tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    const mockFiles = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified tests", () => { /* changed */ });\n' },
    ]);

    // Agent doesn't revert — violations remain after push-back
    const result = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(result);

    // The turn completed (response was written) — push-back happened exactly once.
    // Exactly ONE push-back turn pair exists (no re-push-back loop), and its
    // re-detected violations remain.
    const turns = readTurns(ctx.root, taskId);
    const agentTurn = violationTurn(turns);
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations!.length).toBe(1);
    expect(turns.filter(t => t.turn_type === 'nudge' && t.content.includes('## Permission Violation Review'))).toHaveLength(1);

    // Task completed the turn and moved to conflict (not stuck in a loop)
    const status = readTaskStatus(ctx.root, taskId);
    expect(status).toBe('conflict');
  });

  // INVARIANT: Files created by the task itself are exempt from permission violations,
  // even when modified in a later turn. The branch_point_sha plumbing ensures that
  // detectViolations can distinguish task-created files from pre-existing ones across turns.
  test('no violation when file created in turn 1 is modified in turn 2', async () => {
    // Enable permissions with test dir pattern
    setProtectedPatterns(ctx.root, ["test/**/*.ts"]);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns for test dir');

    const taskId = await createTask(ctx, 'Add and refine tests', 'Write tests then refine them');

    // Turn 1: agent creates a brand new test file matching the protected pattern
    const mockFilesTurn1 = JSON.stringify([
      { path: 'test/feature.test.ts', content: 'describe("feature", () => {\n  test("works", () => { expect(true).toBe(true); });\n});\n' },
    ]);

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFilesTurn1 } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(startResult);

    // Verify turn 1: no violations (file is new — pure addition)
    let turns = readTurns(ctx.root, taskId);
    let agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations).toBeUndefined();
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    // Turn 2: agent modifies the same file (changes existing lines — NOT a pure addition)
    const mockFilesTurn2 = JSON.stringify([
      { path: 'test/feature.test.ts', content: 'describe("feature", () => {\n  test("works correctly", () => { expect(1 + 1).toBe(2); });\n  test("handles edge case", () => { expect(null).toBeNull(); });\n});\n' },
    ]);

    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Refine the tests', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFilesTurn2 } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(unblockResult);

    // Verify turn 2: still no violations — the file was created by this task (not pre-existing).
    // branch_point_sha ensures detectViolations exempts it even though it's a modification.
    turns = readTurns(ctx.root, taskId);
    const secondAgentTurn = turns.filter(t => t.role === 'agent')[1];
    expect(secondAgentTurn).toBeDefined();
    expect(secondAgentTurn!.violations).toBeUndefined();

    // No violations → task stays in 'blocked', not 'conflict'
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  });

  // INVARIANT: Violations are detected on unblock turns, not just start turns.
  // protected_patterns must be passed through unblock commands to the supervisor.
  test('detects violations on unblock turns', async () => {
    // Enable permissions with test file patterns
    setProtectedPatterns(ctx.root, ["*.spec.*"]);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns for spec files');

    // Create an existing test file that the agent will modify
    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("existing tests", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Fix something', 'Fix the bug');

    // First turn: agent does NOT modify protected files (no violation)
    const mockFilesFirstTurn = JSON.stringify([
      { path: 'src/main.ts', content: 'console.log("first turn - safe change");\n' },
    ]);

    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFilesFirstTurn } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(startResult);

    // Verify first turn has no violations and status is 'blocked'
    let turns = readTurns(ctx.root, taskId);
    let agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.violations).toBeUndefined();
    let status = readTaskStatus(ctx.root, taskId);
    expect(status).toBe('blocked');

    // Second turn: agent modifies protected file (should trigger violation)
    const mockFilesSecondTurn = JSON.stringify([
      { path: 'test.spec.ts', content: 'describe("modified tests", () => { /* changed */ });\n' },
    ]);

    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Now modify the test file', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFilesSecondTurn } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(unblockResult);

    // Verify the second turn's push-back carries the violations (detected on the
    // unblock turn, re-detected after push-back).
    turns = readTurns(ctx.root, taskId);
    const secondAgentTurn = violationTurn(turns);
    expect(secondAgentTurn).toBeDefined();
    expect(secondAgentTurn!.violations).toBeDefined();
    expect(secondAgentTurn!.violations!.length).toBe(1);
    expect(secondAgentTurn!.violations![0].file).toBe('test.spec.ts');
    expect(secondAgentTurn!.violations![0].status).toBe('pending');

    // Violation text is NOT in the turn content — violations live in the structured field
    expect(secondAgentTurn!.content).not.toContain('## Permission Violations');

    // INVARIANT: Task transitions to 'conflict' after unblock with violations
    status = readTaskStatus(ctx.root, taskId);
    expect(status).toBe('conflict');
  });
});
