import { describe, test, expect } from 'bun:test';
import {
  parseUnifiedDiff,
  renderReviewDiff,
  anchorForLine,
  anchorKey,
  anchorDomId,
  fileSectionId,
  pairSplitRows,
  diffViewOptionsHtml,
  diffViewScript,
  type DiffLine,
} from '../../src/server/review-diff';
import {
  groupThreads,
  threadsJson,
  reviewQueueHtml,
  reviewTaskHtml,
  relativeTime,
} from '../../src/server/review';
import { acceptBlockedByViolations } from '../../src/server/review-actions';
import { bundledStylesheet } from '../../src/server/styles';
import type { FileViolation, ReviewComment, Task } from '../../src/types';

const PATCH = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..89abcde 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 const e = 6;
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -10,2 +10,3 @@
 intro
+added line
 outro
`;

function comment(over: Partial<ReviewComment>): ReviewComment {
  return {
    id: 'c1',
    task_id: 't1',
    thread_id: 'c1',
    file: 'src/foo.ts',
    line: 2,
    side: 'new',
    role: 'human',
    content: 'why 3?',
    created_at: 1,
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
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
    ...over,
  } as unknown as Task;
}

describe('parseUnifiedDiff', () => {
  test('splits files and counts add/del stats', () => {
    const files = parseUnifiedDiff(PATCH);
    expect(files.map((f) => f.path)).toEqual(['src/foo.ts', 'README.md']);
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
    expect(files[1].additions).toBe(1);
    expect(files[1].deletions).toBe(0);
  });

  // INVARIANT: inline comments are anchored to (file, line, side). The parser
  // must therefore track BOTH numbering spaces independently — a deleted line
  // has only a pre-image number, an added line only a post-image number.
  // Collapsing them would make anchors ambiguous and comments would reattach to
  // the wrong line after any edit.
  test('tracks old and new line numbers independently', () => {
    const [foo] = parseUnifiedDiff(PATCH);
    const lines = foo.hunks[0].lines;
    expect(lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
      ['context', 4, 5],
    ]);
  });

  test('hunk headers seed line numbers from the @@ ranges', () => {
    const [, readme] = parseUnifiedDiff(PATCH);
    const lines = readme.hunks[0].lines;
    expect(lines[0].oldLine).toBe(10);
    expect(lines[0].newLine).toBe(10);
    expect(lines[1]).toMatchObject({ kind: 'add', newLine: 11, oldLine: null });
  });

  test('binary patches are flagged, not dropped', () => {
    const files = parseUnifiedDiff(
      'diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n',
    );
    expect(files).toHaveLength(1);
    expect(files[0].binary).toBe(true);
  });

  test('empty and non-diff input yields no files rather than throwing', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('just some prose\nnot a diff\n')).toEqual([]);
  });

  test('"\\ No newline at end of file" does not consume a line number', () => {
    const files = parseUnifiedDiff(
      'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n',
    );
    const lines = files[0].hunks[0].lines;
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ kind: 'add', newLine: 1 });
  });
});

describe('anchorForLine', () => {
  test('deleted lines anchor to the old side, added/context to the new side', () => {
    const [foo] = parseUnifiedDiff(PATCH);
    const [ctx, del, add] = foo.hunks[0].lines;
    expect(anchorForLine('src/foo.ts', del)).toEqual({ file: 'src/foo.ts', side: 'old', line: 2 });
    expect(anchorForLine('src/foo.ts', add)).toEqual({ file: 'src/foo.ts', side: 'new', line: 2 });
    expect(anchorForLine('src/foo.ts', ctx)).toEqual({ file: 'src/foo.ts', side: 'new', line: 1 });
  });
});

describe('anchorDomId', () => {
  // INVARIANT: the id is built with encodeURIComponent, not with the private
  // hash used for file section ids. The island has to produce the SAME id in
  // the browser for threads it renders client-side, and a hash duplicated in
  // two languages is how anchors silently stop resolving. Anything that makes
  // this id un-reproducible from (file, side, line) alone breaks the queued
  // comment links.
  test('is reproducible from the anchor alone and escapes path separators', () => {
    expect(anchorDomId({ file: 'src/foo.ts', side: 'new', line: 2 })).toBe('l-src%2Ffoo.ts-new-2');
    expect(anchorDomId({ file: 'src/foo.ts', side: 'old', line: 2 })).toBe('l-src%2Ffoo.ts-old-2');
    expect(anchorDomId({ file: 'a b.md', side: 'new', line: 1 })).toBe('l-a%20b.md-new-1');
  });

  test('distinguishes the two numbering spaces, exactly as anchorKey does', () => {
    const oldSide = { file: 'x.ts', side: 'old', line: 5 } as const;
    const newSide = { file: 'x.ts', side: 'new', line: 5 } as const;
    expect(anchorDomId(oldSide)).not.toBe(anchorDomId(newSide));
    expect(anchorKey(oldSide)).not.toBe(anchorKey(newSide));
  });
});

describe('renderReviewDiff', () => {
  // INVARIANT: every commentable line carries data-file/data-side/data-line in
  // the LIGHT DOM. The renderer this one replaced (@pierre/diffs, since deleted)
  // put its lines in a Shadow DOM, where nothing outside can address a line —
  // which is why the review surface has its own renderer at all. If these
  // attributes disappear, inline commenting silently stops working. In the
  // side-by-side layout they sit on the code cell instead of the row, because a
  // split row holds two lines; the data is the same either way.
  test('emits light-DOM rows with anchor data attributes', () => {
    const html = renderReviewDiff(parseUnifiedDiff(PATCH), new Map());
    expect(html).toContain('data-file="src/foo.ts" data-side="new" data-line="2"');
    expect(html).toContain('data-file="src/foo.ts" data-side="old" data-line="2"');
    expect(html).not.toContain('diffs-container');
    expect(html).toContain('rv-add-comment');
  });

  // The queued-comment list links to `#l-...`; without an id on the row there
  // is nothing for that fragment to land on and the link silently does nothing.
  test('commentable rows carry the anchor id a queued comment links to', () => {
    const html = renderReviewDiff(parseUnifiedDiff(PATCH), new Map());
    expect(html).toContain(`id="${anchorDomId({ file: 'src/foo.ts', side: 'new', line: 2 })}"`);
    expect(html).toContain(`id="${anchorDomId({ file: 'src/foo.ts', side: 'old', line: 2 })}"`);
    // Hunk header rows are not commentable, so they get no anchor id.
    expect(html).not.toContain('id="l-"');
  });

  test('renders existing threads inline at their anchor', () => {
    const files = parseUnifiedDiff(PATCH);
    const threads = new Map([
      [anchorKey({ file: 'src/foo.ts', side: 'new', line: 2 }), [{ threadId: 'th1', html: '<b>hello</b>' }]],
    ]);
    const html = renderReviewDiff(files, threads);
    expect(html).toContain('data-thread="th1"');
    expect(html).toContain('<b>hello</b>');
  });

  test('escapes file paths and code so a diff cannot inject markup', () => {
    const evil = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,0 +1,1 @@\n+<script>alert(1)</script>\n';
    const html = renderReviewDiff(parseUnifiedDiff(evil), new Map());
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('empty file list renders an empty state', () => {
    expect(renderReviewDiff([], new Map())).toContain('empty-state');
  });
});

describe('thread grouping', () => {
  test('replies group under the root comment in order', () => {
    const threads = groupThreads([
      comment({ id: 'a', thread_id: 'a', content: 'first' }),
      comment({ id: 'b', thread_id: 'a', role: 'agent', content: 'answer', created_at: 2 }),
      comment({ id: 'c', thread_id: 'c', line: 5, content: 'other', created_at: 3 }),
    ]);
    expect(threads).toHaveLength(2);
    expect(threads[0].messages.map((m) => m.content)).toEqual(['first', 'answer']);
    expect(threads[1].line).toBe(5);
  });

  // The island polls only while something is awaiting the agent; `pending` is
  // what tells it when to stop.
  test('threadsJson reports the number of comments still awaiting the agent', () => {
    const json = threadsJson([
      comment({ id: 'a', thread_id: 'a', ask_state: 'pending' }),
      comment({ id: 'b', thread_id: 'b', ask_state: 'answered' }),
      comment({ id: 'c', thread_id: 'c', ask_state: 'failed' }),
    ]);
    expect(json.pending).toBe(1);
    expect(json.threads).toHaveLength(3);
  });

  // The queued list is rendered in two places on the page; the poll re-renders
  // both from this payload, so it must carry the comment IN FULL plus the
  // anchor needed to link back to its line. A count alone would force a reload.
  test('threadsJson carries queued comments in full, with their anchors', () => {
    const json = threadsJson([
      comment({
        id: 'q1',
        thread_id: 'q1',
        intent: 'comment',
        delivery_state: 'pending_delivery',
        content: 'x'.repeat(400),
      }),
      comment({ id: 'a', thread_id: 'a', ask_state: 'answered' }),
    ]);
    expect(json.pendingDelivery).toBe(1);
    expect(json.queued).toEqual([
      { id: 'q1', file: 'src/foo.ts', side: 'new', line: 2, content: 'x'.repeat(400) },
    ]);
  });

  // The poll re-renders the queued list without a reload, so a withdrawn
  // comment must drop out of this payload too — otherwise it would reappear in
  // the list the moment the island refreshed.
  test('threadsJson drops withdrawn comments from the queue but keeps the thread', () => {
    const json = threadsJson([
      comment({ id: 'q1', thread_id: 'q1', intent: 'comment', delivery_state: 'pending_delivery' }),
      comment({
        id: 'w1', thread_id: 'w1', intent: 'comment',
        delivery_state: 'pending_delivery', withdrawn_at: 1700000000000,
      }),
    ]);
    expect(json.pendingDelivery).toBe(1);
    expect(json.queued.map((c) => c.id)).toEqual(['q1']);
    expect(json.threads).toHaveLength(2);
  });

  test('threadsJson passes the live state through for the status bar', () => {
    const state = {
      status: 'working',
      turns: 3,
      lastActiveAt: 1000,
      askable: false,
      askUnavailable: 'Task is working — …',
    };
    expect(threadsJson([], state).state).toEqual(state);
    // Omitted by callers that have no session to read (existing tests, errors).
    expect(threadsJson([]).state).toBeUndefined();
  });
});

describe('relativeTime', () => {
  test('renders a compact age, and says so plainly when there is none', () => {
    expect(relativeTime(null)).toBe('never');
    expect(relativeTime(Date.now() - 5_000)).toBe('5s ago');
    expect(relativeTime(Date.now() - 3 * 60_000)).toBe('3m ago');
    expect(relativeTime(Date.now() - 5 * 3600_000)).toBe('5h ago');
    expect(relativeTime(Date.now() - 5 * 24 * 3600_000)).toBe('5d ago');
  });
});

describe('reviewTaskHtml', () => {
  const queuedComment = comment({
    id: 'q1',
    thread_id: 'q1',
    intent: 'comment',
    delivery_state: 'pending_delivery',
    content: 'This needs a null check before the cast, and a test for the empty case.',
  });

  // The reviewer reads top-to-bottom; making them scroll back up to unblock is
  // the abrupt ending this mirrors away. Both copies must be complete, working
  // forms — with scripting off there is no dialog to fall back on.
  test('renders the actions block above AND below the diff', () => {
    const html = reviewTaskHtml(task(), PATCH, []);
    expect(html.split('class="rv-actions"').length - 1).toBe(2);
    expect(html.split('action="/review/task1234abcd/unblock"').length - 1).toBe(2);
    expect(html.split('class="rv-accept-form"').length - 1).toBe(2);
  });

  // INVARIANT: queued comments are shown in full. This list is the reviewer's
  // only record of what they have already written before they commit to
  // sending it — a comment truncated to a preview is exactly the one they would
  // want to re-read.
  test('shows queued comments untruncated, linked back to their line', () => {
    const long = 'y'.repeat(500);
    const html = reviewTaskHtml(task(), PATCH, [
      queuedComment,
      comment({ id: 'q2', thread_id: 'q2', intent: 'comment', delivery_state: 'pending_delivery', content: long }),
    ]);
    expect(html).toContain('This needs a null check before the cast, and a test for the empty case.');
    expect(html).toContain(long);
    expect(html).toContain(`href="#${anchorDomId({ file: 'src/foo.ts', side: 'new', line: 2 })}"`);
    expect(html).toContain('2 comments queued');
  });

  // INVARIANT: what the page lists as queued is exactly what the next unblock
  // will carry. A withdrawn comment stays visible in its thread — struck
  // through, so the reviewer can see what they took back — but is gone from the
  // queued list and the status-bar count.
  test('a withdrawn comment leaves the queue but stays in its thread', () => {
    const html = reviewTaskHtml(task(), PATCH, [
      queuedComment,
      comment({
        id: 'w1',
        thread_id: 'w1',
        intent: 'comment',
        delivery_state: 'pending_delivery',
        content: 'this one was a typo',
        withdrawn_at: 1700000000000,
      }),
    ]);
    expect(html).toContain('this one was a typo');
    expect(html).toContain('withdrawn — never sent to the agent');
    expect(html).toContain('rv-msg-withdrawn');
    expect(html).toContain('1 comment queued');
    expect(html).toContain('1 queued');
    // Nothing offers to withdraw it a second time.
    expect(html).not.toContain('/comment/w1/withdraw');
  });

  // The withdraw control is a plain form for the same reason retry is: taking
  // a comment back must not depend on JavaScript being alive.
  test('a queued comment offers a plain-form Withdraw', () => {
    const html = reviewTaskHtml(task(), PATCH, [queuedComment]);
    expect(html).toContain('action="/review/task1234abcd/comment/q1/withdraw"');
    expect(html).toContain('Withdraw');
  });

  // INVARIANT: the page never offers to withdraw something the agent has read.
  // Instead of a dead button it states the reason, which is the reviewer's
  // actual question — "why can't I take this back?".
  test('a delivered comment and an answered ask say why they cannot be withdrawn', () => {
    const html = reviewTaskHtml(task(), PATCH, [
      comment({
        id: 'd1', thread_id: 'd1', intent: 'comment',
        delivery_state: 'delivered', delivered_turn: 4, content: 'already sent',
      }),
      comment({ id: 'a1', thread_id: 'a1', ask_state: 'answered', content: 'a question' }),
    ]);
    expect(html).not.toContain('/comment/d1/withdraw');
    expect(html).not.toContain('/comment/a1/withdraw');
    expect(html).toContain('already delivered to the agent in turn 4');
    expect(html).toContain('already answered this question');
  });

  test('the comment box invites a question rather than asking one', () => {
    const html = reviewTaskHtml(task(), PATCH, []);
    expect(html).toContain('Ask the agent about this line');
    expect(html).not.toContain('What about this line?');
  });

  // INVARIANT: a question that could not be delivered is never lost and never a
  // dead end. The reviewer must be told it did not go, that it was saved, and
  // be given a way to send it again — as a plain form, so it works with JS off.
  test('a failed ask keeps its text and offers a re-send', () => {
    const html = reviewTaskHtml(task(), PATCH, [
      comment({
        id: 'f1',
        thread_id: 'f1',
        content: 'why did you drop the retry here?',
        ask_state: 'failed',
        ask_error: 'Task is working — the agent can only answer while the task is blocked.',
      }),
    ]);
    expect(html).toContain('why did you drop the retry here?');
    expect(html).toContain('not sent:');
    expect(html).toContain('your question is saved');
    expect(html).toContain('action="/review/task1234abcd/comment/f1/retry"');
    expect(html).toContain('Re-send to agent');
  });

  // The bar is the reviewer's answer to "can I even ask right now?" while they
  // are 400 lines down a diff. Its askable flag also drives the warning the
  // island prepends to the comment form BEFORE they type.
  test('the sticky status bar reports state and whether the agent can answer', () => {
    const html = reviewTaskHtml(task({ status: 'working' }), PATCH, [queuedComment], undefined, {
      status: 'working',
      turns: 4,
      lastActiveAt: Date.now() - 120_000,
      askable: false,
      askUnavailable: 'Task is working — the agent can only answer while the task is blocked.',
    });
    expect(html).toContain('id="rv-statusbar"');
    expect(html).toContain('data-rv-askable="0"');
    expect(html).toContain('data-rv-sb="status">status: working');
    expect(html).toContain('4 turns');
    expect(html).toContain('active 2m ago');
    expect(html).toContain('1 queued');
    expect(html).toContain('agent busy');
  });

  test('without an explicit state the bar falls back to the task status', () => {
    const html = reviewTaskHtml(task({ status: 'blocked' }), PATCH, []);
    expect(html).toContain('data-rv-askable="1"');
    expect(html).toContain('agent can answer');
    expect(html).toContain('active never');
  });
});

describe('reviewQueueHtml', () => {
  test('lists blocked tasks with a link into the review view', () => {
    const html = reviewQueueHtml([
      {
        id: 'abcd1234ef',
        code: 'demo-task',
        goal: 'Do the thing',
        status: 'blocked',
        type: 'task',
        updatedAt: 0,
        hasSession: true,
        commentCount: 2,
        pendingAsks: 1,
        pendingComments: 0,
      },
    ]);
    expect(html).toContain('href="/review/abcd1234ef"');
    expect(html).toContain('demo-task');
    expect(html).toContain('1 awaiting agent');
  });

  // The two intents have different urgency and the queue must distinguish them:
  // an ask is mid-conversation, a queued comment is work the reviewer has not
  // sent yet and could otherwise forget entirely.
  test('queued comments are counted separately from asks awaiting an answer', () => {
    const html = reviewQueueHtml([
      {
        id: 'abcd1234ef',
        code: 'demo-task',
        goal: 'Do the thing',
        status: 'blocked',
        type: 'task',
        updatedAt: 0,
        hasSession: true,
        commentCount: 4,
        pendingAsks: 0,
        pendingComments: 3,
      },
    ]);
    expect(html).toContain('3 comments to deliver');
    expect(html).not.toContain('awaiting agent');
  });

  test('empty queue renders an empty state, not a broken table', () => {
    expect(reviewQueueHtml([])).toContain('Nothing awaiting review');
  });
});

describe('protected-file violations on the review surface', () => {
  const violations: FileViolation[] = [
    { file: 'src/foo.ts', base_sha: 'base1111', status: 'pending' },
    { file: 'src/bar.ts', base_sha: 'base2222', status: 'approved' },
  ];

  function render() {
    return reviewTaskHtml(task({ status: 'conflict' }), PATCH, [], undefined, undefined, violations);
  }

  // INVARIANT (one-control-per-decision): the ⛔/✅ decision is durable state,
  // not a form field, so exactly ONE control exists per violated file. An
  // earlier design put a checkbox inside both the unblock and the accept form
  // and synchronised them, because a checkbox only submits with its own form —
  // two controls for one answer, which could disagree. If this count is ever
  // greater than one per file, that mistake has come back.
  test('exactly one decision control exists per violated file', () => {
    const html = render();
    expect((html.match(/data-rv-decide="src\/foo\.ts"/g) ?? []).length).toBe(1);
    expect((html.match(/data-rv-decide="src\/bar\.ts"/g) ?? []).length).toBe(1);
    // and it is not smuggled into the action forms as an input
    expect(html).not.toContain('name="approve"');
  });

  // INVARIANT: the current answer must be VISIBLE, not implied by an empty
  // control. "Unticked means rejected" is a rule you have to be told.
  test('the standing answer is shown for both the undecided and the approved file', () => {
    const html = render();
    const control = (file: string) =>
      (html.split(`data-rv-decide="${file}"`)[1] ?? '').split('</form>')[0];
    // undecided → ⛔ is the lit button
    expect(control('src/foo.ts')).toMatch(/value="0"[^>]*rv-decide-on/);
    expect(control('src/foo.ts')).not.toMatch(/value="1"[^>]*rv-decide-on/);
    // approved → ✅ is the lit button
    expect(control('src/bar.ts')).toMatch(/value="1"[^>]*rv-decide-on/);
    expect(control('src/bar.ts')).not.toMatch(/value="0"[^>]*rv-decide-on/);
  });

  // A violated file that is not in the rendered diff has no header to hang a
  // control on. It must still be decidable, or the reviewer is stuck: accept
  // refuses on it and nothing on the page can clear it. src/bar.ts is such a
  // file here — the PATCH fixture only contains src/foo.ts and README.md.
  test('a violated file missing from the diff still gets its one control', () => {
    const html = render();
    expect((html.match(/data-rv-decide="src\/bar\.ts"/g) ?? []).length).toBe(1);
    expect(html).toContain('(not in this diff)');
  });

  test('the control posts to the decision route and names its file', () => {
    const html = render();
    expect(html).toContain('action="/review/task1234abcd/violation"');
    expect(html).toContain('<input type="hidden" name="file" value="src/foo.ts">');
  });

  // The summary REPORTS; it must not let the reviewer approve a change without
  // opening the diff for it. src/foo.ts is in the diff, so its summary row is a
  // link and its control lives in the file box, not here.
  test('the summary links to the file rather than offering a control', () => {
    const html = render();
    const row = (html.split('data-rv-summary="src/foo.ts"')[1] ?? '').split('</li>')[0];
    expect(row).not.toContain('rv-decide-btn');
    expect(html).toContain('1 of 2 protected files not yet accepted');
    expect(html).toContain(`href="#${fileSectionId('src/foo.ts')}"`);
  });

  test('a task with no violations renders no decision control at all', () => {
    const html = reviewTaskHtml(task(), PATCH, []);
    // The island script mentions [data-rv-decide] and the stylesheet mentions
    // .rv-violations on every page, so assert on the MARKUP these produce.
    expect(html).not.toContain('data-rv-decide="');
    expect(html).not.toContain('<div class="rv-violations"');
  });

  test('the violated file is marked in the diff, and other files are not', () => {
    expect(render()).toContain('rv-file-protected');
  });
});

describe('acceptBlockedByViolations', () => {
  test('names every file not yet approved', () => {
    const reason = acceptBlockedByViolations([
      { file: 'src/foo.ts', base_sha: 'b1', status: 'pending' },
      { file: 'src/bar.ts', base_sha: 'b2', status: 'approved' },
    ]);
    expect(reason).toContain('src/foo.ts');
    expect(reason).not.toContain('src/bar.ts');
  });

  test('passes once every violation is approved', () => {
    expect(acceptBlockedByViolations([{ file: 'a.ts', base_sha: 'b', status: 'approved' }])).toBeNull();
  });

  test('is a no-op for a task with no violations', () => {
    expect(acceptBlockedByViolations([])).toBeNull();
  });
});

describe('pairSplitRows', () => {
  const ln = (kind: DiffLine['kind'], oldLine: number | null, newLine: number | null, content = ''): DiffLine =>
    ({ kind, oldLine, newLine, content });

  // The classic bug in side-by-side diffs: a deletion and the addition that
  // replaced it staircase down the page instead of sitting across from each
  // other. Pairing the two runs of a change block index-wise is what prevents it.
  test('puts a deletion across from the addition that replaced it', () => {
    const rows = pairSplitRows([
      ln('context', 1, 1),
      ln('del', 2, null, 'was'),
      ln('add', null, 2, 'is'),
      ln('context', 3, 3),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[1].left?.content).toBe('was');
    expect(rows[1].right?.content).toBe('is');
  });

  // A context line is the SAME line on both sides. Giving it one row with both
  // panes filled is what keeps the two sides in step down the whole file.
  test('a context line fills both panes of one row', () => {
    const ctx = ln('context', 7, 9);
    const rows = pairSplitRows([ctx]);
    expect(rows).toEqual([{ left: ctx, right: ctx }]);
  });

  test('the longer side of an uneven change block gets blank filler opposite it', () => {
    const rows = pairSplitRows([
      ln('del', 1, null, 'a'),
      ln('add', null, 1, 'x'),
      ln('add', null, 2, 'y'),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1].left).toBeNull();
    expect(rows[1].right?.content).toBe('y');

    const removals = pairSplitRows([ln('del', 1, null, 'a'), ln('del', 2, null, 'b')]);
    expect(removals.map((r) => r.right)).toEqual([null, null]);
  });

  test('an addition-only run pairs against filler rather than spinning', () => {
    const rows = pairSplitRows([ln('add', null, 1, 'x'), ln('del', 1, null, 'a')]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ left: null, right: expect.objectContaining({ content: 'x' }) });
    expect(rows[1]).toEqual({ left: expect.objectContaining({ content: 'a' }), right: null });
  });

  test('no lines yields no rows', () => {
    expect(pairSplitRows([])).toEqual([]);
  });
});

describe('side-by-side layout', () => {
  // INVARIANT: the browser only REGROUPS rows the server already paired. The
  // pairing itself stays in TypeScript (pairSplitRows, tested above) so the part
  // that can be wrong is testable; if these attributes stop being emitted, the
  // split layout silently degrades to a staircase with no failing test.
  test('every diff line is stamped with its split row and pane', () => {
    const html = renderReviewDiff(parseUnifiedDiff(PATCH), new Map());
    // The deletion of `const b = 2;` and the addition of `const b = 3;` share a
    // split row, one per pane.
    expect(html).toContain('data-side="old" data-line="2" data-rv-pair="1" data-rv-pane="l"');
    expect(html).toContain('data-side="new" data-line="2" data-rv-pair="1" data-rv-pane="r"');
    // A context line occupies both panes of a row of its own.
    expect(html).toContain('data-rv-pane="lr"');
  });

  // INVARIANT: full-width rows span BOTH layouts. The layout is switched in the
  // browser without re-fetching, so a hunk header or thread rendered with the
  // unified table's four columns has to survive the split table's six.
  test('full-width rows span the wider of the two layouts', () => {
    const html = renderReviewDiff(parseUnifiedDiff(PATCH), new Map());
    expect(html).toContain('<tr class="rv-hunk"><td colspan="6">');
    expect(html).not.toContain('colspan="4"');
  });

  // INVARIANT: a split row holds two lines, so the row can no longer say which
  // line a Reply beneath it belongs to. The thread carries its own anchor.
  test('a rendered thread carries the anchor it was written against', () => {
    const threads = new Map([
      [anchorKey({ file: 'src/foo.ts', side: 'old', line: 2 }), [{ threadId: 'th1', html: 'x' }]],
    ]);
    const html = renderReviewDiff(parseUnifiedDiff(PATCH), threads);
    expect(html).toContain(
      '<tr class="rv-thread-row" data-thread="th1" data-file="src/foo.ts" data-side="old" data-line="2">',
    );
  });

  test('the toolbar offers layout alongside wrap, as one list of modes', () => {
    const bar = diffViewOptionsHtml();
    expect(bar).toContain('data-rv-mode="layout" data-rv-value="unified" aria-pressed="true"');
    expect(bar).toContain('data-rv-mode="layout" data-rv-value="split"');
    expect(bar).toContain('data-rv-mode="wrap" data-rv-value="1"');
  });

  // Two panes of code do not fit on a phone, and the fallback has to be a real
  // relayout rather than a horizontal scrollbar into uselessness.
  test('the script falls back to unified below a breakpoint', () => {
    const js = diffViewScript('#rv-root');
    expect(js).toContain("matchMedia('(max-width: 900px)')");
    expect(js).toContain('splitBtn.disabled = narrow.matches');
  });

  // The unified body is detached rather than hidden while split is showing:
  // two copies in one document means two elements per anchor id, and the queued
  // comment list is built entirely out of links to those ids.
  test('only one layout is ever in the document at a time', () => {
    const js = diffViewScript('#rv-root');
    expect(js).toContain('table.__rvUnified = live');
    expect(js).toContain('table.replaceChild(buildSplit(live), live)');
  });

  // Against the BUNDLED sheet, not the .css file on disk: a compiled binary
  // can only serve what was compiled into it.
  test('the split styles ship with the shared stylesheet', () => {
    expect(bundledStylesheet()).toContain('tr.rv-pair td.rv-code');
    expect(bundledStylesheet()).toContain('td.rv-c-nil');
    expect(bundledStylesheet()).toContain('td.rv-code:target');
  });
});
