import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';
import { successScenario } from '../helpers/fake-claude';

/**
 * A queued comment survives an intervening `lazy ask`.
 *
 * "Never lose human feedback" is lazy's first invariant, and the notes cutoff
 * used to break it. `buildNotesContext` was fed "everything created after the
 * LAST AGENT TURN" — but `lazy ask` and `lazy sync` both record agent turns
 * while delivering no notes at all (`launchAskTask` skips them deliberately: a
 * read-only question must not consume queued feedback, and `syncTask` never
 * builds them). So:
 *
 *     lazy comment <task> -m "..."      # queued for the agent
 *     lazy ask <task> "quick question"  # records an agent turn
 *     lazy unblock <task> -m "..."      # comment now looks old — silently dropped
 *
 * The human's comment vanished with no error anywhere.
 *
 * The cutoff is now the last DELIVERY, not the last agent turn:
 * `session.notes_delivered_through`, written by `Storage.markNotesDelivered()`
 * from the prompts that actually carry notes (unblock and the initial start),
 * and read back through `resolveNotesCutoff()`.
 *
 * This suite uses the fake-binary seam so it can assert on the REAL argv the
 * agent received — the prompt lazy actually handed over, not an intermediate.
 */
describe('a queued comment survives an intervening ask', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: ask and sync turns must NOT advance the notes cutoff. They are
  // agent turns that deliver no notes; treating them as delivery points drops
  // every comment written before them.
  test('comment -> ask -> unblock still carries the comment', async () => {
    const taskId = await createTask(ctx, 'Comment survives ask', 'Do the work');
    await ctx.setClaudeScenario({
      sequence: [
        successScenario({ result: 'Work done.', sessionId: 'fake-sess-notes' }),
        successScenario({ result: 'Because the caller retries.', sessionId: 'fake-sess-notes' }),
        successScenario({ result: 'Fixed.', sessionId: 'fake-sess-notes' }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expectOutput(await ctx.lazy(['show', taskId]), 'blocked');

    // Comments are compared against a timestamp, so make this one strictly
    // later than the turn that precedes it.
    await Bun.sleep(1100);
    expectSuccess(await ctx.lazy([
      'comment', taskId, '--message', 'REVIEW NOTE: the retry path swallows errors',
    ]));

    // The ask records an agent turn and delivers no notes. Under the old cutoff
    // this is what silently consumed the comment.
    expectSuccess(await ctx.lazy(['ask', taskId, '--message', 'why did you drop the retry?']));
    expectOutput(await ctx.lazy(['show', taskId]), 'blocked');

    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'Fix the retry path']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const turnInvocations = (await ctx.claudeInvocations()).filter(i => i.argv.includes('-p'));
    const unblockPrompt = turnInvocations[turnInvocations.length - 1].argv.join('\n');
    expect(unblockPrompt).toContain('NOTES ADDED SINCE YOUR LAST TURN');
    expect(unblockPrompt).toContain('REVIEW NOTE: the retry path swallows errors');
    expect(unblockPrompt).toContain('Fix the retry path');
  }, 180_000);

  // The delivery mark is what stops a comment repeating forever: once a prompt
  // has carried it, the next unblock must not carry it again.
  test('a delivered comment is not re-delivered on the next unblock', async () => {
    const taskId = await createTask(ctx, 'Comment delivered once', 'Do the work');
    await ctx.setClaudeScenario({
      sequence: [
        successScenario({ result: 'Work done.', sessionId: 'fake-sess-once' }),
        successScenario({ result: 'Fixed.', sessionId: 'fake-sess-once' }),
        successScenario({ result: 'Fixed again.', sessionId: 'fake-sess-once' }),
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    await Bun.sleep(1100);
    expectSuccess(await ctx.lazy([
      'comment', taskId, '--message', 'REVIEW NOTE: only once please',
    ]));

    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'first feedback']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    expectSuccess(await ctx.lazy(['unblock', taskId, '--message', 'second feedback']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    const turnInvocations = (await ctx.claudeInvocations()).filter(i => i.argv.includes('-p'));
    const first = turnInvocations[turnInvocations.length - 2].argv.join('\n');
    const second = turnInvocations[turnInvocations.length - 1].argv.join('\n');
    expect(first).toContain('REVIEW NOTE: only once please');
    expect(second).toContain('second feedback');
    expect(second).not.toContain('REVIEW NOTE: only once please');
  }, 180_000);
});
