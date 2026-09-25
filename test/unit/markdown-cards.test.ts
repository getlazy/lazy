/**
 * Markdown cards never scroll inside themselves.
 *
 * INVARIANT: rendered markdown in the web UI (turns, agent reports, comments,
 * journal entries, follow-ups, prompts) is shown IN FULL. No max-height +
 * overflow-y scroll box, and no "preview behind a click" the reader has to
 * expand. The way to make a long card take less room is the same affordance a
 * file in the review diff has: tick "Viewed" and it collapses to its header,
 * remembered per task and cleared when the content changes.
 *
 * These assertions exist because both mechanisms were shipped and both hid
 * text: `.turn-content { max-height: 300px; overflow-y: auto }` gave every long
 * turn a 300px scroll box inside a scrolling page, and the agent report was
 * truncated to a ~900-character preview behind a <details>.
 */

import { describe, test, expect } from 'bun:test';
import { shortHash, viewedCardHtml, viewedStateScript } from '../../src/server/viewed-cards';
import { reviewTaskHtml } from '../../src/server/review';
import { taskDetailHtml } from '../../src/server/templates';
import { bundledStylesheet } from '../../src/server/styles';
import type { Task, Turn, TurnReport } from '../../src/types';

const PATCH = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
`;

/** Comfortably past both of the removed truncation thresholds (2000/900). */
const LONG_BODY = `${'The agent explains itself at length. '.repeat(200)}\nFINAL LINE OF THE REPORT`;

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

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn-1',
    session_id: 'sess-1',
    sequence: 3,
    role: 'agent',
    content: LONG_BODY,
    timestamp: 0,
    usage: null,
    start_sha: null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: null,
    ...overrides,
  } as Turn;
}

function report(): TurnReport {
  return {
    id: 'rep-1',
    task_id: 'task1234abcd',
    session_id: 'sess-1',
    turn_sequence: 3,
    sections: [{ kind: 'what_was_done', body: LONG_BODY }],
    created_at: 0,
  } as TurnReport;
}

describe('viewedCardHtml', () => {
  test('emits the same collapsible section a diff file uses', () => {
    const html = viewedCardHtml({
      key: 'turn:3',
      content: 'hello',
      headHtml: 'Head',
      bodyHtml: '<p>hello</p>',
    });
    expect(html).toContain('rv-viewable');
    expect(html).toContain('data-viewed-key="card:turn:3"');
    expect(html).toContain(`data-content-hash="${shortHash('hello')}"`);
    expect(html).toContain('class="rv-viewed-box"');
    expect(html).toContain('class="rv-vw-toggle"');
    expect(html).toContain('class="rv-vw-body"');
  });

  // The chevron and the tick are view state: without JS they would be dead
  // chrome, so they ship hidden and the island unhides them. Everything the
  // reader came for — the body — is expanded and present either way.
  test('view-state controls ship hidden, the body does not', () => {
    const html = viewedCardHtml({ key: 'k', content: 'c', headHtml: 'H', bodyHtml: '<p>BODY</p>' });
    expect(html).toMatch(/class="rv-vw-toggle"[^>]*hidden/);
    expect(html).toMatch(/class="rv-viewed"[^>]*hidden/);
    expect(html).toContain('<p>BODY</p>');
    expect(html).not.toContain('data-collapsed="1"');
  });

  // A card whose text changed since it was ticked comes back unviewed, exactly
  // as a file whose diff changed does — the hash is what makes that work.
  test('the content hash tracks the content', () => {
    const a = viewedCardHtml({ key: 'k', content: 'one', headHtml: 'H', bodyHtml: '' });
    const b = viewedCardHtml({ key: 'k', content: 'two', headHtml: 'H', bodyHtml: '' });
    expect(a).not.toBe(b);
    expect(shortHash('one')).not.toBe(shortHash('two'));
  });

  // Nothing to tick off on a page with no per-task scope (commit detail), but
  // the chevron still collapses — so the island runs with persistence off.
  test('an unscoped island collapses but persists nothing', () => {
    const js = viewedStateScript(null);
    expect(js).toContain('var persist = false;');
    expect(js).not.toContain('lazy:reviewed:');
    // Scoped pages persist through the review draft, not localStorage.
    const scoped = viewedStateScript('task1234abcd', { serverState: { 'card:x': 'abc' } });
    expect(scoped).toContain('lazyReviewDraftSave');
    expect(scoped).toContain('"card:x"');
    expect(scoped).not.toContain('lazy:reviewed:');
  });

  // OPEN MEANS NOT VIEWED: expanding a viewed card with the chevron clears
  // the tick, so the checkbox never shows Viewed on an open card. Closing
  // without ticking does not mark Viewed — that is hide-for-a-moment.
  test('opening a viewed card with the chevron clears the tick', () => {
    const js = viewedStateScript('task1234abcd', { serverState: {} });
    expect(js).toMatch(
      /dataset\.viewed === '1'[\s\S]*setViewed\(section, false\)/,
    );
  });
});

describe('agent report on the review page', () => {
  test('renders in full, with no preview truncation', () => {
    const html = reviewTaskHtml(task(), PATCH, [], undefined, undefined, [], {
      lastAgentTurn: turn(),
      turnReport: report(),
    });
    expect(html).toContain('FINAL LINE OF THE REPORT');
    // The old preview mechanism: a <details>/<summary> around a clipped body.
    expect(html).not.toContain('rv-agent-report-details');
    expect(html).not.toContain('Show full report');
  });

  test('carries the viewed checkbox instead', () => {
    const html = reviewTaskHtml(task(), PATCH, [], undefined, undefined, [], {
      lastAgentTurn: turn(),
      turnReport: report(),
    });
    expect(html).toContain('data-viewed-key="card:agent-report"');
    expect(html).toContain('class="rv-viewed-box"');
  });

  // Prose reports (no structured sections) take the same route.
  test('a prose report is a card too', () => {
    const html = reviewTaskHtml(task(), PATCH, [], undefined, undefined, [], {
      lastAgentTurn: turn(),
    });
    expect(html).toContain('data-viewed-key="card:agent-report"');
    expect(html).toContain('FINAL LINE OF THE REPORT');
  });
});

describe('task page turns', () => {
  // The CHUNK is the viewable card, not the turn — a turn of its own put a
  // review stop between a nudge and the work it caused (see
  // turns-chunk-review-unit.test.ts). What has not changed is the card rule
  // this file exists for: the full text is shown, never truncated.
  test('the chunk is a viewable card carrying its turns in full', () => {
    const html = taskDetailHtml(task(), null, [turn()], [], [], [], [], [], []);
    // Chunks are numbered the way the heading and the `#chunk-N` anchor
    // number them — 1-based, one numbering for all three.
    expect(html).toContain('data-viewed-key="card:chunk:1"');
    expect(html).toContain('class="rv-viewed-box"');
    expect(html).toContain('FINAL LINE OF THE REPORT');
  });

  // A turn body is MARKDOWN, and agents routinely end a turn with a small
  // verification table. Rendering it as literal pipes inside a paragraph is
  // the same failure as truncating the card: the reviewer cannot read what the
  // agent wrote. No preview/truncation step exists here — the renderer simply
  // has to know the syntax.
  test('a pipe table in a turn renders as a real table, not literal pipes', () => {
    const body = ['| Check | Result |', '|-------|:------:|', '| typecheck | pass |'].join('\n');
    const html = taskDetailHtml(task(), null, [turn({ content: body })], [], [], [], [], [], []);
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain('<th>Check</th>');
    expect(html).toContain('<th style="text-align: center">Result</th>');
    expect(html).toContain('<td>typecheck</td>');
    expect(html).not.toContain('| Check | Result |');
  });
});

describe('stylesheet', () => {
  test('.turn-content declares no max-height and no overflow-y', () => {
    const css = bundledStylesheet();
    const rule = css.match(/\.turn-content \{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).not.toContain('max-height');
    expect(rule![0]).not.toContain('overflow-y');
  });

  // A long LINE inside a code block still scrolls sideways — that is not a
  // card scrolling, and removing it would only wrap code that must not wrap.
  test('code blocks keep their horizontal scroll', () => {
    expect(bundledStylesheet()).toContain('overflow-x: auto');
  });

  test('the shared card styles ship', () => {
    const css = bundledStylesheet();
    expect(css).toContain('.md-card');
    expect(css).toContain('.rv-vw-toggle');
    expect(css).toContain('.rv-viewed');
  });

  // Same invariant as the card itself: a wide table WRAPS its cells rather
  // than turning the card into a scroll container.
  test('tables wrap rather than scroll', () => {
    const rule = bundledStylesheet().match(/\.md-table \{[^}]*\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).not.toContain('overflow');
    expect(rule![0]).toContain('width: 100%');
  });
});
