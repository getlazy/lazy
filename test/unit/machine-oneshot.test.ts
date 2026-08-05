/**
 * Unit tests for machine-generated one-shot marking and detection.
 *
 * INVARIANT: lazy's own `claude -p` housekeeping runs (PR/commit fidelity
 * summaries on every accept, `lazy report`, LLM memory compaction) are NEVER
 * captured as conversations. They made up the bulk of the store and drowned real
 * builder conversations in `lazy builder list` and search.
 *
 * INVARIANT: detection is a MARKER check, not a content heuristic. It matches
 * only lazy's own marker, and only where lazy puts it — as the first thing in
 * the session's first message content. A transcript or task prompt that merely
 * MENTIONS the marker (this file's own source, for instance) must still be
 * captured as a real conversation. Loosening this to a bare substring search
 * would silently make real conversations disappear.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ONESHOT_MARKER,
  markMachineOneshotPrompt,
  headHasOneshotMarker,
  isMachineOneshotSessionFile,
} from '../../src/import/machine-oneshot';

/** One JSONL line as Claude Code journals a `-p` prompt: content is a string. */
function userLine(content: string, cwd = '/repo/marked'): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd,
    sessionId: 'ffffffff-0000-0000-0000-000000000001',
    version: '2.0.0',
    gitBranch: 'main',
    type: 'user',
    message: { role: 'user', content },
  });
}

describe('machine one-shot marking', () => {
  test('the marker is prepended on its own line, leaving the prompt intact', () => {
    const marked = markMachineOneshotPrompt('Summarize this task.');
    expect(marked.startsWith(ONESHOT_MARKER + '\n')).toBe(true);
    expect(marked.endsWith('Summarize this task.')).toBe(true);
  });

  test('recognizes a marked prompt at the head of a JSONL', () => {
    const head = userLine(markMachineOneshotPrompt('You are writing the PR description...'));
    expect(headHasOneshotMarker(head)).toBe(true);
  });

  test('recognizes the array-of-blocks content shape too', () => {
    const head = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: markMachineOneshotPrompt('go') }] },
    });
    expect(headHasOneshotMarker(head)).toBe(true);
  });

  test('an unmarked conversation is not a one-shot', () => {
    expect(headHasOneshotMarker(userLine('Fix the failing test in src/foo.ts'))).toBe(false);
  });

  // INVARIANT: prose that MENTIONS the marker must not be misclassified. A
  // builder task about this very feature quotes the marker in its prompt; a bare
  // substring search would make that conversation vanish from the store.
  test('a conversation that merely mentions the marker is still captured', () => {
    const head = userLine(`Please explain what ${ONESHOT_MARKER} does in the codebase.`);
    expect(headHasOneshotMarker(head)).toBe(false);
  });
});

describe('isMachineOneshotSessionFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lazy-oneshot-marker-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function seed(name: string, body: string): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, body);
    return file;
  }

  test('true for a marked session file', async () => {
    const file = await seed('marked.jsonl', userLine(markMachineOneshotPrompt('summarize')) + '\n');
    expect(await isMachineOneshotSessionFile(file)).toBe(true);
  });

  test('false for a real conversation', async () => {
    const file = await seed('real.jsonl', userLine('what does this repo do?') + '\n');
    expect(await isMachineOneshotSessionFile(file)).toBe(false);
  });

  test('still true when the marked prompt is enormous (only the head is read)', async () => {
    // `lazy report`'s reduce prompt and a fidelity bundle are both huge, and the
    // whole prompt is ONE JSONL line. Detection must not depend on the line
    // fitting in the read window.
    const huge = markMachineOneshotPrompt('x'.repeat(200_000));
    const file = await seed('huge.jsonl', userLine(huge) + '\n');
    expect(await isMachineOneshotSessionFile(file)).toBe(true);
  });

  // A real conversation whose marker-mention happens to land far into the file
  // is beyond the head window anyway, but the near case is the one that matters.
  test('false when a long real prompt mentions the marker later on', async () => {
    const file = await seed(
      'mention.jsonl',
      userLine('a'.repeat(3000) + ONESHOT_MARKER) + '\n',
    );
    expect(await isMachineOneshotSessionFile(file)).toBe(false);
  });

  // Fallback direction matters: never lose a real conversation because a file
  // was momentarily unreadable. Unknown ⇒ treat as a conversation.
  test('a missing file is reported as NOT a one-shot (capture is the safe default)', async () => {
    expect(await isMachineOneshotSessionFile(join(dir, 'gone.jsonl'))).toBe(false);
  });

  test('an empty file is not a one-shot', async () => {
    const file = await seed('empty.jsonl', '');
    expect(await isMachineOneshotSessionFile(file)).toBe(false);
  });
});
