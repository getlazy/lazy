/**
 * The one shape `lazy stats limits --json` and `lazy_usage_limits` share, and
 * the narrowing a task agent's call gets.
 */
import { describe, test, expect } from 'bun:test';
import { memberPairUsageLimitsView, memberUsageLimitsView, projectUsageLimits, scopeUsageLimitsView } from '../../src/usage-pause/limits-view';
import { memberEndpointUsageKey } from '../../src/proxy/usage-limits';
import type { UsageLimitReading } from '../../src/proxy/usage-limits';
import type { UsagePauseVerdict } from '../../src/usage-pause/policy';
import { describeUsageLimitsView } from '../../src/daemon/usage-pause';
import type { Storage } from '../../src/storage/interface';

function reading(credential: string, headers: Record<string, string>): UsageLimitReading {
  return {
    credential, ts: 1000, upstream: 'https://api.anthropic.com', backend: 'claude',
    status: 200, taskId: null, model: null, headers, windows: [],
  };
}

const alice = reading('user:alice@example.com', {
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled_until',
});
const bob = reading('user:bob@example.com', { 'anthropic-ratelimit-unified-5h-utilization': '0.9' });
const bobPaused: UsagePauseVerdict = {
  credential: bob.credential, window: 'unified-5h', usedPercent: 90, status: null,
  threshold: 80, resetsAt: null, readingAt: 1000,
};
const pause = {
  configured: { threshold_percent: 80, credentials: { [alice.credential]: 95, [bob.credential]: 70 } },
  override: null,
  paused: [bobPaused],
  held: [
    { taskId: 't-alice', task: 'a', hold: { ...bobPaused, credential: alice.credential, held: 'auto-resume', since: 1 } },
    { taskId: 't-bob', task: 'b', hold: { ...bobPaused, held: 'auto-resume', since: 1 } },
  ],
};

describe('usage-limits view', () => {
  // INVARIANT: member Pair/Chat sees only its own account, never the paired
  // task's spender or comment/launch state. Two members on one task differ.
  test('Pair and Chat scope every credential field to the authenticated member', () => {
    const endpointAlice = memberEndpointUsageKey('alice@example.com', 'builtin:anthropic');
    const endpointBob = memberEndpointUsageKey('bob@example.com', 'builtin:anthropic');
    const service = 'user:__service__';
    const credentials = [alice.credential, bob.credential, endpointAlice, endpointBob, service, 'credential:ANTHROPIC_API_KEY'];
    const full = projectUsageLimits(credentials.map(c => reading(c, {})), {
      ...pause,
      configured: { threshold_percent: 80, credentials: Object.fromEntries(credentials.map(c => [c, 70])) },
      paused: credentials.map(c => ({ ...bobPaused, credential: c })),
      coverage: credentials.map(c => ({ credential: c, coverage: 'none' as const, readingAt: null, lastSpentAt: null })),
    }, Date.now(), credentials.map(c => ({
      credential: c, userId: null, profile: null, upstream: 'https://api.anthropic.com',
      failedAt: 1000, status: 401, error: 'Expired', unusable: false,
    })));
    for (const [email, own] of [[' ALICE@example.com ', [alice.credential, endpointAlice]], ['bob@example.com', [bob.credential, endpointBob]]] as const) {
      const scoped = memberPairUsageLimitsView(full, email);
      expect(scoped.scope).toBe('member');
      expect(scoped.readings.map(r => r.credential)).toEqual([...own]);
      expect(Object.keys(scoped.pause.configured.credentials)).toEqual([...own]);
      expect(scoped.pause.paused.map(p => p.credential)).toEqual([...own]);
      expect(scoped.pause.coverage.map(c => c.credential)).toEqual([...own]);
      expect(scoped.credentialHealth.map(c => c.credential)).toEqual([...own]);
      expect(scoped.pause.held).toEqual([]);
    }
    expect(() => memberPairUsageLimitsView(full, '')).toThrow('authenticated member');
  });

  // INVARIANT: a member on an endpoint/tiered profile sees their own endpoint
  // readings, never the task owner's or another member's connection.
  test('member Pair scopes named tier endpoints to the attaching member', () => {
    const own = memberEndpointUsageKey('alice@example.com', 'gateway');
    const other = memberEndpointUsageKey('bob@example.com', 'gateway');
    const primary = memberEndpointUsageKey('alice@example.com', 'builtin:anthropic');
    const full = projectUsageLimits([own, other, primary].map(key => reading(key, {})), pause);
    expect(memberPairUsageLimitsView(full, 'alice@example.com', ['gateway']).readings.map(r => r.credential)).toEqual([own]);
  });

  test('project view carries every reading with its overage and pause verdict', () => {
    const view = projectUsageLimits([alice, bob], pause);
    expect(view.scope).toBe('project');
    expect(view.readings.map((r) => r.credential)).toEqual([alice.credential, bob.credential]);
    expect(view.readings[0].overage).toEqual({ status: 'rejected', reason: 'org_level_disabled_until' });
    expect(view.readings[0].paused).toBeNull();
    expect(view.readings[1].overage).toBeNull();
    expect(view.readings[1].paused).toEqual(bobPaused);
    expect(view.readings[1].headers).toEqual(bob.headers);
    expect(view.pause.held).toHaveLength(2);
  });

  // INVARIANT: provider health reaches narrowed views as counts only — its
  // failure TEXT can carry another member's credential label (their address)
  // or quote an upstream error from somebody else's request.
  test('narrowed views keep provider health counts but drop the failure text', () => {
    const health = [{
      provider: 'Anthropic', host: 'api.anthropic.com', requests: 3,
      failures: { reset: 1, timeout: 0, connect: 0, server_error: 0, overloaded: 0, rate_limited: 0, other: 0 },
      lastFailureAt: 1, lastFailure: 'Anthropic (api.anthropic.com, credential `bob@example.com (endpoint builtin:anthropic)`) reset',
    }];
    const project = projectUsageLimits([alice, bob], pause, Date.now(), [], health);
    expect(project.providerHealth![0]!.lastFailure).toContain('bob@example.com');
    for (const view of [
      scopeUsageLimitsView(project, alice.credential, 't-alice'),
      memberUsageLimitsView(project, alice.credential, 'user:__service__'),
    ]) {
      expect(view.providerHealth![0]).toMatchObject({ requests: 3, lastFailureAt: 1, lastFailure: null });
      expect(JSON.stringify(view)).not.toContain('bob@example.com');
    }
  });

  // INVARIANT: a task agent's view names no credential but the one its own
  // turn spends — on a Teams host the others are other members' accounts.
  test('task scope keeps only the calling task\'s credential and hold', () => {
    const view = scopeUsageLimitsView(projectUsageLimits([alice, bob], pause), alice.credential, 't-alice');
    expect(view.scope).toBe('task');
    expect(view.credential).toBe(alice.credential);
    expect(view.readings.map((r) => r.credential)).toEqual([alice.credential]);
    expect(view.pause.paused).toEqual([]);
    expect(view.pause.configured).toEqual({ threshold_percent: 80, credentials: { [alice.credential]: 95 } });
    expect(view.pause.held.map((h) => h.taskId)).toEqual(['t-alice']);
    expect(JSON.stringify(view)).not.toContain('bob@example.com');
  });

  test('an unknown credential leaves nothing credential-specific', () => {
    const view = scopeUsageLimitsView(projectUsageLimits([alice, bob], pause), null, 't-x');
    expect(view.readings).toEqual([]);
    expect(view.pause.paused).toEqual([]);
    expect(view.pause.configured.credentials).toEqual({});
    expect(view.pause.held).toEqual([]);
  });

  // INVARIANT: a Teams builder sees the service credential, its own session's,
  // and nothing keyed to another member — reading, verdict, threshold or hold.
  test('member scope hides every other member\'s credential', () => {
    const service = 'user:__service__';
    const withService = projectUsageLimits([alice, bob, reading(service, {}), reading('credential:ANTHROPIC_API_KEY', {})], pause);
    const view = memberUsageLimitsView(withService, alice.credential, service);
    expect(view.scope).toBe('member');
    expect(view.readings.map((r) => r.credential)).toEqual([alice.credential, service, 'credential:ANTHROPIC_API_KEY']);
    expect(view.pause.paused).toEqual([]);
    expect(view.pause.configured.credentials).toEqual({ [alice.credential]: 95 });
    expect(view.pause.held.map((h) => h.taskId)).toEqual(['t-alice']);
    expect(JSON.stringify(view)).not.toContain('bob@example.com');

    const unbound = memberUsageLimitsView(withService, null, service);
    expect(unbound.readings.map((r) => r.credential)).toEqual([service, 'credential:ANTHROPIC_API_KEY']);
    expect(JSON.stringify(unbound)).not.toContain('alice@example.com');
    expect(JSON.stringify(unbound)).not.toContain('bob@example.com');
  });
});

describe('usage-limits view when the readings cannot be read', () => {
  // INVARIANT: a failed read of the recorded readings is an ERROR, never an
  // empty list — `readings: []` would read as untouched headroom to a builder
  // planning work.
  test('a failed seed propagates instead of answering with no readings', async () => {
    const failing = async () => { throw new Error('audit log unreadable'); };
    const noStorage = {} as unknown as Storage;
    await expect(
      describeUsageLimitsView('/nonexistent', noStorage, { kind: 'builder', label: null }, failing),
    ).rejects.toThrow('audit log unreadable');
  });
});
