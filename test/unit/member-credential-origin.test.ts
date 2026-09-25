/**
 * A member terminal's placeholder is honoured only from its own container.
 *
 * INVARIANT: a member's placeholder is pinned at launch to the network address
 * of the container it was minted for, and the proxy refuses it — 401, audited
 * as `session_token_wrong_origin`, logged loudly — from any other address.
 * Defence in depth behind the lazy-built member home: should the value leak
 * out of the member's container anyway (a turn reading it off the worktree),
 * it spends nobody's account anywhere else.
 *
 * Real proxy, real daemon-side resolver, real binding registry; only the
 * upstream is a stub. Requests come from 127.0.0.1, so pinning to that address
 * is the "own container" case and any other address is the leak.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProxyServer } from '../../src/proxy/server';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';
import { createSessionCredentialResolver, planTurnCredential } from '../../src/daemon/turn-credentials';
import { putUserCredential, clearUserCredentialCache } from '../../src/daemon/user-credentials';
import { clearSessionCredentialCache, setSessionBindingOrigin } from '../../src/daemon/session-credentials';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';

describe("a member placeholder's origin pin", () => {
  let root: string;
  let base: string;
  let unpin: () => void;
  let upstream: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let forwarded: string | null;
  const records: ProxyAuditRecord[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'member-origin-'));
    base = await mkdtemp(join(tmpdir(), 'lzd-member-origin-'));
    unpin = pinDaemonBaseDir(base);
    clearUserCredentialCache();
    clearSessionCredentialCache();
    await putUserCredential(root, { userId: 'alice@example.com', kind: 'api-key', token: 'sk-ant-api-alice-real' } as never);
    forwarded = null;
    records.length = 0;
    upstream = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(req) {
        forwarded = req.headers.get('x-api-key');
        await req.text().catch(() => '');
        return Response.json({ type: 'message', model: 'test' });
      },
    });
    const sink: AuditSink = { append: async (r: ProxyAuditRecord) => { records.push(r); } };
    proxy = createProxyServer(
      { port: 0, bind: '127.0.0.1', upstream: `http://127.0.0.1:${upstream.port}`, resolveSessionCredential: createSessionCredentialResolver(root) },
      sink,
      null,
    );
  });

  afterEach(async () => {
    upstream.stop();
    proxy.stop();
    unpin();
    clearUserCredentialCache();
    clearSessionCredentialCache();
    await rm(root, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  async function memberPlaceholder(origin: string | null): Promise<string> {
    const key = 'member-exec:task-1:abc';
    const plan = await planTurnCredential(root, { taskId: key, sessionId: 's1', spender: { email: 'alice@example.com' } });
    if (plan.mode !== 'session') throw new Error('expected a session plan in team mode');
    if (origin) await setSessionBindingOrigin(root, key, origin);
    return plan.token;
  }

  async function send(token: string) {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await new Promise((r) => setTimeout(r, 50));
    return res;
  }

  test('is honoured from the address it is pinned to', async () => {
    const res = await send(await memberPlaceholder('127.0.0.1'));
    expect(res.status).toBe(200);
    expect(forwarded).toBe('sk-ant-api-alice-real');
  });

  test('is refused, loudly and audited, from any other address', async () => {
    const res = await send(await memberPlaceholder('172.30.0.9'));
    expect(res.status).toBe(401);
    expect(forwarded).toBeNull();
    const body = await res.json() as { error?: { message?: string } };
    expect(body.error?.message).toContain('pinned to the container it was minted for');
    expect(records.at(-1)?.authDenial).toBe('session_token_wrong_origin');
  });

  test('a placeholder nothing pinned resolves as before (turn placeholders)', async () => {
    const res = await send(await memberPlaceholder(null));
    expect(res.status).toBe(200);
  });
});
