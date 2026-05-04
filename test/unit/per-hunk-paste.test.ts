import { describe, test, expect } from 'bun:test';
import { promptMultiLine, type Key, type RawSession } from '../../src/cli/tui/per-hunk-review';

// Drive promptMultiLine with a synthetic key stream. The fake RawSession lets
// us deliver keypresses one at a time and capture the resolved string.
function makeFakeSession(): { session: RawSession; emit: (k: Partial<Key>) => void } {
  let handler: ((k: Key) => void) | null = null;
  const session: RawSession = {
    onKey(h) { handler = h; },
    close() { handler = null; },
  };
  const emit = (k: Partial<Key>) => {
    handler?.({
      name: k.name ?? '',
      ctrl: k.ctrl ?? false,
      meta: k.meta ?? false,
      shift: k.shift ?? false,
      sequence: k.sequence ?? '',
    });
  };
  return { session, emit };
}

describe('promptMultiLine bracketed paste', () => {
  // INVARIANT: a CR delivered between the bracketed-paste start/end markers
  // is content (a row break), not submit. Without this guarantee, multi-line
  // pastes get truncated at the first newline — the original bug.
  test('treats CR inside bracketed paste as a row break, not submit', async () => {
    const { session, emit } = makeFakeSession();
    const resultP = promptMultiLine(session, 'test:');

    // Simulate the byte stream a terminal sends for a multi-line paste:
    //   ESC[200~ hello \r world ESC[201~
    // Then a plain Enter to submit.
    emit({ sequence: '\x1b[200~' });
    for (const ch of 'hello') emit({ name: ch, sequence: ch });
    emit({ name: 'return', sequence: '\r' });
    for (const ch of 'world') emit({ name: ch, sequence: ch });
    emit({ sequence: '\x1b[201~' });
    emit({ name: 'return', sequence: '\r' });

    const result = await resultP;
    expect(result).toBe('hello\nworld');
  });

  // INVARIANT: terminals that bundle the entire paste (markers + content)
  // into a single keypress event must behave identically to the split-event
  // shape. Both shapes are seen in the wild.
  test('handles whole paste arriving in a single sequence event', async () => {
    const { session, emit } = makeFakeSession();
    const resultP = promptMultiLine(session, 'test:');

    emit({ sequence: '\x1b[200~one\rtwo\rthree\x1b[201~' });
    emit({ name: 'return', sequence: '\r' });

    const result = await resultP;
    expect(result).toBe('one\ntwo\nthree');
  });

  // INVARIANT: a trailing CR flushed in the same bundled event as the paste
  // end marker is the user's Enter — honour it as submit, don't silently
  // append a row break and wait for another keystroke.
  test('bundled paste with trailing CR submits without an extra row break', async () => {
    const { session, emit } = makeFakeSession();
    const resultP = promptMultiLine(session, 'test:');

    emit({ sequence: '\x1b[200~hello\x1b[201~\r' });

    const result = await resultP;
    expect(result).toBe('hello');
  });

  // INVARIANT: the paste-content body may itself arrive as one large chunk
  // between separate start/end events. The `if (pasting)` branch must split
  // embedded CR/LF into row breaks, not drop them.
  test('handles bulk paste content delivered as one chunk between split markers', async () => {
    const { session, emit } = makeFakeSession();
    const resultP = promptMultiLine(session, 'test:');

    emit({ sequence: '\x1b[200~' });
    emit({ sequence: 'one\rtwo\rthree' });
    emit({ sequence: '\x1b[201~' });
    emit({ name: 'return', sequence: '\r' });

    const result = await resultP;
    expect(result).toBe('one\ntwo\nthree');
  });

  // INVARIANT: outside a paste, plain Enter still submits — the bracketed-
  // paste handling must not regress the normal interactive path.
  test('plain Enter outside a paste still submits', async () => {
    const { session, emit } = makeFakeSession();
    const resultP = promptMultiLine(session, 'test:');

    for (const ch of 'hi') emit({ name: ch, sequence: ch });
    emit({ name: 'return', sequence: '\r' });

    const result = await resultP;
    expect(result).toBe('hi');
  });

  // INVARIANT: Ctrl+C must always abort, even mid-paste. It's the safety
  // hatch — without it a malformed paste (no end marker arriving) would
  // strand the reviewer in raw mode.
  test('Ctrl+C aborts even mid-paste', async () => {
    const { session, emit } = makeFakeSession();
    const resultP = promptMultiLine(session, 'test:');

    emit({ sequence: '\x1b[200~' });
    for (const ch of 'partial') emit({ name: ch, sequence: ch });
    emit({ name: 'c', ctrl: true, sequence: '\x03' });

    await expect(resultP).rejects.toThrow('cancelled');
  });

  // INVARIANT: ESC bytes inside a bracketed paste are content, not cancel —
  // the end marker (ESC[201~) starts with ESC, so an Esc-cancels-mid-paste
  // policy would let the marker self-cancel and corrupt the editor state.
  // The literal ESC byte must survive into the resolved string.
  test('Esc inside a paste is literal content, not cancel', async () => {
    const { session, emit } = makeFakeSession();
    const resultP = promptMultiLine(session, 'test:');

    emit({ sequence: '\x1b[200~' });
    emit({ name: 'escape', sequence: '\x1b' });
    for (const ch of 'x') emit({ name: ch, sequence: ch });
    emit({ sequence: '\x1b[201~' });
    emit({ name: 'return', sequence: '\r' });

    const result = await resultP;
    expect(result).toBe('\x1bx');
  });
});
