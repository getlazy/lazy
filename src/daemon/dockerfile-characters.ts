/**
 * Characters a person cannot see, or that reorder what they see, in a file
 * they are asked to approve. An adopted Dockerfile runs in every container of
 * the project, so the admin's consent must be to the bytes that will build:
 * bidi controls ("Trojan Source") can make a line read differently from how it
 * executes, zero-width and control characters hide text, and invalid UTF-8
 * renders as a replacement glyph that says nothing about the real bytes.
 *
 * Tab, newline and a carriage return directly before a newline (a CRLF file)
 * are ordinary and allowed.
 */

export type HiddenCharacterKind = 'bidi' | 'control' | 'invisible' | 'space' | 'invalid-utf8';

export interface HiddenCharacter {
  /** 1-based line number. */
  line: number;
  /** 1-based column, counted in code points. */
  column: number;
  /** `U+XXXX` (for invalid UTF-8, the replacement character it decoded to). */
  codepoint: string;
  kind: HiddenCharacterKind;
}

// Keep these sets identical to lazy-teams' VisibleText. The \`u\` flag is what
// lets a range match the astral tag characters and variation selectors.
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const INVISIBLE = /[\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200D\u2028\u2029\u2060-\u2064\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
// Look like a space, but a shell does not split on them.
const SPACE_LOOKALIKE = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/u;
// C0 (minus tab/newline; CR is handled separately), DEL, C1.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function classify(ch: string, next: string | undefined): HiddenCharacterKind | null {
  if (ch === '\r') return next === '\n' ? null : 'control';
  if (BIDI.test(ch)) return 'bidi';
  if (INVISIBLE.test(ch)) return 'invisible';
  if (SPACE_LOOKALIKE.test(ch)) return 'space';
  if (CONTROL.test(ch)) return 'control';
  if (ch === '\uFFFD') return 'invalid-utf8';
  return null;
}

/** Every hidden or reordering character in `content`, in file order. */
export function findHiddenCharacters(content: string): HiddenCharacter[] {
  const found: HiddenCharacter[] = [];
  const chars = Array.from(content);
  let line = 1;
  let column = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\n') { line++; column = 0; continue; }
    column++;
    const kind = classify(ch, chars[i + 1]);
    if (kind) {
      const cp = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
      found.push({ line, column, codepoint: `U+${cp}`, kind });
    }
  }
  return found;
}

const KIND_WORDS: Record<HiddenCharacterKind, string> = {
  bidi: 'a text-direction control',
  control: 'a control character',
  invisible: 'an invisible character',
  space: 'a character that looks like a space but is not one',
  'invalid-utf8': 'bytes that are not valid UTF-8',
};

/** One sentence naming where the first few are, for a refusal. */
export function describeHiddenCharacters(found: HiddenCharacter[], file: string): string {
  const shown = found.slice(0, 5).map((f) => `line ${f.line} column ${f.column}: ${KIND_WORDS[f.kind]} (${f.codepoint})`);
  const more = found.length > shown.length ? `, and ${found.length - shown.length} more` : '';
  return `${file} contains characters that display differently from what would build — ${shown.join('; ')}${more}. ` +
    'Remove them and commit again before adopting it.';
}
