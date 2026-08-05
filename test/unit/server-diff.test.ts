import { describe, test, expect } from 'bun:test';
import { renderDiff, diffScripts, diffStyles } from '../../src/server/diff';
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

// INVARIANT: The diff viewer is rendered through @pierre/diffs SSR
// (renderDiff in src/server/diff.ts), ported from the add-server-diffs task.
// The output must wrap each file's pre-rendered diff in a <diffs-container>
// web component and expose a per-file header with add/del stats. These
// assertions guard that the SSR integration stays wired up.
describe('renderDiff (@pierre/diffs SSR)', () => {
  test('split view wraps each file in a <diffs-container> with header + stats', async () => {
    const html = await renderDiff(SAMPLE_PATCH, 'split');
    expect(html).toContain('<diffs-container>');
    expect(html).toContain('class="diff-file"');
    expect(html).toContain('foo.ts');
    // Two additions, one deletion in the sample patch.
    expect(html).toContain('diff-stat-add');
    expect(html).toContain('diff-stat-del');
  });

  test('unified view also renders through the web component', async () => {
    const html = await renderDiff(SAMPLE_PATCH, 'unified');
    expect(html).toContain('<diffs-container>');
    expect(html).toContain('foo.ts');
  });

  test('empty diff yields an empty-state message, not a broken container', async () => {
    const html = await renderDiff('', 'split');
    expect(html).toContain('empty-state');
    expect(html).not.toContain('<diffs-container>');
  });

  // INVARIANT: Rendering must never throw on malformed input — it falls back
  // to a raw <pre> dump so the page still loads. Errors are surfaced to the
  // user, not swallowed (see CLAUDE.md error-handling rules).
  test('unparseable input falls back to a raw pre block instead of throwing', async () => {
    const garbage = 'this is not a unified diff at all\njust some text\n';
    const html = await renderDiff(garbage, 'split');
    // Falls back to a raw <pre> dump (no web component) rather than throwing.
    expect(html).toContain('class="diff-raw"');
    expect(html).not.toContain('<diffs-container>');
  });

  test('diffScripts registers the diffs-container custom element', () => {
    expect(diffScripts).toContain("customElements.define('diffs-container'");
  });

  test('diffStyles ship the file-wrapper styling', () => {
    expect(diffStyles).toContain('.diff-file');
    expect(diffStyles).toContain('.diff-view-toggle');
  });
});

// INVARIANT: The commit detail page honors the side-by-side/unified view
// toggle, marks the active view, renders the diff via renderDiff, and includes
// the companion registration script (diffScripts) so the web component works.
describe('commitDetailHtml view toggle + diff integration', () => {
  test('side-by-side view marks side-by-side active and embeds the diff + scripts', async () => {
    const html = await commitDetailHtml(makeTask(), makeCommit(), SAMPLE_PATCH, 'side-by-side');
    expect(html).toContain('class="diff-view-toggle"');
    expect(html).toMatch(/view=side-by-side"[^>]*class="active"/);
    expect(html).toContain('<diffs-container>');
    expect(html).toContain("customElements.define('diffs-container'");
  });

  test('unified view marks unified active', async () => {
    const html = await commitDetailHtml(makeTask(), makeCommit(), SAMPLE_PATCH, 'unified');
    expect(html).toMatch(/view=unified"[^>]*class="active"/);
    expect(html).toContain('<diffs-container>');
  });
});
