/**
 * E2E tests for durable model persistence on started tasks.
 *
 * Regression suite for a production incident: a task was unblocked with
 * `--model opus`, but the override was only passed as a soft per-turn
 * preference and never persisted to `task.model`. When the daemon later
 * auto-resumed the task, it relaunched from the stale `task.model` (an old
 * local model that no longer existed) and crash-looped with "the selected
 * model may not exist or you may not have access to it."
 *
 * The fix: an explicit `--model` on unblock/resume persists to `task.model`
 * (via storage.updateTaskModel) even when task.model is already set, so any
 * subsequent auto-resume/auto-deliver — which read `task.model` — relaunch on
 * the model the human chose. A plain unblock/resume with no `--model` must
 * NOT touch the persisted model.
 *
 * These tests run withDaemon (post-v0.11 the CLI requires a daemon for
 * storage), with agent turns mocked inside the daemon.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import {
  readCommand,
  consumeResponse,
  protocolDir as getProtocolDir,
} from '../../src/protocol';
import type { UnblockCommand } from '../../src/protocol';

const OLD_MODEL = 'claude-opus-4-6';
const NEW_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Resolve the tasks directory for a test project. Test projects use external
 * storage (external_path in lazy.toml) with a fallback to the in-repo
 * .lazy/tasks layout.
 */
function tasksDirFor(root: string): string {
  const toml = readFileSync(join(root, 'lazy.toml'), 'utf-8');
  const m = toml.match(/^external_path\s*=\s*"(.+)"/m);
  if (m && m[1]) return join(m[1], 'tasks');
  return join(root, '.lazy', 'tasks');
}

function findFullTaskId(root: string, shortId: string): string {
  const match = readdirSync(tasksDirFor(root)).find(d => d.startsWith(shortId));
  if (!match) throw new Error(`Task directory not found for ${shortId}`);
  return match;
}

function readTaskJson(root: string, shortId: string): Record<string, unknown> {
  const fullId = findFullTaskId(root, shortId);
  return JSON.parse(readFileSync(join(tasksDirFor(root), fullId, 'task.json'), 'utf-8'));
}

function writeTaskJson(root: string, fullId: string, task: Record<string, unknown>): void {
  writeFileSync(join(tasksDirFor(root), fullId, 'task.json'), JSON.stringify(task, null, 2));
}

function readSessionJson(root: string, fullId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(tasksDirFor(root), fullId, 'session.json'), 'utf-8'));
}

function writeSessionJson(root: string, fullId: string, session: Record<string, unknown>): void {
  writeFileSync(join(tasksDirFor(root), fullId, 'session.json'), JSON.stringify(session, null, 2));
}

describe('durable model persistence on unblock/resume', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Create + start a task on OLD_MODEL and wait until it is blocked. */
  async function startedTask(): Promise<string> {
    const taskId = await createTask(ctx, 'Model persistence test', 'Do work');
    const startResult = await ctx.lazyMocked(
      ['start', taskId, '--yes', '--model', OLD_MODEL],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(startResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);
    // Sanity: first launch persisted the start model.
    expect(readTaskJson(ctx.root, taskId).model).toBe(OLD_MODEL);
    return taskId;
  }

  // INVARIANT: An explicit `unblock --model X` is a durable choice — it must
  // persist X to task.model even when task.model is already non-empty.
  // Auto-resume/auto-deliver relaunch from task.model; without persistence a
  // stale model relaunches and can crash-loop (the production incident).
  test('unblock --model persists the override to task.model even when already set', async () => {
    const taskId = await startedTask();

    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Switch model', '--model', NEW_MODEL],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);

    expect(readTaskJson(ctx.root, taskId).model).toBe(NEW_MODEL);
  });

  // INVARIANT: A plain unblock (no --model) must NOT clobber the persisted
  // task.model — only an explicit override changes the durable choice.
  test('plain unblock does not change task.model', async () => {
    const taskId = await startedTask();

    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Keep going'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);

    expect(readTaskJson(ctx.root, taskId).model).toBe(OLD_MODEL);
  });

  // INVARIANT: `resume --model X` persists X to task.model, same as unblock —
  // both surfaces deliver an explicit, durable model choice.
  test('resume --model persists the override to task.model even when already set', async () => {
    const taskId = await startedTask();

    const resumeResult = await ctx.lazyMocked(
      ['resume', taskId, '--model', NEW_MODEL],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(resumeResult);

    expect(readTaskJson(ctx.root, taskId).model).toBe(NEW_MODEL);
  });

  // INVARIANT: After `unblock --model X`, a daemon AUTO-RESUME must relaunch
  // on X — not on the model the task was started with. This is the exact
  // regression that caused the incident: the auto-resume path reads
  // task.model, so the unblock override must have been persisted there.
  test('auto-resume after unblock --model relaunches on the new model', async () => {
    const taskId = await startedTask();

    // Human explicitly switches the model.
    const unblockResult = await ctx.lazyMocked(
      ['unblock', taskId, '--message', 'Switch model', '--model', NEW_MODEL],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
    );
    expectSuccess(unblockResult);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const fullId = findFullTaskId(ctx.root, taskId);

    // Simulate a crash mid-turn: task stuck in 'working', supervisor gone, no
    // response, grace period elapsed. The daemon reconciler must mark it
    // interrupted and auto-resume it.
    const task = readTaskJson(ctx.root, taskId);
    task.status = 'working';
    writeTaskJson(ctx.root, fullId, task);
    const session = readSessionJson(ctx.root, fullId);
    session.last_interaction_at = new Date(Date.now() - 120_000).toISOString();
    writeSessionJson(ctx.root, fullId, session);
    consumeResponse(getProtocolDir(fullId));

    // Wait for the daemon reconcile loop (5s ticks) to auto-resume: it writes
    // a fresh UnblockCommand whose prompt carries the resume/crash context.
    let resumeCommand: UnblockCommand | null = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const cmd = readCommand(getProtocolDir(fullId)) as UnblockCommand | null;
      if (cmd && cmd.type === 'unblock' && /interrupted/i.test(cmd.prompt ?? '')) {
        resumeCommand = cmd;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    expect(resumeCommand).not.toBeNull();
    // The relaunch uses the model persisted by the unblock override — the
    // stale start model would be the incident regressing.
    expect(resumeCommand!.model_id).toBe(NEW_MODEL);
  }, 60_000); // several daemon reconcile ticks (5s each) may pass before auto-resume
});
