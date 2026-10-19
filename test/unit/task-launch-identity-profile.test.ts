import { describe, test, expect } from 'bun:test';
import type { ResolvedConfig } from '../../src/config/types';
import type { Task } from '../../src/types';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/config/default-target';
import { taskLaunchIdentityView } from '../../src/task/launch-identity-view';
import { launchIdentityHtml } from '../../src/server/task-page';

const ENDPOINTS = {
  'anthropic-sub': { url: 'https://api.anthropic.com', credential: 'anthropic' },
  fireworks: { url: 'https://api.fireworks.ai/inference', credential: 'work-fireworks' },
};

function config(agents?: Record<string, unknown>): ResolvedConfig {
  return {
    agents,
    endpoints: ENDPOINTS,
    models: { default: 'claude-opus-5-5', roles: { builder: ANTHROPIC_DEFAULT_TARGET, agent: ANTHROPIC_DEFAULT_TARGET } },
    agent: { effort: 'medium' },
    usage_pause: { threshold_percent: 0, credentials: {} },
    proxy: { upstream: 'https://api.anthropic.com', cursorUpstream: 'https://api2.cursor.sh', fallbacks: [] },
  } as unknown as ResolvedConfig;
}

const task = (over: Partial<Task> = {}): Task => ({
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', code: 't', goal: 'g', prompt: 'p', type: 'task',
  status: 'working', created_at: 1, completed_at: null, target: { kind: 'branch', branch: 'main' },
  branched_from_sha: null, close_reason: null, model: null, agent_id: 'claude-code',
  runner_type: null, metadata: null, tags: [], pending_sync: 0, ...over,
} as Task);

describe('taskLaunchIdentityView().profile', () => {
  // INVARIANT: the header states the profile the LAUNCH resolves, from the daemon's
  // answer. A client that re-derived it from lazy.toml could disagree with what runs.
  test('built-in profile: harness, harness-default endpoint, credential name', () => {
    const { profile } = taskLaunchIdentityView({ task: task(), config: config() });
    expect(profile).toMatchObject({
      name: 'claude-code', found: true, builtin: true, harness: 'claude-code',
      endpoint_name: null, tiers: null, model_origin: 'project', effort_origin: 'project',
    });
    expect(profile!.credential).toBeString();
  });

  test('custom profile on a named endpoint: not built-in, endpoint named, profile model origin', () => {
    const view = taskLaunchIdentityView({
      task: task({ agent_id: 'fw' }),
      config: config({ fw: { harness: 'claude-code', model: 'firerouter/opus', named_endpoint: 'fireworks' } }),
    });
    expect(view.profile).toMatchObject({
      name: 'fw', builtin: false, endpoint_name: 'fireworks',
      endpoint_url: 'https://api.fireworks.ai/inference', credential: 'work-fireworks', model_origin: 'profile',
    });
    expect(view.model.value).toBe('firerouter/opus');
  });

  test('a stored task model wins and is reported as the task\'s', () => {
    const view = taskLaunchIdentityView({
      task: task({ agent_id: 'fw', model: 'other', metadata: { effort: 'high' } } as never),
      config: config({ fw: { harness: 'claude-code', model: 'firerouter/opus', named_endpoint: 'fireworks' } }),
    });
    expect(view.profile).toMatchObject({ model_origin: 'task', effort_origin: 'task' });
  });

  test('tiered profile: ordered tiers with thresholds', () => {
    const view = taskLaunchIdentityView({
      task: task({ agent_id: 'chain' }),
      config: config({
        chain: {
          harness: 'claude-code',
          tiers: [
            { endpoint: 'anthropic-sub', model: 'claude-sonnet-5-5', threshold_percent: 95 },
            { endpoint: 'fireworks', model: 'firerouter/opus' },
          ],
        },
      }),
    });
    expect(view.profile!.tiers!.map((t) => [t.endpoint, t.url, t.credential, t.model, t.threshold])).toEqual([
      ['anthropic-sub', 'https://api.anthropic.com', 'anthropic', 'claude-sonnet-5-5', 95],
      ['fireworks', 'https://api.fireworks.ai/inference', 'work-fireworks', 'firerouter/opus', null],
    ]);
    // INVARIANT: a tiered profile's endpoint and credential are per tier; the profile-level
    // fields (which only mirror tier 0) are not offered as if they were the whole story.
    expect(view.profile).toMatchObject({ endpoint_name: null, endpoint_url: null, credential: null });
    const html = launchIdentityHtml(view);
    expect(html).toContain('Credential: work-fireworks');
    expect(html).not.toContain('Endpoint: the harness default');
    expect(html).toContain('tiered: anthropic-sub/claude-sonnet-5-5 → fireworks/firerouter/opus');
    expect(html).toContain('profile chain');
  });

  // INVARIANT: a profile lazy.toml no longer defines is shown as missing, never
  // as a fallback to some other profile.
  test('missing profile is reported plainly', () => {
    const view = taskLaunchIdentityView({ task: task({ agent_id: 'gone' }), config: config() });
    expect(view.profile).toMatchObject({ name: 'gone', found: false, harness: null, credential: null, tiers: null });
    const html = launchIdentityHtml(view);
    expect(html).toContain('profile gone (missing)');
    expect(html).toContain('lz-launch-missing');
  });

  test('header says "profile <name>" with harness, endpoint and credential in the tooltip', () => {
    const html = launchIdentityHtml(taskLaunchIdentityView({ task: task(), config: config() }));
    expect(html).toContain('profile claude-code');
    expect(html).toContain('Harness: claude-code');
    expect(html).toContain('Endpoint: the harness default');
    expect(html).toContain('Credential:');
  });
});

describe('launchIdentity URLs', () => {
  // INVARIANT: no URL leaves the daemon with userinfo or a query string — lazy.toml
  // URLs may embed a secret and these reach every header tooltip and the show RPC.
  test('endpoint and tier URLs are stripped of user:pass@ and ?query', () => {
    const dirty = 'https://user:secret@host.example/path?key=x';
    const cfg = config({
      one: { harness: 'claude-code', model: 'm', endpoint: dirty, credential: 'anthropic' },
      chain: { harness: 'claude-code', tiers: [
        { endpoint: 'leaky', model: 'a', threshold_percent: 90 },
        { endpoint: 'fireworks', model: 'b' },
      ] },
    });
    (cfg as unknown as { endpoints: Record<string, unknown> }).endpoints = {
      ...ENDPOINTS, leaky: { url: dirty, credential: 'anthropic' },
    };
    const one = taskLaunchIdentityView({ task: task({ agent_id: 'one' }), config: cfg });
    const chain = taskLaunchIdentityView({ task: task({ agent_id: 'chain' }), config: cfg });
    expect(one.profile!.endpoint_url).toBe('https://host.example/path');
    expect(chain.profile!.tiers![0]!.url).toBe('https://host.example/path');
    const wire = JSON.stringify([one, chain]) + launchIdentityHtml(one) + launchIdentityHtml(chain);
    expect(wire).not.toContain('secret');
    expect(wire).not.toContain('key=x');
  });
});
