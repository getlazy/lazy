import { describe, test, expect } from 'bun:test';
import { renderPendingNotesPrompt } from '../../src/supervisor/pending-notes';

describe('pending-notes follow-up prompt', () => {
  // INVARIANT: a human's comment reaches the agent verbatim. String.replace
  // with a string replacement expands $$, $&, $` and $' — it must not.
  test('dollar patterns in comment text survive unchanged', () => {
    const notes = "run `echo $$` and it costs $'5 or $& $`\n";
    expect(renderPendingNotesPrompt(notes)).toContain(notes);
  });
});
