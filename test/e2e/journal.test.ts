import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { createAllHandlers, type McpToolContext } from '../../src/mcp/tools';
import { createStorage, type Storage } from '../../src/storage';

describe('lazy journal', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('appends a journal entry with --message flag', async () => {
    const taskId = await createTask(ctx, 'Task with journal');

    const result = await ctx.lazy(['journal', taskId, '--message', 'Blocked on upstream X landing']);

    expectSuccess(result);
    expectOutput(result, 'Added journal entry to task');
  });

  test('accepts -m as a short alias for --message', async () => {
    const taskId = await createTask(ctx, 'Task with -m alias');

    const result = await ctx.lazy(['journal', taskId, '-m', 'Short-flag journal entry']);

    expectSuccess(result);
    expectOutput(result, 'Added journal entry to task');

    const showResult = await ctx.lazy(['show', taskId]);
    expectOutput(showResult, 'Short-flag journal entry');
  });

  test('appends a journal entry from piped stdin', async () => {
    const taskId = await createTask(ctx, 'Task with piped journal');

    const result = await ctx.lazy(['journal', taskId], { input: 'Stubbed retry logic, revisit next run' });

    expectSuccess(result);
    expectOutput(result, 'Added journal entry to task');
  });

  test('journal entry appears in show output', async () => {
    const taskId = await createTask(ctx, 'Task with visible journal');
    await ctx.lazy(['journal', taskId, '--message', 'Chose K=3 because of latency budget']);

    const showResult = await ctx.lazy(['show', taskId]);

    expectSuccess(showResult);
    expectOutput(showResult, 'Journal (1)');
    expectOutput(showResult, 'Chose K=3 because of latency budget');
  });

  test('bare invocation reads entries (the safe default)', async () => {
    const taskId = await createTask(ctx, 'Read mode task');
    await ctx.lazy(['journal', taskId, '--message', 'Decision A']);
    await ctx.lazy(['journal', taskId, '--message', 'Decision B']);

    const result = await ctx.lazy(['journal', taskId]);

    expectSuccess(result);
    expectOutput(result, 'Decision A');
    expectOutput(result, 'Decision B');
  });

  test('read mode reports when there are no entries', async () => {
    const taskId = await createTask(ctx, 'Empty journal task');

    const result = await ctx.lazy(['journal', taskId]);

    expectSuccess(result);
    expectOutput(result, 'No journal entries');
  });

  test('fails with nonexistent task', async () => {
    const result = await ctx.lazy(['journal', 'nonexist0', '--message', 'some entry']);

    expectFailure(result);
    expectError(result, 'No task found matching');
  });

  test('appending via the MCP lazy_journal tool persists the entry', async () => {
    // Drive the MCP tool handler in-process against this project's storage,
    // mirroring how an agent/builder would call lazy_journal.
    const storage: Storage = await createStorage(ctx.root, { backend: 'external' });
    try {
      const mctx: McpToolContext = { taskId: '', worktreePath: ctx.root, storage };
      const handlers = createAllHandlers(mctx);

      const createHandler = handlers.get('lazy_create');
      const created = await createHandler!({ goal: 'MCP journal task', prompt: 'work' });
      const taskId = (created as any).id as string;

      const journalHandler = handlers.get('lazy_journal');
      expect(journalHandler).toBeDefined();

      const appended = await journalHandler!({ task_id: taskId, message: 'Agent memory: deferred Z' });
      expect((appended as any).content).toBe('Agent memory: deferred Z');

      // Verify it was persisted and attributed to the builder/agent actor.
      const stored = await storage.getTaskJournal(taskId);
      expect(stored).toHaveLength(1);
      expect(stored[0].content).toBe('Agent memory: deferred Z');
      expect(stored[0].actor).toBe('builder');
    } finally {
      await storage.close();
    }
  });

});

// The prompt-immunity invariant needs a real run (a `start`), which requires
// the daemon-backed storage path — hence a separate, daemon-enabled context.
describe('lazy journal — prompt immunity', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: journal entries are prompt-immune — they must NEVER be injected
  // into the agent/LLM prompt. This is the load-bearing reason the journal is a
  // separate entity from comments (which DO enter the prompt as guidance) rather
  // than a flag on Comment: with no shared code path, a journal entry cannot leak
  // into a prompt. This test pins that guarantee end to end: on the next run, a
  // comment IS present in the assembled prompt while a journal entry is NOT.
  // Do not weaken or delete this without explicit human approval (see CLAUDE.md).
  test('journal entry does NOT appear in the agent prompt on the next run', async () => {
    const taskId = await createTask(ctx, 'Prompt-immunity task', 'Do the work');

    await ctx.lazy(['comment', taskId, '--message', 'COMMENT_MARKER_inject_me as guidance']);
    await ctx.lazy(['journal', taskId, '--message', 'JOURNAL_MARKER_keep_out of the prompt']);

    const startResult = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(startResult);

    const showResult = await ctx.lazy(['show', taskId, '--json']);
    expectSuccess(showResult);
    const data = JSON.parse(showResult.stdout);
    const humanTurn = (data.turns as Array<{ role: string; prompt: string | null }>)
      .find(t => t.role === 'human');
    expect(humanTurn).toBeDefined();
    const prompt = humanTurn!.prompt ?? '';

    // Sanity: the comment DID reach the prompt (so the assertion below is meaningful).
    expect(prompt).toContain('COMMENT_MARKER_inject_me');
    // The invariant: the journal entry did NOT.
    expect(prompt).not.toContain('JOURNAL_MARKER_keep_out');
  });
});
