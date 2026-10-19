import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader';
import { putUserCredential, clearUserCredentialCache } from '../../src/daemon/user-credentials';
import { bindTurnCredential, clearSessionCredentialCache } from '../../src/daemon/session-credentials';
import { resolveMemberCredential } from '../../src/proxy/credential-deps';
import { createLiveProxyRouting } from '../../src/daemon/live-proxy-routing';
import { buildTargetCredentials } from '../../src/proxy/credential-deps';
import { pinConfig } from '../helpers/pin-config';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

let root: string;
let undoConfig: (() => void) | undefined;
let undoBase: (() => void) | undefined;
afterEach(async () => {
  clearUserCredentialCache(); clearSessionCredentialCache();
  undoConfig?.(); undoBase?.();
  if (root) await rm(root, { recursive: true, force: true });
});

// INVARIANT: selected route and credential consent use one effective config snapshot. A second config read can authorize an upstream different from the one selected for the request.
test('the member resolver uses the route snapshot through a concurrent config edit', async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-route-snapshot-'));
  undoConfig = pinConfig(root);
  undoBase = pinDaemonBaseDir(join(root, 'daemon'));
  const path = join(root, 'lazy.toml');
  const configText = '[agents.gateway]\nharness = "claude-code"\nmodel = "m"\nendpoint = "https://old.example.com"\ncredential = "gateway"\n';
  await writeFile(path, configText);
  await putUserCredential(root, { userId: 'member@example.com', profile: 'gateway', endpoint: 'https://old.example.com', kind: 'api-key', token: 'own-gateway-secret' });
  await bindTurnCredential(root, { taskId: 'task', sessionId: 'session', ownerUserId: 'member@example.com', kind: 'api-key' });
  const snapshot = await loadConfig(root);
  const routing = await createLiveProxyRouting(root, snapshot, buildTargetCredentials(root, snapshot).targets);
  const selected = await routing();
  expect(selected.config).toBeDefined();
  await writeFile(path, configText.replace('old.example.com', 'new.example.com'));
  const grant = { token: 't', role: 'agent' as const, taskId: 'task', taskUuid: 'task', profile: 'gateway', label: 'task', envKey: 'ANTHROPIC_API_KEY', createdAt: '' };
  const oldRequest = await resolveMemberCredential(root, grant, 'https://old.example.com', { upstream: 'https://old.example.com', config: selected.config });
  expect(oldRequest?.outcome.kind).toBe('credential');
  const updated = await routing();
  const nextRequest = await resolveMemberCredential(root, grant, 'https://new.example.com', { upstream: 'https://new.example.com', config: updated.config });
  expect(nextRequest?.outcome.kind).toBe('missing');
});
