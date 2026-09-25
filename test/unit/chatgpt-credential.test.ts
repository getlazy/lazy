import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  accessTokenExpiry,
  needsRefresh,
  parseChatGptTokens,
  serializeChatGptTokens,
  refreshChatGptTokens,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_TOKEN_URL,
  REFRESH_TIMEOUT_MS,
} from '../../src/credentials/chatgpt-tokens';
import {
  resolveChatGptSession,
  __resetRenewedSessionsForTests,
} from '../../src/credentials/chatgpt-session';
import {
  hydrateCredentialEnv,
  assertStoredCredentialsReachedEnv,
} from '../../src/credentials/hydrate';
import { setCredential, getStoredCredential } from '../../src/credentials/store';
import {
  credentialKinds,
  credentialSelfRefreshing,
  credentialSetupCommand,
  envVarFor,
  envVarsFor,
  isProvider,
  namedCredentialEnvVar,
  PROVIDERS,
} from '../../src/credentials/providers';
import { isCredentialEnvKey } from '../../src/utils/redact';
import { defaultCredentialFor } from '../../src/config/agent-profiles';
import { isChatGptEndpoint, CHATGPT_CODEX_UPSTREAM } from '../../src/utils/openai-compat';
import { chatGptPlacement, CHATGPT_ACCOUNT_HEADER } from '../../src/proxy/target-credentials';
import { applyCredential } from '../../src/proxy/inject';
import { classifyOpenAIEndpoint } from '../../src/proxy/openai-extractor';
import { decideProxyPath } from '../../src/proxy/path-allowlist';

// ---------------------------------------------------------------------------
// Fixtures. The auth.json shape below is what codex-cli 0.152.1 actually writes
// and accepts — probed against the real binary (`codex login status` reports
// "Logged in using ChatGPT" for exactly this), not copied from documentation.
// ---------------------------------------------------------------------------

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: unknown): string =>
  `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.sig`;

function accessToken(expiresInSeconds: number, accountId = 'acct-abc'): string {
  return jwt({
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  });
}

function codexAuthJson(overrides: Record<string, unknown> = {}): string {
  const { tokens: _tokenOverrides, ...topLevel } = overrides;
  return JSON.stringify(
    {
      auth_mode: 'chatgpt',
      ...topLevel,
      tokens: {
        id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-abc' } }),
        access_token: accessToken(3600),
        refresh_token: 'rt-original',
        account_id: 'acct-abc',
        ...((_tokenOverrides as Record<string, unknown>) ?? {}),
      },
      last_refresh: '2026-09-13T00:00:00.000Z',
    },
    null,
    2,
  );
}

describe('chatgpt token parsing', () => {
  test('reads a verbatim ~/.codex/auth.json', () => {
    const tokens = parseChatGptTokens(codexAuthJson(), 'fixture');
    expect(tokens.refreshToken).toBe('rt-original');
    expect(tokens.accountId).toBe('acct-abc');
    expect(tokens.accessToken.split('.')).toHaveLength(3);
  });

  test('round-trips through the store shape', () => {
    const tokens = parseChatGptTokens(codexAuthJson(), 'fixture');
    const serialized = serializeChatGptTokens(tokens);
    // INVARIANT: the stored form is SINGLE-LINE. setCredential refuses a secret
    // containing a line break (an embedded newline is a command-injection hazard
    // in the OS credential tools), and a codex auth.json is pretty-printed — so
    // compacting is a requirement of the store, not a formatting preference.
    expect(serialized).not.toContain('\n');
    expect(parseChatGptTokens(serialized, 'round-trip')).toEqual(tokens);
  });

  test('the account id falls back to the token claims when the file omits it', () => {
    const raw = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: accessToken(3600, 'acct-from-claims'), refresh_token: 'rt' },
    });
    expect(parseChatGptTokens(raw, 'fixture').accountId).toBe('acct-from-claims');
  });

  // INVARIANT: a credential that is PRESENT but wrong throws; it never reads as
  // absent. "No ChatGPT credential" sends a user to `codex login`, which is the
  // wrong instruction — and an actively misleading one — when what they actually
  // have is an API-key auth.json or a session with no refresh token.
  test('an api-key auth.json is refused, naming the right command', () => {
    const raw = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' });
    expect(() => parseChatGptTokens(raw, 'fixture')).toThrow(/lazy auth set openai/);
  });

  test('a session with no refresh token is refused', () => {
    const raw = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: accessToken(3600) } });
    expect(() => parseChatGptTokens(raw, 'fixture')).toThrow(/refresh_token/);
  });

  test('malformed JSON is refused with the source named', () => {
    expect(() => parseChatGptTokens('{not json', 'the piped input')).toThrow(/the piped input/);
  });
});

describe('chatgpt token expiry', () => {
  test('reads exp out of the access token', () => {
    const expiry = accessTokenExpiry(accessToken(3600));
    expect(expiry).not.toBeNull();
    expect(expiry! - Date.now()).toBeGreaterThan(3000 * 1000);
  });

  test('a live token is not refreshed; one inside the skew window is', () => {
    const live = parseChatGptTokens(codexAuthJson(), 'fixture');
    expect(needsRefresh(live)).toBe(false);

    const expiring = { ...live, accessToken: accessToken(60) };
    expect(needsRefresh(expiring)).toBe(true);
  });

  // INVARIANT: a token that does not say when it expires is refreshed rather
  // than presented hopefully. One extra round trip is the cost; the alternative
  // is a dead token upstream and a 401 the user cannot act on.
  test('a token with no readable expiry is treated as needing refresh', () => {
    const tokens = parseChatGptTokens(
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'opaque', refresh_token: 'rt' } }),
      'fixture',
    );
    expect(accessTokenExpiry('opaque')).toBeNull();
    expect(needsRefresh(tokens)).toBe(true);
  });
});

describe('chatgpt provider registration', () => {
  test('chatgpt is a provider with only an oauth kind', () => {
    expect(isProvider('chatgpt')).toBe(true);
    expect(PROVIDERS).toContain('chatgpt');
    expect(credentialKinds('chatgpt')).toEqual(['oauth']);
    expect(envVarFor('chatgpt', 'api-key')).toBeNull();
    expect(envVarFor('chatgpt', 'oauth')).toBe('CHATGPT_AUTH');
  });

  // INVARIANT: every env var that can carry a credential must be recognised by
  // the redaction rule. The two tables are in different modules and nothing tied
  // them together, so `CHATGPT_AUTH_JSON` — ending in a word the name-shape rule
  // does not cover — shipped exempt from log redaction and from the argv
  // scrubbing that keeps real secrets out of container command lines. Asserted
  // over ALL providers, and over a named credential's generated spellings, so
  // the next provider added cannot repeat it.
  test('every credential env var is recognised as one by the redaction rule', () => {
    const offenders: string[] = [];
    for (const provider of PROVIDERS) {
      for (const envVar of envVarsFor(provider)) {
        if (!isCredentialEnvKey(envVar)) offenders.push(`${provider}: ${envVar}`);
      }
    }
    for (const kind of ['api-key', 'oauth'] as const) {
      const envVar = namedCredentialEnvVar('work-openai', kind);
      if (!isCredentialEnvKey(envVar)) offenders.push(`named/${kind}: ${envVar}`);
    }
    expect(offenders).toEqual([]);
  });

  // A credential lazy RENEWS must not be hydrated into the daemon's env: its own
  // hydrated copy would read back as a user export, so the renewed secret would
  // not be written back — while the renewal had already retired the stored one.
  test('the ChatGPT session is marked self-refreshing; nothing else is', () => {
    expect(credentialSelfRefreshing('chatgpt')).toBe(true);
    for (const provider of PROVIDERS.filter((p) => p !== 'chatgpt')) {
      expect(credentialSelfRefreshing(provider)).toBe(false);
    }
    expect(credentialSelfRefreshing('work-openai')).toBe(false);
  });

  test('the setup command is import, not set', () => {
    // `lazy auth set chatgpt` would mean pasting a JSON session at a masked
    // prompt; the file already exists after `codex login`.
    expect(credentialSetupCommand('chatgpt')).toBe('auth import chatgpt');
    expect(credentialSetupCommand('openai')).toBe('auth set openai');
  });

  // INVARIANT: the ChatGPT backend bills a SUBSCRIPTION, so a profile pointed
  // there must not default to the metered `openai` API key. Getting this wrong
  // spends the wrong credential (or, more often, reports a missing API key while
  // a paid-for subscription sits unused).
  test('a chatgpt.com endpoint defaults to the chatgpt credential', () => {
    expect(isChatGptEndpoint(CHATGPT_CODEX_UPSTREAM)).toBe(true);
    expect(defaultCredentialFor('codex', 'openai', CHATGPT_CODEX_UPSTREAM)).toBe('chatgpt');
    // Everything else is unchanged.
    expect(defaultCredentialFor('codex', 'openai', 'https://api.openai.com')).toBe('openai');
    expect(defaultCredentialFor('codex', 'openai', '')).toBe('openai');
  });
});

describe('chatgpt proxy presentation', () => {
  test('the token and its account header travel together', () => {
    const headers = new Headers({ authorization: 'Bearer lazy-placeholder-1' });
    applyCredential(
      headers,
      [{ header: 'authorization', raw: 'Bearer lazy-placeholder-1', value: 'lazy-placeholder-1' }],
      'lazy-placeholder-1',
      chatGptPlacement('real-access-token', 'acct-abc'),
    );
    expect(headers.get('authorization')).toBe('Bearer real-access-token');
    expect(headers.get(CHATGPT_ACCOUNT_HEADER)).toBe('acct-abc');
  });

  // INVARIANT: the HOST's account id wins. The container holds a placeholder and
  // cannot know which real credential sits behind it, so it cannot know the
  // right account either — anything it sent under this name is a guess.
  test('a container-sent account header is overwritten', () => {
    const headers = new Headers({
      authorization: 'Bearer lazy-placeholder-1',
      [CHATGPT_ACCOUNT_HEADER]: 'acct-guessed-by-the-container',
    });
    applyCredential(
      headers,
      [{ header: 'authorization', raw: 'Bearer lazy-placeholder-1', value: 'lazy-placeholder-1' }],
      'lazy-placeholder-1',
      chatGptPlacement('real-access-token', 'acct-real'),
    );
    expect(headers.get(CHATGPT_ACCOUNT_HEADER)).toBe('acct-real');
  });

  // INVARIANT: with no account id the header is DELETED, not left alone. The
  // proxy forwards every client header through, so omitting the host's answer
  // would leave the container's — letting an agent pair the user's real bearer
  // with an account of its own choosing. Attribution is the host's answer or it
  // is nothing.
  test('no account id DELETES the header, including one the container sent', () => {
    const headers = new Headers({
      authorization: 'Bearer lazy-placeholder-1',
      [CHATGPT_ACCOUNT_HEADER]: 'acct-chosen-by-the-agent',
    });
    applyCredential(
      headers,
      [{ header: 'authorization', raw: 'Bearer lazy-placeholder-1', value: 'lazy-placeholder-1' }],
      'lazy-placeholder-1',
      chatGptPlacement('real-access-token', null),
    );
    expect(headers.has(CHATGPT_ACCOUNT_HEADER)).toBe(false);
    // The credential itself still went out — the turn is refused upstream on
    // attribution grounds if at all, not silently unauthenticated here.
    expect(headers.get('authorization')).toBe('Bearer real-access-token');
  });

  test('the refresh endpoint and client id are codex\'s own', () => {
    // Read out of the shipped codex-cli 0.152.1 binary. A refresh is only ever
    // accepted for the client the token was issued to, so these are not choices.
    expect(CHATGPT_TOKEN_URL).toBe('https://auth.openai.com/oauth/token');
    expect(CHATGPT_OAUTH_CLIENT_ID).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
  });
});

describe('chatgpt proxy routing', () => {
  // INVARIANT: both spellings of the OpenAI-wire paths classify the same. The
  // ChatGPT backend serves the Responses API at <base>/responses with no /v1,
  // and classification is what decides whether usage is extracted — so matching
  // only the prefixed spelling would forward subscription turns correctly and
  // then audit them with no token counts at all.
  test('the /v1-less Responses path is classified and allowed on the openai tier', () => {
    expect(classifyOpenAIEndpoint('/responses')).toBe('responses');
    expect(classifyOpenAIEndpoint('/v1/responses')).toBe('responses');
    expect(classifyOpenAIEndpoint('/chat/completions')).toBe('chat_completions');

    expect(decideProxyPath('POST', '/responses', 'openai').allowed).toBe(true);
    expect(decideProxyPath('GET', '/models', 'openai').allowed).toBe(true);
  });

  // INVARIANT: the new spellings stay on the openai tier. The primary and role
  // tiers are Anthropic-wire; widening them would hand an Anthropic-credentialed
  // upstream a path nothing on that tier has any inference use for.
  test('the unprefixed paths are refused on the anthropic tiers', () => {
    expect(decideProxyPath('POST', '/responses', 'primary').allowed).toBe(false);
    expect(decideProxyPath('POST', '/responses', 'role').allowed).toBe(false);
    expect(decideProxyPath('GET', '/models', 'role').allowed).toBe(false);
  });

  test('an unrelated unprefixed path is still refused everywhere', () => {
    expect(decideProxyPath('GET', '/account', 'openai').allowed).toBe(false);
    expect(decideProxyPath('POST', '/billing', 'openai').allowed).toBe(false);
  });
});

describe('resolveChatGptSession', () => {
  let root: string;
  const savedEnv = process.env.CHATGPT_AUTH;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-chatgpt-'));
    await mkdir(join(root, '.lazy'), { recursive: true });
    await writeFile(
      join(root, 'lazy.toml'),
      '[credentials]\nbackend = "file"\n',
      'utf-8',
    );
    delete process.env.CHATGPT_AUTH;
    // Renewed sessions are process-lifetime state; one test's renewal must not
    // be served to the next.
    __resetRenewedSessionsForTests();
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.CHATGPT_AUTH;
    else process.env.CHATGPT_AUTH = savedEnv;
    await rm(root, { recursive: true, force: true });
  });

  test('an unset credential resolves to null, not an error', async () => {
    expect(await resolveChatGptSession(root, 'chatgpt')).toBeNull();
  });

  test('a live stored session is returned without refreshing', async () => {
    const tokens = parseChatGptTokens(codexAuthJson(), 'fixture');
    await setCredential(
      root,
      { provider: 'chatgpt', kind: 'oauth', secret: serializeChatGptTokens(tokens) },
      'file',
    );
    const session = await resolveChatGptSession(root, 'chatgpt');
    expect(session?.refreshed).toBe(false);
    expect(session?.tokens.refreshToken).toBe('rt-original');
    expect(session?.source).toBe('store');
  });

  // INVARIANT: a refresh ROTATES the refresh token, so the rotated one is
  // persisted BEFORE it is handed out. The old one is already dead upstream at
  // that point; failing to record the replacement is the one outcome that loses
  // the user's session entirely.
  test('an expiring session is refreshed and the rotated token is written back', async () => {
    const tokens = parseChatGptTokens(codexAuthJson({ tokens: { access_token: accessToken(30) } }), 'fixture');
    await setCredential(
      root,
      { provider: 'chatgpt', kind: 'oauth', secret: serializeChatGptTokens(tokens) },
      'file',
    );

    const realFetch = globalThis.fetch;
    let calls = 0;
    let sentBody = '';
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      sentBody = String(init?.body ?? '');
      expect(String(url)).toBe(CHATGPT_TOKEN_URL);
      return new Response(
        JSON.stringify({ access_token: accessToken(3600), refresh_token: 'rt-rotated' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    try {
      // Two concurrent callers: the refresh must happen ONCE. Two would each
      // invalidate the other's rotated token and log the user out.
      const [a, b] = await Promise.all([
        resolveChatGptSession(root, 'chatgpt'),
        resolveChatGptSession(root, 'chatgpt'),
      ]);
      expect(calls).toBe(1);
      expect(sentBody).toContain(`client_id=${CHATGPT_OAUTH_CLIENT_ID}`);
      expect(sentBody).toContain('grant_type=refresh_token');
      expect(sentBody).toContain('refresh_token=rt-original');
      expect([a!.tokens.refreshToken, b!.tokens.refreshToken]).toEqual(['rt-rotated', 'rt-rotated']);

      const stored = await getStoredCredential(root, 'chatgpt');
      expect(parseChatGptTokens(stored!.value, 'stored').refreshToken).toBe('rt-rotated');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // INVARIANT: a refresh response that omits `refresh_token` means "keep using
  // the one you have". Dropping it would log the user out on the NEXT refresh,
  // one step removed from the code that caused it.
  test('a refresh response without a new refresh token keeps the old one', async () => {
    const tokens = parseChatGptTokens(codexAuthJson({ tokens: { access_token: accessToken(30) } }), 'fixture');
    await setCredential(
      root,
      { provider: 'chatgpt', kind: 'oauth', secret: serializeChatGptTokens(tokens) },
      'file',
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: accessToken(3600) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    try {
      const session = await resolveChatGptSession(root, 'chatgpt');
      expect(session?.tokens.refreshToken).toBe('rt-original');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('a refused refresh throws with the remedy, leaving the stored session alone', async () => {
    const tokens = parseChatGptTokens(codexAuthJson({ tokens: { access_token: accessToken(30) } }), 'fixture');
    await setCredential(
      root,
      { provider: 'chatgpt', kind: 'oauth', secret: serializeChatGptTokens(tokens) },
      'file',
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"error":"invalid_grant"}', { status: 400 })) as unknown as typeof fetch;
    try {
      await expect(resolveChatGptSession(root, 'chatgpt')).rejects.toThrow(/codex login/);
      const stored = await getStoredCredential(root, 'chatgpt');
      expect(parseChatGptTokens(stored!.value, 'stored').refreshToken).toBe('rt-original');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // INVARIANT: hydration never copies a SELF-REFRESHING credential into the
  // daemon's environment. It did, and the effect was silent destruction of the
  // user's login: hydration's own copy read back as a user export, so the
  // renewed session was not persisted — while the renewal had already retired
  // the stored refresh token upstream. One turn's worth of working, then a dead
  // credential that only a fresh `codex login` could fix.
  test('a stored ChatGPT session is not hydrated into the environment', async () => {
    await writeFile(
      join(root, 'lazy.toml'),
      '[credentials]\nbackend = "file"\n\n[agents.codex-sub]\nharness = "codex"\n' +
      'model = "gpt-5.6-sol"\nendpoint = "https://chatgpt.com/backend-api/codex"\n\n' +
      '[agent]\nagent_id = "codex-sub"\n',
      'utf-8',
    );
    const tokens = parseChatGptTokens(codexAuthJson(), 'fixture');
    await setCredential(
      root,
      { provider: 'chatgpt', kind: 'oauth', secret: serializeChatGptTokens(tokens) },
      'file',
    );

    const env: NodeJS.ProcessEnv = {};
    const hydrated = await hydrateCredentialEnv(root, env);
    expect(hydrated.map((h) => h.provider)).not.toContain('chatgpt');
    expect(env.CHATGPT_AUTH).toBeUndefined();

    // And the daemon must still START: "stored but not in the environment" is
    // this credential's correct state, not an unkept promise from the store.
    await assertStoredCredentialsReachedEnv(root, undefined, env);

    // The proxy reaches it through the store regardless, which is why skipping
    // hydration costs nothing.
    const session = await resolveChatGptSession(root, 'chatgpt');
    expect(session?.source).toBe('store');
    expect(session?.tokens.refreshToken).toBe('rt-original');
  });

  // INVARIANT: the environment wins over the store, as for every credential —
  // and lazy refreshes it in memory but must NOT write it back. Silently moving
  // a credential out of the variable the user exported and into the store is
  // exactly the hidden side effect CLAUDE.md forbids.
  test('the env var overrides the store and is never written back', async () => {
    const stored = parseChatGptTokens(codexAuthJson(), 'fixture');
    await setCredential(
      root,
      { provider: 'chatgpt', kind: 'oauth', secret: serializeChatGptTokens(stored) },
      'file',
    );
    const fromEnv = { ...stored, refreshToken: 'rt-from-env', accessToken: accessToken(30) };
    process.env.CHATGPT_AUTH = serializeChatGptTokens(fromEnv);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: accessToken(3600), refresh_token: 'rt-env-rotated' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    try {
      const session = await resolveChatGptSession(root, 'chatgpt');
      expect(session?.source).toBe('env');
      expect(session?.tokens.refreshToken).toBe('rt-env-rotated');
      // The STORE is untouched.
      const onDisk = await getStoredCredential(root, 'chatgpt');
      expect(parseChatGptTokens(onDisk!.value, 'stored').refreshToken).toBe('rt-original');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // INVARIANT: an env-sourced session is refreshed ONCE per token lifetime, not
  // once per request. The env var cannot be written back, so without somewhere
  // to keep the renewal every request re-read the same stale value and
  // presented the ALREADY-RETIRED refresh token again: one working turn, then
  // 401s, while hammering the OAuth endpoint at request rate.
  test('an env session is refreshed once and then served from memory', async () => {
    const fromEnv = {
      ...parseChatGptTokens(codexAuthJson(), 'fixture'),
      refreshToken: 'rt-env-original',
      accessToken: accessToken(30),
    };
    process.env.CHATGPT_AUTH = serializeChatGptTokens(fromEnv);

    const realFetch = globalThis.fetch;
    let calls = 0;
    const sentRefreshTokens: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls += 1;
      sentRefreshTokens.push(
        new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? '',
      );
      return new Response(
        JSON.stringify({ access_token: accessToken(3600), refresh_token: `rt-rotated-${calls}` }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    try {
      const first = await resolveChatGptSession(root, 'chatgpt');
      expect(first?.refreshed).toBe(true);

      // Three further sequential requests: none of them refreshes again.
      for (let i = 0; i < 3; i++) {
        const again = await resolveChatGptSession(root, 'chatgpt');
        expect(again?.refreshed).toBe(false);
        expect(again?.tokens.refreshToken).toBe('rt-rotated-1');
      }
      expect(calls).toBe(1);
      // And the one refresh that happened used the token the user exported —
      // never a retired one.
      expect(sentRefreshTokens).toEqual(['rt-env-original']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // The renewal is keyed on the SOURCE VALUE, so re-exporting a freshly imported
  // session is honoured rather than shadowed by what lazy renewed from the old
  // one — otherwise "log in again and export it" would not fix anything.
  test('re-exporting a new session invalidates the renewed one', async () => {
    process.env.CHATGPT_AUTH = serializeChatGptTokens({
      ...parseChatGptTokens(codexAuthJson(), 'fixture'),
      refreshToken: 'rt-first',
      accessToken: accessToken(30),
    });

    const realFetch = globalThis.fetch;
    const sentRefreshTokens: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      sentRefreshTokens.push(
        new URLSearchParams(String(init?.body ?? '')).get('refresh_token') ?? '',
      );
      return new Response(
        JSON.stringify({ access_token: accessToken(3600), refresh_token: 'rt-rotated' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    try {
      await resolveChatGptSession(root, 'chatgpt');

      // The user logs in again and exports the new session.
      process.env.CHATGPT_AUTH = serializeChatGptTokens({
        ...parseChatGptTokens(codexAuthJson(), 'fixture'),
        refreshToken: 'rt-second',
        accessToken: accessToken(30),
      });
      const after = await resolveChatGptSession(root, 'chatgpt');
      expect(after?.refreshed).toBe(true);
      expect(sentRefreshTokens).toEqual(['rt-first', 'rt-second']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // INVARIANT: the refresh is BOUNDED. Refreshes are serialized per credential,
  // so a hung token endpoint would hold the chain open and every later codex
  // turn in the project would queue behind it — a transient upstream stall
  // turned into a permanently wedged daemon. One failed turn is the right blast
  // radius, and the message has to name the timeout or it reads as a local
  // network fault.
  test('a hung token endpoint fails the turn instead of wedging the daemon', async () => {
    const tokens = parseChatGptTokens(codexAuthJson({ tokens: { access_token: accessToken(30) } }), 'fixture');

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      // Never resolves on its own — only the caller's own signal ends this.
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        expect(signal, 'the refresh must pass an abort signal').toBeDefined();
        signal!.addEventListener('abort', () => reject(signal!.reason));
      });
    }) as unknown as typeof fetch;

    try {
      // The BOUND is injected, so this asserts "it gave up on its own signal" in
      // milliseconds rather than paying the real 20s on every run. The production
      // default is asserted separately, below.
      const start = Date.now();
      await expect(refreshChatGptTokens(tokens, 25)).rejects.toThrow(/did not respond within 25ms/);
      expect(Date.now() - start).toBeLessThan(5_000);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // The bound that actually ships. Injectability exists for the test above; it
  // must not become a way for the real timeout to drift or disappear unnoticed.
  test('the shipped refresh bound is finite and not absurd', () => {
    expect(REFRESH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(REFRESH_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
