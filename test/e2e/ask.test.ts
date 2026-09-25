/**
 * E2E tests for `lazy ask <task_id>` — the CLI surface over the daemon's
 * read-only ask RPC.
 *
 * The happy paths use the fake-`claude`-binary seam (setupTestLazy({
 * fakeClaude: true })): the CLI talks to a real daemon, which launches a real
 * supervisor, which spawns a scripted fake agent. Nothing in `src/` is mocked,
 * so what these assert is the production path — including that the ask answer
 * really round-trips from the agent's turn back out of the CLI.
 *
 * The pure-validation cases (no session, unknown task, missing task id) need no
 * agent at all and run on the cheap non-daemon context.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, startAndWait, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { successScenario } from '../helpers/fake-claude';
import { writeFile, chmod } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

const ASK_ANSWER = 'I dropped the retry because the caller already retries.';

/**
 * Install a fake `$EDITOR` that appends `body` to the file it is handed.
 *
 * Appends rather than overwrites so the command's own template (the `#` comment
 * header) is still present when the "editor" exits — which is what exercises the
 * comment-stripping path. `openEditor` spawns `$EDITOR <tmpfile>` with
 * shell:true, so a plain executable script is all that is needed.
 */
async function writeFakeEditor(ctx: TestContext, body: string): Promise<string> {
  const path = join(ctx.root, `fake-editor-${randomUUID()}.sh`);
  await writeFile(path, `#!/bin/sh\ncat >> "$1" <<'LAZY_EOF'\n${body}\nLAZY_EOF\n`);
  await chmod(path, 0o755);
  return path;
}

describe('lazy ask (real supervisor, fake claude)', () => {
  let ctx: TestContext;
  let taskId: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
    taskId = await createTask(ctx, 'Ask target', 'Do the work');
    // Invocation 0 is the `start` turn; invocation 1+ is the ask turn.
    await ctx.setClaudeScenario({
      sequence: [
        successScenario({ result: 'Work done.', sessionId: 'fake-sess-ask' }),
        successScenario({ result: ASK_ANSWER, sessionId: 'fake-sess-ask' }),
      ],
    });
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expectOutput(await ctx.lazy(['show', taskId]), 'blocked');
  }, 120_000);

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('--message asks the agent and prints the answer', async () => {
    const result = await ctx.lazy(['ask', taskId, '--message', 'why did you drop the retry?']);
    expectSuccess(result);
    expectOutput(result, ASK_ANSWER);
  }, 120_000);

  // INVARIANT (src/daemon/task-lifecycle.ts launchAskTask): an ask is read-only
  // and must leave the task exactly as it found it. A CLI ask that silently
  // unblocked a task would be a data-loss-grade surprise.
  test('leaves the task blocked afterwards', async () => {
    expectSuccess(await ctx.lazy(['ask', taskId, '-m', 'anything?']));
    expectOutput(await ctx.lazy(['show', taskId]), 'blocked');
  }, 120_000);

  test('a piped question is used when --message is absent', async () => {
    const result = await ctx.lazy(['ask', taskId], { input: 'what did you change?\n' });
    expectSuccess(result);
    expectOutput(result, ASK_ANSWER);
  }, 120_000);

  test('--json prints a machine-readable envelope', async () => {
    const result = await ctx.lazy(['ask', taskId, '-m', 'why?', '--json']);
    expectSuccess(result);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.answer).toContain(ASK_ANSWER);
    expect(parsed.taskId).toBeTruthy();
    expect(parsed.fullTaskId).toBeTruthy();
    expect(parsed.sessionId).toBeTruthy();
    expect(typeof parsed.turnNumber).toBe('number');
    expect(Array.isArray(parsed.warnings)).toBe(true);
    // The human-readable progress line must never contaminate the JSON stream.
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  }, 120_000);

  test('without --message and without a TTY it fails with an actionable error', async () => {
    const result = await ctx.lazy(['ask', taskId]);
    expectFailure(result);
    expectError(result, '--message is required when stdin is not a terminal');
  }, 120_000);

  test('without --message on a TTY it opens $EDITOR for the question', async () => {
    const editor = await writeFakeEditor(ctx, 'why did you drop the retry?\n');
    const result = await ctx.lazy(['ask', taskId], {
      env: { LAZY_FORCE_TTY: '1', EDITOR: editor },
    });
    expectSuccess(result);
    expectOutput(result, ASK_ANSWER);
  }, 120_000);

  // The reason $EDITOR replaced a single-line readline prompt: a review question
  // is usually pasted (a stack trace, a diff hunk), and a prompt that cannot
  // carry LF silently mangles it. This asserts the question reaches the agent
  // with its line structure intact.
  test('a multi-line question keeps its line breaks', async () => {
    const question = 'Why this branch?\n\n    if (x) {\n      return null;  // <- here\n    }\n';
    const editor = await writeFakeEditor(ctx, question);
    const result = await ctx.lazy(['ask', taskId], {
      env: { LAZY_FORCE_TTY: '1', EDITOR: editor },
    });
    expectSuccess(result);

    // The fake agent echoes nothing back, so verify against the durable record:
    // the human turn the daemon stored before launching the ask.
    const shown = await ctx.lazy(['show', taskId, '--json']);
    expectSuccess(shown);
    expect(shown.stdout).toContain('return null;');
    expect(shown.stdout).toContain('Why this branch?');
  }, 120_000);

  // Comment lines are the editor template's own scaffolding; a question made up
  // of nothing else means the human declined, and must not reach the agent.
  test('a question of only comment lines is refused', async () => {
    const editor = await writeFakeEditor(ctx, '');  // template comments only
    const result = await ctx.lazy(['ask', taskId], {
      env: { LAZY_FORCE_TTY: '1', EDITOR: editor },
    });
    expectFailure(result);
    expectError(result, 'Empty question');
  }, 120_000);

  // REGRESSION (live report): a reviewer's ask answer arrived in their terminal
  // cut mid-word, a few bytes from the end, while the agent-side turn was
  // complete. Anything between the agent and the terminal that drops the tail of
  // a large answer — envelope framing, capture, or an unflushed stdout at
  // process.exit — reproduces here. The assertion is deliberately on the FINAL
  // bytes and the exact length, not on a substring near the start: a truncation
  // bug passes any `toContain` check aimed at the beginning of the payload.
  test('a multi-KB answer arrives complete, down to the final byte', async () => {
    // Distinct, position-encoding lines so a truncation reports WHERE it cut.
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) {
      lines.push(`line ${String(i).padStart(4, '0')}: ${'payload '.repeat(12)}`);
    }
    const bigAnswer = lines.join('\n') + '\nFINAL_TOKEN_ARRIVED_INTACT';
    expect(bigAnswer.length).toBeGreaterThan(40_000);

    await ctx.setClaudeScenario(successScenario({ result: bigAnswer, sessionId: 'fake-sess-ask' }));

    const result = await ctx.lazy(['ask', taskId, '-m', 'give me the long answer']);
    expectSuccess(result);
    const printed = result.stdout.trim();
    expect(printed.endsWith('FINAL_TOKEN_ARRIVED_INTACT')).toBe(true);
    expect(printed.length).toBe(bigAnswer.length);
  }, 120_000);

  // Same guarantee on the machine-readable path: --json emits one JSON line, so
  // a dropped tail is not merely a short answer — it is unparseable output.
  test('a multi-KB answer survives the --json path', async () => {
    const bigAnswer = 'A'.repeat(60_000) + 'FINAL_TOKEN_ARRIVED_INTACT';
    await ctx.setClaudeScenario(successScenario({ result: bigAnswer, sessionId: 'fake-sess-ask' }));

    const result = await ctx.lazy(['ask', taskId, '-m', 'long json', '--json']);
    expectSuccess(result);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.answer.trim().endsWith('FINAL_TOKEN_ARRIVED_INTACT')).toBe(true);
    expect(parsed.answer.trim().length).toBe(bigAnswer.length);
  }, 120_000);

  // A task whose session has ended is no longer answered by the LIVE agent —
  // it is answered from its stored record instead (see the finished-task suite
  // below). What this asserts here is the pre-flight: the CLI must decide the
  // route from the same rule the daemon uses, so the route is known BEFORE the
  // reviewer is asked to type a question.
  test('an ask against a closed task is routed, not refused', async () => {
    expectSuccess(await ctx.lazy(['close', taskId, '--yes', '--reason', 'done with it']));
    const result = await ctx.lazy(['ask', taskId, '-m', 'still there?', '--json']);
    // The one-shot itself is not mocked in this fake-claude suite, so the run
    // may fail for want of a container — but it must fail HAVING CHOSEN the
    // record route, never with the old "not blocked or conflict" refusal.
    expect(result.stderr + result.stdout).not.toContain("not 'blocked' or 'conflict'");
    expect(result.stderr + result.stdout).not.toContain('re-send it once the task is blocked');
  }, 120_000);
});

describe('lazy ask (task still working)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ fakeClaude: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // The daemon refuses a read-only turn against a task the agent is actively
  // working — a plan-mode resume would race live work. The CLI must surface
  // that refusal verbatim rather than hanging or retrying.
  test('rejects an ask while the agent is mid-turn', async () => {
    const taskId = await createTask(ctx, 'Busy task', 'Do the work');
    const slow = successScenario({ result: 'Eventually done.', sessionId: 'fake-sess-busy' });
    // Turn 1 completes so the session gets an agent session id to resume;
    // turn 2 (the unblock) stalls, leaving the task 'working' for the ask.
    await ctx.setClaudeScenario({
      sequence: [
        successScenario({ result: 'First turn done.', sessionId: 'fake-sess-busy' }),
        { steps: [{ kind: 'sleep', ms: 30_000 }, ...slow.steps] },
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    expectSuccess(await ctx.lazy(['unblock', taskId, '-m', 'keep going']));
    const result = await ctx.lazy(['ask', taskId, '-m', 'what are you doing?']);
    // Never a plan-mode resume of a task mid-turn: that would race live work.
    // The question is not thrown away either — it is answered from the record.
    expect(result.stdout + result.stderr).not.toContain('Eventually done.');
    expect(result.stderr).not.toContain("not 'blocked' or 'conflict'");
  }, 120_000);
});

describe('lazy ask (validation)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('requires a task id', async () => {
    const result = await ctx.lazy(['ask']);
    expectFailure(result);
    expectOutput(result, 'Usage: lazy ask');
  });

  // The ONE genuinely unanswerable case: nothing was ever recorded, so an
  // answer could only be invented. Everything else is answered — from the live
  // agent when it can be resumed, from the stored record when it cannot.
  test('fails when the task has never run, saying what to do instead', async () => {
    const taskId = await createTask(ctx, 'Never started');
    const result = await ctx.lazy(['ask', taskId, '-m', 'hello?']);
    expectFailure(result);
    expectError(result, 'nothing recorded');
    expectError(result, 'lazy start');
  });

  test('--json reports errors as JSON on stdout', async () => {
    await createTask(ctx, 'Unrelated');
    const result = await ctx.lazy(['ask', 'deadbeef', '-m', 'hello?', '--json']);
    expectFailure(result);
    const parsed = JSON.parse(result.stdout.trim());
    expect(String(parsed.error)).toContain('deadbeef');
  });
});

/**
 * Asking a task lazy has already finished with.
 *
 * This is the suite for the behaviour the feedback asked for: a completed task
 * used to answer "the agent can only answer while the task is blocked or in
 * conflict — re-send it once the task is blocked", which a completed task can
 * never do. It is answered from its stored record instead.
 *
 * Module-mock context on purpose: the record ask runs a machine ONE-SHOT inside
 * the daemon, and the default preload mocks src/oneshot/index.ts there (the
 * fake-claude suites above deliberately mock nothing in src/, so a one-shot
 * would need a real container).
 */
describe('lazy ask (finished task, answered from the record)', () => {
  let ctx: TestContext;
  let taskId: string;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    taskId = await createTask(ctx, 'Finished work', 'Do the thing');
    await startAndWait(ctx, taskId);
    expectSuccess(await ctx.lazy(['close', taskId, '--yes', '--reason', 'done with it']));
  }, 120_000);

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('answers from the stored record instead of refusing', async () => {
    const result = await ctx.lazyMocked(
      ['ask', taskId, '-m', 'why was it done that way?'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(result);
    // The answer came from the record-ask one-shot, and the task's own turns
    // were in the prompt it read.
    expectOutput(result, '[record-ask:single]');
    expectOutput(result, 'why was it done that way?');
    // The read-only lockdown was requested for the one-shot.
    expectOutput(result, '[ro]');
  }, 120_000);

  // INVARIANT: an answer read off the stored record must never read as the live
  // agent looking at a live worktree. The provenance is stated, every time.
  test('says the answer came from the record, not from the live agent', async () => {
    const result = await ctx.lazyMocked(
      ['ask', taskId, '-m', 'what happened?'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(result);
    expect(result.stderr).toContain("stored record");
    expect(result.stderr).toContain('not the original agent');
  }, 120_000);

  // INVARIANT (CLAUDE.md — a read-only question must not disturb the task): the
  // record ask takes no worktree lock, creates no turn, and must leave a
  // terminal task exactly as it found it.
  test('leaves the finished task untouched — same status, no new turns', async () => {
    const before = JSON.parse((await ctx.lazy(['show', taskId, '--json'])).stdout);
    const result = await ctx.lazyMocked(
      ['ask', taskId, '-m', 'anything?'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(result);
    const after = JSON.parse((await ctx.lazy(['show', taskId, '--json'])).stdout);
    expect(after.status).toBe(before.status);
    expect(after.turns?.length ?? 0).toBe(before.turns?.length ?? 0);
  }, 120_000);

  test('--json carries the provenance so a machine consumer cannot miss it', async () => {
    const result = await ctx.lazyMocked(
      ['ask', taskId, '-m', 'json please?', '--json'],
      MOCK_CLAUDE_SUCCESS,
    );
    expectSuccess(result);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.type).toBe('task');
    expect(parsed.derivedFrom).toBe('stored-record');
    expect(String(parsed.provenance)).toContain('stored record');
    // No turn was recorded, so there is no turn number to report.
    expect(parsed.turnNumber).toBeNull();
  }, 120_000);
});
