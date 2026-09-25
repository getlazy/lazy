/**
 * Filing a review: which asks stop being the reviewer's open business, and
 * which ones must keep showing up however many reviews have been filed since.
 */

import { describe, test, expect } from 'bun:test';
import {
  askAwaitsAgent,
  askThreadIsCurrent,
  isFiledAsk,
  isHumanAsk,
} from '../../src/server/review-actions';
import { currentReviewHtml } from '../../src/server/current-review';
import { TASK_LEVEL_REVIEW_ANCHOR } from '../../src/review/task-level-anchor';
import type { ReviewComment, Task } from '../../src/types';

function ask(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: overrides.id ?? 'c1',
    task_id: 't1',
    thread_id: overrides.thread_id ?? 'th1',
    file: TASK_LEVEL_REVIEW_ANCHOR.file,
    line: TASK_LEVEL_REVIEW_ANCHOR.line,
    side: TASK_LEVEL_REVIEW_ANCHOR.side,
    role: 'human',
    intent: 'ask',
    ask_state: 'answered',
    content: 'Why is the retry unbounded?',
    created_at: 1,
    ...overrides,
  } as ReviewComment;
}

function agentReply(threadId: string, id = 'r1'): ReviewComment {
  return ask({
    id,
    thread_id: threadId,
    role: 'agent',
    content: 'It retries three times.',
  } as Partial<ReviewComment>);
}

describe('ask filing predicates', () => {
  test('a message with no intent is read as an ask', () => {
    expect(isHumanAsk(ask({ intent: undefined }))).toBe(true);
    expect(isHumanAsk(ask({ intent: 'comment' }))).toBe(false);
    expect(isHumanAsk(agentReply('th1'))).toBe(false);
  });

  // INVARIANT: filing never hides an ask the agent has not consumed. A failed
  // ask carries the reviewer's words and the only Re-send control there is; a
  // pending one still has an answer coming.
  test('an ask still in flight or never sent is never filed', () => {
    expect(askAwaitsAgent(ask({ ask_state: 'pending' }))).toBe(true);
    expect(askAwaitsAgent(ask({ ask_state: 'failed' }))).toBe(true);
    expect(askAwaitsAgent(ask({ ask_state: 'answered' }))).toBe(false);
    expect(isFiledAsk(ask({ ask_state: 'pending', filed_at: 10 }))).toBe(false);
    expect(isFiledAsk(ask({ ask_state: 'failed', filed_at: 10 }))).toBe(false);
    expect(isFiledAsk(ask({ ask_state: 'answered', filed_at: 10 }))).toBe(true);
  });

  test('a thread is current until every question in it is filed', () => {
    const answered = ask({ id: 'a', thread_id: 'th1', filed_at: 10 });
    expect(askThreadIsCurrent({ messages: [answered, agentReply('th1')] })).toBe(false);
    expect(askThreadIsCurrent({ messages: [answered, ask({ id: 'b', thread_id: 'th1' })] })).toBe(true);
    expect(askThreadIsCurrent({ messages: [ask({ id: 'c', thread_id: 'th1' })] })).toBe(true);
  });

  // INVARIANT: a thread holding no question at all is NOT current. It has
  // nothing that can ever become unfiled, so a rule phrased as "current until
  // every question is filed" pinned it in the Asks list permanently — and Asks
  // lists open business, which such a thread can never be.
  test('a thread with no question is not current', () => {
    const delivered = ask({
      id: 'c',
      thread_id: 'th9',
      intent: 'comment',
      ask_state: undefined,
      delivery_state: 'delivered',
      content: 'a note, already delivered',
    } as Partial<ReviewComment>);
    expect(askThreadIsCurrent({ messages: [delivered] })).toBe(false);
    expect(askThreadIsCurrent({ messages: [delivered, agentReply('th9')] })).toBe(false);
    // Agent messages alone are nobody's open business either.
    expect(askThreadIsCurrent({ messages: [agentReply('th9')] })).toBe(false);
    // …and an empty thread cannot be open business.
    expect(askThreadIsCurrent({ messages: [] })).toBe(false);
  });

  // INVARIANT: an undelivered comment keeps its thread current. Reply on a
  // task-level thread offers both intents, so "alright, do that" is a queued
  // comment on a thread whose questions are long answered — filing it into an
  // archive labelled closed business would bury words the agent has not read.
  test('a queued comment keeps its thread out of the archive', () => {
    const filedAsk = ask({ id: 'a', thread_id: 'th1', filed_at: 10 });
    const queued = ask({
      id: 'b',
      thread_id: 'th1',
      intent: 'comment',
      ask_state: undefined,
      delivery_state: 'pending_delivery',
      content: 'alright, do that',
    } as Partial<ReviewComment>);
    expect(askThreadIsCurrent({ messages: [filedAsk, agentReply('th1'), queued] })).toBe(true);

    const delivered = { ...queued, delivery_state: 'delivered' as const };
    expect(askThreadIsCurrent({ messages: [filedAsk, agentReply('th1'), delivered] })).toBe(false);
  });
});

/**
 * The inner HTML of the FIRST `data-rv-task-threads` container, by matching
 * `<div>` depth. The assertion below is about containment, and a substring
 * search cannot tell "inside the container" from "just after it".
 */
function polledContainerInnerHtml(html: string): string {
  const openTag = html.indexOf('<div data-rv-task-threads>');
  if (openTag < 0) throw new Error('no data-rv-task-threads container in the rendered page');
  const start = html.indexOf('>', openTag) + 1;
  let depth = 1;
  const tag = /<(\/?)div\b/g;
  tag.lastIndex = start;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  throw new Error('data-rv-task-threads container is never closed');
}

describe('Current review — Asks block', () => {
  const task = { id: 'task-1', code: 'demo', status: 'blocked', goal: 'g' } as unknown as Task;

  function render(comments: ReviewComment[]): string {
    return currentReviewHtml({
      task,
      comments,
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live: { status: 'blocked', turns: 1, lastActiveAt: null, askable: true, askUnavailable: null },
      hasOpenSession: true,
      hasCommits: true,
    });
  }

  test('an unfiled ask is listed as open business', () => {
    const html = render([ask({ id: 'a', thread_id: 'th1' }), agentReply('th1')]);
    expect(html).toContain('<h2 data-rv-asks-count>Asks (1)</h2>');
    expect(html).not.toContain('Filed asks');
  });

  // INVARIANT: filing MOVES an ask, it never discards it — the question, the
  // answer and their delivery state stay on the page (CLAUDE.md, "Never Lose
  // Human Feedback"). The count above it is the reviewer's open business only.
  test('a filed ask leaves the count but stays readable below', () => {
    const html = render([
      ask({ id: 'a', thread_id: 'th1', filed_at: 10, content: 'Filed question?' }),
      agentReply('th1'),
      ask({ id: 'b', thread_id: 'th2', content: 'New question?' }),
    ]);
    expect(html).toContain('<h2 data-rv-asks-count>Asks (1)</h2>');
    expect(html).toContain('Filed asks (1)');
    expect(html).toContain('New question?');
    expect(html).toContain('Filed question?');
  });

  test('with every ask filed the block is empty but the archive remains', () => {
    const html = render([ask({ id: 'a', thread_id: 'th1', filed_at: 10 }), agentReply('th1')]);
    expect(html).toContain('Asks (0)');
    expect(html).toContain('No open questions');
    expect(html).toContain('Filed asks (1)');
  });

  // INVARIANT: everything the poll island re-renders lives INSIDE the container
  // it replaces (`data-rv-task-threads`). The island emits the open list AND
  // the filed archive; a filed block rendered as a SIBLING is not replaced, so
  // seconds after load the page carries two copies of the archive — which is
  // exactly the "moved, not lost" claim falling over, and invisible to a
  // screenshot taken at load time.
  test('the filed archive is inside the container the poll replaces', () => {
    const html = render([
      ask({ id: 'a', thread_id: 'th1', filed_at: 10, content: 'Filed question?' }),
      agentReply('th1'),
    ]);
    const inner = polledContainerInnerHtml(html);
    expect(inner).toContain('lz-review-asks-filed');
    expect(inner).toContain('Filed question?');
    // And exactly one copy of it in the whole page.
    expect(html.split('Filed asks (1)')).toHaveLength(2);
  });

  // The count is re-rendered by the island with the list, so it needs the hook.
  test('the Asks heading carries the hook the island updates', () => {
    expect(render([])).toContain('<h2 data-rv-asks-count>Asks (0)</h2>');
  });
});
