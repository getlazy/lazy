/**
 * A real supervisor launched under the harness writes its agent config into the
 * context's private HOME and never touches the HOME of the process running the
 * tests — which, on a builder, is the builder's own tool channel (incident
 * 2026-09-28: a test run's supervisor re-pointed a live builder's
 * `mcpServers.lazy` at a worktree deleted minutes later).
 *
 * The real HOME is only READ here, never written.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';
import { findFullTaskId } from '../helpers/storage';

async function snapshot(path: string): Promise<{ content: string; mtimeMs: number } | null> {
  try {
    return { content: await readFile(path, 'utf-8'), mtimeMs: (await stat(path)).mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

describe('test-launched supervisors keep out of the real HOME', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a supervisor launched under the harness writes ~/.claude.json only
  // into the context's private HOME; the test process's own HOME is untouched.
  // Claude Code reads one MCP config per HOME, so a write there hijacks whatever
  // real session lives in it.
  test("a real turn leaves the test process's ~/.claude.json exactly as it was", async () => {
    const realConfig = join(process.env.HOME || homedir(), '.claude.json');
    const before = await snapshot(realConfig);

    const taskId = await createTask(ctx, 'Home isolation', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 'home-iso' }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    await ctx.lazy(['wait', taskId]);

    const fullId = findFullTaskId(ctx.root, taskId);
    expect(ctx.agentHome).toBeDefined();
    expect(ctx.agentHome).not.toBe(process.env.HOME);
    const written = JSON.parse(await readFile(join(ctx.agentHome!, '.claude.json'), 'utf-8'));
    expect(written.mcpServers.lazy.args).toContain(fullId);

    expect(await snapshot(realConfig)).toEqual(before);
  });
});
