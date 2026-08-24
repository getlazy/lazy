/**
 * Rendering tests for the review page's remedy panel.
 *
 * The page RENDERS a remedy the daemon composed; it never infers one. These
 * tests pin that split: what the daemon sent appears verbatim (command, files),
 * the in-page affordance follows the reason's uiAction, and a remedy carrying
 * no uiAction still gives the reviewer a command instead of a dead end.
 */

import { describe, test, expect } from 'bun:test';
import { reviewTaskHtml } from '../../src/server/review';
import type { AcceptRemedy } from '../../src/types';
import type { Task } from '../../src/storage';

const PATCH = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
`;

function task(): Task {
  return {
    id: 'task1234abcd',
    code: 'demo-task',
    goal: 'Do the thing',
    prompt: '',
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

function render(remedy: AcceptRemedy, draft: { reason?: string; feedback?: string } = {}): string {
  return reviewTaskHtml(task(), PATCH, [], undefined, undefined, [], { remedy, draft });
}

describe('remedy panel', () => {
  test('a passphrase remedy renders the in-page form and the command', () => {
    const html = render({
      reason: 'approval-required',
      next: 'This merge is protected.',
      command: 'lazy accept task1234abcd',
      uiAction: 'passphrase',
    });
    expect(html).toContain('data-rv-remedy="approval-required"');
    expect(html).toContain('This merge is protected.');
    expect(html).toContain('type="password" name="passphrase"');
    expect(html).toContain('lazy accept task1234abcd');
    expect(html).toContain('action="/review/task1234abcd/accept"');
  });

  test('a sync remedy renders the sync button pointing at the sync route', () => {
    const html = render({
      reason: 'merge-conflict',
      next: 'Sync the task with its parent.',
      command: 'lazy sync task1234abcd',
      uiAction: 'sync',
    });
    expect(html).toContain('action="/review/task1234abcd/sync"');
    expect(html).toContain('Sync with parent');
    expect(html).not.toContain('name="passphrase"');
  });

  // INVARIANT: a refusal with no in-page affordance still ends in an action —
  // the exact command the daemon composed, with every file enumerated. This is
  // the case that motivated the whole feature (43 protected files).
  test('a command-only remedy lists the files and the full command', () => {
    const files = ['src/a.ts', 'docs/my notes.md'];
    const html = render({
      reason: 'pending-violations',
      next: 'Approve every protected file.',
      command: "lazy accept task1234abcd --approve-file src/a.ts --approve-file 'docs/my notes.md'",
      files,
    });
    expect(html).toContain('--approve-file src/a.ts');
    expect(html).toContain('docs/my notes.md');
    expect(html).toContain('rv-remedy-cmd');
    expect(html).not.toContain('rv-remedy-form');
  });

  // Never lose human feedback: text typed before the refusal comes back in the
  // boxes it was typed in, AND rides the remedy form so a second failure (a
  // mistyped passphrase) cannot eat it either.
  test('the reviewer\'s typed text survives the refusal', () => {
    const html = render(
      { reason: 'approval-required', next: 'Approve it.', uiAction: 'passphrase' },
      { reason: 'looks good', feedback: 'rename the helper first' },
    );
    expect(html).toContain('>looks good</textarea>');
    expect(html).toContain('>rename the helper first</textarea>');
    expect(html).toContain('<input type="hidden" name="reason" value="looks good">');
    expect(html).toContain('<input type="hidden" name="feedback" value="rename the helper first">');
  });

  test('no remedy renders no panel at all', () => {
    const html = reviewTaskHtml(task(), PATCH, []);
    expect(html).not.toContain('rv-remedy');
  });
});
