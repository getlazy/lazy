/**
 * Three complaints, one theme: while reviewing, the page loses your place or
 * your typing.
 *
 *   1. The current card's header scrolled away, so a long file gave no answer
 *      to "what am I looking at, and how do I accept it".
 *   2. Expanding context destroyed a comment that was being typed.
 *   3. A presented surface (a rendered document, a diagram, a screenshot)
 *      offered no way to ask about it, and did not say that Source was where
 *      commenting lived.
 *
 * SCOPE, stated plainly: this project has no DOM harness, so what runs here is
 * the SERVER-SIDE rendering — the markup contract and the stylesheet. That is a
 * real contract (the islands address exactly these classes and attributes), but
 * it is not the behaviour, and an assertion that a script's text contains a
 * helper's NAME passes while that helper does nothing. So the behaviour is
 * tested where it can actually be executed, and this file stays out of its way:
 *
 *   - the draft round trip, two tabs, and the script-tag payload:
 *     test/e2e/review-line-drafts.test.ts (a real daemon, real requests);
 *   - the key format, on both sides of the wire:
 *     test/unit/review-draft-key.test.ts (it runs the island's own mirror);
 *   - the escaping itself: test/unit/script-json-escape.test.ts;
 *   - what only a browser can show — the header parked under the tabs, the
 *     caret surviving a poll — is in the task's report as screenshots.
 */

import { describe, test, expect } from 'bun:test';
import { reviewTaskHtml, reviewScript } from '../../src/server/review';
import { reviewNavigationScript } from '../../src/server/review-navigation';
import { diffViewScript, renderReviewDiff, parseUnifiedDiff } from '../../src/server/review-diff';
import { renderMarkdownFile } from '../../src/server/review-markdown';
import { screenshotsCardHtml } from '../../src/server/review-presentation';
import { wrapMermaidFence } from '../../src/server/mermaid';
import { bundledStylesheet } from '../../src/server/styles';
import type { Task } from '../../src/types';

const PATCH = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
`;

const MD_PATCH = `diff --git a/docs/notes.md b/docs/notes.md
--- a/docs/notes.md
+++ b/docs/notes.md
@@ -1,3 +1,3 @@
 # Notes
-old line
+new line
`;

function task(): Task {
  return {
    id: 'task1234abcd',
    code: 'demo-task',
    goal: 'Do the thing',
    prompt: 'The prompt body',
    type: 'task',
    status: 'blocked',
    priority: 'normal',
    created_at: 1,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata: null,
  } as unknown as Task;
}

describe('the current card keeps its header on screen', () => {
  // INVARIANT: a card header is sticky in CSS, not by scroll-driven JS. CSS
  // swaps one file's header for the next one's for free as you scroll out of
  // one section and into another; a script would have to re-derive that on
  // every scroll event and would be wrong at every boundary.
  test('file and card headers stick, at the measured offset', () => {
    const css = bundledStylesheet();
    const fileHead = css.slice(css.indexOf('.rv-file-head {'), css.indexOf('.rv-file-path'));
    expect(fileHead).toContain('position: sticky');
    expect(fileHead).toContain('top: var(--lz-sticky-top, 0px)');

    const cardHead = css.slice(css.indexOf('.md-card-head {'), css.indexOf('.md-card[data-collapsed'));
    expect(cardHead).toContain('position: sticky');
    expect(cardHead).toContain('top: var(--lz-sticky-top, 0px)');
  });

  // INVARIANT: .rv-file must not be a scroll container. `overflow: hidden` on
  // it makes the card itself the sticky header's scrollport — and that
  // scrollport never scrolls, so the header sticks to nothing. The diff's own
  // horizontal overflow belongs to .rv-diff-scroll, one level in.
  test('a file card does not clip its own overflow', () => {
    const css = bundledStylesheet();
    const rule = css.slice(css.indexOf('.rv-file {'), css.indexOf('.rv-file-head {'));
    expect(rule).not.toContain('overflow: hidden');
    expect(css).toContain('.rv-diff-scroll { overflow-x: auto; }');
  });

  // INVARIANT: a sticky header must not eat the thing it was made sticky to
  // keep visible. Without scroll-margin, following a permalink parks the target
  // UNDERNEATH the header — the feedback inverted. `:target` covers every
  // fragment link; the rest cover what scripts scroll to with no hash.
  test('everything the page scrolls to clears the stuck chrome', () => {
    const css = bundledStylesheet();
    const marginFor = (selector: string): string => {
      // The rule that declares scroll-margin-top for this selector, whether it
      // is alone or in a list.
      const re = new RegExp(
        `(^|,)\\s*${selector.replace(/[.[\]^$*+?()|{}\\]/g, '\\$&')}\\s*(,[^{]*)?\\{[^}]*?scroll-margin-top:([^;]+);`,
        'm',
      );
      const m = re.exec(css);
      return m ? m[3].trim() : '';
    };

    // Every anchor kind the review surfaces hand out links to.
    for (const selector of [
      ':target', // file sections, threads, raised panels, anything with an id
      '.rv-viewable', // a file card or a markdown card
      'tr.rv-line', // a diff line in unified
      'td.rv-code', // the same line in side-by-side
      'tr.rv-thread-row', // a comment thread
      '[id^="turn-"]', // a turn permalink
      '.chunk-note', // a comment or journal entry inside a chunk
      '.rv-pres-group', // an agent walkthrough group
    ]) {
      expect(marginFor(selector)).toContain('var(--lz-sticky-top');
    }
  });

  // The height of the tab strip is the one thing the stylesheet cannot know.
  // The navigation island measures it, publishes it as --lz-sticky-top, and
  // uses the SAME number when it scrolls — otherwise next/previous parks the
  // header it just made sticky underneath the strip that is covering it.
  test('the navigation island measures the stuck chrome and scrolls below it', () => {
    const js = reviewNavigationScript();
    expect(js).toContain("'.lz-tabs'");
    expect(js).toContain("setProperty('--lz-sticky-top'");
    expect(js).toContain('- stickyTop() - 8');
    // Re-measured when the strip is replaced by an in-place tab switch. The
    // hook re-points the toolbar observer as well as re-measuring, which is
    // why it is not publishStickyTop itself — the property this pins is that
    // the hook exists and re-measures, not which function it names.
    expect(js).toContain('window.lzRefreshStickyTop = refreshStickyTop;');
    expect(js).toContain('function refreshStickyTop()');
    expect(js).toContain('publishStickyTop();');
  });

  // INVARIANT: the stuck chrome is a STACK, and each level parks under the one
  // above it. The tab strip sticks at 0; the diff toolbar sticks under the
  // strip (--lz-strip-top); card headers stick under BOTH (--lz-sticky-top).
  //
  // Why this is an invariant and not a detail: the toolbar was made sticky at
  // --lz-sticky-top — the SAME offset the card headers use — and since it is
  // opaque and a z-index above them, every file header parked itself exactly
  // underneath the toolbar and was invisible from the first scroll onwards.
  // The header was still sticky and still correct; it just could not be seen,
  // which is indistinguishable from "the header scrolled away". Two levels
  // sharing one offset is the bug, so the two offsets must stay distinct.
  test('the toolbar parks under the strip, and cards park under the toolbar', () => {
    const css = bundledStylesheet();
    const start = css.indexOf('.rv-viewopts {');
    expect(start).toBeGreaterThan(-1);
    const viewopts = css.slice(start, css.indexOf('}', start));
    expect(viewopts).toContain('position: sticky');
    expect(viewopts).toContain('top: var(--lz-strip-top, 0px)');
    // The level below it must NOT be what the toolbar parks under.
    expect(viewopts).not.toContain('top: var(--lz-sticky-top');

    // And the island publishes both, measuring the toolbar as stuck chrome.
    const js = reviewNavigationScript();
    expect(js).toContain("setProperty('--lz-strip-top'");
    expect(js).toContain("setProperty('--lz-sticky-top'");
    expect(js).toContain("var STICKY_TOOLBAR = '[data-rv-viewopts]'");
    expect(js).toContain('return stripTop() + stuckHeight(STICKY_TOOLBAR);');
  });
});

describe('a half-typed comment survives the page moving underneath it', () => {
  // WHERE THE REAL COVERAGE IS. The behaviour — written, handed back, cleared,
  // one tab not erasing another's — is a server round trip, and it is executed
  // in test/e2e/review-line-drafts.test.ts against a running daemon. The key
  // format is executed on both sides in test/unit/review-draft-key.test.ts.
  // What is left here is the emitted MARKUP those rely on: assertions about a
  // script's source text pass while the behaviour is broken, so this file does
  // as little of that as it can.

  test('the stored drafts are seeded server-side, so a reload keeps them', () => {
    const js = reviewScript('task1234abcd', {
      lineDrafts: { 'new 12 - src/foo.ts': 'why this cast?' },
    });
    expect(js).toContain('var LINE_DRAFTS = {"new 12 - src/foo.ts":"why this cast?"}');
    // And the review page passes what it loaded from the task's draft.
    const html = reviewTaskHtml(task(), PATCH, [], undefined, undefined, [], {
      lineDrafts: { 'new 1 - src/foo.ts': 'still typing' },
    });
    expect(html).toContain('"new 1 - src/foo.ts":"still typing"');
  });

  // The form row carries the class every other handler identifies it by. It
  // did not, so closeForms() matched nothing, the side-by-side rebuild could
  // not skip it, and the stylesheet rule for it was dead.
  test('an open form is a marked row', () => {
    expect(reviewScript('t')).toContain("row.className = 'rv-form-row'");
  });

  // Expanding context inside side-by-side rebuilds the body from the stashed
  // unified one, which never held the open box. The event is the CONTRACT
  // between the two islands — the diff island announces, the review island
  // re-opens — so the announcement is asserted; that it is dispatched from the
  // rebuild is what the browser check in the task's report exercises.
  test('expanding context announces the rebuild the review island listens for', () => {
    const js = diffViewScript('#rv-changes', '/api/review/t/file-lines');
    expect(js).toContain("root.dispatchEvent(new CustomEvent('rv:layout'");
    // document, not root: reviewScript is page-level and never re-runs, so a
    // listener bound to a captured root element would go stale the moment an
    // in-place switch replaces #rv-changes/#rv-root (see currentRoot() in
    // review.ts). document outlives every tab body and needs no re-binding.
    expect(reviewScript('t')).toContain("document.addEventListener('rv:layout'");
  });
});

describe('a presented surface can be asked about', () => {
  const mdFile = parseUnifiedDiff(MD_PATCH)[0];
  const source = { text: '# Notes\nnew line\n' };

  test('a rendered document offers a comment box and explains Source', () => {
    const pane = renderMarkdownFile(mdFile, source)!;
    expect(pane).toContain('data-rv-present-ask="Ask or comment on this document"');
    // Anchored on a real line of the file, so the comment lands where the
    // change is rather than nowhere in particular.
    expect(pane).toMatch(/class="rv-md-ask" hidden[^>]*data-file="docs\/notes.md"/);
    // The escape hatch back to the lines stays, and now says what it buys.
    expect(pane).toContain('data-rv-show-source');
    expect(pane).toContain('Source — comment line by line');
  });

  // Ships hidden, like every other JS-only control: a page with no comment
  // machinery must never show a button that could not do anything.
  test('the ask affordance is hidden without the island, and unhidden by it', () => {
    expect(renderMarkdownFile(mdFile, source, { allowComments: false })).not.toContain(
      'data-rv-present-ask',
    );
    expect(wrapMermaidFence('graph TD\n A --> B')).toContain('data-rv-present-ask');
    expect(wrapMermaidFence('graph TD\n A --> B')).toMatch(/lz-mermaid-ask" hidden/);
    expect(reviewScript('t')).toContain('function unhidePresentAsk()');
  });

  // A diagram hides the lines it was rendered from, and with them every
  // comment affordance those lines carried. The toolbar carries one back, with
  // a quote of the diagram so the question the agent gets says what it is about.
  test('a diagram carries its own Comment control and a quote', () => {
    const html = wrapMermaidFence('graph TD\n  A[Reviewer] --> B[Page]');
    expect(html).toContain('data-rv-present-quote="diagram: graph TD A[Reviewer] --&gt; B[Page]"');
  });

  // In the diff, the diagram's comment anchors to the line the fence opens on:
  // the line the reviewer would have clicked had they been reading the source.
  test('a diagram in the diff anchors to its opening fence line', () => {
    const patch = `diff --git a/docs/d.md b/docs/d.md
--- a/docs/d.md
+++ b/docs/d.md
@@ -1,4 +1,5 @@
 intro
+\`\`\`mermaid
+graph TD
+  A --> B
+\`\`\`
`;
    const html = renderReviewDiff(parseUnifiedDiff(patch), new Map(), { allowComments: true });
    expect(html).toMatch(/rv-mermaid-row[^>]*data-file="docs\/d.md" data-side="new" data-line="2"/);
  });

  // A screenshot's only text is its caption, so the caption is what a question
  // about the picture anchors to — the same prose-anchor mechanism the report
  // uses, plus a line saying the affordance is there.
  test('screenshots are report prose, and the card says so', () => {
    const card = screenshotsCardHtml('task1', [{ artifact: 'shot.png', caption: 'The sticky header' }]);
    expect(card).toContain('data-rv-prose="(report)"');
    expect(card).toContain('data-rv-prose-kind="screenshots"');
    expect(card).toContain('Hover a caption to ask the agent about that screenshot.');
    expect(reviewScript('t')).toContain('pre, figcaption');
  });

  // Whatever else fails to resolve, a question about what the reviewer is
  // looking at must not be swallowed: the task-level conversation is the
  // anchor of last resort.
  test('an anchor is always found', () => {
    const js = reviewScript('t');
    expect(js).toContain('function presentAskAnchor(btn)');
    expect(js).toContain('return { file: TASK_ANCHOR_FILE, side: \'new\', line: TASK_ANCHOR_LINE };');
  });
});
