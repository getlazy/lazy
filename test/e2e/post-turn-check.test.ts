/**
 * E2E tests for the post-turn check feature.
 *
 * Verifies that a configurable command runs after each agent turn,
 * its exit code and stderr output are captured, and the results
 * are attached to the turn for reviewers to see.
 *
 * The check runs as part of the reconcile pass that records the agent turn, so
 * this daemonless suite drives that pass explicitly via `startAndReconcile`.
 * `lazy start --follow` used to reconcile on the way out; post-v0.11 it does
 * not, and only the daemon reconciles on its own.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, startAndReconcile } from '../helpers/fixtures';
import { storageDirFor, taskFilePath } from '../helpers/storage';

function readTurns(root: string, shortId: string): Array<{
  role: string;
  content: string;
  check_exit_code?: number;
  check_output?: string;
}> {
  const turnsPath = taskFilePath(root, shortId, 'turns.json');
  const data = JSON.parse(readFileSync(turnsPath, 'utf-8'));
  return data.turns;
}

describe('post-turn check', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    const storageDir = storageDirFor(ctx.root);
    if (existsSync(storageDir)) {
      rmSync(storageDir, { recursive: true, force: true });
    }
    await ctx.cleanup();
  });

  // INVARIANT: When post_turn check passes (exit 0), the turn records exit code 0.
  test('captures passing check result on turn', async () => {
    // Configure a check command that always succeeds
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[checks]\npost_turn = "echo ok"\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable post-turn check');

    const taskId = await createTask(ctx, 'Do something', 'Do the thing');

    // Daemonless: drive the reconcile pass that records the agent turn (and
    // with it the post-turn check result). --follow no longer reconciles.
    await startAndReconcile(ctx, taskId);

    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.check_exit_code).toBe(0);
    // check_output may be empty string for echo to stdout (stderr captured)
    expect(agentTurn!.check_output).toBeDefined();
  });

  // INVARIANT: When post_turn check fails (non-zero exit), the turn records exit code and stderr.
  test('captures failing check result with exit code and stderr', async () => {
    // Configure a check command that fails and writes to stderr
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[checks]\npost_turn = "echo failure-output >&2 && exit 1"\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable failing post-turn check');

    const taskId = await createTask(ctx, 'Do something', 'Do the thing');

    // Daemonless: drive the reconcile pass that records the agent turn (and
    // with it the post-turn check result). --follow no longer reconciles.
    await startAndReconcile(ctx, taskId);

    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.check_exit_code).toBe(1);
    expect(agentTurn!.check_output).toContain('failure-output');
  });

  // INVARIANT: When no checks are configured, turns have no check data (backward compatible).
  test('no check data when checks are not configured', async () => {
    const taskId = await createTask(ctx, 'Do something', 'Do the thing');

    // Daemonless: drive the reconcile pass that records the agent turn (and
    // with it the post-turn check result). --follow no longer reconciles.
    await startAndReconcile(ctx, taskId);

    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.check_exit_code).toBeUndefined();
    expect(agentTurn!.check_output).toBeUndefined();
  });

  // INVARIANT: Check output is truncated to 200 lines when verbose.
  test('truncates check output to 200 lines', async () => {
    // Create a script that outputs 250 lines to stderr
    const scriptPath = join(ctx.root, 'noisy-check.sh');
    writeFileSync(scriptPath, 'for i in $(seq 1 250); do echo "line $i" >&2; done; exit 1\n');
    ctx.git('add', 'noisy-check.sh');
    ctx.git('commit', '-m', 'Add noisy check script');

    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[checks]\npost_turn = "sh noisy-check.sh"\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable noisy post-turn check');

    const taskId = await createTask(ctx, 'Do something', 'Do the thing');

    // Daemonless: drive the reconcile pass that records the agent turn (and
    // with it the post-turn check result). --follow no longer reconciles.
    await startAndReconcile(ctx, taskId);

    const turns = readTurns(ctx.root, taskId);
    const agentTurn = turns.find(t => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn!.check_exit_code).toBe(1);
    // Should be truncated to last 200 lines with a truncation notice
    const output = agentTurn!.check_output!;
    expect(output).toContain('... (');
    expect(output).toContain('lines truncated)');
    // Should contain the last line (line 250)
    expect(output).toContain('line 250');
    // Should NOT contain the first line (line 1) since it was truncated
    expect(output).not.toContain('line 1\n');
  });

  // Verify check results are visible in show --json output
  test('check results appear in show --json output', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const existingConfig = readFileSync(configPath, 'utf-8');
    writeFileSync(configPath, existingConfig + '\n[checks]\npost_turn = "echo check-ran >&2 && exit 42"\n');
    ctx.git('add', 'lazy.toml');
    ctx.git('commit', '-m', 'Enable check for show test');

    const taskId = await createTask(ctx, 'Do something', 'Do the thing');

    await startAndReconcile(ctx, taskId);

    const showResult = await ctx.lazy(['show', taskId, '--json']);
    expectSuccess(showResult);

    const showData = JSON.parse(showResult.stdout);
    const agentTurn = showData.turns?.find((t: { role: string }) => t.role === 'agent');
    expect(agentTurn).toBeDefined();
    expect(agentTurn.check_exit_code).toBe(42);
    expect(agentTurn.check_output).toContain('check-ran');
  });
});
