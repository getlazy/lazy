/**
 * Regression coverage for the JIT-credential hardening pass.
 *
 * Each test here corresponds to a defect found reviewing the injection work,
 * and each one is about the proxy being TRUSTWORTHY rather than merely working:
 * attribution that a verified caller cannot forge, refusals that leave durable
 * evidence, and a passthrough route that does not quietly mangle the bytes it
 * is only supposed to be observing.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createProxyServer, type ProxyCredentialDeps } from '../../src/proxy/server';
import { TargetCredentials, anthropicPlacement } from '../../src/proxy/target-credentials';
import type { CredentialGrant } from '../../src/proxy/credential-broker';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';

const BUILDER_TOKEN = 'sk-ant-oat01-lazy-builder';
const AGENT_TOKEN = 'sk-ant-api03-lazy-agent';
const CURSOR_TOKEN = 'key_lazy_cursor';
const REAL = 'sk-ant-oat01-REAL';
const REAL_CURSOR = 'key_THE_REAL_CURSOR_KEY_LONGER';

/** A builder grant: role set, taskId legitimately NULL. That null is the trap. */
const BUILDER_GRANT: CredentialGrant = {
  token: BUILDER_TOKEN, role: 'builder', taskId: null,
  label: 'builder:session', envKey: 'CLAUDE_CODE_OAUTH_TOKEN',
  createdAt: new Date().toISOString(),
};
const AGENT_GRANT: CredentialGrant = {
  token: AGENT_TOKEN, role: 'agent', taskId: 'task-9',
  label: 'lazy-task-9', envKey: 'ANTHROPIC_API_KEY',
  createdAt: new Date().toISOString(),
};
const CURSOR_GRANT: CredentialGrant = {
  token: CURSOR_TOKEN, role: 'agent', taskId: 'task-c',
  label: 'lazy-task-c', envKey: 'CURSOR_API_KEY',
  createdAt: new Date().toISOString(),
};

function freePort(): number {
  return 49000 + Math.floor(Math.random() * 6000);
}

describe('JIT credentials — attribution and refusal auditing', () => {
  let anthropicUp: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let records: ProxyAuditRecord[];
  let reached = 0;
  /** Flipped per test so the primary can be made credential-less. */
  let anthropicCredentialAvailable = true;

  beforeAll(async () => {
    records = [];
    const upPort = freePort();
    anthropicUp = Bun.serve({
      port: upPort, hostname: '127.0.0.1',
      async fetch() {
        reached++;
        return Response.json({ type: 'message', model: 'm' });
      },
    });

    const targets = new TargetCredentials();
    targets.set(`http://127.0.0.1:${upPort}`, async () =>
      anthropicCredentialAvailable
        ? { kind: 'credential', placement: anthropicPlacement('CLAUDE_CODE_OAUTH_TOKEN', REAL), label: 'oauth' }
        : { kind: 'missing', reason: 'the daemon has no Anthropic credential' });

    const credentials: ProxyCredentialDeps = {
      lookup: async (t: string) =>
        t === BUILDER_TOKEN ? BUILDER_GRANT : t === AGENT_TOKEN ? AGENT_GRANT : null,
      targets,
    };

    const sink: AuditSink = { append: async (r) => { records.push(r); } };
    proxyPort = freePort();
    proxy = createProxyServer(
      { port: proxyPort, bind: '127.0.0.1', upstream: `http://127.0.0.1:${upPort}`, retryAfterThreshold: 0 },
      sink,
      credentials,
    );
    await new Promise(r => setTimeout(r, 50));
  });

  afterAll(() => { anthropicUp.stop(); proxy.stop(); });

  async function settle() { await new Promise(r => setTimeout(r, 60)); }

  // INVARIANT: a VERIFIED caller cannot forge its own attribution either.
  // A builder grant has taskId null, and `caller?.grant.taskId ?? header` fell
  // through that null to the client's own header — so the one caller lazy had
  // actually authenticated was the one that could lie about which task it was.
  test('a verified builder grant does not inherit a forged x-lazy-task-id', async () => {
    records.length = 0;
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${BUILDER_TOKEN}`,
        'x-lazy-role': 'agent',
        'x-lazy-task-id': 'someone-elses-task',
      },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(resp.status).toBe(200);
    await settle();

    expect(records).toHaveLength(1);
    expect(records[0].role).toBe('builder');
    // Null, NOT the forged header — the grant is the only source.
    expect(records[0].taskId).toBeNull();
  });

  test('an unverified request still falls back to its header hints', async () => {
    records.length = 0;
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lazy-role': 'agent', 'x-lazy-task-id': 'hint-task' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    await settle();
    // No grant to contradict them, and a blank record would be worse than a
    // self-reported one for traffic lazy never minted a token for.
    expect(records[0].role).toBe('agent');
    expect(records[0].taskId).toBe('hint-task');
  });

  test('an unknown placeholder is refused AND leaves an audit record', async () => {
    records.length = 0;
    const before = reached;
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-api03-lazy-REVOKED' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    });
    expect(resp.status).toBe(401);
    expect(reached).toBe(before); // never forwarded
    await settle();

    // A revoked task hammering the proxy must leave durable evidence, not just
    // warn lines in a rotating process log.
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe(401);
    expect(records[0].error).toMatch(/unknown or revoked placeholder/);
    // Nothing was proven, so nothing is attributed — and the forged-header
    // fallback must NOT sneak in here either.
    expect(records[0].role).toBeNull();
    expect(records[0].taskId).toBeNull();
    // The credential itself never enters the audit log.
    expect(JSON.stringify(records[0])).not.toContain('REVOKED');
  });

  test('a missing target credential is refused AND audited, attributed to the grant', async () => {
    records.length = 0;
    anthropicCredentialAvailable = false;
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': AGENT_TOKEN },
        body: JSON.stringify({ model: 'm', messages: [] }),
      });
      expect(resp.status).toBe(401);
      await settle();
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe(401);
      expect(records[0].taskId).toBe('task-9');
      expect(records[0].error).toMatch(/no Anthropic credential/);
    } finally {
      anthropicCredentialAvailable = true;
    }
  });
});

describe('JIT credentials — cursor body substitution is byte-exact', () => {
  let cursorUp: ReturnType<typeof Bun.serve>;
  let proxy: ReturnType<typeof Bun.serve>;
  let proxyPort: number;
  let seenBody: Uint8Array | null = null;
  let seenLength: string | null = null;

  beforeAll(async () => {
    const upPort = freePort();
    cursorUp = Bun.serve({
      port: upPort, hostname: '127.0.0.1',
      async fetch(req) {
        seenBody = new Uint8Array(await req.arrayBuffer());
        seenLength = req.headers.get('content-length');
        return Response.json({ ok: true });
      },
    });

    const targets = new TargetCredentials();
    targets.set(`http://127.0.0.1:${upPort}`, async () => ({
      kind: 'credential', placement: { kind: 'in-place', value: REAL_CURSOR }, label: 'CURSOR_API_KEY',
    }));

    const credentials: ProxyCredentialDeps = {
      lookup: async (t: string) => (t === CURSOR_TOKEN ? CURSOR_GRANT : null),
      targets,
    };
    const sink: AuditSink = { append: async () => {} };
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

  const url = () => `http://127.0.0.1:${proxyPort}/_lazy/cursor/${CURSOR_TOKEN}/auth/exchange_user_api_key`;

  // INVARIANT: every declared body under the cap is buffered, not just the ones
  // carrying a placeholder — so the buffering path must be byte-transparent.
  // Cursor speaks connect-rpc and a small unary call can be binary protobuf;
  // decoding that as UTF-8 turns each invalid byte into U+FFFD and re-encodes
  // it as three different bytes, silently corrupting a request lazy is only
  // supposed to be observing.
  test('a binary body with no placeholder is forwarded byte-for-byte', async () => {
    seenBody = null;
    // 0xFF/0xFE/0x80 are not valid UTF-8 in these positions — a text round-trip
    // would replace them with EF BF BD.
    const raw = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f, 0x42, 0xc3, 0x28]);
    const resp = await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/proto' },
      body: raw,
    });
    expect(resp.status).toBe(200);
    expect(seenBody).not.toBeNull();
    expect(Array.from(seenBody!)).toEqual(Array.from(raw));
  });

  test('a binary body carrying the placeholder swaps only those bytes', async () => {
    seenBody = null;
    const tok = new TextEncoder().encode(CURSOR_TOKEN);
    const prefix = new Uint8Array([0x00, 0xff, 0x80]);
    const suffix = new Uint8Array([0xfe, 0x01]);
    const raw = new Uint8Array([...prefix, ...tok, ...suffix]);

    await fetch(url(), { method: 'POST', headers: { 'content-type': 'application/proto' }, body: raw });

    const expected = new Uint8Array([
      ...prefix, ...new TextEncoder().encode(REAL_CURSOR), ...suffix,
    ]);
    expect(Array.from(seenBody!)).toEqual(Array.from(expected));
  });

  test('content-length matches the substituted body, not the original', async () => {
    seenBody = null; seenLength = null;
    // The real key is deliberately a different length from the placeholder, so
    // a stale content-length would truncate or hang the call upstream.
    expect(REAL_CURSOR.length).not.toBe(CURSOR_TOKEN.length);
    const body = JSON.stringify({ apiKey: CURSOR_TOKEN });
    await fetch(url(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const text = new TextDecoder().decode(seenBody!);
    expect(text).toContain(REAL_CURSOR);
    expect(text).not.toContain(CURSOR_TOKEN);
    if (seenLength !== null) {
      expect(Number(seenLength)).toBe(new TextEncoder().encode(text).length);
    }
  });

  test('a UTF-8 body with multibyte characters survives substitution', async () => {
    seenBody = null;
    const body = JSON.stringify({ apiKey: CURSOR_TOKEN, note: 'héllo — 世界 🎉' });
    await fetch(url(), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    const text = new TextDecoder().decode(seenBody!);
    expect(text).toContain('héllo — 世界 🎉');
    expect(text).toContain(REAL_CURSOR);
  });
});

describe('JIT credentials — the credential map cannot lie', () => {
  // INVARIANT: TargetCredentials is keyed by ORIGIN, so a fallback that shares
  // an origin with an already-mapped upstream inherits its credential no matter
  // what the config says. Silently doing that while the startup log prints
  // "→ none" is a config that reads as one thing and behaves as another, so
  // lazy refuses to start instead.
  test('a credential-less fallback sharing the primary origin is rejected at build', async () => {
    const { buildProxyCredentialDeps } = await import('../../src/proxy/credential-deps');
    const config = {
      proxy: {
        upstream: 'https://api.anthropic.com',
        cursorUpstream: 'https://api2.cursor.sh',
        // Same ORIGIN as the primary, different path — the map would key both
        // to api.anthropic.com and hand this one the user's real credential.
        fallbacks: [{ upstream: 'https://api.anthropic.com/v2', credential: 'none' }],
      },
      // No per-role endpoints: this suite is about the fallback chain's map.
      models: { roles: { builder: { backend: 'anthropic', model: 'm' }, agent: { backend: 'anthropic', model: 'm' } } },
    } as never;
    expect(() => buildProxyCredentialDeps('/tmp/x', config)).toThrow(/shares an origin/);
  });

  test('an explicitly anthropic fallback on a shared origin is allowed', async () => {
    const { buildProxyCredentialDeps } = await import('../../src/proxy/credential-deps');
    const config = {
      proxy: {
        upstream: 'https://api.anthropic.com',
        cursorUpstream: 'https://api2.cursor.sh',
        fallbacks: [{ upstream: 'https://api.anthropic.com/v2', credential: 'anthropic' }],
      },
      // No per-role endpoints: this suite is about the fallback chain's map.
      models: { roles: { builder: { backend: 'anthropic', model: 'm' }, agent: { backend: 'anthropic', model: 'm' } } },
    } as never;
    // It asked for that credential, so receiving it is what the config says.
    expect(() => buildProxyCredentialDeps('/tmp/x', config)).not.toThrow();
  });

  test('a distinct-origin fallback with no credential is fine', async () => {
    const { buildProxyCredentialDeps } = await import('../../src/proxy/credential-deps');
    const config = {
      proxy: {
        upstream: 'https://api.anthropic.com',
        cursorUpstream: 'https://api2.cursor.sh',
        fallbacks: [{ upstream: 'http://host.docker.internal:11434', credential: 'none' }],
      },
      // No per-role endpoints: this suite is about the fallback chain's map.
      models: { roles: { builder: { backend: 'anthropic', model: 'm' }, agent: { backend: 'anthropic', model: 'm' } } },
    } as never;
    expect(() => buildProxyCredentialDeps('/tmp/x', config)).not.toThrow();
  });
});
