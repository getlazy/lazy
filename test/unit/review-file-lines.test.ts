import { describe, test, expect } from 'bun:test';
import {
  validateFileLinesRequest,
  sliceFileLines,
  EXPAND_CHUNK_LINES,
  MAX_EXPAND_LINES,
} from '../../src/review/file-lines';
import {
  contextGaps,
  diffViewScript,
  parseUnifiedDiff,
  renderReviewDiff,
} from '../../src/server/review-diff';

const ALLOWED = ['src/a.ts', 'docs/b.md'];

function validate(over: Record<string, unknown> = {}) {
  return validateFileLinesRequest({
    path: 'src/a.ts',
    side: 'new',
    start: 1,
    end: 10,
    allowedPaths: ALLOWED,
    ...over,
  });
}

describe('validateFileLinesRequest', () => {
  test('accepts a bounded range on a file that is in the diff', () => {
    const v = validate();
    expect(v).toEqual({ ok: true, request: { path: 'src/a.ts', side: 'new', start: 1, end: 10 } });
  });

  // INVARIANT: the file allow-list IS the authorization. This endpoint reads a
  // task worktree on behalf of a browser, so "which files may be read" is
  // decided by the diff the reviewer is already looking at — never by the
  // caller. A token holder must not be able to read a path out of a worktree
  // just by asking for it.
  test('refuses a path that is not part of the diff', () => {
    const v = validate({ path: 'src/secrets.ts' });
    expect(v).toEqual({ ok: false, status: 404, error: 'File is not part of this diff: src/secrets.ts' });
  });

  // INVARIANT: traversal is rejected before the allow-list is even consulted,
  // so a path that escapes the worktree can never be reached by a diff that
  // somehow named one.
  test.each(['../etc/passwd', 'src/../../etc/passwd', '/etc/passwd', 'src\\a.ts'])(
    'refuses unsafe path %p',
    (path) => {
      const v = validate({ path });
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.status).toBe(400);
        expect(v.error).toContain('Refusing to read path');
      }
    },
  );

  test('refuses a blank path', () => {
    const v = validate({ path: '' });
    expect(v).toEqual({ ok: false, status: 400, error: 'path is required' });
  });

  test('refuses a side that is neither old nor new', () => {
    const v = validate({ side: 'both' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(400);
  });

  test.each([0, -3, 'x', null])('refuses start %p', (start) => {
    const v = validate({ start });
    expect(v).toEqual({ ok: false, status: 400, error: 'start must be a line number >= 1' });
  });

  test('refuses an end before start', () => {
    const v = validate({ start: 40, end: 10 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('is before start');
  });

  // INVARIANT: the range is CLAMPED, not rejected. The bottom-of-file control
  // cannot know where the file ends, so it deliberately asks for more than it
  // expects; a hard refusal there would make "expand all" unusable, while an
  // unbounded read would let one click pull a whole generated file into a page.
  test('clamps an over-long range instead of refusing it', () => {
    const v = validate({ start: 5, end: 100000 });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.request.end).toBe(5 + MAX_EXPAND_LINES - 1);
  });
});

describe('sliceFileLines', () => {
  const content = 'a\nb\nc\nd\ne\n';

  test('slices an inclusive 1-based range', () => {
    expect(sliceFileLines(content, 2, 4)).toEqual({
      start: 2,
      end: 4,
      lines: ['b', 'c', 'd'],
      totalLines: 5,
      atEof: false,
    });
  });

  // INVARIANT: a trailing newline TERMINATES the last line, it does not start a
  // sixth empty one — otherwise every expansion to the end of a normal file
  // shows a phantom blank line that has no counterpart in the diff's numbering.
  test('does not count the trailing newline as a line', () => {
    const r = sliceFileLines(content, 5, 9);
    expect(r).toEqual({ start: 5, end: 5, lines: ['e'], totalLines: 5, atEof: true });
  });

  test('reports a file with no trailing newline the same way', () => {
    expect(sliceFileLines('a\nb', 1, 50)).toEqual({
      start: 1,
      end: 2,
      lines: ['a', 'b'],
      totalLines: 2,
      atEof: true,
    });
  });

  test('returns nothing when the range starts past the end', () => {
    const r = sliceFileLines(content, 9, 12);
    expect(r.lines).toEqual([]);
    expect(r.atEof).toBe(true);
  });

  test('keeps blank lines inside the range', () => {
    expect(sliceFileLines('a\n\nc\n', 1, 3).lines).toEqual(['a', '', 'c']);
  });
});

function fileFrom(diff: string) {
  const files = parseUnifiedDiff(diff);
  expect(files.length).toBe(1);
  return files[0];
}

describe('contextGaps', () => {
  const twoHunks = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,3 +10,3 @@',
    ' ten',
    '-eleven',
    '+ELEVEN',
    ' twelve',
    '@@ -30,3 +30,4 @@',
    ' thirty',
    '+added',
    ' thirtyone',
    ' thirtytwo',
    '',
  ].join('\n');

  test('reports the gap above the first hunk, between hunks, and after the last', () => {
    const gaps = contextGaps(fileFrom(twoHunks));
    expect(gaps.before[0]).toEqual({ start: 1, end: 9, delta: 0 });
    expect(gaps.before[1]).toEqual({ start: 13, end: 29, delta: 0 });
    // The end of the file is unknown to the renderer — it never reads the file.
    expect(gaps.after).toEqual({ start: 34, end: null, delta: -1 });
  });

  // INVARIANT: delta is (old - new) and is constant across a gap, which is what
  // lets the browser number BOTH columns of an expanded line from one response.
  test('carries the old/new offset accumulated by earlier hunks', () => {
    const gaps = contextGaps(fileFrom(twoHunks));
    expect(gaps.before[1]!.delta).toBe(0);
    expect(gaps.after!.delta).toBe(-1); // one line added before it
  });

  test('has no gap above a hunk that starts at line 1', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      '-one',
      '+ONE',
      ' two',
      '',
    ].join('\n');
    expect(contextGaps(fileFrom(diff)).before[0]).toBeNull();
  });

  // INVARIANT: no control at all beats a control that inserts wrong numbers.
  // A hunk with no old-side numbers (a new file) gives no way to derive delta.
  test('omits the gap when one side has no numbering', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- /dev/null',
      '+++ b/src/a.ts',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
      '',
    ].join('\n');
    const gaps = contextGaps(fileFrom(diff));
    expect(gaps.before[0]).toBeNull();
    expect(gaps.after).toBeNull();
  });
});

describe('renderReviewDiff expand controls', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -40,3 +40,3 @@',
    ' forty',
    '-fortyone',
    '+FORTYONE',
    ' fortytwo',
    '',
  ].join('\n');

  test('renders hidden, JS-only expand rows when allowed', () => {
    const html = renderReviewDiff([fileFrom(diff)], new Map(), { allowExpand: true });
    expect(html).toContain('class="rv-expand" hidden');
    expect(html).toContain('data-rv-expand-dir="up"');
    expect(html).toContain('data-rv-expand-dir="all"');
    expect(html).toContain('data-delta="0"');
    expect(html).toContain('39 hidden lines');
  });

  // A gap that fits in one click gets only "expand all": up and down would do
  // the same thing, and three buttons for one action is noise.
  test('offers only expand-all for a gap smaller than one chunk', () => {
    const small = diff.replace('@@ -40,3 +40,3 @@', '@@ -5,3 +5,3 @@');
    const html = renderReviewDiff([fileFrom(small)], new Map(), { allowExpand: true });
    expect(html).toContain('data-kind="top"');
    expect(html).not.toContain('data-rv-expand-dir="up"');
  });

  // INVARIANT: surfaces with no line-serving endpoint (commit detail) get no
  // controls at all — a button that cannot fetch is worse than no button.
  test('renders none by default', () => {
    const html = renderReviewDiff([fileFrom(diff)], new Map(), {});
    expect(html).not.toContain('rv-expand');
  });

  test('renders none for a binary file', () => {
    const html = renderReviewDiff(
      [{ path: 'img.png', oldPath: 'img.png', hunks: [], additions: 0, deletions: 0, binary: true }],
      new Map(),
      { allowExpand: true },
    );
    expect(html).not.toContain('rv-expand');
  });

  // INVARIANT: the browser must not carry its own copy of the server's limits.
  // The script asks for exactly what the server will clamp to, so both numbers
  // are interpolated from src/review/file-lines.ts rather than written out.
  test('the browser script interpolates the server limits', () => {
    const js = diffViewScript('#rv-root', '/api/review/x/file-lines');
    expect(js).toContain(`var CHUNK = ${EXPAND_CHUNK_LINES};`);
    expect(js).toContain(`var MAX_EXPAND = ${MAX_EXPAND_LINES};`);
    expect(js).not.toContain(String(MAX_EXPAND_LINES - 1));
    // Parse what the browser will actually run, so a broken interpolation is a
    // test failure here rather than a dead island in the page.
    const body = js.replace(/^<script>/, '').replace(/<\/script>$/, '');
    expect(new Function(body)).toBeInstanceOf(Function);
  });

  // INVARIANT: expansion is a VIEW action. The per-file content hash keys the
  // "Viewed" tick in localStorage, so it must depend only on the change itself
  // — otherwise turning the controls on would silently un-view every file.
  test('does not change the per-file content hash', () => {
    const withOut = renderReviewDiff([fileFrom(diff)], new Map(), {});
    const withIn = renderReviewDiff([fileFrom(diff)], new Map(), { allowExpand: true });
    const hash = (html: string) => /data-content-hash="([^"]+)"/.exec(html)?.[1];
    expect(hash(withIn)).toBe(hash(withOut));
  });

  // INVARIANT: expanded lines that are additions in the full file must never
  // paint as context. The island classifies from data-rv-new-adds and bumps
  // the visible +N so a snippet card's header stays honest after expand.
  test('the browser script classifies omitted additions from data-rv-new-adds', () => {
    const js = diffViewScript('#rv-root', '/api/review/x/file-lines');
    expect(js).toContain('rvNewAdds');
    expect(js).toContain('addSetFor');
    expect(js).toContain('bumpVisibleAdds');
    expect(js).toContain("isAdd ? 'rv-line rv-add' : 'rv-line rv-ctx'");
    const body = js.replace(/^<script>/, '').replace(/<\/script>$/, '');
    expect(new Function(body)).toBeInstanceOf(Function);
  });
});
