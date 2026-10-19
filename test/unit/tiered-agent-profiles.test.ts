/**
 * Named endpoints and tiered agent profiles: config validation, the proxy
 * route/credential tables they produce, the task-model carve-out, the launch
 * gates, and the doctor-only unreachable-tier report. The per-request switching
 * itself is exercised through a real proxy in proxy-tiered-profiles.test.ts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveAgentProfiles,
  type AgentProfileConfig,
  type NamedEndpointConfig,
} from '../../src/config/agent-profiles';
import { agentUpstreamMap, resolveAgentUpstreams } from '../../src/proxy/agent-upstreams';
import { buildProxyCredentialDeps, buildTargetCredentials } from '../../src/proxy/credential-deps';
import { resolveTurnLaunchIdentity, resolveOneOffTurnIdentity } from '../../src/daemon/launch-identity';
import { assertNoModelOnTiered } from '../../src/agent/tiered-model';
import { stripThinkingHistory } from '../../src/proxy/tier-history';
import { chooseTier, earliestReset, allFullRetryAfterSeconds, allTiersFullMessage, ALL_FULL_UNKNOWN_RESET_RETRY_SECONDS } from '../../src/proxy/tier-select';
import { ClaudeCodeAgent } from '../../src/agent/claude-code';
import { tierSwitchJournalText } from '../../src/daemon/tier-switch-record';
import { loadConfig } from '../../src/config/loader';
import { enableLastKnownGood, resetLastKnownGood } from '../../src/config/last-good';
import { createLiveProxyRouting } from '../../src/daemon/live-proxy-routing';
import type { ResolvedConfig } from '../../src/config/types';
import type { Task } from '../../src/types';
import type { Storage } from '../../src/storage/interface';

const ENDPOINTS: Record<string, NamedEndpointConfig> = {
  'anthropic-sub': { url: 'https://api.anthropic.com', credential: 'anthropic' },
  fireworks: { url: 'https://api.fireworks.ai/inference', credential: 'fireworks' },
  'ollama-local': { url: 'http://localhost:11434', credential: 'none' },
};

const CHAIN: AgentProfileConfig = {
  harness: 'claude-code',
  tiers: [
    { endpoint: 'anthropic-sub', model: 'claude-sonnet-5-5', threshold_percent: 95 },
    { endpoint: 'fireworks', model: 'firerouter/opus' },
    { endpoint: 'ollama-local', model: 'qwen3-coder' },
  ],
};

const silent = () => {};
const resolve = (agents: Record<string, AgentProfileConfig>, endpoints = ENDPOINTS) =>
  resolveAgentProfiles(agents, silent, endpoints);

function configWith(agents: Record<string, AgentProfileConfig>, endpoints = ENDPOINTS): ResolvedConfig {
  return {
    agents,
    endpoints,
    models: { roles: {} },
    usage_pause: { threshold_percent: 0, credentials: {} },
    agent: { effort: 'medium' },
    proxy: { upstream: 'https://api.anthropic.com', cursorUpstream: 'https://api2.cursor.sh', fallbacks: [] },
  } as never;
}

describe('named endpoints', () => {
  test('any profile can run against a named endpoint, with its URL and credential', () => {
    const p = resolve(
      { fw: { harness: 'claude-code', model: 'firerouter/opus', named_endpoint: 'work-fw' } },
      { 'work-fw': { url: 'https://api.fireworks.ai/inference', credential: 'work-fireworks' } },
    ).get('fw')!;
    expect(p).toMatchObject({ endpoint: 'https://api.fireworks.ai/inference', credential: 'work-fireworks', endpointPinned: true });
  });

  // INVARIANT: every endpoint names its credential; lazy never guesses which
  // secret a host receives. Inferring one from the URL could hand a provider's
  // key (e.g. an Anthropic subscription token) to a third-party gateway, so an
  // [endpoints.<name>] block without `credential` is refused at load, naming
  // the block and the fix.
  test('a named endpoint with no credential is refused, naming the block and the fix', () => {
    let message = '';
    try {
      resolve(
        { fw: { harness: 'claude-code', model: 'm', named_endpoint: 'sub' } },
        { sub: { url: 'https://api.anthropic.com' } },
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('has no credential');
    expect(message).toContain('[endpoints.sub]');
    expect(message).toContain('credential = "none"');
  });

  test('endpoint and named_endpoint together are refused', () => {
    expect(() => resolve({ x: { harness: 'claude-code', model: 'm', endpoint: 'http://a', credential: 'anthropic', named_endpoint: 'fireworks' } }))
      .toThrow(/both endpoint and named_endpoint/);
  });

  test('an unknown endpoint name is refused, naming the defined ones', () => {
    expect(() => resolve({ x: { harness: 'claude-code', model: 'm', named_endpoint: 'nope' } }))
      .toThrow(/no \[endpoints\.nope\] block\. Defined endpoints: anthropic-sub, fireworks, ollama-local/);
  });

  test('an endpoint without a url, or with an unknown key, is refused', () => {
    expect(() => resolve({}, { bad: {} })).toThrow(/\[endpoints\.bad\] has no url/);
    expect(() => resolve({}, { bad: { url: 'http://a', api_key: 'x' } as never })).toThrow(/Unknown option "api_key"/);
    expect(() => resolve({}, { bad: { url: 'not a url' } })).toThrow(/Invalid endpoint/);
  });

  // INVARIANT: an existing profile with an inline endpoint resolves exactly as
  // before named endpoints existed. The feature is additive.
  test('inline endpoint profiles are unchanged', () => {
    const p = resolve({ local: { harness: 'pi', model: 'qwen', endpoint: 'http://localhost:11434', credential: 'none' } }).get('local')!;
    expect(p).toMatchObject({ endpoint: 'http://localhost:11434', credential: 'none', endpointPinned: true });
    expect(p.tiers).toBeUndefined();
  });
});

describe('tiered profile validation', () => {
  test('a chain resolves: tier 0 is what the harness launches against', () => {
    const p = resolve({ chain: CHAIN }).get('chain')!;
    expect(p).toMatchObject({ harness: 'claude-code', model: 'claude-sonnet-5-5', endpoint: 'https://api.anthropic.com', credential: 'anthropic' });
    expect(p.tiers!.map((t) => [t.endpoint, t.usage, t.threshold, t.credential])).toEqual([
      ['anthropic-sub', 'claude', 95, 'anthropic'],
      ['fireworks', null, null, 'fireworks'],
      ['ollama-local', null, null, 'none'],
    ]);
  });

  const bad: Array<[string, AgentProfileConfig, RegExp]> = [
    ['a missing endpoint', { harness: 'claude-code', tiers: [{ endpoint: 'nope', model: 'm' }, { endpoint: 'fireworks', model: 'm' }] }, /no \[endpoints\.nope\] block/],
    ['a threshold on an unconditional endpoint', { harness: 'claude-code', tiers: [{ endpoint: 'fireworks', model: 'm', threshold_percent: 90 }, { endpoint: 'ollama-local', model: 'm' }] }, /reports no usage window/],
    ['zero tiers', { harness: 'claude-code', tiers: [] }, /at least one tier/],
    ['a non-array tiers', { harness: 'claude-code', tiers: 'x' as never }, /at least one tier/],
    ['a tier with no model', { harness: 'claude-code', tiers: [{ endpoint: 'fireworks' }, { endpoint: 'ollama-local', model: 'm' }] }, /has no model/],
    ['a model on the tiered profile itself', { ...CHAIN, model: 'x' }, /"model" cannot be set on it/],
    ['an endpoint on the tiered profile itself', { ...CHAIN, endpoint: 'http://a' }, /"endpoint" cannot be set on it/],
    ['an out-of-range threshold', { harness: 'claude-code', tiers: [{ endpoint: 'anthropic-sub', model: 'm', threshold_percent: 150 }, { endpoint: 'fireworks', model: 'm' }] }, /whole number from 1 to 100/],
    ['an unsupported harness', { harness: 'codex', tiers: [{ endpoint: 'fireworks', model: 'm' }, { endpoint: 'ollama-local', model: 'm' }] }, /support claude-code only/],
    ['an unknown tier key', { harness: 'claude-code', tiers: [{ endpoint: 'fireworks', model: 'm', credential: 'x' } as never, { endpoint: 'ollama-local', model: 'm' }] }, /Unknown option "credential"/],
  ];
  test('a single-tier profile resolves', () => {
    const p = resolve({ chain: { harness: 'claude-code', tiers: [{ endpoint: 'anthropic-sub', model: 'm', threshold_percent: 95 }] } }).get('chain')!;
    expect(p.tiers!.map((t) => [t.endpoint, t.threshold])).toEqual([['anthropic-sub', 95]]);
  });

  for (const [what, block, err] of bad) {
    test(`refuses ${what} at load`, () => {
      expect(() => resolve({ chain: block })).toThrow(err);
    });
  }

  test('an endpoint whose wire does not fit the harness is refused', () => {
    expect(() => resolve(
      { chain: { harness: 'claude-code', tiers: [{ endpoint: 'oai', model: 'm' }, { endpoint: 'fireworks', model: 'm' }] } },
      { ...ENDPOINTS, oai: { url: 'https://api.openai.com', credential: 'openai' } },
    )).toThrow(/tiers\[0\].*speaks the openai API/);
  });

  // INVARIANT: threshold_percent is OPTIONAL on every tier — a tier hands over
  // by REFUSING (a 429), and a threshold is only an early switch (engineer,
  // 2026-10-06: "just let it rip until the 429 is in").
  test('a chain with no thresholds at all loads', () => {
    const p = resolve({
      chain: {
        harness: 'claude-code',
        tiers: [
          { endpoint: 'anthropic-sub', model: 'claude-opus-5-5' },
          { endpoint: 'fireworks', model: 'firerouter/opus' },
          { endpoint: 'ollama-local', model: 'qwen3-coder' },
        ],
      },
    }).get('chain')!;
    expect(p.tiers!.map((t) => [t.endpoint, t.threshold])).toEqual([
      ['anthropic-sub', null], ['fireworks', null], ['ollama-local', null],
    ]);
  });

  // INVARIANT: the builder may run on a tiered profile (engineer, 2026-10-05).
  // Its role target mirrors tier 0 — what the harness launches on — and the
  // proxy picks the tier per request, as for a task.
  test('the builder role accepts a tiered profile, launching on tier 0', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lazy-tiered-builder-'));
    try {
      await writeFile(join(root, 'lazy.toml'), [
        '[endpoints.fw]', 'url = "https://api.fireworks.ai/inference"',
        'credential = "fireworks"',
        '[endpoints.local]', 'url = "http://localhost:11434"',
        'credential = "none"',
        '[agents.chain]', 'harness = "claude-code"',
        'tiers = [{ endpoint = "fw", model = "a" }, { endpoint = "local", model = "b" }]',
        '[models.roles.builder]', 'agent = "chain"',
      ].join('\n'));
      const config = await loadConfig(root);
      expect(config.models.roles.builder.profile).toBe('chain');
      expect(config.models.roles.builder.model).toBe('a');
      expect(config.models.roles.builder.endpoint).toBe('https://api.fireworks.ai/inference');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('proxy tables for a tiered profile', () => {
  test('one route (tier 0) carrying every tier, and one credential entry per tier', () => {
    const config = configWith({ chain: CHAIN });
    const route = agentUpstreamMap(config).chain!;
    expect(route.upstream).toBe('https://api.anthropic.com');
    expect(route.tiers!.map((t) => [t.endpoint, t.upstream, t.model])).toEqual([
      ['anthropic-sub', 'https://api.anthropic.com', 'claude-sonnet-5-5'],
      ['fireworks', 'https://api.fireworks.ai/inference', 'firerouter/opus'],
      ['ollama-local', 'http://localhost:11434', 'qwen3-coder'],
    ]);
    const entries = resolveAgentUpstreams(config).filter((e) => e.profile === 'chain');
    expect(entries.map((e) => [e.upstream, e.credential])).toEqual([
      ['https://api.anthropic.com', 'anthropic'],
      ['https://api.fireworks.ai/inference', 'fireworks'],
      ['http://localhost:11434', null],
    ]);
    const { targets } = buildTargetCredentials('/tmp/x', config);
    expect(targets.has('https://api.fireworks.ai')).toBe(true);
    // The local tier stays unmapped: it is sent no credential at all.
    expect(targets.has('http://localhost:11434')).toBe(false);
  });

  // INVARIANT: the proxy's credential map is keyed by origin, so a tier whose
  // endpoint shares an origin with one mapped to a DIFFERENT credential would be
  // billed to that other credential. Refused, exactly as for a plain profile.
  test('a tier whose origin is claimed by another credential is refused', () => {
    const config = configWith(
      { chain: { harness: 'claude-code', tiers: [{ endpoint: 'anthropic-sub', model: 'a', threshold_percent: 90 }, { endpoint: 'sneaky', model: 'b' }] } },
      { ...ENDPOINTS, sneaky: { url: 'https://api.anthropic.com/other', credential: 'none' } },
    );
    expect(() => buildProxyCredentialDeps('/tmp/x', config)).toThrow(/already mapped to the "anthropic" credential/);
  });

  test('a last conditional tier with no threshold of its own carries [usage_pause]', () => {
    const config = configWith({
      chain: { harness: 'claude-code', tiers: [{ endpoint: 'fireworks', model: 'a' }, { endpoint: 'anthropic-sub', model: 'b' }] },
    });
    (config as { usage_pause: unknown }).usage_pause = { threshold_percent: 90, credentials: {} };
    expect(agentUpstreamMap(config).chain!.tiers![1]).toMatchObject({ threshold: null, pause: { threshold_percent: 90 } });
  });

  // INVARIANT: the proxy's last-known-good config keeps serving the tier chain
  // through a broken lazy.toml edit — tiers ride the same live routing as every
  // other profile route, so a typo never strands a running turn.
  test('a broken edit keeps the last good tier chain serving', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lazy-tiered-live-'));
    enableLastKnownGood();
    try {
      const path = join(root, 'lazy.toml');
      await writeFile(path, [
        '[endpoints.fw]', 'url = "https://api.fireworks.ai/inference"',
        'credential = "fireworks"',
        '[endpoints.local]', 'url = "http://localhost:11434"',
        'credential = "none"',
        '[agents.chain]', 'harness = "claude-code"',
        'tiers = [{ endpoint = "fw", model = "a" }, { endpoint = "local", model = "b" }]',
      ].join('\n'));
      const initial = await loadConfig(root);
      const live = await createLiveProxyRouting(root, initial, buildTargetCredentials(root, initial).targets);
      const before = await live();
      expect(before.routes.chain?.tiers?.map((t) => t.endpoint)).toEqual(['fw', 'local']);
      await writeFile(path, '[agents.chain\n');
      const after = await live();
      expect(after.routes.chain?.tiers?.map((t) => t.endpoint)).toEqual(['fw', 'local']);
      expect(after.targets.has('https://api.fireworks.ai')).toBe(true);
    } finally {
      resetLastKnownGood();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('task model on a tiered profile', () => {
  function fakeStorage() {
    const writes: Array<[string, string]> = [];
    const storage = {
      getProjectSettings: async () => ({}),
      updateTaskModel: async (id: string, model: string) => { writes.push([id, model]); },
      updateTaskMetadata: async () => {},
    } as unknown as Storage;
    return { storage, writes };
  }
  const task = (model: string | null): Task => ({ id: 't1', agent_id: 'chain', model, metadata: {} }) as unknown as Task;

  // INVARIANT (carve-out from turn-model stickiness): a tiered task's model is
  // the serving tier's, chosen per request. task.model is neither read nor
  // written at launch — a stored model would otherwise be sent to every tier,
  // including endpoints that do not serve it.
  test('launch neither reads nor writes task.model', async () => {
    const config = configWith({ chain: CHAIN });
    const { storage, writes } = fakeStorage();
    const identity = await resolveTurnLaunchIdentity({ storage, task: task('claude-opus-5-5'), config });
    expect(identity.model).toBe('claude-sonnet-5-5');
    expect(writes).toEqual([]);
    const oneOff = await resolveOneOffTurnIdentity({ storage, task: task(null), config });
    expect(oneOff.model).toBe('claude-sonnet-5-5');
  });

  // INVARIANT: --model on a tiered task is refused, never silently ignored.
  test('a model override on a tiered task is refused', async () => {
    const config = configWith({ chain: CHAIN });
    const { storage } = fakeStorage();
    await expect(resolveTurnLaunchIdentity({ storage, task: task(null), config, modelOverride: 'x' }))
      .rejects.toThrow(/is tiered/);
    expect(() => assertNoModelOnTiered(config, 'chain', 'x')).toThrow(/cannot pin one with --model/);
    expect(() => assertNoModelOnTiered(config, 'claude-code', 'x')).not.toThrow();
  });
});

describe('thinking history', () => {
  test('removes thinking and redacted_thinking blocks and turns thinking off', () => {
    const r = stripThinkingHistory({
      thinking: { type: 'enabled', budget_tokens: 1 },
      messages: [
        { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 'a' }] },
      ],
    });
    expect(r.stripped).toBe(2);
    expect(r.thinkingDisabled).toBe(true);
    expect(r.body.thinking).toBeUndefined();
    expect(r.body.messages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: '(thinking omitted)' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a' }] },
    ]);
  });

  test('leaves a body with no thinking blocks untouched', () => {
    const body = { thinking: { type: 'enabled' }, messages: [{ role: 'user', content: 'hi' }] };
    expect(stripThinkingHistory(body)).toEqual({ body, stripped: 0, thinkingDisabled: false });
  });
});

describe('tier choice', () => {
  const t = (index: number, usage: 'claude' | null, threshold: number | null) => ({
    index, endpoint: `e${index}`, upstream: `https://e${index}.example`, model: `m${index}`, usage, threshold,
  });
  const reading = (pct: number, resetMs: number) => ({
    credential: 'k', ts: Date.now(), upstream: '', backend: 'proxy', status: 200, taskId: null, model: null, headers: {},
    windows: [{ name: 'unified-5h', usedPercent: pct, resetsAt: resetMs, status: null }],
  });

  test('a conditional tier with no reading is available', async () => {
    const c = await chooseTier([t(0, 'claude', 95), t(1, null, null)], { keyFor: async () => 'k', readingFor: () => null });
    expect(c.tier.index).toBe(0);
  });

  test('every tier full: allFull, and the reason says no tier serves', async () => {
    const r = reading(99, Date.now() + 60_000);
    const c = await chooseTier([t(0, 'claude', 95), t(1, 'claude', 95)], { keyFor: async () => 'k', readingFor: () => r as never });
    expect(c).toMatchObject({ allFull: true, tier: { index: 1 } });
    expect(c.skipped).toHaveLength(2);
    expect(c.reason).toContain('no tier serves');
  });

  test('every tier full: retry-after is the earliest reset, and the message names profile and reset', async () => {
    const early = Date.now() + 120_000;
    const late = Date.now() + 3_600_000;
    const c = await chooseTier([t(0, 'claude', 95), t(1, 'claude', 95)], {
      keyFor: async (tier) => `k${tier.index}`,
      readingFor: (key) => reading(99, key === 'k0' ? late : early) as never,
    });
    expect(earliestReset(c)).toBe(early);
    expect(allFullRetryAfterSeconds(early, early - 90_500)).toBe(91);
    expect(allFullRetryAfterSeconds(early, early + 5000)).toBe(1);
    expect(allFullRetryAfterSeconds(null)).toBe(ALL_FULL_UNKNOWN_RESET_RETRY_SECONDS);
    const msg = allTiersFullMessage('chain', c, early);
    expect(msg).toContain('agent profile "chain"');
    expect(msg).toContain(new Date(early).toISOString());
  });

  // INVARIANT: Claude Code (verified on 2.1.285) does not retry a 429 with a
  // long retry-after; the turn ends at once with "API Error: Request rejected
  // (429) · <message>". That line must classify as a transient rate limit, so
  // lazy retries the turn (task stays working, the retry line shows the
  // message) until a window resets — never a fatal block, which only a human
  // can lift, for a condition that clears by itself.
  test("Claude Code's every-tier-full error is retried by lazy, not blocked", async () => {
    const r = reading(99, Date.now() + 3_600_000);
    const c = await chooseTier([t(0, 'claude', 95), t(1, 'claude', 95)], { keyFor: async () => 'k', readingFor: () => r as never });
    const line = `API Error: Request rejected (429) · ${allTiersFullMessage('chain', c, earliestReset(c))}`;
    expect(new ClaudeCodeAgent().classifyFailure({ message: line }).class).toBe('transient_overload');
  });

  test('the every-tier-full record names the profile, says no tier serves, and gives the reset', () => {
    const text = tierSwitchJournalText({
      taskId: 't', profile: 'chain', ts: 0, allFull: true, crossed: false, thinkingDisabled: false, reason: 'all full',
      from: { index: 1, endpoint: 'fireworks', model: 'b' }, to: null, retryAt: Date.UTC(2026, 9, 1, 15),
    }, 4);
    expect(text).toContain('**Every tier full** on agent profile `chain` during turn 4');
    expect(text).toContain('HTTP 429');
    expect(text).toContain('2026-10-01T15:00:00.000Z');
  });

  test('a reset window counts as empty even before a fresh reading arrives', async () => {
    const r = reading(99, Date.now() - 1000);
    const c = await chooseTier([t(0, 'claude', 95), t(1, null, null)], { keyFor: async () => 'k', readingFor: () => r as never });
    expect(c.tier.index).toBe(0);
  });

  test('the switch record names both tiers, the turn and the reason', () => {
    const text = tierSwitchJournalText({
      taskId: 't', profile: 'chain', ts: 0, allFull: false, crossed: true, thinkingDisabled: true, reason: 'because',
      from: { index: 0, endpoint: 'anthropic-sub', model: 'a' }, to: { index: 1, endpoint: 'fireworks', model: 'b' },
    }, 3);
    expect(text).toContain('during turn 3');
    expect(text).toContain('tier 1 — endpoint `anthropic-sub`, model `a`');
    expect(text).toContain('tier 2 — endpoint `fireworks`, model `b`');
    expect(text).toContain('Why: because');
  });
});

afterEach(() => resetLastKnownGood());

describe('launch gate', () => {
  // INVARIANT: Teams tiers use member endpoint checks, not a blanket profile refusal. Each paid endpoint is checked by the ownership gate before launch.
  test('team mode delegates tiered credential checks to the member endpoint gate', async () => {
    const { turnCredentialRefusal } = await import('../../src/daemon/credential-gate');
    const refusal = await turnCredentialRefusal('/tmp/x', 'chain', { perUser: true, config: configWith({ chain: CHAIN }) });
    expect(refusal).toBeNull();
  });
});

describe('launch-time usage pause for a tiered task', () => {
  const pauseConfig = (usagePause: { threshold_percent: number; credentials: Record<string, number> }) => {
    const c = configWith({ chain: CHAIN });
    (c as unknown as Record<string, unknown>).usage_pause = usagePause;
    (c as unknown as Record<string, unknown>).data = { path: '.lazy' };
    return c;
  };
  const tieredTask = { id: 'tp1', agent_id: 'chain', metadata: {} } as unknown as Task;

  async function fillTierZero(config: ResolvedConfig) {
    const { daemonUsageLimits } = await import('../../src/proxy/usage-limits');
    const { usageLimitCredentialKey } = await import('../../src/proxy/usage-limits');
    const { targets } = buildTargetCredentials('/tmp/x', config);
    const outcome = await targets.forTarget('https://api.anthropic.com');
    const key = usageLimitCredentialKey({
      credentialLabel: outcome.kind === 'credential' ? outcome.label : null, upstream: 'https://api.anthropic.com',
    });
    daemonUsageLimits.observeReading({
      credential: key, ts: Date.now(), upstream: 'https://api.anthropic.com', backend: 'proxy', status: 200,
      taskId: null, model: null,
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.99',
        'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
      },
    });
  }

  afterEach(async () => {
    const { resetUsageReadingsForTest } = await import('../../src/daemon/usage-readings');
    resetUsageReadingsForTest();
  });

  // INVARIANT: a tiered task is judged the way its requests are routed — paused
  // only when EVERY tier is full. Judging it on tier 0's credential alone
  // refused `lazy unblock` exactly when the chain was meant to take over.
  test('a full tier 0 does not pause a chain with an always-available tier', async () => {
    const { usagePauseForTask } = await import('../../src/daemon/usage-pause');
    const config = pauseConfig({ threshold_percent: 90, credentials: {} });
    const root = await mkdtemp(join(tmpdir(), 'lazy-tiered-pause-'));
    try {
      await fillTierZero(config);
      expect(await usagePauseForTask(root, config, tieredTask)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // INVARIANT (usage-pause hardening, carried to tiers): unreadable saved
  // readings fail CLOSED for a chain that depends on a reading.
  test('unreadable saved readings refuse a tiered launch', async () => {
    const { usagePauseForTask } = await import('../../src/daemon/usage-pause');
    const { installUsageReadingStore } = await import('../../src/daemon/usage-readings');
    installUsageReadingStore(async () => ({
      getUsageLimitReadings: async () => { throw new Error('not valid JSON'); },
      saveUsageLimitReading: async () => {},
    }));
    const config = pauseConfig({ threshold_percent: 0, credentials: {} });
    const root = await mkdtemp(join(tmpdir(), 'lazy-tiered-pause-'));
    try {
      const pause = await usagePauseForTask(root, config, tieredTask);
      expect(pause?.verdict.storeError).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('task model on a tiered profile, at every write', () => {
  // INVARIANT: switching a task ONTO a tiered profile clears its stored model,
  // which would otherwise be sent to every tier.
  test('an agent switch onto a tiered profile clears task.model', async () => {
    const { switchTaskAgent } = await import('../../src/daemon/agent-switch');
    const writes: Array<[string, string]> = [];
    const storage = {
      updateTaskAgent: async () => {},
      getSessionByTaskId: async () => null,
      updateTaskModel: async (id: string, m: string) => { writes.push([id, m]); },
      updateTaskMetadata: async () => {},
    } as unknown as Storage;
    const config = configWith({ chain: CHAIN });
    (config as unknown as Record<string, unknown>).agent = { effort: 'medium' };
    const task = { id: 't9', agent_id: 'claude-code', model: 'claude-opus-5-5', metadata: {}, status: 'blocked' } as unknown as Task;
    const result = await switchTaskAgent({ storage, task, newAgentId: 'chain', config });
    expect(writes).toEqual([['t9', '']]);
    expect(result.model).toBe('');
    await expect(switchTaskAgent({
      storage, task: { ...task, agent_id: 'claude-code' } as Task, newAgentId: 'chain', config, modelOverride: 'x',
    })).rejects.toThrow(/is tiered/);
  });
});

describe('usage by endpoint', () => {
  test('tiered requests group under their named endpoint, others under the upstream origin', async () => {
    const { aggregateUsage } = await import('../../src/proxy/aggregate');
    const rec = (over: Record<string, unknown>) => ({
      id: 'x', seq: 1, ts: 1, role: 'agent', taskId: 't', upstream: 'https://api.anthropic.com/v1',
      usage: { input_tokens: 10, output_tokens: 5 }, ...over,
    });
    const report = aggregateUsage([
      rec({ servedByEndpoint: 'fireworks', upstream: 'https://api.fireworks.ai/inference' }),
      rec({ servedByEndpoint: 'fireworks', upstream: 'https://api.fireworks.ai/inference' }),
      rec({}),
    ] as never);
    expect(report.byEndpoint.map((g) => [g.key, g.requests])).toEqual([
      ['fireworks', 2],
      ['https://api.anthropic.com', 1],
    ]);
  });
});

describe('builder default profile', () => {
  test('a tiered override of the builder\'s default profile is the builder\'s profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lazy-tiered-builder-default-'));
    try {
      await writeFile(join(root, 'lazy.toml'), [
        '[endpoints.fw]', 'url = "https://api.fireworks.ai/inference"',
        'credential = "fireworks"',
        '[endpoints.local]', 'url = "http://localhost:11434"',
        'credential = "none"',
        '[agents.claude-code]', 'harness = "claude-code"',
        'tiers = [{ endpoint = "fw", model = "a" }, { endpoint = "local", model = "b" }]',
        '[agent]', 'agent_id = "pi"',
      ].join('\n'));
      const config = await loadConfig(root);
      expect(config.models.roles.builder.profile).toBe('claude-code');
      expect(config.models.roles.builder.model).toBe('a');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('thinking after a provider crossing', () => {
  const thinkingOn = { type: 'enabled', budget_tokens: 1024 };
  const crossedAssistant = {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 't', signature: 'foreign' }, { type: 'tool_use', id: 'tu1', name: 'x', input: {} }],
  };

  // INVARIANT: a provider crossing never ends extended thinking for the rest of
  // the task. Once a new user message starts a fresh turn, the request keeps
  // `thinking` on — the stripped blocks belong to turns the docs let us omit.
  test('thinking stays on for the first request after a new user message', () => {
    const r = stripThinkingHistory({
      thinking: thinkingOn,
      messages: [
        { role: 'user', content: 'do it' },
        crossedAssistant,
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        { role: 'user', content: 'next thing please' },
      ],
    });
    expect(r.stripped).toBe(1);
    expect(r.thinkingDisabled).toBe(false);
    expect(r.body.thinking).toEqual(thinkingOn);
  });

  // INVARIANT: while the tool-use loop whose final assistant message lost its
  // thinking block is still open, `thinking` is turned off for that request —
  // Anthropic refuses a final assistant message without its thinking block
  // while thinking is enabled.
  test('thinking is turned off when the final assistant message of an open tool loop lost its block', () => {
    const r = stripThinkingHistory({
      thinking: thinkingOn,
      messages: [
        { role: 'user', content: 'do it' },
        crossedAssistant,
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
      ],
    });
    expect(r.thinkingDisabled).toBe(true);
    expect(r.body.thinking).toBeUndefined();
  });

  test('the switch record says when thinking was turned off', () => {
    const base = {
      taskId: 't', profile: 'chain', ts: 0, allFull: false, crossed: true, reason: 'r',
      from: { index: 0, endpoint: 'a', model: 'a' }, to: { index: 1, endpoint: 'b', model: 'b' },
    };
    expect(tierSwitchJournalText({ ...base, thinkingDisabled: true }, 1)).toContain('Extended thinking was turned off for this request');
    expect(tierSwitchJournalText({ ...base, thinkingDisabled: false }, 1)).not.toContain('Extended thinking');
  });
});

describe('thinking stays in one mode for a whole tool loop', () => {
  const on = { type: 'enabled', budget_tokens: 1024 };

  // INVARIANT: a tool-use loop runs in ONE thinking mode. The request after the
  // one that turned thinking off carries a final assistant message produced
  // without thinking — nothing left to strip — and must keep thinking off, or
  // the loop toggles mid-turn (a 400, or a silent disable, per Anthropic).
  test('the next request of the same open loop keeps thinking off', () => {
    const r = stripThinkingHistory({
      thinking: on,
      messages: [
        { role: 'user', content: 'do it' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'x', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
      ],
    });
    expect(r.stripped).toBe(0);
    expect(r.thinkingDisabled).toBe(true);
    expect(r.body.thinking).toBeUndefined();
  });

  // INVARIANT: a user message carrying a tool_result plus text (Claude Code adds
  // reminders) still continues the open loop.
  test('tool_result plus text is still an open loop', () => {
    const r = stripThinkingHistory({
      thinking: on,
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 'a', name: 'x', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }, { type: 'text', text: '<reminder>' }] },
      ],
    });
    expect(r.thinkingDisabled).toBe(true);
  });

  // INVARIANT: adaptive thinking has no final-block requirement and is never
  // turned off by lazy.
  test('adaptive thinking is never removed', () => {
    const r = stripThinkingHistory({
      thinking: { type: 'adaptive' },
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 'a', name: 'x', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
      ],
    });
    expect(r.stripped).toBe(1);
    expect(r.thinkingDisabled).toBe(false);
    expect(r.body.thinking).toEqual({ type: 'adaptive' });
  });
});
