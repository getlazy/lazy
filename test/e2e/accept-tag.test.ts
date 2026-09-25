import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';
import { readTaskStatus, readTaskJson, readSessionJson, setTaskMetadata } from '../helpers/storage';

/**
 * Resolve the tasks directory for the test project. Test projects init with
 * external storage (external_path in lazy.toml), so tasks live outside the
 * repo — reading ctx.root/.lazy/tasks finds nothing. Fall back to the in-repo
 * layout only when no external_path is configured. Mirrors tasksDirFor() in
 * auto-react-budget.test.ts / reconcile.test.ts.
 */
function tasksDirFor(root: string): string {
  const toml = readFileSync(join(root, 'lazy.toml'), 'utf-8');
  const m = toml.match(/^external_path\s*=\s*"(.+)"/m);
  if (m && m[1]) return join(m[1], 'tasks');
  return join(root, '.lazy', 'tasks');
}

function findFullTaskId(root: string, shortId: string): string {
  const entries = readdirSync(tasksDirFor(root));
  const match = entries.find((e: string) => e.startsWith(shortId));
  if (!match) throw new Error(`Could not find full task ID for short ID: ${shortId}`);
  return match;
}

async function createStartedTaskWithCommit(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');
  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);

  // INVARIANT: `start` launches the supervisor asynchronously under the daemon;
  // wait for the reconciler to move the task out of 'working' before accept, or
  // accept refuses ("Task X is still working"). Mirrors accept-reason / accept-gates.
  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }

  const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
  expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
  expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);
  // Fixture setup, not the subject (see test/helpers/final.ts).
  await seedFinal(ctx, taskId);
  return taskId;
}

describe('lazy accept creates the authoritative accept tag', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // INVARIANT: `start` + `accept` need a real daemon (see accept-reason /
    // accept-gates). Daemonless, the task stays 'working' and accept refuses.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT (accept-merge-is-commit-point): the tag is follow-through, after
  // the merge. A tag that cannot be written fails the accept LOUDLY (non-zero
  // exit, the step named) but never un-accepts merged work — the task is
  // `complete` with its session `accepted`, and the daemon writes the tag once
  // it can. No module mocks: the failure is a real git ref conflict.
  test('a tag that cannot be written leaves the task accepted, fails loudly, and the daemon writes it later', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Tag fails after merge');
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    // A ref UNDER the tag's name makes `git tag lazy-accept-<id>` fail (D/F conflict).
    const blocker = `refs/tags/lazy-accept-${fullTaskId}/blocker`;
    expect(ctx.git('update-ref', blocker, 'HEAD').exitCode).toBe(0);

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('accept-tag');
    expect(result.stdout + result.stderr).toContain('FAILED');
    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
    expect(readSessionJson(ctx.root, taskId)?.outcome).toBe('accepted');
    expect(ctx.git('show', 'main:feature.txt').exitCode).toBe(0);
    const owed = JSON.parse(readTaskJson(ctx.root, taskId).metadata.accept_followthrough);
    expect(owed.done).not.toContain('accept-tag');
    // Independent steps did not wait on the tag.
    expect(owed.done).toContain('cleanup');

    expect(ctx.git('update-ref', '-d', blocker).exitCode).toBe(0);
    setTaskMetadata(ctx.root, taskId, 'accept_followthrough', JSON.stringify({ ...owed, nextAttemptAt: 0 }));
    const deadline = Date.now() + 60_000;
    while (readTaskJson(ctx.root, taskId).metadata?.accept_followthrough && Date.now() < deadline) {
      await Bun.sleep(500);
    }
    expect(readTaskJson(ctx.root, taskId).metadata?.accept_followthrough ?? '').toBe('');
    expect(ctx.git('rev-parse', '--verify', `refs/tags/lazy-accept-${fullTaskId}^{commit}`).exitCode).toBe(0);
    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
  }, 120_000);

  // The accept tag `lazy-accept-<full-task-id>` is the authoritative signal the zombie
  // sweep gates on. The local driver uses the squash merge path; verify the tag is created
  // and points at the resulting commit on the target branch (main).
  test('squash accept path creates lazy-accept-<full-id> tag on the merge commit', async () => {
    const taskId = await createStartedTaskWithCommit(ctx, 'Tag on squash accept');
    const fullTaskId = findFullTaskId(ctx.root, taskId);

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);

    // Tag must exist and resolve to a commit.
    const tagSha = ctx.git('rev-parse', '--verify', `refs/tags/lazy-accept-${fullTaskId}^{commit}`);
    expect(tagSha.exitCode).toBe(0);

    // It must point at the merge commit on the target branch.
    const mainSha = ctx.git('rev-parse', 'main');
    expect(mainSha.exitCode).toBe(0);
    expect(tagSha.stdout.trim()).toBe(mainSha.stdout.trim());

    // It must be an annotated tag (carries a timestamp).
    const tagType = ctx.git('cat-file', '-t', `refs/tags/lazy-accept-${fullTaskId}`);
    expect(tagType.stdout.trim()).toBe('tag');
  });
});
