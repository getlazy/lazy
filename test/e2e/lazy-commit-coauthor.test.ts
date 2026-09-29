/**
 * lazy_commit carries lazy's co-author trailer unless the PROJECT ROOT's
 * lazy.toml opts out with `[git] coauthor_trailer = false`. The accept-side
 * half of the same rule is test/e2e/coauthor.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';
import { findFullTaskId, worktreePathFor } from '../helpers/storage';
import { runMcpSession, mcpText } from '../helpers/mcp-session';

const TRAILER = 'Co-Authored-By: Lazy <noreply@getlazy.dev>';

function gitIn(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

async function optOut(tomlPath: string): Promise<void> {
  const toml = await readFile(tomlPath, 'utf-8').catch(() => '');
  const edited = toml.includes('[git]\n')
    ? toml.replace('[git]\n', '[git]\ncoauthor_trailer = false\n')
    : `${toml}\n[git]\ncoauthor_trailer = false\n`;
  expect(edited).not.toBe(toml);
  await writeFile(tomlPath, edited);
}

describe('lazy_commit co-author trailer', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function startedTask(): Promise<{ taskId: string; worktree: string }> {
    const taskId = await createTask(ctx, 'Trailer', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ result: 'Done.' }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    return { taskId, worktree: worktreePathFor(ctx.root, taskId) };
  }

  async function lazyCommit(taskId: string, worktree: string, message: string): Promise<string> {
    await writeFile(join(worktree, `work-${Date.now()}.txt`), 'work\n');
    const responses = await runMcpSession(
      ctx.root,
      findFullTaskId(ctx.root, taskId),
      worktree,
      [
        { method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
        { method: 'tools/call', id: 2, params: { name: 'lazy_commit', arguments: { message } } },
      ],
      { timeoutMs: 60_000, env: { LAZY_ALLOW_HOST_RUNNER: '1' } },
    );
    const text = mcpText(responses.find(r => r.id === 2));
    expect(text).toContain('"committed": true');
    return gitIn(worktree, 'log', '-1', '--format=%B');
  }

  // INVARIANT: a commit lazy_commit writes carries lazy's co-author trailer by
  // default — lazy made the commit, so lazy signs it.
  test('adds the trailer by default', async () => {
    const { taskId, worktree } = await startedTask();
    const body = await lazyCommit(taskId, worktree, 'agent work');
    expect(body).toBe(`agent work\n\n${TRAILER}`);
  });

  // INVARIANT: `[git] coauthor_trailer = false` in the ROOT lazy.toml removes it.
  test('omits the trailer when the project root opts out', async () => {
    const { taskId, worktree } = await startedTask();
    await optOut(join(ctx.root, 'lazy.toml'));
    const body = await lazyCommit(taskId, worktree, 'agent work');
    expect(body).toBe('agent work');
  });

  // INVARIANT: a task worktree's lazy.toml has no authority — an agent cannot
  // turn the trailer off by editing the config on its own branch.
  test('a worktree lazy.toml cannot opt out', async () => {
    const { taskId, worktree } = await startedTask();
    await optOut(join(worktree, 'lazy.toml'));
    const body = await lazyCommit(taskId, worktree, 'agent work');
    expect(body).toContain(TRAILER);
  });
});
