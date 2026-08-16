/**
 * Test fixtures and convenience helpers
 */

import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { TestContext, MockAgentResponse } from './setup';
import { extractTaskId } from './assertions';
import { runReconcile } from './reconcile';

/** Create a task with goal and optional prompt, return the short task ID */
export async function createTask(
  ctx: TestContext,
  goal: string,
  prompt?: string,
): Promise<string> {
  const args = ['create', '--goal', goal];
  if (prompt) {
    args.push('--prompt', prompt);
  }
  const result = await ctx.lazy(args);
  if (result.exitCode !== 0) {
    throw new Error(`Failed to create task: ${result.stderr}\n${result.stdout}`);
  }
  return extractTaskId(result.stdout);
}

/**
 * Create a task that a daemon-based test will operate on, asserting that the
 * daemon has not been started yet.
 *
 * WHY THIS EXISTS: `startDaemonServer()` in a test process opens storage and
 * holds `<dataDir>/.storage-lock` for the daemon's whole lifetime. `ctx.lazy()`
 * runs the CLI as a SUBPROCESS, so it is a different pid and sees a live
 * holder — it then retries for ~7 seconds and fails with a message about two
 * projects sharing one store, which is both slow and a lie. Every daemon suite
 * already creates its fixtures first; this makes that ordering explicit and
 * enforced instead of folklore, and turns the 7s mystery into an immediate,
 * accurate error.
 *
 * Use `createTask` as normal for tests with no in-process daemon.
 */
export async function createTaskBeforeDaemon(
  ctx: TestContext,
  goal: string,
  prompt?: string,
): Promise<string> {
  const lockPath = join(ctx.root, '.lazy', '.storage-lock');
  if (existsSync(lockPath)) {
    throw new Error(
      `createTaskBeforeDaemon('${goal}') was called while the storage lock is held ` +
      `(${lockPath}).\n` +
      `An in-process daemon holds that lock for its lifetime, and \`lazy create\` runs ` +
      `as a subprocess, so it would retry for ~7s and then fail with a misleading ` +
      `"storage paths collide" error.\n` +
      `Move this call above startDaemonServer() in the test's setup.`,
    );
  }
  return createTask(ctx, goal, prompt);
}

/**
 * Resolve a task's full UUID from its short id via `lazy show --full`.
 *
 * Needed wherever a component is addressed as a task rather than about one —
 * notably `lazy-agent mcp --task-id`, which scopes every tool call to "your own
 * task or its direct subtasks".
 */
export async function fullTaskId(ctx: TestContext, shortId: string): Promise<string> {
  const showResult = await ctx.lazy(['show', shortId, '--full']);
  const match = showResult.stdout.match(/ID:\s+([a-f0-9-]{36})/);
  if (!match) {
    throw new Error(`Could not extract full task id for ${shortId}: ${showResult.stdout}`);
  }
  return match[1];
}

/** Standard mock response for tests that need Claude to "work" */
export const MOCK_CLAUDE_SUCCESS: MockAgentResponse = {
  result: 'I have completed the task. All changes have been committed.',
  session_id: 'mock-sess-001',
  usage: { input_tokens: 500, output_tokens: 1000 },
};

export interface StartOptions {
  /** Extra env for the `lazy start` subprocess (merged over the defaults). */
  env?: Record<string, string>;
  /** Mock response the started agent writes (default: MOCK_CLAUDE_SUCCESS). */
  mockResponse?: MockAgentResponse;
  /**
   * Have the mock agent commit a change in the worktree (default: true).
   * Suites that assert on an empty branch can turn this off.
   */
  commit?: boolean;
}

/**
 * DAEMONLESS: start a task, then drive one reconcile pass so it lands in
 * `blocked`.
 *
 * `lazy start` returns as soon as the agent is launched. Post-v0.11 ONLY the
 * daemon's reconcile loop transitions working → blocked when the agent's
 * response lands, and no CLI command triggers a pass. A daemonless suite that
 * just calls `start` leaves every task stuck in `working` forever — every later
 * `blocked`/`accept`/`unblock` assertion then fails with an empty list or
 * "Task X is still working". Such suites must drive the pass themselves.
 *
 * Use this for suites that must stay daemonless (they poke storage directly,
 * or assert on reconcile-produced records). Suites that exercise real
 * daemon-mediated flows should use `setupTestLazy({ withDaemon: true })` plus
 * `startAndWait` instead.
 */
export async function startAndReconcile(
  ctx: TestContext,
  taskId: string,
  options: StartOptions = {},
): Promise<void> {
  const { commit = true, mockResponse = MOCK_CLAUDE_SUCCESS, env } = options;
  const result = await ctx.lazyMocked(['start', taskId, '--yes'], mockResponse, {
    env: { ...(commit ? { LAZY_MOCK_SHOULD_COMMIT: '1' } : {}), ...env },
  });
  if (result.exitCode !== 0) {
    throw new Error(`start failed for ${taskId}: ${result.stderr}\n${result.stdout}`);
  }
  await runReconcile(ctx.root, ctx.protocolBase, mockResponse);
}

/**
 * WITH DAEMON: start a task and block until the daemon's reconciler has moved
 * it out of `working` (into `blocked`) — the state `accept`/`unblock` require.
 *
 * The explicit `wait` is mandatory: under the daemon the supervisor is launched
 * asynchronously, so `start` returning says nothing about the task's status.
 * Requires `setupTestLazy({ withDaemon: true })`.
 */
export async function startAndWait(
  ctx: TestContext,
  taskId: string,
  options: StartOptions = {},
): Promise<void> {
  const { commit = true, mockResponse = MOCK_CLAUDE_SUCCESS, env } = options;
  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], mockResponse, {
    env: { ...(commit ? { LAZY_MOCK_SHOULD_COMMIT: '1' } : {}), ...env },
  });
  if (startResult.exitCode !== 0) {
    throw new Error(`start failed for ${taskId}: ${startResult.stderr}\n${startResult.stdout}`);
  }

  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }
}

/**
 * DAEMONLESS: take a task all the way to `complete` — start, drive the
 * reconcile pass that lands it in `blocked`, then accept.
 *
 * Suites that only need an accepted task to operate on (rework, revert, redo,
 * reopen) go through this so the three-step dance lives in one place. Call
 * `disablePreAccept(ctx.root)` in the suite's `beforeEach`: a daemonless suite
 * has no runner to execute the pre-accept agent turn.
 */
export async function startAndAccept(
  ctx: TestContext,
  taskId: string,
  options: StartOptions = {},
): Promise<void> {
  await startAndReconcile(ctx, taskId, options);
  const result = await ctx.lazy(['accept', taskId, '--yes']);
  if (result.exitCode !== 0) {
    throw new Error(`accept failed for ${taskId}: ${result.stderr}\n${result.stdout}`);
  }
}

/**
 * Disable the pre-accept turn ([automation.pre_accept], on by default).
 *
 * A daemonless suite has nothing to run that agent turn against, so `accept`
 * would fail trying to launch a real runner; suites that assert only on
 * post-accept state treat the turn as noise. Suites that exercise the
 * pre-accept step itself live in pre-accept.test.ts.
 *
 * The generated lazy.toml already has a bare [automation] table, so appending
 * the sub-table is valid TOML.
 */
export function disablePreAccept(root: string): void {
  const configPath = join(root, 'lazy.toml');
  const existing = readFileSync(configPath, 'utf-8');
  writeFileSync(configPath, `${existing}\n[automation.pre_accept]\nenabled = false\n`);
}
