/**
 * Unit tests: the builder supervisor's live-session detection.
 *
 * `pickActiveSessionFile` decides which JSONL file holds the conversation the
 * builder is driving. Its sessionId is stamped onto the resume intent and is
 * what the host relaunch loop resumes after `lazy upgrade`.
 *
 * INVARIANT: the resume target is the NEWEST segment owned by this run. A single
 * run spans many JSONL files — /clear, compaction, and resume each roll Claude
 * to a fresh <uuid>.jsonl — so the live tail is the newest of those, regardless
 * of whether the run started fresh or with `--resume`. `--resume <id>` defines
 * where the run STARTED, never what it ends as: pinning to <id> after a /clear
 * resumes the conversation the user deliberately cleared away.
 *
 * INVARIANT: ~/.claude/projects/<proj> is SHARED (other builder runs, a plain
 * `claude` in the same repo). When NO new segment rolled, an explicit `--resume
 * <id>` is authoritative — an unrelated, merely-touched file with a newer mtime
 * must NOT hijack detection. (A genuinely-new segment from THIS run, however,
 * does win — that is the /clear tail, not a hijack.)
 */

import { describe, test, expect } from 'bun:test';
import { pickActiveSessionFile, parseResumeSessionId } from '../../src/supervisor/builder';

const times = (entries: Record<string, number>): Map<string, number> =>
  new Map(Object.entries(entries));

describe('parseResumeSessionId', () => {
  test('extracts the id following --resume', () => {
    expect(parseResumeSessionId(['--append-system-prompt', 'p', '--resume', 'sid-1', '--effort', 'high']))
      .toBe('sid-1');
  });

  test('returns null when --resume is absent (fresh session)', () => {
    expect(parseResumeSessionId(['--append-system-prompt', 'p', '--effort', 'high'])).toBeNull();
  });

  test('returns null when --resume has no following value', () => {
    expect(parseResumeSessionId(['--effort', 'high', '--resume'])).toBeNull();
  });

  test('returns null for undefined args', () => {
    expect(parseResumeSessionId(undefined)).toBeNull();
  });
});

describe('pickActiveSessionFile', () => {
  // HIJACK GUARD: resumed session X is live, but an unrelated PRE-EXISTING
  // session Z (another builder / a plain `claude` in the repo) was merely touched
  // more recently. Z is not a new file — it must not hijack detection. With an
  // explicit --resume id and no new segment, X wins.
  test('prefers the --resume id when an unrelated pre-existing session is merely newer', () => {
    const before = times({ 'X.jsonl': 100, 'Z.jsonl': 100 });
    const after = times({ 'X.jsonl': 110, 'Z.jsonl': 999 });
    expect(pickActiveSessionFile(before, after, 'X')).toBe('X.jsonl');
  });

  // THE BUG (resumed + /clear): the run started with --resume X, then the user
  // /clear'd mid-session. Claude rolled to a brand-new segment C; X.jsonl still
  // exists on disk but is dormant. The resume target must be C (the live tail),
  // NOT X — pinning to X resumes the conversation the user deliberately cleared.
  test('returns the new segment after a /clear in a resumed run, not the resumed id', () => {
    const before = times({ 'X.jsonl': 100 });
    const after = times({ 'X.jsonl': 110, 'C.jsonl': 200 });
    expect(pickActiveSessionFile(before, after, 'X')).toBe('C.jsonl');
  });

  // Fresh + /clear: from-scratch run S, then /clear rolls to C. Newest new wins.
  test('returns the newest new segment after a /clear in a fresh run', () => {
    const before = times({});
    const after = times({ 'S.jsonl': 100, 'C.jsonl': 200 });
    expect(pickActiveSessionFile(before, after, null)).toBe('C.jsonl');
  });

  // Multiple /clears in a resumed run: X → C1 → C2. The last segment is the tail.
  test('returns the last segment after multiple /clears', () => {
    const before = times({ 'X.jsonl': 100 });
    const after = times({ 'X.jsonl': 110, 'C1.jsonl': 200, 'C2.jsonl': 300 });
    expect(pickActiveSessionFile(before, after, 'X')).toBe('C2.jsonl');
  });

  // Resume-in-place: Claude appends to X.jsonl, nothing else changed.
  test('returns the resumed file when it appended in place', () => {
    const before = times({ 'X.jsonl': 100 });
    const after = times({ 'X.jsonl': 150 });
    expect(pickActiveSessionFile(before, after, 'X')).toBe('X.jsonl');
  });

  // Resume id given but its file is gone/never materialized → fall through to
  // genuinely-new-file detection rather than returning a non-existent file.
  test('falls through when the resumed file is not present', () => {
    const before = times({});
    const after = times({ 'new.jsonl': 200 });
    expect(pickActiveSessionFile(before, after, 'X')).toBe('new.jsonl');
  });

  // From-scratch session: exactly one brand-new file.
  test('returns the new file for a fresh session', () => {
    const before = times({ 'old.jsonl': 100 });
    const after = times({ 'old.jsonl': 100, 'fresh.jsonl': 120 });
    expect(pickActiveSessionFile(before, after, null)).toBe('fresh.jsonl');
  });

  // From-scratch, but an unrelated pre-existing session was merely touched and
  // is newer. A genuinely-NEW file still wins over a merely-changed one.
  test('prefers a new file over a merely-changed (touched) file', () => {
    const before = times({ 'touched.jsonl': 100, /* new appears later */ });
    const after = times({ 'touched.jsonl': 999, 'fresh.jsonl': 120 });
    expect(pickActiveSessionFile(before, after, null)).toBe('fresh.jsonl');
  });

  // Last resort: no resume id, no new file — pick the newest changed file.
  test('falls back to newest changed file when nothing else applies', () => {
    const before = times({ 'a.jsonl': 100, 'b.jsonl': 100 });
    const after = times({ 'a.jsonl': 130, 'b.jsonl': 120 });
    expect(pickActiveSessionFile(before, after, null)).toBe('a.jsonl');
  });

  test('returns null when nothing changed', () => {
    const before = times({ 'a.jsonl': 100 });
    const after = times({ 'a.jsonl': 100 });
    expect(pickActiveSessionFile(before, after, null)).toBeNull();
  });
});
