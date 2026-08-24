/**
 * Regression tests for the NUL-in-feedback crash loop.
 *
 * Reproduced live on 2026-07-26: builder feedback delivered via lazy_unblock
 * contained two literal NUL characters. Lazy persisted the feedback, then the
 * work phase crash-looped with
 *
 *     Work phase failed: Crash loop detected:
 *     The argument 'args[2]' must be a string without null bytes
 *
 * because the feedback is passed as argv[2] of `claude -p`. Worse than the
 * crash: auto-resume then ran with an OLDER, generic prompt, so the feedback
 * was silently never delivered — twice.
 *
 * These tests pin the whole seam: intake sanitization, argv construction, and
 * the spawn-level backstop.
 */

import { describe, test, expect } from 'bun:test';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { CursorAgent } from '../../src/agent/cursor';
import { QaAgent } from '../../src/agent/qa-agent';
import { buildMergeClaudeArgs } from '../../src/supervisor/merge';
import { spawn, spawnSyncUnsupervised } from '../../src/utils/spawn';
import { sanitizeUserText, findArgvIllegalIndices, NUL_CHAR } from '../../src/utils/sanitize-text';

const NUL = NUL_CHAR;

/** The exact shape of the feedback that caused the live incident. */
const REAL_WORLD_FEEDBACK =
  `The parser must reject NUL (${NUL}) bytes, and also strip ${NUL} from filenames.`;

describe('NUL-bearing feedback: intake sanitization', () => {
  // INVARIANT (CLAUDE.md "never lose human feedback"): sanitization must
  // PRESERVE the feedback. We escape rather than strip or reject, so the
  // human's words all survive the trip.
  test('sanitized feedback keeps every word the human wrote', () => {
    const safe = sanitizeUserText(REAL_WORLD_FEEDBACK);
    expect(safe).toContain('The parser must reject NUL');
    expect(safe).toContain('also strip');
    expect(safe).toContain('from filenames.');
    expect(safe).toContain('\\u0000');
  });

  test('sanitized feedback is argv-legal', () => {
    expect(sanitizeUserText(REAL_WORLD_FEEDBACK).includes(NUL)).toBe(false);
  });

  test('the substitution is disclosed, not silent', () => {
    expect(sanitizeUserText(REAL_WORLD_FEEDBACK)).toContain('lazy sanitized');
  });
});

describe('NUL-bearing feedback: argv construction', () => {
  // INVARIANT: buildExecArgs must never emit an argv element containing NUL,
  // even when handed an unsanitized prompt. This is the defense-in-depth layer
  // behind intake sanitization — a future intake gap must degrade to a
  // delivered (escaped) turn, never to a crash loop that eats the feedback.
  test('ClaudeCodeAgent.buildExecArgs escapes a NUL prompt instead of emitting it', () => {
    const args = new ClaudeCodeAgent().buildExecArgs({
      prompt: REAL_WORLD_FEEDBACK,
      dangerouslySkipPermissions: true,
    });
    expect(findArgvIllegalIndices(args)).toEqual([]);
    // argv[2] is the prompt — the position named in the original crash.
    expect(args[2]).toContain('\\u0000');
    expect(args[2]).toContain('The parser must reject NUL');
  });

  test('ClaudeCodeAgent.buildExecArgs also escapes the system prompt', () => {
    const args = new ClaudeCodeAgent().buildExecArgs({
      prompt: 'clean',
      systemPrompt: `system${NUL}instructions`,
      dangerouslySkipPermissions: true,
    });
    expect(findArgvIllegalIndices(args)).toEqual([]);
    expect(args.join(' ')).toContain('system\\u0000instructions');
  });

  test('CursorAgent.buildExecArgs escapes its trailing positional prompt', () => {
    const args = new CursorAgent().buildExecArgs({
      prompt: REAL_WORLD_FEEDBACK,
      dangerouslySkipPermissions: true,
    });
    expect(findArgvIllegalIndices(args)).toEqual([]);
    expect(args[args.length - 1]).toContain('The parser must reject NUL');
  });

  test('QaAgent.buildExecArgs escapes its prompt', () => {
    const args = new QaAgent().buildExecArgs({
      prompt: REAL_WORLD_FEEDBACK,
      dangerouslySkipPermissions: true,
    });
    expect(findArgvIllegalIndices(args)).toEqual([]);
  });

  test('buildMergeClaudeArgs escapes its prompt', () => {
    const args = buildMergeClaudeArgs(`resolve${NUL}conflicts`);
    expect(findArgvIllegalIndices(args)).toEqual([]);
    expect(args[2]).toContain('resolve\\u0000conflicts');
  });

  // INVARIANT: clean prompts must pass through byte-for-byte. Sanitization is
  // not allowed to reformat ordinary feedback.
  test('a clean prompt is passed through unchanged', () => {
    const prompt = 'Fix the off-by-one in the parser.\n\nSee line 42.\tThanks.';
    const args = new ClaudeCodeAgent().buildExecArgs({
      prompt,
      dangerouslySkipPermissions: true,
    });
    expect(args[2]).toBe(prompt);
  });
});

describe('NUL-bearing feedback: spawn backstop', () => {
  // INVARIANT: if text ever reaches spawn() unsanitized, the operator gets an
  // ACTIONABLE error naming the argv position and the fix — not the opaque
  // `args[2] must be a string without null bytes` that crash-looped the turn.
  test('spawn() refuses NUL-bearing argv with an actionable error', () => {
    let err: Error | undefined;
    try {
      spawn(['claude', '-p', REAL_WORLD_FEEDBACK], { stdout: 'pipe', stderr: 'pipe' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('args[2]');
    expect(err!.message).toContain('NUL byte');
    expect(err!.message).toContain('claude');
    expect(err!.message).toContain('sanitizeUserText');
    // The old, useless message must not be what surfaces.
    expect(err!.message).not.toContain('must be a string without null bytes');
  });

  test('spawnSyncUnsupervised() applies the same guard', () => {
    expect(() => spawnSyncUnsupervised(['git', 'commit', '-m', `msg${NUL}`])).toThrow(/NUL byte/);
  });

  // INVARIANT: the guard must not disturb ordinary spawns.
  test('a clean argv still spawns', async () => {
    const proc = spawn(['echo', 'hello'], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    expect(out.trim()).toBe('hello');
  });
});

describe('NUL-bearing feedback: end-to-end at the delivery seam', () => {
  // This is the whole incident, reproduced and pinned: NUL feedback goes
  // through intake sanitization, becomes argv, and spawns without throwing.
  // Before the fix this threw, retried instantly, tripped crash-loop
  // detection, and the feedback was silently dropped by the stale auto-resume.
  test('feedback with raw NUL survives intake -> argv -> spawn', async () => {
    const sanitized = sanitizeUserText(REAL_WORLD_FEEDBACK);

    const args = new ClaudeCodeAgent().buildExecArgs({
      prompt: sanitized,
      dangerouslySkipPermissions: true,
    });

    // Substitute a harmless binary for `claude` — we are testing that the argv
    // is spawnable, not that Claude runs.
    const spawnable = ['cat', ...args.slice(1)];
    expect(() => spawn(spawnable, { stdout: 'pipe', stderr: 'pipe' })).not.toThrow();

    // And the human's actual words are still in the prompt that would be sent.
    expect(args[2]).toContain('The parser must reject NUL');
    expect(args[2]).toContain('also strip');
  });
});
