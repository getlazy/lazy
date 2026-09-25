/**
 * E2E coverage for the accept check and the reverted-protected-files report.
 *
 * THE INCIDENT (task `single-version-image-freshness`, August 2026): a human
 * rejected six protected test files at review, lazy reverted them, and the
 * agent's very next turn was titled "Blocked: the reverted state does not
 * compile" and named every broken file. The task was accepted anyway — nothing
 * on the accept path reads a turn title — and `test/mocks/claude.ts` (the
 * `--preload` for every e2e suite) landed on the target branch importing a
 * constant that no longer existed.
 *
 * Two mechanisms came out of it, and both are exercised here:
 *  1. `[automation] accept_check` — the project's own command, run in the TASK
 *     worktree before the merge; a non-zero exit refuses the accept.
 *  2. Reverted protected files are NAMED at accept time. A reverted file is
 *     simply absent from the diff, which reads identically to "the task never
 *     touched it".
 *
 * Harness notes: this suite is daemonless. `startAndReconcile` + the
 * `disablePreAccept` fixture are what make a daemonless accept possible (see
 * test/e2e/accept-content-less-turn.test.ts, same shape) — accept only refuses
 * daemonless when nothing has moved the task out of `working`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectError, expectOutput } from '../helpers/assertions';
import {
  createTask,
  disablePreAccept,
  setProtectedPatterns,
  startAndReconcile,
  MOCK_CLAUDE_SUCCESS,
} from '../helpers/fixtures';
import { runReconcile } from '../helpers/reconcile';
import { worktreePathFor, readTurns, writeTurns, readTaskStatus } from '../helpers/storage';
import { seedFinal } from '../helpers/final';

/**
 * Turn the gate on by rewriting the commented template key — never by
 * overwriting lazy.toml, which would throw away the `external_path` `lazy init`
 * wrote and leave the command reading an empty store.
 */
function setAcceptCheck(root: string, command: string, timeoutSecs?: number): void {
  const path = join(root, 'lazy.toml');
  const before = readFileSync(path, 'utf-8');
  const replacement = timeoutSecs === undefined
    ? `accept_check = ${JSON.stringify(command)}`
    : `accept_check = ${JSON.stringify(command)}\naccept_check_timeout = ${timeoutSecs}`;
  const after = before.replace('# accept_check = "bun run typecheck"', replacement);
  if (after === before) {
    throw new Error('lazy.toml has no `# accept_check` template line to enable — did the template change?');
  }
  writeFileSync(path, after);
}

/** A started task with one extra commit, so accept has something to merge. */
async function taskReadyToAccept(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');
  await startAndReconcile(ctx, taskId);

  const worktreePath = worktreePathFor(ctx.root, taskId);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
  expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
  expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);

  // Fixture setup, not the subject (see test/helpers/final.ts). Daemonless
  // suite, so the final is seeded at the storage level.
  await seedFinal(ctx, taskId);

  return taskId;
}

describe('lazy accept — the accept check', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // This suite asserts on the accept check, not on pre-accept; daemonless
    // there is no runner to execute that extra agent turn.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: nothing that merely SAYS a task is broken is load-bearing on
  // accept — the check is, because accept runs it and reads the exit code.
  test('refuses the merge when the task tree does not build', async () => {
    const taskId = await taskReadyToAccept(ctx, 'Broken tree');
    setAcceptCheck(ctx.root, 'echo "src/x.ts(3,7): error TS2551: nope" >&2; exit 2');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(result);
    // The refusal is stated in MERGE terms, names the branch it would break,
    // carries the command's own output, and names the override.
    expectError(result, 'does not build');
    expectError(result, 'would break');
    expectError(result, 'error TS2551');
    expectError(result, '--allow-broken');

    // The merge really did not happen.
    expect(readTaskStatus(ctx.root, taskId)).not.toBe('complete');
  });

  // INVARIANT: the override is explicit, named, and never silent — the failure
  // is still reported, as a warning. There is no config key that turns the gate
  // into a pass.
  test('--allow-broken merges anyway and still reports the failure', async () => {
    const taskId = await taskReadyToAccept(ctx, 'Broken but wanted');
    setAcceptCheck(ctx.root, 'echo "boom" >&2; exit 2');

    const result = await ctx.lazy(['accept', taskId, '--yes', '--allow-broken']);
    expectSuccess(result);
    expectOutput(result, 'accepted');
    // The fact survives the override.
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('Accept check FAILED');
    expect(combined).toContain('--allow-broken');
  });

  // INVARIANT: a passing check changes nothing about accept, and the command
  // runs in the TASK's worktree — feature.txt exists only there.
  test('a task that passes the check is accepted normally, and the check runs in the task worktree', async () => {
    const taskId = await taskReadyToAccept(ctx, 'Healthy tree');
    expect(existsSync(join(ctx.root, 'feature.txt'))).toBe(false);
    setAcceptCheck(ctx.root, 'test -f feature.txt');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted');
  });

  // INVARIANT: exit 127 means the command never ran, so NOTHING was verified.
  // Reporting that as a compile failure would send the reviewer hunting a type
  // error that does not exist — and passing it would be the very defect the
  // gate exists to prevent, so it refuses with its own wording.
  test('a check that cannot run (exit 127) refuses, and says so in those words', async () => {
    const taskId = await taskReadyToAccept(ctx, 'Missing interpreter');
    setAcceptCheck(ctx.root, 'lazy-no-such-binary-anywhere --noEmit');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(result);
    expectError(result, 'COULD NOT RUN');
    expectError(result, 'exit 127');
    // Explicitly NOT reported as a build failure.
    expect(result.stdout + result.stderr).not.toContain('does not build');
  });

  // INVARIANT: a check that never answered is not a pass.
  test('a check that times out refuses', async () => {
    const taskId = await taskReadyToAccept(ctx, 'Hanging check');
    setAcceptCheck(ctx.root, 'sleep 30', 1);

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(result);
    expectError(result, 'did not finish');
  });

  // INVARIANT: lazy never invents a build command for a project that configured
  // none — it says the step was skipped, and accepts.
  test('with no accept_check configured the phase is skipped, not guessed', async () => {
    const taskId = await taskReadyToAccept(ctx, 'No gate configured');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted');
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('Accept check');
    expect(combined).toContain('skipped');
  });

  // The gate must run a REAL compiler, not merely exit 0. This drives tsc over
  // a file with a deliberate type error and asserts the diagnostic reaches the
  // refusal. Uses lazy's own typescript via `bun` (never node_modules/.bin,
  // whose `#!/usr/bin/env node` shim exits 127 where node is absent — exactly
  // the trap that made the project's own post-turn check verify nothing).
  const tscLib = join(process.cwd(), 'node_modules', 'typescript', 'lib', 'tsc.js');
  test.skipIf(!existsSync(tscLib))('surfaces a real compiler diagnostic', async () => {
    const taskId = await createTask(ctx, 'Real typecheck', 'Some work');
    await startAndReconcile(ctx, taskId);
    // Fixture setup, not the subject (see test/helpers/final.ts). Daemonless
    // suite, so the final is seeded at the storage level.
    await seedFinal(ctx, taskId);

    const worktreePath = worktreePathFor(ctx.root, taskId);
    writeFileSync(join(worktreePath, 'broken.ts'), 'const n: number = "not a number";\n');
    expect(ctx.git('-C', worktreePath, 'add', 'broken.ts').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add broken file').exitCode).toBe(0);

    setAcceptCheck(ctx.root, `bun ${tscLib} --noEmit --strict broken.ts`);

    const refused = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(refused);
    // A genuine tsc diagnostic, not just a non-zero exit.
    expectError(refused, 'broken.ts');
    expectError(refused, 'TS2322');

    // Remove the error and the same command lets the accept through.
    writeFileSync(join(worktreePath, 'broken.ts'), 'const n: number = 1;\nexport { n };\n');
    expect(ctx.git('-C', worktreePath, 'add', 'broken.ts').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Fix the type error').exitCode).toBe(0);

    const accepted = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(accepted);
    expectOutput(accepted, 'accepted');
  }, 60000);
});

describe('lazy accept — reverted protected files', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a protected file that was REVERTED is absent from the diff —
  // indistinguishable from "the task never touched it". Accept says it
  // outright. This reports; it never refuses.
  //
  // HISTORICAL RECORDS ONLY since move-file-approval-to-accept: nothing in lazy
  // reverts a protected file any more, so the `rejected` record and the revert
  // commit are SEEDED here rather than produced by an unblock. That is the
  // state this notice exists for — a session recorded under the old behaviour —
  // and it must keep working for as long as such sessions can be accepted.
  test('accept names protected files that were reverted during the task', async () => {
    setProtectedPatterns(ctx.root, ['*.spec.*']);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns for spec files');

    writeFileSync(join(ctx.root, 'mocks.spec.ts'), 'describe("existing tests", () => {});\n');
    ctx.git('add', 'mocks.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Touch a protected test', 'Fix the bug');

    const mockFiles = JSON.stringify([
      { path: 'mocks.spec.ts', content: 'describe("modified tests", () => {});\n' },
    ]);
    const started = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(started);
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // Seed the old behaviour's end state: the record reads `rejected` and the
    // file is back at its base content on the branch.
    const seeded = readTurns(ctx.root, taskId).map(t => (
      t.violations?.length
        ? { ...t, violations: t.violations.map(v => ({ ...v, status: 'rejected' as const })) }
        : t
    ));
    writeTurns(ctx.root, taskId, seeded);

    const worktreePath = worktreePathFor(ctx.root, taskId);
    writeFileSync(join(worktreePath, 'mocks.spec.ts'), 'describe("existing tests", () => {});\n');
    expect(ctx.git('-C', worktreePath, 'add', 'mocks.spec.ts').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Revert protected file changes (rejected by reviewer)').exitCode).toBe(0);

    const rejected = readTurns(ctx.root, taskId)
      .flatMap(t => t.violations ?? [])
      .filter(v => v.status === 'rejected');
    expect(rejected.map(v => v.file)).toContain('mocks.spec.ts');
    // Fixture setup, not the subject (see test/helpers/final.ts). Daemonless
    // suite, so the final is seeded at the storage level — after the revert
    // turn seeding above, since that write replaces the turn list.
    await seedFinal(ctx, taskId);

    // Give the branch a surviving change: after the revert its only edit is
    // gone, and accept rightly refuses a branch with nothing to merge.
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
    expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);

    // The diff no longer mentions the file at all — which is the whole problem.
    const diff = await ctx.lazy(['diff', taskId]);
    expectSuccess(diff);
    expect(diff.stdout).not.toContain('mocks.spec.ts');

    // Accept says it anyway, BEFORE the merge, and still accepts.
    const accepted = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(accepted);
    const combined = accepted.stdout + accepted.stderr;
    expect(combined).toContain('protected file');
    expect(combined).toContain('reverted during this task');
    expect(combined).toContain('mocks.spec.ts');
    expectOutput(accepted, 'accepted');
  });

  // The other half of the same reporting rule: when the reviewer APPROVES a
  // protected file at accept, that decision is stated too. It used to be
  // silent — the approval happens in accept's preflight, and only the
  // preflight's own result carries the warning, which the CLI dropped.
  test('accept names protected files approved with --approve-file', async () => {
    setProtectedPatterns(ctx.root, ['*.spec.*']);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns for spec files');

    writeFileSync(join(ctx.root, 'mocks.spec.ts'), 'describe("existing tests", () => {});\n');
    ctx.git('add', 'mocks.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await createTask(ctx, 'Touch a protected test', 'Fix the bug');

    const mockFiles = JSON.stringify([
      { path: 'mocks.spec.ts', content: 'describe("modified tests", () => {});\n' },
      { path: 'fix.ts', content: 'export const fix = true;\n' },
    ]);
    const started = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--follow'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: mockFiles } },
    );
    await runReconcile(ctx.root, ctx.protocolBase);
    expectSuccess(started);
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');
    // Fixture setup, not the subject (see test/helpers/final.ts) — seeded even
    // in conflict state: the approval path below must keep working when a
    // standing final is present. Daemonless suite, storage-level seed.
    await seedFinal(ctx, taskId);

    const accepted = await ctx.lazy(['accept', taskId, '--approve-file', 'mocks.spec.ts', '--yes']);
    expectSuccess(accepted);
    const combined = accepted.stdout + accepted.stderr;
    expect(combined).toContain('Approved 1 protected file change(s)');
    expect(combined).toContain('mocks.spec.ts');
  });

  // A task that touched nothing protected must not gain a phantom notice.
  test('a task with no reverted files says nothing about reverts', async () => {
    const taskId = await createTask(ctx, 'Ordinary task', 'Some work');
    await startAndReconcile(ctx, taskId);
    // Fixture setup, not the subject (see test/helpers/final.ts). Daemonless
    // suite, so the final is seeded at the storage level.
    await seedFinal(ctx, taskId);

    const worktreePath = worktreePathFor(ctx.root, taskId);
    writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
    expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);

    const accepted = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(accepted);
    expect(accepted.stdout + accepted.stderr).not.toContain('reverted during this task');
  });
});
