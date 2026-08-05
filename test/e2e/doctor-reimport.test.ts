/**
 * e2e: `lazy doctor --reimport-conversations` — built-in recovery of builder
 * conversations whose raw Claude JSONL is on disk (in a per-builder isolation
 * dir) but never reached the store, plus the doctor detection warning.
 *
 * INVARIANT: recovery is idempotent (safe to run repeatedly) and persists
 * through the daemon-owned store. These sessions are the builder's long-term
 * memory — a regression that double-imports or silently drops them loses history.
 * Uses withDaemon so the write path exercises the real daemon RPC storage,
 * matching how import-conversation / capture actually persist.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, utimes } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import { markMachineOneshotPrompt } from '../../src/import/machine-oneshot';

/**
 * Write a builder session JSONL into a per-builder isolation dir:
 *   <root>/.lazy/builder-projects/<builderId>/<encoded-cwd>/<sessionId>.jsonl
 * This mirrors where the capture bug left conversations stranded on the host.
 */
async function seedIsolationSession(
  root: string,
  builderId: string,
  sessionId: string,
  turns: Array<{ user: string; assistant: string }>,
  /** Force the JSONL's mtime — that is how doctor tells capture rot from history. */
  mtimeMs?: number,
  /**
   * Write it as one of lazy's own machine-generated `claude -p` housekeeping
   * runs (fidelity summary / report / memory compaction) by stamping the first
   * prompt with the one-shot marker, exactly as runClaudeOneshot does.
   */
  opts: { machineOneshot?: boolean } = {},
): Promise<void> {
  const encoded = encodeProjectPath(root);
  const dir = join(root, '.lazy', 'builder-projects', builderId, encoded);
  await mkdir(dir, { recursive: true });

  const lines: string[] = [];
  turns.forEach((t, i) => {
    const content = opts.machineOneshot && i === 0 ? markMachineOneshotPrompt(t.user) : t.user;
    lines.push(JSON.stringify({
      type: 'user',
      uuid: `${sessionId}-u${i}`,
      parentUuid: i > 0 ? `${sessionId}-a${i - 1}` : null,
      timestamp: `2026-07-12T10:0${i}:00Z`,
      sessionId,
      cwd: root,
      version: '1.0.0',
      gitBranch: 'main',
      message: { role: 'user', content },
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

  const file = join(dir, `${sessionId}.jsonl`);
  await writeFile(file, lines.join('\n') + '\n', 'utf-8');
  if (mtimeMs !== undefined) {
    const when = new Date(mtimeMs);
    await utimes(file, when, when);
  }
}

describe('lazy doctor --reimport-conversations', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('recovers stranded builder conversations and is idempotent', async () => {
    await seedIsolationSession(ctx.root, 'builderA', '11111111-2222-3333-4444-555555555555', [
      { user: 'How do we recover lost conversations?', assistant: 'Re-import them from the projects dirs.' },
      { user: 'Is it idempotent?', assistant: 'Yes — already-stored sessions are skipped.' },
    ]);
    await seedIsolationSession(ctx.root, 'builderB', '66666666-7777-8888-9999-aaaaaaaaaaaa', [
      { user: 'What about the shared dir?', assistant: 'It is scanned too.' },
    ]);

    // First recovery run imports both.
    const first = await ctx.lazy(['doctor', '--reimport-conversations', '--yes']);
    expectSuccess(first);
    expectOutput(first, 'Imported 11111111');
    expectOutput(first, 'Imported 66666666');
    expectOutput(first, '2 imported');

    // They are now in the store.
    const list = await ctx.lazy(['builder', 'list']);
    expectSuccess(list);
    expectOutput(list, '2 captured conversation(s)');
    expectOutput(list, '11111111');
    expectOutput(list, '66666666');
    expectOutput(list, 'How do we recover lost conversations?');

    // Second run is a no-op — nothing new imported (idempotent).
    const second = await ctx.lazy(['doctor', '--reimport-conversations', '--yes']);
    expectSuccess(second);
    expectOutput(second, 'already up to date');
  });

  test('reports nothing to recover when no sessions on disk', async () => {
    const result = await ctx.lazy(['doctor', '--reimport-conversations', '--yes']);
    expectSuccess(result);
    expectOutput(result, 'No Claude Code sessions found');
  });

  // INVARIANT: recovery must not resurrect the housekeeping runs the sweep
  // deliberately skips, or every `--reimport-conversations` would undo the fix.
  test('recovery skips machine-generated one-shots and imports the real session', async () => {
    await seedIsolationSession(
      ctx.root,
      'builderA',
      'aaaa1111-2222-3333-4444-555555555555',
      [{ user: 'You are writing the description that will land...', assistant: 'Adds a thing.' }],
      undefined,
      { machineOneshot: true },
    );
    await seedIsolationSession(ctx.root, 'builderA', 'bbbb2222-2222-3333-4444-555555555555', [
      { user: 'A real question from a human', assistant: 'A real answer.' },
    ]);

    const result = await ctx.lazy(['doctor', '--reimport-conversations', '--yes']);
    expectSuccess(result);
    expectOutput(result, 'Imported bbbb2222');
    expectOutput(result, '1 imported');
    expectOutputExcludes(result, 'Imported aaaa1111');
    expectOutput(result, 'ignored 1 machine-generated lazy one-shot');

    // And it never reaches the conversation list either.
    const list = await ctx.lazy(['builder', 'list']);
    expectSuccess(list);
    expectOutput(list, '1 captured conversation(s)');
    expectOutputExcludes(list, 'aaaa1111');
  });
});

// The detection warning in the full `lazy doctor` sweep needs no daemon — the
// read-only check falls back to a direct store handle. Run it in the fast
// (non-daemon) mode so the whole health sweep doesn't race the test timeout.
describe('lazy doctor detects recoverable conversations', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  const DAY_MS = 24 * 60 * 60_000;

  test('health check warns about OLD conversations on disk but not in the store', async () => {
    await seedIsolationSession(
      ctx.root,
      'builderA',
      '77777777-2222-3333-4444-555555555555',
      [{ user: 'Surface me in doctor', assistant: 'You are recoverable.' }],
      Date.now() - 7 * DAY_MS,
    );

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'missing from the store');
    expectOutput(result, 'lazy doctor --reimport-conversations');
  });

  // INVARIANT: a RECENT uncaptured session means live capture is broken NOW, and
  // that must FAIL the health check, not warn. Capture has rotted silently twice
  // — a warning is exactly what let it go unnoticed for months both times.
  test('health check FAILS when a recent conversation never reached the store', async () => {
    await seedIsolationSession(
      ctx.root,
      'builderA',
      '88888888-2222-3333-4444-555555555555',
      [{ user: 'I was written an hour ago', assistant: 'And nobody captured me.' }],
      Date.now() - 60 * 60_000,
    );

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'live capture is not running');
    expectOutput(result, 'lazy doctor --reimport-conversations');
  });

  // A session written seconds ago may simply be mid-write, or waiting for the
  // daemon's next sweep tick. Calling that rot would make doctor cry wolf.
  test('a just-written conversation is in flight, not a failure', async () => {
    await seedIsolationSession(ctx.root, 'builderA', '99999999-2222-3333-4444-555555555555', [
      { user: 'I was written just now', assistant: 'Give the sweep a moment.' },
    ]);

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'All conversations captured');
  });

  test('no warning when there are no recoverable conversations', async () => {
    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'All conversations captured');
  });

  /**
   * INVARIANT: sessions capture deliberately SKIPS must never count as
   * uncaptured. lazy writes a machine-generated `claude -p` one-shot (fidelity
   * summary) on every single accept, so if these counted, the capture-rot check
   * would go red minutes after every accept and stay red — crying wolf forever
   * about the one thing working as designed.
   */
  test('a recent machine-generated one-shot does NOT trip the capture-rot check', async () => {
    // Recent AND settled — the exact window that would otherwise be called rot.
    await seedIsolationSession(
      ctx.root,
      'builderA',
      '5a5a5a5a-2222-3333-4444-555555555555',
      [{ user: 'unused', assistant: 'unused' }],
      Date.now() - 60 * 60_000,
      { machineOneshot: true },
    );

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'All conversations captured');
    expectOutputExcludes(result, 'live capture is not running');
    expectOutputExcludes(result, 'missing from the store');
  });

  test('a one-shot does not hide a real uncaptured conversation next to it', async () => {
    await seedIsolationSession(
      ctx.root,
      'builderA',
      '6b6b6b6b-2222-3333-4444-555555555555',
      [{ user: 'unused', assistant: 'unused' }],
      Date.now() - 60 * 60_000,
      { machineOneshot: true },
    );
    await seedIsolationSession(
      ctx.root,
      'builderA',
      '7c7c7c7c-2222-3333-4444-555555555555',
      [{ user: 'I am a real conversation', assistant: 'And nobody captured me.' }],
      Date.now() - 60 * 60_000,
    );

    const result = await ctx.lazy(['doctor']);
    expectOutput(result, 'live capture is not running');
  });
});
