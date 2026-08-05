import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';

/**
 * E2E tests for the pre-accept validation step ([automation.pre_accept]).
 *
 * The step is OPT-IN: `enabled` defaults to false, so every test here that
 * wants the step must set `enabled = true` explicitly.
 *
 * When enabled, on accept, BEFORE the merge, the daemon runs a final agent turn (recorded
 * under a "Pre-accept validation" heading) where the agent runs the configured
 * commands, brings maintained files up to date, and records a post-mortem. The
 * supervisor then re-runs the configured commands as the AUTHORITATIVE merge
 * gate — a non-zero exit aborts the accept and returns the task to blocked
 * (never a silent merge).
 *
 * INVARIANT: pre-accept command failure blocks the merge. There is no override
 * flag — the user fixes the issue and re-accepts.
 *
 * The gate commands come from config (via the pre_accept command file), NOT
 * from env, so no daemon env plumbing is needed: the mock supervisor
 * (test/mocks/claude.ts#handleMockPreAccept) re-runs cmd.pre_accept_commands in
 * the worktree exactly like the real handler. `loadConfig` is un-memoized and
 * the accept path re-reads lazy.toml per accept, so writing config after the
 * daemon starts takes effect immediately.
 */
describe('lazy accept pre-accept step', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // INVARIANT: `start` + `accept` need a real daemon (see accept-gates /
    // accept-reason). The reconciler moves the task out of 'working'; the
    // daemon runs the pre-accept turn synchronously during accept.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * Append an [automation.pre_accept] table to the project's lazy.toml. The
   * generated config already has a bare [automation] table (maintain commented
   * out), so appending the sub-table is valid TOML.
   */
  function configurePreAccept(
    opts: { enabled?: boolean; commands?: string[]; timeout?: number },
  ): void {
    const configPath = join(ctx.root, 'lazy.toml');
    const existing = readFileSync(configPath, 'utf-8');
    const lines = ['', '[automation.pre_accept]'];
    if (opts.enabled !== undefined) lines.push(`enabled = ${opts.enabled}`);
    if (opts.commands !== undefined) {
      lines.push(`commands = [${opts.commands.map(c => JSON.stringify(c)).join(', ')}]`);
    }
    if (opts.timeout !== undefined) lines.push(`timeout = ${opts.timeout}`);
    writeFileSync(configPath, existing + lines.join('\n') + '\n');
  }

  /**
   * Create a task, start it, wait for it to leave 'working', and commit a file
   * in the worktree so accept has something to merge. Mirrors accept-reason:
   * under withDaemon the per-test LAZY_MOCK_SHOULD_COMMIT does not reach the
   * daemon-run agent, so the test makes the commit itself.
   */
  async function setupBlockedTask(goal: string): Promise<string> {
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

  // INVARIANT: the pre-accept step is OPT-IN. A project with no
  // [automation.pre_accept] section runs NO pre-accept turn — accept merges
  // immediately. The step costs a full agent turn that the accept blocks on, so
  // the default must stay false; a project turns it on with enabled = true.
  //
  // The assertion is load-bearing in two directions: `commands` that WOULD fail
  // never run (so the merge succeeds), and the CLI prints no pre-accept
  // heads-up. Note the commands are written WITHOUT `enabled`, exactly as a
  // user who set only `commands` would have them.
  test('default config runs NO pre-accept turn', async () => {
    const taskId = await setupBlockedTask('Pre-accept default-off test');
    // No [automation.pre_accept] section at all — the shipped default.

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted and merged');
    expectOutputExcludes(result, 'Running pre-accept validation before merge');

    // No pre-accept turn was recorded in the task history.
    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expect(show.stdout).not.toContain('Pre-accept validation');
  });

  // INVARIANT: `commands` alone does NOT turn the step on — `enabled = true` is
  // the switch. Without it a configured gate command is never run.
  test('commands without enabled = true does not run the step', async () => {
    const taskId = await setupBlockedTask('Pre-accept commands-only test');
    // A command that WOULD fail if the step ran, but `enabled` is left default.
    configurePreAccept({ commands: ['exit 1'], timeout: 60 });

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted and merged');
    expectOutputExcludes(result, 'Running pre-accept validation before merge');
  });

  // INVARIANT: a failing pre-accept command aborts the merge and returns the
  // task to blocked — never a silent merge.
  test('blocks the merge when a configured command fails', async () => {
    const taskId = await setupBlockedTask('Pre-accept fail test');
    configurePreAccept({ enabled: true, commands: ['exit 1'], timeout: 60 });

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(result);
    expectError(result, 'Pre-accept checks failed');

    // The task must be back to blocked (re-acceptable), and the failure recorded.
    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expectOutput(show, 'blocked');
    expectOutput(show, 'Pre-accept checks failed');
  });

  // INVARIANT: when the configured command passes, the merge proceeds.
  test('merges when the configured command passes', async () => {
    const taskId = await setupBlockedTask('Pre-accept pass test');
    configurePreAccept({ enabled: true, commands: ['true'], timeout: 60 });

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    // The caller is told about the extra step up front.
    expectOutput(result, 'Running pre-accept validation before merge');
    expectOutput(result, 'accepted and merged');
  });

  // The gate runs in the TASK WORKTREE against the final diff: a command that
  // checks for the task's committed file passes; the pre-accept turn is recorded
  // (this is where maintained-files + CHANGELOG + post-mortem work happens).
  test('runs the gate in the worktree and records the pre-accept turn', async () => {
    const taskId = await setupBlockedTask('Pre-accept worktree test');
    configurePreAccept({ enabled: true, commands: ['test -f feature.txt'], timeout: 60 });

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted and merged');

    // The pre-accept turn is persisted under its heading — the reviewer can see
    // the accept-time validation turn in the task history.
    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expectOutput(show, 'Pre-accept validation');
  });

  // INVARIANT: enabled = false opts the project out of the whole step — the
  // failing command is never run and the accept merges directly.
  test('enabled = false skips the pre-accept step entirely', async () => {
    const taskId = await setupBlockedTask('Pre-accept disabled test');
    // A command that WOULD fail if it ran — but the step is disabled.
    configurePreAccept({ enabled: false, commands: ['exit 1'] });

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'accepted and merged');
    // No heads-up when the step is disabled.
    expectOutputExcludes(result, 'Running pre-accept validation before merge');
  });

  // A blocked-by-gate task is cleanly re-acceptable once the issue is fixed.
  test('a task blocked by the gate can be re-accepted after fixing the config', async () => {
    const taskId = await setupBlockedTask('Pre-accept recover test');
    configurePreAccept({ enabled: true, commands: ['exit 1'], timeout: 60 });

    const failed = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(failed);
    expectError(failed, 'Pre-accept checks failed');

    // Fix the gate and re-accept — the merge now proceeds.
    const configPath = join(ctx.root, 'lazy.toml');
    writeFileSync(configPath, readFileSync(configPath, 'utf-8').replace('commands = ["exit 1"]', 'commands = ["true"]'));

    const retry = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(retry);
    expectOutput(retry, 'accepted and merged');
  });
});
