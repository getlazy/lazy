/**
 * E2E: comments that arrive WHILE a work turn runs are handed to that turn
 * before it ends — on the REAL supervisor (fake claude).
 *
 * Engineer's design (2026-10-10): a turn used to finish even when somebody had
 * commented in the meantime, leaving the comment queued until a person
 * unblocked. Now, before the wrap-up, the supervisor asks the daemon for notes
 * queued during the turn and resumes the same session with the notes block an
 * unblock would carry. Each hand-off counts against
 * [limits] max_turns_without_human; past it, the notes wait for a person.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile, rm } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario, sessionStartEvent, resultEvent, type ClaudeScenario } from '../helpers/fake-claude';
import { taskDir } from '../helpers/agent-seam';
import { readSessionJson } from '../helpers/storage';

const HEADING = '## New Comments During the Turn';
const NOTES_HEADER = 'NOTES ADDED SINCE YOUR LAST TURN:';

async function editConfig(ctx: TestContext, from: string | RegExp, to: string): Promise<void> {
  const configPath = join(ctx.root, 'lazy.toml');
  const before = await readFile(configPath, 'utf-8');
  const after = before.replace(from, to);
  if (after === before) throw new Error(`could not edit ${String(from)} in the init-produced lazy.toml`);
  await writeFile(configPath, after);
  ctx.git('add', 'lazy.toml');
  expect(ctx.git('commit', '-m', 'Test config').exitCode).toBe(0);
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

/** An invocation that stays live while `holdPath` exists, then answers. */
function heldTurn(sessionId: string, holdPath: string, result: string): ClaudeScenario {
  return {
    steps: [
      { kind: 'emit', event: sessionStartEvent(sessionId) },
      { kind: 'hold-while-file', path: holdPath },
      { kind: 'declare-presentation' },
      { kind: 'emit', event: resultEvent({ result, sessionId }) },
    ],
  };
}

/** Whether the comment containing `text` is behind the session's delivery mark. */
async function deliveredState(ctx: TestContext, shortId: string, text: string): Promise<boolean> {
  const session = readSessionJson(ctx.root, shortId);
  const show = await ctx.lazy(['show', shortId, '--json']);
  expectSuccess(show);
  const comment = (JSON.parse(show.stdout) as { comments: Array<{ content: string; created_at: number }> })
    .comments.find(c => c.content.includes(text));
  if (!comment) throw new Error(`no comment containing "${text}"`);
  const mark = session?.notes_delivered_through as number | undefined;
  return mark !== undefined && comment.created_at <= mark;
}

/** `lazy wait` returns only once the task has left `working`, i.e. parked. */
async function waitParked(ctx: TestContext, shortId: string): Promise<void> {
  expectSuccess(await ctx.lazy(['wait', shortId]));
}

async function untilInvocations(ctx: TestContext, n: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while ((await turnInvocations(ctx)).length < n) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} agent invocation(s)`);
    await Bun.sleep(250);
  }
}

describe('comments that arrive during a turn (real supervisor, fake claude)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    await editConfig(ctx, '# mode = "low_high"', 'mode = "off"');
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a comment written while the agent works is delivered to THAT
  // turn, in the same session, with the unblock's own notes block — the turn
  // does not end with feedback sitting unread.
  test('a comment made mid-turn is handed to the agent before the turn ends', async () => {
    const hold = join(ctx.root, '..', `hold-${Date.now()}`);
    await writeFile(hold, '');
    const taskId = await createTask(ctx, 'Mid-turn comment', 'Do the work');
    await ctx.setClaudeScenario({ sequence: [
      heldTurn('pn-work', hold, 'Work done.'),
      successScenario({ result: 'Handled the comment.', sessionId: 'pn-notes', declarePresentation: true }),
    ] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    await untilInvocations(ctx, 1);
    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'Please also handle the empty input case']));
    await rm(hold, { force: true });
    await waitParked(ctx, taskId);

    const followups = (await turnInvocations(ctx)).filter(i => promptOf(i).includes(NOTES_HEADER));
    expect(followups.length).toBe(1);
    expect(promptOf(followups[0])).toContain('Please also handle the empty input case');
    expect(followups[0].argv).toContain('--resume');

    const turns = await allTurns(ctx.root, taskId);
    expect(turns.filter(t => String(t.content).startsWith(HEADING)).length).toBe(1);
    expect(turns.some(t => String(t.content).includes('Handled the comment.'))).toBe(true);

    // Delivered: the next unblock must not carry it again.
    expect(await deliveredState(ctx, taskId, 'empty input')).toBe(true);
  }, 180_000);

  // INVARIANT: no comment, no extra invocation.
  test('a turn with no new comments gets no follow-up', async () => {
    const taskId = await createTask(ctx, 'No comment', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ result: 'Work done.', sessionId: 'pn-none', declarePresentation: true }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    await waitParked(ctx, taskId);
    expect((await turnInvocations(ctx)).some(i => promptOf(i).includes(NOTES_HEADER))).toBe(false);
  }, 120_000);

  // INVARIANT: hand-offs are bounded by [limits] max_turns_without_human. Past
  // it the comments stay QUEUED (never dropped) and the turn ends, so something
  // that comments all the time cannot keep a turn alive forever.
  test('past max_turns_without_human the comment stays queued and the turn ends', async () => {
    await editConfig(ctx, /# max_turns_without_human = 10/, 'max_turns_without_human = 1');
    const hold1 = join(ctx.root, '..', `hold1-${Date.now()}`);
    const hold2 = join(ctx.root, '..', `hold2-${Date.now()}`);
    await writeFile(hold1, '');
    await writeFile(hold2, '');
    const taskId = await createTask(ctx, 'Chatty comments', 'Do the work');
    await ctx.setClaudeScenario({ sequence: [
      heldTurn('pn-b-work', hold1, 'Work done.'),
      heldTurn('pn-b-notes', hold2, 'Handled the first comment.'),
      successScenario({ result: 'Should never run as a notes follow-up.', sessionId: 'pn-b-x', declarePresentation: true }),
    ] });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    await untilInvocations(ctx, 1);
    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'First comment']));
    await rm(hold1, { force: true });
    await untilInvocations(ctx, 2);
    expectSuccess(await ctx.lazy(['comment', taskId, '--message', 'Second comment']));
    await rm(hold2, { force: true });
    await waitParked(ctx, taskId);

    const followups = (await turnInvocations(ctx)).filter(i => promptOf(i).includes(NOTES_HEADER));
    expect(followups.length).toBe(1);
    expect(promptOf(followups[0])).toContain('First comment');

    expect(await deliveredState(ctx, taskId, 'First comment')).toBe(true);
    expect(await deliveredState(ctx, taskId, 'Second comment')).toBe(false);
  }, 180_000);
});
