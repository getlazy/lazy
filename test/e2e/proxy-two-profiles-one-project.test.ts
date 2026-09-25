/**
 * Two profiles of the SAME harness, two upstreams, two keys — one project.
 *
 * This is the case role-wide backends could not express at all: `[models.roles.
 * agent] backend = "openai"` decided the upstream for every task in the role, so
 * a project could have one OpenAI-compatible service, not two. A profile is a
 * per-task choice, so `[agents.house-codex]` and `[agents.work-codex]` can run
 * the same harness against different services on different credentials, at the
 * same time.
 *
 * What is actually proven here, per grant: the request lands on THAT profile's
 * upstream, carrying THAT profile's credential, and the other upstream sees
 * nothing. Routing comes from the grant the daemon minted (broker-verified
 * evidence), never from a header the caller could set — so the two turns cannot
 * borrow each other's upstream or key by claiming to be one another.
 *
 * `work-codex` bills a NAMED credential (`credential = "work-openai"`), which is
 * how "a second key on a service lazy already knows" is spelled; `house-codex`
 * bills the provider slot. Same provider, same harness, different keys.
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

/** The house key: the `openai` provider slot, carried in its own env var. */
const HOUSE_KEY = 'sk-proj-HOUSE-OPENAI-KEY';
/** The work key: a NAMED credential (`work-openai`), a different secret. */
const WORK_KEY = 'sk-proj-WORK-OPENAI-KEY';

interface Upstream {
  server: ReturnType<typeof Bun.serve>;
  seen: Array<{ path: string; auth: string | null; apiKey: string | null; body: string }>;
}

/**
 * A fake upstream. `wire` only decides the response SHAPE — an anthropic-wire
 * profile's traffic is `/v1/messages` with `x-api-key`, an openai-wire one's is
 * `/v1/chat/completions` with a bearer.
 */
function startUpstream(id: string, wire: 'openai' | 'anthropic' = 'openai'): Upstream {
  const seen: Upstream['seen'] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      seen.push({
        path: u.pathname,
        auth: req.headers.get('authorization'),
        apiKey: req.headers.get('x-api-key'),
        body: await req.text(),
      });
      return wire === 'anthropic'
        ? Response.json({
          id: `msg-${id}`,
          type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, output_tokens: 2 },
        })
        : Response.json({
          id: `chatcmpl-${id}`,
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        });
    },
  });
  return { server, seen };
}

describe('two profiles of one harness, two upstreams, one project', () => {
  let ctx: TestContext;
  let tmpHome: string;
  let daemonBaseDir: string;
  let house: Upstream;
  let work: Upstream;
  /** A local model server, spoken to on the anthropic wire (pi's ollama route). */
  let ollama: Upstream;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-two-profiles-'));
    daemonBaseDir = await makeDaemonBaseDir();
    house = startUpstream('house');
    work = startUpstream('work');
    ollama = startUpstream('ollama', 'anthropic');
  });

  afterEach(async () => {
    house.server.stop(true);
    work.server.stop(true);
    ollama.server.stop(true);
    await ctx.cleanup();
    await rm(tmpHome, { recursive: true, force: true });
    await removeDaemonBaseDir(daemonBaseDir);
  });

  const env = () => ({
    HOME: tmpHome,
    LAZY_DAEMON_BASE_DIR: daemonBaseDir,
    LAZY_TEST: '',
    // The default profile and the builder are still claude-code, so the daemon
    // gate wants an Anthropic credential too.
    ANTHROPIC_API_KEY: 'sk-ant-fake-for-test',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    OPENAI_API_KEY: HOUSE_KEY,
    // A named credential's env var is mechanical from its name — see
    // namedCredentialEnvVar in src/credentials/providers.ts.
    LAZY_CREDENTIAL_WORK_OPENAI: WORK_KEY,
  });

  /** Mint a grant for `profile` in the RUNNING daemon's registry. */
  async function mintGrantForDaemon(
    profile: string,
    taskId: string,
    envKey = 'OPENAI_API_KEY',
  ): Promise<string> {
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
   * Declare both profiles. Each names its credential because both endpoints are
   * on loopback, and a local upstream defaults to none — see the openai
   * round-trip suite for why that default is what it is.
   */
  async function addProfiles(): Promise<void> {
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    expect(before).not.toMatch(/^\s*\[agents\./m);
    await writeFile(
      configPath,
      `${before}\n` +
      `[agents.house-codex]\nharness = "codex"\nmodel = "gpt-5.2"\n` +
      `endpoint = "http://127.0.0.1:${house.server.port}"\ncredential = "openai"\n\n` +
      `[agents.work-codex]\nharness = "codex"\nmodel = "gpt-5.2-work"\n` +
      `endpoint = "http://127.0.0.1:${work.server.port}"\ncredential = "work-openai"\n\n` +
      // A third profile on the OTHER wire: pi against a local model server,
      // which authenticates nobody — so it names no credential and gets the
      // local default of none.
      `[agents.local-pi]\nharness = "pi"\nmodel = "qwen3:8b"\n` +
      `endpoint = "http://127.0.0.1:${ollama.server.port}"\n`,
    );
  }

  async function proxyAddress(): Promise<string> {
    const status = await ctx.lazy(['daemon', 'status'], { env: env() });
    const match = status.stdout.match(/Proxy:\s+(\S+)\s+→/);
    expect(match, `no proxy address in daemon status:\n${status.stdout}`).not.toBeNull();
    return match![1];
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

  async function chat(address: string, placeholder: string, model: string): Promise<Response> {
    return fetch(`${address}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${placeholder}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
    });
  }

  test('each grant lands on its own upstream with its own key, and the other is untouched', async () => {
    await pinFreeServerPort();
    await addProfiles();

    const started = await ctx.lazy(['daemon', 'start'], { env: env() });
    expect(started.exitCode, started.stderr).toBe(0);
    try {
      const address = await proxyAddress();
      const housePlaceholder = await mintGrantForDaemon('house-codex', 'tskhouse');
      const workPlaceholder = await mintGrantForDaemon('work-codex', 'tskwork');
      // Two launches, two grants — and two DIFFERENT placeholders, or one turn
      // could present the other's and inherit its routing.
      expect(housePlaceholder).not.toBe(workPlaceholder);

      const houseRes = await chat(address, housePlaceholder, 'gpt-5.2');
      expect(houseRes.status).toBe(200);
      expect(await houseRes.json()).toMatchObject({ id: 'chatcmpl-house' });

      // The house turn reached the house service, on the house key.
      expect(house.seen).toHaveLength(1);
      expect(house.seen[0].path).toBe('/v1/chat/completions');
      expect(house.seen[0].auth).toBe(`Bearer ${HOUSE_KEY}`);
      // THE point: the other profile's service saw nothing at all.
      expect(work.seen).toHaveLength(0);

      const workRes = await chat(address, workPlaceholder, 'gpt-5.2-work');
      expect(workRes.status).toBe(200);
      expect(await workRes.json()).toMatchObject({ id: 'chatcmpl-work' });

      // The work turn reached the work service on the NAMED credential — a
      // different secret on the same provider, which is why a profile may name
      // one at all.
      expect(work.seen).toHaveLength(1);
      expect(work.seen[0].auth).toBe(`Bearer ${WORK_KEY}`);
      // Neither key ever reached the wrong service, and neither placeholder
      // reached any service.
      expect(house.seen).toHaveLength(1);
      expect(house.seen[0].auth).not.toContain(WORK_KEY);
      expect(work.seen[0].auth).not.toContain(HOUSE_KEY);
      for (const hit of [...house.seen, ...work.seen]) {
        expect(hit.body).not.toContain(housePlaceholder);
        expect(hit.body).not.toContain(workPlaceholder);
      }

      // Both turns are audited, each attributed to its own task and model.
      const records = await auditRecords(2);
      const houseRecord = records.find(r => r.taskId === 'tskhouse');
      const workRecord = records.find(r => r.taskId === 'tskwork');
      expect(houseRecord?.model).toBe('gpt-5.2');
      expect(houseRecord?.status).toBe(200);
      expect(workRecord?.model).toBe('gpt-5.2-work');
      expect(workRecord?.status).toBe(200);
    } finally {
      await ctx.lazy(['daemon', 'stop'], { env: env() });
    }
  });

  test('a profile on the other wire routes to its own upstream, unaided by a key', async () => {
    await pinFreeServerPort();
    await addProfiles();

    const started = await ctx.lazy(['daemon', 'start'], { env: env() });
    expect(started.exitCode, started.stderr).toBe(0);
    try {
      const address = await proxyAddress();
      // A `none`-credential profile is still placeholderized: the grant is what
      // authenticates the caller to the proxy and says which upstream its
      // traffic belongs to, so skipping it would cost the ROUTING, not just the
      // secrecy. The synthetic local credential occupies ANTHROPIC_AUTH_TOKEN.
      const placeholder = await mintGrantForDaemon('local-pi', 'tskpi', 'ANTHROPIC_AUTH_TOKEN');

      const res = await fetch(`${address}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': placeholder },
        body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: 'msg-ollama' });

      expect(ollama.seen).toHaveLength(1);
      expect(ollama.seen[0].path).toBe('/v1/messages');
      // Nothing the user owns was spent on a server that authenticates nobody:
      // neither the house key, nor the work key, nor the placeholder itself.
      const credentials = [
        ollama.seen[0].auth ?? '', ollama.seen[0].apiKey ?? '', ollama.seen[0].body,
      ].join(' ');
      expect(credentials).not.toContain(HOUSE_KEY);
      expect(credentials).not.toContain(WORK_KEY);
      expect(credentials).not.toContain(placeholder);

      // INVARIANT: an anthropic-wire profile's traffic never reaches an
      // openai-wire profile's service. Two wires, three profiles, one project —
      // and each request goes exactly one place.
      expect(house.seen).toHaveLength(0);
      expect(work.seen).toHaveLength(0);
    } finally {
      await ctx.lazy(['daemon', 'stop'], { env: env() });
    }
  });
});
