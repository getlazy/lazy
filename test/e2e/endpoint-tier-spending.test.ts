/** Live fake-upstream requests exercise the production member resolver for task and builder grants. */
import { beforeEach, afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from '../../src/config/loader';
import { agentUpstreamMap } from '../../src/proxy/agent-upstreams';
import { createProxyServer } from '../../src/proxy/server';
import { buildProxyCredentialDeps } from '../../src/proxy/credential-deps';
import { mintCredentialGrant, clearCredentialGrantCache } from '../../src/proxy/credential-broker';
import { putEndpointCredential, revokeEndpointCredential, setCredentialBillingMode, clearUserCredentialCache } from '../../src/daemon/user-credentials';
import { bindTurnCredential, clearSessionCredentialCache } from '../../src/daemon/session-credentials';
import { UsageLimitTracker, memberEndpointUsageKey } from '../../src/proxy/usage-limits';
import { TierRefusals } from '../../src/proxy/tier-select';
import type { ProxyAuditRecord } from '../../src/storage/types';
import { pinConfig } from '../helpers/pin-config';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

let root: string;
let undoConfig: () => void;
let undoBase: () => void;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
let hits: Array<{ endpoint: string; auth: string | null; alternate: string | null; model: unknown }>;
const refusing = new Set<string>();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-member-tiers-live-'));
  undoConfig = pinConfig(root); undoBase = pinDaemonBaseDir(join(root, 'daemon'));
  hits = []; clearUserCredentialCache(); clearSessionCredentialCache(); clearCredentialGrantCache();
  refusing.clear();
});
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  clearUserCredentialCache(); clearSessionCredentialCache(); clearCredentialGrantCache();
  undoConfig(); undoBase(); await rm(root, { recursive: true, force: true });
});
function upstream(endpoint: string, full = false) {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    const body = await req.json() as { model?: unknown };
    hits.push({ endpoint, auth: req.headers.get('x-api-key'), alternate: req.headers.get('authorization'), model: body.model });
    if (refusing.has(endpoint)) return Response.json({ type: 'error', error: { type: 'rate_limit_error' } },
      { status: 429, headers: { 'retry-after': '60' } });
    return Response.json({ type: 'message', content: [] }, { headers: full ? {
      'anthropic-ratelimit-unified-5h-utilization': '0.99',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
    } : {} });
  } });
  servers.push(server); return `http://127.0.0.1:${server.port}`;
}

// INVARIANT: task and builder tier switches use the bound member's selected endpoint account on each request. Another member's usage cannot change their route; free tiers carry no auth.
for (const role of ['agent', 'builder'] as const) test(`${role}: switch paid endpoints mid-turn, then serve a free tier without auth`, async () => {
  const first = upstream('first', true); const second = upstream('second', true); const free = upstream('free');
  await writeFile(join(root, 'lazy.toml'), `
[endpoints.first]
url = "${first}"
credential = "first-key"
[endpoints.second]
url = "${second}"
credential = "second-key"
[endpoints.free]
url = "${free}"
credential = "none"
[agents.chain]
harness = "claude-code"
tiers = [{ endpoint = "first", model = "first-model" }, { endpoint = "second", model = "second-model" }, { endpoint = "free", model = "free-model" }]
`);
  await setCredentialBillingMode(root);
  const config = await loadConfig(root);
  for (const member of ['alice@example.com', 'bob@example.com']) {
    for (const [endpoint, origin] of [['first', first], ['second', second]]) {
      await putEndpointCredential(root, { userId: member, endpointId: endpoint!, origin: origin!, provider: `${endpoint}-key`, kind: 'api-key', token: `${member}-${endpoint}` });
    }
  }
  const bindingKey = 'launch';
  await bindTurnCredential(root, { taskId: bindingKey, sessionId: 'session', ownerUserId: 'alice@example.com', kind: 'api-key' });
  const grant = await mintCredentialGrant(root, { role, taskId: role === 'agent' ? 'task' : null, label: 'builder-launch', envKey: 'ANTHROPIC_API_KEY', profile: 'chain', ...(role === 'agent' ? { taskUuid: bindingKey } : { bindingKey }) });
  const deps = buildProxyCredentialDeps(root, config, true);
  const routes = agentUpstreamMap(config);
  // Generic test upstreams supply real subscription headers. Describe that
  // provider capability at the external boundary; all credential checks stay real.
  for (const tier of routes.chain!.tiers!) if (tier.endpoint !== 'free') { tier.usage = 'claude'; tier.threshold = 90; }
  const tracker = new UsageLimitTracker();
  const records: ProxyAuditRecord[] = [];
  const proxy = createProxyServer({ port: 0, bind: '127.0.0.1', upstream: first, fallbacks: [], retryAfterThreshold: 0,
    liveAgentRouting: async () => ({ config, routes, targets: deps.targets, profiles: new Set(['chain']) }),
  }, { append: async r => { records.push(r); } }, deps, { usageLimits: tracker, tierRefusals: new TierRefusals() });
  servers.push(proxy);
  async function send(status = 200) {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': grant, authorization: 'Bearer unrelated-client-auth' }, body: JSON.stringify({ model: 'first-model', messages: [] }) });
    await response.text(); expect(response.status).toBe(status);
  }
  await send(); await send(); await send();
  expect(hits).toEqual([
    { endpoint: 'first', auth: 'alice@example.com-first', alternate: null, model: 'first-model' },
    { endpoint: 'second', auth: 'alice@example.com-second', alternate: null, model: 'second-model' },
    { endpoint: 'free', auth: null, alternate: null, model: 'free-model' },
  ]);
  expect(tracker.reading(memberEndpointUsageKey('alice@example.com', 'first'))).not.toBeNull();
  expect(tracker.reading(memberEndpointUsageKey('alice@example.com', 'second'))).not.toBeNull();
  await bindTurnCredential(root, { taskId: bindingKey, sessionId: 'session', ownerUserId: 'bob@example.com', kind: 'api-key' });
  await send();
  expect(hits.at(-1)).toMatchObject({ endpoint: 'first', auth: 'bob@example.com-first' });
  for (const tier of routes.chain!.tiers!) { tier.usage = null; tier.threshold = null; }
  await bindTurnCredential(root, { taskId: bindingKey, sessionId: 'session', ownerUserId: 'alice@example.com', kind: 'api-key' });
  refusing.add('first');
  const beforeRetry = hits.length;
  await send();
  expect(hits.slice(beforeRetry)).toMatchObject([
    { endpoint: 'first', auth: 'alice@example.com-first' },
    { endpoint: 'second', auth: 'alice@example.com-second' },
  ]);
  refusing.clear();
  await bindTurnCredential(root, { taskId: bindingKey, sessionId: 'session', ownerUserId: 'bob@example.com', kind: 'api-key' });
  await send();
  expect(hits.at(-1)).toMatchObject({ endpoint: 'first', auth: 'bob@example.com-first' });
  await bindTurnCredential(root, { taskId: bindingKey, sessionId: 'session', ownerUserId: 'alice@example.com', kind: 'api-key' });
  await send();
  expect(hits.at(-1)).toMatchObject({ endpoint: 'second', auth: 'alice@example.com-second' });
  // Even the last connection's removal leaves durable member billing active.
  // The running grant cannot fall back to a project or process credential.
  for (const member of ['alice@example.com', 'bob@example.com']) for (const endpoint of ['first', 'second']) await revokeEndpointCredential(root, member, endpoint);
  const hitCount = hits.length;
  await send(401);
  expect(hits).toHaveLength(hitCount);
  const deadline = Date.now() + 2000;
  while (!records.some(r => r.userId === 'alice@example.com') && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  expect(records.some(r => r.userId === 'alice@example.com')).toBe(true);
}, 30_000);
