/**
 * Per-member credentials PER AGENT PROFILE — which of a member's own
 * credentials pays for a turn, what a control plane may store, and what the
 * proxy sends upstream for a team-mode task caller.
 *
 * The rule (src/daemon/member-credentials.ts): in team mode every profile is
 * paid by the principal's OWN credential for it — their Claude credential for
 * an Anthropic-billed profile whose traffic goes to Anthropic, one they
 * connected for the profile otherwise — and never by the project's store.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import {
  claudeCredentialPays,
  memberCredentialFor,
} from '../../src/daemon/member-credentials';
import { agentCredentialProfiles, putProfileCredential } from '../../src/daemon/agent-credential-profiles';
import {
  clearUserCredentialCache,
  getUserCredential,
  putUserCredential,
  storeRenewedUserCredential,
  SERVICE_CREDENTIAL_USER_ID,
} from '../../src/daemon/user-credentials';
import { bindTurnCredential, clearSessionCredentialCache, revokeTaskSessionBinding } from '../../src/daemon/session-credentials';
import { resolveMemberCredential } from '../../src/proxy/credential-deps';
import { agentProfilesFor, type AgentProfile } from '../../src/config/agent-profiles';
import { loadConfig } from '../../src/config/loader';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import { recordRunningProxyRoutes, resetRunningProxyRoutes } from '../../src/daemon/running-proxy-routes';

const ALICE = 'alice@example.com';

const CONFIG = [
  '[credentials]',
  'backend = "file"',
  '',
  '[agents.claude-gw]',
  'harness = "claude-code"',
  'model = "claude-sonnet-4-6"',
  'endpoint = "https://gw.example.com"',
  'credential = "gw-claude"',
  '',
  '[agents.pi-cloud]',
  'harness = "pi"',
  'model = "qwen3"',
  'endpoint = "https://ollama.com"',
  '',
  '[agents.claude-direct]',
  'harness = "claude-code"',
  'model = "claude-sonnet-4-6"',
  'endpoint = "https://api.anthropic.com"',
  '',
  '[agents.local]',
  'harness = "claude-code"',
  'model = "qwen"',
  'endpoint = "http://localhost:11434"',
  '',
].join('\n');

/**
 * Store a credential the way a control plane does: carrying the endpoint the
 * member was SHOWN for the profile — read off the daemon's own list at the
 * time — as their consent to where the secret goes.
 */
async function putShown(
  projectRoot: string,
  input: Omit<Parameters<typeof putProfileCredential>[1], 'endpoint'>,
) {
  const { profiles } = await agentCredentialProfiles(projectRoot);
  const shownEndpoint = profiles.find((p) => p.name === input.profile)?.endpoint ?? '';
  return putProfileCredential(projectRoot, { ...input, endpoint: shownEndpoint });
}

/** An agent grant as a launch mints it: the task's reference, and its UUID. */
function grant(profile: string, taskId: string | null = 'task-1', role: 'agent' | 'builder' = 'agent'): CredentialGrant {
  return {
    token: 'lazy-ph-x', role, taskId, label: 'c', envKey: 'ANTHROPIC_AUTH_TOKEN', profile, createdAt: '',
    ...(taskId ? { taskUuid: taskId } : {}),
  };
}

/** A JWT-shaped ChatGPT access token expiring in `seconds`. */
function chatGptAccess(seconds: number, n: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + seconds, n })}.sig`;
}

describe('member credentials per agent profile', () => {
  let projectRoot: string;
  let baseDir: string;
  let undoBaseDir: () => void;
  let savedConfig: string | undefined;

  async function profile(name: string): Promise<AgentProfile> {
    return agentProfilesFor(await loadConfig(projectRoot)).get(name)!;
  }

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'lazy-member-cred-'));
    baseDir = await mkdtemp(join(tmpdir(), 'lazy-member-cred-daemon-'));
    undoBaseDir = pinDaemonBaseDir(baseDir);
    savedConfig = process.env.LAZY_CONFIG;
    const configPath = join(projectRoot, 'lazy.toml');
    await writeFile(configPath, CONFIG);
    process.env.LAZY_CONFIG = configPath;
    clearUserCredentialCache();
    clearSessionCredentialCache();
  });

  afterEach(async () => {
    undoBaseDir();
    if (savedConfig === undefined) delete process.env.LAZY_CONFIG;
    else process.env.LAZY_CONFIG = savedConfig;
    clearUserCredentialCache();
    clearSessionCredentialCache();
    resetRunningProxyRoutes();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(baseDir, { recursive: true, force: true });
  });

  // INVARIANT: the Claude credential pays only where it is sent to Anthropic —
  // the primary upstream or Anthropic's own API. A profile pinned anywhere else
  // needs a credential connected for it, so no member's Anthropic token follows
  // a profile to a host they never chose.
  test('the Claude credential pays only for Anthropic-bound profiles', async () => {
    expect(claudeCredentialPays(await profile('claude-code'))).toBe(true);
    expect(claudeCredentialPays(await profile('claude-direct'))).toBe(true);
    expect(claudeCredentialPays(await profile('claude-gw'))).toBe(false);
    expect(claudeCredentialPays(await profile('codex'))).toBe(false);
    expect(claudeCredentialPays(await profile('local'))).toBe(false);
  });

  test('which credential pays: none, the Claude one, or the one connected for the profile', async () => {
    expect(await memberCredentialFor(projectRoot, ALICE, await profile('local'))).toEqual({ kind: 'none-needed' });

    expect(await memberCredentialFor(projectRoot, ALICE, await profile('claude-code')))
      .toMatchObject({ kind: 'missing', want: 'claude' });
    expect(await memberCredentialFor(projectRoot, ALICE, await profile('claude-gw')))
      .toMatchObject({ kind: 'missing', want: 'profile' });

    await putUserCredential(projectRoot, { userId: ALICE, kind: 'oauth', token: 'claude-secret' });
    expect(await memberCredentialFor(projectRoot, ALICE, await profile('claude-direct')))
      .toMatchObject({ kind: 'credential', via: 'claude' });
    // The Claude credential never pays for a profile pinned elsewhere.
    expect(await memberCredentialFor(projectRoot, ALICE, await profile('claude-gw')))
      .toMatchObject({ kind: 'missing', want: 'profile' });

    await putShown(projectRoot, { userId: ALICE, kind: 'api-key', token: 'gw-secret', profile: 'claude-gw' });
    const gw = await memberCredentialFor(projectRoot, ALICE, await profile('claude-gw'));
    expect(gw).toMatchObject({ kind: 'credential', via: 'profile' });
    expect(gw.kind === 'credential' && gw.record.token).toBe('gw-secret');
  });

  // INVARIANT: a credential connected for a profile is stamped with the
  // endpoint it was connected for; when the project points the profile
  // elsewhere, it is refused rather than sent to the new host.
  test('a profile whose endpoint changed refuses the credential connected for the old one', async () => {
    await putShown(projectRoot, { userId: ALICE, kind: 'api-key', token: 'gw-secret', profile: 'claude-gw' });
    await writeFile(process.env.LAZY_CONFIG!, CONFIG.replace('https://gw.example.com', 'https://elsewhere.example.com'));
    const answer = await memberCredentialFor(projectRoot, ALICE, await profile('claude-gw'));
    expect(answer).toMatchObject({ kind: 'missing', want: 'profile' });
    expect(answer.kind === 'missing' && answer.detail).toContain('https://elsewhere.example.com');
  });

  // INVARIANT: the stamp records CONSENT — the endpoint the member was shown —
  // never the config of the moment. A control plane re-pushes every credential
  // on each provisioning pass; if that re-push re-stamped from config, an owner
  // re-pointing a profile would silently redirect every member's secret.
  test('a re-provisioning push after the endpoint changed does not re-consent', async () => {
    await putShown(projectRoot, { userId: ALICE, kind: 'api-key', token: 'gw-secret', profile: 'claude-gw' });
    await writeFile(process.env.LAZY_CONFIG!, CONFIG.replace('https://gw.example.com', 'https://elsewhere.example.com'));
    // The re-push carries what the member consented to, unchanged.
    await putProfileCredential(projectRoot, {
      userId: ALICE, kind: 'api-key', token: 'gw-secret', profile: 'claude-gw', endpoint: 'https://gw.example.com',
    });
    expect(await memberCredentialFor(projectRoot, ALICE, await profile('claude-gw')))
      .toMatchObject({ kind: 'missing', want: 'profile' });
    // Reconnecting — consenting to the new endpoint — is what makes it usable.
    await putShown(projectRoot, { userId: ALICE, kind: 'api-key', token: 'gw-secret', profile: 'claude-gw' });
    expect(await memberCredentialFor(projectRoot, ALICE, await profile('claude-gw')))
      .toMatchObject({ kind: 'credential', via: 'profile' });
  });

  // A credential pushed with no stated consent pays for nothing.
  test('a credential stored without a consented endpoint is refused', async () => {
    await putProfileCredential(projectRoot, { userId: ALICE, kind: 'api-key', token: 'gw-secret', profile: 'claude-gw' });
    expect(await memberCredentialFor(projectRoot, ALICE, await profile('claude-gw')))
      .toMatchObject({ kind: 'missing', want: 'profile' });
  });

  // INVARIANT: the stamp is checked against where the RUNNING proxy forwards
  // the profile — built at daemon start — not a fresh read of the config, which
  // a save changes before the restart that re-routes the proxy.
  test('the stamp is checked against the running proxy\'s route, not the saved config', async () => {
    recordRunningProxyRoutes(projectRoot, await loadConfig(projectRoot));
    await writeFile(process.env.LAZY_CONFIG!, CONFIG.replace('https://gw.example.com', 'https://elsewhere.example.com'));
    // Consent to the NEW endpoint: the proxy still forwards to the old one.
    await putShown(projectRoot, { userId: ALICE, kind: 'api-key', token: 'gw-secret', profile: 'claude-gw' });
    const early = await memberCredentialFor(projectRoot, ALICE, await profile('claude-gw'));
    expect(early).toMatchObject({ kind: 'missing', want: 'profile' });
    expect(early.kind === 'missing' && early.detail).toContain('https://gw.example.com');
    // Once the proxy runs on the new config (a restart), the same consent works.
    recordRunningProxyRoutes(projectRoot, await loadConfig(projectRoot));
    expect(await memberCredentialFor(projectRoot, ALICE, await profile('claude-gw')))
      .toMatchObject({ kind: 'credential' });
  });

  test('the store refuses what a profile does not take', async () => {
    await expect(putShown(projectRoot, { userId: ALICE, kind: 'api-key', token: 't', profile: 'claude-code' }))
      .rejects.toThrow(/paid by the member's Claude/);
    await expect(putShown(projectRoot, { userId: ALICE, kind: 'api-key', token: 't', profile: 'local' }))
      .rejects.toThrow(/takes no credential/);
    await expect(putShown(projectRoot, { userId: ALICE, kind: 'oauth', token: 't', profile: 'codex' }))
      .rejects.toThrow(/takes 'api-key'/);
    await expect(putShown(projectRoot, { userId: ALICE, kind: 'oauth', token: 'not json', profile: 'codex-subscription' }))
      .rejects.toThrow(/not valid JSON/);
  });

  test('the list a connect page renders comes from the config, with where each secret goes', async () => {
    const { profiles } = await agentCredentialProfiles(projectRoot);
    const byName = new Map(profiles.map((p) => [p.name, p]));
    expect(byName.has('qa-agent')).toBe(false);
    expect(byName.get('claude-code')).toMatchObject({ paidBy: 'claude', kinds: [], endpoint: null });
    expect(byName.get('claude-gw')).toMatchObject({
      paidBy: 'profile', credential: 'gw-claude', kinds: ['api-key', 'oauth'], endpoint: 'https://gw.example.com',
    });
    expect(byName.get('pi-cloud')).toMatchObject({ paidBy: 'profile', credential: 'ollama', kinds: ['api-key'] });
    expect(byName.get('codex-subscription')).toMatchObject({ paidBy: 'profile', session: true, kinds: ['oauth'] });
    expect(byName.get('local')).toMatchObject({ paidBy: 'none', credential: null });
  });

  // INVARIANT: a renewed ChatGPT session survives the control plane re-pushing
  // the ORIGINAL (whose refresh token the renewal retired); a genuinely new
  // one replaces it.
  test('a re-push of the same session keeps the renewed one', async () => {
    const original = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a1', refresh_token: 'r1' } });
    await putShown(projectRoot, { userId: ALICE, kind: 'oauth', token: original, profile: 'codex-subscription' });
    const stored = (await getUserCredential(projectRoot, ALICE, 'codex-subscription'))!.token;
    expect(await storeRenewedUserCredential(projectRoot, ALICE, 'codex-subscription', 'RENEWED', stored)).toBe(true);
    await putShown(projectRoot, { userId: ALICE, kind: 'oauth', token: original, profile: 'codex-subscription' });
    expect((await getUserCredential(projectRoot, ALICE, 'codex-subscription'))?.token).toBe('RENEWED');

    const fresh = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a2', refresh_token: 'r2' } });
    await putShown(projectRoot, { userId: ALICE, kind: 'oauth', token: fresh, profile: 'codex-subscription' });
    expect((await getUserCredential(projectRoot, ALICE, 'codex-subscription'))?.token).toContain('r2');
  });

  // INVARIANT: a renewal writes back only over the session it renewed. A
  // renewal still in flight when the member reconnects a NEW session must not
  // overwrite it — the new record's digest would then match every later
  // re-push, and the member would stay billed on the login they replaced.
  test('a renewal that finishes after a reconnect does not overwrite the new session', async () => {
    const old = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a1', refresh_token: 'r1' } });
    await putShown(projectRoot, { userId: ALICE, kind: 'oauth', token: old, profile: 'codex-subscription' });
    const renewedFrom = (await getUserCredential(projectRoot, ALICE, 'codex-subscription'))!.token;

    const fresh = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a2', refresh_token: 'r2' } });
    await putShown(projectRoot, { userId: ALICE, kind: 'oauth', token: fresh, profile: 'codex-subscription' });

    expect(await storeRenewedUserCredential(projectRoot, ALICE, 'codex-subscription', 'RENEWED-OLD', renewedFrom))
      .toBe(false);
    expect((await getUserCredential(projectRoot, ALICE, 'codex-subscription'))?.token).toContain('r2');
  });

  // INVARIANT: the Claude credential is paid only where the RUNNING proxy
  // sends the profile to Anthropic. A saved config that re-points a gateway
  // profile at Anthropic (or drops its endpoint) changes nothing about where
  // the proxy forwards until it is rebuilt, so the member's Anthropic token
  // must not ride a request that still goes to the gateway.
  test('the Claude credential never pays while the running proxy still forwards the profile elsewhere', async () => {
    await putUserCredential(projectRoot, { userId: ALICE, kind: 'oauth', token: 'claude-secret' });
    recordRunningProxyRoutes(projectRoot, await loadConfig(projectRoot));
    const gwBlock = 'endpoint = "https://gw.example.com"\ncredential = "gw-claude"\n';
    for (const repointed of [
      CONFIG.replace(gwBlock, 'endpoint = "https://api.anthropic.com"\n'),
      CONFIG.replace(gwBlock, ''),
    ]) {
      expect(repointed).not.toBe(CONFIG);
      await writeFile(process.env.LAZY_CONFIG!, repointed);
      const answer = await memberCredentialFor(projectRoot, ALICE, await profile('claude-gw'));
      expect(answer.kind).toBe('missing');
      expect(answer.kind === 'missing' && answer.detail).toContain('https://gw.example.com');
    }
    // Once the proxy is rebuilt on the saved config, the Claude credential pays.
    recordRunningProxyRoutes(projectRoot, await loadConfig(projectRoot));
    expect(await memberCredentialFor(projectRoot, ALICE, await profile('claude-gw')))
      .toMatchObject({ kind: 'credential', via: 'claude' });
  });

  describe('what the proxy sends for a team-mode task caller', () => {
    test('nothing to decide outside team mode, or for a caller with no task', async () => {
      expect(await resolveMemberCredential(projectRoot, grant('claude-gw'))).toBeNull();
      await putUserCredential(projectRoot, { userId: ALICE, kind: 'oauth', token: 'claude-secret' });
      expect(await resolveMemberCredential(projectRoot, grant('claude-code', null, 'builder'))).toBeNull();
    });

    // INVARIANT: no member, no credential. A task with no live turn has nobody
    // to bill, and the project's own key is never the answer.
    test('a task with no live turn is refused', async () => {
      await putUserCredential(projectRoot, { userId: ALICE, kind: 'oauth', token: 'claude-secret' });
      expect((await resolveMemberCredential(projectRoot, grant('claude-gw')))?.outcome.kind).toBe('missing');
      await bindTurnCredential(projectRoot, { taskId: 'task-1', sessionId: 's', ownerUserId: ALICE, kind: 'oauth' });
      await revokeTaskSessionBinding(projectRoot, 'task-1');
      expect((await resolveMemberCredential(projectRoot, grant('claude-gw')))?.outcome.kind).toBe('missing');
    });

    // INVARIANT: each profile's traffic carries the turn owner's credential for
    // THAT profile, in the header shape the store resolvers use.
    test('each profile is paid with the owner\'s credential for it, in its own header shape', async () => {
      await putUserCredential(projectRoot, { userId: ALICE, kind: 'oauth', token: 'claude-secret' });
      await putShown(projectRoot, { userId: ALICE, kind: 'api-key', token: 'gw-secret', profile: 'claude-gw' });
      await putShown(projectRoot, { userId: ALICE, kind: 'api-key', token: 'ollama-secret', profile: 'pi-cloud' });
      await putShown(projectRoot, { userId: ALICE, kind: 'api-key', token: 'openai-secret', profile: 'codex' });
      await bindTurnCredential(projectRoot, { taskId: 'task-1', sessionId: 's', ownerUserId: ALICE, kind: 'oauth' });

      const gw = await resolveMemberCredential(projectRoot, grant('claude-gw'));
      expect(gw?.userId).toBe(ALICE);
      expect(gw?.outcome).toMatchObject({ kind: 'credential', placement: { header: 'x-api-key', value: 'gw-secret' } });

      expect((await resolveMemberCredential(projectRoot, grant('pi-cloud')))?.outcome)
        .toMatchObject({ kind: 'credential', placement: { header: 'authorization', value: 'Bearer ollama-secret' } });
      expect((await resolveMemberCredential(projectRoot, grant('codex')))?.outcome)
        .toMatchObject({ kind: 'credential', placement: { header: 'authorization', value: 'Bearer openai-secret' } });
      expect((await resolveMemberCredential(projectRoot, grant('claude-direct')))?.outcome)
        .toMatchObject({ kind: 'credential', placement: { header: 'authorization', value: 'Bearer claude-secret' } });
      expect((await resolveMemberCredential(projectRoot, grant('local')))?.outcome.kind).toBe('none');
    });

    // INVARIANT: a grant finds its turn by the task UUID it was minted with,
    // EXACTLY. A task code is mutable and reusable: a grant minted under a
    // task's old code must never resolve to another task that took the code
    // since, and bill that task's principal.
    test('the turn is found by the task UUID the grant carries, never by a code', async () => {
      await putUserCredential(projectRoot, { userId: ALICE, kind: 'oauth', token: 'claude-secret' });
      await putShown(projectRoot, { userId: ALICE, kind: 'api-key', token: 'gw-secret', profile: 'claude-gw' });
      const uuid = '0123abcd-0000-4000-8000-000000000001';
      await bindTurnCredential(projectRoot, { taskId: uuid, sessionId: 's', ownerUserId: ALICE, kind: 'oauth' });

      const byUuid = { ...grant('claude-gw', 'my-code'), taskUuid: uuid };
      expect((await resolveMemberCredential(projectRoot, byUuid))?.outcome.kind).toBe('credential');

      // Only a code, or a prefix of the UUID: nothing to bill.
      for (const ref of ['my-code', '0123abcd']) {
        const { taskUuid: _drop, ...byRef } = grant('claude-gw', ref);
        expect((await resolveMemberCredential(projectRoot, byRef))?.outcome.kind).toBe('missing');
      }
    });

    // INVARIANT: the service slot for a ChatGPT SESSION profile is the holder's
    // own login, not a copy of it. Two copies of one session renew
    // independently, and each renewal retires the refresh token the other copy
    // holds — one of the two is then dead for good.
    test('a service holder\'s ChatGPT session keeps working for both uses across renewals', async () => {
      await putUserCredential(projectRoot, {
        userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'svc-claude', ownerEmail: ALICE,
      });
      await putUserCredential(projectRoot, { userId: ALICE, kind: 'oauth', token: 'claude-secret' });
      const session = JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: chatGptAccess(30, 0), refresh_token: 'rt-0', account_id: 'acct-alice' },
      });
      // What the control plane pushes: the holder's own row, and the same row
      // again under the service key.
      await putShown(projectRoot, { userId: ALICE, kind: 'oauth', token: session, profile: 'codex-subscription' });
      await putShown(projectRoot, {
        userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: session, profile: 'codex-subscription',
      });
      await bindTurnCredential(projectRoot, { taskId: 'task-alice', sessionId: 'a', ownerUserId: ALICE, kind: 'oauth' });
      await bindTurnCredential(projectRoot, {
        taskId: 'task-svc', sessionId: 'b', ownerUserId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth',
      });

      // The token endpoint rotates, and refuses a retired refresh token.
      let live = 'rt-0';
      let n = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const presented = new URLSearchParams(String(init?.body ?? '')).get('refresh_token');
        if (presented !== live) return new Response('{"error":"invalid_grant"}', { status: 400 });
        n += 1;
        live = `rt-${n}`;
        return Response.json({ access_token: chatGptAccess(30, n), refresh_token: live });
      }) as unknown as typeof fetch;
      try {
        for (const taskId of ['task-svc', 'task-alice', 'task-svc', 'task-alice']) {
          const outcome = (await resolveMemberCredential(projectRoot, grant('codex-subscription', taskId)))?.outcome;
          expect(outcome, `renewal for ${taskId}`).toMatchObject({ kind: 'credential' });
        }
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(n).toBe(4);
    });

    // A ChatGPT subscription connected by a member is presented the way the
    // codex CLI presents one: its access token as a bearer, and the ACCOUNT
    // header from the stored session — never whatever the container sent.
    test('a member\'s ChatGPT subscription is presented with its account', async () => {
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const access = `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
      const session = JSON.stringify({
        auth_mode: 'chatgpt', tokens: { access_token: access, refresh_token: 'r1', account_id: 'acct-alice' },
      });
      await putUserCredential(projectRoot, { userId: ALICE, kind: 'oauth', token: 'claude-secret' });
      await putShown(projectRoot, { userId: ALICE, kind: 'oauth', token: session, profile: 'codex-subscription' });
      await bindTurnCredential(projectRoot, { taskId: 'task-1', sessionId: 's', ownerUserId: ALICE, kind: 'oauth' });

      expect((await resolveMemberCredential(projectRoot, grant('codex-subscription')))?.outcome).toMatchObject({
        kind: 'credential',
        placement: {
          header: 'authorization', value: `Bearer ${access}`, companionHeaders: { 'chatgpt-account-id': 'acct-alice' },
        },
      });
    });

    test('a turn nobody asked for is paid by the service holder\'s credential for the profile', async () => {
      await putUserCredential(projectRoot, { userId: ALICE, kind: 'oauth', token: 'claude-secret' });
      await bindTurnCredential(projectRoot, { taskId: 'task-1', sessionId: 's', ownerUserId: SERVICE_CREDENTIAL_USER_ID, kind: 'api-key' });
      expect((await resolveMemberCredential(projectRoot, grant('claude-gw')))?.outcome.kind).toBe('missing');
      await putShown(projectRoot, {
        userId: SERVICE_CREDENTIAL_USER_ID, kind: 'api-key', token: 'svc-gw', profile: 'claude-gw',
      });
      expect((await resolveMemberCredential(projectRoot, grant('claude-gw')))?.outcome)
        .toMatchObject({ kind: 'credential', placement: { value: 'svc-gw' } });
    });
  });
});

describe('the per-member re-authorize verdict', () => {
  // INVARIANT: a 401 on a credential a member connected for one PROFILE is not
  // evidence against their Claude credential — "re-authorize your Claude
  // token" would send them to fix the wrong thing.
  test('ignores requests paid by a profile credential', async () => {
    const { unresolvedAuthRejectionsByUser } = await import('../../src/proxy/auth-verdict');
    const base = { id: 'x', seq: 1, ts: 1, role: 'agent', taskId: 't', backend: 'proxy', upstream: 'u',
      method: 'POST', path: '/v1/messages', durationMs: 1 } as const;
    const verdicts = unresolvedAuthRejectionsByUser([
      { ...base, userId: ALICE, credentialProfile: 'claude-gw', status: 401 },
    ] as never);
    expect(verdicts.has(ALICE)).toBe(false);
    expect(unresolvedAuthRejectionsByUser([{ ...base, userId: ALICE, status: 401 }] as never).has(ALICE)).toBe(true);
  });
});
