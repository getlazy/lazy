import { describe, test, expect } from 'bun:test';
import {
  sanitizeControlChars,
  sanitizeUserText,
  sanitizationNote,
  findArgvIllegalIndices,
  assertArgvSafe,
  sanitizePromptForArgv,
  NUL_CHAR,
} from '../../src/utils/sanitize-text';

const NUL = NUL_CHAR;
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const DEL = String.fromCharCode(0x7f);

describe('sanitizeControlChars', () => {
  test('leaves ordinary text untouched (identity, no allocation surprises)', () => {
    const input = 'Please fix the parser.\n\nIt drops trailing\tcommas.\r\n';
    const r = sanitizeControlChars(input);
    expect(r.text).toBe(input);
    expect(r.replaced).toBe(0);
    expect(r.found).toEqual([]);
    expect(r.hadNul).toBe(false);
  });

  // INVARIANT: tab, LF and CR are legal in argv and meaningful in prose.
  // Escaping them would mangle every multi-line feedback message.
  test('preserves tab, newline and carriage return', () => {
    const input = 'a\tb\nc\r\nd';
    expect(sanitizeControlChars(input).text).toBe(input);
  });

  test('replaces NUL with its printable escape', () => {
    const r = sanitizeControlChars(`before${NUL}after`);
    expect(r.text).toBe('before\\u0000after');
    expect(r.replaced).toBe(1);
    expect(r.found).toEqual(['U+0000']);
    expect(r.hadNul).toBe(true);
  });

  test('replaces other non-printable controls (ESC, BEL, DEL, C1)', () => {
    const c1 = String.fromCharCode(0x9b);
    const r = sanitizeControlChars(`${ESC}${BEL}${DEL}${c1}`);
    expect(r.text).toBe('\\u001b\\u0007\\u007f\\u009b');
    expect(r.replaced).toBe(4);
    expect(r.hadNul).toBe(false);
  });

  test('counts every occurrence but reports distinct code points, sorted', () => {
    const r = sanitizeControlChars(`${ESC}x${NUL}y${NUL}z${ESC}`);
    expect(r.replaced).toBe(4);
    expect(r.found).toEqual(['U+0000', 'U+001B']);
  });

  // INVARIANT: the sanitizer must not be stateful across calls. A module-level
  // global regex used with `.test()` carries lastIndex between invocations and
  // would intermittently miss NULs — the exact failure mode we cannot afford.
  test('is stateless across repeated calls', () => {
    for (let i = 0; i < 5; i++) {
      const r = sanitizeControlChars(`x${NUL}y`);
      expect(r.text).toBe('x\\u0000y');
      expect(r.replaced).toBe(1);
    }
  });

  test('output of the sanitizer is itself clean (re-running is a no-op)', () => {
    const once = sanitizeControlChars(`a${NUL}b${ESC}c`).text;
    const twice = sanitizeControlChars(once);
    expect(twice.replaced).toBe(0);
    expect(twice.text).toBe(once);
  });

  test('handles the empty string', () => {
    const r = sanitizeControlChars('');
    expect(r.text).toBe('');
    expect(r.replaced).toBe(0);
  });

  // INVARIANT: sanitizing must never DROP content. The bytes around the
  // offending character have to survive verbatim — that is the whole reason
  // we escape rather than strip.
  test('never loses surrounding content', () => {
    const r = sanitizeControlChars(`keep-me${NUL}and-me-too`);
    expect(r.text).toContain('keep-me');
    expect(r.text).toContain('and-me-too');
  });
});

describe('sanitizeUserText', () => {
  test('returns the input unchanged when nothing needs sanitizing', () => {
    const input = 'normal feedback';
    expect(sanitizeUserText(input)).toBe(input);
  });

  test('annotates by default so the substitution is visible, not silent', () => {
    const out = sanitizeUserText(`bad${NUL}text`);
    expect(out).toContain('bad\\u0000text');
    expect(out).toContain('lazy sanitized 1 non-printable control character');
    expect(out).toContain('U+0000');
  });

  test('annotate:false escapes without the explanatory note', () => {
    const out = sanitizeUserText(`bad${NUL}text`, { annotate: false });
    expect(out).toBe('bad\\u0000text');
  });

  // INVARIANT: whatever we hand downstream must be argv-legal. This is the
  // property the whole module exists to guarantee.
  test('output is always free of NUL', () => {
    const out = sanitizeUserText(`a${NUL}b${NUL}c`);
    expect(out.includes(NUL)).toBe(false);
  });
});

describe('sanitizationNote', () => {
  test('uses singular/plural correctly', () => {
    expect(sanitizationNote(sanitizeControlChars(`a${NUL}`))).toContain('1 non-printable control character ');
    expect(sanitizationNote(sanitizeControlChars(`a${NUL}${NUL}`))).toContain('2 non-printable control characters ');
  });
});

describe('findArgvIllegalIndices / assertArgvSafe', () => {
  test('clean argv passes', () => {
    const args = ['claude', '-p', 'hello', '--output-format', 'json'];
    expect(findArgvIllegalIndices(args)).toEqual([]);
    expect(() => assertArgvSafe(args)).not.toThrow();
  });

  // INVARIANT: only NUL is illegal in argv. Escape sequences and other control
  // characters spawn fine, and rejecting them here would fail turns needlessly.
  test('non-NUL control characters are NOT argv-illegal', () => {
    expect(findArgvIllegalIndices(['claude', '-p', `x${ESC}y`])).toEqual([]);
  });

  test('reports every offending index', () => {
    expect(findArgvIllegalIndices(['claude', `-p${NUL}`, `body${NUL}`])).toEqual([1, 2]);
  });

  test('assertArgvSafe throws an actionable error naming the position and the fix', () => {
    let err: Error | undefined;
    try {
      assertArgvSafe(['claude', '-p', `feedback${NUL}here`], 'the agent work phase');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('args[2]');
    expect(err!.message).toContain('NUL byte');
    expect(err!.message).toContain('the agent work phase');
    expect(err!.message).toContain('sanitizeUserText');
  });
});

describe('sanitizePromptForArgv', () => {
  test('passes clean prompts through untouched and does not notify', () => {
    let notified = false;
    const out = sanitizePromptForArgv('clean prompt', () => { notified = true; });
    expect(out).toBe('clean prompt');
    expect(notified).toBe(false);
  });

  // INVARIANT: the delivery seam SANITIZES rather than failing. Failing here
  // would re-create the crash loop that swallowed the human's feedback.
  test('sanitizes and notifies rather than throwing', () => {
    let seen: { replaced: number } | undefined;
    const out = sanitizePromptForArgv(`please fix${NUL}this`, (r) => { seen = r; });
    expect(out.includes(NUL)).toBe(false);
    expect(out).toContain('please fix\\u0000this');
    expect(seen?.replaced).toBe(1);
  });

  test('its output survives assertArgvSafe', () => {
    const out = sanitizePromptForArgv(`a${NUL}b`);
    expect(() => assertArgvSafe(['claude', '-p', out])).not.toThrow();
  });
});
