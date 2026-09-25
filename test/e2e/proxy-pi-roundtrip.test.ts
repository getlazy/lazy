/**
 * pi's OpenAI wire through the running daemon proxy, selected by PROFILE.
 *
 * test/e2e/proxy-openai-roundtrip.test.ts proves the openai-wire route for
 * codex's Responses API; this suite proves it for pi's wire — streaming Chat
 * Completions with `stream_options: {"include_usage": true}`, exactly what pi
 * 0.84.4 emits under lazy's per-turn models.json provider (verified against the
 * real binary; see docs/pi-agent-integration.md) — and for the two hosts a pi
 * profile can name for it. Three pi profiles in ONE project:
 *
 *  - `[agents.openai-pi]`      endpoint api.openai.com → openai wire, `openai` key
 *  - `[agents.openrouter-pi]`  endpoint openrouter.ai  → openai wire, `openrouter` key,
 *                              a SLASHED model id that must reach the upstream verbatim
 *  - the built-in `pi`         a LOCAL Ollama (its default since 2026-09-13,
 *                              pinned here at a loopback fake) → the Anthropic
 *                              wire, NO credential — untouched by the other two
 *
 * Neither wire nor credential is written in lazy.toml: both are inferred from
 * the endpoint hostname, which is the rule under test. Per grant, what is proven
 * is that the request lands on THAT profile's upstream carrying THAT profile's
 * real key, the placeholder never leaves, the other upstreams see nothing, an
 * off-wire request is refused rather than forwarded, and the audit record
 * carries the usage the proxy extracted from the SSE usage chunk.
 *
 * Hermetic hostname routing: the proxy forwards to `http://api.openai.com/…`
 * and `http://openrouter.ai/…` as the profiles say, and Bun's fetch honours
 * `HTTP_PROXY` — so the daemon is started with a loopback "internet" fake as
 * its HTTP proxy (and `NO_PROXY` for the daemon's own loopback traffic). The
 * fake sees the absolute-URI proxy requests, hostnames intact. Nothing in
 * `src/` is special-cased for the test; the two hostnames are the real rule.
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

/** The keys the DAEMON holds; each upstream must see its own, the client none. */
const REAL_OPENAI_KEY = 'sk-proj-THE-REAL-OPENAI-KEY-PI';
const REAL_OPENROUTER_KEY = 'sk-or-THE-REAL-OPENROUTER-KEY-PI';
const REAL_ANTHROPIC_KEY = 'sk-ant-THE-REAL-ANTHROPIC-KEY-PI';

/** An OpenRouter model id — slashed, as they all are. */
const OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5';

type Seen = { host: string; path: string; auth: string | null; body: string };

/**
 * The SSE stream a Chat Completions upstream answers with: per-chunk deltas,
 * then a final usage chunk (present because pi sends
 * stream_options.include_usage), then [DONE].
 */
function chatCompletionsSSE(model: string): string {
  const chunks = [
    { id: 'c-pi-e2e', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] },
    { id: 'c-pi-e2e', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { id: 'c-pi-e2e', object: 'chat.completion.chunk', model, choices: [], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49, prompt_tokens_details: { cached_tokens: 12 } } },
  ];
  return chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

describe('pi profiles on the OpenAI wire through the running daemon proxy', () => {
  let ctx: TestContext;
  let tmpHome: string;
  let daemonBaseDir: string;
  /** The "internet": reached as the daemon's HTTP proxy, sees hostnames. */
  let internet: ReturnType<typeof Bun.serve> | null = null;
  /** The primary Anthropic-wire upstream, on loopback like any other suite. */
  let primary: ReturnType<typeof Bun.serve> | null = null;
  /**
   * The LOCAL Ollama the built-in `pi` profile points at. Loopback, like a real
   * one: what is proven through it is that the default profile's traffic reaches
   * its own upstream and carries no credential there.
   */
  let ollama: ReturnType<typeof Bun.serve> | null = null;
  const seenInternet: Seen[] = [];
  const seenPrimary: Seen[] = [];
  const seenOllama: Seen[] = [];

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-pi-proxy-'));
    daemonBaseDir = await makeDaemonBaseDir();
    seenInternet.length = 0;
    seenPrimary.length = 0;
    seenOllama.length = 0;
    internet = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        // An HTTP proxy receives the absolute URI, so the hostname the daemon's
        // proxy forwarded to is right here.
        const u = new URL(req.url);
        const body = await req.text();
        seenInternet.push({ host: u.hostname, path: u.pathname, auth: req.headers.get('authorization'), body });
        let model = 'unknown';
        try { model = JSON.parse(body).model; } catch { /* a non-JSON probe; the model is only echoed */ }
        return new Response(chatCompletionsSSE(model), { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    ollama = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        seenOllama.push({
          host: u.hostname,
          path: u.pathname,
          auth: req.headers.get('x-api-key') ?? req.headers.get('authorization'),
          body: await req.text(),
        });
        return Response.json({ id: 'msg-ollama-e2e', usage: { input_tokens: 3, output_tokens: 2 } });
      },
    });
    primary = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        seenPrimary.push({
          host: u.hostname,
          path: u.pathname,
          auth: req.headers.get('x-api-key') ?? req.headers.get('authorization'),
          body: await req.text(),
        });
        return Response.json({ id: 'msg-anthropic-e2e', usage: { input_tokens: 3, output_tokens: 2 } });
      },
    });
  });

  afterEach(async () => {
    internet?.stop(true);
    primary?.stop(true);
    ollama?.stop(true);
    internet = null;
    primary = null;
    ollama = null;
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
    OPENROUTER_API_KEY: REAL_OPENROUTER_KEY,
    // Everything the daemon's proxy forwards to a real hostname lands on the
    // fake internet; its own loopback traffic (the CLI's RPC, the primary
    // upstream) stays direct.
    HTTP_PROXY: `http://127.0.0.1:${internet!.port}`,
    NO_PROXY: '127.0.0.1,localhost',
  });

  /**
   * Mint a grant for `profile` in the RUNNING daemon's registry (see the cursor
   * e2e for why). `envKey` is the var the launch puts the placeholder in:
   * ANTHROPIC_AUTH_TOKEN for every non-Anthropic credential
   * (resolveProfileLaunchCreds) — the models.json openai provider interpolates
   * exactly that var — and ANTHROPIC_API_KEY for the Anthropic default.
   */
  async function mintGrantForDaemon(profile: string, taskId: string, envKey: string): Promise<string> {
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
        .map(l => JSON.parse(l)).filter(r => r.role === 'agent' && r.status === 200);
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
   * The primary upstream at the loopback fake, and the two OpenAI-wire pi
   * profiles by hostname only. No `credential` on either: the openai one is
   * inferred from api.openai.com, the openrouter one from openrouter.ai —
   * that inference, and the wire that comes with it, is what this suite
   * exists to observe end to end.
   *
   * `[agents.pi]` overrides the built-in only in ADDRESS: its default is a
   * local Ollama on this machine, and the loopback fake stands in for one. The
   * shape under test — Anthropic wire on a non-Anthropic host, credential
   * inferred as none — is the default's own.
   */
  async function pinUpstreamsAndProfiles(): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    expect(before).not.toMatch(/^\s*\[proxy\]/m);
    expect(before).not.toMatch(/^\s*\[agents\./m);
    await writeFile(
      configPath,
      `${before}\n[proxy]\nupstream = "http://127.0.0.1:${primary!.port}"\n\n` +
      `[agents.openai-pi]\nharness = "pi"\nmodel = "gpt-5.2"\nendpoint = "http://api.openai.com"\n\n` +
      `[agents.openrouter-pi]\nharness = "pi"\nmodel = "${OPENROUTER_MODEL}"\nendpoint = "http://openrouter.ai/api"\n\n` +
      `[agents.pi]\nharness = "pi"\nmodel = "qwen3.8:latest"\nendpoint = "http://127.0.0.1:${ollama!.port}"\n`,
    );
  }

  async function proxyAddress(): Promise<string> {
    const status = await ctx.lazy(['daemon', 'status'], { env: env() });
    const match = status.stdout.match(/Proxy:\s+(\S+)\s+→/);
    expect(match, `no proxy address in daemon status:\n${status.stdout}`).not.toBeNull();
    return match![1];
  }

  /** Exactly what pi 0.84.4 sends under lazy's models.json openai provider. */
  async function piChatCompletion(address: string, placeholder: string, model: string): Promise<Response> {
    return fetch(`${address}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${placeholder}` },
      body: JSON.stringify({
        model,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
  }

  test('each pi profile lands on its own upstream with its own key; the Anthropic one is untouched', async () => {
    await pinFreeServerPort();
    await pinUpstreamsAndProfiles();

    const started = await ctx.lazy(['daemon', 'start'], { env: env() });
    expect(started.exitCode, started.stderr).toBe(0);
    try {
      const address = await proxyAddress();
      const openaiPlaceholder = await mintGrantForDaemon('openai-pi', 'tskopenai', 'ANTHROPIC_AUTH_TOKEN');
      const routerPlaceholder = await mintGrantForDaemon('openrouter-pi', 'tskrouter', 'ANTHROPIC_AUTH_TOKEN');
      // The built-in pi profile's credential slot is `none` (local endpoint), and
      // every non-Anthropic credential rides ANTHROPIC_AUTH_TOKEN.
      const localPiPlaceholder = await mintGrantForDaemon('pi', 'tskpi', 'ANTHROPIC_AUTH_TOKEN');
      // Three launches, three grants, three DIFFERENT placeholders — or one
      // turn could present another's and inherit its routing.
      expect(new Set([openaiPlaceholder, routerPlaceholder, localPiPlaceholder]).size).toBe(3);

      // --- openai-pi: api.openai.com on the openai wire, the openai key ---
      const openaiRes = await piChatCompletion(address, openaiPlaceholder, 'gpt-5.2');
      expect(openaiRes.status).toBe(200);
      expect(await openaiRes.text()).toContain('data: [DONE]');

      expect(seenInternet).toHaveLength(1);
      expect(seenInternet[0]!.host).toBe('api.openai.com');
      expect(seenInternet[0]!.path).toBe('/v1/chat/completions');
      // The daemon-held OpenAI key went out; the placeholder never did.
      expect(seenInternet[0]!.auth).toBe(`Bearer ${REAL_OPENAI_KEY}`);
      expect(seenInternet[0]!.body).not.toContain(openaiPlaceholder);
      expect(seenPrimary).toHaveLength(0);

      // --- openrouter-pi: openrouter.ai on the SAME wire, the openrouter key,
      // a slashed model id forwarded verbatim ---
      const routerRes = await piChatCompletion(address, routerPlaceholder, OPENROUTER_MODEL);
      expect(routerRes.status).toBe(200);
      expect(await routerRes.text()).toContain('data: [DONE]');

      expect(seenInternet).toHaveLength(2);
      expect(seenInternet[1]!.host).toBe('openrouter.ai');
      expect(seenInternet[1]!.path).toBe('/api/v1/chat/completions');
      expect(seenInternet[1]!.auth).toBe(`Bearer ${REAL_OPENROUTER_KEY}`);
      expect(JSON.parse(seenInternet[1]!.body).model).toBe(OPENROUTER_MODEL);
      expect(seenInternet[1]!.body).not.toContain(routerPlaceholder);
      // Neither key reached the other service.
      expect(seenInternet[0]!.auth).not.toContain(REAL_OPENROUTER_KEY);
      expect(seenInternet[1]!.auth).not.toContain(REAL_OPENAI_KEY);
      expect(seenPrimary).toHaveLength(0);

      // --- the DEFAULT pi profile: the Anthropic wire to a local Ollama, on
      // nobody's credential. This is what `--agent pi` now is, end to end ---
      const localRes = await fetch(`${address}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': localPiPlaceholder,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: 'qwen3.8:latest', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(localRes.status).toBe(200);
      expect(await localRes.json()).toMatchObject({ id: 'msg-ollama-e2e' });
      expect(seenOllama).toHaveLength(1);
      expect(seenOllama[0]!.path).toBe('/v1/messages');
      // INVARIANT: a local model server ignores auth, so it is handed NO
      // credential — not the user's Anthropic key, and never the placeholder.
      expect(seenOllama[0]!.auth).toBeNull();
      expect(seenOllama[0]!.body).not.toContain(localPiPlaceholder);
      // INVARIANT: the default profile does not touch the primary Anthropic
      // upstream. Before this default it rode the primary, so a regression
      // here is a turn silently billing Anthropic again.
      expect(seenPrimary).toHaveLength(0);
      // Still exactly two OpenAI-wire requests: this turn was not rerouted by
      // the OpenAI-wire pi profiles existing in the project.
      expect(seenInternet).toHaveLength(2);

      // INVARIANT: wire isolation. An openai-wire pi grant's Anthropic-shaped
      // request is refused with lazy's actionable 403, not forwarded to an
      // upstream that would 404 — and nothing reached any upstream.
      const refused = await fetch(`${address}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiPlaceholder}` },
        body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
      });
      expect(refused.status).toBe(403);
      expect(seenInternet).toHaveLength(2);
      expect(seenOllama).toHaveLength(1);
      expect(seenPrimary).toHaveLength(0);

      // --- Attribution + usage, from the grants (evidence) ---
      const records = await auditRecords(3);
      const openaiRecord = records.find(r => r.taskId === 'tskopenai');
      expect(openaiRecord).toBeDefined();
      expect(openaiRecord.endpoint).toBe('chat_completions');
      expect(openaiRecord.model).toBe('gpt-5.2');
      // Usage extracted from the SSE usage chunk, cached tokens split into
      // cache reads (42 prompt = 30 input + 12 cached) — the same subtraction
      // pi itself reports agent-side, so the two accountings agree.
      expect(openaiRecord.usage).toEqual({
        inputTokens: 30,
        outputTokens: 7,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: 12,
      });
      const routerRecord = records.find(r => r.taskId === 'tskrouter');
      expect(routerRecord).toBeDefined();
      expect(routerRecord.endpoint).toBe('chat_completions');
      expect(routerRecord.model).toBe(OPENROUTER_MODEL);
      expect(routerRecord.usage?.inputTokens).toBe(30);
      const localPiRecord = records.find(r => r.taskId === 'tskpi');
      expect(localPiRecord).toBeDefined();
      expect(localPiRecord.status).toBe(200);
      // Audited like any other turn — a local upstream is inside the audit
      // plane, not an exemption from it — and against ITS upstream, not the
      // primary one.
      expect(localPiRecord.endpoint).toBe('messages');
      expect(localPiRecord.model).toBe('qwen3.8:latest');
      expect(localPiRecord.upstream).toContain(String(ollama!.port));
    } finally {
      await ctx.lazy(['daemon', 'stop'], { env: env() });
    }
  });
});
