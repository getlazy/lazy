/**
 * Per-user credentials, end to end: control plane → launch env → proxy → upstream.
 *
 * This composes the REAL modules of every stage — `handlePutUserCredential` to
 * store, `planTurnCredential` + `sessionCredentialEnvFor` to decide and mint,
 * `getAuthEnvVars` (the launch path in src/capture/claude.ts) to build the env a
 * container is created with, the real proxy with the real resolver, and a fake
 * upstream that reports the headers it received.
 *
 * The one thing it does NOT do is run Docker: the agent container is the seam
 * being modelled, not the thing under test, so the test plays Claude Code's part
 * — read the credential env var, emit the request shape that env var implies.
 * Every decision in the chain is real; only the process boundary is simulated.
 *
 * What it proves:
 *   - a container is launched with a placeholder, never a real secret;
 *   - the upstream receives the OWNER's real token, in the header the request
 *     arrived in;
 *   - a token whose turn has ended is refused with 401 — the container still
 *     holds it, and it buys nothing;
 *   - a request whose shape disagrees with the owner's credential kind is a
 *     loud 401, not a guess;
 *   - a single-user install (no per-user credentials stored) is untouched: the
 *     daemon's own credential goes into the container env and out to the
 *     upstream exactly as before.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { createProxyServer } from '../../src/proxy/server';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';
import { getAuthEnvVars } from '../../src/capture/claude';
import { ANTHROPIC_DEFAULT_TARGET } from '../../src/utils/role-target';
import { handlePutUserCredential } from '../../src/daemon/rpc-handlers';
import { clearUserCredentialCache } from '../../src/daemon/user-credentials';
import { clearSessionCredentialCache, isSessionPlaceholderToken } from '../../src/daemon/session-credentials';
import {
  planTurnCredential,
  sessionCredentialEnvFor,
  createSessionCredentialResolver,
  releaseTurnCredential,
} from '../../src/daemon/turn-credentials';
import { runAsTurnOwnerRequest } from '../../src/daemon/turn-owner';

const CONTROL = { kind: 'control' } as const;
const TASK = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SESSION = 'sess-1';

type Forwarded = { headers: Record<string, string> } | null;

describe('per-user credentials end to end', () => {
  let root: string;
  let base: string;
  let unpin: () => void;
  let upstream: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyUrl: string;
  let records: ProxyAuditRecord[];
  let forwarded: Forwarded = null;
  const savedEnv = {
    oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    apiKey: process.env.ANTHROPIC_API_KEY,
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-percred-'));
    base = await mkdtemp(join(tmpdir(), 'lzd-percred-'));
    unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
    clearSessionCredentialCache();

    // The daemon's own credential — what a single-user install runs on.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'daemon-own-oauth';
    delete process.env.ANTHROPIC_API_KEY;

    forwarded = null;
    // Port 0 = let the OS pick a free one, rather than gambling on a window.
    upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });
        forwarded = { headers };
        await req.text().catch(() => '');
        return Response.json({ type: 'message', model: 'test' });
      },
    });

    records = [];
    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    proxy = createProxyServer(
      {
        port: 0,
        bind: '127.0.0.1',
        upstream: `http://127.0.0.1:${upstream.port}`,
        resolveSessionCredential: createSessionCredentialResolver(root),
      },
      sink,
      // No credential broker: these tests exercise the per-user session swap,
      // not JIT injection.
      null,
    );
    proxyUrl = `http://127.0.0.1:${proxy.port}`;
    await new Promise((r) => setTimeout(r, 50));
  });

  afterEach(async () => {
    upstream.stop();
    proxy.stop();
    unpin();
    clearUserCredentialCache();
    clearSessionCredentialCache();
    if (savedEnv.oauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedEnv.oauth;
    if (savedEnv.apiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedEnv.apiKey;
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  /**
   * Plan the task's turn as the request `email` sent. A turn has an owner only
   * inside the request that asked for it (src/daemon/turn-owner.ts).
   */
  function planAs(email: string): ReturnType<typeof planTurnCredential> {
    return runAsTurnOwnerRequest(
      { taskId: TASK, owner: { email, spendable: true } },
      () => planTurnCredential(root, { taskId: TASK, sessionId: SESSION }),
    );
  }

  /** The env a task container would be created with, via the real launch path. */
  async function containerEnv(taskId: string): Promise<Record<string, string>> {
    const override = await sessionCredentialEnvFor(root, taskId);
    const vars = getAuthEnvVars(
      { ...ANTHROPIC_DEFAULT_TARGET, proxyUrl },
      { role: 'agent', taskId: 'e2e' },
      'container',
      override,
    );
    return Object.fromEntries(vars.map((v) => [v.key, v.value]));
  }

  /**
   * Claude Code's part: derive the request shape from the credential env var it
   * finds, exactly as the client does — that derivation is the whole reason the
   * placeholder's kind mirrors the owner's.
   */
  async function agentRequest(env: Record<string, string>, force?: 'bearer' | 'x-api-key') {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const form = force ?? (env.CLAUDE_CODE_OAUTH_TOKEN ? 'bearer' : 'x-api-key');
    const token = env.CLAUDE_CODE_OAUTH_TOKEN ?? env.ANTHROPIC_API_KEY!;
    if (form === 'bearer') headers.authorization = `Bearer ${token}`;
    else headers['x-api-key'] = token;

    forwarded = null;
    const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [], max_tokens: 16 }),
    });
    await new Promise((r) => setTimeout(r, 50)); // audit queue flush
    return res;
  }

  test('an OAuth owner: placeholder in the container, real token at the upstream', async () => {
    await handlePutUserCredential(root, { userId: 'alice', kind: 'oauth', token: 'alice-real-oat' }, CONTROL);
    const plan = await planAs('alice');
    expect(plan.mode).toBe('session');

    const env = await containerEnv(TASK);
    // The container holds a placeholder and nothing else. This is the feature.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeDefined();
    expect(isSessionPlaceholderToken(env.CLAUDE_CODE_OAUTH_TOKEN!)).toBe(true);
    expect(JSON.stringify(env)).not.toContain('alice-real-oat');
    expect(JSON.stringify(env)).not.toContain('daemon-own-oauth');

    const res = await agentRequest(env);
    expect(res.status).toBe(200);
    expect(forwarded!.headers['authorization']).toBe('Bearer alice-real-oat');
    expect(records.at(-1)!.userId).toBe('alice');
  });

  test('an API-key owner gets the x-api-key shape all the way through', async () => {
    await handlePutUserCredential(root, { userId: 'bob', kind: 'api-key', token: 'bob-real-key' }, CONTROL);
    await planAs('bob');

    const env = await containerEnv(TASK);
    expect(isSessionPlaceholderToken(env.ANTHROPIC_API_KEY!)).toBe(true);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    const res = await agentRequest(env);
    expect(res.status).toBe(200);
    expect(forwarded!.headers['x-api-key']).toBe('bob-real-key');
    expect(forwarded!.headers['authorization']).toBeUndefined();
    expect(records.at(-1)!.userId).toBe('bob');
  });

  // INVARIANT: the placeholder is bound to a TURN. When the turn's process
  // exits the binding is revoked, and the token the container still holds stops
  // buying anything.
  test('a placeholder from a finished turn is refused with 401', async () => {
    await handlePutUserCredential(root, { userId: 'alice', kind: 'oauth', token: 'alice-real-oat' }, CONTROL);
    await planAs('alice');
    const env = await containerEnv(TASK);

    expect((await agentRequest(env)).status).toBe(200);

    await releaseTurnCredential(root, TASK);

    const res = await agentRequest(env);
    expect(res.status).toBe(401);
    expect(forwarded).toBeNull(); // never reached the upstream
    expect(records.at(-1)!.authDenial).toBe('unknown_session_token');
  });

  // INVARIANT: form/kind disagreement is refused, never fixed up.
  test('a request whose shape disagrees with the owner credential is refused', async () => {
    await handlePutUserCredential(root, { userId: 'alice', kind: 'oauth', token: 'alice-real-oat' }, CONTROL);
    await planAs('alice');
    const env = await containerEnv(TASK);

    // A client that sent the OAuth placeholder as an API key.
    const res = await agentRequest(
      { ...env, ANTHROPIC_API_KEY: env.CLAUDE_CODE_OAUTH_TOKEN! },
      'x-api-key',
    );
    expect(res.status).toBe(401);
    expect(forwarded).toBeNull();
    expect(records.at(-1)!.authDenial).toBe('auth_kind_mismatch');
    expect(records.at(-1)!.userId).toBe('alice');
  });

  // INVARIANT — THE ADDITIVITY REQUIREMENT. With no per-user credential stored,
  // nothing above happens: the daemon's own credential goes into the container
  // and out to the upstream, exactly as it did before this feature existed.
  test('a single-user install is untouched', async () => {
    const env = await containerEnv(TASK);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('daemon-own-oauth');
    expect(isSessionPlaceholderToken(env.CLAUDE_CODE_OAUTH_TOKEN!)).toBe(false);

    const res = await agentRequest(env);
    expect(res.status).toBe(200);
    expect(forwarded!.headers['authorization']).toBe('Bearer daemon-own-oauth');
    expect(records.at(-1)!.userId ?? null).toBeNull();
  });
});
