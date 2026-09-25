/**
 * In-process coverage for the daemon web memory routes that e2e cannot pin:
 * the 503 when the write port is unwired, and the load-bearing fact that
 * compact POST returns a streaming Response immediately so the web-request
 * deadline cannot kill an LLM oneshot.
 */

import { describe, test, expect } from 'bun:test';
import { createWebRequestHandler } from '../../src/server/index';
import type { Storage } from '../../src/storage';
import type { MemoryActions } from '../../src/server/memory-actions';
import type { MemoryCompactRunResult } from '../../src/memory/run-compact';

/** Storage that answers memory reads with nothing and ignores the rest. */
function emptyMemoryStorage(): Storage {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'getMemoryCompact') return async () => null;
      if (prop === 'getMemory') return async () => null;
      return async () => [];
    },
  }) as unknown as Storage;
}

function compactResult(overrides: Partial<MemoryCompactRunResult> = {}): MemoryCompactRunResult {
  return {
    saved: null,
    rejected: false,
    notes: [],
    liveCount: 0,
    beforeBytes: 0,
    afterBytes: 0,
    plainBytes: 0,
    warnBytes: 4096,
    previous: null,
    message: 'No memory records to compact.',
    ...overrides,
  };
}

describe('web memory routes', () => {
  test('listing still renders when the write port is not wired', async () => {
    const handler = createWebRequestHandler(emptyMemoryStorage());
    const res = await handler(new Request('http://localhost/settings/memory'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('No memory records yet');
  });

  test('mutating routes 503 when the write port is not wired', async () => {
    const handler = createWebRequestHandler(emptyMemoryStorage());
    const res = await handler(new Request('http://localhost/memory', { method: 'POST' }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Memory actions are not available');
  });

  // INVARIANT: compact is an LLM oneshot that routinely outlasts the
  // web-request deadline (~105s, there to bound storage-proportional GETs).
  // POST /memory/compact must return a streaming Response immediately so
  // Promise.race against that deadline resolves with the stream, not a 503.
  // The model wait happens INSIDE the stream; if this handler ever awaits
  // compact before returning, a compressed deadline fires first.
  test('compact POST streams past the web-request deadline', async () => {
    const compactMs = 400;
    const deadlineMs = 200;
    const memoryActions: MemoryActions = {
      save: async () => { throw new Error('unused'); },
      remove: async () => null,
      clearCompact: async () => false,
      compact: async (_options, onProgress) => {
        onProgress?.({
          label: 'Compacting 1 memory record(s)',
          state: 'plan',
          detail: 'last compact: never · generator: mechanical, no model',
        });
        await new Promise((resolve) => setTimeout(resolve, compactMs));
        onProgress?.({ label: 'Generate compact from live records', state: 'done' });
        return compactResult({
          liveCount: 1,
          message: 'Compacted 1 memory record(s) using mechanical compaction.',
        });
      },
    };

    const handler = createWebRequestHandler(emptyMemoryStorage(), undefined, {
      deadlineMs,
      memoryActions,
    });
    const started = Date.now();
    const res = await handler(new Request('http://localhost/memory/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ mode: 'mechanical' }),
    }));
    // The Response itself must arrive before compact finishes — otherwise
    // the deadline would already have substituted a 503 timeout page.
    expect(Date.now() - started).toBeLessThan(compactMs);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const body = await res.text();
    expect(body).not.toContain('Request Timed Out');
    expect(body).toContain('id="memory-compact-progress"');
    expect(body).toContain('Compacting 1 memory record(s)');
    expect(body).toContain('id="memory-compact-result"');
    expect(body).toContain('Compacted 1 memory record(s) using mechanical');
  });
// INVARIANT: the dashboard names the PERSON behind a memory write when the
// store recorded one, and falls back to the role for rows that carry none.
test("record page names the person who wrote it, else the role", async () => {
  const record = {
    name: "team-style", description: "How we work", type: "feedback", body: "b",
    created_at: 1, updated_at: 2, created_by: "human", updated_by: "human",
    updated_by_email: "ada@example.com", updated_by_name: "Ada", revision: 2,
  };
  const events = [
    { id: "1", name: "team-style", action: "create", actor: "human", timestamp: 1, revision: 1 },
    { id: "2", name: "team-style", action: "update", actor: "human", actor_email: "ada@example.com",
      actor_name: "Ada", timestamp: 2, revision: 2 },
  ];
  const storage = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === "getMemory") return async () => record;
      if (prop === "getMemoryHistory") return async () => events;
      if (prop === "getMemoryCompact") return async () => null;
      return async () => [];
    },
  }) as unknown as Storage;
  const handler = createWebRequestHandler(storage);
  const html = await (await handler(new Request("http://localhost/memory/team-style"))).text();
  expect(html).toContain("by Ada</dd>");
  expect(html).toContain("by human</dd>");
  expect(html).toContain("rev 2 · by Ada");
  expect(html).toContain("rev 1 · by human");
});
});
