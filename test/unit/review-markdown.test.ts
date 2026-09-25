import { describe, test, expect } from 'bun:test';
import {
  isMarkdownPath,
  markdownDiffKind,
  markdownSourceRequests,
  loadMarkdownSources,
  splitMarkdownBlocks,
  removedRuns,
  mapMarkdownRegions,
  renderMarkdownFile,
  renderMarkdownDocument,
  MAX_MARKDOWN_LINES,
  FOLD_MIN_LINES,
} from '../../src/server/review-markdown';
import {
  parseUnifiedDiff,
  renderReviewDiff,
  diffViewOptionsHtml,
  diffViewScript,
  presentedViewScript,
} from '../../src/server/review-diff';

function fileOf(patch: string) {
  const files = parseUnifiedDiff(patch);
  expect(files.length).toBe(1);
  return files[0];
}

const ADDED = `diff --git a/docs/new.md b/docs/new.md
new file mode 100644
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1,3 @@
+# Title
+
+Body text.
`;

const REMOVED = `diff --git a/docs/old.md b/docs/old.md
deleted file mode 100644
--- a/docs/old.md
+++ /dev/null
@@ -1,2 +0,0 @@
-# Gone
-Was here.
`;

/**
 * Patches are built line by line because a blank CONTEXT line in a unified diff
 * is a line containing one space — a truly empty line is not part of the hunk.
 * A markdown fixture is mostly blank lines, so writing them as a template
 * literal quietly produces a diff that means something else.
 */
const ctx = (s = '') => ` ${s}`;

// One paragraph edited in the middle of a document; everything else untouched.
const MIDDLE_EDIT = [
  'diff --git a/docs/guide.md b/docs/guide.md',
  '--- a/docs/guide.md',
  '+++ b/docs/guide.md',
  // Starts at line 7 so the hunk and GUIDE_TEXT below describe the same file.
  '@@ -7,7 +7,7 @@',
  ctx('line seven'),
  ctx(),
  '-old middle paragraph',
  '+new middle paragraph',
  ctx(),
  ctx('line eleven'),
  ctx('line twelve'),
  '',
].join('\n');

const TABLE_EDIT = `diff --git a/docs/t.md b/docs/t.md
--- a/docs/t.md
+++ b/docs/t.md
@@ -1,4 +1,4 @@
 | a | b |
 | - | - |
-| 1 | 2 |
+| 1 | 9 |
 | 3 | 4 |
`;
const TABLE_TEXT = '| a | b |\n| - | - |\n| 1 | 9 |\n| 3 | 4 |\n';

/**
 * The shape that broke on the real page: a heading stack (`#` / `##` / `###`)
 * labelling long top-level bullet lists, with one bullet added to two of the
 * sections. The whole CHANGELOG is this, repeated a hundred times over.
 *
 * Both hunks add exactly one line. Everything else — 3 of 4 "Added" bullets,
 * the entire "Changed" section, 1 of 2 "Fixed" bullets — is untouched context.
 */
const CHANGELOG_TEXT = [
  '# Changelog', //                                                        1
  '', //                                                                   2
  '## 0.22.1141 - 2026-09-05', //                                          3
  '', //                                                                   4
  '### Added', //                                                          5
  '', //                                                                   6
  '- **New entry** — the bullet this patch adds', //                       7  ADDED
  '- **Existing one** — was already here', //                              8
  '- **Existing two** — also already here', //                             9
  '', //                                                                  10
  '### Changed', //                                                       11
  '', //                                                                  12
  '- **Untouched one** — nothing happened here', //                       13
  '- **Untouched two** — nor here', //                                    14
  '- **Untouched three** — nor here either', //                           15
  '', //                                                                  16
  '### Fixed', //                                                         17
  '', //                                                                  18
  '- **New fix** — the second bullet this patch adds', //                 19  ADDED
  '- **Old fix** — was already here', //                                  20
  '',
].join('\n');

const CHANGELOG_EDIT = [
  'diff --git a/CHANGELOG.md b/CHANGELOG.md',
  '--- a/CHANGELOG.md',
  '+++ b/CHANGELOG.md',
  '@@ -5,4 +5,5 @@',
  ctx('### Added'),
  ctx(),
  '+- **New entry** — the bullet this patch adds',
  ctx('- **Existing one** — was already here'),
  ctx('- **Existing two** — also already here'),
  '@@ -16,3 +17,4 @@',
  ctx('### Fixed'),
  ctx(),
  '+- **New fix** — the second bullet this patch adds',
  ctx('- **Old fix** — was already here'),
  '',
].join('\n');

describe('markdown path and change classification', () => {
  test('recognises markdown extensions, not their lookalikes', () => {
    expect(isMarkdownPath('docs/a.md')).toBe(true);
    expect(isMarkdownPath('README.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('site/page.mdx')).toBe(true);
    expect(isMarkdownPath('src/markdown.ts')).toBe(false);
    expect(isMarkdownPath('a.md.ts')).toBe(false);
  });

  test('classifies added, removed and modified from the hunks', () => {
    expect(markdownDiffKind(fileOf(ADDED))).toBe('added');
    expect(markdownDiffKind(fileOf(REMOVED))).toBe('removed');
    expect(markdownDiffKind(fileOf(MIDDLE_EDIT))).toBe('modified');
  });

  test('a removed file is read from the OLD side, under its pre-image path', () => {
    const reqs = markdownSourceRequests(parseUnifiedDiff(REMOVED + ADDED));
    expect(reqs).toEqual([
      { path: 'docs/old.md', side: 'old', diffPath: 'docs/old.md', kind: 'removed' },
      { path: 'docs/new.md', side: 'new', diffPath: 'docs/new.md', kind: 'added' },
    ]);
  });

  test('non-markdown files are never fetched', () => {
    const patch = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-a
+b
`;
    expect(markdownSourceRequests(parseUnifiedDiff(patch))).toEqual([]);
  });
});

describe('loadMarkdownSources', () => {
  test('reads a file to EOF and hands back its text', async () => {
    const sources = await loadMarkdownSources(parseUnifiedDiff(ADDED), async () => ({
      lines: ['# Title', '', 'Body text.'],
      atEof: true,
    }));
    expect(sources.get('docs/new.md')?.text).toBe('# Title\n\nBody text.');
  });

  test('marks a file truncated rather than rendering half a document', async () => {
    // Never reaches EOF: every page comes back full and asking for more.
    const sources = await loadMarkdownSources(parseUnifiedDiff(ADDED), async (q) => ({
      lines: new Array(q.end - q.start + 1).fill('x'),
      atEof: false,
    }));
    const source = sources.get('docs/new.md')!;
    expect(source.truncated).toBe(true);
    expect(source.text).toBeNull();
    expect(renderMarkdownFile(fileOf(ADDED), source)).toBeNull();
  });

  test('a read failure costs the file its rendering, not the page', async () => {
    const sources = await loadMarkdownSources(parseUnifiedDiff(ADDED), async () => {
      throw new Error('path not in diff');
    });
    expect(sources.get('docs/new.md')).toEqual({ text: null });
    expect(renderMarkdownFile(fileOf(ADDED), sources.get('docs/new.md'))).toBeNull();
  });

  test('never asks for more than the render ceiling', async () => {
    const asked: number[] = [];
    await loadMarkdownSources(parseUnifiedDiff(ADDED), async (q) => {
      asked.push(q.end);
      return { lines: new Array(q.end - q.start + 1).fill('x'), atEof: false };
    });
    expect(Math.max(...asked)).toBe(MAX_MARKDOWN_LINES);
  });
});

describe('splitMarkdownBlocks', () => {
  test('every line of the file belongs to exactly one block', () => {
    const text = '# H\n\npara one\npara two\n\n- a\n- b\n\n> quote\n\n---\n\ntail\n';
    const blocks = splitMarkdownBlocks(text);
    let expected = 1;
    for (const b of blocks) {
      expect(b.start).toBe(expected);
      expect(b.end).toBeGreaterThanOrEqual(b.start);
      expected = b.end + 1;
    }
    // 13 content lines; the trailing newline is a terminator, not a line.
    expect(expected - 1).toBe(13);
  });

  test('a list run is one block, not one block per item', () => {
    const blocks = splitMarkdownBlocks('- a\n- b\n- c\n');
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toEqual({ start: 1, end: 3, text: '- a\n- b\n- c' });
  });

  test('a fence is one block even when it contains blank lines and prose', () => {
    const blocks = splitMarkdownBlocks('```js\nconst a = 1;\n\n# not a heading\n```\nafter\n');
    expect(blocks[0].start).toBe(1);
    expect(blocks[0].end).toBe(5);
    expect(blocks[1].text).toBe('after');
  });

  test('an unterminated fence runs to end of file and swallows nothing else', () => {
    // INVARIANT: an in-progress fence must not split into phantom blocks — the
    // reviewer would see the tail of the file rendered as prose it is not.
    const blocks = splitMarkdownBlocks('intro\n\n```sh\nlazy list\nstill inside\n');
    expect(blocks.length).toBe(2);
    expect(blocks[1]).toEqual({ start: 3, end: 5, text: '```sh\nlazy list\nstill inside' });
  });
});

describe('mapMarkdownRegions', () => {
  test('a pure addition marks only the added block, and folds the rest', () => {
    const patch = [
      'diff --git a/docs/guide.md b/docs/guide.md',
      '--- a/docs/guide.md',
      '+++ b/docs/guide.md',
      '@@ -1,3 +1,5 @@',
      ctx('# Guide'),
      ctx(),
      '+A brand new paragraph.',
      '+',
      ctx('old tail'),
      '',
    ].join('\n');
    const text = '# Guide\n\nA brand new paragraph.\n\nold tail\n';
    const regions = mapMarkdownRegions(fileOf(patch), text);
    const changed = regions.filter((r) => r.kind === 'changed');
    expect(changed.length).toBe(1);
    expect(changed[0].start).toBe(3);
    expect(changed[0].firstChangedLine).toBe(3);
    expect(regions.map((r) => r.kind)).toEqual(['unchanged', 'changed', 'unchanged']);
  });

  test('a pure deletion is a change, so it can never be folded away', () => {
    const patch = [
      'diff --git a/docs/guide.md b/docs/guide.md',
      '--- a/docs/guide.md',
      '+++ b/docs/guide.md',
      '@@ -1,5 +1,3 @@',
      ctx('# Guide'),
      ctx(),
      '-Deleted paragraph.',
      '-',
      ctx('tail'),
      '',
    ].join('\n');
    const text = '# Guide\n\ntail\n';
    const regions = mapMarkdownRegions(fileOf(patch), text);
    const changed = regions.filter((r) => r.kind === 'changed');
    expect(changed.length).toBe(1);
    // No added line to point at: the block is marked changed by its removal.
    expect(changed[0].firstChangedLine).toBeNull();
    expect(changed[0].removed.map((r) => r.lines)).toEqual([['Deleted paragraph.', '']]);
  });

  test('a middle-paragraph edit marks that paragraph and folds its neighbours', () => {
    const text = [
      'line one',
      '',
      'line three',
      '',
      'line five',
      '',
      'line seven',
      '',
      'new middle paragraph',
      '',
      'line eleven',
      'line twelve',
      '',
    ].join('\n');
    const regions = mapMarkdownRegions(fileOf(MIDDLE_EDIT), text);
    const changed = regions.filter((r) => r.kind === 'changed');
    expect(changed.length).toBe(1);
    expect(changed[0].firstChangedLine).toBe(9);
    // The paragraph it replaced is shown where it was removed from.
    expect(changed[0].removed[0].lines).toEqual(['old middle paragraph']);
  });

  test('an edit inside a table opens the whole table — the honest resolution', () => {
    const patch = TABLE_EDIT;
    const regions = mapMarkdownRegions(fileOf(patch), TABLE_TEXT);
    // A table has no markdown block syntax of its own here: its rows are one
    // paragraph, so the whole table is one region and none of it can be folded
    // away. Which ROW carries the accent is a separate, finer question — see
    // renderMarkdownFile below.
    expect(regions.length).toBe(1);
    expect(regions[0].kind).toBe('changed');
    expect(regions[0].start).toBe(1);
    expect(regions[0].end).toBe(4);
    // Only the edited row is reported as changed, though the region is all four.
    expect(regions[0].changedLines).toEqual([3]);
  });

  test('a deletion at the very top of the file anchors above line 1', () => {
    const patch = `diff --git a/docs/g.md b/docs/g.md
--- a/docs/g.md
+++ b/docs/g.md
@@ -1,3 +1,2 @@
-# Old title
 body
 tail
`;
    expect(removedRuns(fileOf(patch))).toEqual([{ afterLine: 0, lines: ['# Old title'] }]);
    const regions = mapMarkdownRegions(fileOf(patch), 'body\ntail\n');
    expect(regions[0].kind).toBe('changed');
    expect(regions[0].removed[0].afterLine).toBe(0);
  });
});

describe('renderMarkdownFile', () => {
  const added = { text: '# Title\n\nBody text.\n' };

  test('an added file renders whole, badged, and hidden until the toggle runs', () => {
    const html = renderMarkdownFile(fileOf(ADDED), added)!;
    expect(html).toContain('data-rv-show="presented"');
    expect(html).toContain('hidden');
    expect(html).toContain('markdown · added');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<p>Body text.</p>');
    // The escape hatch is part of the rendering, not an optional extra.
    expect(html).toContain('data-rv-show-source');
  });

  test('a removed file renders its last contents and says so', () => {
    const html = renderMarkdownFile(fileOf(REMOVED), { text: '# Gone\nWas here.\n' })!;
    expect(html).toContain('markdown · removed');
    expect(html).toContain('rv-md-whole-removed');
    expect(html).toContain('This file was deleted');
    expect(html).toContain('<h1>Gone</h1>');
  });

  test('a modified file folds unchanged stretches and accents the change', () => {
    const text = [
      'line one',
      '',
      'line three',
      '',
      'line five',
      '',
      'line seven',
      '',
      'new middle paragraph',
      '',
      'line eleven',
      'line twelve',
      '',
    ].join('\n');
    const html = renderMarkdownFile(fileOf(MIDDLE_EDIT), { text })!;
    expect(html).toContain('markdown · modified');
    expect(html).toContain('rv-md-fold');
    expect(html).toMatch(/\d+ unchanged lines/);
    expect(html).toContain('rv-md-changed');
    expect(html).toContain('<p class="rv-md-added">new middle paragraph</p>');
    // The paragraph it replaced, in place and marked as gone.
    expect(html).toContain('rv-md-removed');
    expect(html).toContain('old middle paragraph');
    // Commenting on a rendered block hands off to the source row it came from.
    expect(html).toContain('data-rv-show-anchor');
    expect(html).toContain('data-target="l-docs%2Fguide.md-new-9"');
  });

  test('one added bullet accents that bullet, not the list it landed in', () => {
    // The bug this reproduces: `splitMarkdownBlocks` makes a top-level list run
    // ONE block, so a region is the whole list — and painting the region green
    // reported a two-bullet CHANGELOG edit as a rewrite of every bullet on the
    // page. Folding is the region's job; accenting is the element's.
    const html = renderMarkdownFile(fileOf(CHANGELOG_EDIT), { text: CHANGELOG_TEXT })!;

    // Exactly the two added bullets are accented...
    expect((html.match(/rv-md-added/g) ?? []).length).toBe(2);
    expect(html).toContain('<li class="rv-md-added"><strong>New entry</strong>');
    expect(html).toContain('<li class="rv-md-added"><strong>New fix</strong>');
    // ...and their untouched neighbours, inside the same open region, are not.
    expect(html).toContain('<li><strong>Existing one</strong>');
    expect(html).toContain('<li><strong>Old fix</strong>');

    // Each list run is still ONE list: the document reads as the document.
    expect((html.match(/<ul>/g) ?? []).length).toBe(3);

    // Every heading that labels a change is visible, not folded away with the
    // quiet stretch above it — an unlabelled slab of bullets says nothing.
    const outsideFolds = html.replace(/<details[\s\S]*?<\/details>/g, '');
    expect(outsideFolds).toContain('<h1>Changelog</h1>');
    expect(outsideFolds).toContain('<h3>Added</h3>');
    expect(outsideFolds).toContain('<h3>Fixed</h3>');
    // The section nothing happened to still folds.
    expect(html).toContain('unchanged lines');
    expect(html).toContain('<h3>Changed</h3>');
  });

  test('an edited table row is accented on its own row, not across the table', () => {
    const html = renderMarkdownFile(fileOf(TABLE_EDIT), { text: TABLE_TEXT })!;
    expect((html.match(/rv-md-added/g) ?? []).length).toBe(1);
    expect(html).toContain('<tr class="rv-md-added"><td>1</td><td>9</td></tr>');
  });

  test('a short unchanged run is left in place rather than folded', () => {
    const patch = `diff --git a/docs/s.md b/docs/s.md
--- a/docs/s.md
+++ b/docs/s.md
@@ -1,2 +1,3 @@
 head
+added line
 tail
`;
    const html = renderMarkdownFile(fileOf(patch), { text: 'head\nadded line\ntail\n' })!;
    expect(html).toContain('rv-md-changed');
    expect(html).not.toContain('rv-md-fold');
    expect(FOLD_MIN_LINES).toBeGreaterThan(1);
  });

  test('comments hidden in the raw pane are counted, never silently dropped', () => {
    const html = renderMarkdownFile(fileOf(ADDED), added, { threadCount: 2 })!;
    expect(html).toContain('2 comments on this file');
  });

  test('a mermaid fence goes through the shared enhancer', () => {
    const html = renderMarkdownFile(fileOf(ADDED), {
      text: '# Title\n\n```mermaid\ngraph TD;\nA-->B;\n```\n',
    })!;
    expect(html).toContain('data-lz-mermaid');
  });
});

describe('the presented pane and its escape hatch', () => {
  test('renderReviewDiff wraps the line diff as the source pane when a pane exists', () => {
    const file = fileOf(ADDED);
    const pane = renderMarkdownFile(file, { text: '# Title\n\nBody text.\n' })!;
    const html = renderReviewDiff([file], new Map(), {
      presentedPanes: new Map([[file.path, pane]]),
    });
    expect(html).toContain('data-rv-show="presented"');
    expect(html).toContain('data-rv-show="source"');
    // The source table is untouched: line anchors still exist, so comments and
    // permalinks keep working exactly as before.
    expect(html).toContain('id="l-docs%2Fnew.md-new-1"');
    // ...and every element opened is closed.
    expect((html.match(/<div/g) ?? []).length).toBe((html.match(/<\/div>/g) ?? []).length);
  });

  test('a file with no pane renders exactly as it did before', () => {
    const file = fileOf(ADDED);
    expect(renderReviewDiff([file], new Map(), { presentedPanes: new Map() })).toBe(
      renderReviewDiff([file], new Map()),
    );
  });

  test('the toolbar offers the switch only on a page with something presented', () => {
    expect(diffViewOptionsHtml()).not.toContain('data-rv-mode="presented"');
    const withPane = diffViewOptionsHtml({ presented: true });
    expect(withPane).toContain('data-rv-mode="presented"');
    expect(withPane).toContain('data-rv-value="presented"');
    expect(withPane).toContain('data-rv-value="source"');
    // Nothing in the control names markdown: it is the first file type with a
    // presented form, deliberately not the last.
    expect(withPane.toLowerCase()).not.toContain('markdown');
  });

  test('the view script drives the presented mode like any other view state', () => {
    const script = diffViewScript('#rv-root');
    expect(script).toContain(presentedViewScript().trim().split('\n')[0].trim());
    expect(script).toContain("presented: { key: 'lazy:diffpresented', def: 'presented'");
    expect(script).toContain('function applyPresented');
  });
});

describe('renderMarkdownDocument — the document without the daemon page chrome', () => {
  // INVARIANT: a remote client (Lazy Teams) gets the rendered document, its
  // change kind and its comment anchor from the daemon, and wraps its OWN
  // header around it. The body must therefore carry none of this page's
  // controls, and the anchor must be the one this page itself comments on —
  // a client that recomputed either would be porting the rule.
  test('an added file: whole document, anchor on its first new line, no chrome', () => {
    const doc = renderMarkdownDocument(fileOf(ADDED), { text: '# Title\n\nBody text.\n' }, { allowComments: false });
    expect(doc).not.toBeNull();
    expect(doc!.kind).toBe('added');
    expect(doc!.anchor).toEqual({ side: 'new', line: 1 });
    expect(doc!.bodyHtml).toContain('Body text.');
    expect(doc!.bodyHtml).not.toContain('rv-md-head');
    expect(doc!.bodyHtml).not.toContain('<button');
  });

  test('a removed file anchors on the old side and says it was deleted', () => {
    const doc = renderMarkdownDocument(fileOf(REMOVED), { text: '# Gone\nWas here.\n' }, { allowComments: false });
    expect(doc!.kind).toBe('removed');
    expect(doc!.anchor).toEqual({ side: 'old', line: 1 });
    expect(doc!.noteHtml).toContain('deleted');
  });

  test('a changed block names its first added line for a per-passage affordance', () => {
    const doc = renderMarkdownDocument(fileOf(TABLE_EDIT), { text: TABLE_TEXT }, { allowComments: false });
    expect(doc!.kind).toBe('modified');
    expect(doc!.bodyHtml).toContain('data-rv-md-line="3"');
    expect(doc!.bodyHtml).not.toContain('rv-md-comment');
  });

  test('a mermaid fence in the document arrives as a diagram block', () => {
    const text = '# D\n\n```mermaid\ngraph TD; A-->B\n```\n';
    const patch = [
      'diff --git a/d.md b/d.md', 'new file mode 100644', '--- /dev/null', '+++ b/d.md', '@@ -0,0 +1,5 @@',
      ...text.trimEnd().split('\n').map((l) => `+${l}`), '',
    ].join('\n');
    const doc = renderMarkdownDocument(fileOf(patch), { text }, { allowComments: false });
    expect(doc!.bodyHtml).toContain('data-lz-mermaid=');
    expect(doc!.bodyHtml).toContain('graph TD; A--&gt;B');
  });

  test('the daemon page pane is the document plus its chrome', () => {
    const pane = renderMarkdownFile(fileOf(ADDED), { text: '# Title\n\nBody text.\n' });
    expect(pane).toContain('rv-md-head');
    expect(pane).toContain('rv-md-ask');
  });
});
