/**
 * End-to-end-through-real-HTTP tests for the request-plugin seam in the proxy.
 *
 * These run the actual proxy server against an in-process upstream that records
 * the RAW forwarded bytes, so the central claim of this feature — "no plugin
 * installed means byte-identical to a build without the seam" — is verified
 * against the wire, not against a unit-level object comparison.
 *
 * The plugin used here is loaded from a real `.lazy/plugins/` directory through
 * the real loader, so the file-on-disk → transform-on-the-wire path is covered
 * end to end.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProxyServer } from '../../src/proxy/server';
import { loadProxyRequestPlugins, proxyPluginDir } from '../../src/proxy/plugins/loader';
import type { ProxyRequestPlugin } from '../../src/proxy/plugins/types';
import type { AuditSink } from '../../src/proxy/audit';
import type { ProxyAuditRecord } from '../../src/storage/types';

// The proxy writes audit records to an AuditSink (the project-local bounded
// log in production) — never to Storage.
function createMockSink(): AuditSink {
  const records: ProxyAuditRecord[] = [];
  return {
    append: async (r: ProxyAuditRecord) => { records.push(r); },
  };
}

function findFreePort(): number {
  return 40000 + Math.floor(Math.random() * 10000);
}

const SYSTEM_PROMPT = [
  'You are the agent that works on the task in the repository.',
  'It is very important that the change is verified before it is committed.',
].join(' ');

describe('proxy request plugins over real HTTP', () => {
  let upstream: ReturnType<typeof Bun.serve>;
  let upstreamPort: number;
  let rawForwardedBody: string | null = null;
  let projectRoot: string;

  beforeAll(async () => {
    upstreamPort = findFreePort();
    upstream = Bun.serve({
      port: upstreamPort,
      hostname: '127.0.0.1',
      async fetch(req) {
        rawForwardedBody = req.method === 'GET' ? null : await req.text();
        return Response.json({ type: 'message', ok: true });
      },
    });

    // A real project checkout with a real user-authored plugin in .lazy/plugins.
    projectRoot = await mkdtemp(join(tmpdir(), 'lazy-plugin-proxy-'));
    await mkdir(proxyPluginDir(projectRoot), { recursive: true });
    await writeFile(
      join(proxyPluginDir(projectRoot), 'uppercase-system.ts'),
      `export default {
         name: 'uppercase-system',
         transformRequest(body) {
           const b = body as { system?: unknown };
           if (typeof b.system !== 'string') return null;
           return { ...(body as object), system: b.system.toUpperCase() };
         },
       };`,
      'utf-8',
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterAll(async () => {
    upstream.stop();
    await rm(projectRoot, { recursive: true, force: true });
  });

  function startProxy(plugins?: readonly ProxyRequestPlugin[]) {
    const port = findFreePort();
    const server = createProxyServer(
      { port, bind: '127.0.0.1', upstream: `http://127.0.0.1:${upstreamPort}`, plugins },
      createMockSink(),
      // No credential broker: these tests exercise request plugins, not JIT injection.
      null,
    );
    return { port, server };
  }

  async function post(proxyPort: number, body: string): Promise<void> {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    await resp.text();
  }

  const requestBody = {
    model: 'claude-sonnet-4-6',
    max_tokens: 100,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: SYSTEM_PROMPT }],
  };

  // INVARIANT: the proxy sits on every agent's critical path, so with no plugin
  // installed the forwarded bytes must be the client's bytes, character for
  // character — not a re-serialisation that merely parses back to the same
  // object. Key order, spacing and unicode escaping all have to survive, because
  // upstream prompt-cache keys are computed over the bytes.
  test('no plugins forwards the request body byte-identically', async () => {
    const { port, server } = startProxy();
    try {
      const sent = JSON.stringify(requestBody);
      // Cast widens the assignment so TS does not narrow the flow type to the
      // literal `null` (the same tsc quirk noted in proxy-server.test.ts).
      rawForwardedBody = null as string | null;
      await post(port, sent);
      expect(rawForwardedBody).toBe(sent);
    } finally {
      server.stop();
    }
  });

  // Same claim from the other direction: a project whose .lazy/plugins does not
  // exist resolves to an empty chain, so the default install is byte-identical.
  test('a project with no .lazy/plugins directory is byte-identical', async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), 'lazy-plugin-empty-'));
    try {
      const loaded = await loadProxyRequestPlugins(emptyRoot);
      expect(loaded).toEqual([]);
      const { port, server } = startProxy(loaded);
      try {
        const sent = JSON.stringify(requestBody);
        rawForwardedBody = null as string | null;
        await post(port, sent);
        expect(rawForwardedBody).toBe(sent);
      } finally {
        server.stop();
      }
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });

  test('a plugin loaded from .lazy/plugins rewrites the body on the wire', async () => {
    const plugins = await loadProxyRequestPlugins(projectRoot);
    expect(plugins.map((p) => p.name)).toEqual(['uppercase-system']);
    const { port, server } = startProxy(plugins);
    try {
      rawForwardedBody = null as string | null;
      await post(port, JSON.stringify(requestBody));
      expect(rawForwardedBody).not.toBeNull();
      const forwarded = JSON.parse(rawForwardedBody!) as typeof requestBody;
      expect(forwarded.system).toBe(SYSTEM_PROMPT.toUpperCase());
      // Everything the plugin did not touch is carried through unchanged.
      expect(forwarded.messages).toEqual(requestBody.messages);
      expect(forwarded.model).toBe('claude-sonnet-4-6');
    } finally {
      server.stop();
    }
  });

  // A request the installed plugin declines (returns null for) must still go out
  // byte-for-byte — the seam only re-serialises when something actually changed.
  test('a request the plugin declines is still forwarded byte-identically', async () => {
    const plugins = await loadProxyRequestPlugins(projectRoot);
    const { port, server } = startProxy(plugins);
    try {
      const sent = JSON.stringify({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      rawForwardedBody = null as string | null;
      await post(port, sent);
      expect(rawForwardedBody).toBe(sent);
    } finally {
      server.stop();
    }
  });

  // INVARIANT (fail open at RUN time): a plugin that throws mid-request must not
  // take the request down. Contrast with load time, which fails loud.
  test('a plugin that throws at request time degrades to passthrough', async () => {
    const boom: ProxyRequestPlugin = {
      name: 'boom',
      transformRequest() { throw new Error('plugin exploded'); },
    };
    const { port, server } = startProxy([boom]);
    try {
      const sent = JSON.stringify(requestBody);
      rawForwardedBody = null as string | null;
      const resp = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: sent,
      });
      expect(resp.status).toBe(200);
      await resp.text();
      expect(rawForwardedBody).toBe(sent);
    } finally {
      server.stop();
    }
  });
});
