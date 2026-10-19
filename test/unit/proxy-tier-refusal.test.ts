/**
 * Tiered agent profiles switch on what the provider SAYS: a tier is used until
 * it refuses for capacity (a 429), the refused request is retried on the next
 * tier so the turn continues, and a refused tier is tried again at its
 * retry-after / reported reset or after `[proxy] tier_retry_interval`
 * (engineer, 2026-10-06). Through the REAL proxy, against fake upstreams that
 * answer 429 on demand.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { TargetCredentials, anthropicPlacement, bearerPlacement } from '../../src/proxy/target-credentials';
import { UsageLimitTracker } from '../../src/proxy/usage-limits';
import { TierRefusals, chooseTier, refusalFor, type TierSwitchEvent } from '../../src/proxy/tier-select';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';
import type { AgentUpstreamRoute, TierRoute } from '../../src/proxy/agent-upstreams';

const PLACEHOLDER = 'sk-ant-api03-lazy-tier-refusal-placeholder';
type Name = 'anthropic' | 'fireworks' | 'lunaroute';

describe('tiered profile: a tier is used until it refuses', () => {
  const servers: Array<ReturnType<typeof Bun.serve>> = [];
  let proxyPort: number;
  const urls = {} as Record<Name, string>;
  let hits: Record<Name, number>;
  /** Every credential header value each upstream received. */
  let creds: Record<Name, string[]>;
  /** When set, that upstream answers 429 with these headers. */
  let refusing: Partial<Record<Name, Record<string, string>>>;
  let usage: Record<string, string>;
  let routes: Record<string, AgentUpstreamRoute>;
  let records: ProxyAuditRecord[];
  let switches: TierSwitchEvent[];
  const tracker = new UsageLimitTracker();
  const refusals = new TierRefusals();
  const RETRY_INTERVAL_S = 2;
  /** [proxy] retry_after_threshold for this proxy: retry-after at or under it is waited out. */
  const SHORT_WAIT_S = 0.5;
  /** Upstreams that refuse only their NEXT request, then serve. */
  let refuseOnce: Partial<Record<Name, boolean>>;
  let prepareError: boolean;

  const grant: CredentialGrant = {
    token: PLACEHOLDER, role: 'agent', taskId: 'task-refusal', label: 'lazy-task-refusal',
    envKey: 'ANTHROPIC_API_KEY', profile: 'chain', createdAt: new Date().toISOString(),
  };

  function tiers(thresholds: { anthropic?: number } = {}): TierRoute[] {
    return [
      { index: 0, endpoint: 'anthropic-sub', upstream: urls.anthropic, model: 'claude-opus-5-5', usage: 'claude', threshold: thresholds.anthropic ?? null },
      { index: 1, endpoint: 'fireworks', upstream: urls.fireworks, model: 'firerouter/opus', usage: null, threshold: null },
      { index: 2, endpoint: 'lunaroute', upstream: urls.lunaroute, model: 'glm-5.3', usage: null, threshold: null },
    ];
  }

  beforeAll(async () => {
    for (const name of ['anthropic', 'fireworks', 'lunaroute'] as const) {
      // Port 0: the OS assigns, so suites running side by side never collide.
      const server = Bun.serve({
        port: 0, hostname: '127.0.0.1',
        async fetch(req) {
          await req.text();
          hits[name] += 1;
          creds[name].push(`${req.headers.get('authorization') ?? ''} ${req.headers.get('x-api-key') ?? ''}`);
          if (refuseOnce[name]) {
            refuseOnce[name] = false;
            return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'burst' } },
              { status: 429, headers: { 'retry-after': '0.2' } });
          }
          const refuse = refusing[name];
          if (refuse) {
            return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: `${name} says no` } },
              { status: 429, headers: refuse });
          }
          return Response.json({ type: 'message', from: name }, { headers: name === 'anthropic' ? usage : {} });
        },
      });
      servers.push(server);
      urls[name] = `http://127.0.0.1:${server.port}`;
    }
    const targets = new TargetCredentials();
    targets.set(urls.anthropic, async () => ({ kind: 'credential', placement: anthropicPlacement('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-REAL'), label: 'CLAUDE_CODE_OAUTH_TOKEN' }));
    targets.set(urls.fireworks, async () => ({ kind: 'credential', placement: bearerPlacement('fw_REAL'), label: 'FIREWORKS_API_KEY' }));
    targets.set(urls.lunaroute, async () => ({ kind: 'credential', placement: bearerPlacement('lr_REAL'), label: 'LUNAROUTE_API_KEY' }));
    const credentials: ProxyCredentialDeps = {
      lookup: async (token) => (token === PLACEHOLDER ? grant : null),
      targets,
      member: async () => null,
    };
    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    const proxy = createProxyServer(
      {
        port: 0, bind: '127.0.0.1', upstream: urls.anthropic, fallbacks: [], retryAfterThreshold: SHORT_WAIT_S,
        tierRetryIntervalSeconds: RETRY_INTERVAL_S,
        liveAgentRouting: async () => ({ routes, targets, profiles: new Set(['chain']) }),
      },
      sink,
      credentials,
      { usageLimits: tracker, tierRefusals: refusals, onTierSwitch: (e) => switches.push(e),
        prepareTierChoice: async () => { if (prepareError) throw new Error('temporary usage read failure'); } },
    );
    servers.push(proxy);
    proxyPort = proxy.port!;
    await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(() => { for (const s of servers) s.stop(); });

  let n = 0;
  beforeEach(() => {
    n += 1;
    prepareError = false;
    grant.taskId = `task-refusal-${n}`;
    hits = { anthropic: 0, fireworks: 0, lunaroute: 0 };
    creds = { anthropic: [], fireworks: [], lunaroute: [] };
    refusing = {};
    refuseOnce = {};
    usage = {};
    records = [];
    switches = [];
    tracker.resetForTest();
    refusals.resetForTest();
    routes = { chain: { upstream: urls.anthropic, wire: 'anthropic', tiers: tiers() } };
  });

  async function send() {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PLACEHOLDER}` },
      body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const json = await res.json().catch(() => null) as Record<string, unknown> | null;
    await new Promise((r) => setTimeout(r, 30));
    return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
  }

  // INVARIANT: a failed usage refresh does not fail a model request or forget
  // known readings; endpoint credential authorization is still independent.
  test('a transient reading failure keeps known usage and unknown tiers available', async () => {
    prepareError = true;
    routes.chain!.tiers = tiers({ anthropic: 90 });
    expect((await send()).json).toMatchObject({ from: 'anthropic' });
    usage = { 'anthropic-ratelimit-unified-5h-utilization': '0.97',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600) };
    expect((await send()).json).toMatchObject({ from: 'anthropic' });
    expect((await send()).json).toMatchObject({ from: 'fireworks' });
  });

  // INVARIANT: a capacity refusal (429) from a tier hands THE SAME request to
  // the next tier, so the turn continues — the harness never sees the 429 —
  // and the tier stays skipped afterwards. No threshold is needed for it.
  test('a 429 falls through and the same request is served by the next tier', async () => {
    refusing.anthropic = {};
    const r = await send();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ from: 'fireworks' });
    expect(hits).toEqual({ anthropic: 1, fireworks: 1, lunaroute: 0 });
    // The refused attempt is in the audit trail, named as such.
    const refused = records.find((x) => x.status === 429);
    expect(refused?.error).toMatch(/^tier refused: tier 1 \(anthropic-sub, claude-opus-5-5\) refused 429 at/);
    expect(refused?.tierIndex).toBe(0);
    // The switch is recorded with the refusal as its reason.
    expect(switches.at(-1)).toMatchObject({ to: { index: 1 } });
    expect(switches.at(-1)!.reason).toMatch(/skipped tier 1 \(anthropic-sub\): refused 429 at \d\d:\d\d:\d\d, retry after/);
    // Next request goes straight to tier 2 — the refused tier is skipped.
    expect((await send()).json).toMatchObject({ from: 'fireworks' });
    expect(hits.anthropic).toBe(1);
  });

  // INVARIANT: retry-after is honoured: the refused tier is skipped until then
  // and tried again by the next real request after it (no probe request).
  test('retry-after is honoured, then the tier comes back', async () => {
    refusing.anthropic = { 'retry-after': '1' };
    expect((await send()).json).toMatchObject({ from: 'fireworks' });
    refusing.anthropic = undefined;
    expect((await send()).json).toMatchObject({ from: 'fireworks' });
    expect(hits.anthropic).toBe(1);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await send()).json).toMatchObject({ from: 'anthropic' });
    const back = switches.at(-1)!;
    expect(back).toMatchObject({ from: { index: 1 }, to: { index: 0 } });
    expect(back.reason).toMatch(/refused 429 at .*its retry-after.*trying it again/);
  }, 10_000);

  // INVARIANT: with no retry time, a refused tier is tried again after
  // [proxy] tier_retry_interval.
  test('the interval retry brings a tier with no retry time back', async () => {
    refusing.fireworks = {};
    routes = { chain: { upstream: urls.fireworks, wire: 'anthropic', tiers: tiers().slice(1) } };
    expect((await send()).json).toMatchObject({ from: 'lunaroute' });
    refusing.fireworks = undefined;
    expect((await send()).json).toMatchObject({ from: 'lunaroute' });
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_S * 1000 + 100));
    expect((await send()).json).toMatchObject({ from: 'fireworks' });
  }, 10_000);

  // INVARIANT: a tier that still refuses on its come-back falls through at
  // once, on that same request.
  test('a still-refusing tier falls through at once on its retry', async () => {
    refusing.anthropic = { 'retry-after': '1' };
    await send();
    await new Promise((r) => setTimeout(r, 1100));
    const r = await send();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ from: 'fireworks' });
    expect(hits.anthropic).toBe(2);
  }, 10_000);

  // INVARIANT: every tier refusing → the proxy answers 429 itself with the
  // earliest known retry time, and the turn's last request never reaches past
  // the chain.
  test('all tiers refusing returns 429 with the earliest retry time', async () => {
    // Two unwindowed tiers: each is back at its own retry-after.
    routes = { chain: { upstream: urls.fireworks, wire: 'anthropic', tiers: tiers().slice(1) } };
    refusing.fireworks = { 'retry-after': '900' };
    refusing.lunaroute = { 'retry-after': '120' };
    const r = await send();
    expect(r.status).toBe(429);
    expect(Number(r.retryAfter)).toBeGreaterThan(110);
    expect(Number(r.retryAfter)).toBeLessThanOrEqual(120);
    expect(hits).toEqual({ anthropic: 0, fireworks: 1, lunaroute: 1 });
    expect(JSON.stringify(r.json)).toContain('every tier');
    // Nothing is forwarded while every tier is refused.
    expect((await send()).status).toBe(429);
    expect(hits).toEqual({ anthropic: 0, fireworks: 1, lunaroute: 1 });
  });

  // INVARIANT: a WINDOWED tier (Anthropic) is tried again no later than the
  // retry interval even when it reported a later reset — the window may be
  // reset or the plan upgraded early.
  test('a windowed tier is retried at the interval before its reported reset', async () => {
    refusing.anthropic = { 'retry-after': '18000' };
    refusing.fireworks = { 'retry-after': '900' };
    refusing.lunaroute = { 'retry-after': '900' };
    const r = await send();
    expect(r.status).toBe(429);
    expect(Number(r.retryAfter)).toBeLessThanOrEqual(RETRY_INTERVAL_S);
  });

  // INVARIANT: the request re-sent after a refusal carries ONLY the next
  // tier's credential — never the refusing tier's secret, never the placeholder.
  test('a re-dispatched request carries only the serving tier credential', async () => {
    refusing.anthropic = {};
    await send();
    expect(creds.anthropic.join('\n')).toContain('sk-ant-oat01-REAL');
    expect(creds.anthropic.join('\n')).not.toContain('fw_REAL');
    const fw = creds.fireworks.join('\n');
    expect(fw).toContain('fw_REAL');
    expect(fw).not.toContain('sk-ant-oat01-REAL');
    expect(fw).not.toContain(PLACEHOLDER);
  });

  // INVARIANT: a refused tier records no switch onto itself: a still-refusing
  // come-back writes nothing, only a come-back it SERVES is a switch.
  test('a still-refusing come-back records no switch', async () => {
    refusing.anthropic = { 'retry-after': '1' };
    await send();
    expect(switches).toHaveLength(1); // first request served by tier 2
    await new Promise((r) => setTimeout(r, 1100));
    await send(); // tier 1 refuses again, tier 2 serves: still on tier 2
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({ to: { index: 1 }, crossed: false });
  }, 10_000);

  // INVARIANT: a windowed tier WITH a threshold still comes back at the
  // interval: the rejected reading its own 429 carried does not hold it until
  // the reported reset.
  test('a refused tier with a threshold comes back at the interval', async () => {
    routes = { chain: { upstream: urls.anthropic, wire: 'anthropic', tiers: tiers({ anthropic: 90 }) } };
    refusing.anthropic = {
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-utilization': '1.0',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 5 * 3600),
    };
    expect((await send()).json).toMatchObject({ from: 'fireworks' });
    refusing.anthropic = undefined;
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_S * 1000 + 100));
    expect((await send()).json).toMatchObject({ from: 'anthropic' });
  }, 10_000);

  // INVARIANT: a short burst limit (retry-after at or under
  // [proxy] retry_after_threshold) is waited out on the SAME tier, retried
  // once, and never switches — a switch costs the prompt cache twice.
  test('a short retry-after is waited out on the same tier', async () => {
    refuseOnce.anthropic = true;
    const r = await send();
    expect(r.json).toMatchObject({ from: 'anthropic' });
    expect(hits).toEqual({ anthropic: 2, fireworks: 0, lunaroute: 0 });
    expect(switches).toHaveLength(0);
    expect((await send()).json).toMatchObject({ from: 'anthropic' });
  });

  // INVARIANT: if the same tier refuses again after the short wait, the
  // request switches tiers then.
  test('a short retry-after that refuses again switches', async () => {
    refusing.anthropic = { 'retry-after': '0.2' };
    const r = await send();
    expect(r.json).toMatchObject({ from: 'fireworks' });
    expect(hits.anthropic).toBe(2);
  });

  // INVARIANT: a longer retry-after, or none at all, switches at once.
  test('a long or missing retry-after switches without waiting', async () => {
    refusing.anthropic = { 'retry-after': '30' };
    expect((await send()).json).toMatchObject({ from: 'fireworks' });
    expect(hits.anthropic).toBe(1);
    refusals.resetForTest();
    hits.anthropic = 0;
    refusing.anthropic = {};
    expect((await send()).json).toMatchObject({ from: 'fireworks' });
    expect(hits.anthropic).toBe(1);
  });

  // INVARIANT: threshold_percent still switches EARLY, before any refusal.
  test('an optional threshold still switches early', async () => {
    routes = { chain: { upstream: urls.anthropic, wire: 'anthropic', tiers: tiers({ anthropic: 90 }) } };
    usage = {
      'anthropic-ratelimit-unified-5h-utilization': '0.93',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
    };
    expect((await send()).json).toMatchObject({ from: 'anthropic' });
    expect((await send()).json).toMatchObject({ from: 'fireworks' });
    expect(records.some((x) => x.status === 429)).toBe(false);
  });
});

describe('refusalFor: when a refused tier is tried again', () => {
  const now = Date.parse('2026-10-06T01:07:39Z');
  const windowed = { usage: 'claude' as const };
  const plain = { usage: null };

  test('retry-after wins on an unwindowed tier', () => {
    expect(refusalFor(plain, 429, { 'retry-after': '3600' }, 300, now).retryAt).toBe(now + 3600_000);
  });

  test('no retry time → the interval', () => {
    const r = refusalFor(plain, 429, null, 300, now);
    expect(r.retryAt).toBe(now + 300_000);
    expect(r.basis).toBe('the tier retry interval');
  });

  test('a windowed tier with a later reported reset is tried again at the interval', () => {
    const reset = Math.floor(now / 1000) + 5 * 3600;
    const r = refusalFor(windowed, 429, {
      'anthropic-ratelimit-unified-5h-utilization': '1.0',
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': String(reset),
    }, 300, now);
    expect(r.retryAt).toBe(now + 300_000);
    expect(r.basis).toContain('ahead of its reported reset');
  });

  test('a windowed tier with a sooner reported reset is tried again at the reset', () => {
    const reset = Math.floor(now / 1000) + 60;
    const r = refusalFor(windowed, 429, {
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-utilization': '1.0',
      'anthropic-ratelimit-unified-5h-reset': String(reset),
    }, 300, now);
    expect(r.retryAt).toBe(reset * 1000);
  });

  test('never sooner than a second', () => {
    expect(refusalFor(plain, 429, { 'retry-after': '0' }, 300, now).retryAt).toBe(now + 1000);
  });

  test('chooseTier skips a refused tier and names the refusal', async () => {
    const t: TierRoute[] = [
      { index: 0, endpoint: 'a', upstream: 'http://a', model: 'm', usage: null, threshold: null },
      { index: 1, endpoint: 'b', upstream: 'http://b', model: 'n', usage: null, threshold: null },
    ];
    const refusals = new TierRefusals();
    refusals.refuse('p', t[0]!, null, refusalFor(plain, 429, null, 300, now));
    const lookups = { keyFor: async () => null, readingFor: () => null, refusalFor: refusals.lookupFor('p') };
    const choice = await chooseTier(t, lookups, now + 1000);
    expect(choice.tier.index).toBe(1);
    expect(choice.reason).toContain('skipped tier 1 (a): refused 429 at 01:07:39, retry after 01:12:39');
    expect((await chooseTier(t, lookups, now + 301_000)).tier.index).toBe(0);
  });
});
