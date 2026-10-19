import { describe, test, expect } from 'bun:test';
import { findHiddenCharacters, describeHiddenCharacters } from '../../src/daemon/dockerfile-characters';

describe('findHiddenCharacters', () => {
  test('an ordinary Dockerfile, tabs and CRLF included, has none', () => {
    expect(findHiddenCharacters('FROM alpine\r\nRUN\techo hi\n')).toEqual([]);
  });

  // INVARIANT: every class of character that makes a file read differently
  // from its bytes is found — bidi, zero-width, C0/C1 controls, invalid UTF-8.
  test('each hidden class is found with its position', () => {
    const found = findHiddenCharacters('a\u2067b\nc\u200Bd\u0007\u0085\re\uFFFD');
    expect(found.map((f) => [f.line, f.column, f.codepoint, f.kind])).toEqual([
      [1, 2, 'U+2067', 'bidi'],
      [2, 2, 'U+200B', 'invisible'],
      [2, 4, 'U+0007', 'control'],
      [2, 5, 'U+0085', 'control'],
      [2, 6, 'U+000D', 'control'],
      [2, 8, 'U+FFFD', 'invalid-utf8'],
    ]);
  });

  // INVARIANT: the astral invisibles (Unicode tag characters, the "ASCII
  // smuggling" vector; supplementary variation selectors) are found too, and a
  // non-ASCII space — which a shell does not split on — is flagged.
  test('tag characters, variation selectors, Hangul fillers and space lookalikes are found', () => {
    const found = findHiddenCharacters('a\u{E0041}b\u{E0100}c\uFE0Fd\u3164e\u00A0f');
    expect(found.map((f) => [f.column, f.codepoint, f.kind])).toEqual([
      [2, 'U+E0041', 'invisible'],
      [4, 'U+E0100', 'invisible'],
      [6, 'U+FE0F', 'invisible'],
      [8, 'U+3164', 'invisible'],
      [10, 'U+00A0', 'space'],
    ]);
  });

  test('the refusal names where they are', () => {
    const msg = describeHiddenCharacters(findHiddenCharacters('x\u202Ey'), 'Dockerfile.lazy');
    expect(msg).toContain('Dockerfile.lazy');
    expect(msg).toContain('line 1 column 2: a text-direction control (U+202E)');
  });
});
