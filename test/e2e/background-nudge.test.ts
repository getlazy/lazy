/**
 * E2E: the once-per-turn background nudge, on the REAL supervisor (fake claude).
 *
 * Engineer's decision (2026-10-06): when a turn ends while background work the
 * agent started was still running and got stopped — Claude Code stops a
 * background shell 5s after the turn's result (measured on 2.1.291) — lazy
 * does not know whether the agent needed it, so it ASKS once, gently, in the
 * same session, before the commit nudge. Never on a read-only turn, never twice.
 * Event shapes are the measured ones (docs/claude-code-background-tasks.md).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario, backgroundShellScenario } from '../helpers/fake-claude';
import { taskDir } from '../helpers/agent-seam';
import { worktreePathFor } from '../helpers/storage';
import { launchAsPerson } from '../helpers/usage-pause';

const BG_HEADING = '## Stopped Background Work Check';
const COMMIT_HEADING = '## Uncommitted Changes Check';
const BG_QUESTION = "Are you sure you didn't need it to finish?";
const COMMIT_QUESTION = 'Have you committed all your work?';
const COMMAND = 'bun test test/e2e/slow.test.ts';

async function setReviewOff(ctx: TestContext): Promise<void> {
  const configPath = join(ctx.root, 'lazy.toml');
  const before = await readFile(configPath, 'utf-8');
  const after = before.replace('# mode = "low_high"', 'mode = "off"');
  if (after === before) throw new Error('could not set [review] mode in the init-produced lazy.toml');
  await writeFile(configPath, after);
  ctx.git('add', 'lazy.toml');
  expect(ctx.git('commit', '-m', 'Review mode off for this test').exitCode).toBe(0);
}

async function turnInvocations(ctx: TestContext) {
  return (await ctx.claudeInvocations()).filter(i => i.argv.includes('-p'));
}

// The prompt rides stdin, never argv (src/agent/argv-safety.ts).
function promptOf(invocation: { stdin?: string }): string {
  return invocation.stdin ?? '';
}

async function allTurns(root: string, shortId: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(await taskDir(root, shortId), 'turns.json'), 'utf-8');
  return (JSON.parse(raw) as { turns: Array<Record<string, unknown>> }).turns;
}

function countHeading(turns: Array<Record<string, unknown>>, heading: string): number {
  return turns.filter(t => String(t.content).startsWith(heading)).length;
}

const answer = (text: string, sessionId: string) => successScenario({ result: text, sessionId, declarePresentation: true });

describe('the once-per-turn background nudge (real supervisor, fake claude)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    await setReviewOff(ctx);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a background shell Claude Code stopped at turn end gets exactly
  // one question, in the same session, naming the command.
  test('a killed background shell gets one nudge naming the command', async () => {
    const taskId = await createTask(ctx, 'Killed bg', 'Do the work');
    await ctx.setClaudeScenario({ sequence: [
      backgroundShellScenario({ command: COMMAND, outcome: 'killed', sessionId: 'bg-work' }),
      answer('I did not need it; the targeted tests already passed.', 'bg-reply'),
    ] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const nudges = (await turnInvocations(ctx)).filter(i => promptOf(i).includes(BG_QUESTION));
    expect(nudges.length).toBe(1);
    expect(promptOf(nudges[0])).toContain(COMMAND);
    expect(nudges[0].argv).toContain('--resume');

    const turns = await allTurns(ctx.root, taskId);
    expect(countHeading(turns, BG_HEADING)).toBe(1);
    expect(turns.some(t => String(t.content).includes('I did not need it'))).toBe(true);
  }, 120_000);

  // INVARIANT: a background job that finished in time is not asked about.
  test('a background job that finished in time gets no nudge', async () => {
    const taskId = await createTask(ctx, 'Finished bg', 'Do the work');
    await ctx.setClaudeScenario({ sequence: [
      backgroundShellScenario({ command: COMMAND, outcome: 'completed', sessionId: 'bg-ok' }),
      answer('Nothing further.', 'bg-ok'),
    ] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    expect((await turnInvocations(ctx)).some(i => promptOf(i).includes(BG_QUESTION))).toBe(false);
    expect(countHeading(await allTurns(ctx.root, taskId), BG_HEADING)).toBe(0);
  }, 120_000);

  // INVARIANT: when both fire, the background question comes first, then the
  // commit question — re-running stopped work can change what is left to commit.
  test('both nudges in one turn run in order: background, then commit', async () => {
    const taskId = await createTask(ctx, 'Both nudges', 'Do the work');
    await ctx.setClaudeScenario({ sequence: [
      backgroundShellScenario({
        command: COMMAND, outcome: 'killed', sessionId: 'both-work',
        beforeResult: [{ kind: 'write-file', path: 'loose.txt', content: 'unfinished\n' }],
      }),
      answer('Did not need it.', 'both-bg'),
      answer('Leaving loose.txt; it is scratch.', 'both-commit'),
    ] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const invocations = await turnInvocations(ctx);
    const bgIdx = invocations.findIndex(i => promptOf(i).includes(BG_QUESTION));
    const commitIdx = invocations.findIndex(i => promptOf(i).includes(COMMIT_QUESTION));
    expect(bgIdx).toBeGreaterThan(0);
    expect(commitIdx).toBeGreaterThan(bgIdx);
    expect(invocations.filter(i => promptOf(i).includes(BG_QUESTION)).length).toBe(1);

    const turns = await allTurns(ctx.root, taskId);
    expect(countHeading(turns, BG_HEADING)).toBe(1);
    expect(countHeading(turns, COMMIT_HEADING)).toBe(1);
  }, 120_000);

  // INVARIANT: a read-only (plan-mode) turn is never nudged.
  test('a read-only turn gets no nudge', async () => {
    const taskId = await createTask(ctx, 'Read-only bg', 'Do the work');
    await ctx.setClaudeScenario(answer('Work done.', 'ro-work'));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    await ctx.setClaudeScenario(backgroundShellScenario({ command: COMMAND, outcome: 'killed', sessionId: 'ro-plan', result: 'Answered.' }));
    const launched = await launchAsPerson(ctx, 'unblockTask', {
      taskId, message: 'Why this approach?', permissionMode: 'plan',
    });
    expect(launched.exitCode).toBe(0);
    await ctx.lazy(['wait', taskId]);

    expect((await turnInvocations(ctx)).some(i => promptOf(i).includes(BG_QUESTION))).toBe(false);
    const turns = await allTurns(ctx.root, taskId);
    expect(countHeading(turns, BG_HEADING)).toBe(0);
    // Not vacuous: the read-only turn really ran and ended with a stopped shell.
    expect(turns.some(t => String(t.content).includes('Answered.'))).toBe(true);
  }, 120_000);
});

describe('the background nudge across the self-review loop (real supervisor, fake claude)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // Review mode left at its default, low_high: draft → self-review → revise.
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a revise that leaves nothing behind does not erase the draft's
  // stopped background work — the draft's command is still asked about, once.
  test('a draft whose background shell was stopped is asked about after a revise', async () => {
    const taskId = await createTask(ctx, 'Bg across revise', 'Do the work');
    await ctx.setClaudeScenario({ sequence: [
      backgroundShellScenario({ command: COMMAND, outcome: 'killed', sessionId: 'loop-work' }),
      successScenario({ result: '1. Tighten the wording in README.', sessionId: 'loop-review' }),
      answer('Applied the revision.', 'loop-revise'),
      answer('I did not need the background run.', 'loop-bg'),
      answer('Nothing further.', 'loop-tail'),
      answer('Nothing further.', 'loop-tail'),
    ] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const invocations = await turnInvocations(ctx);
    // Not vacuous: the revise phase really ran.
    expect(invocations.some(i => promptOf(i).includes('## Apply Self-Review Instructions'))).toBe(true);
    const nudges = invocations.filter(i => promptOf(i).includes(BG_QUESTION));
    expect(nudges.length).toBe(1);
    expect(promptOf(nudges[0])).toContain(COMMAND);
    expect(countHeading(await allTurns(ctx.root, taskId), BG_HEADING)).toBe(1);
  }, 180_000);
});
