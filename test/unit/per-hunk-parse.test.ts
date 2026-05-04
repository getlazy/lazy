import { describe, test, expect } from 'bun:test';
import { parseHunks, summaryHunksFromText, splitHunk } from '../../src/cli/tui/per-hunk-review';

describe('parseHunks', () => {
  test('parses a single-file single-hunk diff', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 0000000..1111111 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line one
-line two
+line two modified
+line three
 line four
`;
    const hunks = parseHunks(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].file).toBe('src/foo.ts');
    expect(hunks[0].lines).toBe('1-4');
    expect(hunks[0].diff).toContain('@@ -1,3 +1,4 @@');
    expect(hunks[0].diff).toContain('+line two modified');
  });

  test('parses multi-hunk multi-file diffs', () => {
    const diff = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-alpha
+ALPHA
@@ -10,1 +10,2 @@
 keep
+added
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -5,0 +6,1 @@
+new line
`;
    const hunks = parseHunks(diff);
    expect(hunks).toHaveLength(3);
    expect(hunks[0].file).toBe('a.txt');
    expect(hunks[1].file).toBe('a.txt');
    expect(hunks[2].file).toBe('b.txt');
    expect(hunks[0].lines).toBe('1');
    expect(hunks[1].lines).toBe('10-11');
    expect(hunks[2].lines).toBe('6');
  });

  test('returns empty array for empty input', () => {
    expect(parseHunks('')).toEqual([]);
    expect(parseHunks('no diff here')).toEqual([]);
  });
});

describe('summaryHunksFromText', () => {
  test('returns a single summary hunk for multi-paragraph text', () => {
    const text = `I implemented the feature by modifying two files.

Specifically, I added a new function foo() that handles the edge case.

Then wired it into bar() so existing callers stay unchanged.`;
    const hunks = summaryHunksFromText(text);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].kind).toBe('summary');
    expect(hunks[0].file).toBe('agent-response');
    expect(hunks[0].lines).toBe('summary');
    expect(hunks[0].diff).toContain('I implemented the feature');
    expect(hunks[0].diff).toContain('Then wired it into bar()');
  });

  test('handles single paragraph', () => {
    const hunks = summaryHunksFromText('Just a single paragraph.');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].diff).toBe('Just a single paragraph.');
  });

  test('treats whitespace-only input as empty', () => {
    expect(summaryHunksFromText('')).toEqual([]);
    expect(summaryHunksFromText('   \n\n\n  ')).toEqual([]);
  });
});

describe('splitHunk', () => {
  test('splits a hunk at interior context between two change groups', () => {
    const diff = [
      '@@ -10,6 +10,7 @@',
      '-first change old',
      '+first change new',
      ' context in middle',
      ' more context',
      '-second change old',
      '+second change new',
      '+added line',
    ].join('\n');
    const hunks = parseHunks(`diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n${diff}\n`);
    const split = splitHunk(hunks[0]);
    expect(split).not.toBeNull();
    const [a, b] = split!;

    expect(a.kind).toBe('code');
    expect(a.file).toBe('x.ts');
    // First half covers the first change + the context before the split point
    expect(a.diff).toContain('-first change old');
    expect(a.diff).toContain('+first change new');
    expect(a.diff).toContain(' context in middle');
    expect(a.diff).not.toContain('-second change old');

    expect(b.diff).toContain(' more context');
    expect(b.diff).toContain('-second change old');
    expect(b.diff).toContain('+second change new');
    expect(b.diff).toContain('+added line');
  });

  test('splits an all-add hunk at a blank added line', () => {
    // Whole-block addition (e.g. a new interface followed by a new function)
    // has no context lines, but a blank +line between the two paragraphs is
    // a natural paragraph boundary.
    const diff = [
      '@@ -0,0 +1,8 @@',
      '+interface Foo {',
      '+  bar: string;',
      '+}',
      '+',
      '+function baz() {',
      '+  return 1;',
      '+}',
      '+',
    ].join('\n');
    const hunks = parseHunks(`diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n${diff}\n`);
    const split = splitHunk(hunks[0]);
    expect(split).not.toBeNull();
    const [a, b] = split!;
    expect(a.diff).toContain('+interface Foo {');
    expect(a.diff).toContain('+}');
    expect(a.diff).not.toContain('+function baz');
    expect(b.diff).toContain('+function baz() {');
    // Line ranges should correctly reflect new-file positions in each half.
    expect(a.lines).toBe('1-4');
    expect(b.lines).toBe('5-8');
  });

  test('returns null when the hunk has no interior context between changes', () => {
    const diff = [
      '@@ -10,4 +10,4 @@',
      ' context before',
      '-old',
      '+new',
      ' context after',
    ].join('\n');
    const hunks = parseHunks(`diff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n${diff}\n`);
    expect(splitHunk(hunks[0])).toBeNull();
  });

  test('splits a summary hunk at the first blank-line boundary', () => {
    const [h] = summaryHunksFromText('para one.\n\npara two.\n\npara three.');
    const split = splitHunk(h);
    expect(split).not.toBeNull();
    const [a, b] = split!;
    expect(a.kind).toBe('summary');
    expect(a.diff).toBe('para one.');
    // Second half keeps the remaining paragraphs + their blank-line separator,
    // so another press of `s` can atomize it further.
    expect(b.diff).toContain('para two.');
    expect(b.diff).toContain('para three.');
    expect(b.diff).toMatch(/para two\.\s*\n\s*\n\s*para three\./);
  });

  test('splits the same summary progressively on repeated calls', () => {
    const [h0] = summaryHunksFromText('one.\n\ntwo.\n\nthree.');
    const first = splitHunk(h0)!;
    expect(first[0].diff).toBe('one.');
    const second = splitHunk(first[1])!;
    expect(second[0].diff).toBe('two.');
    expect(second[1].diff).toBe('three.');
    expect(splitHunk(second[0])).toBeNull();
  });

  test('returns null when summary has no blank-line boundary', () => {
    const [h] = summaryHunksFromText('just one paragraph');
    expect(splitHunk(h)).toBeNull();
  });

  test('prefers a TS semantic boundary (function/class) over the first soft boundary', () => {
    // A hunk with an earlier context-line "soft" boundary AND a later semantic
    // boundary (new function). The soft-boundary splitter would have split at
    // the empty context line — the semantic splitter should prefer the
    // function boundary so each half is a self-contained declaration.
    const diff = [
      '@@ -10,8 +10,9 @@',
      '-export const a = 1;',
      '+export const a = 2;',
      ' ',
      ' // unrelated context line',
      ' ',
      '-function bar() { return 1; }',
      '+function bar() { return 2; }',
      '+function baz() { return 3; }',
    ].join('\n');
    const hunks = parseHunks(`diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n${diff}\n`);
    const split = splitHunk(hunks[0]);
    expect(split).not.toBeNull();
    const [a, b] = split!;
    expect(a.diff).toContain('+export const a = 2;');
    expect(a.diff).not.toContain('function bar');
    expect(b.diff).toContain('-function bar() { return 1; }');
    expect(b.diff).toContain('+function baz() { return 3; }');
  });

  test('matches a semantic boundary on an added (+) line', () => {
    // All-add hunk with two top-level functions — no context lines at all,
    // so the soft-boundary splitter would have to rely on a blank +line.
    // Semantic split should find "function bar" directly even without a
    // blank separator.
    const diff = [
      '@@ -0,0 +1,4 @@',
      '+function foo() { return 1; }',
      '+const x = 1;',
      '+function bar() { return 2; }',
      '+const y = 2;',
    ].join('\n');
    const hunks = parseHunks(`diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n${diff}\n`);
    const split = splitHunk(hunks[0]);
    expect(split).not.toBeNull();
    const [a, b] = split!;
    expect(a.diff).toContain('+function foo');
    expect(a.diff).not.toContain('function bar');
    expect(b.diff).toContain('+function bar');
  });

  test('matches a semantic boundary on a removed (-) line', () => {
    // When a function is being deleted, splitting at the start of the removal
    // is still meaningful — the removed function is a logical unit.
    const diff = [
      '@@ -10,5 +10,1 @@',
      ' const header = 1;',
      '-function toDelete() {',
      '-  return 42;',
      '-}',
      '-const trailing = 2;',
    ].join('\n');
    const hunks = parseHunks(`diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n${diff}\n`);
    const split = splitHunk(hunks[0]);
    expect(split).not.toBeNull();
    const [a, b] = split!;
    expect(a.diff).toContain('-function toDelete');
    expect(b.diff).toContain('-const trailing = 2;');
  });

  test('splits Python at def/class boundary', () => {
    const diff = [
      '@@ -10,4 +10,5 @@',
      '-def foo():',
      '+def foo():',
      '+    return 1',
      ' ',
      '-def bar():',
      '+def bar():',
      '+    return 2',
    ].join('\n');
    const hunks = parseHunks(`diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n${diff}\n`);
    const split = splitHunk(hunks[0]);
    expect(split).not.toBeNull();
    const [a, b] = split!;
    expect(a.diff).toContain('+def foo():');
    expect(a.diff).not.toContain('def bar');
    expect(b.diff).toContain('+def bar():');
  });

  test('splits Markdown at heading boundary', () => {
    const diff = [
      '@@ -1,6 +1,6 @@',
      '-# Old title',
      '+# New title',
      ' some body',
      ' ',
      '-## Section B',
      '+## Section B2',
    ].join('\n');
    const hunks = parseHunks(`diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n${diff}\n`);
    const split = splitHunk(hunks[0]);
    expect(split).not.toBeNull();
    const [a, b] = split!;
    expect(a.diff).toContain('+# New title');
    expect(a.diff).not.toContain('Section B');
    expect(b.diff).toContain('+## Section B2');
  });

  test('keeps JSDoc attached to the function that follows it', () => {
    // Without attachment the splitter would land on '+function bar' and
    // leave its JSDoc in the first half, stranded from the declaration
    // it documents.
    const diff = [
      '@@ -10,2 +10,8 @@',
      '-function foo() { return 1; }',
      '+function foo() { return 2; }',
      ' ',
      '+/**',
      '+ * Computes bar.',
      '+ * @returns number',
      '+ */',
      '+function bar() { return 2; }',
    ].join('\n');
    const hunks = parseHunks(`diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n${diff}\n`);
    const split = splitHunk(hunks[0]);
    expect(split).not.toBeNull();
    const [a, b] = split!;
    expect(a.diff).toContain('+function foo() { return 2; }');
    expect(a.diff).not.toContain('/**');
    expect(a.diff).not.toContain('function bar');
    // The JSDoc block and the function should stay together in the second half.
    expect(b.diff).toContain('+/**');
    expect(b.diff).toContain('+ * Computes bar.');
    expect(b.diff).toContain('+ */');
    expect(b.diff).toContain('+function bar() { return 2; }');
  });

  test('keeps decorators attached to the class/function they annotate', () => {
    const diff = [
      '@@ -10,2 +10,7 @@',
      '-const x = 1;',
      '+const x = 2;',
      ' ',
      '+@Component({ selector: "app-foo" })',
      '+@Injectable()',
      '+class FooComponent {',
      '+  constructor() {}',
      '+}',
    ].join('\n');
    const hunks = parseHunks(`diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n${diff}\n`);
    const split = splitHunk(hunks[0]);
    expect(split).not.toBeNull();
    const [a, b] = split!;
    expect(a.diff).toContain('+const x = 2;');
    expect(a.diff).not.toContain('@Component');
    expect(a.diff).not.toContain('class FooComponent');
    expect(b.diff).toContain('+@Component');
    expect(b.diff).toContain('+@Injectable()');
    expect(b.diff).toContain('+class FooComponent');
  });

  test('unknown extension falls back to soft-boundary splitter', () => {
    // A .xyz file has no semantic pattern — should behave like the original
    // splitHunk: split at interior context between change groups.
    const diff = [
      '@@ -10,6 +10,7 @@',
      '-first change old',
      '+first change new',
      ' context in middle',
      ' more context',
      '-second change old',
      '+second change new',
      '+added line',
    ].join('\n');
    const hunks = parseHunks(`diff --git a/x.xyz b/x.xyz\n--- a/x.xyz\n+++ b/x.xyz\n${diff}\n`);
    const split = splitHunk(hunks[0]);
    expect(split).not.toBeNull();
    const [a, b] = split!;
    expect(a.diff).toContain('-first change old');
    expect(a.diff).not.toContain('-second change old');
    expect(b.diff).toContain('-second change old');
  });
});
