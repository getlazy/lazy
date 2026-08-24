/**
 * Cursor API traffic really rides the daemon's proxy (proxy-cursor-passthrough).
 *
 * The unit tests build a proxy server in-process; this one proves the DAEMON
 * wires the route up — that `[proxy] cursor_upstream` reaches
 * `createProxyServer`, that the route answers on the same OS-assigned proxy
 * port agents are handed, and that a cursor request lands in the project's
 * audit log attributed to its role and task.
 *
 * Since proxy-jit-credentials the route's first path segment is the launch's
 * PLACEHOLDER credential, and attribution comes from the grant it resolves to
 * rather than from segments the client chose — so this suite mints a real grant
 * against the running daemon's registry instead of putting a role/task pair in
 * the URL. See src/proxy/cursor-route.ts for the segment contract.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { auditLogPath } from '../../src/proxy/audit-log';
import { CURSOR_PROXY_PREFIX } from '../../src/proxy/cursor-route';
import { mintCredentialGrant, placeholderValueFor } from '../../src/proxy/credential-broker';
import { getRootPath } from '../../src/daemon/paths';

/**
 * The Cursor key the DAEMON holds. The proxy swaps the launch's placeholder for
 * this just before forwarding, so it is what the upstream must see — and it must
 * never have been in the request the client sent.
 */
const REAL_CURSOR_KEY = 'key_THE_REAL_CURSOR_KEY';

describe('cursor passthrough through the running daemon proxy', () => {
  let ctx: TestContext;
  let tmpHome: string;
  let daemonBaseDir: string;
  let upstream: ReturnType<typeof Bun.serve> | null = null;
  const seen: Array<{ method: string; path: string; auth: string | null; body: string }> = [];

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-cursor-proxy-'));
    daemonBaseDir = await makeDaemonBaseDir();
    seen.length = 0;
    upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        seen.push({
          method: req.method,
          path: u.pathname + u.search,
          auth: req.headers.get('authorization'),
          body: await req.text(),
        });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
  });

  afterEach(async () => {
    upstream?.stop(true);
    upstream = null;
    await ctx.cleanup();
    await rm(tmpHome, { recursive: true, force: true });
    await removeDaemonBaseDir(daemonBaseDir);
  });

  const env = () => ({
    HOME: tmpHome,
    LAZY_DAEMON_BASE_DIR: daemonBaseDir,
    LAZY_TEST: '',
    ANTHROPIC_API_KEY: 'sk-ant-fake-for-test',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    // The daemon-held Cursor credential the proxy swaps in (credential-deps.ts
    // resolves it through resolveAgentApiKey, which reads the daemon's own env).
    CURSOR_API_KEY: REAL_CURSOR_KEY,
  });

  /**
   * Mint a grant in the running daemon's registry, from this process.
   *
   * The registry is a file under the daemon base dir keyed by project root, and
   * `lookupCredentialGrant` re-reads it on a cache miss — so a grant written here
   * is visible to the daemon without restarting it. The base dir only reaches the
   * broker through the env, hence the narrow pin.
   */
  async function mintGrantForDaemon(taskId: string): Promise<string> {
    const previous = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = daemonBaseDir;
    try {
      // Fail loudly if this process and the daemon disagree about the project
      // root: they would then key the registry differently and the grant would
      // silently never resolve.
      const daemonRoot = (await readFile(getRootPath(ctx.root), 'utf-8')).trim();
      expect(daemonRoot).toBe(ctx.root);
      return await mintCredentialGrant(ctx.root, {
        role: 'agent',
        taskId,
        label: `lazy-${taskId}`,
        envKey: 'CURSOR_API_KEY',
      });
    } finally {
      if (previous === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
      else process.env.LAZY_DAEMON_BASE_DIR = previous;
    }
  }

  /** Cursor audit records written so far (the proxy answers before it writes). */
  async function cursorAuditRecords(expected: number): Promise<any[]> {
    const logPath = auditLogPath(join(ctx.root, '.lazy'));
    let records: any[] = [];
    for (let i = 0; i < 40; i++) {
      const raw = await readFile(logPath, 'utf-8').catch(() => '');
      records = raw.trim().split('\n').filter(Boolean)
        .map(l => JSON.parse(l)).filter(r => r.backend === 'cursor');
      if (records.length >= expected) break;
      await Bun.sleep(100);
    }
    return records;
  }

  /** Pin `[server] port` to a port the OS just reported free. */
  async function pinFreeServerPort(): Promise<void> {
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('p') });
    const port = probe.port!;
    probe.stop(true);
    const configPath = join(ctx.root, 'lazy.toml');
    const existing = await readFile(configPath, 'utf-8');
    const updated = existing.replace(/^port\s*=\s*\d+/m, `port = ${port}`);
    expect(updated).not.toBe(existing);
    await writeFile(configPath, updated);
  }

  /** Point the cursor route at the local mock instead of Cursor's servers. */
  async function pinCursorUpstream(): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    // The init template mentions [proxy] only in comments, so appending a real
    // section here is not a duplicate-key error.
    expect(before).not.toMatch(/^\s*\[proxy\]/m);
    await writeFile(
      configPath,
      `${before}\n[proxy]\ncursor_upstream = "http://127.0.0.1:${upstream!.port}"\n`,
    );
  }

  /** The live proxy address the daemon reports — the same one agents are handed. */
  async function proxyAddress(): Promise<string> {
    const status = await ctx.lazy(['daemon', 'status'], { env: env() });
    const match = status.stdout.match(/Proxy:\s+(\S+)\s+→/);
    expect(match, `no proxy address in daemon status:\n${status.stdout}`).not.toBeNull();
    return match![1];
  }

  test('the daemon forwards a cursor request verbatim and audits it', async () => {
    await pinFreeServerPort();
    await pinCursorUpstream();

    const started = await ctx.lazy(['daemon', 'start'], { env: env() });
    expect(started.exitCode).toBe(0);
    try {
      const address = await proxyAddress();
      const placeholder = await mintGrantForDaemon('abc123');

      const res = await fetch(
        `${address}${CURSOR_PROXY_PREFIX}/${placeholder}/auth/exchange_user_api_key?v=2`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${placeholder}`,
          },
          body: JSON.stringify({ hello: 'cursor' }),
        },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      // Verbatim passthrough: the lazy credential segment is stripped and
      // nothing else about the request is rewritten — not the method, not the
      // path, not the query string, not the body.
      expect(seen).toHaveLength(1);
      expect(seen[0].method).toBe('POST');
      expect(seen[0].path).toBe('/auth/exchange_user_api_key?v=2');
      expect(JSON.parse(seen[0].body)).toEqual({ hello: 'cursor' });
      // The one deliberate exception since proxy-jit-credentials: the credential
      // IS rewritten. The launch only ever held a placeholder; the proxy swaps in
      // the daemon's real key on the way out, so the real key must appear here and
      // the placeholder must not.
      expect(seen[0].auth).toBe(`Bearer ${REAL_CURSOR_KEY}`);
      expect(seen[0].auth).not.toContain(placeholder);

      // INVARIANT: routing cursor traffic through the proxy is pointless if it
      // is not recorded — the audit trail is the entire reason this route
      // exists. Attribution is EVIDENCE, not a claim: role and task come from
      // the grant the placeholder resolved to, never from anything the client
      // put in the URL or its headers.
      const cursorRecords = await cursorAuditRecords(1);
      expect(cursorRecords).toHaveLength(1);
      expect(cursorRecords[0].role).toBe('agent');
      expect(cursorRecords[0].taskId).toBe('abc123');
      expect(cursorRecords[0].path).toBe('/auth/exchange_user_api_key?v=2');
      expect(cursorRecords[0].status).toBe(200);
      // Coarse by design: the Anthropic-wire extractor must never see a cursor
      // request, so every model/usage field stays empty rather than guessed.
      expect(cursorRecords[0].model).toBeNull();
      expect(cursorRecords[0].usage).toBeNull();
    } finally {
      await ctx.lazy(['daemon', 'stop'], { env: env() });
    }
  });

  // INVARIANT: a token segment that does not resolve is a hard 401, never a
  // best-effort unattributed forward. Anything else would let a launch whose
  // grant was revoked (or forged) keep spending the daemon's real Cursor key
  // while leaving no attributable trail.
  test('a lazy-shaped token with no grant is refused and never forwarded', async () => {
    await pinFreeServerPort();
    await pinCursorUpstream();

    const started = await ctx.lazy(['daemon', 'start'], { env: env() });
    expect(started.exitCode).toBe(0);
    try {
      const address = await proxyAddress();
      // Correctly shaped, but minted by nobody — so it is in no registry.
      const forged = placeholderValueFor('CURSOR_API_KEY');

      const res = await fetch(
        `${address}${CURSOR_PROXY_PREFIX}/${forged}/auth/exchange_user_api_key?v=2`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${forged}` },
          body: JSON.stringify({ hello: 'cursor' }),
        },
      );
      expect(res.status).toBe(401);
      // The upstream was never dialled — refusal happens before forwarding.
      expect(seen).toHaveLength(0);
    } finally {
      await ctx.lazy(['daemon', 'stop'], { env: env() });
    }
  });
});
