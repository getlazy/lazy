import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { bindCredentialSet } from '../../src/credentials/set-binding';
import { deleteCredential, getStoredCredential, setCredential } from '../../src/credentials/store';
import { credentialIndexPath, credentialSecretsPath, type CredentialScope } from '../../src/credentials/scope';
import { withCredentialFileLock } from '../../src/credentials/file-updates';
import { __resetRenewedSessionsForTests, resolveChatGptSession } from '../../src/credentials/chatgpt-session';
import { CHATGPT_TOKEN_URL, parseChatGptTokens, serializeChatGptTokens } from '../../src/credentials/chatgpt-tokens';

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

function tokens(refreshToken: string, expiresIn = -60) {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return serializeChatGptTokens({
    accessToken: `${b64({ alg: 'RS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expiresIn })}.sig`,
    refreshToken, accountId: 'fixture-account', idToken: null,
  });
}

describe('credential-set renewal races', () => {
  let ctx: TestContext;
  let temp: string;
  let unpin: () => void;
  let upstream: ReturnType<typeof Bun.serve>;
  let releaseExchange: ReturnType<typeof gate>;
  let exchangeStarted: ReturnType<typeof gate>;
  let releasedLock: ReturnType<typeof gate> | undefined;
  let heldLock: Promise<void> | undefined;
  let calls: string[];
  let renewals: Promise<unknown>[];
  const realFetch = globalThis.fetch;
  const envKeys = ['LAZY_TEST', 'LAZY_IS_DAEMON', 'LAZY_MCP_EXPECTED_TASK_ID', 'LAZY_MCP_EXPECTED_WORKTREE', 'LAZY_TASK', 'CHATGPT_AUTH'];
  let saved: Record<string, string | undefined>;

  beforeEach(async () => {
    saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    temp = await mkdtemp(join(tmpdir(), 'lazy-renewal-race-'));
    unpin = pinDaemonBaseDir(join(temp, 'daemon'));
    ctx = await setupTestLazy({ withDaemon: true, daemonEnv: { CHATGPT_AUTH: '' } });
    const config = join(ctx.root, 'lazy.toml');
    await writeFile(config, (await readFile(config, 'utf8')) + '\n[credentials]\nbackend = "file"\n');
    __resetRenewedSessionsForTests();
    calls = [];
    renewals = [];
    exchangeStarted = gate();
    releaseExchange = gate();
    upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const token = new URLSearchParams(await request.text()).get('refresh_token')!;
      calls.push(token);
      if (calls.length === 1) {
        exchangeStarted.open();
        await releaseExchange.promise;
      }
      const replacement = JSON.parse(tokens(`${token}-rotated`, 3600));
      return Response.json({ access_token: replacement.access_token, refresh_token: replacement.refresh_token });
    } });
    globalThis.fetch = ((input, init) => String(input) === CHATGPT_TOKEN_URL
      ? realFetch(`http://127.0.0.1:${upstream.port}`, init)
      : realFetch(input, init)) as typeof fetch;
    await setCredential({ set: 'personal' }, { provider: 'chatgpt', kind: 'oauth', secret: tokens('shared') }, 'file');
    await bindCredentialSet(ctx.root, 'personal');
  });

  afterEach(async () => {
    releaseExchange?.open();
    releasedLock?.open();
    await heldLock;
    await Promise.allSettled(renewals);
    heldLock = undefined;
    releasedLock = undefined;
    globalThis.fetch = realFetch;
    upstream?.stop(true);
    __resetRenewedSessionsForTests();
    try {
      await ctx?.cleanup();
    } finally {
      unpin?.();
      for (const key of envKeys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      await rm(temp, { recursive: true, force: true });
    }
  });

  function renew(opts: { force?: boolean } = {}) {
    const renewal = resolveChatGptSession(ctx.root, 'chatgpt', opts);
    renewals.push(renewal);
    return renewal;
  }

  async function holdScope(scope: CredentialScope) {
    const acquired = gate();
    releasedLock = gate();
    heldLock = withCredentialFileLock(`${credentialIndexPath(scope)}.refresh`, async () => {
      acquired.open();
      await releasedLock!.promise;
    });
    await acquired.promise;
  }

  async function refreshToken(scope: CredentialScope) {
    return parseChatGptTokens((await getStoredCredential(scope, 'chatgpt'))!.value, 'fixture').refreshToken;
  }

  // INVARIANT: a queued renewal must hold the lock for the credential it will
  // exchange and persist. Falling back under a project lock retires a shared
  // refresh token without saving it, breaking every project using that set.
  test('removing a project override while two renewals queue switches to the shared lock', async () => {
    await setCredential(ctx.root, { provider: 'chatgpt', kind: 'oauth', secret: tokens('project') }, 'file');
    await holdScope({ set: 'personal' });
    const outcomes = Promise.allSettled([renew(), renew()]);
    await exchangeStarted.promise;
    // Leave both callers queued while the provider withholds the first reply.
    await Bun.sleep(100);
    await deleteCredential(ctx.root, 'chatgpt');
    releaseExchange.open();
    await Bun.sleep(100);
    expect(calls).toEqual(['project']); // Shared lock is still held by the test.
    releasedLock!.open();
    const results = await outcomes;
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(calls).toEqual(['project', 'shared']);
    expect(await refreshToken({ set: 'personal' })).toBe('shared-rotated');
    const messages = await ctx.lazy(['messages']);
    expect(messages.exitCode).toBe(0);
    expect(messages.stdout).toContain('A renewed ChatGPT session could not be saved');
    await ctx.restartDaemon({ CHATGPT_AUTH: '' });
    expect((await ctx.lazy(['messages'])).stdout).toContain('A renewed ChatGPT session could not be saved');
  }, 30_000);

  // INVARIANT: adding an override while a shared renewal runs must save that
  // shared rotation, then resolve queued callers under the new project's lock.
  test('adding a project override mid-exchange saves the set and switches queued callers to the project lock', async () => {
    await holdScope(ctx.root);
    const outcomes = Promise.allSettled([renew(), renew()]);
    await exchangeStarted.promise;
    await Bun.sleep(100);
    await setCredential(ctx.root, { provider: 'chatgpt', kind: 'oauth', secret: tokens('project') }, 'file');
    releaseExchange.open();
    await Bun.sleep(100);
    expect(calls).toEqual(['shared']);
    releasedLock!.open();
    const results = await outcomes;
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    expect(calls).toEqual(['shared', 'project']);
    expect(await refreshToken({ set: 'personal' })).toBe('shared-rotated');
    expect(await refreshToken(ctx.root)).toBe('project-rotated');
  }, 30_000);

  // INVARIANT: a failed save after token rotation is durably reported. The next
  // request retries the save before serving tokens, without another exchange.
  test('a failed backend save leaves an alert and retries persistence without rotating again', async () => {
    const scope = { set: 'personal' };
    const path = credentialSecretsPath(scope);
    // A forced renewal also has to retry its save while the old access token
    // is still valid: freshness must not bypass a pending durable write.
    await setCredential(scope, { provider: 'chatgpt', kind: 'oauth', secret: tokens('shared', 3600) }, 'file');
    const outcome = renew({ force: true }).then(value => ({ value }), error => ({ error }));
    await exchangeStarted.promise;
    await rename(path, `${path}.saved`);
    await mkdir(path);
    releaseExchange.open();
    const failed = await outcome;
    expect('error' in failed).toBe(true);
    if ('error' in failed) expect(failed.error.message).toContain('previous refresh token may already be retired');
    expect((await ctx.lazy(['messages'])).stdout).toContain('A renewed ChatGPT session could not be saved');
    await rm(path, { recursive: true });
    await rename(`${path}.saved`, path);
    const retried = await resolveChatGptSession(ctx.root);
    expect(retried?.tokens.refreshToken).toBe('shared-rotated');
    expect(calls).toEqual(['shared']);
    expect(await refreshToken(scope)).toBe('shared-rotated');
  }, 30_000);
  // INVARIANT: completed and pending renewals belong to their selected scope.
  // Switching accounts must neither spend nor persist another scope's tokens.
  test.each(['work', 'shared'])('A to B to A keeps completed renewals scoped when B starts with %s tokens', async other => {
    releaseExchange.open();
    // Copy the exact session: generating it again could change its expiry at
    // a second boundary and accidentally test value isolation instead of scope.
    const secret = other === 'shared' ? (await getStoredCredential({ set: 'personal' }, 'chatgpt'))!.value : tokens(other);
    await setCredential({ set: 'work' }, { provider: 'chatgpt', kind: 'oauth', secret }, 'file');
    expect((await renew())?.tokens.refreshToken).toBe('shared-rotated');
    await bindCredentialSet(ctx.root, 'work');
    expect((await renew())?.tokens.refreshToken).toBe(`${other}-rotated`);
    await bindCredentialSet(ctx.root, 'personal');
    expect((await renew())?.tokens.refreshToken).toBe('shared-rotated');
    expect(calls).toEqual(['shared', other]);
    expect(await refreshToken({ set: 'work' })).toBe(`${other}-rotated`);
  }, 30_000);

  test.each(['work', 'shared'])('a pending replacement for A never crosses a rebind when B starts with %s tokens', async other => {
    // Copy the exact session: generating it again could change its expiry at
    // a second boundary and accidentally test value isolation instead of scope.
    const secret = other === 'shared' ? (await getStoredCredential({ set: 'personal' }, 'chatgpt'))!.value : tokens(other);
    await setCredential({ set: 'work' }, { provider: 'chatgpt', kind: 'oauth', secret }, 'file');
    const path = credentialSecretsPath({ set: 'personal' });
    const outcome = renew().then(value => ({ value }), error => ({ error }));
    await exchangeStarted.promise;
    await rename(path, `${path}.saved`);
    await mkdir(path);
    releaseExchange.open();
    expect('error' in await outcome).toBe(true);
    await rm(path, { recursive: true });
    await rename(`${path}.saved`, path);
    await bindCredentialSet(ctx.root, 'work');
    expect((await renew())?.tokens.refreshToken).toBe(`${other}-rotated`);
    expect(await refreshToken({ set: 'personal' })).toBe('shared');
    await bindCredentialSet(ctx.root, 'personal');
    expect((await renew())?.tokens.refreshToken).toBe('shared-rotated');
    expect(await refreshToken({ set: 'work' })).toBe(`${other}-rotated`);
    expect(calls).toEqual(['shared', other]);
  }, 30_000);

});
