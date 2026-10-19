import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { initDaemonStorage, getOrCreateStorage, closeAllStorage, handleRpc } from '../../src/daemon/rpc-handlers';
import { clearUserCredentialCache, putEndpointCredential, setCredentialBillingMode } from '../../src/daemon/user-credentials';
import { bindTurnCredential, clearSessionCredentialCache } from '../../src/daemon/session-credentials';
import { recordBuilderTierSwitch, resetBuilderTierHistory, type BuilderTierView } from '../../src/daemon/builder-tier';
import { daemonUsageLimits, memberEndpointUsageKey } from '../../src/proxy/usage-limits';
import { resetUsageReadingsForTest } from '../../src/daemon/usage-readings';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { pinConfig } from '../helpers/pin-config';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

enableInProcessTestMode();
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
let root: string;
let unpin: () => void;
let unpinBase: () => void;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-builder-tier-scope-'));
  await writeFile(join(root, 'lazy.toml'), `
[storage]
backend = "external"
external_path = "${join(root, 'store')}"
[endpoints.paid]
url = "https://api.anthropic.com"
credential = "anthropic"
[endpoints.free]
url = "http://localhost:11434"
credential = "none"
[agents.chain]
harness = "claude-code"
tiers = [{ endpoint = "paid", model = "claude-opus-5-5", threshold_percent = 90 }, { endpoint = "free", model = "qwen" }]
[models.roles.builder]
agent = "chain"
`);
  unpin = pinConfig(root);
  unpinBase = pinDaemonBaseDir(join(root, 'daemon'));
  clearUserCredentialCache(); clearSessionCredentialCache();
  await setCredentialBillingMode(root);
  for (const member of [ALICE, BOB]) await putEndpointCredential(root, { userId: member, endpointId: 'paid', origin: 'https://api.anthropic.com', provider: 'anthropic', kind: 'api-key', token: `${member}-secret` });
  initDaemonStorage(root);
  const storage = await getOrCreateStorage();
  await storage.createBuilderSession({ id: 'alice-session', projectRoot: root, memberEmail: ALICE, kind: 'interactive', state: 'running', builderId: 'alice-run', containerName: null, agentSessionId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), endedAt: null });
  await bindTurnCredential(root, { taskId: 'alice-run', sessionId: 'alice-session', ownerUserId: ALICE, kind: 'api-key' });
  daemonUsageLimits.observeReading({ credential: memberEndpointUsageKey(ALICE, 'paid'), ts: Date.now(), upstream: 'https://api.anthropic.com', backend: 'proxy', status: 200, taskId: null, model: null, headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.99', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600) } });
  recordBuilderTierSwitch({ taskId: null, profile: 'chain', bindingKey: 'alice-run', label: 'member-builder:alice-run', from: null, to: { index: 1, endpoint: 'free', model: 'qwen' }, reason: 'Alice quota', allFull: false, crossed: true, thinkingDisabled: false, ts: Date.now() });
});
afterEach(async () => {
  await closeAllStorage();
  resetUsageReadingsForTest(); resetBuilderTierHistory();
  clearUserCredentialCache(); clearSessionCredentialCache();
  unpin(); unpinBase();
  await rm(root, { recursive: true, force: true });
});

// INVARIANT: a builder session's tier and history belong to its authorized member. Control may inspect it, but another member learns neither its existence nor usage.
test('builderTier RPC scopes explicit sessions through the existing member read guard', async () => {
  for (const caller of [{ kind: 'user', email: ALICE, name: 'Alice' }, { kind: 'control' }] as const) {
    const view = await handleRpc('builderTier', root, { builderSessionId: 'alice-session' }, undefined, caller) as BuilderTierView;
    expect(view.now?.index).toBe(1);
    expect(view.switches).toHaveLength(1);
    expect(view.switches[0]?.reason).toBe('Alice quota');
  }
  await expect(handleRpc('builderTier', root, { builderSessionId: 'alice-session' }, undefined, { kind: 'user', email: BOB, name: 'Bob' })).rejects.toThrow('Builder session not found');
});

// INVARIANT: a member's generic tier read uses that authenticated member's endpoint usage. It never inherits another builder's switch history.
test('generic member reads use their own quota without another session history', async () => {
  const view = await handleRpc('builderTier', root, {}, undefined, { kind: 'user', email: BOB, name: 'Bob' }) as BuilderTierView;
  expect(view.now?.index).toBe(0);
  expect(view.switches).toHaveLength(0);
});
