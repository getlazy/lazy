/**
 * E2E coverage: a SUBMITTED task stays submitted across a sync.
 *
 * THE BUG (engineer question, 2026-09-09: "Why does submitted go back to
 * blocked when say there is an auto-sync?"). A sync that launches a turn moves the task through
 * `working` so the merge (and any conflict resolution) can run as an agent turn,
 * and the reconciler's end-of-turn park then wrote the derived paused label —
 * `blocked`. A task with an open PR therefore left `submitted` on every sync,
 * manual or automatic: it dropped out of the submitted view, and PR-comment
 * auto-react, which is gated on `submitted`, stopped reacting to the very review
 * comments the task was waiting for. Nothing about the task had changed; a merge
 * says nothing about where it stands with its reviewer.
 *
 * The fix records the status the sync FOUND at launch and restores it at the
 * park, the way an ask turn already does (src/task/sync-restore-status.ts).
 *
 * Since then a CLEAN sync merges on the host and launches no turn at all, so
 * the task never leaves its status; that path has its own test below. The
 * sync-TURN tests force a conflict so a turn really launches and parks.
 *
 * Harness notes: daemonless, so each turn is driven with the mocked CLI (which
 * makes the in-process supervisor launch succeed and writes response.json
 * synchronously) plus an explicit `runReconcile` — only the daemon reconciles,
 * and the park under test happens there.
 *
 * `submitted` is seeded straight into storage rather than produced by a real
 * `lazy submit`: submitting needs a forge driver and a live `gh`/`glab`, and
 * none of that is what is under test here. The PR metadata is seeded alongside
 * it so the test can also assert the sync leaves the forge pointer intact.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { runReconcile } from '../helpers/reconcile';
import { readTaskJson, readTaskStatus, readTurns, setTaskMetadata, setTaskStatus } from '../helpers/storage';

describe('lazy sync restores the status it found', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // The task's first turn writes CONFLICT_FILE and advanceMain writes the same
  // path on main with different content. A CLEAN sync merges on the host and
  // launches no turn, so the task never leaves its status and the park under
  // test never runs; the conflict forces a real agent sync turn.
  const CONFLICT_FILE = 'shared.txt';

  /** Create a task, run its first turn, and reconcile it into a paused status. */
  async function startedTask(
    goal: string,
    extraFiles: Array<{ path: string; content: string }> = [],
  ): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Do work');
    const files = [{ path: CONFLICT_FILE, content: 'written on the task branch\n' }, ...extraFiles];
    const started = await ctx.lazyMocked(['start', taskId, '--yes', '--follow'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1', LAZY_MOCK_FILES: JSON.stringify(files) },
    });
    expectSuccess(started);
    await runReconcile(ctx.root, ctx.protocolBase);
    return taskId;
  }

  /** Put a CONFLICTING commit on `main`, so the sync must launch an agent turn. */
  function advanceMain(filename: string, conflict = true): void {
    ctx.git('checkout', 'main');
    writeFileSync(join(ctx.root, filename), 'landed upstream while the PR was open\n');
    ctx.git('add', filename);
    if (conflict) {
      writeFileSync(join(ctx.root, CONFLICT_FILE), `written on main (${filename})\n`);
      ctx.git('add', CONFLICT_FILE);
    }
    ctx.git('commit', '-m', `Upstream commit (${filename})`);
    ctx.git('checkout', '-');
  }

  /** Run a sync that really merges, then reconcile the turn it produced. */
  async function syncAndReconcile(taskId: string): Promise<string> {
    const result = await ctx.lazyMocked(['sync', taskId], MOCK_CLAUDE_SUCCESS);
    const output = result.stdout + result.stderr;
    // Guard the premise: a no-op or clean (host-merged) sync never launches a
    // turn, so it would prove nothing about the park.
    expect(output.includes('up to date')).toBe(false);
    expect(readTaskStatus(ctx.root, taskId)).toBe('working');
    await runReconcile(ctx.root, ctx.protocolBase);
    return output;
  }

  // INVARIANT: a sync restores the status it found. `submitted` means an open PR
  // is waiting for review — a merge into the task branch does not change that,
  // and rewriting it to `blocked` hides the PR from the review queue and turns
  // off the PR-comment auto-react that is gated on `submitted`.
  test('a submitted task is still submitted after a sync, with its PR metadata intact', async () => {
    const taskId = await startedTask('Submitted task that gets synced');

    setTaskStatus(ctx.root, taskId, 'submitted');
    setTaskMetadata(ctx.root, taskId, 'pr_number', '42');
    setTaskMetadata(ctx.root, taskId, 'pr_url', 'https://example.test/pr/42');

    advanceMain('upstream-while-submitted.txt');
    await syncAndReconcile(taskId);

    expect(readTaskStatus(ctx.root, taskId)).toBe('submitted');

    // The forge pointer is what makes `submitted` actionable — merge detection
    // and auto-react both read it. A restore that dropped it would be a
    // different way to lose the same thing.
    const metadata = readTaskJson(ctx.root, taskId).metadata ?? {};
    expect(metadata.pr_number).toBe('42');
    expect(metadata.pr_url).toBe('https://example.test/pr/42');

    // The merge really happened — this is a restore, not a sync that no-opped.
    const syncTurns = readTurns(ctx.root, taskId).filter(t => t.turn_type === 'sync');
    expect(syncTurns.length).toBeGreaterThan(0);
  }, 60_000);

  // INVARIANT: a CLEAN sync, merged on the host with no turn, leaves a
  // submitted task submitted. This is the common auto-sync path, and the one the
  // original complaint was about: a merge says nothing about the PR's review.
  test('a submitted task is still submitted after a clean host-merged sync', async () => {
    const taskId = await startedTask('Submitted task, clean sync');
    setTaskStatus(ctx.root, taskId, 'submitted');
    setTaskMetadata(ctx.root, taskId, 'pr_number', '42');
    setTaskMetadata(ctx.root, taskId, 'pr_url', 'https://example.test/pr/42');
    const nonSyncBefore = readTurns(ctx.root, taskId).filter(t => t.turn_type !== 'sync').length;

    advanceMain('clean-upstream-while-submitted.txt', false);
    const result = await ctx.lazyMocked(['sync', taskId], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);
    expect((result.stdout + result.stderr).includes('up to date')).toBe(false);

    expect(readTaskStatus(ctx.root, taskId)).toBe('submitted');
    const metadata = readTaskJson(ctx.root, taskId).metadata ?? {};
    expect(metadata.pr_number).toBe('42');
    expect(metadata.pr_url).toBe('https://example.test/pr/42');
    // No agent turn ran: nothing but (host-recorded) sync turns was added.
    expect(readTurns(ctx.root, taskId).filter(t => t.turn_type !== 'sync').length)
      .toBe(nonSyncBefore);
    // The merge really landed in the task's worktree.
    const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
    expect(readFileSync(join(worktreePath, 'clean-upstream-while-submitted.txt'), 'utf-8'))
      .toBe('landed upstream while the PR was open\n');
  }, 60_000);

  // INVARIANT: only `submitted` is restored — `blocked` stays DERIVED from the
  // pending violation set on every park (violations-are-the-source-of-truth).
  // This is the unchanged case, guarding against a restore that leaks into the
  // ordinary path and re-asserts a stale label.
  test('a blocked task is still blocked after a sync', async () => {
    const taskId = await startedTask('Blocked task that gets synced');
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

    advanceMain('upstream-while-blocked.txt');
    await syncAndReconcile(taskId);

    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  }, 60_000);

  // INVARIANT: a derived `conflict` WINS over a restored `submitted`. The
  // reviewer still owes a decision on a protected file, and `conflict` may only
  // ever be cleared by the derivation — never by a side-channel turn putting an
  // older label back. Chosen deliberately over restoring `submitted` here: the
  // label gates `lazy accept`, and losing it would let a protected-file change
  // nobody approved through the gate, which is a strictly worse failure than a
  // PR temporarily reading `conflict` instead of `submitted`.
  test('a submitted task with an undecided protected file parks in conflict, not submitted', async () => {
    // Edit the key init already wrote — appending a second [permissions] table
    // is a TOML redefinition error (see CLAUDE.md, "Storage and config in tests").
    const configPath = join(ctx.root, 'lazy.toml');
    const before = readFileSync(configPath, 'utf-8');
    const after = before.replace(/^# protected = \[.*\]$/m, 'protected = ["*.spec.*"]');
    expect(after).not.toBe(before);
    writeFileSync(configPath, after);
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable protected patterns');

    writeFileSync(join(ctx.root, 'test.spec.ts'), 'describe("existing", () => {});\n');
    ctx.git('add', 'test.spec.ts');
    ctx.git('commit', '-m', 'Add existing test file');

    const taskId = await startedTask('Submitted task with a protected edit', [
      { path: 'test.spec.ts', content: 'describe("agent edit", () => {});\n' },
    ]);
    // `conflict` here comes from the whole-branch scan behind
    // `resolveOutstandingViolations` — the protected file is in the branch and
    // nobody has decided on it. That is the authoritative source the park reads,
    // and the one the restore must not override.
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // The task is submitted anyway — a human can submit from `conflict`, and the
    // undecided file is still owed at accept.
    setTaskStatus(ctx.root, taskId, 'submitted');

    advanceMain('upstream-while-conflicted.txt');
    await syncAndReconcile(taskId);

    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');
  }, 60_000);
});
