/**
 * The daemon dashboard's task header names what the task really runs on: the
 * agent PROFILE (labelled as one, facts in its tooltip) and, for a tiered
 * profile, the tier chain instead of a single model that is never sent. The
 * `show` RPC carries the same answer for Lazy Teams.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess, extractTaskId } from '../helpers/assertions';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { signInToDashboard, type DashboardFetch } from '../helpers/dashboard-session';

describe('dashboard task header: agent profile', () => {
  let ctx: TestContext;
  let base: string;
  let fetch: DashboardFetch;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    // Appending NEW tables (init writes neither) — the keys are not redefinitions.
    appendFileSync(join(ctx.root, 'lazy.toml'), `
[endpoints.anthropic-sub]
url = "https://api.anthropic.com"
credential = "anthropic"

[endpoints.fireworks]
url = "https://api.fireworks.ai/inference"
credential = "work-fireworks"

[agents.fw]
harness = "claude-code"
model = "firerouter/opus"
named_endpoint = "fireworks"

[agents.chain]
harness = "claude-code"
tiers = [
  { endpoint = "anthropic-sub", model = "claude-sonnet-5-5", threshold_percent = 95 },
  { endpoint = "fireworks", model = "firerouter/opus" },
]
`);
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function headerFor(agent: string | null): Promise<string> {
    const goal = `On ${agent ?? 'default'}`;
    const created = await ctx.lazy(['create', '--goal', goal, ...(agent ? ['--agent', agent] : [])]);
    expectSuccess(created);
    const taskId = extractTaskId(created.stdout);
    const html = await (await fetch(`${base}/tasks/${taskId}`)).text();
    const m = /<span class="lz-launch-identity">.*?<\/span>\s*<\/span>/s.exec(html);
    expect(m).not.toBeNull();
    return m![0];
  }

  test('a built-in profile reads "profile claude-code" with harness and endpoint in the tooltip', async () => {
    const html = await headerFor(null);
    expect(html).toContain('profile claude-code');
    expect(html).toContain('Harness: claude-code');
    expect(html).toContain('Endpoint: the harness default');
  });

  test('a custom profile shows its named endpoint and credential NAME', async () => {
    const html = await headerFor('fw');
    expect(html).toContain('profile fw');
    expect(html).toContain('from lazy.toml');
    expect(html).toContain('fireworks — https://api.fireworks.ai/inference');
    expect(html).toContain('Credential: work-fireworks');
    expect(html).toContain('firerouter/opus');
  });

  test('a tiered profile shows its tier chain, not a single model', async () => {
    const html = await headerFor('chain');
    expect(html).toContain('tiered: anthropic-sub/claude-sonnet-5-5 → fireworks/firerouter/opus');
  });

  // INVARIANT: `show` sends the resolved profile, so Teams renders the same
  // answer as the dashboard and never reads lazy.toml itself.
  test('the show RPC carries the same resolved profile', async () => {
    const created = await ctx.lazy(['create', '--goal', 'rpc', '--agent', 'chain']);
    expectSuccess(created);
    const target = getDaemonTcpTarget(ctx.root)!;
    const shown = (await DaemonClient.fromTarget(target, readToken(ctx.root)!).rpc('show', ctx.root, {
      taskId: extractTaskId(created.stdout),
    })) as { launchIdentity: { profile: { name: string; tiers: Array<{ endpoint: string }> } } };
    const profile = shown.launchIdentity.profile;
    expect(profile.name).toBe('chain');
    expect(profile.tiers.map((t: { endpoint: string }) => t.endpoint)).toEqual(['anthropic-sub', 'fireworks']);
  });
});
