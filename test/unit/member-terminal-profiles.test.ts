import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { clearDaemonContext, setDaemonContext } from '../../src/daemon/context';
import { putEndpointCredential, putUserCredential, revokeEndpointCredential, clearUserCredentialCache, setCredentialBillingMode } from '../../src/daemon/user-credentials';
import { createSessionCredentialResolver } from '../../src/daemon/turn-credentials';
import { clearSessionCredentialCache, getTaskSessionBinding } from '../../src/daemon/session-credentials';
import { clearCredentialGrantCache, lookupCredentialGrant, grantAcceptsPeer } from '../../src/proxy/credential-broker';
import { resolveMemberCredential } from '../../src/proxy/credential-deps';
import { memberContainerProfileEnv, memberTerminalCredentialProblem, planMemberContainerCredential } from '../../src/server/member-exec-credential';

let root: string;
let base: string;
let unpin: () => void;
let oldTest: string | undefined;
const ALICE = 'alice@example.com';
const CONFIG = `
[endpoints.first]
url = "https://first.example.com"
credential = "first-key"
[endpoints.later]
url = "https://later.example.com"
credential = "later-key"
[agents.pinned]
harness = "claude-code"
model = "pinned-model"
named_endpoint = "later"
[agents.chain]
harness = "claude-code"
tiers = [{ endpoint = "first", model = "first-model" }, { endpoint = "later", model = "later-model" }]
`;

beforeEach(async () => {
  oldTest = process.env.LAZY_TEST;
  process.env.LAZY_TEST = '1';
  root = await mkdtemp(join(tmpdir(), 'member-profiles-'));
  base = await mkdtemp(join(tmpdir(), 'member-profiles-daemon-'));
  unpin = pinDaemonBaseDir(base);
  setDaemonContext({ webPort: 26025, proxyPort: 26026, token: 'unit-control' });
  await writeFile(join(root, 'lazy.toml'), CONFIG);
  clearUserCredentialCache();
  clearSessionCredentialCache();
  clearCredentialGrantCache();
  await setCredentialBillingMode(root);
});

afterEach(async () => {
  clearDaemonContext();
  clearUserCredentialCache();
  clearSessionCredentialCache();
  clearCredentialGrantCache();
  unpin();
  if (oldTest === undefined) delete process.env.LAZY_TEST;
  else process.env.LAZY_TEST = oldTest;
  await rm(root, { recursive: true, force: true });
  await rm(base, { recursive: true, force: true });
});

async function connect(email: string, endpoint: 'first' | 'later') {
  await putEndpointCredential(root, {
    userId: email, endpointId: endpoint, origin: `https://${endpoint}.example.com`,
    provider: `${endpoint}-key`, kind: 'api-key', token: `${email}-${endpoint}-secret`,
  });
}

for (const profile of ['pinned', 'chain']) {
  // INVARIANT: a terminal uses the task's Claude profile and the attaching
  // member's endpoint connections. A live task or another member cannot pay it.
  test(`${profile}: grants name the task profile, a private binding, and only the member's endpoint keys`, async () => {
    for (const endpoint of ['first', 'later'] as const) {
      await connect(ALICE, endpoint);
      await connect('bob@example.com', endpoint);
    }
    const planned = await planMemberContainerCredential({ root, taskId: 'task-1', sessionId: 's1', memberEmail: ALICE, container: 'member-1', profile });
    if (!planned.ok) throw new Error(planned.message);
    try {
      const token = planned.credential.env.find(v => v.key === 'ANTHROPIC_AUTH_TOKEN')!.value;
      expect(JSON.stringify(planned.credential.env)).not.toContain('secret');
      const grant = await lookupCredentialGrant(root, token);
      expect(grant?.profile).toBe(profile);
      expect(grant?.bindingKey).toBe(planned.credential.key);
      expect(await getTaskSessionBinding(root, 'task-1')).toBeNull();
      expect((await getTaskSessionBinding(root, grant!.bindingKey!))?.ownerUserId).toBe(ALICE);
      const route = profile === 'chain' ? { endpoint: 'later', tier: 1 } : {};
      const answer = await resolveMemberCredential(root, grant!, '', { upstream: 'https://later.example.com', ...route });
      expect(answer?.userId).toBe(ALICE);
      expect(answer?.outcome).toMatchObject({ kind: 'credential', placement: { value: `${ALICE}-later-secret` } });
      await planned.credential.pinOrigin('172.19.0.2');
      const pinned = (await lookupCredentialGrant(root, token))!;
      expect(grantAcceptsPeer(pinned, '172.19.0.2')).toBe(true);
      expect(grantAcceptsPeer(pinned, '172.19.0.3')).toBe(false);
      await planned.credential.release();
      expect(await lookupCredentialGrant(root, token)).toBeNull();
      expect((await resolveMemberCredential(root, grant!, '', { upstream: 'https://later.example.com', ...route }))?.outcome.kind).toBe('missing');
    } finally { await planned.credential.release(); }
  });
}

// INVARIANT: discovery names the same missing endpoint as launch; another
// member's connection never admits the caller and no binding is allocated.
test('missing endpoint names the connection and where to connect it', async () => {
  await connect('bob@example.com', 'later');
  const problem = await memberTerminalCredentialProblem(root, ALICE, 'pinned');
  expect(problem).toContain('endpoint "later"');
  expect(problem).toContain('Connections (account, team, or project)');
  const planned = await planMemberContainerCredential({ root, taskId: 'task-1', sessionId: 's1', memberEmail: ALICE, container: 'member-1', profile: 'pinned' });
  expect(planned).toEqual({ ok: false, status: 400, message: problem! });
});

// INVARIANT: a new conversation uses the current task profile even when its
// member container predates a profile change; its existing payer stays fixed.
test('a reused container receives the new profile grant without replacing its binding', async () => {
  await connect(ALICE, 'first');
  await connect(ALICE, 'later');
  const planned = await planMemberContainerCredential({ root, taskId: 'task-1', sessionId: 's1', memberEmail: ALICE, container: 'member-1', profile: 'pinned' });
  if (!planned.ok) throw new Error(planned.message);
  try {
    await planned.credential.pinOrigin('172.19.0.2');
    const before = await getTaskSessionBinding(root, planned.credential.key!);
    const env = await memberContainerProfileEnv({ root, taskId: 'task-1', memberEmail: ALICE, container: 'member-1', key: planned.credential.key!, profile: 'chain' });
    const grant = (await lookupCredentialGrant(root, env.find(e => e.startsWith('ANTHROPIC_AUTH_TOKEN='))!.slice('ANTHROPIC_AUTH_TOKEN='.length)))!;
    expect(grant.profile).toBe('chain');
    expect(grant.bindingKey).toBe(planned.credential.key);
    expect(grantAcceptsPeer(grant, '172.19.0.2')).toBe(true);
    expect(grantAcceptsPeer(grant, '172.19.0.3')).toBe(false);
    expect(await getTaskSessionBinding(root, planned.credential.key!)).toEqual(before);
    await connect('bob@example.com', 'first');
    await connect('bob@example.com', 'later');
    await expect(memberContainerProfileEnv({ root, taskId: 'task-1', memberEmail: 'bob@example.com', container: 'member-1', key: planned.credential.key!, profile: 'chain' })).rejects.toThrow('no longer active');
  } finally { await planned.credential.release(); }
});

// INVARIANT: refreshing a terminal chooses the CURRENT profile connection's
// auth form while retaining its payer, token and existing conversations.
test('a gateway API-key container can start an Anthropic OAuth conversation', async () => {
  await connect(ALICE, 'later');
  await putUserCredential(root, { userId: ALICE, kind: 'oauth', token: 'alice-oauth-secret' });
  const planned = await planMemberContainerCredential({ root, taskId: 'task-1', sessionId: 's1', memberEmail: ALICE, container: 'member-1', profile: 'pinned' });
  if (!planned.ok) throw new Error(planned.message);
  try {
    await planned.credential.pinOrigin('172.19.0.2');
    const before = await getTaskSessionBinding(root, planned.credential.key!);
    expect(before?.kind).toBe('api-key');
    const refreshed = Object.fromEntries((await memberContainerProfileEnv({ root, taskId: 'task-1', memberEmail: ALICE, container: 'member-1', key: planned.credential.key!, profile: 'claude-code' })).map(e => {
      const split = e.indexOf('=');
      return [e.slice(0, split), e.slice(split + 1)];
    }));
    expect(refreshed.CLAUDE_CODE_OAUTH_TOKEN).toBe(before!.token);
    expect(refreshed.ANTHROPIC_API_KEY).toBe('');
    expect(refreshed.ANTHROPIC_AUTH_TOKEN).toBe('');
    expect(await createSessionCredentialResolver(root)(refreshed.CLAUDE_CODE_OAUTH_TOKEN!, { peerAddress: '172.19.0.2', upstream: 'https://api.anthropic.com' })).toMatchObject({ ok: true, userId: ALICE, kind: 'oauth', secret: 'alice-oauth-secret' });
    expect(await getTaskSessionBinding(root, planned.credential.key!)).toEqual(before);
    // The original gateway grant still resolves for its original conversation.
    const token = planned.credential.env.find(v => v.key === 'ANTHROPIC_AUTH_TOKEN')!.value;
    const grant = (await lookupCredentialGrant(root, token))!;
    expect((await resolveMemberCredential(root, grant, '', { upstream: 'https://later.example.com' }))?.outcome).toMatchObject({ kind: 'credential', placement: { value: `${ALICE}-later-secret` } });
  } finally { await planned.credential.release(); }
});

for (const [from, to] of [['claude-code', 'pinned'], ['pinned', 'claude-code']] as const) {
  for (const legacy of [false, true]) {
    // INVARIANT: a new conversation replaces profile-controlled flags in both
    // directions, including containers retained across an upgrade/restart.
    test(`${from} -> ${to}: clears obsolete flags${legacy ? ' from a retained pre-upgrade container' : ''}`, async () => {
      await connect(ALICE, 'later');
      await putUserCredential(root, { userId: ALICE, kind: 'oauth', token: 'alice-oauth-secret' });
      const planned = await planMemberContainerCredential({ root, taskId: 'task-1', sessionId: 's1', memberEmail: ALICE, container: 'member-1', profile: from });
      if (!planned.ok) throw new Error(planned.message);
      try {
        let inherited = planned.credential.env;
        if (legacy) {
          // Old container environments omitted inactive flags instead of
          // explicitly clearing them. Re-adoption reloads its persisted payer.
          inherited = inherited.filter(v => v.value !== '');
          clearSessionCredentialCache();
          clearCredentialGrantCache();
        }
        const overlay = await memberContainerProfileEnv({ root, taskId: 'task-1', memberEmail: ALICE, container: 'member-1', key: planned.credential.key!, profile: to });
        const effective = Object.fromEntries([
          ...inherited.map(v => [v.key, v.value]),
          ...overlay.map(e => { const i = e.indexOf('='); return [e.slice(0, i), e.slice(i + 1)]; }),
        ]);
        expect(effective._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe(to === 'claude-code' ? '1' : '');
        for (const key of ['DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']) {
          expect(effective[key]).toBe(to === 'pinned' ? '1' : '');
        }
      } finally { await planned.credential.release(); }
    });
  }
}

// INVARIANT: every placeholder a member terminal ever held — including one a
// later Pair/Chat minted for a changed profile — dies with the terminal. A member
// removed from the team stops being billed at once: Teams withdraws their
// connections, while the terminal's binding lives on until its container goes,
// so the withdrawal is what stops the spending.
test('profile-refresh grants die on release, and withdrawn connections stop spending', async () => {
  await connect(ALICE, 'first');
  await connect(ALICE, 'later');
  const planned = await planMemberContainerCredential({ root, taskId: 'task-1', sessionId: 's1', memberEmail: ALICE, container: 'member-1', profile: 'pinned' });
  if (!planned.ok) throw new Error(planned.message);
  try {
    const first = planned.credential.env.find(v => v.key === 'ANTHROPIC_AUTH_TOKEN')!.value;
    const env = await memberContainerProfileEnv({ root, taskId: 'task-1', memberEmail: ALICE, container: 'member-1', key: planned.credential.key!, profile: 'chain' });
    const refreshed = env.find(e => e.startsWith('ANTHROPIC_AUTH_TOKEN='))!.slice('ANTHROPIC_AUTH_TOKEN='.length);
    expect(refreshed).not.toBe(first);
    const grant = (await lookupCredentialGrant(root, refreshed))!;
    const route = { upstream: 'https://later.example.com', endpoint: 'later', tier: 1 };
    expect((await resolveMemberCredential(root, grant, '', route))?.userId).toBe(ALICE);

    await revokeEndpointCredential(root, ALICE, 'later', async () => {});
    clearUserCredentialCache();
    expect((await resolveMemberCredential(root, grant, '', route))?.outcome.kind).toBe('missing');

    await planned.credential.release();
    expect(await lookupCredentialGrant(root, first)).toBeNull();
    expect(await lookupCredentialGrant(root, refreshed)).toBeNull();
  } finally { await planned.credential.release(); }
});

// INVARIANT: a task profile that names its OWN credential never makes a member
// terminal spend the project's key: the terminal runs that profile (as every
// launch passes it), and pays only with the member's connection for its
// endpoint — refused, binding nothing, when they have none.
test("a profile naming its own credential pays with the member's connection, never the project's", async () => {
  await writeFile(join(root, 'lazy.toml'), `${CONFIG}\n[agents.claude-code]\nharness = "claude-code"\ncredential = "project-anthropic-key"\n`);
  await putUserCredential(root, { userId: ALICE, kind: 'api-key', token: 'alice-builtin-secret' });
  const refused = await planMemberContainerCredential({ root, taskId: 'task-1', sessionId: 's1', memberEmail: ALICE, container: 'member-1', profile: 'claude-code' });
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.message).toContain('profile:claude-code');
  await putEndpointCredential(root, {
    userId: ALICE, endpointId: 'profile:claude-code', origin: 'https://api.anthropic.com',
    provider: 'project-anthropic-key', kind: 'api-key', token: 'alice-profile-secret',
  });
  const planned = await planMemberContainerCredential({ root, taskId: 'task-1', sessionId: 's1', memberEmail: ALICE, container: 'member-1', profile: 'claude-code' });
  if (!planned.ok) throw new Error(planned.message);
  try {
    expect(JSON.stringify(planned.credential.env)).not.toContain('secret');
    const token = planned.credential.env.find(v => v.key === 'ANTHROPIC_AUTH_TOKEN')!.value;
    const grant = (await lookupCredentialGrant(root, token))!;
    const answer = await resolveMemberCredential(root, grant, '', { upstream: 'https://api.anthropic.com' });
    expect(answer?.userId).toBe(ALICE);
    expect(answer?.outcome).toMatchObject({ kind: 'credential', placement: { value: 'alice-profile-secret' } });
  } finally { await planned.credential.release(); }
});

// INVARIANT: on the plain profile the terminal's session placeholder pays with
// the attaching member's own Claude connection — never a teammate's — and stops
// the moment Teams withdraws that connection (the member left the team).
test('plain profile: pays with the member, and stops when their connection is withdrawn', async () => {
  await putUserCredential(root, { userId: ALICE, kind: 'api-key', token: 'alice-builtin-secret' });
  await putUserCredential(root, { userId: 'bob@example.com', kind: 'api-key', token: 'bob-builtin-secret' });
  const planned = await planMemberContainerCredential({ root, taskId: 'task-1', sessionId: 's1', memberEmail: ALICE, container: 'member-1', profile: 'claude-code' });
  if (!planned.ok) throw new Error(planned.message);
  try {
    await planned.credential.pinOrigin('172.19.0.2');
    const token = planned.credential.env.find(v => v.key === 'ANTHROPIC_API_KEY')!.value;
    const resolve = () => createSessionCredentialResolver(root)(token, { peerAddress: '172.19.0.2', upstream: 'https://api.anthropic.com' });
    expect(await resolve()).toMatchObject({ ok: true, userId: ALICE, secret: 'alice-builtin-secret' });
    await revokeEndpointCredential(root, ALICE, 'builtin:anthropic', async () => {});
    clearUserCredentialCache();
    expect((await resolve()).ok).toBe(false);
  } finally { await planned.credential.release(); }
});

// INVARIANT (engineer, 2026-10-24): a member's Pair/Chat on a Codex task runs on
// the member's OWN credential for that profile — what a Codex turn the member
// launched would spend — through lazy's proxy: Codex's key variable holds a
// placeholder bound to the member's private binding, its endpoint variable is
// the live proxy, and no Anthropic credential rides along.
test("codex: the member's own OpenAI key, through the proxy, and nothing else", async () => {
  for (const email of [ALICE, 'bob@example.com']) {
    await putEndpointCredential(root, {
      userId: email, endpointId: 'builtin:openai', origin: 'https://api.openai.com',
      provider: 'openai', kind: 'api-key', token: `${email}-openai-secret`,
    });
  }
  const planned = await planMemberContainerCredential({ root, taskId: 'task-1', sessionId: 's1', memberEmail: ALICE, container: 'member-1', profile: 'codex' });
  if (!planned.ok) throw new Error(planned.message);
  try {
    const env = new Map(planned.credential.env.map(v => [v.key, v.value]));
    expect(JSON.stringify(planned.credential.env)).not.toContain('secret');
    expect(env.get('LAZY_CODEX_API_BASE')).toBe('http://host.docker.internal:26026/v1');
    for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CURSOR_API_KEY']) expect(env.get(key)).toBe('');
    const grant = await lookupCredentialGrant(root, env.get('OPENAI_API_KEY')!);
    expect(grant?.profile).toBe('codex');
    expect(grant?.bindingKey).toBe(planned.credential.key);
    expect((await getTaskSessionBinding(root, grant!.bindingKey!))?.ownerUserId).toBe(ALICE);
    const answer = await resolveMemberCredential(root, grant!, '', { upstream: 'https://api.openai.com' });
    expect(answer?.userId).toBe(ALICE);
    expect(answer?.outcome).toMatchObject({ kind: 'credential', placement: { value: `Bearer ${ALICE}-openai-secret` } });
  } finally { await planned.credential.release(); }
});
