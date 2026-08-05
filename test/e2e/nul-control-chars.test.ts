/**
 * e2e regression coverage for the NUL-in-feedback crash loop.
 *
 * Incident (2026-07-26): feedback containing two literal NUL characters was
 * accepted and persisted, then the work phase crash-looped —
 * `The argument 'args[2]' must be a string without null bytes` — because the
 * feedback becomes argv[2] of `claude -p`. Auto-resume then restarted the agent
 * with an older, generic prompt, so the feedback was silently never delivered.
 *
 * These tests pin the INTAKE half: no CLI text intake may persist a raw NUL,
 * and the prompt written into the protocol command (the exact string that
 * becomes argv) must be argv-legal. The DELIVERY half (argv construction plus
 * the spawn backstop) is pinned in test/unit/nul-feedback-delivery.test.ts,
 * because the e2e harness mocks the agent module wholesale and never reaches a
 * real spawn.
 *
 * Note on coverage shape: a NUL cannot travel through `--message`/`--goal`,
 * because the test harness itself would have to spawn `lazy` with a NUL in its
 * own argv — which is equally illegal. Realistic NUL sources are files, pipes
 * and editors (and MCP JSON), which is what these tests exercise.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readCommand, protocolDir as getProtocolDir } from '../../src/protocol';
import type { UnblockCommand } from '../../src/protocol';

/** Built at runtime so this source file contains no raw control byte. */
const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(0x1b);

/**
 * Resolve a task's storage directory from its short id. Tests run against
 * either in-repo or external (~/.lazy/<project>) storage depending on setup.
 */
function taskDir(ctx: TestContext, shortId: string): string {
  const candidates = [
    join(ctx.root, '.lazy', 'tasks'),
    join(homedir(), '.lazy', basename(ctx.root), 'tasks'),
  ];
  for (const tasksDir of candidates) {
    if (!existsSync(tasksDir)) continue;
    const full = readdirSync(tasksDir).find(d => d.startsWith(shortId));
    if (full) return join(tasksDir, full);
  }
  throw new Error(`Task directory not found for ${shortId}`);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** Assert that no string anywhere in a JSON blob contains a NUL. */
function expectNoNulAnywhere(value: unknown): void {
  expect(JSON.stringify(value).includes(NUL)).toBe(false);
}

/** Start a task with the mocked agent and reconcile it back to `blocked`. */
async function startAndSettle(ctx: TestContext, taskId: string): Promise<void> {
  expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
    env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
  }));
  // `wait` blocks until reconciliation records the agent turn and moves the
  // task from working to blocked, so it can accept feedback.
  expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);
}

function latestHumanTurn(ctx: TestContext, taskId: string): any {
  const turns = readJson(join(taskDir(ctx, taskId), 'turns.json'));
  expectNoNulAnywhere(turns);
  const human = (turns.turns as any[]).filter(t => t.role === 'human').pop();
  expect(human).toBeDefined();
  return human;
}

function deliveredPrompt(ctx: TestContext, taskId: string): string {
  const fullId = basename(taskDir(ctx, taskId));
  const command = readCommand(getProtocolDir(fullId)) as UnblockCommand;
  expect(command).not.toBeNull();
  return command.prompt;
}

describe('control-character sanitization at CLI intake', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // withDaemon: post-v0.11 the CLI needs a running daemon for storage and for
    // reconciliation to move a started task back to blocked.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT (CLAUDE.md "never lose human feedback"): NUL-bearing feedback is
  // SANITIZED AND DELIVERED, never rejected and never persisted raw. Rejecting
  // would discard feedback the human already typed; persisting raw would
  // crash-loop the turn and drop it silently on the stale auto-resume.
  test('unblock -f with a NUL-bearing file succeeds and delivers sanitized feedback', async () => {
    const taskId = await createTask(ctx, 'NUL feedback task', 'Do work');
    await startAndSettle(ctx, taskId);

    const feedbackPath = join(ctx.root, 'feedback.txt');
    writeFileSync(
      feedbackPath,
      `The parser must reject NUL (${NUL}) bytes, and strip ${NUL} from filenames.`,
    );

    const result = await ctx.lazyMocked(
      ['unblock', taskId, '-f', feedbackPath],
      MOCK_CLAUDE_SUCCESS,
    );

    // The crash we are regressing against made this fail with
    // "Crash loop detected: The argument 'args[2]' ...".
    expectSuccess(result);
    expect(result.stderr).not.toContain('null bytes');
    expect(result.stderr).not.toContain('Crash loop detected');

    const human = latestHumanTurn(ctx, taskId);
    // Content survives — escaped, not stripped, not truncated at the NUL.
    expect(human.content).toContain('The parser must reject NUL');
    expect(human.content).toContain('from filenames.');
    expect(human.content).toContain('\\u0000');
    // The substitution is disclosed rather than applied silently.
    expect(human.content).toContain('lazy sanitized');

    // The prompt handed to the supervisor — the exact string that becomes
    // argv[2] of `claude -p` — is argv-legal and still carries the feedback.
    const prompt = deliveredPrompt(ctx, taskId);
    expect(prompt.includes(NUL)).toBe(false);
    expect(prompt).toContain('The parser must reject NUL');
    expect(prompt).toContain('from filenames.');
  });

  test('unblock via piped stdin sanitizes too', async () => {
    const taskId = await createTask(ctx, 'NUL stdin feedback', 'Do work');
    await startAndSettle(ctx, taskId);

    const result = await ctx.lazyMocked(
      ['unblock', taskId],
      MOCK_CLAUDE_SUCCESS,
      { input: `piped${NUL}feedback` },
    );
    expectSuccess(result);

    expect(latestHumanTurn(ctx, taskId).content).toContain('piped\\u0000feedback');
    expect(deliveredPrompt(ctx, taskId).includes(NUL)).toBe(false);
  });

  // INVARIANT: sanitization must be invisible for ordinary text. Adding a note
  // or escaping to clean feedback would corrupt every normal turn.
  test('ordinary feedback is untouched — no escapes, no note', async () => {
    const taskId = await createTask(ctx, 'Clean feedback task', 'Do work');
    await startAndSettle(ctx, taskId);

    const message = 'Please fix the off-by-one.\n\nSee line 42.';
    expectSuccess(await ctx.lazyMocked(
      ['unblock', taskId, '--message', message],
      MOCK_CLAUDE_SUCCESS,
    ));

    const human = latestHumanTurn(ctx, taskId);
    expect(human.content).toBe(message);
    expect(human.content).not.toContain('lazy sanitized');
  });

  test('comment with a NUL is persisted sanitized, not raw', async () => {
    const taskId = await createTask(ctx, 'NUL comment task');

    const result = await ctx.lazy(['comment', taskId], { input: `careful${NUL}here` });
    expectSuccess(result);
    expectOutput(result, 'Added comment to task');

    const comments = readJson(join(taskDir(ctx, taskId), 'comments.json'));
    expectNoNulAnywhere(comments);
    expect(comments.comments[0].content).toContain('careful\\u0000here');
  });

  test('create sanitizes a NUL-bearing prompt piped on stdin', async () => {
    // The goal carries an ESC (argv-legal but non-printable); the prompt
    // carries a NUL, which can only arrive via a pipe/file/editor.
    const result = await ctx.lazy(
      ['create', '--goal', `Fix${ESC}the parser`],
      { input: `Reject${NUL}NUL bytes at intake` },
    );
    expectSuccess(result);

    const shortId = /Created task (\S+)/.exec(result.stdout)![1];
    const dir = taskDir(ctx, shortId);

    const task = readJson(join(dir, 'task.json'));
    expectNoNulAnywhere(task);
    // A goal is a one-liner — escaped, but not padded with an explanatory note.
    expect(task.goal).toBe('Fix\\u001bthe parser');
    expect(task.goal).not.toContain('lazy sanitized');

    const show = await ctx.lazy(['show', shortId]);
    expectSuccess(show);
    expect(show.stdout.includes(NUL)).toBe(false);
    expectOutput(show, 'Reject\\u0000NUL bytes at intake');
  });
});
