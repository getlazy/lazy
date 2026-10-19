import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from '../../src/config/loader';
import { agentProfilesFor } from '../../src/config/agent-profiles';
import { endpointRequirementsForProfile, credentialConsentedToEndpoint } from '../../src/credentials/endpoint-requirements';
import { memberEndpointCredentialFor, memberProfileCredentialProblem } from '../../src/daemon/member-credentials';
import { planTurnCredential, sideLaunchCredentialProblem, turnCredentialProblem } from '../../src/daemon/turn-credentials';
import { putEndpointCredential, setCredentialBillingMode, revokeEndpointCredential, storeRenewedEndpointCredential, getEndpointCredential, putUserCredential, clearUserCredentialCache, SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { bindTurnCredential, clearSessionCredentialCache, revokeTaskSessionBinding } from '../../src/daemon/session-credentials';
import { buildTargetCredentials, resolveMemberCredential } from '../../src/proxy/credential-deps';
import { memberEndpointUsageKey, daemonUsageLimits } from '../../src/proxy/usage-limits';
import { tierInUseNow, usagePauseBeside } from '../../src/daemon/usage-pause';
import { resetUsageReadingsForTest } from '../../src/daemon/usage-readings';
import { builderTierView, recordBuilderTierSwitch, resetBuilderTierHistory } from '../../src/daemon/builder-tier';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { Storage } from '../../src/storage/interface';
import { pinConfig } from '../helpers/pin-config';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const TOML = `
[endpoints.personal]
url = "https://api.anthropic.com"
credential = "anthropic"
[endpoints.work]
url = "https://api.anthropic.com"
credential = "anthropic"
[endpoints.free]
url = "http://localhost:11434"
credential = "none"
[agents.chain]
harness = "claude-code"
tiers = [{ endpoint = "personal", model = "claude-opus-5-5", threshold_percent = 90 }, { endpoint = "work", model = "claude-sonnet-5-5", threshold_percent = 95 }, { endpoint = "free", model = "qwen" }]
[models.roles.builder]
agent = "chain"
`;
let root: string;
let undoConfig: () => void;
let undoBase: () => void;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-endpoint-spending-'));
  await writeFile(join(root, 'lazy.toml'), TOML);
  undoConfig = pinConfig(root);
  undoBase = pinDaemonBaseDir(join(root, 'daemon'));
  clearUserCredentialCache(); clearSessionCredentialCache();
  await setCredentialBillingMode(root);
});
afterEach(async () => {
  resetUsageReadingsForTest(); resetBuilderTierHistory();
  clearUserCredentialCache(); clearSessionCredentialCache();
  undoConfig(); undoBase();
  await rm(root, { recursive: true, force: true });
});
async function connect(member: string, endpoint: string, secret = `${member}-${endpoint}`) {
  await putEndpointCredential(root, { userId: member, endpointId: endpoint, origin: 'https://api.anthropic.com', provider: 'anthropic', session: false, kind: 'api-key', token: secret });
}
function grant(role: 'agent' | 'builder' = 'agent', bindingKey = 'task'): CredentialGrant {
  return { token: 'placeholder', role, taskId: role === 'agent' ? bindingKey : null, label: `builder-${bindingKey}`, envKey: 'ANTHROPIC_API_KEY', profile: 'chain', createdAt: '', ...(role === 'agent' ? { taskUuid: bindingKey } : { bindingKey }) };
}
async function bind(member: string, key = 'task') {
  await bindTurnCredential(root, { taskId: key, sessionId: 'session', ownerUserId: member, kind: 'api-key' });
}

// INVARIANT: member endpoint credentials share the provider-host backstop with solo routing. Origin consent cannot authorize an implicitly selected provider credential on another host.
test('member tiers require explicit provider credentials at a gateway', async () => {
  const upstream = 'https://gateway.example';
  await writeFile(join(root, 'lazy.toml'), TOML.replace(
    '[endpoints.work]\nurl = "https://api.anthropic.com"\ncredential = "anthropic"',
    `[endpoints.work]\nurl = "${upstream}"\ncredential = "openai"`,
  ).replace(', threshold_percent = 95', ''));
  await putEndpointCredential(root, { userId: ALICE, endpointId: 'work', origin: upstream, provider: 'openai', kind: 'api-key', token: 'gateway-member-secret' });
  await bind(ALICE);
  const config = await loadConfig(root);
  const route = { endpoint: 'work', tier: 1, upstream, config };
  expect((await resolveMemberCredential(root, grant(), undefined, route))?.outcome.kind).toBe('credential');
  agentProfilesFor(config).get('chain')!.tiers![1]!.credentialExplicit = false;
  const refused = await resolveMemberCredential(root, grant(), undefined, route);
  expect(refused?.outcome).toMatchObject({ kind: 'missing', reason: expect.stringContaining('explicit endpoint credential') });
  expect(JSON.stringify(refused)).not.toContain('gateway-member-secret');
});

// INVARIANT: every paid tier must be connected before either a task or builder launches. A free first route cannot hide an unpaid later route.
test('task and builder gates refuse any missing paid endpoint and accept a complete chain', async () => {
  await connect(ALICE, 'personal');
  const task = { id: 'task', agent_id: 'chain' };
  const storage = { getTask: async () => task } as unknown as Storage;
  expect(await turnCredentialProblem(root, { taskId: task.id, storage, owner: ALICE })).toContain('"work"');
  expect(await sideLaunchCredentialProblem(root, ALICE, 'chain')).toContain('"work"');
  await expect(planTurnCredential(root, { taskId: 'builder', sessionId: 'builder', spender: { email: ALICE }, spenderProfile: 'chain' })).rejects.toThrow('"work"');
  await connect(BOB, 'work');
  expect(await sideLaunchCredentialProblem(root, ALICE, 'chain')).toContain('"work"');
  await connect(ALICE, 'work');
  expect(await turnCredentialProblem(root, { taskId: task.id, storage, owner: ALICE })).toBeNull();
  expect(await sideLaunchCredentialProblem(root, ALICE, 'chain')).toBeNull();
  expect(await planTurnCredential(root, { taskId: 'builder', sessionId: 'builder', spender: { email: ALICE }, spenderProfile: 'chain' })).toMatchObject({ mode: 'session', ownerUserId: ALICE });
  await writeFile(join(root, 'lazy.toml'), TOML.replace('endpoint = "personal", model = "claude-opus-5-5", threshold_percent = 90', 'endpoint = "free", model = "qwen-first"'));
  expect(await sideLaunchCredentialProblem(root, BOB, 'chain')).toBeNull();
  expect(await sideLaunchCredentialProblem(root, 'missing@example.com', 'chain')).toContain('"work"');
});

// INVARIANT: credential-free turns never need a paid account. Durable member mode still requires a live launch binding and strips auth.
test('an all-free service launch works without a service holder', async () => {
  await connect(ALICE, 'personal');
  await writeFile(join(root, 'lazy.toml'), TOML.replace(/tiers = .*\n/, 'tiers = [{ endpoint = "free", model = "qwen" }, { endpoint = "free", model = "qwen-other" }]\n'));
  const config = await loadConfig(root);
  const plan = await planTurnCredential(root, { taskId: 'free-builder', sessionId: 'free-builder', spenderProfile: 'chain' });
  expect(plan.mode).toBe('session');
  const resolution = await resolveMemberCredential(root, grant('builder', 'free-builder'), undefined, { endpoint: 'free', tier: 0, upstream: 'http://localhost:11434', config });
  expect(resolution).toMatchObject({ userId: null, endpoint: 'free', outcome: { kind: 'none' } });
});

// INVARIANT: named Anthropic endpoints are independent accounts even at the same origin. The legacy builtin slot never pays an explicit endpoint.
test('named slots do not borrow each other or builtin Claude credentials', async () => {
  await putUserCredential(root, { userId: ALICE, kind: 'api-key', token: 'builtin-secret' });
  const config = await loadConfig(root);
  const profile = agentProfilesFor(config).get('chain')!;
  expect(await memberProfileCredentialProblem(root, ALICE, profile, config)).toContain('"personal"');
  await connect(ALICE, 'personal');
  expect(await memberProfileCredentialProblem(root, ALICE, profile, config)).toContain('"work"');
  const map = buildTargetCredentials(root, config, true);
  expect((await map.targets.forTarget('https://api.anthropic.com')).kind).toBe('none');
});

// INVARIANT: destination consent and independent provider compatibility are both required. Matching consent alone never authorizes an Anthropic secret at a gateway.
test('origin changes refuse, a first-party path keeps consent, and Anthropic cannot reach a gateway', async () => {
  await connect(ALICE, 'personal');
  const config = await loadConfig(root);
  const requirement = endpointRequirementsForProfile(agentProfilesFor(config).get('chain')!, config)[0]!;
  expect((await memberEndpointCredentialFor(root, ALICE, requirement, 'https://api.anthropic.com/path')).kind).toBe('credential');
  expect((await memberEndpointCredentialFor(root, ALICE, requirement, 'https://elsewhere.example/path')).kind).toBe('missing');
  const gateway = { ...requirement, origin: 'https://gateway.example', scope: 'https://gateway.example', provider: 'gateway', credential: 'gateway' };
  await putEndpointCredential(root, { userId: ALICE, endpointId: 'personal', origin: gateway.origin, provider: 'anthropic', kind: 'api-key', token: 'provider-bound-secret' });
  const answer = await memberEndpointCredentialFor(root, ALICE, gateway);
  expect(answer).toMatchObject({ kind: 'missing' });
  if (answer.kind === 'missing') expect(answer.detail).toContain('Anthropic credential');
});

// INVARIANT: each request resolves the launch's bound payer and selected endpoint. Missing or revoked bindings never fall through to project credentials.
test('tasks and builders resolve their own selected accounts and refuse unbound grants', async () => {
  await connect(ALICE, 'personal'); await connect(ALICE, 'work');
  await connect(BOB, 'personal'); await connect(BOB, 'work');
  const config = await loadConfig(root);
  for (const role of ['agent', 'builder'] as const) {
    const g = grant(role);
    expect((await resolveMemberCredential(root, g))?.outcome.kind).toBe('missing');
    await bind(ALICE);
    const route = { upstream: 'https://api.anthropic.com', endpoint: 'work', tier: 1, config };
    const alice = await resolveMemberCredential(root, g, undefined, route);
    expect(alice).toMatchObject({ userId: ALICE, endpoint: 'work', outcome: { kind: 'credential', placement: { value: `${ALICE}-work` } } });
    await bind(BOB);
    expect(await resolveMemberCredential(root, g, undefined, route)).toMatchObject({ userId: BOB, outcome: { placement: { value: `${BOB}-work` } } });
    await revokeTaskSessionBinding(root, 'task');
    expect((await resolveMemberCredential(root, g, undefined, route))?.outcome.kind).toBe('missing');
  }
});

// INVARIANT: unattended work uses the service holder's own endpoint slots and shares that holder's usage with requested work.
test('service holder and member read the same endpoint usage without billing another member', async () => {
  await putUserCredential(root, { userId: SERVICE_CREDENTIAL_USER_ID, ownerEmail: ALICE, kind: 'api-key', token: 'service-marker' });
  await connect(ALICE, 'personal'); await connect(ALICE, 'work');
  await connect(BOB, 'personal'); await connect(BOB, 'work');
  const config = await loadConfig(root);
  const key = memberEndpointUsageKey(ALICE, 'personal');
  daemonUsageLimits.observeReading({ credential: key, ts: Date.now(), upstream: 'https://api.anthropic.com', backend: 'proxy', status: 200, taskId: null, model: null, headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.99', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600) } });
  expect((await tierInUseNow(root, config, 'chain', Date.now(), ALICE))?.tier.index).toBe(1);
  expect((await tierInUseNow(root, config, 'chain', Date.now(), SERVICE_CREDENTIAL_USER_ID))?.tier.index).toBe(1);
  expect((await tierInUseNow(root, config, 'chain', Date.now(), BOB))?.tier.index).toBe(0);
  expect(await usagePauseBeside(root, config, ALICE)).toBeNull();
  await bind(ALICE, 'alice-builder'); await bind(BOB, 'bob-builder');
  recordBuilderTierSwitch({ taskId: null, label: 'builder-alice-builder', profile: 'chain', from: null, to: { index: 1, endpoint: 'work', model: 'claude-sonnet-5-5' }, reason: 'Alice usage', allFull: false, crossed: false, thinkingDisabled: false, ts: Date.now() });
  const bob = await builderTierView(root, config, { label: 'builder-bob-builder' });
  expect(bob.now?.index).toBe(0); expect(bob.switches).toHaveLength(0);
  const alice = await builderTierView(root, config, { label: 'builder-alice-builder' });
  expect(alice.now?.index).toBe(1); expect(alice.switches).toHaveLength(1);
});

// INVARIANT: replacement and origin changes clear an endpoint's quota; renewal and identical provisioning preserve it. A renewed secret must not be overwritten by the old push.
test('credential mutation clears usage only when the connected account changes', async () => {
  const input = { userId: ALICE, endpointId: 'personal', origin: 'https://api.anthropic.com', provider: 'anthropic', kind: 'api-key' as const, token: 'original', renewable: true };
  await putEndpointCredential(root, input);
  const key = memberEndpointUsageKey(ALICE, 'personal');
  const fill = () => daemonUsageLimits.observeReading({ credential: key, ts: Date.now(), upstream: input.origin, backend: 'proxy', status: 200, taskId: null, model: null, headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.99' } });
  fill();
  expect(await storeRenewedEndpointCredential(root, ALICE, 'personal', 'renewed', 'original')).toBe(true);
  expect(daemonUsageLimits.reading(key)).not.toBeNull();
  await putEndpointCredential(root, input);
  expect((await getEndpointCredential(root, ALICE, 'personal'))?.token).toBe('renewed');
  expect(daemonUsageLimits.reading(key)).not.toBeNull();
  await putEndpointCredential(root, { ...input, token: 'replacement' });
  expect(daemonUsageLimits.reading(key)).toBeNull();
  fill();
  await putEndpointCredential(root, { ...input, token: 'replacement', origin: 'https://elsewhere.example' });
  expect(daemonUsageLimits.reading(key)).toBeNull();
  fill(); await revokeEndpointCredential(root, ALICE, 'personal');
  expect(daemonUsageLimits.reading(key)).toBeNull();
});

// INVARIANT: old user-only readings remain history, never the active quota for a member endpoint. Unknown fresh endpoint usage is available.
test('legacy user-only usage does not select a lower tier', async () => {
  await connect(ALICE, 'personal'); await connect(ALICE, 'work');
  const config = await loadConfig(root);
  daemonUsageLimits.observeReading({ credential: `user:${ALICE}`, ts: Date.now(), upstream: 'https://api.anthropic.com', backend: 'proxy', status: 200, taskId: null, model: null, headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.99', 'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600) } });
  expect((await tierInUseNow(root, config, 'chain', Date.now(), ALICE))?.tier.index).toBe(0);
});

// INVARIANT: a service refusal names WHICH of its causes holds — no holder
// delivered, holders conflicting, or a holder without this endpoint — and that
// the turn is the service holder's because lazy started it. Every cause used to
// read alike, and a member who had just started the work on their own
// connection could not tell why theirs was not used (field report 2026-10-06).
test('service refusals name the real cause, and a person asking on the same profile is billed instead', async () => {
  const task = { id: 'task', agent_id: 'chain' };
  const storage = { getTask: async () => task } as unknown as Storage;
  const config = await loadConfig(root);
  const chain = agentProfilesFor(config).get('chain')!;
  await connect(ALICE, 'personal'); await connect(ALICE, 'work');

  const none = await memberProfileCredentialProblem(root, SERVICE_CREDENTIAL_USER_ID, chain, config);
  expect(none).toStartWith('No service credential for automated turns "personal"');
  expect(none).toContain('no admin has designated one');
  expect(none).toContain('Teams could not deliver');
  expect(none).toContain('Nobody asked for this turn');
  // The person who asked is billed on their own connections, whatever the service holder's state.
  expect(await turnCredentialProblem(root, { taskId: task.id, storage, owner: ALICE })).toBeNull();

  await putEndpointCredential(root, { userId: SERVICE_CREDENTIAL_USER_ID, endpointId: 'personal', origin: 'https://api.anthropic.com', provider: 'anthropic', kind: 'api-key', token: 'svc', ownerEmail: BOB });
  const holderless = await memberProfileCredentialProblem(root, SERVICE_CREDENTIAL_USER_ID, chain, config);
  expect(holderless).toContain(`the service holder ${BOB} has no`);
  expect(holderless).toContain('"personal"');

  await putEndpointCredential(root, { userId: SERVICE_CREDENTIAL_USER_ID, endpointId: 'work', origin: 'https://api.anthropic.com', provider: 'anthropic', kind: 'api-key', token: 'svc2', ownerEmail: ALICE });
  expect(await memberProfileCredentialProblem(root, SERVICE_CREDENTIAL_USER_ID, chain, config)).toContain('name different holders');

  await revokeEndpointCredential(root, SERVICE_CREDENTIAL_USER_ID, 'personal');
  await putEndpointCredential(root, { userId: SERVICE_CREDENTIAL_USER_ID, endpointId: 'personal', origin: 'https://api.anthropic.com', provider: 'anthropic', kind: 'api-key', token: 'svc', ownerEmail: ALICE });
  expect(await memberProfileCredentialProblem(root, SERVICE_CREDENTIAL_USER_ID, chain, config)).toBeNull();
});

// INVARIANT: a turn a task's agent launches on its subtask (lazy_start,
// unblock, resume, ask, review) is owned by and billed to whoever asked for the
// agent's OWN turn, read from the parent's session — and a parent turn nobody
// asked for makes the child a system turn. Every agent-launched turn used to
// run ownerless, so on a managed host a member's task starting a subtask was
// billed to the service holder and refused (field report 2026-10-06).
test('a subtask an agent launches bills the parent turn owner, or the service holder when nobody asked', async () => {
  const { agentLaunchOwnerRequest } = await import('../../src/daemon/mcp-routes');
  const { runAsTurnOwnerRequest } = await import('../../src/daemon/turn-owner');
  const parent = { id: 'parent-uuid', agent_id: 'chain' };
  const child = { id: 'child-uuid', agent_id: 'chain' };
  const tasks: Record<string, typeof parent> = { [parent.id]: parent, [child.id]: child, child };
  const storage = {
    getTask: async (id: string) => tasks[id] ?? null,
    resolveTask: async (ref: string) => ({ task: tasks[ref] ?? null }),
  } as unknown as Storage;
  await connect(ALICE, 'personal'); await connect(ALICE, 'work');
  // Managed mode only decides spendability here; billing reads team mode.
  const managed = async <T>(fn: () => Promise<T>) => {
    const prev = process.env.LAZY_MANAGED;
    process.env.LAZY_MANAGED = '1';
    try { return await fn(); } finally { if (prev === undefined) delete process.env.LAZY_MANAGED; else process.env.LAZY_MANAGED = prev; }
  };
  {
    const request = await managed(() => agentLaunchOwnerRequest(storage, parent.id, 'lazy_start', { task_id: 'child' }, { email: ALICE }));
    expect(request).toEqual({ taskId: child.id, owner: { email: ALICE, spendable: true } });
    expect(await runAsTurnOwnerRequest(request!, () => turnCredentialProblem(root, { taskId: child.id, storage }))).toBeNull();

    // System-owned parent turn: no owner, so the child goes to the service holder.
    expect(await agentLaunchOwnerRequest(storage, parent.id, 'lazy_start', { task_id: 'child' }, null)).toBeNull();
    const { runWithLaunchOrigin } = await import('../../src/daemon/launch-origin');
    const refused = await runWithLaunchOrigin({ kind: 'agent', parentTask: 'parent-task' }, () => turnCredentialProblem(root, { taskId: child.id, storage }));
    expect(refused).toStartWith('No service credential for automated turns');
    // The refusal names the real trigger, not every way a turn can be automated.
    expect(refused).toContain("Task parent-task's agent started this turn during a turn nobody asked for");
    expect(await runWithLaunchOrigin({ kind: 'builder' }, () => turnCredentialProblem(root, { taskId: child.id, storage }))).toContain('The builder started this turn');
    await putEndpointCredential(root, { userId: SERVICE_CREDENTIAL_USER_ID, endpointId: 'personal', origin: 'https://api.anthropic.com', provider: 'anthropic', kind: 'api-key', token: 'svc', ownerEmail: BOB });
    await connect(BOB, 'personal'); await connect(BOB, 'work');
    expect(await turnCredentialProblem(root, { taskId: child.id, storage })).toBeNull();

    // Non-launching tools carry no owner.
    expect(await agentLaunchOwnerRequest(storage, parent.id, 'lazy_show', { task_id: 'child' }, { email: ALICE })).toBeNull();
  }
  // On a laptop the parent's owner is the git identity: attributed, never spent.
  expect((await agentLaunchOwnerRequest(storage, parent.id, 'lazy_unblock', { task_id: 'child' }, { email: ALICE }))?.owner.spendable).toBe(false);
});

// INVARIANT: a subtask start held by the usage pause is replayed under the
// owner it was asked with. The replay runs outside every request, so a held
// start that lost its owner would be billed to the service holder.
test('a held subtask start replays under the owner it was held with', async () => {
  const { processUsagePauseHolds } = await import('../../src/daemon/usage-pause');
  const { getPendingTurnOwner } = await import('../../src/daemon/turn-owner');
  const { USAGE_PAUSE_PENDING_START_KEY } = await import('../../src/usage-pause/hold');
  const owner = { email: ALICE, spendable: true };
  const child = { id: 'child-uuid', status: 'backlog', agent_id: 'chain', target: { kind: 'branch', branch: 'main' }, metadata: { [USAGE_PAUSE_PENDING_START_KEY]: JSON.stringify({ requestedAt: 1, params: {}, owner }) } };
  const storage = {
    listTasks: async () => [child],
    getTask: async () => null,
    updateTaskMetadata: async () => {},
  } as unknown as Storage;
  let seen: unknown = 'not launched';
  await processUsagePauseHolds(root, storage, undefined, async (task) => { seen = getPendingTurnOwner(task.id); return 'started'; });
  expect(seen).toEqual(owner);
});

// INVARIANT: a held start's reset is judged on the window of the person it was
// held for, not the service holder's. Judged outside the owner, a paused owner's
// start was replayed (and re-held) every tick while the service holder was free.
test('a held subtask start waits for its owner window, whatever the service holder reads', async () => {
  await writeFile(join(root, 'lazy.toml'), `${TOML}\n[agents.solo]\nharness = "claude-code"\nmodel = "claude-opus-5-5"\nendpoint = "https://api.anthropic.com"\ncredential = "anthropic"\n\n[usage_pause]\nthreshold_percent = 90\n`);
  const EP = 'profile:solo';
  const { processUsagePauseHolds } = await import('../../src/daemon/usage-pause');
  const { USAGE_PAUSE_PENDING_START_KEY } = await import('../../src/usage-pause/hold');
  await connect(ALICE, EP); await connect(BOB, EP);
  await putEndpointCredential(root, { userId: SERVICE_CREDENTIAL_USER_ID, endpointId: EP, origin: 'https://api.anthropic.com', provider: 'anthropic', kind: 'api-key', token: 'svc', ownerEmail: BOB });
  const reading = (member: string, used: string) => daemonUsageLimits.observeReading({ credential: memberEndpointUsageKey(member, EP), ts: Date.now(), upstream: 'https://api.anthropic.com', backend: 'proxy', status: 200, taskId: null, model: null, headers: { 'anthropic-ratelimit-unified-5h-utilization': used, 'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600) } });
  reading(ALICE, '0.99'); reading(BOB, '0.10');
  const child = { id: 'child-uuid', status: 'backlog', agent_id: 'solo', target: { kind: 'branch', branch: 'main' }, metadata: { [USAGE_PAUSE_PENDING_START_KEY]: JSON.stringify({ requestedAt: 1, params: {}, owner: { email: ALICE, spendable: true } }) } };
  const storage = { listTasks: async () => [child], getTask: async () => null, updateTaskMetadata: async () => {} } as unknown as Storage;
  let launches = 0;
  const launch = async () => { launches++; return 'started' as const; };
  await processUsagePauseHolds(root, storage, undefined, launch);
  expect(launches).toBe(0);
  reading(ALICE, '0.10');
  await processUsagePauseHolds(root, storage, undefined, launch);
  expect(launches).toBe(1);
});

// INVARIANT: a task a member's builder session starts or unblocks is that
// member's turn, billed to them — resolved from the builder session record the
// MCP token's label names, never a request field. Builder launches used to run
// ownerless and bill (or be refused for) the service holder.
test("a member's builder launch bills that member, and only in managed mode", async () => {
  const { builderLaunchOwnerRequest } = await import('../../src/daemon/mcp-routes');
  const { runAsTurnOwnerRequest } = await import('../../src/daemon/turn-owner');
  const child = { id: 'child-uuid', agent_id: 'chain' };
  const sessions = [
    { builderId: 'b1', state: 'running', memberEmail: ALICE },
    { builderId: 'b2', state: 'ended', memberEmail: BOB },
  ];
  const storage = {
    getTask: async (id: string) => (id === child.id ? child : null),
    resolveTask: async (ref: string) => ({ task: ref === 'child' || ref === child.id ? child : null }),
    listBuilderSessions: async () => sessions,
  } as unknown as Storage;
  await connect(ALICE, 'personal'); await connect(ALICE, 'work');
  const prev = process.env.LAZY_MANAGED;
  process.env.LAZY_MANAGED = '1';
  let request, ended, unknown, nonLaunch;
  try {
    request = await builderLaunchOwnerRequest(storage, root, 'lazy_start', { task_id: 'child' }, 'builder-b1');
    ended = await builderLaunchOwnerRequest(storage, root, 'lazy_start', { task_id: 'child' }, 'builder-b2');
    unknown = await builderLaunchOwnerRequest(storage, root, 'lazy_start', { task_id: 'child' }, 'builder-nope');
    nonLaunch = await builderLaunchOwnerRequest(storage, root, 'lazy_show', { task_id: 'child' }, 'builder-b1');
  } finally {
    if (prev === undefined) delete process.env.LAZY_MANAGED; else process.env.LAZY_MANAGED = prev;
  }
  expect(request).toEqual({ taskId: child.id, owner: { email: ALICE, spendable: true } });
  expect(await runAsTurnOwnerRequest(request!, () => turnCredentialProblem(root, { taskId: child.id, storage }))).toBeNull();
  expect(ended).toBeNull();
  expect(unknown).toBeNull();
  expect(nonLaunch).toBeNull();
  // On a laptop the builder keeps running on the daemon's own credential.
  expect(await builderLaunchOwnerRequest(storage, root, 'lazy_start', { task_id: 'child' }, 'builder-b1')).toBeNull();
});

// INVARIANT: off a built-in provider's own origin, consent names origin AND
// path. On a path-routed shared gateway one host serves many accounts by path,
// so a key consented for one account's path must never be sent to another's —
// and consent recorded before it carried a path covers only a pathless
// destination (the conservative migration).
test('gateway consent is bound to its path', async () => {
  const config = await loadConfig(root);
  const base = endpointRequirementsForProfile(agentProfilesFor(config).get('chain')!, config)[0]!;
  const teamA = { ...base, origin: 'https://gw.example', scope: 'https://gw.example/v1/acct-a', provider: 'anthropic' };
  const teamB = { ...teamA, scope: 'https://gw.example/v1/acct-b' };
  expect(credentialConsentedToEndpoint({ endpoint: 'https://gw.example/v1/acct-a/' }, teamA)).toBe(true);
  expect(credentialConsentedToEndpoint({ endpoint: 'https://gw.example/v1/acct-a' }, teamB)).toBe(false);
  expect(credentialConsentedToEndpoint({ endpoint: 'https://gw.example' }, teamA)).toBe(false);
  expect(credentialConsentedToEndpoint({ endpoint: 'https://gw.example' }, { ...teamA, scope: 'https://gw.example' })).toBe(true);
});
