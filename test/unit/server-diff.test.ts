import { describe, test, expect } from 'bun:test';
import { bundledStylesheet } from '../../src/server/styles';
import { commitDetailHtml } from '../../src/server/templates';
import type { Task, Commit } from '../../src/types';

const SAMPLE_PATCH = `diff --git a/foo.ts b/foo.ts
index 1234567..89abcde 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
`;

function makeTask(): Task {
  return {
    id: 'abcd1234ef567890',
    code: 'demo-diff',
    goal: 'Render a diff',
    prompt: 'Do work',
    type: 'task',
    status: 'complete',
    priority: 'normal',
    created_at: 0,
    completed_at: null,
    target: { kind: 'branch', branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata: null,
    runner_type: null,
    tags: [], pending_sync: 0,
  };
}

function makeCommit(): Commit {
  return {
    id: 'commit-id-1',
    session_id: 'sess-1',
    sha: 'deadbeefcafebabe1234567890abcdef12345678',
    message: 'Change b and add c',
    status: 'pending_review',
    timestamp: 0,
  };
}

/**
 * INVARIANT (one-diff-renderer): the commit detail page renders through the
 * SAME renderer as the review surface.
 *
 * It used to use @pierre/diffs, which put every line inside a <diffs-container>
 * web component's Shadow DOM. Nothing outside a shadow root can address a line,
 * so that renderer could never carry the per-line anchors inline comments are
 * built on — the review surface needed its own renderer, and the project ended
 * up with two diff components, two looks and two sets of behaviour. These
 * assertions guard against a second one reappearing.
 */
describe('commitDetailHtml', () => {
  test('renders light-DOM diff rows, not a shadow-DOM web component', () => {
    const html = commitDetailHtml(makeTask(), makeCommit(), SAMPLE_PATCH);
    expect(html).toContain('class="rv-file"');
    expect(html).toContain('table class="rv-diff"');
    expect(html).not.toContain('diffs-container');
    expect(html).not.toContain('customElements.define');
  });

  test('shows the file and its add/delete counts', () => {
    const html = commitDetailHtml(makeTask(), makeCommit(), SAMPLE_PATCH);
    expect(html).toContain('foo.ts');
    expect(html).toContain('+2');
    expect(html).toContain('-1');
  });

  // A historical commit has nothing to reply to and nothing to work through,
  // so the review-only affordances must not appear here.
  test('carries no comment affordance and no Viewed tick', () => {
    const html = commitDetailHtml(makeTask(), makeCommit(), SAMPLE_PATCH);
    // The shared stylesheet names both classes on every page, so assert on the
    // MARKUP each would produce, not on the bare class name.
    expect(html).not.toContain('class="rv-add-comment"');
    expect(html).not.toContain('class="rv-viewed-box"');
    expect(html).toContain('<td class="rv-gutter"></td>');
  });

  test('offers the wrap/scroll and unified/split toggles and the script that drives them', () => {
    const html = commitDetailHtml(makeTask(), makeCommit(), SAMPLE_PATCH);
    expect(html).toContain('data-rv-viewopts');
    expect(html).toContain('data-rv-mode="wrap" data-rv-value="1"');
    expect(html).toContain('data-rv-mode="layout" data-rv-value="split"');
    expect(html).toContain('#commit-diff');
  });

  // Split view was the one thing commit detail lost when the second (shadow-DOM)
  // renderer was deleted. It comes back through the shared renderer, so this
  // page gets it without gaining any of the review-only comment machinery.
  test('side-by-side works here without dragging comment UI onto the page', () => {
    const html = commitDetailHtml(makeTask(), makeCommit(), SAMPLE_PATCH);
    // The pairing the split layout is built from.
    expect(html).toContain('data-rv-pair="1" data-rv-pane="l"');
    expect(html).toContain('data-rv-pair="1" data-rv-pane="r"');
    // Still no comment affordance anywhere, in either layout.
    expect(html).not.toContain('class="rv-add-comment"');
  });

  test('an empty diff yields an empty state rather than a broken table', () => {
    const html = commitDetailHtml(makeTask(), makeCommit(), '');
    expect(html).toContain('empty-state');
    expect(html).not.toContain('table class="rv-diff"');
  });

  // The parser is deliberately tolerant: unrecognized input yields no files,
  // which renders as the empty state rather than throwing the page away.
  test('unparseable input renders an empty state instead of throwing', () => {
    const html = commitDetailHtml(makeTask(), makeCommit(), 'not a diff at all\njust text\n');
    expect(html).toContain('empty-state');
  });

  // INVARIANT: the diff styling SHIPS. It lives in src/server/styles/diff.css,
  // which a compiled binary can only serve if it is compiled in — so assert
  // against the bundled stylesheet, not against the file on disk. The classes
  // are the shared renderer's (.rv-*): the .diff-* set belonged to the second,
  // shadow-DOM renderer and went with it.
  test('the bundled stylesheet ships the diff styling', () => {
    expect(bundledStylesheet()).toContain('.rv-file');
    expect(bundledStylesheet()).toContain('.rv-wrap');
    expect(bundledStylesheet()).toContain('.rv-diff-scroll');
  });
});
