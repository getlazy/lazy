/**
 * Unit tests: the builder supervisor's live-session detection.
 *
 * `pickActiveSessionFile` decides which JSONL file holds the conversation the
 * builder is driving. Its sessionId is stamped onto the resume intent and is
 * what the host relaunch loop resumes after `lazy upgrade`. ~/.claude/projects/
 * <proj> is SHARED (other builder runs, a plain `claude` in the same repo), so
 * picking "newest modified file" can latch onto an unrelated session — which is
 * exactly the bug that resumed the wrong conversation after an upgrade.
 *
 * INVARIANT: when the builder was launched with `--resume <id>`, that session is
 * authoritative — detection must NOT be overridden by an unrelated file with a
 * newer mtime.
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
  // THE BUG: resumed session X is live, but an unrelated session Z (another
  // builder / a plain `claude` in the repo) was written more recently. The old
  // "newest changed" heuristic picked Z. With an explicit --resume id, X wins.
  test('prefers the --resume id even when an unrelated session is newer', () => {
    const before = times({ 'X.jsonl': 100, 'Z.jsonl': 100 });
    const after = times({ 'X.jsonl': 110, 'Z.jsonl': 999 });
    expect(pickActiveSessionFile(before, after, 'X')).toBe('X.jsonl');
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
