import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError, expectOutputExcludes } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS, startAndReconcile } from '../helpers/fixtures';

describe('lazy search', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('finds tasks by goal text', async () => {
    await createTask(ctx, 'Implement authentication module');
    await createTask(ctx, 'Fix database connection');

    const result = await ctx.lazy(['search', 'authentication']);

    expectSuccess(result);
    expectOutput(result, 'authentication');
  });

  test('finds tasks by prompt text', async () => {
    await createTask(ctx, 'Auth task', 'Use OAuth2 with JWT tokens');

    const result = await ctx.lazy(['search', 'JWT']);

    expectSuccess(result);
    expectOutput(result, 'JWT');
  });

  test('finds tasks by code text', async () => {
    const taskId = await createTask(ctx, 'Authentication module');
    // Set a code on it
    await ctx.lazy(['edit', taskId, '--code', 'auth-module']);

    const result = await ctx.lazy(['search', 'auth-module']);

    expectSuccess(result);
    expectOutput(result, 'auth-module');
  });

  test('finds tasks by partial code text', async () => {
    const taskId = await createTask(ctx, 'Fix authentication bug');
    await ctx.lazy(['edit', taskId, '--code', 'fix-auth-bug']);

    const result = await ctx.lazy(['search', 'auth-bug']);

    expectSuccess(result);
    expectOutput(result, 'fix-auth-bug');
  });

  test('shows message when no matches', async () => {
    await createTask(ctx, 'Some task');

    const result = await ctx.lazy(['search', 'xyznonexistent']);

    expectSuccess(result);
    expectOutput(result, 'No matches');
  });

  // --- Structured query language tests ---

  describe('query language', () => {
    test('status: field filter', async () => {
      await createTask(ctx, 'Auth module');
      await createTask(ctx, 'Database fix');

      // All tasks start as 'backlog' status
      const result = await ctx.lazy(['search', 'status:backlog']);

      expectSuccess(result);
      expectOutput(result, 'Auth module');
      expectOutput(result, 'Database fix');
    });

    test('status: filter excludes non-matching', async () => {
      await createTask(ctx, 'Auth module');

      const result = await ctx.lazy(['search', 'status:working']);

      expectSuccess(result);
      expectOutput(result, 'No matches');
    });

    test('goal: field filter', async () => {
      await createTask(ctx, 'Implement authentication module');
      await createTask(ctx, 'Fix database connection');

      const result = await ctx.lazy(['search', 'goal:authentication']);

      expectSuccess(result);
      expectOutput(result, 'authentication');
      expectOutputExcludes(result, 'database');
    });

    test('code: field filter', async () => {
      // createTask uses --goal, the task gets auto-assigned a code or no code
      // We need to test that code: works if the task has a code
      const taskId = await createTask(ctx, 'Auth module');
      // Set a code on it
      await ctx.lazy(['edit', taskId, '--code', 'auth-mod']);

      const result = await ctx.lazy(['search', 'code:auth-mod']);

      expectSuccess(result);
      expectOutput(result, 'Auth module');
    });

    test('AND boolean operator', async () => {
      await createTask(ctx, 'Implement authentication module');
      await createTask(ctx, 'Fix database connection');

      const result = await ctx.lazy(['search', 'status:backlog AND goal:authentication']);

      expectSuccess(result);
      expectOutput(result, 'authentication');
      expectOutputExcludes(result, 'database');
    });

    test('OR boolean operator', async () => {
      await createTask(ctx, 'Implement authentication');
      await createTask(ctx, 'Fix database');
      await createTask(ctx, 'Unrelated task');

      const result = await ctx.lazy(['search', 'goal:authentication OR goal:database']);

      expectSuccess(result);
      expectOutput(result, 'authentication');
      expectOutput(result, 'database');
    });

    test('NOT boolean operator', async () => {
      await createTask(ctx, 'Implement authentication');
      await createTask(ctx, 'Fix database');

      const result = await ctx.lazy(['search', 'status:backlog AND NOT goal:database']);

      expectSuccess(result);
      expectOutput(result, 'authentication');
      expectOutputExcludes(result, 'database');
    });

    test('parenthesized grouping', async () => {
      await createTask(ctx, 'Auth module');
      await createTask(ctx, 'Database fix');

      const result = await ctx.lazy(['search', '(goal:auth OR goal:database) AND status:backlog']);

      expectSuccess(result);
      expectOutput(result, 'Auth module');
      expectOutput(result, 'Database fix');
    });

    test('has:comments filter', async () => {
      const taskId = await createTask(ctx, 'Task with comment');
      await createTask(ctx, 'Task without comment');

      // Add a comment to the first task
      await ctx.lazy(['comment', taskId, '--message', 'This is a comment']);

      const result = await ctx.lazy(['search', 'has:comments']);

      expectSuccess(result);
      expectOutput(result, 'Task with comment');
      expectOutputExcludes(result, 'Task without comment');
    });

    test('in:comments search', async () => {
      const taskId = await createTask(ctx, 'Commented task');
      await ctx.lazy(['comment', taskId, '--message', 'Review feedback about reconciler']);

      const result = await ctx.lazy(['search', 'in:comments reconciler', '--group']);

      expectSuccess(result);
      expectOutput(result, 'Commented task');
      expectOutput(result, 'reconciler');
    });

    test('quoted multi-word text search', async () => {
      await createTask(ctx, 'Fix error handling in auth');
      await createTask(ctx, 'Error in database');

      const result = await ctx.lazy(['search', 'goal:"error handling"']);

      expectSuccess(result);
      expectOutput(result, 'error handling');
      expectOutputExcludes(result, 'database');
    });

    test('shows error for malformed query', async () => {
      const result = await ctx.lazy(['search', 'in:invalid foo']);

      expectFailure(result);
      expectError(result, 'Query parse error');
    });

    test('date filter created:>', async () => {
      await createTask(ctx, 'Recent task');

      // The task was just created, so it should be after 2020-01-01
      const result = await ctx.lazy(['search', 'created:>2020-01-01']);

      expectSuccess(result);
      expectOutput(result, 'Recent task');
    });

    test('date filter created:< excludes future', async () => {
      await createTask(ctx, 'Some task');

      // Task was created now, should not be before 2020-01-01
      const result = await ctx.lazy(['search', 'created:<2020-01-01']);

      expectSuccess(result);
      expectOutput(result, 'No matches');
    });

    test('parentheses in plain text do not trigger structured parse', async () => {
      await createTask(ctx, 'Implement function() handler');

      // "function()" contains parens but no operators/fields — should use regex search
      const result = await ctx.lazy(['search', 'function()']);

      expectSuccess(result);
      expectOutput(result, 'function');
    });

    // code: field filter with hyphenated values — the original reported bug.
    // The tokenizer must handle hyphens in field values correctly.
    test('code: matches hyphenated codes', async () => {
      const taskId = await createTask(ctx, 'Document search syntax');
      await ctx.lazy(['edit', taskId, '--code', 'doc-search-syntax']);

      const result = await ctx.lazy(['search', 'code:doc-search-syntax']);

      expectSuccess(result);
      expectOutput(result, 'Document search syntax');
    });

    // code: is case-insensitive — searching with different case should still match.
    test('code: is case-insensitive', async () => {
      const taskId = await createTask(ctx, 'Auth module');
      await ctx.lazy(['edit', taskId, '--code', 'auth-mod']);

      const result = await ctx.lazy(['search', 'code:AUTH-MOD']);

      expectSuccess(result);
      expectOutput(result, 'Auth module');
    });

    // code: excludes tasks without matching code.
    test('code: excludes non-matching tasks', async () => {
      const taskId1 = await createTask(ctx, 'First task');
      await ctx.lazy(['edit', taskId1, '--code', 'first-code']);
      const taskId2 = await createTask(ctx, 'Second task');
      await ctx.lazy(['edit', taskId2, '--code', 'second-code']);

      const result = await ctx.lazy(['search', 'code:first-code']);

      expectSuccess(result);
      expectOutput(result, 'First task');
      expectOutputExcludes(result, 'Second task');
    });

    // code: requires exact match (not substring).
    test('code: requires exact match', async () => {
      const taskId = await createTask(ctx, 'Some task');
      await ctx.lazy(['edit', taskId, '--code', 'full-code-name']);

      // Partial code should NOT match with code: field filter
      const result = await ctx.lazy(['search', 'code:full-code']);

      expectSuccess(result);
      expectOutput(result, 'No matches');
    });

    // status: is case-insensitive.
    test('status: is case-insensitive', async () => {
      await createTask(ctx, 'Backlog task');

      const result = await ctx.lazy(['search', 'status:BACKLOG']);

      expectSuccess(result);
      expectOutput(result, 'Backlog task');
    });

    // goal: does substring matching (not exact).
    test('goal: does substring matching', async () => {
      await createTask(ctx, 'Implement the authentication handler');

      const result = await ctx.lazy(['search', 'goal:authentication']);

      expectSuccess(result);
      expectOutput(result, 'authentication');
    });

    // has:comments with no comments returns no matches.
    test('has:comments returns no matches when none have comments', async () => {
      await createTask(ctx, 'Task without comments');

      const result = await ctx.lazy(['search', 'has:comments']);

      expectSuccess(result);
      expectOutput(result, 'No matches');
    });

    // in:comments returns no matches when comment text doesn't match.
    test('in:comments excludes non-matching comment text', async () => {
      const taskId = await createTask(ctx, 'Task with unrelated comment');
      await ctx.lazy(['comment', taskId, '--message', 'This comment is about databases']);

      const result = await ctx.lazy(['search', 'in:comments authentication']);

      expectSuccess(result);
      expectOutput(result, 'No matches');
    });

    // Multiple field filters combined with AND.
    test('multiple filters combined: code AND status', async () => {
      const taskId = await createTask(ctx, 'Auth module task');
      await ctx.lazy(['edit', taskId, '--code', 'auth-mod']);

      const result = await ctx.lazy(['search', 'code:auth-mod AND status:backlog']);

      expectSuccess(result);
      expectOutput(result, 'Auth module task');
    });

    // Multiple field filters: code AND wrong status returns nothing.
    test('combined filters: correct code but wrong status returns nothing', async () => {
      const taskId = await createTask(ctx, 'Auth module task');
      await ctx.lazy(['edit', taskId, '--code', 'auth-mod']);

      const result = await ctx.lazy(['search', 'code:auth-mod AND status:working']);

      expectSuccess(result);
      expectOutput(result, 'No matches');
    });

    // Date filter updated:> matches tasks updated after a given date.
    test('date filter updated:>', async () => {
      await createTask(ctx, 'Updated task');

      // Task was just created, updated_at falls back to created_at
      const result = await ctx.lazy(['search', 'updated:>2020-01-01']);

      expectSuccess(result);
      expectOutput(result, 'Updated task');
    });

    // Date filter updated:< excludes recently updated tasks.
    test('date filter updated:< excludes recent tasks', async () => {
      await createTask(ctx, 'Recent task');

      const result = await ctx.lazy(['search', 'updated:<2020-01-01']);

      expectSuccess(result);
      expectOutput(result, 'No matches');
    });

    // Malformed date format gives a parse error.
    test('malformed date format gives parse error', async () => {
      const result = await ctx.lazy(['search', 'created:>2026-1-1']);

      expectFailure(result);
      expectError(result, 'YYYY-MM-DD');
    });

    // INVARIANT: adjacent terms with no operator are an implicit AND — NOT a
    // parse error. This is the documented grammar ("and_expr → term ((AND |
    // implicit_AND) term)*" in src/search/parser.ts) and documented user-facing
    // behavior (docs/search.md, "adjacent tokens are an implicit AND", which is
    // also why `tag:My Feature Work` silently matches nothing). This test
    // previously asserted the opposite; implicit AND shipped in v0.9, after the
    // assertion was written in v0.5, and the assertion was never updated.
    test('missing operator between field terms is an implicit AND', async () => {
      await createTask(ctx, 'Add auth to the gateway');
      await createTask(ctx, 'Unrelated cleanup');

      const result = await ctx.lazy(['search', 'status:backlog goal:auth']);

      expectSuccess(result);
      expectOutput(result, 'Add auth to the gateway');
      expectOutputExcludes(result, 'Unrelated cleanup');
    });

    // has: with invalid scope gives a parse error.
    test('has: with invalid scope gives parse error', async () => {
      const result = await ctx.lazy(['search', 'has:invalid']);

      expectFailure(result);
      expectError(result, 'Query parse error');
    });

    // code: without a value gives a parse error.
    test('code: without value gives parse error', async () => {
      const result = await ctx.lazy(['search', 'code: AND status:backlog']);

      expectFailure(result);
      expectError(result, 'Query parse error');
    });
  });

  // --- Content scoping and existence checks with sessions ---

  describe('content scoping', () => {
    // These tests require starting a task to create sessions with turns and commits.

    // INVARIANT: has:turns must detect tasks that have been started (have sessions with turns).
    test('has:turns finds tasks with sessions', async () => {
      const taskWithTurns = await createTask(ctx, 'Task with agent session', 'Implement the feature');
      await createTask(ctx, 'Task without session', 'No implementation needed');

      // Start the task to create a session with turns
      const startResult = await ctx.lazyMocked(
        ['start', taskWithTurns, '--yes'],
        MOCK_CLAUDE_SUCCESS,
        { env: { LAZY_MOCK_SHOULD_COMMIT: '1' } },
      );
      expectSuccess(startResult);

      const result = await ctx.lazy(['search', 'has:turns']);

      expectSuccess(result);
      expectOutput(result, 'Task with agent session');
      expectOutputExcludes(result, 'Task without session');
    });

    // INVARIANT: has:commits must detect tasks where the agent made commits.
    test('has:commits finds tasks with commits', async () => {
      const taskWithCommits = await createTask(ctx, 'Task with agent commits', 'Make the changes');
      await createTask(ctx, 'Task without commits', 'Nothing to do');

      // Start with LAZY_MOCK_SHOULD_COMMIT=1 to create commits. The commit rows
      // are written when the response is RECONCILED, not by `start` itself — so
      // a daemonless suite has to drive that pass (see startAndReconcile).
      await startAndReconcile(ctx, taskWithCommits);

      const result = await ctx.lazy(['search', 'has:commits']);

      expectSuccess(result);
      expectOutput(result, 'Task with agent commits');
      expectOutputExcludes(result, 'Task without commits');
    });

    // in:turns searches within turn content for matching text.
    test('in:turns searches turn content', async () => {
      const taskId = await createTask(ctx, 'Reconciler task', 'Fix the reconciler');

      // The mock response text becomes a turn's content
      const mockResponse = {
        result: 'Fixed the reconciler blind spot in the evaluator module.',
        session_id: 'mock-sess-turns',
        usage: { input_tokens: 100, output_tokens: 200 },
      };

      // The response text lands on the turn during reconciliation, so a
      // daemonless suite must drive that pass before searching turn content.
      await startAndReconcile(ctx, taskId, { mockResponse });

      const result = await ctx.lazy(['search', 'in:turns evaluator']);

      expectSuccess(result);
      // The match is a turn, so we check for the turn content text
      expectOutput(result, 'evaluator');

      // Also verify via grouped output that the right task is shown
      const grouped = await ctx.lazy(['search', 'in:turns evaluator', '--group']);
      expectSuccess(grouped);
      expectOutput(grouped, 'Reconciler task');
    });

    // INVARIANT: a turn hit must name WHICH turn matched. Search excerpts are
    // truncated by design (search locates, `show` reads), so a hit labelled
    // only "turn" leaves the reader scanning show output for the excerpt. The
    // sequence is what show prints as `--- Turn #N ---`.
    test('turn hits are labelled with the turn sequence', async () => {
      const taskId = await createTask(ctx, 'Turn locator task', 'Fix the widget');

      await startAndReconcile(ctx, taskId, {
        mockResponse: {
          result: 'Rewrote the widget_locator_marker path.',
          session_id: 'mock-sess-locator',
          usage: { input_tokens: 100, output_tokens: 200 },
        },
      });

      const result = await ctx.lazy(['search', 'in:turns widget_locator_marker']);
      expectSuccess(result);
      expectOutput(result, 'turn #');

      // The sequence printed must be the one `show` renders for that turn.
      const seq = result.stdout.match(/turn #(\d+)/)![1];
      const shown = await ctx.lazy(['show', taskId]);
      expectSuccess(shown);
      expect(shown.stdout).toMatch(new RegExp(`#${seq} \\[agent\\][^\\n]*widget_locator_marker`));
    });

    // --json carries the locator as structured data: turn_seq from the stored
    // turn (not scraped back out of rendered show output), plus index — the
    // entity's offset in the list show pages over.
    test('--json turn hits carry turn_seq and index', async () => {
      const taskId = await createTask(ctx, 'Json locator task', 'Fix the gadget');

      await startAndReconcile(ctx, taskId, {
        mockResponse: {
          result: 'Rewrote the gadget_locator_marker path.',
          session_id: 'mock-sess-json-locator',
          usage: { input_tokens: 100, output_tokens: 200 },
        },
      });

      const result = await ctx.lazy(['search', 'in:turns gadget_locator_marker', '--json']);
      expectSuccess(result);

      const parsed = JSON.parse(result.stdout);
      const turnMatch = parsed.matches.find((m: any) => m.match_type === 'turn');
      expect(turnMatch).toBeDefined();
      expect(typeof turnMatch.context.turn_seq).toBe('number');
      expect(typeof turnMatch.context.index).toBe('number');
      expect(turnMatch.context.index).toBeGreaterThanOrEqual(0);
    });

    // in:commits searches commit messages.
    test('in:commits searches commit messages', async () => {
      const taskId = await createTask(ctx, 'Commit search task', 'Make some commits');

      // Commit rows are written at reconcile time (see has:commits above).
      await startAndReconcile(ctx, taskId);

      // The mock creates commits with message "Mock agent commit (supervisor)"
      const result = await ctx.lazy(['search', 'in:commits "Mock agent commit"']);

      expectSuccess(result);
      // Check for the matched commit message text
      expectOutput(result, 'Mock agent commit');

      // Also verify via grouped output that the right task is shown
      const grouped = await ctx.lazy(['search', 'in:commits "Mock agent commit"', '--group']);
      expectSuccess(grouped);
      expectOutput(grouped, 'Commit search task');
    });
  });

  // --- JSON output tests ---

  describe('--json', () => {
    test('outputs valid JSON with matches array', async () => {
      await createTask(ctx, 'Search JSON test task');

      const result = await ctx.lazy(['search', 'JSON test', '--json']);

      expectSuccess(result);
      const json = JSON.parse(result.stdout);
      expect(json.query).toBe('JSON test');
      expect(Array.isArray(json.matches)).toBe(true);
      expect(json.matches.length).toBeGreaterThan(0);
    });

    // INVARIANT: JSON search results must include line numbers that correspond
    // to show --lines output. This is the key capability that enables agents
    // to jump from search hits to surrounding context.
    test('includes line numbers in matches', async () => {
      await createTask(ctx, 'Auth module for line test');

      const result = await ctx.lazy(['search', 'Auth module', '--json']);

      expectSuccess(result);
      const json = JSON.parse(result.stdout);
      expect(json.matches.length).toBeGreaterThan(0);

      const match = json.matches[0];
      expect(match.task_id).toBeDefined();
      expect(match.match_type).toBeDefined();
      expect(match.line).toBeGreaterThan(0);
      expect(match.content).toBeDefined();
    });

    // INVARIANT: line numbers from search --json must work with show --lines.
    // This is the core agent workflow: search → get line → show context.
    test('line numbers correspond to show --lines output', async () => {
      const taskId = await createTask(ctx, 'Reconciler line number test', 'Fix reconciler blind spot');

      const searchResult = await ctx.lazy(['search', 'reconciler', '--json']);

      expectSuccess(searchResult);
      const json = JSON.parse(searchResult.stdout);
      expect(json.matches.length).toBeGreaterThan(0);

      // Find a match with a line number
      const matchWithLine = json.matches.find((m: any) => m.line !== null);
      expect(matchWithLine).toBeDefined();

      // Use the line number to fetch context from show
      const lineNum = matchWithLine.line;
      const showResult = await ctx.lazy(['show', taskId, '--lines', `${lineNum}..${lineNum}`]);

      expectSuccess(showResult);
      // The line at this position should contain the matching content
      const showLine = showResult.stdout.toLowerCase();
      expect(showLine.includes('reconciler')).toBe(true);
    });

    test('includes match_type field', async () => {
      await createTask(ctx, 'Type test task', 'Prompt content for type test');

      // Search for something in the prompt
      const result = await ctx.lazy(['search', 'Prompt content', '--json']);

      expectSuccess(result);
      const json = JSON.parse(result.stdout);

      // Should have at least one prompt-type match
      const promptMatch = json.matches.find((m: any) => m.match_type === 'prompt');
      expect(promptMatch).toBeDefined();
    });

    test('returns empty matches array for no results', async () => {
      await createTask(ctx, 'Some task');

      const result = await ctx.lazy(['search', 'xyznonexistent', '--json']);

      expectSuccess(result);
      const json = JSON.parse(result.stdout);
      expect(json.matches).toEqual([]);
    });

    // INVARIANT: text output must not change when --json is not passed.
    test('text output unchanged without --json', async () => {
      await createTask(ctx, 'Text format task');

      const result = await ctx.lazy(['search', 'Text format']);

      expectSuccess(result);
      // Should contain human-readable formatting, not JSON
      expectOutput(result, 'Text format');
      // Should NOT be valid JSON
      expect(() => JSON.parse(result.stdout)).toThrow();
    });
  });

  // Searching by tag used to fail silently: every one of these inputs returned a
  // bare "No matches found." with nothing to distinguish a typo from a tag that
  // was never applied from a value the shell had split apart.
  describe('tag search', () => {
    test('tag: value is normalized the same way it is on write', async () => {
      const tagged = await createTask(ctx, 'Normalized tag task');
      expectSuccess(await ctx.lazy(['tag', tagged, 'My Feature Work']));

      // Stored as 'my-feature-work'; all of these spellings must reach it.
      for (const query of [
        'tag:my-feature-work',
        'tag:My-Feature-Work',
        'tag:#my-feature-work',
        'tag:"My Feature Work"',
      ]) {
        const result = await ctx.lazy(['search', query]);
        expectSuccess(result);
        expectOutput(result, 'Normalized tag task');
      }
    });

    // The CLI PRINTS tags with a leading '#' ("Tagged x with #launch", "Tags: #launch"),
    // so the spelling lazy shows the user must be a spelling search accepts.
    test('bare #tag finds the tagged task', async () => {
      const tagged = await createTask(ctx, 'Hash spelled task');
      await createTask(ctx, 'Untagged other task');
      expectSuccess(await ctx.lazy(['tag', tagged, 'launch']));

      const result = await ctx.lazy(['search', '#launch']);
      expectSuccess(result);
      expectOutput(result, 'Hash spelled task');
      expectOutputExcludes(result, 'Untagged other task');
    });

    // INVARIANT: '#foo' matches the TAG foo OR the literal text '#foo' — never the
    // tag alone. Issue refs like '#1234' in goals and commit messages were findable
    // before tags existed and must stay findable.
    test('bare #text still finds literal text when no such tag exists', async () => {
      await createTask(ctx, 'Fix issue #1234 in the parser');

      const result = await ctx.lazy(['search', '#1234']);
      expectSuccess(result);
      expectOutput(result, 'Fix issue #1234 in the parser');
    });

    test('unmatched tag reports which tag is missing and lists known tags', async () => {
      const tagged = await createTask(ctx, 'Tagged with launch');
      expectSuccess(await ctx.lazy(['tag', tagged, 'launch']));

      const result = await ctx.lazy(['search', 'tag:launhc']);
      expectSuccess(result);
      expectOutput(result, 'No matches found.');
      expectOutput(result, 'No task is tagged #launhc');
      // Close enough to suggest, and the full tag list is shown regardless.
      expectOutput(result, '#launch');
      expectOutput(result, 'Known tags:');
    });

    // An unquoted multi-word tag parses as `tag:<first-word> AND <rest as text>`,
    // which is indistinguishable from a legitimate `tag:x some text` query — so it
    // is not silently "fixed" in the parser, it is explained.
    test('unquoted multi-word tag explains itself instead of failing silently', async () => {
      const tagged = await createTask(ctx, 'Multi word tagged task');
      expectSuccess(await ctx.lazy(['tag', tagged, 'My Feature Work']));

      const result = await ctx.lazy(['search', 'tag:My Feature Work']);
      expectSuccess(result);
      expectOutput(result, 'No matches found.');
      expectOutput(result, 'No task is tagged #my');
      expectOutput(result, '#my-feature-work');
      expectOutput(result, 'Quote a multi-word tag');
    });

    // The write side (normalizeTagOrThrow) rejects a tag with no alphanumerics;
    // the query side must not silently return zero matches for the same input.
    test('tag value with no alphanumerics is a parse error, not a silent miss', async () => {
      await createTask(ctx, 'Some task');

      const result = await ctx.lazy(['search', 'tag:###']);
      expectFailure(result);
      expectError(result, 'is not a valid tag');
    });

    test('no hint when the tag exists but the rest of the query excludes it', async () => {
      const tagged = await createTask(ctx, 'Backlog tagged task');
      expectSuccess(await ctx.lazy(['tag', tagged, 'launch']));

      // The tag DOES exist — the status is what filtered it out, so a
      // "no task is tagged #launch" hint would be actively wrong.
      const result = await ctx.lazy(['search', 'tag:launch AND status:complete']);
      expectSuccess(result);
      expectOutput(result, 'No matches found.');
      expectOutputExcludes(result, 'No task is tagged');
    });
  });
});
