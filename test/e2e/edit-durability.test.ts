import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskJson, readTurns, taskFilePath } from '../helpers/storage';
import { readFileSync } from 'fs';

const TRUNCATED = 'Do the thing:\n\n1. **First step**\n2. **';
const FULL = 'Do the thing:\n\n1. **First step**\n2. **Second step** — the part that was cut off.\n3. **Third step**';

/** Latest prompt version content, straight from prompt-history.json. */
function latestPromptVersion(root: string, shortId: string): string {
  const raw = readFileSync(taskFilePath(root, shortId, 'prompt-history.json'), 'utf-8');
  const versions = (JSON.parse(raw).versions ?? []) as Array<{ version: number; content: string }>;
  versions.sort((a, b) => b.version - a.version);
  return versions[0]?.content ?? '';
}

/**
 * INVARIANT: an acknowledged prompt edit is durable, and the agent is launched
 * with the LATEST accepted prompt — never a pre-edit snapshot. The prompt is
 * human input; CLAUDE.md's "Never Lose Human Feedback" rule covers it, so
 * reporting the edit as saved and then handing the agent the old text is a
 * correctness bug, not a cosmetic one.
 *
 * Regression guard for: a task created with a truncated prompt, edited to the
 * full text (edit acknowledged), then started — and both the stored prompt and
 * turn 1 came back as the truncated original.
 */
describe('prompt edit durability across start', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // start's turn-1 record is written by the daemon, so this needs a real one.
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('an edited prompt survives start and is what the agent receives', async () => {
    const taskId = await createTask(ctx, 'Edited task', TRUNCATED);

    expectSuccess(await ctx.lazy(['edit', taskId, '--prompt', FULL]));

    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    // The stored prompt was not reverted by start's own writes.
    expect(readTaskJson(ctx.root, taskId).prompt).toBe(FULL);
    // `lazy show` reads the prompt back from history — that must agree.
    expect(latestPromptVersion(ctx.root, taskId)).toBe(FULL);

    // And turn 1 — what the agent actually got — carries the edited text.
    const turn1 = readTurns(ctx.root, taskId).find(t => t.sequence === 1);
    expect(turn1).toBeDefined();
    expect(turn1!.content).toContain('Second step');
    expect(turn1!.content).not.toMatch(/2\. \*\*\s*$/);
  });

  test('goal, type and code edits also survive start', async () => {
    // The reported loss was of a prompt, but the mechanism was field-agnostic:
    // a whole-task-directory swap reverts every field the loser wrote.
    const taskId = await createTask(ctx, 'Original goal', 'Some prompt');

    expectSuccess(await ctx.lazy(['edit', taskId, '--goal', 'Edited goal']));
    expectSuccess(await ctx.lazy(['edit', taskId, '--type', 'fix']));
    expectSuccess(await ctx.lazy(['edit', taskId, '--code', 'edited-code']));

    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
      env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
    }));
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

    const stored = readTaskJson(ctx.root, taskId);
    expect(stored.goal).toBe('Edited goal');
    expect(stored.type).toBe('fix');
    expect(stored.code).toBe('edited-code');
  });

  test('an edit racing start is never silently reverted', async () => {
    // The reported incident issued edit and start in one parallel batch, so
    // the two overlapped inside the daemon. Whether the edit lands before or
    // after turn 1 is composed is genuinely a race — what must NEVER happen is
    // the acknowledged edit being rolled back by start's concurrent writes.
    // Which side wins is timing-dependent, so race several tasks: against the
    // pre-fix code roughly one attempt in three lost the edit outright.
    for (let attempt = 0; attempt < 5; attempt++) {
      const taskId = await createTask(ctx, `Raced task ${attempt}`, TRUNCATED);

      // Launch first, then edit into the launch window — that ordering is what
      // reproduces it (with the lock re-entrant per PID, `edit` returned 0 and
      // the stored prompt stayed truncated).
      const startPromise = ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS, {
        env: { LAZY_MOCK_SHOULD_COMMIT: '1' },
      });
      const editResult = await ctx.lazy(['edit', taskId, '--prompt', FULL]);
      expectSuccess(await startPromise);
      expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);

      // If the launch won the race, the edit is legitimately REJECTED (the task
      // already has turns) — that is a correct, loud outcome. What must never
      // happen is edit reporting success and the prompt staying truncated.
      if (editResult.exitCode === 0) {
        expect(readTaskJson(ctx.root, taskId).prompt).toBe(FULL);
        expect(latestPromptVersion(ctx.root, taskId)).toBe(FULL);
      } else {
        expect(readTaskJson(ctx.root, taskId).prompt).toBe(TRUNCATED);
      }
    }
  }, 120_000);
});
