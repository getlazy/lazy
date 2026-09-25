/**
 * The Asks block AFTER the review island's poll has re-rendered it.
 *
 * The island replaces `[data-rv-task-threads]` wholesale, and it emits both the
 * open list and the filed archive. Anything the server renders as a SIBLING of
 * that container therefore survives the swap and the page ends up with two
 * copies of the archive seconds after load — invisible to every assertion on
 * the server's HTML, and to a screenshot taken at load time.
 *
 * A real browser is the only place that behaviour exists, so this drives one:
 * the page is the real `currentReviewHtml` + the real `reviewScript`, with
 * `fetch` stubbed to answer the poll with a canned threads payload.
 */

import { describe, test, beforeAll, expect } from 'bun:test';
import { dumpDomOfHtml, browserSuiteSkipped } from '../helpers/page-screenshot';
import { currentReviewHtml } from '../../src/server/current-review';
import { reviewScript, threadsJson } from '../../src/server/review';
import { TASK_LEVEL_REVIEW_ANCHOR } from '../../src/review/task-level-anchor';
import type { ReviewComment, Task } from '../../src/types';

const TASK_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const task = { id: TASK_ID, code: 'demo', status: 'blocked', goal: 'g' } as unknown as Task;

function msg(overrides: Partial<ReviewComment>): ReviewComment {
  return {
    task_id: TASK_ID,
    file: TASK_LEVEL_REVIEW_ANCHOR.file,
    line: TASK_LEVEL_REVIEW_ANCHOR.line,
    side: TASK_LEVEL_REVIEW_ANCHOR.side,
    role: 'human',
    intent: 'ask',
    ask_state: 'answered',
    created_at: 1,
    id: 'x',
    thread_id: 'th1',
    content: '',
    ...overrides,
  } as ReviewComment;
}

const comments: ReviewComment[] = [
  msg({ id: 'a', thread_id: 'th1', filed_at: 10, content: 'FILED_QUESTION' }),
  msg({ id: 'r', thread_id: 'th1', role: 'agent', intent: undefined, content: 'AGENT_ANSWER' }),
];

/**
 * The page as the daemon serves it, with the poll answered from memory.
 *
 * The stub is installed before the island script so the first `poll()` — which
 * runs immediately on load — gets the same payload `/api/review/:id/threads`
 * would return. Everything else on the page is the production renderer.
 */
function pageHtml(): string {
  const payload = JSON.stringify(threadsJson(comments, {
    status: 'blocked',
    turns: 1,
    lastActiveAt: null,
    askable: true,
    askUnavailable: null,
  }));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
    ${currentReviewHtml({
      task,
      comments,
      raisedItems: [],
      fileViolations: [],
      viewedFiles: {},
      draft: {},
      live: { status: 'blocked', turns: 1, lastActiveAt: null, askable: true, askUnavailable: null },
      hasOpenSession: true,
      hasCommits: true,
    })}
    <!-- The island needs a prose block or a diff root to start; the real page
         has one whenever the reviewer has commented on the report. -->
    <div data-rv-prose="(report)"></div>
    <script>
      window.fetch = function () {
        return Promise.resolve({ json: function () { return Promise.resolve(${payload}); } });
      };
    </script>
    ${reviewScript(TASK_ID)}
  </body></html>`;
}

/**
 * The rendered Asks block, by `<div>` depth — the page also carries the island
 * source and the canned payload, so counting occurrences over the whole
 * document would count those too.
 */
function asksBlockOf(dom: string): string {
  const open = dom.indexOf('<div class="lz-review-asks">');
  if (open < 0) throw new Error('no lz-review-asks block in the dumped DOM');
  const start = dom.indexOf('>', open) + 1;
  let depth = 1;
  const tag = /<(\/?)div\b/g;
  tag.lastIndex = start;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(dom))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return dom.slice(start, m.index);
  }
  throw new Error('lz-review-asks block is never closed');
}

describe('Current review asks after the poll island re-renders', () => {
  let skipped = false;

  beforeAll(async () => {
    skipped = await browserSuiteSkipped('review-asks-island');
  });

  // INVARIANT: one archive on the page, before AND after the poll. The island
  // owns `[data-rv-task-threads]`; a filed block rendered beside it is not
  // replaced, so the swap leaves the old copy standing next to the new one.
  test('the filed archive is not duplicated by the poll', async () => {
    if (skipped) return;
    const dom = await dumpDomOfHtml(pageHtml());
    const asks = asksBlockOf(dom);

    // The island really ran: it re-rendered the container, which drops the
    // server's `<div id="thread-…">` wrappers and the heading count with it.
    expect(asks).not.toContain('id="thread-');
    expect(asks).toContain('Asks (0)');

    // ONE archive, holding the one filed question and its answer.
    expect(asks.split('lz-review-asks-filed').length - 1).toBe(1);
    expect(asks.split('FILED_QUESTION').length - 1).toBe(1);
    expect(asks).toContain('AGENT_ANSWER');
  }, 90_000);
});
