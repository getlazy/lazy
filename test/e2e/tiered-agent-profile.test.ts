/**
 * A tiered agent profile, end to end: a real daemon, a real supervisor and the
 * fake `claude` binary making two model requests in ONE turn through lazy's
 * proxy. Tier 1 is an Anthropic-credentialed stub that answers the first
 * request with a 97%-used 5-hour window; the second request of the same turn
 * must go to tier 2, with tier 2's model and without the Anthropic credential,
 * and the switch must land on the task's journal.
 *
 * INVARIANTS exercised live:
 *   - the tier is chosen per request, mid-turn, from the reading the previous
 *     response carried;
 *   - the daemon's real Anthropic credential reaches tier 1 and never tier 2;
 *   - the request served by tier 2 asks for tier 2's model;
 *   - the switch is recorded durably on the task.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { sessionStartEvent, resultEvent } from '../helpers/fake-claude';
import { readJournal } from '../helpers/storage';
import { auditLogPath } from '../../src/proxy/audit-log';

/** The credential the test daemon itself holds (test/helpers/setup.ts). */
const DAEMON_CREDENTIAL = 'sk-test-fake-key-for-testing';

interface Hit { headers: Record<string, string>; body: Record<string, unknown> }

describe('tiered agent profile through a live turn', () => {
  let ctx: TestContext;
  let tierOne: ReturnType<typeof Bun.serve>;
  let tierTwo: ReturnType<typeof Bun.serve>;
  let hits: { one: Hit[]; two: Hit[] };

  function stub(which: 'one' | 'two', usage: () => Record<string, string>) {
    return Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });
        const text = await req.text();
        hits[which].push({ headers, body: text ? JSON.parse(text) : {} });
        return Response.json({ type: 'message', model: 'stub', content: [] }, { headers: usage() });
      },
    });
  }

  beforeEach(async () => {
    hits = { one: [], two: [] };
    tierOne = stub('one', () => ({
      'anthropic-ratelimit-unified-5h-utilization': '0.97',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
    }));
    tierTwo = stub('two', () => ({}));
    ctx = await setupTestLazy({ fakeClaude: true });
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    await writeFile(configPath, [
      before,
      '[endpoints.sub]',
      `url = "http://127.0.0.1:${tierOne.port}"`,
      'credential = "anthropic"',
      '[endpoints.cheap]',
      `url = "http://127.0.0.1:${tierTwo.port}"`,
      'credential = "none"',
      '[agents.chain]',
      'harness = "claude-code"',
      'tiers = [',
      '  { endpoint = "sub", model = "claude-sonnet-5-5", threshold_percent = 95 },',
      '  { endpoint = "cheap", model = "qwen3-coder" },',
      ']',
      '',
    ].join('\n'));
    await ctx.restartDaemon({ CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '' });
  });

  afterEach(async () => {
    tierOne.stop(true);
    tierTwo.stop(true);
    await ctx.cleanup();
  });

  test('a full window moves the next request of the same turn to the next tier', async () => {
    const taskId = await createTask(ctx, 'Tiered profile', 'Make two requests', { agent: 'chain' });
    const sessionId = 'tiered-1';
    await ctx.setClaudeScenario({
      steps: [
        { kind: 'emit', event: sessionStartEvent(sessionId) },
        { kind: 'http', path: '/v1/messages', expectStatus: 200 },
        { kind: 'http', path: '/v1/messages', expectStatus: 200 },
        { kind: 'emit', event: resultEvent({ result: 'Made two requests.', sessionId }) },
      ],
    });

    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));

    // Model requests only: the daemon's own reachability probes of the
    // profile's endpoint carry no body.
    const modelHits = (hs: Hit[]) => hs.filter((h) => typeof h.body.model === 'string');
    expect(modelHits(hits.one)).toHaveLength(1);
    expect(modelHits(hits.two).length).toBeGreaterThanOrEqual(1);
    const credentialOf = (h: Hit) => `${h.headers.authorization ?? ''} ${h.headers['x-api-key'] ?? ''}`;
    expect(credentialOf(modelHits(hits.one)[0]!)).toContain(DAEMON_CREDENTIAL);
    for (const h of hits.two) {
      expect(credentialOf(h)).not.toContain(DAEMON_CREDENTIAL);
      expect(credentialOf(h).trim()).toBe('');
    }
    for (const h of modelHits(hits.two)) expect(h.body.model).toBe('qwen3-coder');

    let journal = readJournal(ctx.root, taskId);
    for (let i = 0; i < 40 && !journal.some((e) => e.content.includes('Tier switch')); i++) {
      await Bun.sleep(100);
      journal = readJournal(ctx.root, taskId);
    }
    const entry = journal.find((e) => e.content.includes('Tier switch'));
    expect(entry?.content).toContain('endpoint `cheap`, model `qwen3-coder`');
    expect(entry?.content).toContain('5-hour window 97% used');

    // INVARIANT: the tier switch happens INSIDE the proxy, so both tiers'
    // requests are in the audit trail, attributed to the task and naming the
    // endpoint and tier that served them — a tier is never a way around it.
    const logPath = auditLogPath(join(ctx.root, '.lazy'));
    let served: any[] = [];
    for (let i = 0; i < 50; i++) {
      const raw = await readFile(logPath, 'utf-8').catch(() => '');
      served = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
        .filter((r) => r.servedByEndpoint === 'sub' || r.servedByEndpoint === 'cheap');
      if (served.some((r) => r.servedByEndpoint === 'sub') && served.some((r) => r.servedByEndpoint === 'cheap')) break;
      await Bun.sleep(100);
    }
    const sub = served.find((r) => r.servedByEndpoint === 'sub');
    const cheap = served.find((r) => r.servedByEndpoint === 'cheap');
    expect(sub, 'tier 1 request has no audit record').toBeTruthy();
    expect(cheap, 'tier 2 request has no audit record').toBeTruthy();
    expect(sub.tierIndex).toBe(0);
    expect(cheap.tierIndex).toBe(1);
    for (const r of [sub, cheap]) {
      expect(r.role).toBe('agent');
      expect(taskId.startsWith(String(r.taskId)) || String(r.taskId).startsWith(taskId)).toBe(true);
    }
  }, 120_000);
});
