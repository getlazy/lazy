import { describe, test, expect } from 'bun:test';
import { parseQuery } from '../../src/search/parser';
import { evaluateQuery, buildSearchResults } from '../../src/search/evaluator';
import type { TaskData } from '../../src/search/evaluator';
import type { Task, Turn, Commit, Comment, FollowUp } from '../../src/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task-id-001',
    code: 'test-task',
    goal: 'Implement authentication module',
    prompt: 'Use OAuth2 with JWT tokens',
    type: 'task',
    status: 'working',
    priority: 'normal',
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

function makeFollowUp(overrides: Partial<FollowUp> = {}): FollowUp {
  return {
    id: 'followup-001',
    task_id: 'test-task-id-001',
    content: 'Consider extracting the retry helper into a shared module',
    created_at: Date.now(),
    ...overrides,
  };
}

function makeData(overrides: Partial<TaskData> = {}): TaskData {
  return {
    task: makeTask(),
    turns: [makeTurn()],
    commits: [makeCommit()],
    comments: [makeComment()],
    followUps: [makeFollowUp()],
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

  test('code: matches exact code', () => {
    const ast = parseQuery('code:test-task');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('code: is case-insensitive', () => {
    const ast = parseQuery('code:TEST-TASK');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('code: does not match wrong code', () => {
    const ast = parseQuery('code:other-task');
    expect(evaluateQuery(ast, makeData())).toBe(false);
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

  test('in:followups matches follow-up content', () => {
    const ast = parseQuery('in:followups retry');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('in:followups does not match when not in follow-ups', () => {
    const ast = parseQuery('in:followups nonexistent');
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

  test('has:followups is true when follow-ups exist', () => {
    const ast = parseQuery('has:followups');
    expect(evaluateQuery(ast, makeData())).toBe(true);
  });

  test('has:followups is false when no follow-ups', () => {
    const ast = parseQuery('has:followups');
    expect(evaluateQuery(ast, makeData({ followUps: [] }))).toBe(false);
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

  test('returns a followup-typed result when a follow-up matches', () => {
    const ast = parseQuery('"retry helper"');
    const results = buildSearchResults(ast, makeData());
    const followUpResults = results.filter(r => r.entity_type === 'followup');
    expect(followUpResults.length).toBe(1);
    expect(followUpResults[0].content).toContain('retry helper');
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
      followUps: [
        makeFollowUp({ id: 'followup-a', content: 'unrelated' }),
        makeFollowUp({ id: 'followup-b', content: 'reconciler retry helper' }),
      ],
    });
    const results = buildSearchResults(parseQuery('"reconciler"'), data);

    expect(results.find(r => r.entity_type === 'commit')?.entity_index).toBe(1);
    expect(results.find(r => r.entity_type === 'comment')?.entity_index).toBe(1);
    expect(results.find(r => r.entity_type === 'followup')?.entity_index).toBe(1);

    // A task/prompt hit has no position in any per-task list, so it must not
    // claim one — an index of 0 there would read as "the first turn".
    const taskHits = buildSearchResults(parseQuery('status:working'), makeData());
    expect(taskHits[0].entity_type).toBe('task');
    expect(taskHits[0].entity_index).toBeUndefined();
    expect(taskHits[0].turn_sequence).toBeUndefined();
  });
});
