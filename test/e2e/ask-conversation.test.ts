/**
 * e2e: `lazy ask <conversation-id>` — ask-style Q&A against a stored conversation.
 *
 * `lazy ask` is polymorphic on its id, the same way `lazy show` is: a task id
 * asks the task's live agent, a conversation session id asks a throwaway
 * read-only agent that reads the stored transcript. These tests cover the
 * conversation half — resolution (exact/prefix/ambiguous/not-found), the single
 * pass, the map-reduce path for an oversized transcript, and the invariant that
 * matters most:
 *
 * INVARIANT: asking a conversation writes NOTHING. A conversation is immutable
 * history and an ask is a read of it — no turn, no comment, no new conversation.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess, expectFailure, expectOutput, expectError } from '../helpers/assertions';
import { encodeProjectPath } from '../../src/import/claude-code-logs';

/** Seed a builder session JSONL and import it into the store. */
async function seedConversation(
  ctx: TestContext,
  sessionId: string,
  turns: Array<{ user: string; assistant: string }>,
): Promise<void> {
  const encoded = encodeProjectPath(ctx.root);
  const dir = join(ctx.root, '.lazy', 'builder-projects', 'builderA', encoded);
  await mkdir(dir, { recursive: true });

  const lines: string[] = [];
  turns.forEach((t, i) => {
    const stamp = `2026-07-12T10:${String(i).padStart(2, '0')}:00Z`;
    lines.push(JSON.stringify({
      type: 'user',
      uuid: `${sessionId}-u${i}`,
      parentUuid: i > 0 ? `${sessionId}-a${i - 1}` : null,
      timestamp: stamp,
      sessionId,
      cwd: ctx.root,
      version: '1.0.0',
      gitBranch: 'main',
      message: { role: 'user', content: t.user },
    }));
    lines.push(JSON.stringify({
      type: 'assistant',
      uuid: `${sessionId}-a${i}`,
      parentUuid: `${sessionId}-u${i}`,
      timestamp: stamp,
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: t.assistant }],
        model: 'claude-opus-4-8',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }));
  });

  await writeFile(join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf-8');
  expectSuccess(await ctx.lazy(['import-conversation', sessionId]));
}

const RETENTION_SESSION = 'aaaa1111-2222-3333-4444-555555555555';

describe('lazy ask <conversation-id>', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('answers a question about a stored conversation and writes nothing', async () => {
    await seedConversation(ctx, RETENTION_SESSION, [
      { user: 'What should we do about retention?', assistant: 'Capture into lazy, never touch Claude Code settings.' },
    ]);

    const result = await ctx.lazyMocked(['ask', RETENTION_SESSION, '-m', 'what did we decide about retention?'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);
    // Single pass (small transcript), and the read-only lockdown was requested.
    expectOutput(result, '[conv-ask:single][ro]');
    expectOutput(result, 'what did we decide about retention?');

    // INVARIANT: nothing was written back. The conversation still has exactly
    // the messages it was imported with, and no second conversation appeared.
    const list = await ctx.lazy(['builder', 'list']);
    expectSuccess(list);
    expectOutput(list, '1 captured conversation(s)');
  });

  test('accepts a unique session-id prefix', async () => {
    await seedConversation(ctx, RETENTION_SESSION, [
      { user: 'Prefix me', assistant: 'Resolved by prefix.' },
    ]);

    const result = await ctx.lazyMocked(['ask', 'aaaa1111', '-m', 'anything?'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);
    expectOutput(result, '[conv-ask:single]');
  });

  test('refuses an ambiguous prefix instead of picking one', async () => {
    await seedConversation(ctx, 'bbbb1111-0000-0000-0000-000000000001', [
      { user: 'First', assistant: 'One.' },
    ]);
    await seedConversation(ctx, 'bbbb1111-0000-0000-0000-000000000002', [
      { user: 'Second', assistant: 'Two.' },
    ]);

    const result = await ctx.lazyMocked(['ask', 'bbbb1111-0000-0000-0000-00000000000', '-m', 'which one?'], MOCK_CLAUDE_SUCCESS);
    expectFailure(result);
    expectError(result, 'Multiple conversations match');
  });

  test('reports when neither a task nor a conversation matches', async () => {
    const result = await ctx.lazyMocked(['ask', 'deadbeef', '-m', 'anything?'], MOCK_CLAUDE_SUCCESS);
    expectFailure(result);
    expectError(result, 'No task or conversation found');
  });

  test('--json returns a structured conversation answer', async () => {
    await seedConversation(ctx, RETENTION_SESSION, [
      { user: 'Structured?', assistant: 'Yes.' },
    ]);

    const result = await ctx.lazyMocked(['ask', RETENTION_SESSION, '-m', 'structured?', '--json'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(result);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.type).toBe('conversation');
    expect(parsed.sessionId).toBe(RETENTION_SESSION);
    expect(parsed.chunks).toBe(1);
    expect(parsed.answer).toContain('[conv-ask:single]');
    expect(parsed.warnings).toEqual([]);
  });

  test('map-reduces an oversized transcript and reports excerpts that had nothing', async () => {
    // Three excerpts' worth of transcript: the chunker's budget is 96 KiB per
    // call, so ~40 KiB per message over 8 turns comfortably crosses it twice.
    const filler = 'x'.repeat(40_000);
    const turns = Array.from({ length: 8 }, (_, i) => ({
      user: `Question ${i}. ${filler}`,
      assistant: `Answer ${i}. ${filler}`,
    }));
    await seedConversation(ctx, 'cccc1111-2222-3333-4444-555555555555', turns);

    const result = await ctx.lazyMocked(
      ['ask', 'cccc1111', '-m', 'what happened?', '--json'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_CONV_ASK_IRRELEVANT: '2' } },
    );
    expectSuccess(result);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.chunks).toBeGreaterThan(1);
    // Excerpt 2 said NOTHING_RELEVANT, so it is not counted as relevant and its
    // marker never reaches the reduce pass.
    expect(parsed.relevantChunks).toBe(parsed.chunks - 1);
    expect(parsed.answer).toContain('[conv-ask:reduce]');
    expect(parsed.answer).toContain('[conv-ask:map:1]');
    expect(parsed.answer).not.toContain('[conv-ask:map:2]');
  }, 30_000);

  test('survives an excerpt that fails to read, and says so', async () => {
    const filler = 'y'.repeat(40_000);
    const turns = Array.from({ length: 8 }, (_, i) => ({
      // Mid-transcript on purpose: the first message becomes the stored
      // conversation's summary, which is rendered into EVERY excerpt prompt —
      // a sentinel there would fail every excerpt instead of just one.
      user: i === 3 ? `POISON ${filler}` : `Question ${i}. ${filler}`,
      assistant: `Answer ${i}. ${filler}`,
    }));
    await seedConversation(ctx, 'dddd1111-2222-3333-4444-555555555555', turns);

    const result = await ctx.lazyMocked(
      ['ask', 'dddd1111', '-m', 'what happened?', '--json'],
      MOCK_CLAUDE_SUCCESS,
      { env: { LAZY_MOCK_FAIL_KEYWORD: 'POISON' } },
    );
    expectSuccess(result);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.warnings.some((w: string) => w.includes('could not be read'))).toBe(true);
    expect(parsed.answer).toContain('[conv-ask:reduce]');
  }, 30_000);
});
