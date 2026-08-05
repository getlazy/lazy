/**
 * E2E tests for the task tagging system: tag/untag via CLI, filtering by tag in
 * list/blocked/search, and the append-only, actor-attributed tag history.
 *
 * INVARIANT (channel, not source): a tag/untag arriving via the CLI boundary is
 * attributed to actor='human'; via the MCP boundary (the builder) it is
 * actor='builder' (see mcp-tag.test.ts). History is append-only — untagging
 * appends an 'untag' event, it never erases the earlier 'tag' event. (See
 * CLAUDE.md, and the builder-actor task for the full actor taxonomy.)
 *
 * These assert on `lazy show`/`lazy list`/`lazy search` output rather than raw
 * storage files: the on-disk path is a configurable external location, and the
 * command output is the actual user-facing surface (mirrors status-history.test.ts).
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { createTask } from '../helpers/fixtures';

describe('lazy tag / untag', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('tags a task and normalizes the tag on input', async () => {
    const taskId = await createTask(ctx, 'Tagging test');

    // Mixed-case + punctuation input normalizes to lowercase alphanumeric+hyphen.
    const tagResult = await ctx.lazy(['tag', taskId, '[Onboarding]']);
    expectSuccess(tagResult);
    expectOutput(tagResult, '#onboarding');

    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    expectOutput(show, 'Tags:');
    expectOutput(show, '#onboarding');
  });

  test('a task can carry multiple tags', async () => {
    const taskId = await createTask(ctx, 'Multi-tag test');

    expectSuccess(await ctx.lazy(['tag', taskId, 'onboarding', 'launch', 'infra']));

    const show = await ctx.lazy(['show', taskId]);
    expectOutput(show, '#onboarding');
    expectOutput(show, '#launch');
    expectOutput(show, '#infra');
  });

  test('--tag at create time assigns tags', async () => {
    const result = await ctx.lazy(['create', '--goal', 'Created with tags', '--tag', 'onboarding', '--tag', 'launch']);
    expectSuccess(result);
    const match = result.stdout.match(/Created task ([0-9a-f]{8})/);
    if (!match) throw new Error(`Could not extract task id from: ${result.stdout}`);
    const taskId = match[1];

    const show = await ctx.lazy(['show', taskId]);
    expectOutput(show, '#onboarding');
    expectOutput(show, '#launch');
  });

  // INVARIANT: re-tagging an existing tag is a no-op — the Tag History shows a
  // single 'tagged' event, not two.
  test('tagging is idempotent (no duplicate history event)', async () => {
    const taskId = await createTask(ctx, 'Idempotent tag test');

    expectSuccess(await ctx.lazy(['tag', taskId, 'onboarding']));
    expectSuccess(await ctx.lazy(['tag', taskId, 'onboarding']));

    const show = await ctx.lazy(['show', taskId]);
    // Header count reflects total history events — exactly one tag event.
    expectOutput(show, 'Tag History (1)');
  });

  // INVARIANT: History is append-only. Untagging appends an 'untag' event; the
  // 'tag' event remains visible in the history.
  test('untagging appends history but does not erase the tag event', async () => {
    const taskId = await createTask(ctx, 'Untag history test');

    expectSuccess(await ctx.lazy(['tag', taskId, 'onboarding']));
    expectSuccess(await ctx.lazy(['untag', taskId, 'onboarding']));

    const show = await ctx.lazy(['show', taskId]);
    expectSuccess(show);
    // Both events survive in the append-only history.
    expectOutput(show, 'Tag History (2)');
    expectOutput(show, 'tagged');
    expectOutput(show, 'untagged');
    // The task no longer carries the current tag (no "Tags:" line printed).
    expectOutputExcludes(show, 'Tags:');
  });

  // INVARIANT: CLI channel → actor='human' (rendered as "by human" in history).
  test('tag from CLI attributes the history event to the human actor', async () => {
    const taskId = await createTask(ctx, 'CLI actor test');

    expectSuccess(await ctx.lazy(['tag', taskId, 'onboarding']));

    const show = await ctx.lazy(['show', taskId]);
    expectOutput(show, 'Tag History');
    expectOutput(show, 'by human');
  });

  // INVARIANT: The MCP channel sets actor='builder' (simulated here via the same
  // LAZY_ACTOR=builder env var the real MCP handler relies on through getActor();
  // mcp-tag.test.ts exercises the real MCP tool end-to-end).
  test('tag with LAZY_ACTOR=builder attributes the history event to the builder actor', async () => {
    const taskId = await createTask(ctx, 'Builder actor test');

    expectSuccess(await ctx.lazy(['tag', taskId, 'onboarding'], { env: { LAZY_ACTOR: 'builder' } }));

    const show = await ctx.lazy(['show', taskId]);
    expectOutput(show, 'Tag History');
    expectOutput(show, 'by builder');
  });

  test('lazy list --tag filters to tasks carrying the tag', async () => {
    const tagged = await createTask(ctx, 'Belongs to onboarding');
    await createTask(ctx, 'Unrelated work');
    expectSuccess(await ctx.lazy(['tag', tagged, 'onboarding']));

    const listed = await ctx.lazy(['list', '--tag', 'onboarding']);
    expectSuccess(listed);
    expectOutput(listed, 'Belongs to onboarding');
    expectOutputExcludes(listed, 'Unrelated work');
  });

  test('lazy search tag: field filter finds tagged tasks', async () => {
    const tagged = await createTask(ctx, 'Searchable tagged task');
    await createTask(ctx, 'Not tagged task');
    expectSuccess(await ctx.lazy(['tag', tagged, 'launch']));

    const search = await ctx.lazy(['search', 'tag:launch']);
    expectSuccess(search);
    expectOutput(search, 'Searchable tagged task');
    expectOutputExcludes(search, 'Not tagged task');
  });
});
