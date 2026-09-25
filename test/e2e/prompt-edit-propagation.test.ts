/**
 * INVARIANT: every surface that reports or reuses "the task prompt" reports
 * the CURRENT one — the same text a launch would use now.
 *
 * Prompts are versioned, and `Storage.getPromptHistory` comes back in OPPOSITE
 * orders from the two backends (FileStorage newest-first, Postgres
 * oldest-first). Five callers reached for the current prompt as
 * `history[history.length - 1]`, so on the default file backend they all
 * resolved the ORIGINAL prompt after a `lazy edit --prompt`:
 *
 *   - `lazy_show` served text the agent never received, contradicting the
 *     `turns` array in its own response;
 *   - `lazy clone` / `lazy redo` seeded the NEW task with the superseded
 *     prompt, so the stale text was then actually executed.
 *
 * The fix is one resolver (`currentPromptOf`, src/task-prompt.ts) reading
 * `task.prompt`, which `updateTaskPrompt` keeps in step — so no surface
 * depends on that ordering any more. These tests pin the user-visible half;
 * test/unit/current-prompt-resolution.test.ts pins the MCP half.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask, disablePreAccept } from '../helpers/fixtures';
import { taskFilePath } from '../helpers/storage';
import { readFileSync } from 'fs';

const V1 = 'ORIGINAL PROMPT: you are a child of release-v022.';
const V2 = 'EDITED PROMPT: you are targeting main, deliberately.';

/** Extract a task id or code from "Created task <x>" output. */
function extractNewTaskId(output: string): string {
  const hex = output.match(/Created task ([a-f0-9]{8})/);
  if (hex) return hex[1];
  const code = output.match(/Created task ([a-z0-9.-]+)\b/);
  if (!code) throw new Error(`No created task in output:\n${output}`);
  return code[1];
}

describe('prompt edits propagate to every surface', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    // Daemonless suite: nothing here can execute the pre-accept agent turn.
    disablePreAccept(ctx.root);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('lazy show reports the edited prompt, not the original', async () => {
    const taskId = await createTask(ctx, 'Task with an edited prompt', V1);
    expectSuccess(await ctx.lazy(['edit', taskId, '--prompt', V2]));

    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expectOutput(show, V2);
    expectOutputExcludes(show, V1);

    const json = await ctx.lazy(['show', taskId, '--json']);
    expectSuccess(json);
    expect(JSON.parse(json.stdout).prompt).toBe(V2);
  });

  test('lazy clone carries the edited prompt into the new task', async () => {
    const taskId = await createTask(ctx, 'Task to clone after editing', V1);
    expectSuccess(await ctx.lazy(['edit', taskId, '--prompt', V2]));

    const cloned = await ctx.lazy(['clone', taskId]);
    expectSuccess(cloned);

    const json = await ctx.lazy(['show', extractNewTaskId(cloned.stdout), '--json']);
    expectSuccess(json);
    expect(JSON.parse(json.stdout).prompt).toBe(V2);
  });

  test('lazy redo carries the edited prompt into the new task', async () => {
    const taskId = await createTask(ctx, 'Task to redo after editing', V1);
    expectSuccess(await ctx.lazy(['edit', taskId, '--prompt', V2]));

    const redone = await ctx.lazy(['redo', taskId, '--no-start']);
    expectSuccess(redone);

    const json = await ctx.lazy(['show', extractNewTaskId(redone.stdout), '--json']);
    expectSuccess(json);
    expect(JSON.parse(json.stdout).prompt).toContain(V2);
    expect(JSON.parse(json.stdout).prompt).not.toContain(V1);
  });

  // Prompt history is deliberately preserved — the fix must not "solve" the
  // stale read by dropping the superseded version.
  test('the superseded prompt stays reachable as history', async () => {
    const taskId = await createTask(ctx, 'Task whose history must survive', V1);
    expectSuccess(await ctx.lazy(['edit', taskId, '--prompt', V2]));

    const shown = await ctx.lazy(['show', taskId, '--json']);
    expectSuccess(shown);
    // The task record carries the current prompt...
    expect(JSON.parse(shown.stdout).prompt).toBe(V2);

    // ...and BOTH versions remain on disk, in append order, for the web
    // prompt-version route to render. (Read raw rather than via
    // getPromptHistory, whose ORDER is backend-dependent by design.)
    const raw = readFileSync(taskFilePath(ctx.root, taskId, 'prompt-history.json'), 'utf-8');
    const versions = (JSON.parse(raw).versions ?? []) as Array<{ version: number; content: string }>;
    expect(versions.map((v) => v.content)).toEqual([V1, V2]);
  });
});
