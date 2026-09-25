import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';
import { readSessionJson, writeSessionJson, readTaskJson, writeTaskJson, worktreePathFor } from '../helpers/storage';

/**
 * `lazy clone --same-base`: a like-for-like re-run of a task, branched from the
 * exact commit the original started from and PINNED there.
 */

function newTaskId(output: string): string {
  const match = output.match(/Created task (\S+) —/);
  if (!match) throw new Error(`no task id in clone output:\n${output}`);
  // Strip ANSI colouring the theme may add.
  return match[1].replace(/\x1b\[[0-9;]*m/g, '');
}

function headOf(ctx: TestContext, cwd: string, ref = 'HEAD'): string {
  const r = ctx.git('-C', cwd, 'rev-parse', ref);
  expect(r.exitCode).toBe(0);
  return r.stdout.trim();
}

function isAncestor(ctx: TestContext, cwd: string, ancestor: string, of = 'HEAD'): boolean {
  return ctx.git('-C', cwd, 'merge-base', '--is-ancestor', ancestor, of).exitCode === 0;
}

function commitOnMain(ctx: TestContext, file: string): string {
  writeFileSync(join(ctx.root, file), `${file}\n`);
  expect(ctx.git('-C', ctx.root, 'add', file).exitCode).toBe(0);
  expect(ctx.git('-C', ctx.root, 'commit', '-m', `main: ${file}`).exitCode).toBe(0);
  return headOf(ctx, ctx.root);
}

async function startAndWait(ctx: TestContext, taskId: string): Promise<void> {
  expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
  const wait = await ctx.lazy(['wait', taskId]);
  if (wait.exitCode !== 0) throw new Error(`wait failed for ${taskId}: ${wait.stderr}\n${wait.stdout}`);
}

function commitInWorktree(ctx: TestContext, taskId: string, file: string): void {
  const wt = worktreePathFor(ctx.root, taskId);
  writeFileSync(join(wt, file), `${file}\n`);
  expect(ctx.git('-C', wt, 'add', file).exitCode).toBe(0);
  expect(ctx.git('-C', wt, 'commit', '-m', `work: ${file}`).exitCode).toBe(0);
}

describe('lazy clone --same-base (with daemon)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // start/unblock/accept need the reconciler to move tasks out of `working`.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('a clone of a COMPLETED task starts at its start commit, stays pinned through turns and upstream accepts, and still accepts', async () => {
    // The original: started, worked on, accepted.
    const original = await createTask(ctx, 'Original work', 'Do the thing');
    await startAndWait(ctx, original);
    const originalStart = readSessionJson(ctx.root, original)!.git_start_sha as string;
    expect(originalStart).toMatch(/^[0-9a-f]{40}$/);
    commitInWorktree(ctx, original, 'original.txt');
    await seedFinal(ctx, original);
    expectSuccess(await ctx.lazy(['accept', original, '--reason', 'done']));

    // Main moves on after the original started.
    const mainAfter = commitOnMain(ctx, 'later-on-main.txt');
    expect(mainAfter).not.toBe(originalStart);

    const cloned = await ctx.lazy(['clone', original, '--same-base', '--model', 'claude-sonnet-5']);
    expectSuccess(cloned);
    expectOutput(cloned, 'Pinned to:');
    expectOutput(cloned, originalStart.substring(0, 12));
    const clone = newTaskId(cloned.stdout);
    expect(readTaskJson(ctx.root, clone).model).toBe('claude-sonnet-5');

    await startAndWait(ctx, clone);
    const wt = worktreePathFor(ctx.root, clone);

    // The branch starts at the ORIGINAL's start commit, not main's current head.
    expect(readSessionJson(ctx.root, clone)!.git_start_sha).toBe(originalStart);
    expect(headOf(ctx, wt, 'HEAD~1')).toBe(originalStart); // HEAD = "Initialize task" commit
    expect(isAncestor(ctx, wt, mainAfter)).toBe(false);

    // INVARIANT: nothing but an explicit human `lazy sync` merges the parent
    // into a pinned clone — not an upstream accept's auto-sync, not the next
    // turn. One silent merge destroys the like-for-like comparison unnoticed.
    const sibling = await createTask(ctx, 'Unrelated sibling', 'Other work');
    await startAndWait(ctx, sibling);
    commitInWorktree(ctx, sibling, 'sibling.txt');
    await seedFinal(ctx, sibling);
    expectSuccess(await ctx.lazyMocked(['accept', sibling, '--reason', 'ok'], MOCK_CLAUDE_SUCCESS));

    expectSuccess(await ctx.lazyMocked(['unblock', clone, '--message', 'keep going'], MOCK_CLAUDE_SUCCESS));
    const wait = await ctx.lazy(['wait', clone]);
    expect(wait.exitCode).toBe(0);
    expect(isAncestor(ctx, wt, mainAfter)).toBe(false);
    expect(isAncestor(ctx, wt, headOf(ctx, ctx.root, 'main'))).toBe(false);
    expect(readTaskJson(ctx.root, clone).metadata?.pinned_base_sha).toBe(originalStart);

    // The daemon's own sync retry loop is the automatic path that WOULD merge:
    // queue a sync the way a failed fetch does, and let the loop pick it up.
    // It must drain the queue without merging.
    writeTaskJson(ctx.root, clone, { ...readTaskJson(ctx.root, clone), pending_sync: 1 });
    const deadline = Date.now() + 60_000;
    while (readTaskJson(ctx.root, clone).pending_sync !== 0 && Date.now() < deadline) {
      await Bun.sleep(500);
    }
    expect(readTaskJson(ctx.root, clone).pending_sync).toBe(0);
    expect((await ctx.lazy(['wait', clone])).exitCode).toBe(0);
    expect(isAncestor(ctx, wt, mainAfter)).toBe(false);

    // The pin is shown where upstream status is.
    const show = await ctx.lazy(['show', clone]);
    expectSuccess(show);
    expectOutput(show, `pinned to ${originalStart.substring(0, 12)}`);

    // An explicit human `lazy sync` is the one way in: it merges the parent and
    // lifts the pin.
    const sync = await ctx.lazyMocked(['sync', clone], MOCK_CLAUDE_SUCCESS);
    expectSuccess(sync);
    expect((await ctx.lazy(['wait', clone])).exitCode).toBe(0);
    expect(isAncestor(ctx, wt, mainAfter)).toBe(true);
    expect(readTaskJson(ctx.root, clone).metadata?.pinned_base_sha ?? '').toBe('');

    // Accepting a (formerly) pinned clone is the ordinary merge.
    commitInWorktree(ctx, clone, 'rerun.txt');
    await seedFinal(ctx, clone);
    const accept = await ctx.lazyMocked(['accept', clone, '--reason', 'compared'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(accept);
    expect(ctx.git('-C', ctx.root, 'cat-file', '-e', 'main:rerun.txt').exitCode).toBe(0);
  }, 240_000);
});

describe('lazy clone --same-base refusals', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('refuses when the start commit no longer exists', async () => {
    const original = await createTask(ctx, 'Old task', 'prompt');
    const start = await ctx.lazyMocked(['start', original, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(start);

    const gone = 'deadbeef'.repeat(5);
    const session = readSessionJson(ctx.root, original)!;
    writeSessionJson(ctx.root, original, { ...session, git_start_sha: gone });

    const before = (await ctx.lazy(['list', '--all'])).stdout;
    const result = await ctx.lazy(['clone', original, '--same-base']);
    expectFailure(result);
    expectError(result, 'not in this repository');
    expectError(result, gone.substring(0, 12));
    // Refused before anything was created.
    expect((await ctx.lazy(['list', '--all'])).stdout).toBe(before);
  });

  test('refuses a source that never started', async () => {
    const original = await createTask(ctx, 'Never started', 'prompt');
    const result = await ctx.lazy(['clone', original, '--same-base']);
    expectFailure(result);
    expectError(result, 'never started');
  });

  test('--base pins to a named commit and refuses an unknown one', async () => {
    const original = await createTask(ctx, 'Base flag', 'prompt');
    const head = headOf(ctx, ctx.root);

    const ok = await ctx.lazy(['clone', original, '--base', 'HEAD']);
    expectSuccess(ok);
    expect(readTaskJson(ctx.root, newTaskId(ok.stdout)).metadata?.pinned_base_sha).toBe(head);

    const bad = await ctx.lazy(['clone', original, '--base', 'no-such-ref']);
    expectFailure(bad);
    expectError(bad, 'not in this repository');

    const both = await ctx.lazy(['clone', original, '--base', 'HEAD', '--same-base']);
    expectFailure(both);
  });

  test('the pinned branch exists from clone time, keeping the base commit referenced', async () => {
    const original = await createTask(ctx, 'Keep alive', 'prompt');
    const head = headOf(ctx, ctx.root);
    const ok = await ctx.lazy(['clone', original, '--base', 'HEAD']);
    expectSuccess(ok);
    const ref = readTaskJson(ctx.root, newTaskId(ok.stdout)).metadata?.task_ref;
    expect(ref).toBeTruthy();
    const branches = ctx.git('-C', ctx.root, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/');
    expect(branches.stdout.split('\n').some((l) => l.endsWith(`/${ref} ${head}`))).toBe(true);
  });

  test('--agent without --model does not carry the source model to the other agent', async () => {
    const original = await createTask(ctx, 'Model switch', 'prompt');
    writeTaskJson(ctx.root, original, { ...readTaskJson(ctx.root, original), model: 'claude-opus-5-5' });

    const result = await ctx.lazy(['clone', original, '--agent', 'codex']);
    expectSuccess(result);
    const clone = readTaskJson(ctx.root, newTaskId(result.stdout));
    expect(clone.agent_id).toBe('codex');
    expect(clone.model).not.toBe('claude-opus-5-5');
    // INVARIANT: an agent switch leaves the clone's model UNSET, so the launch
    // helper resolves it at first launch. Clone must not run the model ladder itself.
    expect(clone.model ?? null).toBeNull();

    // Same agent, or an explicit model: the model is taken as given.
    const kept = await ctx.lazy(['clone', original]);
    expect(readTaskJson(ctx.root, newTaskId(kept.stdout)).model).toBe('claude-opus-5-5');
    const named = await ctx.lazy(['clone', original, '--agent', 'codex', '--model', 'gpt-5']);
    expect(readTaskJson(ctx.root, newTaskId(named.stdout)).model).toBe('gpt-5');
  });

  test('--base refuses an option-shaped value', async () => {
    const original = await createTask(ctx, 'Dash base', 'prompt');
    const result = await ctx.lazy(['clone', original, '--base=--all']);
    expectFailure(result);
  });

  test('--agent rejects an unknown profile', async () => {
    const original = await createTask(ctx, 'Agent flag', 'prompt');
    const result = await ctx.lazy(['clone', original, '--agent', 'no-such-agent']);
    expectFailure(result);
    expectError(result, 'Unknown agent profile');
  });
});
