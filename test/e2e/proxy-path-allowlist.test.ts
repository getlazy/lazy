/**
 * The forwarding-surface allowlist, observed on the DAEMON's real proxy.
 *
 * The unit suites build a proxy in-process; this one proves the control is live
 * on the port agents are actually handed. A granted agent presenting a real
 * placeholder must get a 403 for anything outside the model API, the upstream
 * must never see the request, and the refusal must land in the project's audit
 * log — the same three properties a credential refusal has.
 *
 * Modelled on proxy-cursor-passthrough.test.ts, which is the established seam
 * for "mint a grant against a running daemon and send it real HTTP".
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { auditLogPath } from '../../src/proxy/audit-log';
import { PATH_REFUSED_PREFIX } from '../../src/proxy/activity';
import { mintCredentialGrant } from '../../src/proxy/credential-broker';
import { getRootPath } from '../../src/daemon/paths';

describe('the daemon proxy refuses paths outside the model API', () => {
  let ctx: TestContext;
  let tmpHome: string;
  let daemonBaseDir: string;
  let upstream: ReturnType<typeof Bun.serve> | null = null;
  const seen: Array<{ method: string; path: string }> = [];

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-proxy-allowlist-'));
    daemonBaseDir = await makeDaemonBaseDir();
    seen.length = 0;
    upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        await req.text();
        seen.push({ method: req.method, path: u.pathname + u.search });
        return new Response(JSON.stringify({ type: 'message', ok: true }), {
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
  });

  /** Mint a grant in the running daemon's registry, from this process. */
  async function mintGrantForDaemon(taskId: string): Promise<string> {
    const previous = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = daemonBaseDir;
    try {
      const daemonRoot = (await readFile(getRootPath(ctx.root), 'utf-8')).trim();
      expect(daemonRoot).toBe(ctx.root);
      return await mintCredentialGrant(ctx.root, {
        role: 'agent',
        taskId,
        label: `lazy-${taskId}`,
        envKey: 'ANTHROPIC_API_KEY',
      });
    } finally {
      if (previous === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
      else process.env.LAZY_DAEMON_BASE_DIR = previous;
    }
  }

  /** Audit records written so far (the proxy answers before it writes). */
  async function auditRecords(match: (r: any) => boolean, expected: number): Promise<any[]> {
    const logPath = auditLogPath(join(ctx.root, '.lazy'));
    let records: any[] = [];
    for (let i = 0; i < 40; i++) {
      const raw = await readFile(logPath, 'utf-8').catch(() => '');
      records = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter(match);
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

  /** Point the proxy's primary upstream at the local mock. */
  async function pinUpstream(): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    // The init template mentions [proxy] only in comments, so appending a real
    // section here is not a duplicate-key error.
    expect(before).not.toMatch(/^\s*\[proxy\]/m);
    await writeFile(
      configPath,
      `${before}\n[proxy]\nupstream = "http://127.0.0.1:${upstream!.port}"\n`,
    );
  }

  /** The live proxy address the daemon reports — the same one agents are handed. */
  async function proxyAddress(): Promise<string> {
    const status = await ctx.lazy(['daemon', 'status'], { env: env() });
    const match = status.stdout.match(/Proxy:\s+(\S+)\s+→/);
    expect(match, `no proxy address in daemon status:\n${status.stdout}`).not.toBeNull();
    return match![1];
  }

  test('forwards /v1/messages but refuses an upstream admin path', async () => {
    await pinFreeServerPort();
    await pinUpstream();

    const started = await ctx.lazy(['daemon', 'start'], { env: env() });
    expect(started.exitCode).toBe(0);
    try {
      const address = await proxyAddress();
      const placeholder = await mintGrantForDaemon('abc123');

      // The model API still rides through, untouched.
      const ok = await fetch(`${address}/v1/messages?beta=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': placeholder },
        body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
      });
      expect(ok.status).toBe(200);
      expect(seen).toEqual([{ method: 'POST', path: '/v1/messages?beta=true' }]);

      // INVARIANT: a granted agent cannot reach an upstream's administrative
      // surface through lazy's proxy. `/api/pull` is ollama's model-download
      // endpoint; the same refusal covers /api/delete, /api/create and friends.
      seen.length = 0;
      const refused = await fetch(`${address}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': placeholder },
        body: JSON.stringify({ model: 'llama3' }),
      });
      expect(refused.status).toBe(403);
      // Never forwarded — the refusal happens before any upstream call.
      expect(seen).toEqual([]);

      const body = await refused.json() as { error: { type: string; message: string } };
      expect(body.error.type).toBe('permission_error');
      expect(body.error.message).toContain('POST /api/pull');
      expect(body.error.message).toContain('model API');

      // INVARIANT: a refusal is durably recorded, not merely logged — it is the
      // single most security-interesting thing this proxy does.
      const records = await auditRecords(
        (r) => typeof r.error === 'string' && r.error.startsWith(PATH_REFUSED_PREFIX),
        1,
      );
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe(403);
      expect(records[0].path).toBe('/api/pull');
      expect(records[0].method).toBe('POST');
      // Attribution from the grant, not from a client-supplied header.
      expect(records[0].role).toBe('agent');
      expect(records[0].taskId).toBe('abc123');
    } finally {
      await ctx.lazy(['daemon', 'stop'], { env: env() });
    }
  });
});
