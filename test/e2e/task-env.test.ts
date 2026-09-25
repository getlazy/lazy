/**
 * `lazy env` — per-task environment variables, end to end.
 *
 * The load-bearing test here is the delivery one: it uses the fake-binary seam
 * so the value must travel the REAL path (CLI → daemon → supervisor → agent
 * process env) and is then read back out of the agent's OWN environment. An
 * argv assertion would only prove lazy meant to deliver it.
 *
 * The other half of the contract is negative and equally important: the value
 * must appear NOWHERE durable — not in task state, turns, prompts, or logs. A
 * token leaked into a turn is unrecoverable, so that is asserted by sweeping
 * the whole external store and the project's own .lazy directory for it.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rm, readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';
import { storageDirFor } from '../helpers/storage';
import { getTaskEnvPath } from '../../src/daemon/paths';

/** The dummy secret. Distinctive enough that a substring sweep is meaningful. */
const SECRET = 'sk-dummy-per-task-98f3c1-value';

/** Every file under `dir` whose contents mention `needle`. */
async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      // A directory that vanished mid-walk (worktree teardown) is not a hit.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      let text: string;
      try {
        text = await readFile(path, 'utf-8');
      } catch {
        continue; // binary or unreadable — cannot carry the secret as text
      }
      if (text.includes(needle)) hits.push(path);
    }
  };
  await walk(dir);
  return hits;
}

describe('lazy env (per-task environment variables)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    // The registry lives in the daemon state dir (outside the temp project), so
    // ctx.cleanup() would not remove it.
    const registry = getTaskEnvPath(ctx.root);
    await ctx.cleanup();
    await rm(registry, { force: true });
  });

  test('a variable set on one task reaches that task\'s agent and nothing durable', async () => {
    const taskId = await createTask(ctx, 'Per-task env delivery', 'Do the work');
    await ctx.recordClaudeEnvKeys(['DUMMY_TASK_TOKEN']);

    const set = await ctx.lazy(['env', 'set', taskId, `DUMMY_TASK_TOKEN=${SECRET}`]);
    expectSuccess(set);
    expectOutput(set, 'DUMMY_TASK_TOKEN');
    // Even the command that RECEIVED the value must not echo it back.
    expectOutputExcludes(set, SECRET);

    await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 'fake-sess-env' }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // 1. It arrived: read out of the agent process's own environment.
    const invocations = await ctx.claudeInvocations();
    const turn = invocations.find(i => i.argv.includes('-p'));
    expect(turn).toBeDefined();
    expect(turn!.env?.DUMMY_TASK_TOKEN).toBe(SECRET);

    // 2. It is nowhere durable. Turns, prompts, session and task JSON all live
    //    under the external store; the project's own .lazy holds logs and the
    //    worktree. Neither may contain the value.
    expect(await filesContaining(storageDirFor(ctx.root), SECRET)).toEqual([]);
    expect(await filesContaining(join(ctx.root, '.lazy'), SECRET)).toEqual([]);

    // 3. It IS in the daemon's own 0600 file — the one place it is meant to be.
    const registry = getTaskEnvPath(ctx.root);
    expect((await readFile(registry, 'utf-8')).includes(SECRET)).toBe(true);
    expect((await stat(registry)).mode & 0o777).toBe(0o600);
  }, 120_000);

  test('another task does not get it', async () => {
    const withVar = await createTask(ctx, 'Has a token', 'Do the work');
    const without = await createTask(ctx, 'Has no token', 'Do the work');
    await ctx.recordClaudeEnvKeys(['DUMMY_TASK_TOKEN']);
    expectSuccess(await ctx.lazy(['env', 'set', withVar, `DUMMY_TASK_TOKEN=${SECRET}`]));

    await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 'fake-sess-other' }));
    expectSuccess(await ctx.lazy(['start', without, '--yes']));
    expectSuccess(await ctx.lazy(['wait', without]));

    const turn = (await ctx.claudeInvocations()).find(i => i.argv.includes('-p'));
    expect(turn).toBeDefined();
    // Recorded but unset — the key was asked for and was genuinely absent.
    expect(turn!.env?.DUMMY_TASK_TOKEN ?? null).toBeNull();
  }, 120_000);

  test('`lazy start --env` sets the variable before the launch', async () => {
    const taskId = await createTask(ctx, 'Start-time env', 'Do the work');
    await ctx.recordClaudeEnvKeys(['DUMMY_TASK_TOKEN']);
    await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 'fake-sess-startenv' }));

    const start = await ctx.lazy(['start', taskId, '--env', `DUMMY_TASK_TOKEN=${SECRET}`, '--yes']);
    expectSuccess(start);
    expectOutputExcludes(start, SECRET);
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const turn = (await ctx.claudeInvocations()).find(i => i.argv.includes('-p'));
    expect(turn!.env?.DUMMY_TASK_TOKEN).toBe(SECRET);
  }, 120_000);

  test('list prints names only; unset and clear remove them', async () => {
    const taskId = await createTask(ctx, 'Env CLI surface', 'Do the work');
    expectSuccess(await ctx.lazy(['env', 'set', taskId, `DUMMY_TASK_TOKEN=${SECRET}`, 'API_BASE=https://x.test']));

    const list = await ctx.lazy(['env', 'list', taskId]);
    expectSuccess(list);
    expectOutput(list, 'DUMMY_TASK_TOKEN');
    expectOutput(list, 'API_BASE');
    // INVARIANT: no lazy surface prints a per-task value back. `lazy env list`
    // must be safe to paste into a bug report.
    expectOutputExcludes(list, SECRET);

    expectSuccess(await ctx.lazy(['env', 'unset', taskId, 'API_BASE']));
    const afterUnset = await ctx.lazy(['env', 'list', taskId]);
    expectOutput(afterUnset, 'DUMMY_TASK_TOKEN');
    expectOutputExcludes(afterUnset, 'API_BASE');

    expectSuccess(await ctx.lazy(['env', 'clear', taskId]));
    expectOutput(await ctx.lazy(['env', 'list', taskId]), 'No environment variables');
  }, 60_000);

  test('reserved and malformed names are refused with actionable text', async () => {
    const taskId = await createTask(ctx, 'Env validation', 'Do the work');

    const reserved = await ctx.lazy(['env', 'set', taskId, 'ANTHROPIC_API_KEY=hijack']);
    expectFailure(reserved);
    expectError(reserved, 'reserved by lazy');

    const malformed = await ctx.lazy(['env', 'set', taskId, '1BAD=x']);
    expectFailure(malformed);
    expectError(malformed, 'Invalid environment variable name');

    // Nothing partial landed.
    expectOutput(await ctx.lazy(['env', 'list', taskId]), 'No environment variables');
  }, 60_000);

  test('--env-file reads a dotenv-style file', async () => {
    const taskId = await createTask(ctx, 'Env file', 'Do the work');
    const envFile = join(ctx.root, 'task.env');
    await Bun.write(envFile, `# comment\nDUMMY_TASK_TOKEN=${SECRET}\nexport API_BASE=https://x.test\n`);

    expectSuccess(await ctx.lazy(['env', 'set', taskId, '--env-file', envFile]));
    const list = await ctx.lazy(['env', 'list', taskId]);
    expectOutput(list, 'DUMMY_TASK_TOKEN');
    expectOutput(list, 'API_BASE');
    expectOutputExcludes(list, SECRET);
  }, 60_000);

  test('a missing env file fails loudly instead of setting nothing', async () => {
    const taskId = await createTask(ctx, 'Missing env file', 'Do the work');
    const result = await ctx.lazy(['env', 'set', taskId, '--env-file', join(ctx.root, 'nope.env')]);
    expectFailure(result);
    expectError(result, 'Cannot read env file');
  }, 60_000);

  // INVARIANT: a task's variables are scoped to its lifetime. They are held on
  // disk only so that resumes and auto-resumes keep working, so a terminal
  // transition must take the value with it rather than leave a live token in a
  // host file forever. `close` is the cheapest terminal path to drive; accept
  // and reject clear it through the same revokeTaskTokens call site.
  test('a terminal transition deletes the task\'s values from the host', async () => {
    const taskId = await createTask(ctx, 'Cleared on close', 'Do the work');
    expectSuccess(await ctx.lazy(['env', 'set', taskId, `DUMMY_TASK_TOKEN=${SECRET}`]));

    const registry = getTaskEnvPath(ctx.root);
    expect((await readFile(registry, 'utf-8')).includes(SECRET)).toBe(true);

    expectSuccess(await ctx.lazy(['close', taskId, '--reason', 'done with it', '--yes']));

    expect((await readFile(registry, 'utf-8')).includes(SECRET)).toBe(false);
    expectOutput(await ctx.lazy(['env', 'list', taskId]), 'No environment variables');
  }, 60_000);

  test('an unknown task is refused rather than silently stored', async () => {
    const result = await ctx.lazy(['env', 'set', 'deadbeef', 'DUMMY_TASK_TOKEN=x']);
    expectFailure(result);
  }, 60_000);
});
