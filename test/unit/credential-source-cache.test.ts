import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { bindCredentialSet } from '../../src/credentials/set-binding';
import { credentialSecretsPath } from '../../src/credentials/scope';
import { credentialPresence, getStoredCredentialForEntry, deleteCredential, locateCredential, resolveCredential, setCredential } from '../../src/credentials/store';
import { hydrateCredentialEnv } from '../../src/credentials/hydrate';
import { forgetHydratedEnvValues, isStoreUnreadable } from '../../src/credentials/hydrated-env';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { clearUserCredentialCache, putEndpointCredential, setCredentialBillingMode } from '../../src/daemon/user-credentials';
import { bindTurnCredential, clearSessionCredentialCache } from '../../src/daemon/session-credentials';
import { agentProfilesFor } from '../../src/config/agent-profiles';
import { endpointRequirementsForProfile } from '../../src/credentials/endpoint-requirements';
import { loadConfig } from '../../src/config/loader';
import { buildProxyCredentialDeps } from '../../src/proxy/credential-deps';
import { createProxyServer } from '../../src/proxy/server';
import { bindDerivedCredentials, derivedPlaceholderFor, clearCredentialGrantCache, mintCredentialGrant } from '../../src/proxy/credential-broker';

// INVARIANT: a stale hydrated value may only stand in for its own currently
// selected scope. A failed read must never let a different account be spent.
describe('credential source cache', () => {
  let temp: string;
  let root: string;
  let unpin: () => void;
  let env: NodeJS.ProcessEnv;
  const savedMarkers: Record<string, string | undefined> = {};
  const markers = ['LAZY_MCP_EXPECTED_TASK_ID', 'LAZY_MCP_EXPECTED_WORKTREE', 'LAZY_TASK', 'CURSOR_API_KEY'];

  beforeEach(async () => {
    for (const key of markers) { savedMarkers[key] = process.env[key]; delete process.env[key]; }
    temp = await mkdtemp(join(tmpdir(), 'lazy-source-cache-'));
    root = join(temp, 'project');
    await mkdir(root);
    const git = Bun.spawnSync(['git', 'init'], { cwd: root, stderr: 'pipe', stdout: 'pipe' });
    if (git.exitCode) throw new Error(git.stderr.toString());
    await writeFile(join(root, 'lazy.toml'), '[credentials]\nbackend = "file"\n');
    unpin = pinDaemonBaseDir(join(temp, 'daemon'));
    forgetHydratedEnvValues();
    env = {};
    await setCredential({ set: 'personal' }, { provider: 'openai', kind: 'api-key', secret: 'personal-original' }, 'file');
    await setCredential({ set: 'work' }, { provider: 'openai', kind: 'api-key', secret: 'work-current' }, 'file');
    await bindCredentialSet(root, 'personal');
    await hydrateCredentialEnv(root, env, ['openai']);
  });

  afterEach(async () => {
    forgetHydratedEnvValues();
    clearCredentialGrantCache();
    clearUserCredentialCache();
    clearSessionCredentialCache();
    unpin?.();
    for (const key of markers) {
      if (savedMarkers[key] === undefined) delete process.env[key]; else process.env[key] = savedMarkers[key];
    }
    await rm(temp, { recursive: true, force: true });
  });

  async function failPersonalRead() {
    await setCredential({ set: 'personal' }, { provider: 'openai', kind: 'api-key', secret: 'personal-rotated' }, 'file');
    const path = credentialSecretsPath({ set: 'personal' });
    const readable = await readFile(path, 'utf8');
    await writeFile(path, '{}');
    expect(await resolveCredential(root, 'openai', env)).toMatchObject({ value: 'personal-original', setName: 'personal', stale: true });
    return { path, readable };
  }

  test('a backend read uses the source snapshot whose metadata will mark its cached value', async () => {
    const selected = (await credentialPresence(root, 'openai'))!;
    await bindCredentialSet(root, 'work');
    expect(await getStoredCredentialForEntry(root, 'openai', selected)).toMatchObject({ value: 'personal-original', setName: 'personal' });
    expect(await resolveCredential(root, 'openai', env)).toMatchObject({ value: 'work-current', setName: 'work' });
  });

  test('A to B to A after a failed read never serves the previous binding', async () => {
    const { path, readable } = await failPersonalRead();
    await writeFile(path, readable);
    await bindCredentialSet(root, 'work');
    expect(await locateCredential(root, 'openai', env)).toMatchObject({ setName: 'work' });
    expect(await resolveCredential(root, 'openai', env)).toMatchObject({ value: 'work-current', setName: 'work' });
    expect(isStoreUnreadable('openai')).toBe(false);
    await bindCredentialSet(root, 'personal');
    expect(await locateCredential(root, 'openai', env)).toMatchObject({ setName: 'personal' });
    for (let i = 0; i < 3; i++) {
      expect(await resolveCredential(root, 'openai', env)).toMatchObject({ value: 'personal-rotated', setName: 'personal' });
    }
  });

  test('returning to an unreadable A refuses instead of serving cached B', async () => {
    await failPersonalRead();
    await bindCredentialSet(root, 'work');
    expect(await resolveCredential(root, 'openai', env)).toMatchObject({ value: 'work-current', setName: 'work' });
    await bindCredentialSet(root, 'personal');
    for (let i = 0; i < 3; i++) await expect(resolveCredential(root, 'openai', env)).rejects.toThrow('backend did not return one');
    expect(await locateCredential(root, 'openai', env)).toMatchObject({ setName: 'personal' });
  });

  // INVARIANT: upstream-minted sessions remain tied to the selected credential,
  // even when a running launch keeps its placeholder across a binding change.
  test.each(['solo', 'member'] as const)('the %s proxy never reuses a Cursor session minted by another selected source', async mode => {
    const seen: string[] = [];
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const auth = request.headers.get('authorization')!;
      seen.push(auth);
      return new URL(request.url).pathname === '/auth/exchange_user_api_key'
        ? Response.json({ accessToken: `session-${auth.slice(7)}`, refreshToken: `refresh-${auth.slice(7)}` })
        : Response.json({ ok: true });
    } });
    await writeFile(join(root, 'lazy.toml'), '[credentials]\nbackend = "file"\n[agents.cursor]\ncredential = "cursor"\n');
    const config = await loadConfig(root);
    config.proxy.cursorUpstream = `http://127.0.0.1:${upstream.port}`;
    const requirement = endpointRequirementsForProfile(agentProfilesFor(config).get('cursor')!, config)[0]!;
    async function putCursor(name: string, secret: string) {
      if (mode === 'solo') await setCredential({ set: name }, { provider: 'cursor', kind: 'api-key', secret }, 'file');
      else await putEndpointCredential(root, { userId: `${name}@example.com`, endpointId: requirement.endpointId,
        origin: requirement.scope, provider: 'cursor', kind: 'api-key', token: secret });
    }
    async function select(name: string) {
      if (mode === 'solo') await bindCredentialSet(root, name);
      else await bindTurnCredential(root, { taskId: 'cursor-builder', sessionId: name, ownerUserId: `${name}@example.com`, kind: 'api-key' });
    }
    if (mode === 'member') await setCredentialBillingMode(root);
    await putCursor('personal', 'cursor-personal');
    await putCursor('work', 'cursor-work');
    await select('personal');
    const deps = buildProxyCredentialDeps(root, config, mode === 'member');
    const grant = await mintCredentialGrant(root, { role: 'builder', taskId: null, label: 'source-test', envKey: 'CURSOR_API_KEY', profile: 'cursor', bindingKey: 'cursor-builder' });
    const proxy = createProxyServer({ port: 0, bind: '127.0.0.1', upstream: config.proxy.upstream, cursorUpstream: config.proxy.cursorUpstream, liveAgentRouting: async () => ({ routes: {}, targets: deps.targets, profiles: new Set(['cursor']), config }) }, { append: async () => {} }, deps);
    const call = (path: string, token: string) => fetch(`http://127.0.0.1:${proxy.port}/_lazy/cursor/${grant}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
    });
    try {
      const legacy = derivedPlaceholderFor('legacy-session');
      await bindDerivedCredentials(root, grant, [{ placeholder: legacy, real: 'legacy-session' }]);
      expect((await call('/aiserver.v1.AgentService/Run', legacy)).status).toBe(401);
      expect(seen).toHaveLength(0);
      const personal = await (await call('/auth/exchange_user_api_key', grant)).json() as { accessToken: string };
      expect(personal).not.toHaveProperty('error');
      expect(seen.at(-1)).toBe('Bearer cursor-personal');
      await select('work');
      const count = seen.length;
      expect((await call('/aiserver.v1.AgentService/Run', personal.accessToken)).status).toBe(401);
      expect(seen).toHaveLength(count);
      const work = await (await call('/auth/exchange_user_api_key', grant)).json() as { accessToken: string };
      expect(seen.at(-1)).toBe('Bearer cursor-work');
      await select('personal');
      expect((await call('/aiserver.v1.AgentService/Run', work.accessToken)).status).toBe(401);
      expect((await call('/aiserver.v1.AgentService/Run', personal.accessToken)).status).toBe(200);
      expect(seen.at(-1)).toBe('Bearer session-cursor-personal');
      if (mode === 'solo') {
        process.env.CURSOR_API_KEY = 'cursor-personal';
        expect((await call('/aiserver.v1.AgentService/Run', personal.accessToken)).status).toBe(401);
        delete process.env.CURSOR_API_KEY;
      }
      // Equal secrets do not make two independently selected sets one source.
      await putCursor('work', 'cursor-personal');
      await select('work');
      expect((await call('/aiserver.v1.AgentService/Run', personal.accessToken)).status).toBe(401);
      await select('personal');
      await putCursor('personal', 'cursor-rotated');
      expect((await call('/aiserver.v1.AgentService/Run', personal.accessToken)).status).toBe(401);

    } finally {
      proxy.stop(true);
      upstream.stop(true);
    }
  });

  test('project overrides, removal and unbinding cannot inherit another scope\'s stale copy', async () => {
    const { path, readable } = await failPersonalRead();
    await setCredential(root, { provider: 'openai', kind: 'api-key', secret: 'project-current' }, 'file');
    expect(await resolveCredential(root, 'openai', env)).toMatchObject({ value: 'project-current' });
    await deleteCredential(root, 'openai');
    await expect(resolveCredential(root, 'openai', env)).rejects.toThrow('backend did not return one');
    await writeFile(path, readable);
    expect(await resolveCredential(root, 'openai', env)).toMatchObject({ value: 'personal-rotated', setName: 'personal' });
    await bindCredentialSet(root, null);
    expect(await resolveCredential(root, 'openai', env)).toBeNull();
    env.OPENAI_API_KEY = 'explicit-export';
    expect(await resolveCredential(root, 'openai', env)).toMatchObject({ source: 'env', value: 'explicit-export' });
  });
});
