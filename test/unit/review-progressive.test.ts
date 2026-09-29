/**
 * The progressive Changes tab: which files load when, and the parsers it
 * leans on.
 *
 * INVARIANT: a task's diff is its whole branch (engineer decision
 * 2026-09-25), and size is solved by loading file by file — never by capping,
 * truncating or dropping files. Every file is planned into exactly one of
 * inline / deferred / large, and a diff below the progressive thresholds
 * renders in one response exactly as before, walkthrough included.
 */
import { describe, test, expect } from 'bun:test';
import { parseNumstatZ, type DiffFileEntry } from '../../src/git/operations';
import {
  planChangesLoad,
  needsProgressive,
  loadChangesDiff,
  INLINE_FILE_BUDGET,
  LARGE_FILE_LINES,
  PROGRESSIVE_FILES,
} from '../../src/server/review-progressive';
import { parseUnifiedDiff, unquoteGitPath } from '../../src/server/review-diff';
import { reviewTaskHtml } from '../../src/server/review';
import type { ReviewActions } from '../../src/server/review-actions';
import type { Task, TurnReport } from '../../src/types';

const entry = (path: string, additions = 3, deletions = 0): DiffFileEntry =>
  ({ path, additions, deletions, binary: false });

describe('parseNumstatZ', () => {
  test('plain, rename and binary records', () => {
    const out = parseNumstatZ('3\t1\ta.txt\0' + '2\t0\t\0old/b.txt\0new/b.txt\0' + '-\t-\timg.png\0');
    expect(out).toEqual([
      { path: 'a.txt', additions: 3, deletions: 1, binary: false },
      { path: 'new/b.txt', oldPath: 'old/b.txt', additions: 2, deletions: 0, binary: false },
      { path: 'img.png', additions: 0, deletions: 0, binary: true },
    ]);
  });

  test('non-ASCII paths are raw, and the patch parser agrees', () => {
    const [e] = parseNumstatZ('1\t0\té.txt\0');
    expect(e.path).toBe('é.txt');
    // git C-quotes the same path in a patch header; parsed, it must match.
    const files = parseUnifiedDiff(
      'diff --git "a/\\303\\251.txt" "b/\\303\\251.txt"\nnew file mode 100644\n--- /dev/null\n+++ "b/\\303\\251.txt"\n@@ -0,0 +1 @@\n+hi\n',
    );
    expect(files.map((f) => f.path)).toEqual([e.path]);
    expect(unquoteGitPath('"a\\"b\\\\c"')).toBe('a"b\\c');
  });
});

describe('planChangesLoad', () => {
  test('every file lands in exactly one set; inline is a prefix, large files wait for a click', () => {
    const entries = [
      entry('big.lock', LARGE_FILE_LINES + 1),
      ...Array.from({ length: INLINE_FILE_BUDGET + 10 }, (_, i) => entry(`f${i}.txt`)),
    ];
    const plan = planChangesLoad(entries);
    expect(plan.large).toEqual(new Set(['big.lock']));
    expect(plan.inline.size).toBe(INLINE_FILE_BUDGET);
    expect(plan.inline.has('f0.txt')).toBe(true);
    expect(plan.deferred.has(`f${INLINE_FILE_BUDGET}.txt`)).toBe(true);
    expect(plan.inline.size + plan.deferred.size + plan.large.size).toBe(entries.length);
  });

  test('progressive only past the thresholds', () => {
    expect(needsProgressive(Array.from({ length: 50 }, (_, i) => entry(`f${i}`)))).toBe(false);
    expect(needsProgressive([entry('lock', 5000)])).toBe(false);
    expect(needsProgressive(Array.from({ length: PROGRESSIVE_FILES + 1 }, (_, i) => entry(`f${i}`)))).toBe(true);
  });
});

describe('a mid-size change keeps its walkthrough', () => {
  const task = { id: 'task1234abcd', code: 'mid', goal: 'Mid', status: 'blocked' } as unknown as Task;
  const patch = Array.from({ length: 50 }, (_, i) =>
    `diff --git a/f${i}.txt b/f${i}.txt\n--- a/f${i}.txt\n+++ b/f${i}.txt\n@@ -1 +1 @@\n-a\n+b\n`).join('');

  test('50 files load in one response and render the presented view', async () => {
    const calls: unknown[] = [];
    const actions = {
      listDiffFiles: async () => Array.from({ length: 50 }, (_, i) => entry(`f${i}.txt`, 1, 1)),
      getDiff: async (_t: string, opts?: unknown) => { calls.push(opts); return patch; },
    } as unknown as ReviewActions;
    const { diffText, progressive } = await loadChangesDiff(actions, task.id, null);
    expect(progressive).toBeNull();
    expect(calls).toEqual([undefined]);
    const report = {
      sections: [],
      presentation: { groups: [{ title: 'Everything', tier: 'core', items: [{ kind: 'file', file: 'f0.txt' }] }] },
    } as unknown as TurnReport;
    const html = reviewTaskHtml(task, diffText, [], undefined, undefined, [], { turnReport: report });
    expect(html).toContain('rv-presented');
    expect(html).not.toContain('rv-walkthrough-progressive');
  });
});
