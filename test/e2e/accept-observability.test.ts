import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskStatus, setTaskStatus } from '../helpers/storage';

/**
 * Accept observability: what the human sees while an accept runs, and what the
 * task's status says at each moment.
 *
 * WHY: an accept can run for minutes (pre-accept turn, pushes, an LLM-written
 * merge description, the merge). It used to print nothing at all for that whole
 * window, and the task read `blocked` throughout — so a running accept was
 * indistinguishable from a hung one, and from a task nobody was accepting.
 *
 * These tests assert the two halves of the fix: the daemon narrates the accept
 * phase by phase to the CLI, and the stored status reflects the phase actually
 * in flight (including restoring the TRUE prior status when an accept aborts).
 */
describe('lazy accept observability', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // INVARIANT: `start` + `accept` need a real daemon — the reconciler is what
    // moves a task out of 'working' (see accept-reason / pre-accept suites).
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /** Append an [automation.pre_accept] table to the project's lazy.toml. */
  function configurePreAccept(opts: { enabled: boolean; commands?: string[]; timeout?: number }): void {
    const configPath = join(ctx.root, 'lazy.toml');
    const existing = readFileSync(configPath, 'utf-8');
    const lines = ['', '[automation.pre_accept]', `enabled = ${opts.enabled}`];
    if (opts.commands) lines.push(`commands = [${opts.commands.map(c => JSON.stringify(c)).join(', ')}]`);
    if (opts.timeout !== undefined) lines.push(`timeout = ${opts.timeout}`);
    writeFileSync(configPath, existing + lines.join('\n') + '\n');
  }

  /** Task started, waited out of 'working', with one commit on its branch. */
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

  // The plan is emitted BY THE DAEMON, from the same table the executed phases
  // come from, so the announced list can never drift from what actually runs.
  test('announces the phase plan up front and narrates each phase', async () => {
    const taskId = await setupBlockedTask('Phase output test');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);

    // The plan header + the numbered list.
    expectOutput(result, 'phases');
    expectOutput(result, '1. Branch-protection gate');
    expectOutput(result, 'Clean up worktree and children');

    // Pre-flight runs BEFORE the plan is known and is narrated as a prelude.
    expectOutput(result, 'Pre-flight validation');

    // Phases that actually ran are reported with their position in the plan.
    expect(result.stdout).toMatch(/\[\d+\/\d+\] Merge/);
    expect(result.stdout).toMatch(/\[\d+\/\d+\] Fast-forward and finalize/);

    // And the merge result still prints.
    expectOutput(result, 'accepted and merged');
  });

  // A phase that does not apply is announced and then explicitly skipped —
  // silence about an optional step reads as a step that was forgotten.
  test('phases that do not apply are reported as skipped, with a reason', async () => {
    const taskId = await setupBlockedTask('Skipped phase test');

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(result);
    expectOutput(result, 'skipped');
  });

  // INVARIANT: `merging` covers the WHOLE merge phase, not a 2ms window at the
  // end of it. Every read surface (ls, show, MCP) must be able to say "this
  // task is mid-merge" while the merge is actually happening.
  test('status history records merging before complete', async () => {
    const taskId = await setupBlockedTask('Status history test');

    expectSuccess(await ctx.lazy(['accept', taskId, '--yes']));

    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expectOutput(show, 'Status History');
    expectOutput(show, 'blocked → merging');
    expectOutput(show, 'merging → complete');
  });

  // INVARIANT: an aborted accept restores the status the task ACTUALLY had. A
  // conflict task carries unresolved file violations; silently rewriting it to
  // `blocked` (which is what the accept path used to hardcode) destroys that
  // signal and makes the task look reviewable when it is not.
  test('an aborted accept restores conflict rather than blocking the task', async () => {
    const taskId = await setupBlockedTask('Conflict restore test');
    setTaskStatus(ctx.root, taskId, 'conflict');
    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // A gate that always fails: the accept aborts after the pre-accept turn.
    configurePreAccept({ enabled: true, commands: ['exit 1'], timeout: 60 });

    const result = await ctx.lazy(['accept', taskId, '--yes']);
    expectFailure(result);

    expect(readTaskStatus(ctx.root, taskId)).toBe('conflict');

    // The restore is visible in the audit trail, not just in the end state.
    // (The entry INTO working reads `blocked → working` because this test seeded
    // `conflict` straight into storage, bypassing the transition recorder; the
    // restore is what this test is about.)
    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expectOutput(show, 'working → conflict');
    expectOutput(show, 'Task returned to conflict');
  });

  // The same abort from a blocked task must still land on blocked — restoring
  // the true prior status is not a licence to change the common case.
  test('an aborted accept from blocked still restores blocked', async () => {
    const taskId = await setupBlockedTask('Blocked restore test');
    configurePreAccept({ enabled: true, commands: ['exit 1'], timeout: 60 });

    expectFailure(await ctx.lazy(['accept', taskId, '--yes']));
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  });
});
