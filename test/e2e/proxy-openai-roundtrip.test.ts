/**
 * An OpenAI-compatible PROFILE upstream really rides the daemon's proxy.
 *
 * The unit tests (proxy-openai-server.test.ts) build a proxy in-process; this
 * one proves the DAEMON wires it up end to end: an `[agents.<name>]` profile
 * whose endpoint is OpenAI-compatible reaches `createProxyServer` as an
 * openai-wire upstream, the daemon's stored OpenAI key is swapped in for the
 * launch's placeholder, the OpenAI inference surface is forwarded (and the
 * Anthropic surface refused), and the request lands in the audit log with token
 * usage.
 *
 * The project's DEFAULT agent stays claude-code, deliberately: routing is a
 * property of the profile the grant names, not of the role. A project does not
 * have to re-point its whole agent role to give one task an OpenAI upstream —
 * that inability is what profiles replaced.
 *
 * Follows the proxy-cursor-passthrough pattern: a fake upstream on loopback, a
 * grant minted straight into the running daemon's registry.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { makeDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { auditLogPath } from '../../src/proxy/audit-log';
import { mintCredentialGrant } from '../../src/proxy/credential-broker';
import { getRootPath } from '../../src/daemon/paths';

/** The OpenAI key the DAEMON holds; the upstream must see it, the client never. */
const REAL_OPENAI_KEY = 'sk-proj-THE-REAL-OPENAI-KEY';

/** The profile whose endpoint is the fake OpenAI-compatible upstream. */
const PROFILE = 'local-openai';

describe('openai profile upstream through the running daemon proxy', () => {
  let ctx: TestContext;
  let tmpHome: string;
  let daemonBaseDir: string;
  let upstream: ReturnType<typeof Bun.serve> | null = null;
  const seen: Array<{ method: string; path: string; auth: string | null; body: string }> = [];

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-openai-proxy-'));
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
        return Response.json({
          id: 'chatcmpl-e2e',
          usage: { prompt_tokens: 25, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 5 } },
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
    // The builder and the default agent profile stay anthropic, so the gate
    // wants an Anthropic credential too; the openai-wire profile adds the
    // openai provider.
    ANTHROPIC_API_KEY: 'sk-ant-fake-for-test',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    OPENAI_API_KEY: REAL_OPENAI_KEY,
  });

  /** Mint a grant in the running daemon's registry (see cursor e2e for why). */
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
        envKey: 'OPENAI_API_KEY',
        // What the proxy routes by. Broker-verified evidence, not a header the
        // caller could claim — see src/proxy/credential-broker.ts.
        profile: PROFILE,
      });
    } finally {
      if (previous === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
      else process.env.LAZY_DAEMON_BASE_DIR = previous;
    }
  }

  async function auditRecords(expected: number): Promise<any[]> {
    const logPath = auditLogPath(join(ctx.root, '.lazy'));
    let records: any[] = [];
    for (let i = 0; i < 40; i++) {
      const raw = await readFile(logPath, 'utf-8').catch(() => '');
      records = raw.trim().split('\n').filter(Boolean)
        .map(l => JSON.parse(l)).filter(r => r.role === 'agent');
      if (records.length >= expected) break;
      await Bun.sleep(100);
    }
    return records;
  }

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

  /**
   * Declare a profile whose upstream is the fake OpenAI-compatible server.
   *
   * `credential` is named explicitly because the endpoint is on loopback, and a
   * local upstream defaults to NO credential — lazy assumes a model server
   * running on your own machine authenticates nobody. A gateway that does want
   * a key says so, which is exactly what this test needs to observe being
   * swapped in.
   */
  async function addOpenAIProfile(): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    expect(before).not.toMatch(/^\s*\[agents\./m);
    await writeFile(
      configPath,
      `${before}\n[agents.${PROFILE}]\nharness = "codex"\nmodel = "gpt-5.2"\n` +
      `endpoint = "http://127.0.0.1:${upstream!.port}"\ncredential = "openai"\n`,
    );
  }

  async function proxyAddress(): Promise<string> {
    const status = await ctx.lazy(['daemon', 'status'], { env: env() });
    const match = status.stdout.match(/Proxy:\s+(\S+)\s+→/);
    expect(match, `no proxy address in daemon status:\n${status.stdout}`).not.toBeNull();
    return match![1];
  }

  test('a chat completion is routed, credentialed, refused off-wire, and audited with usage', async () => {
    await pinFreeServerPort();
    await addOpenAIProfile();

    const started = await ctx.lazy(['daemon', 'start'], { env: env() });
    expect(started.exitCode, started.stderr).toBe(0);
    try {
      const address = await proxyAddress();
      const placeholder = await mintGrantForDaemon('tsk42');

      const res = await fetch(`${address}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${placeholder}`,
        },
        body: JSON.stringify({ model: 'gpt-5.2', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: 'chatcmpl-e2e' });

      // The daemon-held key went out; the placeholder never did.
      expect(seen).toHaveLength(1);
      expect(seen[0].path).toBe('/v1/chat/completions');
      expect(seen[0].auth).toBe(`Bearer ${REAL_OPENAI_KEY}`);
      expect(seen[0].body).not.toContain(placeholder);

      // INVARIANT: wire isolation, through the real daemon wiring. The same
      // grant's Anthropic-shaped request is refused with lazy's actionable 403,
      // not forwarded to an upstream that would 404.
      const refused = await fetch(`${address}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${placeholder}` },
        body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
      });
      expect(refused.status).toBe(403);
      expect(seen).toHaveLength(1);

      // The audit record is attributed by the grant and carries OpenAI usage,
      // cached tokens split into cache reads (25 prompt = 20 input + 5 cached).
      const records = await auditRecords(2);
      const success = records.find(r => r.endpoint === 'chat_completions');
      expect(success).toBeDefined();
      expect(success.taskId).toBe('tsk42');
      expect(success.model).toBe('gpt-5.2');
      expect(success.status).toBe(200);
      expect(success.usage).toEqual({
        inputTokens: 20,
        outputTokens: 6,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: 5,
      });
    } finally {
      await ctx.lazy(['daemon', 'stop'], { env: env() });
    }
  });
});
