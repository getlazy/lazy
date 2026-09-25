/**
 * Ranking tests — the order search results come back in.
 *
 * executeSearch() (src/search/run.ts) is the one search entry point, and
 * rankSearchResults() (src/search/ranking.ts) is the one ordering rule:
 * entity type tier first, match strength within a tier, then recency, then
 * the engine's original order. These tests pin the rules through the PUBLIC
 * entry point wherever possible, because the guarantee the engineer asked
 * for is about what surfaces return, not about a helper's output.
 *
 * The row-shape helpers below exist because ranking is a pure function over
 * SearchResult — feeding it hand-built rows exercises the ordering without
 * building storage fixtures, while the executeSearch() tests at the bottom
 * prove the wiring into the real producers.
 */

import { describe, test, expect } from 'bun:test';
import { rankSearchResults, queryLiteralTerms, entityTimeFromIso } from '../../src/search/ranking';
import { executeSearch } from '../../src/search/run';
import { parseQuery } from '../../src/search/parser';
import type { SearchResult } from '../../src/storage/types';
import type { QueryNode } from '../../src/search/parser';

// ─── row builders ────────────────────────────────────────────────────────────

let nextRowId = 0;

function row(overrides: Partial<SearchResult> = {}): SearchResult {
  nextRowId += 1;
  return {
    entity_type: 'turn',
    entity_id: `entity-${nextRowId}`,
    task_id: 'task-1',
    task_code: 'task-1',
    task_goal: 'the goal',
    content: 'some content',
    match_context: 'some context',
    ...overrides,
  };
}

function taskRow(overrides: Partial<SearchResult> = {}): SearchResult {
  return row({ entity_type: 'task', task_code: 'auth-task', content: 'code: auth-task', ...overrides });
}

// ─── the order itself ────────────────────────────────────────────────────────

describe('rankSearchResults', () => {
  test('an exact task-code query puts that task first, ahead of mentions', () => {
    // INVARIANT: typing a task's exact code makes that task's row the first
    // hit. Everything else that matched — turns, commits, prompts that merely
    // mention the code — comes after it. This is the case the engineer named
    // when search results had no deliberate order.
    const code = 'fix-search-result-ranking';
    const mentions: SearchResult[] = [
      row({ entity_type: 'turn', task_code: 'other-task', content: `starting ${code} now` }),
      row({ entity_type: 'commit', task_code: 'other-task', content: `merge ${code}` }),
      row({ entity_type: 'prompt', task_code: 'other-task', content: `see ${code} for context` }),
      row({ entity_type: 'comment', task_code: 'other-task', content: `blocked on ${code}` }),
      // Two competitors in the SAME tier, both deliberately NEWER than the
      // task row below, so tier cannot separate them from it and recency
      // actively favours them. Do not "tidy" the times to match.
      // A substring match: mentions the code without being it.
      taskRow({ task_code: 'other-task', content: `goal mentions ${code}`, entity_time: 9999 }),
      // A PREFIX match — the real collision a human hits, `…-v2` beside the
      // task they typed. This is what makes the test discriminate the EXACT
      // step specifically: an exact match is also a prefix match, so without
      // this row, disabling exact leaves the real task at prefix strength,
      // still ahead of the substring row, and the test passes anyway.
      taskRow({ task_code: `${code}-v2`, content: `code: ${code}-v2`, entity_time: 9999 }),
    ];
    // task_code IS the code, so this row matches EXACTLY (identityTexts reads
    // task_code and content; strength is exact only when one of them equals
    // the term). Passing only `content` would make it a substring match and
    // the assertion would pass on tier plus recency alone.
    const theTask = taskRow({ task_code: code, content: `code: ${code}`, match_context: code, entity_time: 1 });

    const ranked = rankSearchResults([...mentions, theTask], [code]);

    expect(ranked[0]).toBe(theTask);
  });

  test('entity types rank in the documented tier order', () => {
    // INVARIANT: tasks > prompts > turns > commits > comments > raised >
    // conversations > memories > scratch. The order lives in ONE place
    // (TYPE_TIERS in src/search/ranking.ts); this test pins it end to end so
    // editing the map without meaning to shows up here. Equal strength and
    // recency, so tier alone decides.
    const types = ['scratch', 'memory', 'conversation', 'raised', 'comment', 'commit', 'turn', 'prompt', 'task'] as const;
    const input = types.map((entity_type, i) =>
      row({ entity_type, content: 'needle', entity_time: 1000 - i })
    );

    const ranked = rankSearchResults(input, ['needle']);

    expect(ranked.map(r => r.entity_type)).toEqual([...types].reverse());
  });

  test('within a tier, exact beats prefix beats substring', () => {
    // INVARIANT: within one type tier the stronger match wins — exact, then
    // prefix, then substring. A prefix hit outranks a row that contains the
    // term mid-text even when the substring row is newer: strength is the
    // engineer's rule, recency only breaks ties within the same strength.
    const input = [
      row({ content: 'plain needle in the middle' }),          // substring
      row({ content: 'needlepoint embroidery', entity_time: 9_999_999 }), // prefix, newer
      row({ content: 'needle' }),                               // exact
    ];

    const ranked = rankSearchResults(input, ['needle']);

    expect(ranked.map(r => r.content)).toEqual(['needle', 'needlepoint embroidery', 'plain needle in the middle']);
  });

  test('the task code field counts toward strength, not just content', () => {
    // The code row is how a code match presents itself; its task_code is the
    // identity text. A PREFIX code match (spike-vm-isolation for "spike")
    // outranks another task whose goal contains "spike" mid-text.
    const input = [
      taskRow({ task_code: 'do-spike-thing', content: 'goal with spike inside' }),
      taskRow({ task_code: 'spike-vm-isolation', content: 'code: spike-vm-isolation' }),
    ];

    const ranked = rankSearchResults(input, ['spike']);

    expect(ranked[0].task_code).toBe('spike-vm-isolation');
  });

  test('a task with an exact goal beats a task with only a substring goal', () => {
    const exact = taskRow({ task_code: 'other', content: 'auth' });
    const partial = taskRow({ task_code: 'other2', content: 'oauth flow' });

    const ranked = rankSearchResults([partial, exact], ['auth']);

    expect(ranked[0]).toBe(exact);
  });

  test('within equal strength, newer entity_time first', () => {
    // INVARIANT: recency is the tiebreak INSIDE a strength class, never
    // across strengths — a weaker but newer match stays below a stronger
    // older one.
    const older = row({ content: 'reconciler notes', entity_time: 1000 });
    const newer = row({ content: 'reconciler notes', entity_time: 2000 });

    const ranked = rankSearchResults([older, newer], ['reconciler']);

    expect(ranked[0]).toBe(newer);
  });

  test('rows without entity_time keep their original order among equals', () => {
    // Absent timestamps must not rank as "older than everything" nor crash —
    // they fall back to the engine's original order, which is deterministic.
    const a = row({ content: 'needle one' });
    const b = row({ content: 'needle two' });
    const ranked = rankSearchResults([a, b], ['needle']);
    expect(ranked).toEqual([a, b]);
  });

  test('full ties keep the engine order (stable sort)', () => {
    const a = row({ content: 'needle', entity_time: 1000 });
    const b = row({ content: 'needle', entity_time: 1000 });
    const ranked = rankSearchResults([b, a], ['needle']);
    expect(ranked).toEqual([b, a]);
  });

  test('case-insensitive strength: uppercase code matches lowercase query exactly', () => {
    const input = [
      row({ content: 'AUTH-TASK notes' }),            // substring only
      taskRow({ task_code: 'AUTH-TASK', content: 'code: AUTH-TASK' }), // exact after lowercase
    ];

    const ranked = rankSearchResults(input, ['auth-task']);

    expect(ranked[0].entity_type).toBe('task');
    expect(ranked[0].task_code).toBe('AUTH-TASK');
  });

  test('multiple terms: the strongest single match decides', () => {
    // A structured query like `auth OR reconciler` produces rows matched by
    // either term; a row one term matches exactly ranks as an exact hit even
    // if the other term is nowhere in it.
    const input = [
      row({ content: 'the reconciler queue' }), // exact on term 2
      row({ content: 'auth flows' }),            // exact on term 1
    ];

    const ranked = rankSearchResults(input, ['auth', 'reconciler']);

    // Both exact — the engine's order decides.
    expect(ranked.map(r => r.content)).toEqual(['auth flows', 'the reconciler queue']);
  });

  test('no literal terms: tier and recency decide, engine order within', () => {
    // A pure status: query has no text to be strong against; every row is
    // equally weak, so tier and recency decide.
    const input = [
      row({ entity_type: 'turn', content: 'anything', entity_time: 5 }),
      row({ entity_type: 'task', content: 'anything', entity_time: 5 }),
      row({ entity_type: 'task', content: 'anything', entity_time: 9 }),
    ];

    const ranked = rankSearchResults(input, []);

    expect(ranked.map(r => r.entity_type)).toEqual(['task', 'task', 'turn']);
    expect(ranked[0].entity_time).toBe(9);
    expect(ranked[1].entity_time).toBe(5);
  });

  test('unknown entity types rank last instead of crashing the sort', () => {
    // INVARIANT: a future entity type the ranking has not been taught must
    // not break the sort or jump the queue — it lands after scratch, in
    // engine order.
    const future = row({ entity_type: 'future-kind' as SearchResult['entity_type'], content: 'needle' });
    const known = row({ entity_type: 'scratch', content: 'needle' });

    const ranked = rankSearchResults([future, known], ['needle']);

    expect(ranked).toEqual([known, future]);
  });
});

// ─── ranking never changes which results come back ──────────────────────────

describe('rankSearchResults preserves the result set', () => {
  test('same rows in, same rows out — reordered, not filtered or deduplicated', () => {
    // INVARIANT: ranking only reorders. The regex backend can emit TWO rows
    // for one task (its code row and its goal row) and a prompt row equal to
    // another row's content; every one of them must survive, or paging counts
    // change behind the user's back.
    const codeRow = taskRow({ content: 'code: auth', entity_id: 't1' });
    const goalRow = taskRow({ content: 'auth service', entity_id: 't1' });
    const dupContent = row({ entity_type: 'turn', content: 'auth', task_code: 't2' });
    const input = [codeRow, goalRow, dupContent];

    const ranked = rankSearchResults(input, ['auth']);

    expect(ranked).toHaveLength(3);
    expect(new Set(ranked)).toEqual(new Set(input));
  });
});

// ─── literal-term extraction for structured queries ─────────────────────────

describe('queryLiteralTerms', () => {
  test('collects text, in:, goal: and task: values', () => {
    const ast: QueryNode = parseQuery('auth in:turns reconciler goal:"fix login" task:spike has:commits');
    expect(queryLiteralTerms(ast)).toEqual(['auth', 'reconciler', 'fix login', 'spike']);
  });

  test('skips NOT branches — an exclusion is not text the user is looking for', () => {
    const ast: QueryNode = parseQuery('auth NOT reconciler');
    expect(queryLiteralTerms(ast)).toEqual(['auth']);
  });

  test('status:, tag:, has: and date: carry no literal text', () => {
    const ast: QueryNode = parseQuery('status:working tag:launch created:>2026-01-01 has:turns');
    expect(queryLiteralTerms(ast)).toEqual([]);
  });
});

// ─── the shared ISO helper ───────────────────────────────────────────────────

describe('entityTimeFromIso', () => {
  test('parses ISO strings, rejects null and garbage', () => {
    expect(entityTimeFromIso('2026-09-15T10:00:00Z')).toBe(Date.parse('2026-09-15T10:00:00Z'));
    expect(entityTimeFromIso(null)).toBeUndefined();
    expect(entityTimeFromIso('')).toBeUndefined();
    expect(entityTimeFromIso('not a date')).toBeUndefined();
  });
});

// ─── executeSearch() wiring: the rules hold at the real entry point ─────────

describe('executeSearch ranking', () => {
  // A minimal Storage stub: executeSearch reaches listTasks / getTaskComments
  // / getTaskRaisedItems / getSessionByTaskId in structured mode, and
  // storage.search() in regex mode. The regex-mode rows come straight from
  // the fake, which is exactly the seam executeSearch composes from.
  function makeStorageStub(results: SearchResult[]): any {
    return {
      listTasks: async () => [],
      getTaskComments: async () => [],
      getTaskRaisedItems: async () => [],
      getSessionByTaskId: async () => null,
      getSessionTurns: async () => [],
      getSessionCommits: async () => [],
      listConversations: async () => [],
      listMemories: async () => [],
      listScratchFiles: async () => [],
      search: async () => results,
    };
  }

  test('regex mode: exact-code task row first, then lower tiers', async () => {
    const theTask = taskRow({ content: 'code: spike-vm', entity_time: 1 });
    const mentionTurn = row({ entity_type: 'turn', task_code: 'other', content: 'spike-vm kickoff', entity_time: 999_999 });
    const mentionCommit = row({ entity_type: 'commit', task_code: 'other', content: 'spike-vm notes', entity_time: 999_998 });

    const outcome = await executeSearch(makeStorageStub([mentionTurn, mentionCommit, theTask]), {
      query: 'spike-vm',
    });

    expect(outcome.results[0]).toBe(theTask);
    // Mentioning rows follow in tier order: turns before commits, newest first.
    expect(outcome.results[1]).toBe(mentionTurn);
    expect(outcome.results[2]).toBe(mentionCommit);
  });

  test('literal terms reach the ranker: exact code beats a newer same-tier mention', async () => {
    // INVARIANT: strength is only ever a key if executeSearch's literalTerms
    // wiring actually feeds the query text to rankSearchResults. Both rows
    // here are TASKS, so the tier key cannot separate them, and the exact-code
    // row is the OLDER one, so recency cannot save it either: the ONLY thing
    // that puts it first is the exact > substring strength step. If the wiring
    // is ever gutted (e.g. literalTerms becomes []), both rows fall to
    // STRENGTH_NONE, recency flips the order, and this test fails — the
    // wiring-level tests above cannot catch that because their exact-code task
    // only competes against LOWER-TIER rows, which lose on tier alone.
    const exactCode = taskRow({ task_code: 'spike-vm', content: 'code: spike-vm', entity_time: 100 });
    const mentionTask = taskRow({ task_code: 'unrelated-code', content: 'follow-up to the spike-vm work', entity_time: 200 });

    const outcome = await executeSearch(makeStorageStub([mentionTask, exactCode]), {
      query: 'spike-vm',
    });

    expect(outcome.results[0]).toBe(exactCode);
    expect(outcome.results[1]).toBe(mentionTask);
  });

  test('offset/limit page over the RANKED list', async () => {
    // INVARIANT: rank first, page second. executeSearch returns the whole
    // ranked list and CALLERS slice it (the MCP handler does results.slice(
    // offset, offset + limit) right after this call) — so consecutive pages
    // must continue each other in rank order, not re-rank a fresh window.
    const theTask = taskRow({ content: 'code: needle', entity_time: 1 });
    const turns = [
      row({ entity_type: 'turn', content: 'needle one', entity_time: 300 }),
      row({ entity_type: 'turn', content: 'needle two', entity_time: 200 }),
      row({ entity_type: 'turn', content: 'needle three', entity_time: 100 }),
    ];
    const storage = makeStorageStub([turns[0], turns[1], turns[2], theTask]);

    const ranked = (await executeSearch(storage, { query: 'needle' })).results;
    const page1 = ranked.slice(0, 2);
    const page2 = ranked.slice(2, 4);

    expect(page1.map(r => r.content)).toEqual(['code: needle', 'needle one']);
    expect(page2.map(r => r.content)).toEqual(['needle two', 'needle three']);
  });

  test('the followup type filter resolves to raised — one entity, two spellings', async () => {
    // INVARIANT: `--followups` used to push the pre-unification type name
    // 'followup', which no producer emits, so the flag silently returned zero
    // results. The filter must honour the legacy spelling exactly the way
    // in:followups does, and return the same rows --raised returns.
    const raisedRow = row({ entity_type: 'raised', content: 'a raised question' });
    const turnRow = row({ entity_type: 'turn', content: 'a turn' });

    const outcome = await executeSearch(makeStorageStub([raisedRow, turnRow]), {
      query: 'a', types: ['followup'],
    });

    expect(outcome.results).toEqual([raisedRow]);
  });
});