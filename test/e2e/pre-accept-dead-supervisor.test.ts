/**
 * E2E: a pre-accept turn whose supervisor never answers must abort in SECONDS.
 *
 * Field report from the released version: `lazy accept` sat at
 *
 *     · [4/12] Pre-accept validation turn… 2m43s (and climbing)
 *
 * with the task's container not running at all and nothing building or testing.
 * The daemon's pre-accept wait polled only for `response.json`, with no liveness
 * check anywhere in the loop, so a supervisor that died before answering — or
 * one that was never launched because a stale `isRunning` said one was already
 * up — held the accept for `agent.watchdog_output_timeout_ms + 5m` (~35 minutes
 * by default) before the timeout path fired.
 *
 * INVARIANT: the pre-accept wait aborts on supervisor death, not on the
 * timeout. The task returns to its prior status and the reason is recorded on
 * the task itself, exactly as the timeout and launch-failure paths already do —
 * this abort can outlive the client that asked for it, so the CLI's error is not
 * the only place the explanation may land.
 *
 * The seam: `LAZY_MOCK_PRE_ACCEPT_SUPERVISOR_DIES` makes the mock supervisor
 * return from a `pre_accept` command without writing anything, and this mock's
 * `isContainerRunning` always reports false — together, a run that answers
 * nothing and is not there. It is set as `daemonEnv` because the pre-accept turn
 * is launched by the DAEMON's mock, which per-test env never reaches.
 *
 * The whole abort is bounded by the helper's two graces (a startup grace so a
 * slow launch is not mistaken for a death, then a death grace so the normal
 * write-response-then-exit ending is not either), so this suite's tests carry an
 * explicit per-test timeout — bun's default 5000ms is under the grace by design.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/** Generous per-test budget; the assertion below is what actually pins the speed. */
const TEST_TIMEOUT_MS = 120_000;

/**
 * The abort must be nowhere near the real pre-accept budget. The default
 * watchdog is 30 minutes and the daemon adds a 5-minute margin, so anything
 * under a minute proves the wait no longer runs to that deadline.
 */
const ABORT_BUDGET_MS = 60_000;

/**
 * Turn the pre-accept step on, and hand back an undo that restores the config
 * VERBATIM. Restoring the original text rather than rewriting `enabled = true`
 * matters: init's lazy.toml has other `enabled` keys, so a `.replace()` would
 * flip the first one it found and leave pre-accept on.
 */
function configurePreAccept(ctx: TestContext): () => void {
  const configPath = join(ctx.root, 'lazy.toml');
  const original = readFileSync(configPath, 'utf-8');
  writeFileSync(
    configPath,
    `${original}\n[automation.pre_accept]\nenabled = true\ncommands = ["true"]\ntimeout = 60\n`,
  );
  return () => writeFileSync(configPath, original);
}

/** A blocked task with a commit to merge. Mirrors pre-accept.test.ts. */
async function setupBlockedTask(ctx: TestContext, goal: string): Promise<string> {
  const taskId = await createTask(ctx, goal, 'Some work');

  const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  });
  expectSuccess(startResult);

  const waitResult = await ctx.lazy(['wait', taskId]);
  if (waitResult.exitCode !== 0) {
    throw new Error(`wait failed for ${taskId}: ${waitResult.stderr}\n${waitResult.stdout}`);
  }

  const worktreePath = join(ctx.root, '.lazy', 'worktrees', taskId);
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature content\n');
  expect(ctx.git('-C', worktreePath, 'add', 'feature.txt').exitCode).toBe(0);
  expect(ctx.git('-C', worktreePath, 'commit', '-m', 'Add feature').exitCode).toBe(0);

  return taskId;
}

describe('pre-accept aborts when the supervisor never answers', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_PRE_ACCEPT_SUPERVISOR_DIES: '1' },
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('the accept fails fast instead of waiting out the pre-accept budget', async () => {
    const taskId = await setupBlockedTask(ctx, 'Dead supervisor abort test');
    configurePreAccept(ctx);

    const started = Date.now();
    const result = await ctx.lazy(['accept', taskId, '--yes']);
    const elapsed = Date.now() - started;

    expectFailure(result);
    expect(elapsed).toBeLessThan(ABORT_BUDGET_MS);

    // The task is back where it started, and the merge did not happen.
    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expectOutput(show, 'blocked');
    // The reason is on the TASK, not only in the CLI's stderr — the abort can
    // outlive the client that asked for it.
    expectOutput(show, 'no longer running');
  }, TEST_TIMEOUT_MS);

  test('a dead supervisor leaves the task re-acceptable', async () => {
    // The abort must be clean: nothing half-merged, nothing wedged in 'working'.
    // Re-running accept with the step disabled merges normally.
    const taskId = await setupBlockedTask(ctx, 'Dead supervisor recovery test');
    const disablePreAccept = configurePreAccept(ctx);

    const failed = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(failed);

    disablePreAccept();

    const retry = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(retry);
    expectOutput(retry, 'accepted and merged');
  }, TEST_TIMEOUT_MS);
});

/**
 * INVARIANT: a merge never proceeds on a response that did not answer the
 * pre-accept command.
 *
 * The protocol dir has no command↔response correlation id — the wait consumes
 * whatever `response.json` holds — so if another command takes over the channel
 * mid-wait (an auto-resume's `unblock`, an auto-delivered comment, a manual
 * turn), the accept gets that turn's ordinary work response instead. It has no
 * `pre_accept` block, because only `handlePreAcceptCommand` ever writes one, and
 * it writes one on EVERY completed pre-accept answer — the empty-command-list
 * case included, as `{ passed: true }`.
 *
 * The daemon used to read that as `gate && !gate.passed` → falsy → pass, so the
 * accept merged having validated nothing, and recorded the foreign turn under
 * the "Pre-accept validation" heading so the task history claimed a validation
 * that never ran. This is the "proceeded and merged successfully" half of the
 * field report the ownership guard alone did not explain.
 */
describe('pre-accept refuses to merge on a response that is not its own', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: { LAZY_MOCK_PRE_ACCEPT_FOREIGN_RESPONSE: '1' },
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('a completed response with no gate result aborts the accept', async () => {
    const taskId = await setupBlockedTask(ctx, 'Foreign response test');
    configurePreAccept(ctx);

    const result = await ctx.lazy(['accept', taskId, '--yes']);

    expectFailure(result);
    // The merge must NOT have happened — this is the whole point.
    const log = ctx.git('-C', ctx.root, 'log', '--oneline', '-n', '20');
    expect(log.stdout).not.toContain('Add feature');

    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expectOutput(show, 'blocked');
    // `lazy show` truncates comment bodies, so assert on the opening clause.
    expectOutput(show, 'Pre-accept validation aborted');
  }, TEST_TIMEOUT_MS);
});
