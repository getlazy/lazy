/** Control-plane endpoint provisioning through the live daemon RPC boundary. */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFile, writeFile, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { storageDirFor } from '../helpers/storage';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import type { EndpointCredentialsResult } from '../../src/daemon/endpoint-credentials';
import type { EndpointCredentialSummary } from '../../src/daemon/user-credentials';

const MEMBER = 'ada@example.com';
describe('endpoint credential RPC', () => {
  let controlDir: string;
  let ctx: TestContext, control: DaemonClient, member: DaemonClient;
  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const configPath = join(ctx.root, 'lazy.toml');
    const config = await readFile(configPath, 'utf8');
    await writeFile(configPath, config + `
[endpoints.work]
url = "https://api.anthropic.com/v1"
credential = "anthropic"
[endpoints.reserve]
url = "https://api.anthropic.com"
credential = "anthropic"
[agents.work]
harness = "claude-code"
model = "claude-sonnet-4-6"
named_endpoint = "work"
[agents.reserve]
harness = "claude-code"
model = "claude-sonnet-4-6"
named_endpoint = "reserve"
`);
    controlDir = await mkdtemp(join(tmpdir(), 'endpoint-control-plane-'));
    const controlConfig = join(controlDir, 'lazy.toml');
    await ctx.restartDaemon({ LAZY_TEST_FORCE_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root), LAZY_MANAGED_CONFIG_PATH: controlConfig });
    const target = getDaemonTcpTarget(ctx.root), token = readToken(ctx.root);
    if (!target || !token) throw new Error('Test daemon did not publish its TCP target and control token.');
    control = DaemonClient.fromTarget(target, token);
    // Provision through the owner's save boundary: a copied file alone has
    // repository provenance, so its custom connections are withheld.
    expect(await control.rpc('applyProjectConfig', ctx.root, {
      toml: await readFile(configPath, 'utf8'), origin: 'control-plane',
    })).toMatchObject({ applied: true, changed: true });
    const minted = await control.rpc('mintActorToken', ctx.root, { kind: 'user', email: MEMBER, name: 'Ada' }) as { token: string };
    member = DaemonClient.fromTarget(target, minted.token);
  });
  afterEach(async () => { await ctx.cleanup(); if (controlDir) await rm(controlDir, { recursive: true, force: true }); });

  // INVARIANT: an active check must enforce consent at the daemon's sending
  // boundary even when the client's earlier configuration read was compatible.
  test('credential checks refuse a destination changed after preflight', async () => {
    await control.rpc('putEndpointCredential', ctx.root, { userId: MEMBER, endpointId: 'builtin:anthropic',
      origin: 'https://api.anthropic.com', kind: 'api-key', token: 'endpoint-check-example-secret' });
    const before = await control.rpc('getProjectConfig', ctx.root, {}) as { toml: string };
    expect(before.toml).not.toMatch(/^\[proxy\]/m);
    let requests = 0;
    const receiver = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
      requests++;
      return Response.json({});
    } });
    try {
      await writeFile(join(controlDir, 'lazy.toml'), before.toml + `\n[proxy]\nupstream = "http://127.0.0.1:${receiver.port}"\n`);
      await expect(control.rpc('checkUserCredential', ctx.root, { userId: MEMBER })).rejects.toThrow('No request was sent');
      expect(requests).toBe(0);
    } finally {
      receiver.stop(true);
    }
  });

  // INVARIANT: a malformed ChatGPT credential never exposes token bytes in the RPC error.
  test('ChatGPT syntax errors return safe reconnect guidance', async () => {
    const secret = 'synthetic_rpc_chatgpt_secret_never_echo';
    const error = await control.rpc('putEndpointCredential', ctx.root, { userId: MEMBER, endpointId: 'builtin:chatgpt', origin: 'https://chatgpt.com', kind: 'oauth', token: `{"tokens":{"refresh_token":${secret}}}` }).then(() => null, err => err as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain('not valid JSON');
    expect(error!.message).toContain('codex login');
    expect(error!.message).not.toContain(secret);
    expect(error!.stack).not.toContain(secret);
    expect(await member.rpc('listEndpointCredentials', ctx.root, {})).toEqual({ credentials: [] });
  });

  // INVARIANT: old blank consent is accepted only for a fixed reserved provider default.
  test('legacy builtin Cursor origin can be re-pushed through endpoint RPC', async () => {
    const saved = await control.rpc('putEndpointCredential', ctx.root, { userId: MEMBER, endpointId: 'builtin:cursor', origin: '', kind: 'api-key', token: 'cursor-secret' }) as EndpointCredentialSummary;
    expect(saved.origin).toBe('https://api2.cursor.sh');
    const state = await member.rpc('endpointCredentials', ctx.root, {}) as EndpointCredentialsResult;
    expect(state.endpoints.find(r => r.endpointId === 'builtin:cursor')!.yours?.state).toBe('connected');
    await expect(control.rpc('putEndpointCredential', ctx.root, { userId: MEMBER, endpointId: 'work', origin: '', kind: 'api-key', token: 'work-secret' })).rejects.toThrow('reserved provider default');
  });

  // INVARIANT: service readiness is the holder's own endpoint account, even without a matching service row.
  test('service endpoint descriptors use the designated holder accounts', async () => {
    const service = { userId: '__service__', endpointId: 'reserve', origin: 'https://api.anthropic.com', kind: 'api-key', token: 'service-copy', ownerEmail: MEMBER };
    await control.rpc('putEndpointCredential', ctx.root, service);
    const state = async () => (await control.rpc('endpointCredentials', ctx.root, { userId: '__service__' }) as EndpointCredentialsResult).endpoints.find(r => r.endpointId === 'work')!.yours?.state;
    expect(await state()).toBe('missing');
    await control.rpc('putEndpointCredential', ctx.root, { ...service, userId: MEMBER, endpointId: 'work', token: 'holder-own' });
    expect(await state()).toBe('connected');
    await control.rpc('putEndpointCredential', ctx.root, { ...service, userId: MEMBER, endpointId: 'work', token: 'holder-own', origin: 'https://old.example' });
    expect(await state()).toBe('stale');
  });

  // INVARIANT: member tokens see only their own state; only the control plane may change whose account pays.
  test('describes independent slots and validates/authenticates every mutation', async () => {
    await control.rpc('setCredentialBillingMode', ctx.root, { mode: 'member' });
    const before = await member.rpc('endpointCredentials', ctx.root, {}) as EndpointCredentialsResult;
    expect(before.endpoints.find(r => r.endpointId === 'work')).toMatchObject({ provider: 'anthropic', origin: 'https://api.anthropic.com', kinds: ['oauth', 'api-key'], yours: { state: 'missing' } });
    await expect(member.rpc('endpointCredentials', ctx.root, { userId: 'someone@example.com' })).rejects.toThrow('Forbidden');
    await expect(member.rpc('listEndpointCredentials', ctx.root, { userId: 'someone@example.com' })).rejects.toThrow('Forbidden');
    const params = { userId: MEMBER, endpointId: 'work', origin: 'https://api.anthropic.com', kind: 'api-key', token: 'endpoint-rpc-work-secret' };
    await expect(member.rpc('putEndpointCredential', ctx.root, params)).rejects.toThrow('control-plane');
    await expect(member.rpc('revokeEndpointCredential', ctx.root, params)).rejects.toThrow('control-plane');
    await expect(member.rpc('setCredentialBillingMode', ctx.root, { mode: 'member' })).rejects.toThrow('control-plane');
    await expect(control.rpc('putEndpointCredential', ctx.root, { ...params, origin: 123 })).rejects.toThrow('origin');
    await expect(control.rpc('putEndpointCredential', ctx.root, { ...params, kind: 'unknown' })).rejects.toThrow('takes');
    await expect(control.rpc('putEndpointCredential', ctx.root, { ...params, endpointId: 'unconfigured' })).rejects.toThrow('not taken');
    await expect(control.rpc('putEndpointCredential', ctx.root, { ...params, origin: 'https://secret@host.example' })).rejects.toThrow('embedded credentials');
    await expect(control.rpc('setCredentialBillingMode', ctx.root, { mode: 'solo' })).rejects.toThrow('cannot disable');
    const saved = await control.rpc('putEndpointCredential', ctx.root, params) as EndpointCredentialSummary;
    expect(saved).toMatchObject({ userId: MEMBER, endpointId: 'work', origin: params.origin, kind: 'api-key' });
    expect(JSON.stringify(saved)).not.toContain(params.token);
    const after = await member.rpc('endpointCredentials', ctx.root, {}) as EndpointCredentialsResult;
    expect(after.endpoints.find(r => r.endpointId === 'work')!.yours?.state).toBe('connected');
    expect(after.endpoints.find(r => r.endpointId === 'reserve')!.yours?.state).toBe('missing');
    expect(after.endpoints.find(r => r.endpointId === 'builtin:anthropic')!.yours?.state).toBe('missing');
    // A delayed push keeps the origin it was originally authorized for.
    await control.rpc('putEndpointCredential', ctx.root, { ...params, origin: 'https://old.example' });
    const stale = await member.rpc('endpointCredentials', ctx.root, {}) as EndpointCredentialsResult;
    expect(stale.endpoints.find(r => r.endpointId === 'work')!.yours?.state).toBe('stale');
    const listed = await member.rpc('listEndpointCredentials', ctx.root, {}) as { credentials: EndpointCredentialSummary[] };
    expect(listed.credentials).toHaveLength(1); expect(listed.credentials[0]!.origin).toBe('https://old.example');
    expect(JSON.stringify(listed)).not.toContain(params.token);
    expect(await control.rpc('revokeEndpointCredential', ctx.root, { userId: MEMBER, endpointId: 'work' })).toEqual({ revoked: true });
    expect(await member.rpc('listEndpointCredentials', ctx.root, {})).toEqual({ credentials: [] });
  });
});
