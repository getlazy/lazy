import { describe, test, expect } from 'bun:test';
import {
  computeReviewActivity,
  isUpstreamMergeCommit,
  reviewActivityCardHtml,
} from '../../src/server/review-activity';
import type { Turn, Commit, Comment, JournalEntry, RaisedItem } from '../../src/types';

/**
 * "Since you last looked" — the window a returning reviewer sees on the review
 * and task pages.
 *
 * INVARIANT: the window is anchored on the last REVIEW CHUNK BOUNDARY
 * (src/utils/turn-chunks.ts) — a human/builder turn that automation did not
 * write — never on the last commit. The commit anchor answers a different
 * question ("what did the agent last WRITE") and would jump the window forward
 * on every agent commit, hiding exactly the turns the reviewer came back for.
 * Merge filtering applies to the COMMIT LIST only, so an upstream sync's merge
 * is never shown as work the agent did.
 */

let seq = 0;
function turn(role: Turn['role'], timestamp: number, extra: Partial<Turn> = {}): Turn {
  seq += 1;
  return {
    id: `t${seq}`,
    session_id: 's1',
    sequence: seq,
    role,
    content: `turn ${seq}`,
    timestamp,
    usage: null,
    start_sha: null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: null,
    ...extra,
  } as Turn;
}

function commit(sha: string, message: string, timestamp: number): Commit {
  return { id: `c-${sha}`, session_id: 's1', sha, message, status: 'pending_review', timestamp };
}

const comment = (id: string, created_at: number): Comment =>
  ({ id, task_id: 'task', content: `comment ${id}`, created_at }) as Comment;
const journal = (id: string, created_at: number): JournalEntry =>
  ({ id, task_id: 'task', content: `entry ${id}`, created_at }) as JournalEntry;
const raised = (id: string, created_at: number, blocking = true): RaisedItem =>
  ({ id, task_id: 'task', content: `raised ${id}`, created_at, status: 'open', blocking }) as RaisedItem;

const empty = { turns: [], commits: [], comments: [], journal: [], raisedItems: [] };

describe('isUpstreamMergeCommit', () => {
  // Stored commits carry no parent count, so lazy's own merge message shape is
  // the signal — see the module header for why that is the right trade here.
  test('recognizes the merge messages lazy itself writes', () => {
    expect(isUpstreamMergeCommit('Merge main')).toBe(true);
    expect(isUpstreamMergeCommit('Merge lazy/parent into lazy/child')).toBe(true);
    expect(isUpstreamMergeCommit('  Merge main  ')).toBe(true);
  });

  test('leaves ordinary agent commits alone', () => {
    expect(isUpstreamMergeCommit('Add the watch panel')).toBe(false);
    expect(isUpstreamMergeCommit('Fix merge conflict handling')).toBe(false);
    expect(isUpstreamMergeCommit('Merged upstream by hand')).toBe(false);
  });
});

describe('computeReviewActivity', () => {
  test('anchors on the last human turn, not on the last sync turn', () => {
    const turns = [
      turn('human', 100),                                  // an early unblock
      turn('agent', 110),
      turn('human', 200),                                  // the reviewer's LAST look
      turn('agent', 210),
      // A sync turn is automation, not a review intervention: it must NOT move
      // the anchor forward past the agent work the reviewer has not seen.
      turn('human', 220, { actor: 'system' }),
      turn('agent', 230),
    ];

    const activity = computeReviewActivity({ ...empty, turns });

    expect(activity.since).toBe(200);
    expect(activity.turns.map((t) => t.timestamp)).toEqual([210, 230]);
    expect(activity.empty).toBe(false);
    expect(activity.anchorLabel).toContain('since you last acted');
  });

  test('an auto-triggered resume is automation too', () => {
    const turns = [
      turn('human', 100),
      turn('agent', 110),
      turn('human', 150, { auto_triggered: true } as Partial<Turn>),
      turn('agent', 160),
    ];

    const activity = computeReviewActivity({ ...empty, turns });
    expect(activity.since).toBe(100);
    expect(activity.turns.map((t) => t.timestamp)).toEqual([110, 160]);
  });

  test('excludes upstream merge commits and anything from before the anchor', () => {
    const turns = [turn('human', 100), turn('agent', 110), turn('human', 200), turn('agent', 210)];
    const commits = [
      commit('aaaaaaaa', 'Old work the reviewer already saw', 120),
      commit('bbbbbbbb', 'Merge lazy/parent into lazy/child', 205),
      commit('cccccccc', 'Add the thing', 215),
    ];

    const activity = computeReviewActivity({ ...empty, turns, commits });
    expect(activity.commits.map((c) => c.sha)).toEqual(['cccccccc']);
  });

  // INVARIANT: raised items are ONE stream regardless of the blocking flag —
  // "what happened since you last looked" does not fork on whether an item
  // gates accept. See docs/design/raised-items-unified.md.
  test('carries comments, journal entries and raised items of either flag from after the anchor', () => {
    const turns = [turn('human', 200)];
    const activity = computeReviewActivity({
      turns,
      commits: [],
      comments: [comment('before', 150), comment('after', 250)],
      journal: [journal('before', 150), journal('after', 250)],
      raisedItems: [
        raised('before', 150),
        raised('after', 250),
        raised('after-nonblocking', 260, false),
      ],
    });

    expect(activity.comments.map((c) => c.id)).toEqual(['after']);
    expect(activity.journal.map((j) => j.id)).toEqual(['after']);
    expect(activity.raisedItems.map((r) => r.id)).toEqual(['after', 'after-nonblocking']);
  });

  test('says so in one line when nothing has happened', () => {
    const turns = [turn('human', 300)];
    const activity = computeReviewActivity({ ...empty, turns });

    expect(activity.empty).toBe(true);
    expect(activity.turns).toEqual([]);
    const html = reviewActivityCardHtml(activity, 'task-1');
    expect(html).toContain('Nothing has happened since you last looked');
  });

  // A task that auto-started and worked without any human turn has no anchor;
  // the whole session IS the window, which is the correct answer for it.
  test('with no human turn at all, the window is the whole session', () => {
    const turns = [turn('agent', 110), turn('agent', 120)];
    const activity = computeReviewActivity({
      ...empty,
      turns,
      commits: [commit('dddddddd', 'First work', 115)],
    });

    expect(activity.since).toBeNull();
    expect(activity.anchorLabel).toBeNull();
    expect(activity.turns).toHaveLength(2);
    expect(activity.commits).toHaveLength(1);
  });
});

describe('reviewActivityCardHtml', () => {
  test('links each turn and commit into the page that shows it', () => {
    const turns = [turn('human', 200), turn('agent', 210)];
    const activity = computeReviewActivity({
      ...empty,
      turns,
      commits: [commit('eeeeeeee', 'Add the thing', 215)],
    });
    const agentTurn = activity.turns[0]!;

    const html = reviewActivityCardHtml(activity, 'task-1');
    expect(html).toContain(`/tasks/task-1/turns/${agentTurn.sequence}`);
    expect(html).toContain('/tasks/task-1/commits/c-eeeeeeee');
    expect(html).toContain('Since you last looked');
    expect(html).toContain('1 turn, 1 commit');
  });

  test('every row kind is a link — raised, comment, journal included', () => {
    const turns = [turn('human', 200), turn('agent', 210)];
    const activity = computeReviewActivity({
      ...empty,
      turns,
      comments: [comment('cmt-1', 220)],
      journal: [journal('jnl-1', 230)],
      raisedItems: [raised('rai-1', 240)],
    });
    // Journal entries with a markdown heading strip the marker in the label.
    activity.journal[0]!.content = '## How the numbers were produced';

    const html = reviewActivityCardHtml(activity, 'task-1');
    expect(html).toContain('href="/raised/rai-1"');
    expect(html).toContain('href="/tasks/task-1/turns#comment-cmt-1"');
    expect(html).toContain('href="/tasks/task-1/turns#journal-jnl-1"');
    expect(html).toContain('How the numbers were produced');
    expect(html).not.toContain('## How');
    expect(html).toContain('Raised');
    expect(html).toContain('Comment');
    expect(html).toContain('Journal');
  });

  test('escapes content that came from an agent', () => {
    const turns = [turn('human', 200), turn('agent', 210, { content: '<script>alert(1)</script>' })];
    const activity = computeReviewActivity({ ...empty, turns });

    const html = reviewActivityCardHtml(activity, 'task-1');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('a review turn names the verdict instead of dumping JSON', () => {
    const turns = [
      turn('human', 200),
      turn('agent', 210, {
        turn_type: 'review',
        content: '{"verdict":"request changes","security":"none found"}',
        review: {
          verdict: 'request changes',
          security: 'none found',
          data_integrity: 'none found',
          findings: [],
        },
      }),
    ];
    const activity = computeReviewActivity({ ...empty, turns });
    const html = reviewActivityCardHtml(activity, 'task-1');
    expect(html).toContain('Review: request changes');
    expect(html).not.toContain('"verdict"');
  });
});
