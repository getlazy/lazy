/**
 * A codex PROFILE's upstream really rides the daemon's proxy.
 *
 * The routing decision under test is per profile: the grant a codex launch
 * mints carries its profile name, and the proxy resolves endpoint + wire +
 * credential from that profile — while a claude-code grant in the same project
 * keeps going to the primary upstream untouched. That is the whole point of
 * profiles (src/proxy/agent-upstreams.ts): role config is shared by every task
 * in the role, so it could never send codex to OpenAI without rerouting
 * claude-code tasks too.
 *
 * Follows the proxy-openai-roundtrip pattern: fake upstreams on loopback,
 * grants minted straight into the running daemon's registry, and the codex
 * profile's `endpoint` pinned at the fake so the route is observable
 * hermetically. Pinning it is also why the profile names `credential` here:
 * a loopback endpoint defaults to no credential (a local model server has no
 * use for a real key), and this suite is about the key reaching the upstream.
 * The zero-config spelling — the built-in codex profile, whose default
 * endpoint is api.openai.com with the openai credential — is not reachable
 * from a hermetic test and is covered in test/unit/proxy-agent-upstreams.test.ts.
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
const REAL_OPENAI_KEY = 'sk-proj-THE-REAL-OPENAI-KEY-CODEX';
const REAL_ANTHROPIC_KEY = 'sk-ant-fake-for-codex-roundtrip';

type Seen = { method: string; path: string; auth: string | null; account?: string | null; body: string };

describe('a codex profile grant through the running daemon proxy', () => {
  let ctx: TestContext;
  let tmpHome: string;
  let daemonBaseDir: string;
  let openaiUpstream: ReturnType<typeof Bun.serve> | null = null;
  let anthropicUpstream: ReturnType<typeof Bun.serve> | null = null;
  const seenOpenai: Seen[] = [];
  const seenAnthropic: Seen[] = [];

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-codex-proxy-'));
    daemonBaseDir = await makeDaemonBaseDir();
    seenOpenai.length = 0;
    seenAnthropic.length = 0;
    openaiUpstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        seenOpenai.push({
          method: req.method,
          path: u.pathname + u.search,
          auth: req.headers.get('authorization'),
          account: req.headers.get('chatgpt-account-id'),
          body: await req.text(),
        });
        // A non-streaming /v1/responses body, in the shape the openai usage
        // extractor reads (see test/unit/proxy-openai-server.test.ts).
        return Response.json({
          id: 'resp-codex-e2e',
          model: 'gpt-5.2-codex',
          usage: { input_tokens: 50, output_tokens: 10, input_tokens_details: { cached_tokens: 20 } },
        });
      },
    });
    anthropicUpstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        seenAnthropic.push({
          method: req.method,
          path: u.pathname + u.search,
          auth: req.headers.get('authorization') ?? req.headers.get('x-api-key'),
          body: await req.text(),
        });
        return Response.json({ id: 'msg-anthropic-e2e', usage: { input_tokens: 3, output_tokens: 2 } });
      },
    });
  });

  afterEach(async () => {
    openaiUpstream?.stop(true);
    anthropicUpstream?.stop(true);
    openaiUpstream = null;
    anthropicUpstream = null;
    await ctx.cleanup();
    await rm(tmpHome, { recursive: true, force: true });
    await removeDaemonBaseDir(daemonBaseDir);
  });

  const env = () => ({
    HOME: tmpHome,
    LAZY_DAEMON_BASE_DIR: daemonBaseDir,
    LAZY_TEST: '',
    ANTHROPIC_API_KEY: REAL_ANTHROPIC_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: '',
    OPENAI_API_KEY: REAL_OPENAI_KEY,
  });

  /** Mint a grant in the running daemon's registry (see cursor e2e for why). */
  async function mintGrantForDaemon(taskId: string, envKey: string, profile: string): Promise<string> {
    const previous = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = daemonBaseDir;
    try {
      const daemonRoot = (await readFile(getRootPath(ctx.root), 'utf-8')).trim();
      expect(daemonRoot).toBe(ctx.root);
      return await mintCredentialGrant(ctx.root, {
        role: 'agent',
        taskId,
        label: `lazy-${taskId}`,
        envKey,
        profile,
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
   * Point the primary upstream and the codex PROFILE at the fakes. NO role
   * config — the absence of it is part of what this suite exercises.
   */
  async function pinProxyUpstreams(): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    expect(before).not.toMatch(/^\s*\[proxy\]/m);
    await writeFile(
      configPath,
      `${before}\n[proxy]\nupstream = "http://127.0.0.1:${anthropicUpstream!.port}"\n\n` +
      `[agents.codex]\nharness = "codex"\nmodel = "gpt-5.2-codex"\n` +
      `endpoint = "http://127.0.0.1:${openaiUpstream!.port}"\ncredential = "openai"\n`,
    );
  }

  async function proxyAddress(): Promise<string> {
    const status = await ctx.lazy(['daemon', 'status'], { env: env() });
    const match = status.stdout.match(/Proxy:\s+(\S+)\s+→/);
    expect(match, `no proxy address in daemon status:\n${status.stdout}`).not.toBeNull();
    return match![1];
  }

  test('a codex-profile grant routes to that profile\'s upstream with the real key; a claude-code grant stays on the primary', async () => {
    await pinFreeServerPort();
    await pinProxyUpstreams();

    const started = await ctx.lazy(['daemon', 'start'], { env: env() });
    expect(started.exitCode, started.stderr).toBe(0);
    try {
      const address = await proxyAddress();

      // --- The codex profile's own upstream ---
      const codexPlaceholder = await mintGrantForDaemon('tskcodex', 'OPENAI_API_KEY', 'codex');
      const res = await fetch(`${address}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${codexPlaceholder}`,
        },
        body: JSON.stringify({ model: 'gpt-5.2-codex', input: [], stream: false }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: 'resp-codex-e2e' });

      // The daemon-held OpenAI key went out; the placeholder never did.
      expect(seenOpenai).toHaveLength(1);
      expect(seenOpenai[0]!.path).toBe('/v1/responses');
      expect(seenOpenai[0]!.auth).toBe(`Bearer ${REAL_OPENAI_KEY}`);
      expect(seenOpenai[0]!.body).not.toContain(codexPlaceholder);
      // Nothing about the codex request touched the primary upstream.
      expect(seenAnthropic).toHaveLength(0);

      // --- The negative: a claude-code grant is untouched by all this ---
      const claudePlaceholder = await mintGrantForDaemon('tskclaude', 'ANTHROPIC_API_KEY', 'claude-code');
      const claudeRes = await fetch(`${address}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': claudePlaceholder,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(claudeRes.status).toBe(200);
      expect(await claudeRes.json()).toMatchObject({ id: 'msg-anthropic-e2e' });
      expect(seenAnthropic).toHaveLength(1);
      expect(seenAnthropic[0]!.path).toBe('/v1/messages');
      // Still exactly one OpenAI-upstream request — the claude turn did not
      // get rerouted by codex support existing in the same project.
      expect(seenOpenai).toHaveLength(1);

      // --- Attribution + usage, from the grants (evidence) ---
      const records = await auditRecords(2);
      const codexRecord = records.find(r => r.taskId === 'tskcodex');
      expect(codexRecord).toBeDefined();
      expect(codexRecord.endpoint).toBe('responses');
      expect(codexRecord.status).toBe(200);
      // OpenAI usage extracted on the wire, cached tokens split into cache
      // reads (50 input = 30 input + 20 cached).
      expect(codexRecord.usage).toEqual({
        inputTokens: 30,
        outputTokens: 10,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: 20,
      });
      const claudeRecord = records.find(r => r.taskId === 'tskclaude');
      expect(claudeRecord).toBeDefined();
      expect(claudeRecord.status).toBe(200);
    } finally {
      await ctx.lazy(['daemon', 'stop'], { env: env() });
    }
  });

  /**
   * The SUBSCRIPTION variant of the same round trip: a codex profile billing
   * the `chatgpt` credential.
   *
   * Three things only an end-to-end run can show, because each involves a
   * different module agreeing with the others: the `/responses` path (no `/v1`
   * — the spelling the real ChatGPT backend uses) survives the allowlist in the
   * running server; the placeholder is replaced by the stored ACCESS token
   * rather than the stored blob; and the `chatgpt-account-id` header the codex
   * CLI normally sends is supplied by the proxy, since lazy deliberately keeps
   * the account id out of the container.
   *
   * The endpoint is a loopback fake, as above — the real chatgpt.com is not
   * reachable from a hermetic test — so the profile names `credential` outright.
   * The hostname rule that picks that slot from a real chatgpt.com endpoint is
   * unit-tested in test/unit/chatgpt-credential.test.ts.
   */
  test('a chatgpt-credential grant gets the stored access token and the account header', async () => {
    await pinFreeServerPort();

    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    // A token that expires far in the future, so nothing here tries to refresh:
    // this suite is about presentation, and a refresh would need the network.
    const accessToken =
      `${b64({ alg: 'RS256', typ: 'JWT' })}.` +
      `${b64({ exp: Math.floor(Date.now() / 1000) + 86_400 })}.sig`;
    const session = JSON.stringify({
      auth_mode: 'chatgpt',
      access_token: accessToken,
      refresh_token: 'rt-e2e-must-not-leave-the-host',
      account_id: 'acct-e2e-roundtrip',
    });

    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    await writeFile(
      configPath,
      `${before}\n[proxy]\nupstream = "http://127.0.0.1:${anthropicUpstream!.port}"\n\n` +
      `[agents.codex]\nharness = "codex"\nmodel = "gpt-5.6-sol"\n` +
      `endpoint = "http://127.0.0.1:${openaiUpstream!.port}"\ncredential = "chatgpt"\n`,
    );

    // The session arrives the way a user's would: through the environment
    // override, which needs no keychain and no backend choice in a temp HOME.
    const subEnv = () => ({ ...env(), CHATGPT_AUTH: session });

    const started = await ctx.lazy(['daemon', 'start'], { env: subEnv() });
    expect(started.exitCode, started.stderr).toBe(0);
    try {
      const status = await ctx.lazy(['daemon', 'status'], { env: subEnv() });
      const address = status.stdout.match(/Proxy:\s+(\S+)\s+→/)![1];

      const placeholder = await mintGrantForDaemon('tsksub', 'OPENAI_API_KEY', 'codex');
      const res = await fetch(`${address}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${placeholder}` },
        body: JSON.stringify({ model: 'gpt-5.6-sol', input: [], stream: false }),
      });
      expect(res.status).toBe(200);

      expect(seenOpenai).toHaveLength(1);
      // The /v1-less path reached the upstream UNCHANGED — no rewrite, and the
      // allowlist let it through on the openai tier.
      expect(seenOpenai[0]!.path).toBe('/responses');
      // The ACCESS token, not the stored session blob, and never the placeholder.
      expect(seenOpenai[0]!.auth).toBe(`Bearer ${accessToken}`);
      expect(seenOpenai[0]!.auth).not.toContain(placeholder);
      expect(seenOpenai[0]!.account).toBe('acct-e2e-roundtrip');
      // The refresh token is the host's alone: it is not a wire credential and
      // must never appear on any request the proxy forwards.
      expect(JSON.stringify(seenOpenai[0])).not.toContain('rt-e2e-must-not-leave-the-host');

      // Usage is still extracted: the /v1-less path classifies as `responses`.
      const records = await auditRecords(1);
      const record = records.find(r => r.taskId === 'tsksub');
      expect(record).toBeDefined();
      expect(record.endpoint).toBe('responses');
      expect(record.status).toBe(200);
      expect(record.usage.outputTokens).toBe(10);
    } finally {
      await ctx.lazy(['daemon', 'stop'], { env: subEnv() });
    }
  });
});
