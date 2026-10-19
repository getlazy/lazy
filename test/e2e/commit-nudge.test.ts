/**
 * E2E: the once-per-turn commit nudge, on the REAL supervisor (fake claude).
 *
 * The engineer's design (2026-10-06): when a work turn is about to end with a
 * dirty worktree — final or parked — the supervisor asks the agent ONCE, in the
 * same session, "have you committed all your work?". Never twice in a turn,
 * never on a read-only turn, never committing for the agent; whatever is still
 * loose afterwards is announced on the task and as a system notice.
 *
 * Only this seam can observe it: the nudge is an extra `claude -p` invocation
 * inside one turn, and the module mock replaces the supervisor wholesale.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario, type ClaudeScenario } from '../helpers/fake-claude';
import { taskDir } from '../helpers/agent-seam';
import { worktreePathFor, readSystemMessagesFile } from '../helpers/storage';
import { launchAsPerson } from '../helpers/usage-pause';

const NUDGE_HEADING = '## Uncommitted Changes Check';
const LEFTOVERS_HEADING = '## Uncommitted Work';

/** Review mode `off`, so a turn is the work invocation plus its wrap-up only. */
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

/** The work invocation: leaves `loose.txt` uncommitted (plus whatever else). */
function dirtyWork(extra: ClaudeScenario['steps'] = []): ClaudeScenario {
  const s = successScenario({ result: 'Work done.', sessionId: 'nudge-work', declarePresentation: true });
  s.steps.splice(3, 0, { kind: 'write-file', path: 'loose.txt', content: 'unfinished\n' }, ...extra);
  return s;
}

/** An agent answer that commits nothing. */
function answer(text: string, sessionId: string): ClaudeScenario {
  return successScenario({ result: text, sessionId, declarePresentation: true });
}

/** Declares the turn final through the handoff fallback (the fake has no MCP). */
const DECLARE_FINAL = {
  kind: 'write-file' as const,
  path: '.lazy-task-sandbox/turn-handoff.jsonl',
  content: '{"kind":"final","content":"done"}\n',
};

describe('the once-per-turn commit nudge (real supervisor, fake claude)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    await setReviewOff(ctx);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a PARKED turn with a dirty worktree is asked exactly once, in
  // the same session, and then parks. A park never runs the commit_leftovers
  // step — the nudge is the only question.
  test('a parked turn with a dirty tree gets exactly one nudge, then parks', async () => {
    const taskId = await createTask(ctx, 'Park dirty', 'Do the work');
    await ctx.setClaudeScenario({ sequence: [
      dirtyWork(),
      { steps: [
        ...answer('Committed it.', 'nudge-reply').steps.slice(0, 3),
        { kind: 'commit', message: 'Commit the loose file', files: [{ path: 'loose.txt', content: 'unfinished\n' }] },
        ...answer('Committed it.', 'nudge-reply').steps.slice(3),
      ] },
    ] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const invocations = await turnInvocations(ctx);
    const nudges = invocations.filter(i => promptOf(i).includes('Have you committed all your work?'));
    expect(nudges.length).toBe(1);
    expect(promptOf(nudges[0])).toContain('loose.txt');
    expect(nudges[0].argv).toContain('--resume');

    const turns = await allTurns(ctx.root, taskId);
    expect(countHeading(turns, NUDGE_HEADING)).toBe(1);
    expect(countHeading(turns, LEFTOVERS_HEADING)).toBe(0);
    const worktree = worktreePathFor(ctx.root, taskId);
    const log = Bun.spawnSync(['git', 'log', '--format=%s', '-5'], { cwd: worktree });
    expect(log.stdout.toString()).toContain('Commit the loose file');
    const show = await ctx.lazy(['show', taskId, '--full']);
    expect(show.stdout).not.toContain('[Uncommitted work left behind]');
  }, 120_000);

  // INVARIANT: a FINAL turn with a dirty worktree gets the nudge first and
  // then the final chain's commit_leftovers step exactly as before.
  test('a final turn with a dirty tree gets one nudge, then commit_leftovers', async () => {
    const taskId = await createTask(ctx, 'Final dirty', 'Do the work');
    await ctx.setClaudeScenario({ sequence: [
      dirtyWork([DECLARE_FINAL]),
      answer('It is scratch; leaving it.', 'nudge-reply'),
      answer('Still leaving it.', 'leftovers-reply'),
    ] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const invocations = await turnInvocations(ctx);
    const nudgeIdx = invocations.findIndex(i => promptOf(i).includes('Have you committed all your work?'));
    const leftoversIdx = invocations.findIndex(i => promptOf(i).includes('Do ONE of these for every path above'));
    expect(nudgeIdx).toBeGreaterThan(0);
    expect(leftoversIdx).toBeGreaterThan(nudgeIdx);
    expect(invocations.filter(i => promptOf(i).includes('Have you committed all your work?')).length).toBe(1);

    const turns = await allTurns(ctx.root, taskId);
    expect(countHeading(turns, NUDGE_HEADING)).toBe(1);
    expect(countHeading(turns, LEFTOVERS_HEADING)).toBe(1);
  }, 120_000);

  // INVARIANT: a lazy_final declared DURING the nudge is a final, so the end-of-work
  // chain (commit_leftovers) runs. The step list used to be picked before the
  // nudge, so such a turn got the park plan and skipped every configured rule.
  test('a final declared during the nudge still runs commit_leftovers', async () => {
    const taskId = await createTask(ctx, 'Final in nudge', 'Do the work');
    const nudgeReply = answer('Declaring done; leaving it.', 'nudge-reply');
    nudgeReply.steps.splice(3, 0, DECLARE_FINAL);
    await ctx.setClaudeScenario({ sequence: [
      dirtyWork(),
      nudgeReply,
      answer('Still leaving it.', 'leftovers-reply'),
    ] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const invocations = await turnInvocations(ctx);
    expect(invocations.some(i => promptOf(i).includes('Do ONE of these for every path above'))).toBe(true);
  }, 120_000);

  // INVARIANT: a clean worktree is never nudged.
  test('a clean tree gets no nudge', async () => {
    const taskId = await createTask(ctx, 'Clean', 'Do the work');
    await ctx.setClaudeScenario(successScenario({
      result: 'Work done.',
      sessionId: 'clean-work',
      declarePresentation: true,
      commit: { message: 'All committed', files: [{ path: 'done.txt', content: 'x\n' }] },
    }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const invocations = await turnInvocations(ctx);
    expect(invocations.some(i => promptOf(i).includes('Have you committed all your work?'))).toBe(false);
    expect(countHeading(await allTurns(ctx.root, taskId), NUDGE_HEADING)).toBe(0);
  }, 120_000);

  // INVARIANT: a read-only (plan-mode) turn is never nudged, even on a dirty
  // worktree — it may not commit, and its own write check governs it.
  test('a read-only turn gets no nudge', async () => {
    const taskId = await createTask(ctx, 'Read-only', 'Do the work');
    await ctx.setClaudeScenario(successScenario({
      result: 'Work done.',
      sessionId: 'ro-work',
      declarePresentation: true,
      commit: { message: 'All committed', files: [{ path: 'done.txt', content: 'x\n' }] },
    }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // A file loose in the worktree from outside the turn.
    await writeFile(join(worktreePathFor(ctx.root, taskId), 'outside.txt'), 'x\n');
    await ctx.setClaudeScenario(successScenario({ result: 'Answered.', sessionId: 'ro-plan' }));
    const launched = await launchAsPerson(ctx, 'unblockTask', {
      taskId, message: 'Why this approach?', permissionMode: 'plan',
    });
    expect(launched.exitCode).toBe(0);
    await ctx.lazy(['wait', taskId]);

    const invocations = await turnInvocations(ctx);
    expect(invocations.some(i => promptOf(i).includes('Have you committed all your work?'))).toBe(false);
    const turns = await allTurns(ctx.root, taskId);
    expect(countHeading(turns, NUDGE_HEADING)).toBe(0);
    // Not vacuous: the read-only turn really ran, on a really dirty worktree.
    const planTurn = turns.filter(t => t.role === 'agent').pop()!;
    expect(String(planTurn.content)).toContain('Answered.');
    expect(planTurn.uncommitted as string[]).toContain('outside.txt');
  }, 120_000);

  // INVARIANT: work still loose after the one nudge is announced — a comment
  // on the task and a system notice — and nobody nudges a second time.
  test('still dirty after the nudge gets the announcement', async () => {
    const taskId = await createTask(ctx, 'Still dirty', 'Do the work');
    await ctx.setClaudeScenario({ sequence: [
      dirtyWork(),
      answer('I cannot commit: my lazy tools are unavailable.', 'nudge-reply'),
    ] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const invocations = await turnInvocations(ctx);
    expect(invocations.filter(i => promptOf(i).includes('Have you committed all your work?')).length).toBe(1);
    const show = await ctx.lazy(['show', taskId, '--full']);
    expectSuccess(show);
    expect(show.stdout).toContain('[Uncommitted work left behind]');
    expect(show.stdout).toContain('loose.txt');
    const notices = readSystemMessagesFile(ctx.root)
      .filter(m => String(m.title).includes('uncommitted work left behind'));
    expect(notices.length).toBe(1);
  }, 120_000);
});
