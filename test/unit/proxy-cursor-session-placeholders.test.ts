/**
 * A task container can never obtain or reuse a real credential through the
 * cursor route.
 *
 * cursor-agent (verified against the 2026.10.01-e373342 bundle) trades its API
 * key for a session: `POST /auth/exchange_user_api_key`, key in
 * `Authorization: Bearer`, body `{}`, answer `{ accessToken, refreshToken }`
 * with the access token a JWT the client decodes for `exp` and then sends as a
 * bearer on every later call. The fake upstream below speaks exactly that.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { TargetCredentials } from '../../src/proxy/target-credentials';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';

const KEY_PLACEHOLDER = 'key_lazy_cursortask';
const OTHER_PLACEHOLDER = 'key_lazy_othertask';
const REAL_KEY = 'key_REAL_CURSOR_API_KEY';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const REAL_ACCESS = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u', exp: 4102444800 })}.REAL-SIGNATURE`;
const REAL_REFRESH = 'REAL-REFRESH-TOKEN';
// Invalid UTF-8 on purpose (0xff, a lone continuation byte): a text round trip
// would turn these into U+FFFD.
const BINARY_REPLY = new Uint8Array([0x0a, 0x03, 0xff, 0xfe, 0x80, 0x12, 0x00, 0xc3]);

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response('') });
  const p = s.port!;
  s.stop(true);
  return p;
}

describe('cursor route — upstream-minted sessions stay behind placeholders', () => {
  let cursorUp: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let seenAuth: string | null = null;
  let hits = 0;
  let bindWorks = true;
  let mislabel = false;
  const audit: ProxyAuditRecord[] = [];
  const grants: Record<string, CredentialGrant> = {};

  beforeAll(async () => {
    const upPort = freePort();
    cursorUp = Bun.serve({
      port: upPort, hostname: '127.0.0.1',
      async fetch(req) {
        hits++;
        seenAuth = req.headers.get('authorization');
        const path = new URL(req.url).pathname;
        if (path === '/auth/exchange_user_api_key') {
          if (seenAuth !== `Bearer ${REAL_KEY}`) return new Response('bad key', { status: 401 });
          const body = JSON.stringify({ accessToken: REAL_ACCESS, refreshToken: REAL_REFRESH, extra: 'kept' });
          // cursor-agent parses the answer as JSON whatever its type; so must lazy.
          return new Response(body, { headers: { 'content-type': mislabel ? 'text/plain' : 'application/json' } });
        }
        if (path === "/aiserver.v1.Unary/Get") {
          return new Response(BINARY_REPLY, { headers: { "content-type": "application/proto" } });
        }
        return Response.json({ ok: true });
      },
    });

    const targets = new TargetCredentials();
    targets.set(`http://127.0.0.1:${upPort}`, async () => ({
      kind: 'credential', placement: { kind: 'in-place', value: REAL_KEY }, label: 'CURSOR_API_KEY',
    }));
    for (const token of [KEY_PLACEHOLDER, OTHER_PLACEHOLDER]) {
      grants[token] = {
        token, role: 'agent', taskId: token, label: token, envKey: 'CURSOR_API_KEY',
        createdAt: new Date().toISOString(),
      };
    }
    const credentials: ProxyCredentialDeps = {
      lookup: async (t: string) => grants[t] ?? null,
      bindDerived: async (t, pairs) => {
        if (!bindWorks || !grants[t]) return false;
        grants[t]!.derived = [...(grants[t]!.derived ?? []), ...pairs.map(p => ({ ...p, createdAt: '' }))];
        return true;
      },
      targets,
    };
    const sink: AuditSink = { append: async (r) => { audit.push(r); } };
    proxyPort = freePort();
    proxy = createProxyServer(
      {
        port: proxyPort, bind: '127.0.0.1',
        upstream: 'http://127.0.0.1:1',
        cursorUpstream: `http://127.0.0.1:${upPort}`,
        retryAfterThreshold: 0,
      },
      sink,
      credentials,
    );
    await new Promise(r => setTimeout(r, 50));
  });

  afterAll(() => { cursorUp.stop(); proxy.stop(); });

  const at = (token: string, path: string) => `http://127.0.0.1:${proxyPort}/_lazy/cursor/${token}${path}`;
  const exchange = (token: string) => fetch(at(token, '/auth/exchange_user_api_key'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{}',
  });

  // INVARIANT: the key exchange's tokens never reach the container. A
  // prompt-injected agent that read them could spend the member's Cursor
  // account from anywhere, outside lazy.
  test('the exchange answer carries placeholders, and they are swapped back upstream', async () => {
    const resp = await exchange(KEY_PLACEHOLDER);
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).not.toContain('REAL-SIGNATURE');
    expect(text).not.toContain(REAL_REFRESH);
    const body = JSON.parse(text) as { accessToken: string; refreshToken: string; extra: string };
    expect(body.extra).toBe('kept');
    // The client decodes the payload for `exp`; it must survive.
    expect(body.accessToken.split('.').slice(0, 2).join('.')).toBe(REAL_ACCESS.split('.').slice(0, 2).join('.'));

    const later = await fetch(at(KEY_PLACEHOLDER, '/aiserver.v1.AgentService/Run'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${body.accessToken}` },
      body: '{}',
    });
    expect(later.status).toBe(200);
    expect(seenAuth).toBe(`Bearer ${REAL_ACCESS}`);
  });

  // INVARIANT: a session placeholder is spendable only by the launch it was
  // minted for. Another task's grant presenting it is refused, not forwarded.
  test('another launch cannot spend a session placeholder', async () => {
    const mine = JSON.parse(await (await exchange(KEY_PLACEHOLDER)).text()) as { accessToken: string };
    const before = hits;
    const stolen = await fetch(at(OTHER_PLACEHOLDER, '/aiserver.v1.AgentService/Run'), {
      method: 'POST', headers: { authorization: `Bearer ${mine.accessToken}` }, body: '{}',
    });
    expect(stolen.status).toBe(401);
    expect(hits).toBe(before);
  });

  // INVARIANT: a unary binary reply (Connect `application/proto`) reaches the
  // container byte-for-byte. Decoding it as text corrupted every invalid UTF-8
  // byte and broke Cursor launches in containers.
  test("a binary unary reply is forwarded byte-for-byte", async () => {
    const resp = await fetch(at(KEY_PLACEHOLDER, "/aiserver.v1.Unary/Get"), {
      method: "POST", headers: { "content-type": "application/proto", authorization: `Bearer ${KEY_PLACEHOLDER}` }, body: "",
    });
    expect(resp.status).toBe(200);
    expect(Array.from(new Uint8Array(await resp.arrayBuffer()))).toEqual(Array.from(BINARY_REPLY));
  });

  test('a mislabelled exchange answer is still swapped', async () => {
    mislabel = true;
    try {
      const text = await (await exchange(KEY_PLACEHOLDER)).text();
      expect(text).not.toContain('REAL-SIGNATURE');
      expect(text).not.toContain(REAL_REFRESH);
    } finally {
      mislabel = false;
    }
  });

  test('a session the launch cannot hold is withheld, never forwarded raw', async () => {
    bindWorks = false;
    try {
      const resp = await exchange(KEY_PLACEHOLDER);
      expect(resp.status).toBe(502);
      const text = await resp.text();
      expect(text).not.toContain('REAL-SIGNATURE');
      expect(text).not.toContain(REAL_REFRESH);
    } finally {
      bindWorks = true;
    }
  });

  // INVARIANT: a grant pinned to its container's address is refused from any
  // other source address, and the refusal is audited.
  test('a pinned grant is refused from another address', async () => {
    grants[OTHER_PLACEHOLDER]!.boundAddresses = ['10.255.0.7'];
    const before = hits;
    const resp = await exchange(OTHER_PLACEHOLDER);
    expect(resp.status).toBe(401);
    expect(hits).toBe(before);
    expect(audit.some(r => r.taskId === OTHER_PLACEHOLDER && r.status === 401)).toBe(true);

    grants[OTHER_PLACEHOLDER]!.boundAddresses = ['127.0.0.1'];
    expect((await exchange(OTHER_PLACEHOLDER)).status).toBe(200);
  });
});
