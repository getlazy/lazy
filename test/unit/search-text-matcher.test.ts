/**
 * Unit tests for bounded store-search matching — the plain-text (regex) path
 * behind `lazy search`, `lazy_search`, and the dashboard's `/search`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  BoundedTextMatcher,
  SEARCH_MATCH_BATCH_ITEMS,
  SEARCH_REGEX_DEADLINE_MS,
} from '../../src/search/text-matcher';
import { FileStorage } from '../../src/storage/file-storage';

/** The ReDoS shape: stacked `a*` against a long run of `a` then a non-`a`. */
const EVIL_PATTERN = 'a*a*a*a*a*a*a*$';
const EVIL_HAYSTACK = 'a'.repeat(80) + '!';

describe('BoundedTextMatcher', () => {
  test('matches like a case-insensitive regex and keeps add() order', async () => {
    const matcher = new BoundedTextMatcher<string>('rel(ease|ic)');
    await matcher.add('first: a RELEASE hub', () => 'first');
    await matcher.add('second: nothing here', () => 'second');
    await matcher.add('third: a relic of the old design', () => 'third');

    expect(await matcher.finish()).toEqual(['first', 'third']);
  });

  test('hands the builder a context snippet around the match', async () => {
    const matcher = new BoundedTextMatcher<string>('needle');
    await matcher.add(`${'x'.repeat(500)} needle ${'y'.repeat(500)}`, context => context);

    const [context] = await matcher.finish();
    expect(context).toContain('needle');
    expect(context.startsWith('...')).toBe(true);
    expect(context.endsWith('...')).toBe(true);
    expect(context.length).toBeLessThan(200);
  });

  test('falls back to a literal search when the pattern is not a valid regex', async () => {
    const matcher = new BoundedTextMatcher<string>('(unclosed');
    await matcher.add('a note containing (unclosed verbatim', context => context);
    await matcher.add('a note that does not', () => 'no');

    const results = await matcher.finish();
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('(unclosed');
  });

  test('tolerates a haystack that is not a string', async () => {
    const matcher = new BoundedTextMatcher<string>('undefined');
    await matcher.add(undefined, () => 'matched-undefined');
    await matcher.add(null, () => 'matched-null');

    // Without the guard, testing `undefined` matches the literal "undefined".
    expect(await matcher.finish()).toEqual([]);
  });

  test('keeps order across a batch boundary', async () => {
    const matcher = new BoundedTextMatcher<number>('hit');
    const expected: number[] = [];
    for (let i = 0; i < SEARCH_MATCH_BATCH_ITEMS * 2 + 7; i++) {
      const isHit = i % 3 === 0;
      if (isHit) expected.push(i);
      await matcher.add(isHit ? `row ${i} hit` : `row ${i} miss`, () => i);
    }

    expect(await matcher.finish()).toEqual(expected);
  });

  // INVARIANT: a user-supplied search regex must never run unbounded on the
  // caller's thread. The daemon serves RPC, MCP, and the dashboard on one event
  // loop, so a backtracking pattern compiled there is a whole-daemon outage.
  // Matching runs in a Worker and terminate() is the deadline — nothing else
  // can stop a JS regex that is already backtracking.
  test('refuses a catastrophically-backtracking pattern instead of hanging', async () => {
    const matcher = new BoundedTextMatcher<string>(EVIL_PATTERN);

    const started = performance.now();
    await expect(
      (async () => {
        await matcher.add(EVIL_HAYSTACK, () => 'hit');
        await matcher.finish();
      })(),
    ).rejects.toThrow(/Invalid search pattern[\s\S]*took too long/);
    // The Worker deadline is the bound; a small margin covers terminate/IPC.
    expect(performance.now() - started).toBeLessThan(SEARCH_REGEX_DEADLINE_MS + 500);
  }, 5000);

  // INVARIANT: the event loop stays free while the pattern is evaluated. That
  // is the whole point of the Worker — a synchronous match would starve every
  // other daemon caller for the duration, deadline or not.
  test('leaves the caller event loop responsive while matching', async () => {
    const matcher = new BoundedTextMatcher<string>(EVIL_PATTERN);
    let ticks = 0;
    const ticker = setInterval(() => { ticks++; }, 50);

    try {
      await expect(
        (async () => {
          await matcher.add(EVIL_HAYSTACK, () => 'hit');
          await matcher.finish();
        })(),
      ).rejects.toThrow(/took too long/);
    } finally {
      clearInterval(ticker);
    }

    expect(ticks).toBeGreaterThan(5);
  }, 5000);
});

describe('FileStorage.search', () => {
  let root: string;
  let base: string;
  let storage: FileStorage;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lazy-search-bound-'));
    base = join(root, 'store');
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${base}"\n`,
    );
    storage = new FileStorage(root, { basePath: base });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('finds goals, prompts, and comments with a regex query', async () => {
    const task = await storage.createTask('Bound the search regex');
    await storage.updateTaskPrompt(task.id, 'The daemon must not wedge on a pattern');
    await storage.createComment(task.id, 'a comment about wedging');

    const results = await storage.search('wedg(e|ing)');
    const types = results.map(r => r.entity_type).sort();
    expect(types).toEqual(['comment', 'prompt']);
    expect(results.every(r => r.match_context.length > 0)).toBe(true);
  });

  test('still falls back to a literal search for an invalid pattern', async () => {
    await storage.createTask('A goal with (unclosed parens');

    const results = await storage.search('(unclosed');
    expect(results).toHaveLength(1);
    expect(results[0].entity_type).toBe('task');
  });

  // INVARIANT: the refusal must reach the caller. The tasks and conversations
  // loops both sit near tolerant catches for a missing directory or a
  // malformed file; a deadline error swallowed there would turn a refused
  // pattern into a silent empty result set that keeps burning worker time.
  test('refuses a catastrophically-backtracking pattern', async () => {
    await storage.createTask(EVIL_HAYSTACK);

    const started = performance.now();
    await expect(storage.search(EVIL_PATTERN)).rejects.toThrow(
      /Invalid search pattern[\s\S]*took too long/,
    );
    expect(performance.now() - started).toBeLessThan(SEARCH_REGEX_DEADLINE_MS + 1500);
  }, 10000);
});
