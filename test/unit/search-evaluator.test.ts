import { describe, test, expect } from 'bun:test';
import { parseQuery } from '../../src/search/parser';
import { evaluateQuery, buildSearchResults } from '../../src/search/evaluator';
import type { TaskData } from '../../src/search/evaluator';
import type { Task, Turn, Commit, Comment, RaisedItem } from '../../src/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task-id-001',
    code: 'test-task',
    goal: 'Implement authentication module',
    prompt: 'Use OAuth2 with JWT tokens',
    type: 'task',
    status: 'working',
    created_at: new Date('2026-02-15T10:00:00Z').getTime(),
    completed_at: null,
    target: { kind: 'branch' as const, branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: 'claude-opus-4-6',
    agent_id: 'claude-code',
    metadata: null,
    tags: [],
    pending_sync: 0,
    runner_type: null,
    ...overrides,
  };
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn-001',
    session_id: 'sess-001',
    sequence: 1,
    role: 'agent',
    content: 'Working on the reconciler logic',
    timestamp: Date.now(),
    usage: null,
    start_sha: null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: null,
    ...overrides,
  };
}

function makeCommit(overrides: Partial<Commit> = {}): Commit {
  return {
    id: 'commit-001',
    session_id: 'sess-001',
    sha: 'abc1234',
    message: 'Fix bug in reconciler',
    status: 'pending_review',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'comment-001',
    task_id: 'test-task-id-001',
    content: 'This needs more testing',
    created_at: Date.now(),
    ...overrides,
  };
}

function makeRaisedItem(overrides: Partial<RaisedItem> = {}): RaisedItem {
  return {
    id: 'raised-001',
    task_id: 'test-task-id-001',
    content: 'Should we keep the legacy proxy warning or drop it?',
    created_at: Date.now(),
    status: 'open',
    blocking: true,
    ...overrides,
  };
}

// A non-blocking raised item — what used to be a follow-up. Search treats both
// the same: one array, one set of scopes.
function makeNonBlockingRaisedItem(overrides: Partial<RaisedItem> = {}): RaisedItem {
  return makeRaisedItem({
    id: 'raised-fyi-001',
    content: 'Consider extracting the retry helper into a shared module',
    blocking: false,
    ...overrides,
  });
}

function makeData(overrides: Partial<TaskData> = {}): TaskData {
  return {
    task: makeTask(),
    turns: [makeTurn()],
    commits: [makeCommit()],
    comments: [makeComment()],
    raisedItems: [makeRaisedItem(), makeNonBlockingRaisedItem()],
    ...overrides,
  };

}

describe('evaluateQuery', () => {
  test('text matches goal', () => {
    const ast = parseQuery('"authentication"');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('text does not match', () => {
    const ast = parseQuery('"nonexistent"');
    expect(evaluateQuery(ast, makeData())).toBe(false);
  });

  test('text matches prompt', () => {
    const ast = parseQuery('"OAuth2"');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('text matches turn content', () => {
    const ast = parseQuery('"reconciler"');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('text matches commit message', () => {
    const ast = parseQuery('"Fix bug"');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('text matches comment content', () => {
    const ast = parseQuery('"more testing"');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('in:tasks searches all task-associated content', () => {
    for (const term of ['test-task', 'authentication', 'OAuth2', 'reconciler', 'Fix bug', 'more testing', 'legacy proxy']) {
      expect(evaluateQuery(parseQuery(`in:tasks "${term}"`), makeData())).toBe(true);
    }
  });

  test('status-group scopes search task content only within their lifecycle group', () => {
    const statuses = ['working', 'interrupted', 'blocked', 'backlog', 'complete', 'abandoned'] as const;
    for (const status of statuses) {
      const data = makeData({ task: makeTask({ status }) });
      expect(evaluateQuery(parseQuery('in:active authentication'), data))
        .toBe(['working', 'interrupted', 'blocked'].includes(status));
      expect(evaluateQuery(parseQuery('in:backlog authentication'), data)).toBe(status === 'backlog');
      expect(evaluateQuery(parseQuery('in:finished authentication'), data))
        .toBe(['complete', 'abandoned'].includes(status));
    }
  });

  test('status-group scopes require both matching content and status', () => {
    const data = makeData({ task: makeTask({ status: 'working' }) });
    expect(evaluateQuery(parseQuery('in:active nonexistent'), data)).toBe(false);
  });

  test('status:working matches', () => {
    const ast = parseQuery('status:working');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('status:blocked does not match', () => {
    const ast = parseQuery('status:blocked');
    expect(evaluateQuery(ast, makeData())).toBe(false);
  });

  test('goal: matches substring', () => {
    const ast = parseQuery('goal:authentication');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('goal: does not match', () => {
    const ast = parseQuery('goal:database');
    expect(evaluateQuery(ast, makeData())).toBe(false);
  });

  test('task: matches the whole code', () => {
    const ast = parseQuery('task:test-task');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('task: is case-insensitive', () => {
    const ast = parseQuery('task:TEST-TASK');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  // INVARIANT: task: is a SUBSTRING match over the code, not exact equality and
  // not prefix-anchored. Exact equality is what made `code:spike` (the old
  // spelling) return zero hits across a project full of `spike-*` and `*-spike`
  // codes — the human's obvious query answering "nothing" while the same string
  // in the dashboard answered "4". Documented as substring in
  // src/search/grammar.ts; the two must not diverge again.
  test('task: matches a substring anywhere in the code', () => {
    const anchored = makeData({ task: makeTask({ code: 'spike-vm-isolation' }) });
    const suffixed = makeData({ task: makeTask({ code: 'publish-runner-spike' }) });
    const infixed = makeData({ task: makeTask({ code: 'do-spike-thing' }) });

    for (const data of [anchored, suffixed, infixed]) {
      expect(evaluateQuery(parseQuery('task:spike'), data)).toBe(true);
    }
  });

  test('task: does not match an unrelated code', () => {
    const ast = parseQuery('task:other-task');
    expect(evaluateQuery(ast, makeData())).toBe(false);
  });

  test('task: does not match a task with no code', () => {
    const ast = parseQuery('task:spike');
    expect(evaluateQuery(ast, makeData({ task: makeTask({ code: null }) }))).toBe(false);
  });

  // INVARIANT: status: stays EXACT while task:/goal: are substrings. Status is a
  // closed enum, so a substring match would make `status:complete` also match
  // nothing useful and `status:work` match 'working' — a filter that quietly
  // widens is worse than one that is documented narrow.
  test('status: is exact, not a substring', () => {
    expect(evaluateQuery(parseQuery('status:working'), makeData())).toBe(true);
    expect(evaluateQuery(parseQuery('status:work'), makeData())).toBe(false);
  });

  test('tag: matches a tag the task carries', () => {
    const ast = parseQuery('tag:onboarding');
    expect(evaluateQuery(ast, makeData({ task: makeTask({ tags: ['onboarding', 'launch'] }) }))).toBe(true);
  });

  test('tag: does not match a tag the task lacks', () => {
    const ast = parseQuery('tag:infra');
    expect(evaluateQuery(ast, makeData({ task: makeTask({ tags: ['onboarding'] }) }))).toBe(false);
  });

  test('tag: normalizes the query value the same way tags are stored', () => {
    // "[Onboarding]" normalizes to "onboarding" at parse time, matching the
    // stored normalized tag.
    const ast = parseQuery('tag:[Onboarding]');
    expect(evaluateQuery(ast, makeData({ task: makeTask({ tags: ['onboarding'] }) }))).toBe(true);
  });

  test('tag: does not match a task with no tags', () => {
    const ast = parseQuery('tag:onboarding');
    expect(evaluateQuery(ast, makeData({ task: makeTask({ tags: [] }) }))).toBe(false);
  });

  test('in:turns matches turn content', () => {
    const ast = parseQuery('in:turns reconciler');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('in:turns does not match when not in turns', () => {
    const ast = parseQuery('in:turns nonexistent');
    expect(evaluateQuery(ast, makeData())).toBe(false);
  });

  test('in:commits matches commit message', () => {
    const ast = parseQuery('in:commits reconciler');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('in:comments matches comment content', () => {
    const ast = parseQuery('in:comments testing');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  // `in:followups` is the pre-unification spelling of `in:raised` — one entity,
  // two names, for one release.
  test('in:followups is an alias for in:raised over the same array', () => {
    const ast = parseQuery('in:followups retry');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('in:followups does not match when not in raised items', () => {
    const ast = parseQuery('in:followups nonexistent');
    expect(evaluateQuery(ast, makeData())).toBe(false);
  });

  test('in:raised matches a blocking item', () => {
    const ast = parseQuery('in:raised proxy');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('in:raised matches a non-blocking item too — one scope covers both', () => {
    const ast = parseQuery('in:raised retry');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('in:raised does not match when not in raised items', () => {
    const ast = parseQuery('in:raised nonexistent');
    expect(evaluateQuery(ast, makeData())).toBe(false);
  });

  test('has:commits is true when commits exist', () => {
    const ast = parseQuery('has:commits');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('has:commits is false when no commits', () => {
    const ast = parseQuery('has:commits');
    expect(evaluateQuery(ast, makeData({ commits: [] }))).toBe(false);
  });

  test('has:turns is true when turns exist', () => {
    const ast = parseQuery('has:turns');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('has:turns is false when no turns', () => {
    const ast = parseQuery('has:turns');
    expect(evaluateQuery(ast, makeData({ turns: [] }))).toBe(false);
  });

  test('has:comments is true when comments exist', () => {
    const ast = parseQuery('has:comments');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('has:comments is false when no comments', () => {
    const ast = parseQuery('has:comments');
    expect(evaluateQuery(ast, makeData({ comments: [] }))).toBe(false);
  });

  // `has:followups` is the pre-unification spelling and answers over the same
  // array — a task with only blocking items still satisfies it.
  test('has:followups is true when raised items exist', () => {
    const ast = parseQuery('has:followups');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('has:followups is false when no raised items', () => {
    const ast = parseQuery('has:followups');
    expect(evaluateQuery(ast, makeData({ raisedItems: [] }))).toBe(false);
  });

  test('has:raised is true when raised items exist', () => {
    const ast = parseQuery('has:raised');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('has:raised is false when no raised items', () => {
    const ast = parseQuery('has:raised');
    expect(evaluateQuery(ast, makeData({ raisedItems: [] }))).toBe(false);
  });

  test('created:> matches tasks after date', () => {
    const ast = parseQuery('created:>2026-02-14');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('created:> does not match tasks before date', () => {
    const ast = parseQuery('created:>2026-02-16');
    expect(evaluateQuery(ast, makeData())).toBe(false);
  });

  test('created:< matches tasks before date', () => {
    const ast = parseQuery('created:<2026-02-16');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('created:< does not match tasks after date', () => {
    const ast = parseQuery('created:<2026-02-14');
    expect(evaluateQuery(ast, makeData())).toBe(false);
  });

  test('updated: uses completed_at when available', () => {
    const ast = parseQuery('updated:>2026-03-01');
    const data = makeData({
      task: makeTask({ completed_at: new Date('2026-03-15T00:00:00Z').getTime() }),
    });
    expect(evaluateQuery(ast, data)).toBe(true);
  });

  test('AND requires both conditions', () => {
    const ast = parseQuery('status:working AND has:commits');
    expect(evaluateQuery(ast, makeData())).toBe(true);

    const ast2 = parseQuery('status:blocked AND has:commits');
    expect(evaluateQuery(ast2, makeData())).toBe(false);
  });

  test('OR requires at least one condition', () => {
    const ast = parseQuery('status:blocked OR has:commits');
    expect(evaluateQuery(ast, makeData())).toBe(true);

    const ast2 = parseQuery('status:blocked OR status:interrupted');
    expect(evaluateQuery(ast2, makeData())).toBe(false);
  });

  test('NOT negates the result', () => {
    const ast = parseQuery('NOT status:blocked');
    expect(evaluateQuery(ast, makeData())).toBe(true);

    const ast2 = parseQuery('NOT status:working');
    expect(evaluateQuery(ast2, makeData())).toBe(false);
  });

  test('complex query: has:commits AND NOT in:commits "wip"', () => {
    const ast = parseQuery('has:commits AND NOT in:commits "wip"');
    expect(evaluateQuery(ast, makeData())).toBe(true);

    const data2 = makeData({ commits: [makeCommit({ message: 'wip: initial work' })] });
    expect(evaluateQuery(ast, data2)).toBe(false);
  });

  test('complex query with parentheses', () => {
    const ast = parseQuery('(status:blocked OR status:working) AND has:turns');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });
});

describe('buildSearchResults', () => {
  test('returns task-level result for non-text queries', () => {
    const ast = parseQuery('status:working');
    const results = buildSearchResults(ast, makeData());
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].entity_type).toBe('task');
    expect(results[0].task_code).toBe('test-task');
  });

  test('returns matches for text queries', () => {
    const ast = parseQuery('"reconciler"');
    const results = buildSearchResults(ast, makeData());
    // Should find it in turns and commits
    const types = results.map(r => r.entity_type);
    expect(types).toContain('turn');
    expect(types).toContain('commit');
  });

  test('deduplicates results by entity', () => {
    // A query with two text terms that match the same turn
    const ast = parseQuery('in:turns "reconciler"');
    const data = makeData();
    const results = buildSearchResults(ast, data);
    // The in: node produces text terms, so we get turn match
    const turnResults = results.filter(r => r.entity_type === 'turn');
    expect(turnResults.length).toBe(1);
  });

  // INVARIANT: blocking and non-blocking raised items share ONE entity_type.
  // The blocking flag is a property of the item, not a different kind of thing,
  // so search must not fork its result vocabulary on it.
  test('returns a raised-typed result when a raised item matches', () => {
    const ast = parseQuery('"retry helper"');
    const results = buildSearchResults(ast, makeData());
    const raisedResults = results.filter(r => r.entity_type === 'raised');
    expect(raisedResults.length).toBe(1);
    expect(raisedResults[0].content).toContain('retry helper');
  });

  test('a blocking raised item produces the same entity_type as a non-blocking one', () => {
    const ast = parseQuery('"legacy proxy warning"');
    const results = buildSearchResults(ast, makeData());
    const raisedResults = results.filter(r => r.entity_type === 'raised');
    expect(raisedResults.length).toBe(1);
  });

  // INVARIANT: a turn hit must say WHICH turn matched. Search excerpts are
  // truncated by design (search locates, show reads), so a hit that names only
  // the task forces the reader to page through show by hand. entity_index is
  // the turn's position in the list show pages over — usable directly as its
  // `offset` — and turn_sequence is the number show prints.
  test('turn hits carry entity_index and turn_sequence', () => {
    const data = makeData({
      turns: [
        makeTurn({ id: 'turn-a', sequence: 0, content: 'unrelated preamble' }),
        makeTurn({ id: 'turn-b', sequence: 1, content: 'first pass at the reconciler' }),
        makeTurn({ id: 'turn-c', sequence: 2, content: 'more unrelated text' }),
        makeTurn({ id: 'turn-d', sequence: 3, content: 'reconciler follow-up work' }),
      ],
    });
    const ast = parseQuery('in:turns "reconciler"');
    const turnResults = buildSearchResults(ast, data).filter(r => r.entity_type === 'turn');

    expect(turnResults.length).toBe(2);
    expect(turnResults[0].entity_index).toBe(1);
    expect(turnResults[0].turn_sequence).toBe(1);
    expect(turnResults[1].entity_index).toBe(3);
    expect(turnResults[1].turn_sequence).toBe(3);
  });

  // The index is a POSITION in the list, not the turn's sequence number. They
  // diverge whenever a session's sequences do not start at 0 — passing a
  // sequence as show's `offset` would then land on the wrong turn, so the two
  // must stay separate fields.
  test('entity_index is a position, independent of the sequence number', () => {
    const data = makeData({
      turns: [
        makeTurn({ id: 'turn-a', sequence: 7, content: 'unrelated' }),
        makeTurn({ id: 'turn-b', sequence: 8, content: 'the reconciler again' }),
      ],
    });
    const ast = parseQuery('in:turns "reconciler"');
    const [hit] = buildSearchResults(ast, data).filter(r => r.entity_type === 'turn');

    expect(hit.entity_index).toBe(1);
    expect(hit.turn_sequence).toBe(8);
  });

  test('commit, comment and follow-up hits carry entity_index; task hits do not', () => {
    const data = makeData({
      commits: [
        makeCommit({ id: 'commit-a', message: 'unrelated' }),
        makeCommit({ id: 'commit-b', message: 'Fix bug in reconciler' }),
      ],
      comments: [
        makeComment({ id: 'comment-a', content: 'unrelated' }),
        makeComment({ id: 'comment-b', content: 'the reconciler needs a look' }),
      ],
      raisedItems: [
        makeRaisedItem({ id: 'raised-a', content: 'unrelated' }),
        makeNonBlockingRaisedItem({ id: 'raised-b', content: 'reconciler retry helper' }),
      ],
    });
    const results = buildSearchResults(parseQuery('"reconciler"'), data);

    expect(results.find(r => r.entity_type === 'commit')?.entity_index).toBe(1);
    expect(results.find(r => r.entity_type === 'comment')?.entity_index).toBe(1);
    expect(results.find(r => r.entity_type === 'raised')?.entity_index).toBe(1);

    // A task/prompt hit has no position in any per-task list, so it must not
    // claim one — an index of 0 there would read as "the first turn".
    const taskHits = buildSearchResults(parseQuery('status:working'), makeData());
    expect(taskHits[0].entity_type).toBe('task');
    expect(taskHits[0].entity_index).toBeUndefined();
    expect(taskHits[0].turn_sequence).toBeUndefined();
  });
});
