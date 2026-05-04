import { describe, test, expect } from 'bun:test';
import { hunkHash } from '../../src/utils/hunk-hash';
import { parseHunks, splitHunk, summaryHunksFromText } from '../../src/cli/tui/per-hunk-review';

describe('hunkHash', () => {
  test('is stable across re-parses of the same diff', () => {
    const diff = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
`;
    const a = parseHunks(diff);
    const b = parseHunks(diff);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(hunkHash(a[0])).toBe(hunkHash(b[0]));
  });

  test('is insensitive to @@ header line counts (surrounding-code shift)', () => {
    // Same body, different `@@ -10,5 +10,6 @@` vs `@@ -50,5 +50,6 @@`
    // — a shift caused by edits above the hunk that don't actually
    // touch its body. Hash must remain stable.
    const body = [
      ' first context',
      '-old',
      '+new',
      ' second context',
    ].join('\n');
    const h1 = parseHunks(`diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -10,4 +10,4 @@\n${body}\n`);
    const h2 = parseHunks(`diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -100,4 +100,4 @@\n${body}\n`);
    expect(hunkHash(h1[0])).toBe(hunkHash(h2[0]));
  });

  test('changes when any body line changes (added, removed, or context)', () => {
    const base = parseHunks(
      `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n ctx\n-old\n+new\n`,
    );
    const editedAdded = parseHunks(
      `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n ctx\n-old\n+different\n`,
    );
    const editedRemoved = parseHunks(
      `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n ctx\n-old2\n+new\n`,
    );
    const editedContext = parseHunks(
      `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n different ctx\n-old\n+new\n`,
    );
    const baseHash = hunkHash(base[0]);
    expect(hunkHash(editedAdded[0])).not.toBe(baseHash);
    expect(hunkHash(editedRemoved[0])).not.toBe(baseHash);
    expect(hunkHash(editedContext[0])).not.toBe(baseHash);
  });

  test('changes when the file path changes', () => {
    const body = '@@ -1,2 +1,2 @@\n-x\n+y\n';
    const h1 = parseHunks(`diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n${body}`);
    const h2 = parseHunks(`diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n${body}`);
    expect(hunkHash(h1[0])).not.toBe(hunkHash(h2[0]));
  });

  test('separates kind so a code body and summary body cannot collide', () => {
    // Synthesise a code hunk and a summary hunk whose canonical bodies
    // are identical strings — the kind tag must keep their hashes apart.
    const text = 'foo bar baz';
    const [summary] = summaryHunksFromText(text);
    const fakeCode: Parameters<typeof hunkHash>[0] = {
      kind: 'code',
      file: 'agent-response',
      diff: text,
    };
    expect(hunkHash(summary)).not.toBe(hunkHash(fakeCode));
  });

  test('children of a split have hashes distinct from the parent and each other', () => {
    const diff = [
      '@@ -10,7 +10,7 @@',
      '-first old',
      '+first new',
      ' middle context',
      ' more context',
      '-second old',
      '+second new',
    ].join('\n');
    const [parent] = parseHunks(`diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n${diff}\n`);
    const split = splitHunk(parent)!;
    expect(split).not.toBeNull();
    const [a, b] = split;
    const ph = hunkHash(parent);
    const ah = hunkHash(a);
    const bh = hunkHash(b);
    expect(ah).not.toBe(ph);
    expect(bh).not.toBe(ph);
    expect(ah).not.toBe(bh);
  });

  test('summary hash is stable across repeated summaryHunksFromText calls', () => {
    const text = 'para one.\n\npara two.\n\npara three.';
    const a = summaryHunksFromText(text);
    const b = summaryHunksFromText(text);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(hunkHash(a[0])).toBe(hunkHash(b[0]));
  });
});
