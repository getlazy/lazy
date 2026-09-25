import { describe, test, expect } from 'bun:test';
import {
  isMermaidOpenFence,
  isFenceClose,
  wrapMermaidFence,
  findMermaidDiffBlocks,
  mermaidDiffIndex,
  mermaidDiffRowHtml,
  mermaidEnhanceScript,
  MERMAID_ASSET_PATH,
  MERMAID_MAX_SOURCE_CHARS,
  bundledMermaidJs,
} from '../../src/server/mermaid';
import { parseUnifiedDiff, renderReviewDiff } from '../../src/server/review-diff';
import { renderMarkdown } from '../../src/server/markdown';
import { bundledStylesheet } from '../../src/server/styles';

describe('mermaid fence detection', () => {
  test('recognises mermaid open fences with optional indent and language case', () => {
    expect(isMermaidOpenFence('```mermaid')).toBe(true);
    expect(isMermaidOpenFence('``` mermaid')).toBe(true);
    expect(isMermaidOpenFence('```Mermaid')).toBe(true);
    expect(isMermaidOpenFence('  ```mermaid')).toBe(true);
    expect(isMermaidOpenFence('```mermaid flowchart')).toBe(true);
    expect(isMermaidOpenFence('```ts')).toBe(false);
    expect(isMermaidOpenFence('// ```mermaid')).toBe(false);
    expect(isMermaidOpenFence('```')).toBe(false);
  });

  test('recognises bare close fences only', () => {
    expect(isFenceClose('```')).toBe(true);
    expect(isFenceClose('```  ')).toBe(true);
    expect(isFenceClose('  ```')).toBe(true);
    expect(isFenceClose('```ts')).toBe(false);
    expect(isFenceClose('```mermaid')).toBe(false);
  });
});

describe('wrapMermaidFence (markdown path)', () => {
  test('emits the shared widget with escaped source and a language-mermaid code block', () => {
    const html = wrapMermaidFence('flowchart TD\n  A-->B');
    expect(html).toContain('data-lz-mermaid=');
    expect(html).toContain('class="language-mermaid"');
    expect(html).toContain('flowchart TD\n  A--&gt;B');
    expect(html).toContain('data-lz-mermaid-view="diagram"');
    expect(html).toContain('data-lz-mermaid-view="source"');
  });

  test('renderMarkdown routes mermaid fences through the wrapper', () => {
    const html = renderMarkdown('```mermaid\nflowchart TD\n  A-->B\n```');
    expect(html).toContain('data-lz-mermaid=');
    expect(html).toContain('class="language-mermaid"');
    // Non-mermaid fences stay as plain <pre><code>
    expect(renderMarkdown('```ts\nconst x = 1;\n```')).toBe(
      '<pre><code class="language-ts">const x = 1;</code></pre>',
    );
  });

  test('escapes hostile content in the fence body', () => {
    const html = wrapMermaidFence('flowchart TD\n  A["<script>alert(1)</script>"]');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('findMermaidDiffBlocks (post-image complete fences)', () => {
  test('finds an unchanged context fence', () => {
    const files = parseUnifiedDiff(`diff --git a/docs/flow.md b/docs/flow.md
--- a/docs/flow.md
+++ b/docs/flow.md
@@ -1,5 +1,5 @@
 \`\`\`mermaid
 flowchart TD
-  A-->B
+  A-->C
 \`\`\`
`);
    const blocks = findMermaidDiffBlocks(files[0]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('flowchart TD\n  A-->C');
  });

  test('finds a newly added fence in a non-markdown file', () => {
    const files = parseUnifiedDiff(`diff --git a/src/cli.ts b/src/cli.ts
--- a/src/cli.ts
+++ b/src/cli.ts
@@ -1,2 +1,7 @@
 const x = 1;
+/*
+\`\`\`mermaid
+flowchart TD
+  A-->B
+\`\`\`
+*/
`);
    const blocks = findMermaidDiffBlocks(files[0]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toContain('flowchart TD');
  });

  // INVARIANT: a mid-edit incomplete fence must NOT get a presentation row.
  // Rendering half a diagram as if it were valid would lie to the reviewer;
  // source-only is the correct degradation.
  test('ignores an incomplete (unclosed) post-image fence', () => {
    const files = parseUnifiedDiff(`diff --git a/a.md b/a.md
--- a/a.md
+++ b/a.md
@@ -1,3 +1,4 @@
 \`\`\`mermaid
 flowchart TD
-  A-->B
+  A-->C
+  D-->E
`);
    expect(findMermaidDiffBlocks(files[0])).toHaveLength(0);
  });

  test('ignores an empty fence body', () => {
    const files = parseUnifiedDiff(`diff --git a/a.md b/a.md
--- a/a.md
+++ b/a.md
@@ -1,2 +1,2 @@
+\`\`\`mermaid
+\`\`\`
`);
    expect(findMermaidDiffBlocks(files[0])).toHaveLength(0);
  });

  test('skips fences larger than the soft size cap', () => {
    const huge = 'x'.repeat(MERMAID_MAX_SOURCE_CHARS + 1);
    const files = parseUnifiedDiff(`diff --git a/a.md b/a.md
--- a/a.md
+++ b/a.md
@@ -1,1 +1,4 @@
+\`\`\`mermaid
+${huge}
+\`\`\`
`);
    expect(findMermaidDiffBlocks(files[0])).toHaveLength(0);
  });
});

describe('renderReviewDiff mermaid presentation', () => {
  test('emits a presentation row and tags source lines without dropping anchors', () => {
    const files = parseUnifiedDiff(`diff --git a/docs/flow.md b/docs/flow.md
--- a/docs/flow.md
+++ b/docs/flow.md
@@ -1,4 +1,4 @@
 \`\`\`mermaid
 flowchart TD
-  A-->B
+  A-->C
 \`\`\`
`);
    const html = renderReviewDiff(files, new Map());
    expect(html).toContain('data-lz-mermaid=');
    expect(html).toContain('data-lz-mermaid-src=');
    expect(html).toContain('rv-mermaid-row');
    // Per-line anchors survive on the fence lines themselves.
    expect(html).toContain('data-side=');
    expect(html).toContain('data-line=');
    expect(html).toContain('rv-add-comment');
    // No Shadow DOM regression.
    expect(html).not.toContain('<diffs-container>');
  });

  test('mermaidDiffIndex tags only post-image lines of the fence', () => {
    const files = parseUnifiedDiff(`diff --git a/a.md b/a.md
--- a/a.md
+++ b/a.md
@@ -1,4 +1,4 @@
 \`\`\`mermaid
 flowchart TD
-  A-->B
+  A-->C
 \`\`\`
`);
    const blocks = findMermaidDiffBlocks(files[0]);
    const { srcOf, afterClose } = mermaidDiffIndex(files[0], blocks);
    expect(blocks).toHaveLength(1);
    expect(afterClose.size).toBe(1);
    // The deleted line is not tagged — it is not part of the post-image fence.
    for (const [key, id] of srcOf) {
      expect(id).toBe(blocks[0].id);
      const [hi, li] = key.split(':').map(Number);
      expect(files[0].hunks[hi].lines[li].kind).not.toBe('del');
    }
  });

  test('mermaidDiffRowHtml ships hidden and carries escaped source', () => {
    const row = mermaidDiffRowHtml({
      id: 'm-test',
      source: 'A-->B & <C>',
      openHunk: 0,
      openLine: 0,
      closeHunk: 0,
      closeLine: 2,
    });
    expect(row).toContain('hidden');
    expect(row).toContain('data-lz-mermaid="m-test"');
    expect(row).toContain('A--&gt;B &amp; &lt;C&gt;');
  });
});

describe('mermaid asset and enhancer', () => {
  test('bundled mermaid.js is the vendored UMD build', () => {
    const js = bundledMermaidJs();
    expect(js.length).toBeGreaterThan(100_000);
    expect(js).toContain('globalThis["mermaid"]');
  });

  test('enhance script points at the asset route and uses strict security', () => {
    const script = mermaidEnhanceScript();
    expect(script).toContain(MERMAID_ASSET_PATH);
    expect(script).toContain("securityLevel: 'strict'");
    expect(script).toContain('data-lz-mermaid-view');
  });

  test('stylesheet includes mermaid presentation rules', () => {
    const css = bundledStylesheet();
    expect(css).toContain('.lz-mermaid');
    expect(css).toContain('tr.rv-mermaid-row');
  });
});
