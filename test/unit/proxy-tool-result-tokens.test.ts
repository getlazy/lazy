/**
 * Sizing a tool_result, so a tool's real cost can be named.
 *
 * The unit under test is the ONE place that holds a tool result's full text —
 * everything downstream has a bounded preview — so if the size is not taken
 * here it cannot be taken at all.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  toolResultTokens,
  warmToolResultTokenizer,
  resetToolResultTokenCache,
  toolResultTokenCacheSize,
  MAX_CACHED_RESULTS,
} from '../../src/proxy/tool-result-tokens';
import { extractRequest } from '../../src/proxy/extractor';

function toolResultBody(id: string, content: string) {
  return {
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
    ],
  };
}

describe('tool_result token sizing', () => {
  beforeEach(() => {
    resetToolResultTokenCache();
  });

  // INVARIANT: an unmeasured result reports null, never 0. A 0 in the audit
  // record would flow through to the Stats tab as "this tool's output was
  // free", which is exactly the fabricated number the tab exists to avoid.
  test('reports null, never zero, before the tokenizer is loaded', () => {
    // Reached only if nothing else in this process warmed the encoder first,
    // hence the either/or: what must never happen is a fabricated 0.
    const answer = toolResultTokens('u-cold', 'some content here');
    expect(answer === null || answer > 0).toBe(true);
  });

  test('counts the result text once loaded', async () => {
    await warmToolResultTokenizer();
    const tokens = toolResultTokens('u1', 'The quick brown fox jumps over the lazy dog.');
    expect(tokens).not.toBeNull();
    expect(tokens!).toBeGreaterThan(3);
    expect(tokens!).toBeLessThan(20);
  });

  test('a bigger result counts bigger', async () => {
    await warmToolResultTokenizer();
    const small = toolResultTokens('a', 'hello world')!;
    const big = toolResultTokens('b', 'hello world '.repeat(500))!;
    expect(big).toBeGreaterThan(small * 100);
  });

  // INVARIANT: every audited request replays the entire conversation, so the
  // same tool_result crosses the proxy once per later request — on a real log,
  // 142 distinct results appeared 3,966 times. Keying the count on the
  // tool_use id is what keeps that from putting megabytes of tokenising on the
  // proxy's request path, growing with the session.
  test('a replayed result is counted once and served from the cache', async () => {
    await warmToolResultTokenizer();
    const content = 'x'.repeat(20_000);
    const first = toolResultTokens('u-replay', content)!;
    expect(toolResultTokenCacheSize()).toBe(1);

    // The replay: same id, and the cache answers without re-tokenising.
    for (let i = 0; i < 50; i++) {
      expect(toolResultTokens('u-replay', content)).toBe(first);
    }
    expect(toolResultTokenCacheSize()).toBe(1);
  });

  test('the cache is bounded and evicts oldest-first', async () => {
    await warmToolResultTokenizer();
    for (let i = 0; i < MAX_CACHED_RESULTS + 25; i++) {
      toolResultTokens(`u${i}`, `result ${i}`);
    }
    expect(toolResultTokenCacheSize()).toBe(MAX_CACHED_RESULTS);
  });

  test('an id-less result is still sized, just not remembered', async () => {
    await warmToolResultTokenizer();
    expect(toolResultTokens(null, 'hello world')).toBeGreaterThan(0);
    expect(toolResultTokenCacheSize()).toBe(0);
  });
});

describe('the extractor carries the size onto the audit record', () => {
  test('a tool_result records its token size against the tool_use it answers', async () => {
    await warmToolResultTokenizer();
    resetToolResultTokenCache();
    const r = extractRequest('/v1/messages', toolResultBody('t-42', 'a'.repeat(4000)));
    expect(r.toolResults[0].toolUseId).toBe('t-42');
    expect(r.toolResults[0].contentLen).toBe(4000);
    expect(r.toolResults[0].contentTokens).toBeGreaterThan(0);
  });

  // INVARIANT: the size is taken from the FULL result, not the preview. The
  // preview is capped at a few hundred characters; sizing that instead would
  // make every large result look identically cheap.
  test('the size measures the whole result, not the truncated preview', async () => {
    await warmToolResultTokenizer();
    resetToolResultTokenCache();
    const small = extractRequest('/v1/messages', toolResultBody('t-small', 'word '.repeat(60)));
    const large = extractRequest('/v1/messages', toolResultBody('t-large', 'word '.repeat(6000)));
    expect(small.toolResults[0].contentPreview.endsWith('…')).toBe(true);
    expect(large.toolResults[0].contentPreview.endsWith('…')).toBe(true);
    expect(large.toolResults[0].contentTokens!).toBeGreaterThan(
      small.toolResults[0].contentTokens! * 50,
    );
  });
});
