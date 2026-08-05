/**
 * Regression suite for content-less turns.
 *
 * Two live crashes (2026-08-03) had the same root cause: a persisted turn
 * record whose `content` field was absent, even though `Turn.content` is typed
 * as a required string. Reading it back crashed:
 *
 *   - accept → fidelity `formatTurn` → `turn.content.trim()`
 *     ("undefined is not an object (evaluating 'turn.content.trim')")
 *   - `lazy search` → evaluator `textContains` → `haystack.toLowerCase()`
 *     ("undefined is not an object (evaluating 'haystack.toLowerCase')")
 *
 * INVARIANT: a turn without content must NEVER crash a read path — and above
 * all must never crash an ACCEPT. Old records with the defect already exist in
 * users' stores, so read paths must degrade to '' forever, not just until the
 * write path is fixed. The write-path guard (normalizeTurnContent) stops new
 * ones being created; these tests pin both halves.
 */
import { describe, test, expect } from 'bun:test';
import { synthesizeFidelityBody, regenerateFidelity } from '../../src/synthesis/fidelity';
import type { Summarizer } from '../../src/synthesis/summarizer';
import { parseQuery } from '../../src/search/parser';
import { evaluateQuery, buildSearchResults } from '../../src/search/evaluator';
import type { TaskData } from '../../src/search/evaluator';
import { normalizeTurnContent, turnText } from '../../src/utils/turn-content';
import type { Task, Turn, Commit, Comment, Session } from '../../src/types';
import type { Storage } from '../../src/storage';
import type { RepositoryDriver } from '../../src/remote/driver';

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task1234',
    code: 'crashy-task',
    goal: 'A task whose history contains a crashed turn',
    prompt: 'do the thing',
    type: 'task',
    status: 'blocked',
    priority: 'normal',
    created_at: Date.now(),
    completed_at: null,
    target: { kind: 'branch' as const, branch: 'main' },
    branched_from_sha: null,
    close_reason: null,
    model: null,
    agent_id: 'claude-code',
    metadata: {},
    pending_sync: 0,
    runner_type: null,
    tags: [],
    ...overrides,
  };
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn-001',
    session_id: 'sess1',
    sequence: 1,
    role: 'agent',
    content: 'a normal report',
    timestamp: 1,
    usage: null,
    start_sha: null,
    start_sha_work: null,
    end_sha_work: null,
    end_sha: null,
    ...overrides,
  };
}

/**
 * A turn record as it actually exists on disk after the defect: the `content`
 * key is ABSENT (JSON.stringify drops `undefined`), so reading it back yields
 * `undefined` despite the type claiming `string`.
 */
function contentLessTurn(overrides: Partial<Turn> = {}): Turn {
  const turn = makeTurn(overrides) as Partial<Turn>;
  delete turn.content;
  return turn as Turn;
}

function fakeStorage(parts: { turns?: Turn[]; commits?: Partial<Commit>[] }): Storage {
  const session: Session = { id: 'sess1', task_id: 'task1234' } as unknown as Session;
  return {
    getSessionByTaskId: async () => session,
    getSessionTurns: async () => parts.turns ?? [],
    getSessionCommits: async () => (parts.commits ?? []).map((c, i) => ({
      id: `c${i}`, session_id: 'sess1', sha: `sha${i}`, message: 'a commit', timestamp: i,
      ...c,
    })) as Commit[],
    getTaskComments: async () => [] as Comment[],
    getChildTasks: async () => [] as Task[],
  } as unknown as Storage;
}

const echoSummarizer: Summarizer = {
  summarize: async input => `SUMMARY::${input.bundle}`,
};

describe('fidelity over a content-less turn', () => {
  // INVARIANT: accept regenerates the fidelity record before merge
  // (task-lifecycle step 4b). A turn without content must not crash that —
  // an un-acceptable task is a hard stop for the human.
  test('synthesizeFidelityBody does not throw and renders a placeholder', async () => {
    const storage = fakeStorage({
      turns: [
        makeTurn({ sequence: 1, role: 'human', actor: 'human', content: 'please fix it' }),
        contentLessTurn({ id: 'turn-002', sequence: 2 }),
      ],
      commits: [{ message: 'fix: the thing' }],
    });

    const result = await synthesizeFidelityBody(storage, makeTask(), echoSummarizer);

    expect(result.synthesized).toBe(true);
    expect(result.summary).toContain('please fix it');
    // The content-less turn is still listed (its existence is signal), with a
    // visible placeholder rather than a crash or a silently blank line.
    expect(result.summary).toContain('(no content recorded)');
  });

  // INVARIANT: synthesis is an enhancement, never a gate. A throw anywhere in
  // gathering — not just in the Summarizer — must degrade to the deterministic
  // commit-subject fallback so accept still completes.
  test('a throw while gathering events falls back instead of aborting', async () => {
    const storage = {
      getSessionByTaskId: async () => { throw new Error('storage exploded'); },
      getSessionCommits: async () => [] as Commit[],
      getTaskComments: async () => [] as Comment[],
      getChildTasks: async () => [] as Task[],
    } as unknown as Storage;

    const result = await synthesizeFidelityBody(storage, makeTask(), echoSummarizer);
    expect(result.synthesized).toBe(false);
    expect(result.summary.length).toBeGreaterThan(0);
  });

  // INVARIANT: regenerateFidelity NEVER throws — it is called inline on the
  // accept path, before the merge.
  test('regenerateFidelity survives a content-less turn', async () => {
    const storage = fakeStorage({
      turns: [contentLessTurn()],
      commits: [{ message: 'fix: the thing' }],
    });
    const driver = {
      needsSync: false,
      hasRemoteRef: () => false,
      updateRemoteBody: async () => { throw new Error('should not be called'); },
    } as unknown as RepositoryDriver;

    const result = await regenerateFidelity(storage, makeTask(), driver, echoSummarizer);
    expect(result.fidelityBody).toBeDefined();
  });
});

describe('search over a content-less turn', () => {
  function taskData(turns: Turn[]): TaskData {
    return {
      task: makeTask(),
      turns,
      commits: [],
      comments: [],
      followUps: [],
      promptHistory: [],
    } as unknown as TaskData;
  }

  // INVARIANT: a boolean/structured query must not crash on a turn whose
  // content is missing — `lazy search` is a read command over ALL tasks, so one
  // defective record would otherwise break search for the whole project.
  test('evaluateQuery does not throw on in:turns over a content-less turn', () => {
    const data = taskData([contentLessTurn(), makeTurn({ id: 'turn-002', sequence: 2 })]);

    const q = parseQuery('in:turns normal AND status:blocked');
    expect(() => evaluateQuery(q, data)).not.toThrow();
    expect(evaluateQuery(q, data)).toBe(true);
  });

  test('bare-term evaluation and result building tolerate a content-less turn', () => {
    const data = taskData([contentLessTurn()]);

    const q = parseQuery('zzzz-no-such-term');
    expect(() => evaluateQuery(q, data)).not.toThrow();
    expect(() => buildSearchResults(q, data)).not.toThrow();
    // A content-less turn matches nothing rather than crashing. (The builder
    // still emits its task-level fallback row, which is pre-existing behavior.)
    expect(buildSearchResults(q, data).some(r => r.entity_type === 'turn')).toBe(false);
  });
});

describe('turn content helpers', () => {
  test('turnText degrades a missing content to an empty string', () => {
    expect(turnText(contentLessTurn())).toBe('');
    expect(turnText(makeTurn({ content: 'hi' }))).toBe('hi');
    expect(turnText(null)).toBe('');
  });

  // INVARIANT: the write path must never persist a turn without content. The
  // Turn type says content is required, so a writer violating it is the bug —
  // we coerce to '' (never lose the turn) and warn loudly so the offending
  // caller is identifiable in the logs.
  test('normalizeTurnContent coerces non-strings to an empty string', () => {
    expect(normalizeTurnContent(undefined, 'test')).toBe('');
    expect(normalizeTurnContent(null, 'test')).toBe('');
    expect(normalizeTurnContent('kept', 'test')).toBe('kept');
    expect(normalizeTurnContent('', 'test')).toBe('');
  });
});
