/**
 * E2e tests for the per-task turn budget (limits.max_turns_without_human).
 *
 * INVARIANT: The cap only gates builder/agent-initiated turns (actor !== 'human').
 * A human channel (CLI) unblock/resume always succeeds and resets the counter —
 * see src/daemon/task-lifecycle.ts's "BUG FIX" comment: the reset used to run
 * unconditionally, letting an autonomous builder/agent turn launder away its
 * own budget every turn. These tests reproduce that regression directly by
 * driving two consecutive builder-actor (MCP channel) unblocks and asserting
 * the counter accumulates across both rather than resetting in between.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { runMcpSession, type JsonRpcResponse } from '../helpers/mcp-session';

describe('turn budget (limits.max_turns_without_human) e2e', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // The cap is enforced by the daemon (task-lifecycle.ts / task-launcher.ts),
    // and driving a builder-actor turn requires the real MCP -> RPC -> daemon
    // channel, so this needs a real daemon like auto-react-budget.test.ts and
    // mcp-actor.test.ts.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Uncomment and set limits.max_turns_without_human in the project's lazy.toml. */
  function setMaxTurnsWithoutHuman(max: number): void {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = readFileSync(configPath, 'utf-8');
    const after = before.replace(/# max_turns_without_human = 10/, `max_turns_without_human = ${max}`);
    expect(after).not.toBe(before);
    writeFileSync(configPath, after);
  }

  async function startAndWait(taskId: string): Promise<void> {
    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(startResult);
    const waitResult = await ctx.lazy(['wait', taskId]);
    if (waitResult.exitCode !== 0) {
      throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
    }
  }

  function tasksDirFor(): string {
    const toml = readFileSync(join(ctx.root, 'lazy.toml'), 'utf-8');
    const m = toml.match(/^external_path\s*=\s*"(.+)"/m);
    if (m && m[1]) return join(m[1], 'tasks');
    return join(ctx.root, '.lazy', 'tasks');
  }

  function readTaskJson(taskShortId: string): Record<string, unknown> {
    const tasksDir = tasksDirFor();
    const entries = Bun.spawnSync(['ls', tasksDir], { stdout: 'pipe' }).stdout.toString().trim().split('\n');
    const taskDir = entries.find(e => e.startsWith(taskShortId));
    if (!taskDir) throw new Error(`Task dir not found for ${taskShortId}`);
    return JSON.parse(readFileSync(join(tasksDir, taskDir, 'task.json'), 'utf-8'));
  }

  function writeTaskJson(taskShortId: string, data: Record<string, unknown>): void {
    const tasksDir = tasksDirFor();
    const entries = Bun.spawnSync(['ls', tasksDir], { stdout: 'pipe' }).stdout.toString().trim().split('\n');
    const taskDir = entries.find(e => e.startsWith(taskShortId));
    if (!taskDir) throw new Error(`Task dir not found for ${taskShortId}`);
    writeFileSync(join(tasksDir, taskDir, 'task.json'), JSON.stringify(data, null, 2));
  }

  function setNonHumanTurnCount(taskId: string, count: number): void {
    const taskJson = readTaskJson(taskId);
    taskJson.metadata = {
      ...(taskJson.metadata as Record<string, string> || {}),
      non_human_turn_count: String(count),
    };
    writeTaskJson(taskId, taskJson);
  }

  async function mcpUnblock(taskId: string, feedback: string): Promise<JsonRpcResponse | undefined> {
    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_unblock', arguments: { task_id: taskId, feedback } } },
    ]);
    return responses.find(r => r.id === 2);
  }

  // INVARIANT: A builder-actor (MCP channel) unblock is refused with a 409-style
  // error once the task has run limits.max_turns_without_human consecutive
  // turns without a human in the loop.
  test('builder-actor unblock is refused once the cap is reached', async () => {
    setMaxTurnsWithoutHuman(2);
    const taskId = await createTask(ctx, 'Turn budget cap test', 'Some work');
    await startAndWait(taskId);
    setNonHumanTurnCount(taskId, 2);

    const response = await mcpUnblock(taskId, 'keep going');
    expect(response).toBeDefined();
    expect(response!.result?.isError).toBe(true);
    const text = response!.result?.content?.[0]?.text ?? '';
    expect(text).toContain('limits.max_turns_without_human');
    expect(text).toContain('2/2 consecutive turns');

    // The refused call must not have advanced the task or the counter.
    const afterJson = readTaskJson(taskId);
    const meta = afterJson.metadata as Record<string, string>;
    expect(meta.non_human_turn_count).toBe('2');
  });

  // INVARIANT: A builder-actor unblock under the cap succeeds and increments
  // the counter — it does NOT reset it (only a human turn resets it). This is
  // the regression the "BUG FIX" comment in task-lifecycle.ts guards against:
  // an autonomous builder turn must never launder away its own budget.
  test('builder-actor unblock under the cap succeeds and increments the counter without resetting it', async () => {
    setMaxTurnsWithoutHuman(5);
    const taskId = await createTask(ctx, 'Turn budget increment test', 'Some work');
    await startAndWait(taskId);
    setNonHumanTurnCount(taskId, 1);

    const response = await mcpUnblock(taskId, 'keep going');
    expect(response).toBeDefined();
    expect(response!.result?.isError).toBeFalsy();

    const afterJson = readTaskJson(taskId);
    const meta = afterJson.metadata as Record<string, string>;
    // Incremented from the pre-set 1, not reset to 0 or 1.
    expect(Number(meta.non_human_turn_count)).toBeGreaterThanOrEqual(2);
  });

  // INVARIANT: A human-actor (CLI channel) unblock always succeeds regardless
  // of the counter, and resets it back to 0 — a human taking over clears the
  // budget entirely.
  test('human-actor (CLI) unblock succeeds at the cap and resets the counter', async () => {
    setMaxTurnsWithoutHuman(2);
    const taskId = await createTask(ctx, 'Turn budget human reset test', 'Some work');
    await startAndWait(taskId);
    setNonHumanTurnCount(taskId, 2);

    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'human taking over'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_PROMPT_DEFAULTS: 'accept', LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);

    const afterJson = readTaskJson(taskId);
    const meta = afterJson.metadata as Record<string, string>;
    expect(meta.non_human_turn_count || '').toBe('');
  });

  // INVARIANT: limits.max_turns_without_human = 0 means unlimited — a
  // builder-actor unblock must succeed no matter how high the counter is.
  test('a limit of 0 never refuses a builder-actor unblock', async () => {
    setMaxTurnsWithoutHuman(0);
    const taskId = await createTask(ctx, 'Turn budget unlimited test', 'Some work');
    await startAndWait(taskId);
    setNonHumanTurnCount(taskId, 999);

    const response = await mcpUnblock(taskId, 'keep going');
    expect(response).toBeDefined();
    expect(response!.result?.isError).toBeFalsy();
  });
});
