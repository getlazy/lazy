import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, extractTaskId } from '../helpers/assertions';

describe('task codes', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('creates a task with --code flag', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Fix model selection', '--code', 'fix-models']);

    expectSuccess(result);
    expectOutput(result, 'Created task');
    expectOutput(result, 'Code:   fix-models');
    expectOutput(result, 'lazy start fix-models');
  });

  test('task code is shown in show output', async () => {
    await ctx.lazy(['create', '--goal', 'Fix auth', '--code', 'fix-auth']);

    const showResult = await ctx.lazy(['show', 'fix-auth']);
    expectSuccess(showResult);
    expectOutput(showResult, 'Code:    fix-auth');
    expectOutput(showResult, 'Fix auth');
  });

  test('resolves task by code in show command', async () => {
    await ctx.lazy(['create', '--goal', 'Add logging', '--code', 'add-logging']);

    const result = await ctx.lazy(['show', 'add-logging']);
    expectSuccess(result);
    expectOutput(result, 'Add logging');
  });

  test('resolves task by hex ID when code is set', async () => {
    const createResult = await ctx.lazy(['create', '--goal', 'Fix tests', '--code', 'fix-tests']);
    const taskId = extractTaskId(createResult.stdout);

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutput(result, 'Fix tests');
    expectOutput(result, 'Code:    fix-tests');
  });

  test('tasks without codes work exactly as before', async () => {
    const createResult = await ctx.lazy(['create', '--goal', 'No code task']);
    const taskId = extractTaskId(createResult.stdout);

    const result = await ctx.lazy(['show', taskId]);
    expectSuccess(result);
    expectOutput(result, 'No code task');
  });

  test('code appears in list output', async () => {
    await ctx.lazy(['create', '--goal', 'Task with code', '--code', 'my-task']);
    await ctx.lazy(['create', '--goal', 'Task without code']);

    const result = await ctx.lazy(['list']);
    expectSuccess(result);
    expectOutput(result, 'CODE');
    expectOutput(result, 'my-task');
  });

  test('rejects invalid code format: spaces', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test', '--code', 'has spaces']);

    expectFailure(result);
    expectError(result, 'Invalid code');
  });

  test('rejects invalid code format: uppercase', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test', '--code', 'HasUpper']);

    expectFailure(result);
    expectError(result, 'Invalid code');
  });

  test('rejects invalid code format: special characters', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test', '--code', 'fix@bug']);

    expectFailure(result);
    expectError(result, 'Invalid code');
  });

  test('rejects code that is too short', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test', '--code', 'x']);

    expectFailure(result);
    expectError(result, 'Code must be 2-80 characters');
  });

  test('accepts minimum length code (2 chars)', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test', '--code', 'ab']);

    expectSuccess(result);
    expectOutput(result, 'Code:   ab');
  });

  test('accepts maximum length code (80 chars)', async () => {
    const code80 = 'a'.repeat(80);
    const result = await ctx.lazy(['create', '--goal', 'Test', '--code', code80]);

    expectSuccess(result);
    expectOutput(result, `Code:   ${code80}`);
  });

  test('rejects code longer than 80 characters', async () => {
    const code81 = 'a'.repeat(81);
    const result = await ctx.lazy(['create', '--goal', 'Test', '--code', code81]);

    expectFailure(result);
    expectError(result, 'Task code must be 80 characters or fewer (got 81)');
  });

  test('accepts a 40-character code', async () => {
    const code40 = 'fix-the-very-long-descriptive-task-name1';
    const result = await ctx.lazy(['create', '--goal', 'Test', '--code', code40]);

    expectSuccess(result);
    expectOutput(result, `Code:   ${code40}`);
  });

  /**
   * Produce a genuinely ambiguous code.
   *
   * `createTask` REJECTS a duplicate code against a non-terminal task
   * (src/storage/file-storage.ts), so two live tasks can no longer be created
   * with the same code — the old "create twice" setup silently failed its
   * second create and left the ambiguity paths untested. Nor is a terminal +
   * live pair ambiguous: `findTaskIdWithDetails` resolves to the single
   * non-terminal match.
   *
   * The collision is still reachable, and this is how it happens in real use:
   * close a task, reuse its code for a new one, then reopen the old task. That
   * is exactly the case `resolveTask`'s ambiguousMatches branch exists for.
   */
  async function createAmbiguousCode(code: string): Promise<string> {
    const first = await ctx.lazy(['create', '--goal', 'First task', '--code', code]);
    expectSuccess(first);
    const firstId = extractTaskId(first.stdout);
    expectSuccess(await ctx.lazy(['close', firstId, '--reason', 'making room', '--yes']));
    expectSuccess(await ctx.lazy(['create', '--goal', 'Second task', '--code', code]));
    expectSuccess(await ctx.lazy(['reopen', firstId, '--reason', 'still needed']));
    return firstId;
  }

  test('ambiguous code produces helpful error', async () => {
    await createAmbiguousCode('dup-code');

    const result = await ctx.lazy(['show', 'dup-code']);
    expectFailure(result);
    expectError(result, "Multiple tasks match code 'dup-code'");
    // Verify status and timestamp are shown
    expectError(result, 'backlog');
    // Check for date format (YYYY-MM-DD)
    expectError(result, '2026-');
  });

  test('ambiguous code prompts for choice in TTY mode', async () => {
    await createAmbiguousCode('tty-dup');

    // Run with LAZY_FORCE_TTY=1 and LAZY_PROMPT_DEFAULTS=1 to simulate TTY and auto-select first option
    const result = await ctx.lazy(['show', 'tty-dup'], {
      env: {
        ...process.env,
        LAZY_FORCE_TTY: '1',
        LAZY_PROMPT_DEFAULTS: '1',
      },
    });

    // Should succeed and show the first task
    expectSuccess(result);
    expectOutput(result, 'First task');
    // Should show the prompt message
    expectOutput(result, "Multiple tasks match code 'tty-dup'. Choose one:");
  });

  test('no match produces helpful error', async () => {
    const result = await ctx.lazy(['show', 'nonexistent-code']);
    expectFailure(result);
    expectError(result, "No task, conversation, or file found matching 'nonexistent-code'");
  });

  test('code works with edit command', async () => {
    await ctx.lazy(['create', '--goal', 'Editable task', '--code', 'edit-me', '--prompt', 'old prompt']);

    const result = await ctx.lazy(['edit', 'edit-me', '--goal', 'Updated goal']);
    expectSuccess(result);
    expectOutput(result, 'Updated goal');
  });

  test('code works with comment command', async () => {
    await ctx.lazy(['create', '--goal', 'Notable task', '--code', 'note-me']);

    const result = await ctx.lazy(['comment', 'note-me', '--message', 'A test note']);
    expectSuccess(result);
    expectOutput(result, 'Added comment');
  });

  test('ambiguous code prompts for choice in comment command (TTY mode)', async () => {
    // Two tasks sharing one code — only reachable by closing the first
    // (see createAmbiguousCode above for why creating twice no longer works).
    const result1 = await ctx.lazy(['create', '--goal', 'First notable task', '--code', 'note-both']);
    const taskId1 = extractTaskId(result1.stdout);
    expectSuccess(await ctx.lazy(['close', taskId1, '--reason', 'making room', '--yes']));
    const result2 = await ctx.lazy(['create', '--goal', 'Second notable task', '--code', 'note-both']);
    const taskId2 = extractTaskId(result2.stdout);

    // Run comment with LAZY_FORCE_TTY=1 and LAZY_PROMPT_DEFAULTS=1 to simulate TTY and auto-select first option
    const commentResult = await ctx.lazy(['comment', 'note-both', '--message', 'Test note'], {
      env: {
        ...process.env,
        LAZY_FORCE_TTY: '1',
        LAZY_PROMPT_DEFAULTS: '1',
      },
    });

    // Should succeed and add comment
    expectSuccess(commentResult);
    expectOutput(commentResult, 'Added comment');

    // Verify the comment was added to one of the tasks (whichever was selected first in the prompt)
    const show1 = await ctx.lazy(['show', taskId1]);
    const show2 = await ctx.lazy(['show', taskId2]);
    const hasCommentInTask1 = show1.stdout.includes('Test note');
    const hasCommentInTask2 = show2.stdout.includes('Test note');

    // Exactly one task should have the comment
    if (!hasCommentInTask1 && !hasCommentInTask2) {
      throw new Error('Comment was not added to either task');
    }
    if (hasCommentInTask1 && hasCommentInTask2) {
      throw new Error('Comment was added to both tasks');
    }
  });

  test('code starting with hyphen is rejected', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test', '--code', '-bad']);

    expectFailure(result);
    expectError(result, 'Invalid code');
  });

  test('code with only hyphens is rejected', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test', '--code', '--']);

    expectFailure(result);
    expectError(result, 'Invalid code');
  });

  test('numeric code is accepted', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test', '--code', '42']);

    expectSuccess(result);
    expectOutput(result, 'Code:   42');
  });

  test('code with dots is accepted', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Release v0.5', '--code', 'release-v0.5']);

    expectSuccess(result);
    expectOutput(result, 'Code:   release-v0.5');
  });

  test('code with multiple dots is accepted', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Version 1.2.3', '--code', 'v1.2.3']);

    expectSuccess(result);
    expectOutput(result, 'Code:   v1.2.3');
  });

  test('code with dots and hyphens is accepted', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Hotfix version 2.1', '--code', 'hotfix-v2.1']);

    expectSuccess(result);
    expectOutput(result, 'Code:   hotfix-v2.1');
  });

  test('code starting with dot is rejected', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test', '--code', '.invalid']);

    expectFailure(result);
    expectError(result, 'Invalid code');
  });

  test('code ending with dot is rejected', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Test', '--code', 'invalid.']);

    expectFailure(result);
    expectError(result, 'Invalid code');
  });

  /**
   * REGRESSION: a code that is exactly 36 characters long — the length of a UUID.
   * Task-id resolution used to take the "this is a full UUID" fast path on length
   * alone, so such a task appeared in `lazy list` but every lookup by its code
   * failed with "No task found matching". Resolution now keys off the UUID shape.
   */
  test('resolves a task whose code is exactly 36 characters', async () => {
    const code = 'fix-approval-burned-on-failed-accept';
    if (code.length !== 36) throw new Error(`fixture must be 36 chars, got ${code.length}`);

    const createResult = await ctx.lazy(['create', '--goal', 'Fix approval', '--code', code]);
    expectSuccess(createResult);

    const showResult = await ctx.lazy(['show', code]);
    expectSuccess(showResult);
    expectOutput(showResult, 'Fix approval');
    expectOutput(showResult, `Code:    ${code}`);
  });
});
