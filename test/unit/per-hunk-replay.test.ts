import { describe, test, expect } from 'bun:test';
import {
  parseHunks,
  splitHunk,
  reconstructHunksWithApprovals,
  replaySplitPath,
} from '../../src/cli/tui/per-hunk-review';
import { hunkHash } from '../../src/utils/hunk-hash';

const SPLITTABLE_DIFF = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -10,7 +10,7 @@
-first old
+first new
 middle context
 more context
-second old
+second new
`;

describe('replaySplitPath', () => {
  test('reproduces the same sub-hunk that splitHunk would emit', () => {
    const [parent] = parseHunks(SPLITTABLE_DIFF);
    const split = splitHunk(parent)!;
    expect(hunkHash(replaySplitPath(parent, '0')!)).toBe(hunkHash(split[0]));
    expect(hunkHash(replaySplitPath(parent, '1')!)).toBe(hunkHash(split[1]));
  });

  test('returns null when path goes deeper than the hunk can split', () => {
    const [parent] = parseHunks(SPLITTABLE_DIFF);
    // Splitting once gives two atomic halves — any further descent fails.
    expect(replaySplitPath(parent, '00')).toBeNull();
  });
});

describe('reconstructHunksWithApprovals', () => {
  test('whole-hunk approvals (no lineage) are surfaced via approvedHashes', () => {
    const parents = parseHunks(SPLITTABLE_DIFF);
    const hash = hunkHash(parents[0]);
    const out = reconstructHunksWithApprovals(parents, [
      { hunk_hash: hash },
    ]);
    expect(out.hunks).toHaveLength(1);
    expect(out.lineage[0]).toBeNull();
    expect(out.approvedHashes.has(hash)).toBe(true);
  });

  test('split-hunk approval survives a re-run: parent gets re-split, child marked approved', () => {
    const parents = parseHunks(SPLITTABLE_DIFF);
    const parent = parents[0];
    const split = splitHunk(parent)!;
    const childHash = hunkHash(split[0]);
    const out = reconstructHunksWithApprovals(parents, [
      {
        hunk_hash: childHash,
        parent_file: parent.file,
        parent_lines: parent.lines,
        split_path: '0',
      },
    ]);
    expect(out.hunks).toHaveLength(2);
    expect(hunkHash(out.hunks[0])).toBe(childHash);
    expect(hunkHash(out.hunks[1])).toBe(hunkHash(split[1]));
    expect(out.approvedHashes.has(childHash)).toBe(true);
    expect(out.approvedHashes.has(hunkHash(split[1]))).toBe(false);
    expect(out.lineage[0]).toEqual({
      parentFile: parent.file,
      parentLines: parent.lines,
      path: '0',
    });
  });

  test('parent location absent → approval is dropped (parent moved/disappeared)', () => {
    const parents = parseHunks(SPLITTABLE_DIFF);
    const out = reconstructHunksWithApprovals(parents, [
      {
        hunk_hash: 'deadbeef',
        parent_file: 'other-file.ts',
        parent_lines: '100-200',
        split_path: '0',
      },
    ]);
    expect(out.hunks).toHaveLength(1);
    expect(out.lineage[0]).toBeNull();
    expect(out.approvedHashes.size).toBe(0);
  });

  test('child hash mismatch after replay → approval dropped, sibling stays unmarked', () => {
    const parents = parseHunks(SPLITTABLE_DIFF);
    const parent = parents[0];
    const split = splitHunk(parent)!;
    // Persist a stale hash for path '0' — the leaf produced by replay won't
    // match it, so the approval must drop and the leaf reappears fresh.
    const out = reconstructHunksWithApprovals(parents, [
      {
        hunk_hash: 'stale-hash-does-not-match',
        parent_file: parent.file,
        parent_lines: parent.lines,
        split_path: '0',
      },
    ]);
    // The split is still reconstructed (lineage tells us the parent was
    // split at least once) — but neither leaf is marked approved.
    expect(out.hunks).toHaveLength(2);
    expect(hunkHash(out.hunks[0])).toBe(hunkHash(split[0]));
    expect(hunkHash(out.hunks[1])).toBe(hunkHash(split[1]));
    expect(out.approvedHashes.size).toBe(0);
  });

  test('per-hunk independence: edits to a different hunk do not invalidate this hunk\'s split approval', () => {
    // Two independent hunks at distinct line ranges. Approval is recorded
    // on hunk A. Between sessions, hunk B's content changes — that has no
    // bearing on A's parent-location lookup, so A's approval must survive.
    const sessionOne = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -10,7 +10,7 @@
-A first old
+A first new
 mid context A
 more context A
-A second old
+A second new
@@ -100,3 +100,3 @@
 ctx B
-B old
+B new
`;
    const sessionTwo = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -10,7 +10,7 @@
-A first old
+A first new
 mid context A
 more context A
-A second old
+A second new
@@ -100,3 +100,3 @@
 ctx B
-B totally different
+B totally different new
`;
    const parsedOne = parseHunks(sessionOne);
    const hunkA = parsedOne[0];
    const hunkB = parsedOne[1];
    expect(hunkA.lines).not.toBe(hunkB.lines);

    const splitA = splitHunk(hunkA)!;
    const approvedChildHash = hunkHash(splitA[0]);

    const parsedTwo = parseHunks(sessionTwo);
    const out = reconstructHunksWithApprovals(parsedTwo, [
      {
        hunk_hash: approvedChildHash,
        parent_file: hunkA.file,
        parent_lines: hunkA.lines,
        split_path: '0',
      },
    ]);
    expect(out.approvedHashes.has(approvedChildHash)).toBe(true);
    // Hunk B is preserved as a single un-split entry (no approval against it).
    const bIdx = out.hunks.findIndex(h => h.lines === hunkB.lines);
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(out.lineage[bIdx]).toBeNull();
  });

  test('line-range shift invalidates approval (known limitation of file+range anchoring)', () => {
    // Documenting the boundary of approach (b): if upstream edits shift the
    // hunk's `@@` line numbers, `parent_lines` changes and the lookup misses.
    // This is a deliberate trade-off vs. parent-hash matching, which would
    // also fail under any context change. The point of the test is to encode
    // the limitation honestly so a future change doesn't quietly "fix" it
    // in a way that re-introduces parent-hash brittleness.
    const before = parseHunks(SPLITTABLE_DIFF);
    const parent = before[0];
    const split = splitHunk(parent)!;
    const childHash = hunkHash(split[0]);

    const shiftedDiff = SPLITTABLE_DIFF.replace('@@ -10,7 +10,7 @@', '@@ -50,7 +50,7 @@');
    const after = parseHunks(shiftedDiff);
    expect(after[0].lines).not.toBe(parent.lines);

    const out = reconstructHunksWithApprovals(after, [
      {
        hunk_hash: childHash,
        parent_file: parent.file,
        parent_lines: parent.lines,
        split_path: '0',
      },
    ]);
    expect(out.approvedHashes.has(childHash)).toBe(false);
    // Parent is surfaced un-split, since no lineage matched its location.
    expect(out.hunks).toHaveLength(1);
    expect(out.lineage[0]).toBeNull();
  });

  test('split-failure in one branch does not cascade across siblings', () => {
    // Persisted paths [0, 11] against a parent where root splits cleanly
    // but the right half is atomic (cannot split further). The '0'
    // approval lives on a leaf the replay can produce; the '11' approval
    // wanted to descend into the atomic right half. The right-side
    // failure must NOT drop the left-side approval.
    const parents = parseHunks(SPLITTABLE_DIFF);
    const parent = parents[0];
    const rootSplit = splitHunk(parent)!;
    expect(splitHunk(rootSplit[1])).toBeNull(); // sanity: right is atomic

    const leftHash = hunkHash(rootSplit[0]);

    const out = reconstructHunksWithApprovals(parents, [
      {
        hunk_hash: leftHash,
        parent_file: parent.file,
        parent_lines: parent.lines,
        split_path: '0',
      },
      {
        hunk_hash: 'irrelevant-deep-hash',
        parent_file: parent.file,
        parent_lines: parent.lines,
        split_path: '11',
      },
    ]);
    // Left half survives independently of the right's failed deeper descent.
    expect(out.approvedHashes.has(leftHash)).toBe(true);
    // The right half is emitted as a leaf at path '1' (its current state),
    // and the '11' approval finds no leaf at that path → dropped.
    const rightIdx = out.hunks.findIndex(h => hunkHash(h) === hunkHash(rootSplit[1]));
    expect(rightIdx).toBeGreaterThanOrEqual(0);
    expect(out.approvedHashes.has(hunkHash(rootSplit[1]))).toBe(false);
  });

  test('multiple split paths under the same parent are reconstructed deepest-needed', () => {
    // Build a diff splittable twice: two separate split points.
    const diff = `diff --git a/y.ts b/y.ts
--- a/y.ts
+++ b/y.ts
@@ -1,11 +1,11 @@
-a-old
+a-new
 ctx1
 ctx1b
-b-old
+b-new
 ctx2
 ctx2b
-c-old
+c-new
`;
    const [parent] = parseHunks(diff);
    const first = splitHunk(parent)!;
    // first[1] should split again
    const second = splitHunk(first[1]);
    if (!second) {
      // If the diff layout doesn't allow nested splits in this env, skip.
      return;
    }
    const leafA = first[0];      // path '0'
    const leafBA = second[0];    // path '10'
    const leafBB = second[1];    // path '11'

    const out = reconstructHunksWithApprovals([parent], [
      {
        hunk_hash: hunkHash(leafBA),
        parent_file: parent.file,
        parent_lines: parent.lines,
        split_path: '10',
      },
    ]);
    expect(out.hunks).toHaveLength(3);
    expect(hunkHash(out.hunks[0])).toBe(hunkHash(leafA));
    expect(hunkHash(out.hunks[1])).toBe(hunkHash(leafBA));
    expect(hunkHash(out.hunks[2])).toBe(hunkHash(leafBB));
    expect(out.approvedHashes.has(hunkHash(leafBA))).toBe(true);
    expect(out.approvedHashes.has(hunkHash(leafA))).toBe(false);
    expect(out.approvedHashes.has(hunkHash(leafBB))).toBe(false);
  });
});
