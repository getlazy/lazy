/**
 * The low-high loop — e2e on the fake-`claude`-binary seam.
 *
 * The loop is a SUPERVISOR behavior (extra `claude -p` invocations inside one
 * turn), so only this seam can observe it: the module mock replaces
 * `launchSupervisorAsync` wholesale and never runs the two-phase machinery.
 * Everything asserted here is the production path — real daemon, real
 * supervisor, real argv handed to the (fake) agent binary.
 *
 * This shape is now the DEFAULT review mode (`[review] mode = "low_high"`,
 * engineer decision 2026-09-21), so the arms below are set by MODE rather than
 * by an experiment flag.
 *
 * What must hold:
 *   - another mode → ONE agent invocation, exactly as before the feature existed
 *   - low_high     → draft at the draft effort, then a plan-mode self-review at
 *     the review effort, then ONE revise back at the draft effort (bounded:
 *     never a second review cycle), with the review's instructions and
 *     per-phase efforts visible in the recorded turn history
 *   - a review that answers LOW_HIGH_LOOP_APPROVED skips the revise phase
 *   - low_high dispatches NO separate reviewer: the whole point is one session
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario, type ClaudeScenarioFile } from '../helpers/fake-claude';
import { codexSuccessScenario } from '../helpers/fake-codex';
import { writeAgentApiKey } from '../../src/agent/credentials';
import { agentTurns, taskDir } from '../helpers/agent-seam';

/**
 * Set the project's review mode, and COMMIT the change — the daemon resolves
 * launch config from the project root, but committing keeps the task
 * worktree's lazy.toml consistent too (same rationale as setGuards).
 *
 * Edits the key INTO the `[review]` section `lazy init` wrote (never overwrite
 * the file, never append a duplicate section — see CLAUDE.md), and asserts the
 * edit changed something: a silent no-op config change is how tests pass for
 * the wrong reason.
 */
async function setReviewMode(ctx: TestContext, mode: string): Promise<void> {
  const configPath = join(ctx.root, 'lazy.toml');
  const before = await readFile(configPath, 'utf-8');
  const after = before.replace('# mode = "low_high"', `mode = "${mode}"`);
  if (after === before) {
    throw new Error(
      'could not uncomment [review] mode in the init-produced lazy.toml — ' +
      'the template line this suite edits has changed',
    );
  }
  await writeFile(configPath, after);
  ctx.git('add', 'lazy.toml');
  const commit = ctx.git('commit', '-m', `Set the review mode to ${mode} for this test`);
  if (commit.exitCode !== 0) {
    throw new Error(`Failed to commit review mode config: ${commit.stderr}`);
  }
}

/** Set the project's review GATE, same edit-and-commit shape as the mode. */
async function setReviewGate(ctx: TestContext, gate: string): Promise<void> {
  const configPath = join(ctx.root, 'lazy.toml');
  const before = await readFile(configPath, 'utf-8');
  const after = before.replace('# gate = "auto"', `gate = "${gate}"`);
  if (after === before) {
    throw new Error(
      'could not uncomment [review] gate in the init-produced lazy.toml — ' +
      'the template line this suite edits has changed',
    );
  }
  await writeFile(configPath, after);
  ctx.git('add', 'lazy.toml');
  const commit = ctx.git('commit', '-m', `Set the review gate to ${gate} for this test`);
  if (commit.exitCode !== 0) {
    throw new Error(`Failed to commit review gate config: ${commit.stderr}`);
  }
}

/** The `-p` (turn) invocations of the fake agent, oldest first. */
async function turnInvocations(ctx: TestContext) {
  return (await ctx.claudeInvocations()).filter(i => i.argv.includes('-p'));
}

/** Value of a flag in an argv, or undefined when the flag is absent. */
function argvFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

/** All turns (any role/actor) recorded for a task, in order. */
async function allTurns(root: string, shortId: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(await taskDir(root, shortId), 'turns.json'), 'utf-8');
  return (JSON.parse(raw) as { turns: Array<Record<string, unknown>> }).turns;
}

const REVIEW_INSTRUCTIONS =
  '1. Fix the null check in fake-work.txt — the draft skipped the empty-input case.';

/**
 * The JSON report the self-review prompt asks for, last in the reply.
 *
 * A real agent emits this alongside its instructions; the reconciler parses it
 * and records it as a review turn, which is what `gate = "always"` gates on.
 */
const REPORT_BLOCK = [
  '',
  '',
  '```json',
  '{',
  '  "verdict": "needs_work",',
  '  "security": "none found",',
  '  "data_integrity": "none found",',
  '  "findings": [',
  '    { "severity": "high", "category": "correctness", "summary": "The draft skipped the empty-input case." }',
  '  ]',
  '}',
  '```',
].join('\n');

/**
 * Draft → review (with instructions) → revise, as consecutive invocations.
 *
 * `reviseCommits: false` is the revise phase that RAN and changed nothing — a
 * real shape, because the loop is non-fatal at every phase, so a revise that
 * refuses or dies still records a response over unchanged work. It is what
 * tells "the findings were applied" apart from "the findings still stand".
 */
function loopScenario(
  reviewReply: string = REVIEW_INSTRUCTIONS,
  opts: { reviseCommits?: boolean } = {},
): ClaudeScenarioFile {
  const reviseCommits = opts.reviseCommits !== false;
  return {
    sequence: [
      successScenario({
        result: 'Draft: did the work quickly.',
        sessionId: 'low-high-draft',
        commit: { message: 'Draft work', files: [{ path: 'fake-work.txt', content: 'draft\n' }] },
      }),
      successScenario({
        result: reviewReply,
        sessionId: 'low-high-review',
      }),
      successScenario({
        result: reviseCommits
          ? 'Applied instruction 1: handled the empty-input case.'
          : 'I could not apply instruction 1.',
        sessionId: 'low-high-revise',
        ...(reviseCommits
          ? { commit: { message: 'Revision', files: [{ path: 'fake-work.txt', content: 'revised\n' }] } }
          : {}),
      }),
    ],
  };
}

describe('low-high loop (real supervisor, fake claude)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: another mode runs a plain single-shot turn. The loop is what
  // `low_high` IS, so any other mode must leave a work turn exactly as it was
  // before the feature existed — one invocation, no loop turns recorded.
  test('another mode: a turn is a single agent invocation with no loop turns', async () => {
    await setReviewMode(ctx, 'off');
    const taskId = await createTask(ctx, 'Single shot baseline', 'Do the work');
    await ctx.setClaudeScenario(successScenario({
      result: 'Single-shot work done.',
      sessionId: 'no-loop-sess',
      commit: { message: 'Work', files: [{ path: 'work.txt', content: 'done\n' }] },
    }));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // Work + the final nudge (final-turn design §2.4): the fake agent never
    // declares, so every turn here is asked once where it stands. What matters
    // for THIS test is that neither invocation is a low-high phase, which the
    // turn-content assertion below is what actually proves.
    const invocations = await turnInvocations(ctx);
    expect(invocations.length).toBe(2);

    const turns = await allTurns(ctx.root, taskId);
    expect(turns.some(t => String(t.content).includes("Low-High Loop"))).toBe(false);
  }, 90_000);

  test('low_high: draft, plan-mode review, and one revise run with per-phase efforts and recorded instructions', async () => {
    await setReviewMode(ctx, 'low_high');
    const taskId = await createTask(ctx, 'Two-phase turn', 'Do the work');
    await ctx.setClaudeScenario(loopScenario());

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const invocations = await turnInvocations(ctx);
    // Bounded iteration: draft + review + revise and NOTHING more from the loop
    // — a second review cycle would show up as an extra loop invocation. The
    // fourth is the final nudge (final-turn design §2.4), which runs after
    // every undeclared turn and is not part of the loop.
    expect(invocations.length).toBe(4);
    const [draft, review, revise] = invocations;

    // Draft runs at the configured draft effort (default "low").
    expect(argvFlag(draft.argv, '--effort')).toBe('low');
    expect(argvFlag(draft.argv, '--resume')).toBeUndefined();

    // Review resumes the draft's session at the review effort, read-only.
    expect(argvFlag(review.argv, '--effort')).toBe('xhigh');
    expect(argvFlag(review.argv, '--resume')).toBe('low-high-draft');
    expect(review.argv).toContain('--disallowedTools');

    // Revise resumes the review's session back at the draft effort, in write mode.
    expect(argvFlag(revise.argv, '--effort')).toBe('low');
    expect(argvFlag(revise.argv, '--resume')).toBe('low-high-review');
    expect(revise.argv).not.toContain('--disallowedTools');

    // The phase boundaries and the review's instructions are in the turn
    // history — this is how a human judges what the loop caught.
    const turns = await allTurns(ctx.root, taskId);
    const reviewPrompt = turns.find(t => String(t.content).includes('## Low-High Loop Self-Review'));
    expect(reviewPrompt).toBeDefined();
    expect(reviewPrompt!.actor).toBe('supervisor');
    const revisePrompt = turns.find(t => String(t.content).includes('## Low-High Loop Revision'));
    expect(revisePrompt).toBeDefined();
    expect(turns.some(t => String(t.content).includes(REVIEW_INSTRUCTIONS))).toBe(true);

    // Per-phase efforts land on the recorded agent turns so experiment arms can
    // be labelled from turn history alone. The fourth agent turn is the final
    // nudge's reply (final-turn design §2.4), which runs at the command's own
    // effort — it is not a loop phase, so it is dropped before the comparison
    // rather than folded into the expected sequence.
    const agents = await agentTurns(ctx.root, taskId);
    expect(agents.length).toBe(4);
    expect(agents.slice(0, 3).map(t => t.effort)).toEqual(['low', 'xhigh', 'low']);
    // The review's reply is the instructions; the revise reply follows it.
    expect(String(agents[1].content)).toContain(REVIEW_INSTRUCTIONS);
    expect(String(agents[2].content)).toContain('Applied instruction 1');
  }, 120_000);

  test('low_high: a review that approves the draft skips the revise phase', async () => {
    await setReviewMode(ctx, 'low_high');
    const taskId = await createTask(ctx, 'Approved draft', 'Do the work');
    await ctx.setClaudeScenario({
      sequence: [
        successScenario({
          result: 'Draft: did the work.',
          sessionId: 'low-high-draft-ok',
          commit: { message: 'Draft work', files: [{ path: 'ok.txt', content: 'ok\n' }] },
        }),
        successScenario({
          result: 'LOW_HIGH_LOOP_APPROVED',
          sessionId: 'low-high-review-ok',
        }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // Draft + review, no revise — plus the final nudge (§2.4). The revise phase
    // is proven absent by the turn-content assertion below, not by the count.
    const invocations = await turnInvocations(ctx);
    expect(invocations.length).toBe(3);

    const turns = await allTurns(ctx.root, taskId);
    expect(turns.some(t => String(t.content).includes('## Low-High Loop Self-Review'))).toBe(true);
    expect(turns.some(t => String(t.content).includes('## Low-High Loop Revision'))).toBe(false);
    expect(turns.some(t => String(t.content).includes('LOW_HIGH_LOOP_APPROVED'))).toBe(true);
  }, 120_000);

  /*
   * `gate = "always"` GATES THE SELF-REVIEW — engineer requirement, 2026-09-21,
   * and what the docs promise. It works only because the self-review's reply is
   * also recorded as a review turn carrying a parsed report; before that the
   * setting was documented and inert.
   *
   * End to end on the real supervisor: the fake agent emits the JSON block the
   * prompt asks for, the reconciler parses and records it, and `lazy accept`
   * refuses on the high finding inside it.
   */
  test('low_high + gate always: a high finding the revise did not apply holds the accept', async () => {
    await setReviewMode(ctx, 'low_high');
    await setReviewGate(ctx, 'always');
    const taskId = await createTask(ctx, 'Gated self-review', 'Do the work');
    await ctx.setClaudeScenario(
      loopScenario(REVIEW_INSTRUCTIONS + REPORT_BLOCK, { reviseCommits: false }),
    );

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // The self-review was recorded as a REVIEW turn, not only as the nudge pair.
    const turns = await allTurns(ctx.root, taskId);
    const review = turns.find(t => t.turn_type === 'review' && t.role === 'agent');
    expect(review).toBeDefined();
    // `self`: nobody asked for it — it ran because the task is in this mode,
    // which is what makes `gate = auto` leave it alone and `always` pick it up.
    // Distinct from `auto` so that escalating this task to a separate reviewer
    // still dispatches one.
    expect(review!.review_dispatch).toBe('self');
    expect((review!.review as { verdict: string }).verdict).toBe('needs_work');
    // The revise ran and moved nothing, so the findings still stand.
    expect(review!.review_addressed).toBeFalsy();

    // And they hold the merge.
    const accept = await ctx.lazy(['accept', taskId, '--yes']);
    expect(accept.exitCode).not.toBe(0);
    expect(accept.stderr + accept.stdout).toContain('--allow-review-issues');
  }, 90_000);

  /*
   * INVARIANT: `gate = "always"` does not hold on findings the revise pass
   * already applied. The recorded report is the PRE-fix state and the revise is
   * a supervised nudge turn, so nothing downstream can see the fix on its own —
   * without this marker, every task on a project running `always` in the
   * default mode would be held forever on findings fixed seconds later, which
   * makes the setting unusable rather than strict.
   */
  test('low_high + gate always: a finding the revise applied does not hold the accept', async () => {
    await setReviewMode(ctx, 'low_high');
    await setReviewGate(ctx, 'always');
    const taskId = await createTask(ctx, 'Addressed self-review', 'Do the work');
    await ctx.setClaudeScenario(loopScenario(REVIEW_INSTRUCTIONS + REPORT_BLOCK));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const turns = await allTurns(ctx.root, taskId);
    const review = turns.find(t => t.turn_type === 'review' && t.role === 'agent');
    expect(review).toBeDefined();
    expect((review!.review as { verdict: string }).verdict).toBe('needs_work');
    expect(review!.review_addressed).toBe(true);

    const accept = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(accept);
  }, 90_000);

  // The same self-review under the DEFAULT gate accepts, and says nothing about
  // it: its findings were already applied by the revise pass, so there is
  // nothing being disregarded and nothing to warn about.
  test('low_high + gate auto: the same self-review accepts, silently', async () => {
    await setReviewMode(ctx, 'low_high');
    const taskId = await createTask(ctx, 'Ungated self-review', 'Do the work');
    await ctx.setClaudeScenario(loopScenario(REVIEW_INSTRUCTIONS + REPORT_BLOCK));

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // Recorded all the same — it is what a reader sees when they ask what the
    // self-review found.
    const turns = await allTurns(ctx.root, taskId);
    expect(turns.some(t => t.turn_type === 'review' && t.role === 'agent')).toBe(true);

    const accept = await ctx.lazy(['accept', taskId, '--yes']);
    expectSuccess(accept);
    expect(accept.stderr + accept.stdout).not.toContain('NOT holding this accept');
  }, 90_000);
});

describe('low-high loop (real supervisor, fake codex)', () => {
  let ctx: TestContext;
  let savedOpenAIKey: string | undefined;

  beforeEach(async () => {
    savedOpenAIKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-LOW_HIGH_CODEX_TEST_KEY';
    ctx = await setupTestLazy({ fakeCodex: true });
    await writeAgentApiKey(ctx.root, 'codex', process.env.OPENAI_API_KEY);
  });

  afterEach(async () => {
    await ctx.cleanup();
    if (savedOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAIKey;
  });

  test('draft, read-only review with a report, and revise all run through resume', async () => {
    await setReviewMode(ctx, 'low_high');
    const taskId = await createTask(ctx, 'Codex low-high phases', 'Do the work');
    await ctx.setCodexScenario({
      sequence: [
        codexSuccessScenario({
          result: 'Draft complete.',
          sessionId: '01a00000-0000-7000-8000-00000000d001',
          commit: { message: 'Codex draft', files: [{ path: 'codex-loop.txt', content: 'draft\n' }] },
        }),
        codexSuccessScenario({
          result: REVIEW_INSTRUCTIONS + REPORT_BLOCK,
          sessionId: '01a00000-0000-7000-8000-00000000d002',
        }),
        codexSuccessScenario({
          result: 'Applied the review instructions.',
          sessionId: '01a00000-0000-7000-8000-00000000d003',
          commit: { message: 'Codex revision', files: [{ path: 'codex-loop.txt', content: 'revised\n' }] },
        }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const invocations = (await ctx.codexInvocations()).filter((i) => i.argv.includes('exec'));
    const [draft, review, revise] = invocations;
    expect(draft.argv).not.toContain('resume');
    expect(review.argv.slice(0, 3)).toEqual(['exec', 'resume', '01a00000-0000-7000-8000-00000000d001']);
    expect(review.argv).toContain('sandbox_mode="read-only"');
    expect(review.argv).not.toContain('--sandbox');
    expect(revise.argv.slice(0, 3)).toEqual(['exec', 'resume', '01a00000-0000-7000-8000-00000000d002']);

    const turns = await allTurns(ctx.root, taskId);
    expect(turns.some((turn) => turn.turn_type === 'review')).toBe(true);
    expect(turns.some((turn) => String(turn.content).includes('Applied the review instructions.'))).toBe(true);
  }, 120_000);
});
