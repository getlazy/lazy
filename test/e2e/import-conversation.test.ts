/**
 * e2e: `lazy import-conversation` — the unified conversation-import surface.
 *
 * The command now shares the SAME multi-root discovery as the built-in recovery
 * (`lazy doctor --reimport-conversations`): it scans the shared
 * `~/.claude/projects` dir AND the per-builder isolation dirs, deduped to the
 * best copy of each session. These tests seed a session that lives ONLY in an
 * isolation dir — the exact gap the old shared-dir-only command couldn't cover
 * (see follow-up 6fef4eab on add-conversation-reimport) — and assert it can be
 * imported both in bulk and by session-id.
 *
 * INVARIANT: bulk import never writes silently — a non-TTY without `--yes`
 * previews and stops. Per-session import (an explicit session-id) writes
 * directly. Both go through the daemon-owned store; withDaemon exercises the
 * real RPC write path.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { encodeProjectPath } from '../../src/import/claude-code-logs';

/**
 * Write a builder session JSONL into a per-builder isolation dir:
 *   <root>/.lazy/builder-projects/<builderId>/<encoded-cwd>/<sessionId>.jsonl
 * This mirrors a session that only ever lived in an isolation dir — invisible
 * to the old shared-dir-only import.
 */
async function seedIsolationSession(
  root: string,
  builderId: string,
  sessionId: string,
  turns: Array<{ user: string; assistant: string }>,
): Promise<void> {
  const encoded = encodeProjectPath(root);
  const dir = join(root, '.lazy', 'builder-projects', builderId, encoded);
  await mkdir(dir, { recursive: true });

  const lines: string[] = [];
  turns.forEach((t, i) => {
    lines.push(JSON.stringify({
      type: 'user',
      uuid: `${sessionId}-u${i}`,
      parentUuid: i > 0 ? `${sessionId}-a${i - 1}` : null,
      timestamp: `2026-07-12T10:0${i}:00Z`,
      sessionId,
      cwd: root,
      version: '1.0.0',
      gitBranch: 'main',
      message: { role: 'user', content: t.user },
    }));
    lines.push(JSON.stringify({
      type: 'assistant',
      uuid: `${sessionId}-a${i}`,
      parentUuid: `${sessionId}-u${i}`,
      timestamp: `2026-07-12T10:0${i}:05Z`,
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
}

describe('lazy import-conversation (unified surface)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('bulk --yes imports isolation-dir sessions and is idempotent', async () => {
    await seedIsolationSession(ctx.root, 'builderA', '11111111-2222-3333-4444-555555555555', [
      { user: 'How do we unify import?', assistant: 'One surface, multi-root discovery.' },
    ]);
    await seedIsolationSession(ctx.root, 'builderB', '66666666-7777-8888-9999-aaaaaaaaaaaa', [
      { user: 'Does it see isolation dirs?', assistant: 'Yes — same discovery as recovery.' },
    ]);

    const first = await ctx.lazy(['import-conversation', '--yes']);
    expectSuccess(first);
    expectOutput(first, 'Imported 11111111');
    expectOutput(first, 'Imported 66666666');
    expectOutput(first, '2 imported');

    // Now in the store.
    const list = await ctx.lazy(['builder', 'list']);
    expectSuccess(list);
    expectOutput(list, '2 captured conversation(s)');
    expectOutput(list, 'How do we unify import?');

    // Second run imports nothing new (idempotent).
    const second = await ctx.lazy(['import-conversation', '--yes']);
    expectSuccess(second);
    expectOutput(second, 'already up to date');
  });

  test('imports a single session that only lives in an isolation dir (by id)', async () => {
    await seedIsolationSession(ctx.root, 'builderA', 'abcdef01-2222-3333-4444-555555555555', [
      { user: 'Import me by id', assistant: 'Done — parsed from the isolation dir.' },
    ]);

    const result = await ctx.lazy(['import-conversation', 'abcdef01']);
    expectSuccess(result);
    expectOutput(result, 'Imported abcdef01');

    const list = await ctx.lazy(['builder', 'list']);
    expectOutput(list, 'abcdef01');
    expectOutput(list, 'Import me by id');
  });

  test('--list surfaces isolation-dir sessions as importable', async () => {
    await seedIsolationSession(ctx.root, 'builderA', '12341234-2222-3333-4444-555555555555', [
      { user: 'List me', assistant: 'Listed.' },
    ]);

    const result = await ctx.lazy(['import-conversation', '--list']);
    expectSuccess(result);
    expectOutput(result, '12341234');
    expectOutput(result, '[new]');
  });

  test('bulk without --yes on a non-TTY previews but never writes', async () => {
    await seedIsolationSession(ctx.root, 'builderA', '99999999-2222-3333-4444-555555555555', [
      { user: 'Should I be written?', assistant: 'Not without confirmation.' },
    ]);

    const preview = await ctx.lazy(['import-conversation']);
    expectSuccess(preview);
    expectOutput(preview, '1 missing from the store');
    expectOutput(preview, '--yes');
    // No silent write.
    expectOutputExcludes(preview, 'Imported 99999999');

    const list = await ctx.lazy(['builder', 'list']);
    expectOutput(list, 'No captured builder conversations yet');
  });

  test('reports nothing to import when no sessions on disk', async () => {
    const result = await ctx.lazy(['import-conversation']);
    expectSuccess(result);
    expectOutput(result, 'No Claude Code sessions found');
  });
});
