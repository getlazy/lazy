import { describe, test, expect } from 'bun:test';
import { parseQuery } from '../../src/search/parser';
import { evaluateQuery, buildSearchResults } from '../../src/search/evaluator';
import type { TaskData } from '../../src/search/evaluator';
import type { Task, Turn, Commit, Comment } from '../../src/types';

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
    pending_sync: 0,
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

function makeData(overrides: Partial<TaskData> = {}): TaskData {
  return {
    task: makeTask(),
    turns: [makeTurn()],
    commits: [makeCommit()],
    comments: [makeComment()],
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
});
