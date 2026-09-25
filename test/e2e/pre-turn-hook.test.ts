/**
 * `[automation] pre_turn` end-to-end, on the fake-`claude`-binary seam.
 *
 * The hook is a SUPERVISOR phase: it runs between the upstream merge and the
 * agent launch, in the task worktree. The module mock (`test/mocks/claude.ts`)
 * replaces `launchSupervisorAsync` wholesale, so it can never observe any of
 * that. Here a real daemon launches a real `lazy supervise`, which really runs
 * the hook and really launches a scriptable fake agent — so what these tests
 * assert is the production path.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';
import { agentTurns, taskStatus, turnPrompts } from '../helpers/agent-seam';

/**
 * Set `[automation]` pre-turn keys for the project, and COMMIT them.
 *
 * The keys are EDITED into the `[automation]` table `lazy init` already wrote —
 * appending a second `[automation]` header would be a TOML redefinition error,
 * and leaving the edit uncommitted would never reach the supervisor (a turn's
 * config is resolved from the task WORKTREE, branched from main).
 */
async function setPreTurn(
  ctx: TestContext,
  keys: { pre_turn?: string; pre_turn_timeout?: number; pre_turn_required?: boolean },
): Promise<void> {
  const configPath = join(ctx.root, 'lazy.toml');
  const before = await readFile(configPath, 'utf-8');
  const lines = Object.entries(keys).map(([k, v]) =>
    typeof v === 'string' ? `${k} = ${JSON.stringify(v)}` : `${k} = ${v}`,
  );
  const after = before.replace('[automation]\n', `[automation]\n${lines.join('\n')}\n`);
  if (after === before) throw new Error('lazy.toml has no [automation] section to edit');
  await writeFile(configPath, after, 'utf-8');
  ctx.git('add', 'lazy.toml');
  const commit = ctx.git('commit', '-m', 'Configure pre-turn hook for this test');
  if (commit.exitCode !== 0) throw new Error(`Failed to commit pre_turn config: ${commit.stderr}`);
}

describe('[automation] pre_turn hook (real supervisor, fake claude)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // The hook's whole purpose is "the environment is ready when the agent
  // starts", so where and when it runs is the feature.
  test('runs in the task worktree before the agent turn', async () => {
    const marker = join(ctx.root, 'hook-cwd.txt');
    await setPreTurn(ctx, { pre_turn: `pwd > ${marker}`, pre_turn_timeout: 60 });

    const taskId = await createTask(ctx, 'Pre-turn hook runs', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ result: 'done', sessionId: 'pre-turn-ok' }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const cwd = (await readFile(marker, 'utf-8')).trim();
    expect(cwd).toContain('worktrees');
    // The turn itself ran normally — a healthy hook is invisible to the agent.
    expect(await taskStatus(ctx.root, taskId)).toBe('blocked');
    const prompts = await turnPrompts(ctx);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).not.toContain('Environment warning');
  }, 90_000);

  // INVARIANT: a failing hook is LOUD but NON-FATAL by default. The turn still
  // runs, and the agent is told its environment is degraded rather than being
  // left to infer it from mysterious downstream failures.
  //
  // This also pins stdout capture end to end: service scripts routinely report
  // failure on stdout, which the helper used to drain to a null sink.
  test('a failing hook warns the agent in-prompt and records the failure on the turn', async () => {
    await setPreTurn(ctx, {
      pre_turn: 'echo boom-on-stdout; echo boom-on-stderr >&2; exit 3',
      pre_turn_timeout: 60,
    });

    const taskId = await createTask(ctx, 'Pre-turn hook fails', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ result: 'done anyway', sessionId: 'pre-turn-fail' }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // The turn ran.
    expect(await taskStatus(ctx.root, taskId)).toBe('blocked');

    const prompts = await turnPrompts(ctx);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain('Environment warning');
    expect(prompts[0]).toContain('boom-on-stdout');
    expect(prompts[0]).toContain('boom-on-stderr');
    // The original prompt is still there — the warning is a prefix, not a
    // replacement.
    expect(prompts[0]).toContain('Do the work');

    // And it is attached to the turn, so a reviewer sees it without reading
    // the prompt lazy happened to send.
    // The WORK turn, named rather than taken as "the last agent turn": a
    // human-facing park also records the wrap-up presentation step as an agent
    // turn, and the hook belongs to the turn it ran before.
    const turns = await agentTurns(ctx.root, taskId);
    const work = turns.filter(t => (t.turn_type ?? 'work') === 'work');
    const last = work[work.length - 1]!;
    expect(last.pre_turn_exit_code).toBe(3);
    expect(String(last.pre_turn_output)).toContain('boom-on-stdout');
  }, 90_000);

  // INVARIANT: `pre_turn_required = true` means the agent is NEVER launched on
  // a failed hook, and the task lands in the human's queue rather than
  // auto-resuming into the same deterministic failure on a timer.
  test('pre_turn_required = true fails the turn without launching the agent', async () => {
    await setPreTurn(ctx, {
      pre_turn: 'echo cannot-start-services >&2; exit 1',
      pre_turn_timeout: 60,
      pre_turn_required: true,
    });

    const taskId = await createTask(ctx, 'Pre-turn hook required', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ result: 'never runs', sessionId: 'pre-turn-req' }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // No agent turn was ever launched.
    expect(await turnPrompts(ctx)).toHaveLength(0);

    const status = await taskStatus(ctx.root, taskId);
    expect(status).toBe('blocked');

    const show = await ctx.lazy(['show', taskId, '--full']);
    expect(show.stdout).toContain('Pre-turn hook failed');
    expect(show.stdout).toContain('cannot-start-services');
  }, 90_000);
});
