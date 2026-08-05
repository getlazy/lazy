/**
 * e2e: `lazy doctor --purge-housekeeping-conversations` — the one-time cleanup
 * of machine-generated `claude -p` one-shots captured BEFORE lazy started
 * excluding them at the source.
 *
 * INVARIANT: without --yes nothing is deleted, ever. The command's whole safety
 * story is "a human reads the classified list first" — a regression that
 * deletes on a preview run destroys history lazy cannot restore.
 *
 * Uses withDaemon so deletion goes through the real daemon RPC storage route
 * (RemoteStorage.deleteConversation), which is how a real purge persists.
 */

import { describe, test, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, expectOutput, expectOutputExcludes } from '../helpers/assertions';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import fidelityPrompt from '../../src/prompts/fidelity-summary.md' with { type: 'text' };

/**
 * A stored fidelity-summary one-shot as it looked BEFORE the source-side marker
 * existed: the real prompt text, no marker. This is exactly what the ~83% of
 * the live store looks like, and the only thing that identifies it.
 */
function preMarkerFidelityPrompt(goal: string): string {
  return fidelityPrompt
    .replace('{{goal}}', goal)
    .replace('{{prompt}}', 'Do the thing')
    .replace('{{bundle}}', '### Turns (1)\n- [human]: do the thing');
}

/**
 * Seed a session JSONL in a per-builder isolation dir so the ordinary
 * `--reimport-conversations` path puts it in the store — the purge then runs
 * against genuinely stored conversations, not hand-written store files.
 */
async function seedSession(
  root: string,
  sessionId: string,
  turns: Array<{ user: string; assistant: string }>,
): Promise<void> {
  const dir = join(root, '.lazy', 'builder-projects', 'builderA', encodeProjectPath(root));
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

const HOUSEKEEPING_ID = 'aaaa1111-2222-3333-4444-555555555555';
const REAL_ID = 'bbbb2222-2222-3333-4444-555555555555';
/** A real conversation that QUOTES the housekeeping prompt — must survive. */
const QUOTING_ID = 'cccc3333-2222-3333-4444-555555555555';

describe('lazy doctor --purge-housekeeping-conversations', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });

    await seedSession(ctx.root, HOUSEKEEPING_ID, [
      { user: preMarkerFidelityPrompt('Add a purge command'), assistant: 'Summary of the work.' },
    ]);
    await seedSession(ctx.root, REAL_ID, [
      { user: 'How do we purge old conversations?', assistant: 'With a doctor flag.' },
    ]);
    await seedSession(ctx.root, QUOTING_ID, [
      {
        user: `The old ones all begin with:\n"${preMarkerFidelityPrompt('Some task')}"\nWrite a classifier.`,
        assistant: 'On it.',
      },
    ]);

    // Get them into the store the ordinary way.
    expectSuccess(await ctx.lazy(['doctor', '--reimport-conversations', '--yes']));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a preview run must not touch the store. This is the single most
  // important behavior of the command.
  test('lists classified conversations and deletes NOTHING without --yes', async () => {
    const preview = await ctx.lazy(['doctor', '--purge-housekeeping-conversations']);
    expectSuccess(preview);
    expectOutput(preview, 'aaaa1111');
    expectOutput(preview, 'fidelity-summary');
    expectOutput(preview, 'Nothing was deleted');
    // The real conversations are not even listed.
    expectOutputExcludes(preview, 'bbbb2222');
    expectOutputExcludes(preview, 'cccc3333');

    // All three are still in the store.
    const list = await ctx.lazy(['builder', 'list']);
    expectSuccess(list);
    expectOutput(list, '3 captured conversation(s)');
  });

  test('deletes the housekeeping conversations with --yes and is idempotent', async () => {
    const purge = await ctx.lazy(['doctor', '--purge-housekeeping-conversations', '--yes']);
    expectSuccess(purge);
    expectOutput(purge, '1 deleted');
    expectOutput(purge, 'one-time cleanup');

    // The real conversations survive; the housekeeping one is gone.
    const list = await ctx.lazy(['builder', 'list']);
    expectSuccess(list);
    expectOutput(list, '2 captured conversation(s)');
    expectOutput(list, 'bbbb2222');
    expectOutput(list, 'cccc3333');
    expectOutputExcludes(list, 'aaaa1111');

    // Re-running finds nothing left to purge.
    const again = await ctx.lazy(['doctor', '--purge-housekeeping-conversations', '--yes']);
    expectSuccess(again);
    expectOutput(again, 'No machine-generated housekeeping conversations found');
  });

  // The purge classifies stored content; re-import classifies on-disk markers.
  // A pre-marker one-shot has no marker, so re-import WOULD bring it back —
  // that is a known, documented property, not a bug to paper over here.
  test('purging does not confuse the routine health sweep', async () => {
    expectSuccess(await ctx.lazy(['doctor', '--purge-housekeeping-conversations', '--yes']));
    const doctor = await ctx.lazy(['doctor']);
    // The sweep still runs end to end (exit code may be non-zero for unrelated
    // environment checks, so assert on content, not status).
    expectOutput(doctor, 'Data directory');
  });
});
