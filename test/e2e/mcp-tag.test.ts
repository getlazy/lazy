/**
 * E2E tests for the MCP tagging tools (lazy_tag / lazy_untag) driven for real
 * through the daemon, mirroring mcp-actor.test.ts.
 *
 * INVARIANT (channel, not source): a tag/untag arriving via the MCP boundary is
 * attributed to actor='builder' — set at the MCP boundary (MCP_ACTOR) and
 * threaded to the daemon so it records 'builder' rather than defaulting to
 * 'human'. The equivalent CLI command records 'human'. History is append-only.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { runMcpSession, mcpPayload as payload } from '../helpers/mcp-session';

describe('lazy_tag / lazy_untag (MCP channel)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    // The channel discriminator only matters through the daemon (the MCP process
    // hands the tag op to the daemon over RPC and the write happens there).
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: An MCP-originated tag/untag carries actor='builder' in the
  // append-only history, and lazy_show exposes both current tags and the
  // tag-history drill-down.
  test('lazy_tag then lazy_untag via MCP records builder-attributed history', async () => {
    const taskShortId = await createTask(ctx, 'MCP tag channel', 'Do the work');

    const responses = await runMcpSession(ctx.root, '', ctx.root, [
      { method: 'initialize', id: 1, params: {} },
      { method: 'tools/call', id: 2, params: { name: 'lazy_tag', arguments: { task_id: taskShortId, tag: 'Onboarding' } } },
      { method: 'tools/call', id: 3, params: { name: 'lazy_untag', arguments: { task_id: taskShortId, tag: 'onboarding' } } },
      { method: 'tools/call', id: 4, params: { name: 'lazy_show', arguments: { task_id: taskShortId, sections: ['tag-history'] } } },
    ]);

    // Tag call returns the normalized current tags.
    const tagResult = payload(responses.find(r => r.id === 2));
    expect(tagResult.tags).toEqual(['onboarding']);

    // Untag call returns empty tags.
    const untagResult = payload(responses.find(r => r.id === 3));
    expect(untagResult.tags).toEqual([]);

    // lazy_show exposes the append-only, builder-attributed tag history.
    const show = payload(responses.find(r => r.id === 4));
    expect(show.tags).toEqual([]);
    expect(show.tag_history_count).toBe(2);
    const history = show.tag_history as Array<{ tag: string; action: string; actor: string | null }>;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ tag: 'onboarding', action: 'tag', actor: 'builder' });
    expect(history[1]).toMatchObject({ tag: 'onboarding', action: 'untag', actor: 'builder' });
  });
});
