/**
 * INVARIANT: a task that points its worktree's HEAD at another branch cannot
 * get lazy_commit to move that branch. `<gitdir>/HEAD` is writable inside a
 * task container (git rewrites it on checkout), so the daemon-side commit
 * reads HEAD from the file first and refuses unless it names the task's own
 * branch (src/git/worktree-pointers.ts). Unit coverage of the check, the other
 * writing paths and the repair: test/unit/task-head-branch-guard.test.ts.
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

function gitIn(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

describe('lazy_commit with a redirected HEAD', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('refuses, naming the task and the branch, and moves no branch', async () => {
    const taskId = await createTask(ctx, 'Head guard', 'Do the work');
    await ctx.setClaudeScenario(successScenario({
      result: 'First pass.',
      commit: { message: 'Add a.txt', files: [{ path: 'a.txt', content: 'a\n' }] },
    }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const worktree = worktreePathFor(ctx.root, taskId);
    const gitdir = (await readFile(join(worktree, '.git'), 'utf-8')).trim().replace(/^gitdir: /, '');
    const ownBranch = gitIn(worktree, 'symbolic-ref', '--short', 'HEAD');
    const mainBefore = gitIn(ctx.root, 'rev-parse', 'main');

    // Stage a change BEFORE redirecting: the daemon's HEAD-repair sweep runs
    // here and repairs a HEAD whose index still equals the task branch, which
    // would race this test. A staged change makes the sweep leave it alone, so
    // the lazy_commit refusal is what gets exercised, deterministically.
    await writeFile(join(worktree, 'b.txt'), 'b\n');
    gitIn(worktree, 'add', 'b.txt');
    // What a task can do from inside its container.
    await writeFile(join(gitdir, 'HEAD'), 'ref: refs/heads/main\n');

    const responses = await runMcpSession(
      ctx.root,
      findFullTaskId(ctx.root, taskId),
      worktree,
      [
        { method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
        { method: 'tools/call', id: 2, params: { name: 'lazy_commit', arguments: { message: 'sneaky' } } },
      ],
      { timeoutMs: 60_000 },
    );
    const text = mcpText(responses.find(r => r.id === 2));
    expect(text).toContain('Refusing to write git');
    expect(text).toContain('points at branch main');
    expect(text).toContain(ownBranch);
    expect(gitIn(ctx.root, 'rev-parse', 'main')).toBe(mainBefore);
  }, 120_000);
});
