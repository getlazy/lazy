/**
 * Rendering tests for delivery state on the review page.
 *
 * INVARIANT (fix-review-decision-delivery-state): every reviewer-authored item
 * shows one of two states unambiguously — "Pending — rides the next unblock"
 * or "Delivered in turn N (time)". A delivered decision is never rendered as
 * undoable, and collapses to one compact line; a pending one keeps its undo
 * and says loudly that it has not reached the agent yet.
 */

import { describe, test, expect } from 'bun:test';
import { reviewTaskHtml } from '../../src/server/review';
import type { RaisedItem, ReviewComment } from '../../src/types';
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

function raised(overrides: Partial<RaisedItem>): RaisedItem {
  return {
    id: 'raised-1111-2222',
    task_id: 'task1234abcd',
    content: 'Should the legacy flag stay?',
    created_at: 1,
    status: 'open',
    blocking: true,
    ...overrides,
  };
}

/**
 * The island script embeds the same state strings as JS string literals, so
 * assertions about what the PAGE says must look at the server-rendered markup
 * only — strip every script block first.
 */
function stripScripts(html: string): string {
  return html.replace(/<script>[\s\S]*?<\/script>/g, '');
}

function comment(overrides: Partial<ReviewComment>): ReviewComment {
  return {
    id: 'rc-1',
    task_id: 'task1234abcd',
    thread_id: 'rc-1',
    file: 'src/foo.ts',
    line: 1,
    side: 'new',
    role: 'human',
    content: 'rename this',
    created_at: 1,
    intent: 'comment',
    ...overrides,
  };
}

describe('review delivery state rendering', () => {
  test('a queued comment says loudly that it rides the next unblock', () => {
    const html = stripScripts(reviewTaskHtml(task(), PATCH, [
      comment({ delivery_state: 'pending_delivery' }),
    ]));
    expect(html).toContain('Pending — rides the next unblock');
    expect(html).not.toContain('Delivered in turn');
  });

  test('a delivered comment shows the turn and time and is not withdrawable', () => {
    const html = stripScripts(reviewTaskHtml(task(), PATCH, [
      comment({
        delivery_state: 'delivered',
        delivered_turn: 3,
        delivered_at: Date.now() - 60_000,
      }),
    ]));
    expect(html).toContain('Delivered in turn 3 (');
    expect(html).not.toContain('Pending — rides the next unblock');
    // No Withdraw form on a delivered comment — only the refusal hint.
    expect(html).not.toContain('class="rv-withdraw"');
    expect(html).toContain('already delivered');
  });

  test('a resolved-but-undelivered raised item keeps its undo and states the pending ride', () => {
    const html = stripScripts(reviewTaskHtml(task(), PATCH, [], undefined, undefined, [], {
      raisedItems: [raised({
        status: 'responded',
        resolved_at: 2,
        resolution: 'Yes, keep it',
        pending_comment: 'Regarding raised item…',
      })],
    }));
    expect(html).toContain('Pending — rides the next unblock (or accept). Undo until then.');
    expect(html).toContain('rv-raised-undo');
    expect(html).toContain('>Undo<');
  });

  test('a delivered raised resolution collapses to one compact line with no undo', () => {
    const html = stripScripts(reviewTaskHtml(task(), PATCH, [], undefined, undefined, [], {
      raisedItems: [raised({
        status: 'promoted_subtask',
        resolved_at: 2,
        pending_comment: 'Regarding raised item…',
        comment_delivered_at: Date.now() - 120_000,
        delivered_turn: 4,
      })],
    }));
    expect(html).toContain('Promoted to subtask');
    expect(html).toContain('Delivered in turn 4 (');
    expect(html).toContain('rv-raised-delivered');
    // Delivered means done: no undo control anywhere in the raised block.
    expect(html).not.toContain('rv-raised-undo');
    expect(html).not.toContain('>Undo<');
  });

  test('a delivered raised item without a stored turn degrades to the timestamp alone', () => {
    const html = stripScripts(reviewTaskHtml(task(), PATCH, [], undefined, undefined, [], {
      raisedItems: [raised({
        status: 'dismissed',
        resolved_at: 2,
        resolution: 'not worth it',
        pending_comment: 'Regarding raised item…',
        comment_delivered_at: Date.now() - 120_000,
      })],
    }));
    expect(html).toContain('Dismissed');
    expect(html).toContain('Delivered (');
    // Never invent a turn number the store does not have.
    expect(html).not.toContain('Delivered in turn');
  });

  test('a delivered promote_peer resolution links the peer task on its compact line', () => {
    const html = stripScripts(reviewTaskHtml(task(), PATCH, [], undefined, undefined, [], {
      raisedItems: [raised({
        status: 'promoted_peer',
        resolved_at: 2,
        pending_comment: 'Regarding raised item…',
        comment_delivered_at: Date.now(),
        delivered_turn: 2,
        promoted_task_id: 'peer5678abcd',
      })],
    }));
    expect(html).toContain('Promoted to peer task');
    expect(html).toContain('/tasks/peer5678abcd');
    expect(html).toContain('Delivered in turn 2 (');
  });

  // INVARIANT: a decided NON-BLOCKING item — what used to be a triaged
  // follow-up — collapses through exactly the same delivered row as a blocking
  // one. One vocabulary, one markup; the flag never forks the rendering. See
  // docs/design/raised-items-unified.md.
  test('a decided non-blocking item collapses to one compact line without the decide form', () => {
    const html = stripScripts(reviewTaskHtml(task(), PATCH, [], undefined, undefined, [], {
      raisedItems: [raised({
        id: 'raised-nonblocking-1',
        blocking: false,
        content: 'The retry path swallows errors.',
        status: 'acknowledged',
        resolved_at: 2,
        resolution: 'Tracked in the docs pass',
        pending_comment: 'Regarding raised item…',
        comment_delivered_at: Date.now() - 60_000,
        delivered_turn: 3,
      })],
    }));
    expect(html).toContain('rv-raised-delivered');
    expect(html).toContain('Acknowledged');
    expect(html).toContain('The retry path swallows errors.');
    // Decided and delivered → no decide dropdown, no undo.
    expect(html).not.toContain('name="raised_action[raised-nonblocking-1]"');
    expect(html).not.toContain('rv-raised-undo');
  });
});
