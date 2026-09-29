import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';
import { readTaskStatus } from '../helpers/storage';
import { runMcpSession, type JsonRpcResponse } from '../helpers/mcp-session';

/**
 * INVARIANT: reopen gives back what was closed. Accept deletes a task's LOCAL
 * branch (the remote one survives), and reopen used to recreate the worktree
 * with `git worktree add -b`, silently cutting a FRESH branch from the parent —
 * the task came back empty while its work sat on origin. Reopen must restore
 * the branch at the task's last head (local → remote → a recorded commit) or
 * refuse and change nothing. A fresh start is clone's or redo's job.
 */
describe('lazy reopen restores the task branch', () => {
  let ctx: TestContext;
  const originDirs: string[] = [];

  beforeEach(async () => {
    // Accept needs a real daemon: the reconciler moves the task out of 'working'.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
    await Promise.all(originDirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
  });

  const branchOf = (taskId: string) => `lazy/${taskId}`;
  const worktreeOf = (taskId: string) => join(ctx.root, '.lazy', 'worktrees', taskId);
  const hasLocalBranch = (taskId: string) =>
    ctx.git('rev-parse', '--verify', '--quiet', `refs/heads/${branchOf(taskId)}`).exitCode === 0;

  /** Start, wait, commit a file by hand (NOT a recorded commit), declare final. Returns the head. */
  async function startedTaskWithWork(goal: string): Promise<{ taskId: string; head: string }> {
    const taskId = await createTask(ctx, goal, 'Some work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    const waited = await ctx.lazy(['wait', taskId]);
    if (waited.exitCode !== 0) throw new Error(`wait failed: ${waited.stderr}\n${waited.stdout}`);

    const wt = worktreeOf(taskId);
    writeFileSync(join(wt, 'feature.txt'), 'feature content\n');
    expect(ctx.git('-C', wt, 'add', 'feature.txt').exitCode).toBe(0);
    expect(ctx.git('-C', wt, 'commit', '-m', 'Add feature').exitCode).toBe(0);
    await seedFinal(ctx, taskId);
    const head = ctx.git('-C', wt, 'rev-parse', 'HEAD').stdout.trim();
    return { taskId, head };
  }

  /** A bare origin carrying `refs` (the after-turn push), with the github driver switched on. */
  async function originWith(refs: Array<[sha: string, branch: string]>): Promise<void> {
    const originPath = await mkdtemp(join(tmpdir(), 'lazy-e2e-origin-'));
    originDirs.push(originPath);
    ctx.git('init', '--bare', originPath);
    ctx.git('remote', 'add', 'origin', originPath);
    expect(ctx.git('push', 'origin', 'main').exitCode).toBe(0);
    for (const [sha, branch] of refs) {
      expect(ctx.git('push', 'origin', `${sha}:refs/heads/${branch}`).exitCode).toBe(0);
    }
    const configPath = join(ctx.root, 'lazy.toml');
    const before = readFileSync(configPath, 'utf-8');
    const after = before.replace('driver = "local"', 'driver = "github"');
    expect(after).not.toBe(before);
    writeFileSync(configPath, after);
  }

  /** Make every task commit unreachable garbage and collect it: no recorded head survives. */
  function forgetLocalObjects(): void {
    expect(ctx.git('reflog', 'expire', '--expire=now', '--all').exitCode).toBe(0);
    expect(ctx.git('gc', '--prune=now', '--quiet').exitCode).toBe(0);
  }

  test('an accepted task whose local branch is gone comes back from origin at its last head', async () => {
    const { taskId, head } = await startedTaskWithWork('Restore from origin');
    expectSuccess(await ctx.lazy(['accept', taskId, '--reason', 'ok']));
    expect(hasLocalBranch(taskId)).toBe(false);

    // Nothing local can supply the head: the hand-made commit was never recorded.
    await originWith([[head, branchOf(taskId)]]);

    const result = await ctx.lazy(['reopen', taskId, '--reason', 'more work']);
    expectSuccess(result);
    expectOutput(result, `Restored ${branchOf(taskId)} from origin at ${head.slice(0, 12)}`);
    expectOutput(result, `lazy sync ${taskId}`);

    expect(ctx.git('-C', worktreeOf(taskId), 'rev-parse', 'HEAD').stdout.trim()).toBe(head);
    expect(existsSync(join(worktreeOf(taskId), 'feature.txt'))).toBe(true);
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  });

  // INVARIANT: a stale remote never wins over newer recorded work. If the
  // task's last commits never reached origin but a final claim names them and
  // their objects are here, reopen restores THAT head — the remote is merged
  // back in by sync's first step, so nothing on either side is lost.
  test('a remote behind the final-claimed head: reopen restores the newer local head', async () => {
    const { taskId, head } = await startedTaskWithWork('Stale remote');
    const older = ctx.git('rev-parse', `${head}^`).stdout.trim();
    expectSuccess(await ctx.lazy(['accept', taskId, '--reason', 'ok']));
    expect(hasLocalBranch(taskId)).toBe(false);

    // Origin only got the commit BEFORE the final-claimed head.
    await originWith([[older, branchOf(taskId)]]);

    const result = await ctx.lazy(['reopen', taskId, '--reason', 'more work']);
    expectSuccess(result);
    expectOutput(result, `last recorded head ${head.slice(0, 12)}`);
    expectOutput(result, `origin is behind at ${older.slice(0, 12)}`);
    expectOutput(result, `lazy sync ${taskId}`);
    expect(ctx.git('-C', worktreeOf(taskId), 'rev-parse', 'HEAD').stdout.trim()).toBe(head);
    expect(existsSync(join(worktreeOf(taskId), 'feature.txt'))).toBe(true);
  });

  test('with no source anywhere, reopen refuses and changes nothing', async () => {
    const { taskId } = await startedTaskWithWork('Nothing to restore');
    expectSuccess(await ctx.lazy(['accept', taskId, '--reason', 'ok']));
    await originWith([]);
    forgetLocalObjects();

    const result = await ctx.lazy(['reopen', taskId, '--reason', 'more work']);
    expectFailure(result);
    expectError(result, 'its work cannot be found');
    expectError(result, `lazy clone ${taskId}`);

    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
    expect(hasLocalBranch(taskId)).toBe(false);
    expect(existsSync(worktreeOf(taskId))).toBe(false);
    const shown = await ctx.lazy(['show', taskId]);
    expect(shown.stdout).not.toContain('[Reopened]');
  });

  test('local driver, no remote: restores from the final-claimed head, not an older recorded commit', async () => {
    const { taskId, head } = await startedTaskWithWork('Restore from recorded head');
    expectSuccess(await ctx.lazy(['accept', taskId, '--reason', 'ok']));
    expect(hasLocalBranch(taskId)).toBe(false);

    // The hand-made head is no commit record — only the final claim names it.
    const result = await ctx.lazy(['reopen', taskId, '--reason', 'more work']);
    expectSuccess(result);
    expectOutput(result, `from the task's last recorded commit ${head.slice(0, 12)}`);
    expect(ctx.git('-C', worktreeOf(taskId), 'rev-parse', 'HEAD').stdout.trim()).toBe(head);
    expect(existsSync(join(worktreeOf(taskId), 'feature.txt'))).toBe(true);
  });

  // INVARIANT: the other half of the containment rule — when the remote is
  // AHEAD of every recorded head (e.g. a colleague pushed after the final
  // claim), reopen restores the remote, never the older recorded head.
  test('a remote ahead of the recorded head: reopen restores the remote', async () => {
    const { taskId, head } = await startedTaskWithWork('Remote ahead');
    expectSuccess(await ctx.lazy(['accept', taskId, '--reason', 'ok']));
    const newer = ctx.git('commit-tree', `${head}^{tree}`, '-p', head, '-m', 'pushed later').stdout.trim();
    expect(newer).toMatch(/^[0-9a-f]{40}$/);
    await originWith([[newer, branchOf(taskId)]]);

    const result = await ctx.lazy(['reopen', taskId, '--reason', 'more work']);
    expectSuccess(result);
    expectOutput(result, `Restored ${branchOf(taskId)} from origin at ${newer.slice(0, 12)}`);
    expect(ctx.git('-C', worktreeOf(taskId), 'rev-parse', 'HEAD').stdout.trim()).toBe(newer);
  });

  // INVARIANT: fail hard on remote failures — a remote that could not be asked
  // is never read as "the branch is not there", and the refusal changes nothing.
  test('an unreachable remote refuses and changes nothing', async () => {
    const { taskId } = await startedTaskWithWork('Unreachable remote');
    expectSuccess(await ctx.lazy(['accept', taskId, '--reason', 'ok']));
    ctx.git('remote', 'add', 'origin', join(tmpdir(), 'lazy-e2e-no-such-origin-' + taskId));
    const configPath = join(ctx.root, 'lazy.toml');
    const before = readFileSync(configPath, 'utf-8');
    const after = before.replace('driver = "local"', 'driver = "github"');
    expect(after).not.toBe(before);
    writeFileSync(configPath, after);

    const result = await ctx.lazy(['reopen', taskId, '--reason', 'more work']);
    expectFailure(result);
    expectError(result, 'could not be reached');
    expectError(result, 'Nothing was changed');
    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
    expect(hasLocalBranch(taskId)).toBe(false);
    expect((await ctx.lazy(['show', taskId])).stdout).not.toContain('[Reopened]');
  }, 60_000);

  /** Run lazy_reopen's two-step confirm protocol in ONE MCP session (codes are per-process). */
  async function mcpReopen(taskId: string): Promise<{ text: string; isError?: boolean }> {
    const full = (await ctx.lazy(['show', taskId, '--full'])).stdout.match(/ID:\s+([a-f0-9-]{36})/)![1];
    const textOf = (r: JsonRpcResponse | undefined) => (r!.result as { content: Array<{ text: string }> }).content[0].text;
    const responses = await runMcpSession(ctx.root, full, ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_reopen', arguments: { task_id: taskId, reason: 'more work' } } },
      {
        method: 'tools/call', id: 3, params: prior => {
          const code = textOf(prior.find(r => r.id === 2)).match(/([a-z]{2}-[0-9a-f]{4})/)?.[1];
          return { name: 'lazy_reopen', arguments: { task_id: taskId, reason: 'more work', confirmation_code: code } };
        },
      },
    ]);
    const result = responses.find(r => r.id === 3)!.result as { content: Array<{ text: string }>; isError?: boolean };
    return { text: result.content[0].text, isError: result.isError };
  }

  test('lazy_reopen (MCP → daemon) restores from origin the same way', async () => {
    const { taskId, head } = await startedTaskWithWork('Restore via MCP');
    expectSuccess(await ctx.lazy(['accept', taskId, '--reason', 'ok']));
    await originWith([[head, branchOf(taskId)]]);

    const result = await mcpReopen(taskId);
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain(`Restored ${branchOf(taskId)} from origin at ${head.slice(0, 12)}`);
    expect(ctx.git('rev-parse', `refs/heads/${branchOf(taskId)}`).stdout.trim()).toBe(head);
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  });

  test('lazy_reopen (MCP → daemon) refuses with no source and changes nothing', async () => {
    const { taskId } = await startedTaskWithWork('MCP nothing to restore');
    expectSuccess(await ctx.lazy(['accept', taskId, '--reason', 'ok']));
    await originWith([]);
    forgetLocalObjects();

    const result = await mcpReopen(taskId);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('its work cannot be found');
    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
    expect(hasLocalBranch(taskId)).toBe(false);
  });
});
