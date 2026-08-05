/**
 * Sanitization of human/agent-authored text at system boundaries.
 *
 * WHY THIS EXISTS
 *
 * Every prompt lazy sends to an agent is passed as an *argv element*
 * (`claude -p <prompt>`). POSIX argv strings are NUL-terminated, so a raw NUL
 * byte anywhere in the prompt makes the spawn fail before the process even
 * starts:
 *
 *     The argument 'args[2]' must be a string without null bytes.
 *
 * That failure is instant, so the work phase retries, fails instantly again,
 * and trips crash-loop detection. The turn is lost — and because auto-resume
 * restarts the agent with a *generic* resume prompt rather than the original
 * feedback, the human's feedback is silently never delivered. That directly
 * violates the never-lose-human-feedback invariant.
 *
 * POLICY: SANITIZE AND DELIVER, never reject.
 *
 * Rejecting at intake would be the easier fix, but it throws the feedback away
 * at exactly the moment the human has finished typing it. Instead we replace
 * each offending character with its printable escape (the four-character
 * sequence backslash-u-0-0-0-0 for NUL, and so on) so the text stays readable,
 * stays complete, and becomes argv-legal. The human's intent survives; only
 * the byte encoding changes.
 *
 * Tab (U+0009), newline (U+000A) and carriage return (U+000D) are legal in
 * argv and meaningful in prose, so they are preserved verbatim.
 */

/** A literal NUL, built without embedding a raw control byte in this source. */
export const NUL_CHAR = String.fromCharCode(0);

/**
 * Matches C0 controls (except tab/LF/CR), DEL, and C1 controls.
 * None of these are printable; NUL is additionally illegal in argv.
 *
 * Built via RegExp so this file contains no raw control bytes of its own —
 * a source file with an embedded NUL is exactly the hazard we are fixing.
 */
const OFFENDING_CONTROL_CHARS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]',
  'g',
);

export interface SanitizeResult {
  /** The sanitized text — safe to persist, prompt with, and pass as argv. */
  text: string;
  /** How many characters were replaced. */
  replaced: number;
  /**
   * The distinct code points that were replaced, as `U+XXXX` labels, in
   * ascending order. Empty when nothing was replaced.
   */
  found: string[];
  /** Whether the text contained a NUL (the argv-fatal case specifically). */
  hadNul: boolean;
}

/** Render a code point as the printable escape we substitute into the text. */
function escapeFor(code: number): string {
  return '\\u' + code.toString(16).padStart(4, '0');
}

/** Render a code point as the `U+00XX` label used in human-facing notes. */
function labelFor(code: number): string {
  return 'U+' + code.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Replace non-printable control characters with printable escape sequences.
 *
 * Pure. The output contains no control characters other than tab/LF/CR, so
 * re-running it on its own output is a no-op.
 */
export function sanitizeControlChars(input: string): SanitizeResult {
  const codes = new Set<number>();
  let replaced = 0;
  let hadNul = false;

  // `replace` with a global regex always starts from index 0, so there is no
  // lastIndex state to reset here (unlike `test`, which we deliberately avoid).
  const text = input.replace(OFFENDING_CONTROL_CHARS, (ch) => {
    const code = ch.charCodeAt(0);
    codes.add(code);
    replaced++;
    if (code === 0) hadNul = true;
    return escapeFor(code);
  });

  if (replaced === 0) {
    return { text: input, replaced: 0, found: [], hadNul: false };
  }

  const found = [...codes].sort((a, b) => a - b).map(labelFor);
  return { text, replaced, found, hadNul };
}

/**
 * Build the note appended to sanitized text so the substitution is visible
 * rather than a silent mutation of what the human wrote.
 */
export function sanitizationNote(result: SanitizeResult): string {
  const plural = result.replaced === 1 ? 'character' : 'characters';
  return (
    '\n\n---\n' +
    `_[lazy sanitized ${result.replaced} non-printable control ${plural} ` +
    `(${result.found.join(', ')}) in the text above, replacing each with its printable ` +
    'escape. Raw control bytes cannot be passed to the agent process (NUL is illegal in ' +
    'argv), so they are escaped rather than dropped — no content was lost.]_'
  );
}

export interface SanitizeUserTextOptions {
  /**
   * Append a visible note describing the substitution. Default true.
   * Turn this off for short single-line fields (task goals) where the escapes
   * are self-evident and a paragraph of explanation would be noise.
   */
  annotate?: boolean;
}

/**
 * Sanitize human- or agent-authored free text at an intake boundary.
 *
 * Returns the input unchanged when there is nothing to sanitize (the
 * overwhelmingly common case), so this is safe to call on every intake path.
 */
export function sanitizeUserText(input: string, options: SanitizeUserTextOptions = {}): string {
  const result = sanitizeControlChars(input);
  if (result.replaced === 0) return input;
  const annotate = options.annotate ?? true;
  return annotate ? result.text + sanitizationNote(result) : result.text;
}

/**
 * Find argv elements that cannot be passed to a spawned process.
 *
 * Only NUL is actually illegal in argv — other control characters are ugly but
 * harmless — so this guard is deliberately narrower than the intake sanitizer.
 * Returns the indices of offending elements (empty when the argv is fine).
 */
export function findArgvIllegalIndices(args: readonly string[]): number[] {
  const bad: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a === 'string' && a.includes(NUL_CHAR)) bad.push(i);
  }
  return bad;
}

/**
 * Throw an actionable error if any argv element contains a NUL byte.
 *
 * This is the delivery-side backstop: if a future intake path forgets to
 * sanitize, the operator gets an error that names the problem and the fix
 * instead of the opaque `args[2] must be a string without null bytes` that
 * previously crash-looped the supervisor and swallowed the feedback.
 */
export function assertArgvSafe(args: readonly string[], context?: string): void {
  const bad = findArgvIllegalIndices(args);
  if (bad.length === 0) return;

  const where = context ? ` while running ${context}` : '';
  const positions = bad.map((i) => `args[${i}]`).join(', ');
  throw new Error(
    `Refusing to spawn a process${where}: ${positions} contains a NUL byte (U+0000), which is ` +
    'illegal in process arguments. This means text reached the spawn seam without passing ' +
    'through sanitizeUserText() at its intake boundary. Sanitize the offending text at intake ' +
    '(see src/utils/sanitize-text.ts) rather than letting the spawn fail.'
  );
}

/**
 * Sanitize text that is about to become an argv element carrying a prompt.
 *
 * Defense in depth for the delivery seam. Unlike `assertArgvSafe`, this
 * DELIVERS rather than failing — an unsanitized prompt reaching this point is
 * a lazy bug, and failing the turn would lose the human's feedback all over
 * again. `onSanitized` lets the caller log loudly so the intake gap is
 * diagnosable.
 */
export function sanitizePromptForArgv(
  prompt: string,
  onSanitized?: (result: SanitizeResult) => void,
): string {
  const result = sanitizeControlChars(prompt);
  if (result.replaced === 0) return prompt;
  onSanitized?.(result);
  return result.text + sanitizationNote(result);
}
