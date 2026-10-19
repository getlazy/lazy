/**
 * The builder on a TIERED agent profile: its launch gate covers every tier,
 * its usage pause follows the tier in use, team mode refuses it in the task's
 * own words, and its surfaces say which tier is answering. Config load and the
 * per-request switching are covered in tiered-agent-profiles.test.ts and
 * proxy-tiered-profiles.test.ts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from '../../src/config/loader';
import type { ResolvedConfig } from '../../src/config/types';
import { buildTargetCredentials } from '../../src/proxy/credential-deps';
import { daemonUsageLimits, usageLimitCredentialKey } from '../../src/proxy/usage-limits';
import { resetUsageReadingsForTest } from '../../src/daemon/usage-readings';
import { targetCredentialRefusal, turnCredentialRefusal } from '../../src/daemon/credential-gate';
import { usagePauseBeside } from '../../src/daemon/usage-pause';
import {
  builderTierLine, builderTierView, recordBuilderTierSwitch, resetBuilderTierHistory,
} from '../../src/daemon/builder-tier';
import { builderTierPanelHtml } from '../../src/server/conversations';
import { putUserCredential, clearUserCredentialCache } from '../../src/daemon/user-credentials';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { sideLaunchCredentialProblem } from '../../src/daemon/turn-credentials';
import { assertNoModelOnTiered } from '../../src/agent/tiered-model';

const roots: string[] = [];

async function project(lines: string[]): Promise<{ root: string; config: ResolvedConfig }> {
  const root = await mkdtemp(join(tmpdir(), 'lazy-builder-tiered-'));
  roots.push(root);
  await writeFile(join(root, 'lazy.toml'), lines.join('\n'));
  return { root, config: await loadConfig(root) };
}

// Tier 1 on the subscription with its own threshold, tier 2 always available.
const SUB_THEN_LOCAL = [
  '[endpoints.sub]', 'url = "https://api.anthropic.com"',
  'credential = "anthropic"',
  '[endpoints.local]', 'url = "http://localhost:11434"', 'credential = "none"',
  '[agents.chain]', 'harness = "claude-code"',
  'tiers = [{ endpoint = "sub", model = "claude-opus-5-5", threshold_percent = 90 }, { endpoint = "local", model = "qwen3-coder" }]',
  '[models.roles.builder]', 'agent = "chain"',
];

async function fillTierOne(root: string, config: ResolvedConfig): Promise<void> {
  const { targets } = buildTargetCredentials(root, config);
  const outcome = await targets.forTarget('https://api.anthropic.com');
  daemonUsageLimits.observeReading({
    credential: usageLimitCredentialKey({
      credentialLabel: outcome.kind === 'credential' ? outcome.label : null, upstream: 'https://api.anthropic.com',
    }),
    ts: Date.now(), upstream: 'https://api.anthropic.com', backend: 'proxy', status: 200, taskId: null, model: null,
    headers: {
      'anthropic-ratelimit-unified-5h-utilization': '0.99',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
    },
  });
}

afterEach(async () => {
  resetUsageReadingsForTest();
  resetBuilderTierHistory();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

describe('builder launch gate', () => {
  // INVARIANT: a tiered builder's launch checks EVERY tier's credential, not
  // just tier 1 (which the flattened role target mirrors) — the proxy may move
  // any of its requests to any tier, so a missing one would be a 401 mid-turn.
  test('a missing credential on a lower tier refuses the builder launch, naming the tier', async () => {
    const { root, config } = await project([
      '[endpoints.local]', 'url = "http://localhost:11434"', 'credential = "none"',
      '[endpoints.fw]', 'url = "https://api.fireworks.ai/inference"', 'credential = "work-fireworks"',
      '[agents.chain]', 'harness = "claude-code"',
      'tiers = [{ endpoint = "local", model = "qwen3-coder" }, { endpoint = "fw", model = "firerouter/opus" }]',
      '[models.roles.builder]', 'agent = "chain"',
    ]);
    const target = config.models.roles.builder;
    expect(target.credential).toBe('none');
    const refusal = await targetCredentialRefusal(root, target, { config });
    expect(refusal).toMatch(/tier 2, endpoint "fw"/);
  });

  // INVARIANT: a member's tiered builder checks each endpoint like a task.
  // Missing lower tiers must refuse before any model request can spend.
  test('member launch preflight checks endpoint credentials instead of a blanket tier refusal', async () => {
    const base = await mkdtemp(join(tmpdir(), 'lazy-builder-member-base-'));
    roots.push(base);
    const unpin = pinDaemonBaseDir(base);
    try {
      const { root, config } = await project(SUB_THEN_LOCAL);
      await putUserCredential(root, { userId: 'alice@example.com', kind: 'api-key', token: 'builtin-secret' });
      expect(await turnCredentialRefusal(root, 'chain', { perUser: true, config })).toBeNull();
      expect(await sideLaunchCredentialProblem(root, 'alice@example.com', 'chain')).toContain('"sub"');
    } finally { unpin(); clearUserCredentialCache(); }
  });
});

describe('builder --model', () => {
  // INVARIANT: `lazy builder --model` on a tiered builder is refused like a
  // tiered task's --model — the proxy picks each request's model by tier.
  test('a model override on a tiered builder is refused', async () => {
    const { config } = await project(SUB_THEN_LOCAL);
    expect(() => assertNoModelOnTiered(config, config.models.roles.builder.profile, 'claude-opus-5-5')).toThrow(/is tiered/);
    expect(() => assertNoModelOnTiered(config, config.models.roles.builder.profile, undefined)).not.toThrow();
  });
});

describe('builder usage pause', () => {
  // INVARIANT: a tiered builder pauses on its TIERS, by the proxy's rule — a
  // full tier 1 with an always-available tier 2 does not pause it; judged on
  // tier 1's credential alone it would be refused while the proxy would serve.
  test('a full first tier does not pause a tiered builder, and the tier in use moves down', async () => {
    const { root, config } = await project(SUB_THEN_LOCAL);
    expect(await usagePauseBeside(root, config, null)).toBeNull();
    expect((await builderTierView(root, config)).now?.index).toBe(0);

    await fillTierOne(root, config);
    expect(await usagePauseBeside(root, config, null)).toBeNull();
    const view = await builderTierView(root, config);
    expect(view.now).toMatchObject({ index: 1, endpoint: 'local', model: 'qwen3-coder', allFull: false });
  });

  test('a tiered builder whose every tier is full is paused', async () => {
    const { root, config } = await project([
      '[endpoints.sub]', 'url = "https://api.anthropic.com"',
      'credential = "anthropic"',
      '[agents.chain]', 'harness = "claude-code"',
      'tiers = [{ endpoint = "sub", model = "claude-opus-5-5", threshold_percent = 90 }, { endpoint = "sub", model = "claude-sonnet-5-5", threshold_percent = 95 }]',
      '[models.roles.builder]', 'agent = "chain"',
    ]);
    await fillTierOne(root, config);
    const pause = await usagePauseBeside(root, config, null);
    expect(pause?.verdict).toBeTruthy();
  });
});

describe('builder tier surfaces', () => {
  // INVARIANT: the builder's surfaces say which tier is answering and when it
  // switched — a conversation that fell to a weaker model is visible.
  test('the line and the dashboard panel name the tier in use and the switch', async () => {
    const { root, config } = await project(SUB_THEN_LOCAL);
    await fillTierOne(root, config);
    recordBuilderTierSwitch({
      taskId: null, label: 'builder-x', profile: 'chain',
      from: { index: 0, endpoint: 'sub', model: 'claude-opus-5-5' },
      to: { index: 1, endpoint: 'local', model: 'qwen3-coder' },
      reason: 'tier 1 is over 90%', ts: Date.parse('2026-10-05T10:00:00Z'),
    } as never);
    const view = await builderTierView(root, config);
    const line = builderTierLine(view)!;
    expect(line).toContain('tier 2 of 2');
    expect(line).toContain('below tier 1 (claude-opus-5-5)');
    expect(line).toContain('switched 2026-10-05T10:00:00.000Z');
    const html = builderTierPanelHtml(view);
    expect(html).toContain('tier 2 of 2');
    expect(html).toContain('tier 1 (claude-opus-5-5) → tier 2 (qwen3-coder)');
  });

  // INVARIANT: an unreadable member binding cannot be displayed as an
  // answering builder; its payer's tier is unknown.
  test('team mode: the surfaces carry the refusal, not a tier in use', async () => {
    const base = await mkdtemp(join(tmpdir(), 'lazy-builder-tiered-base-'));
    roots.push(base);
    const unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
    try {
      const { root, config } = await project(SUB_THEN_LOCAL);
      await putUserCredential(root, { userId: 'alice@example.com', kind: 'api-key', token: 'sk-ant-api-alice' });
      const view = await builderTierView(root, config);
      expect(view.now).toBeNull();
      expect(builderTierLine(view)).toContain('member credential binding is unavailable');
      expect(builderTierPanelHtml(view)).toContain('member credential binding is unavailable');
      expect(builderTierPanelHtml(view)).not.toContain('Answering on');
    } finally {
      unpin();
      clearUserCredentialCache();
    }
  });

  test('an ordinary builder profile shows nothing', async () => {
    const { root, config } = await project(['[agent]', 'agent_id = "claude-code"']);
    const view = await builderTierView(root, config);
    expect(builderTierLine(view)).toBeNull();
    expect(builderTierPanelHtml(view)).toBe('');
  });
});
