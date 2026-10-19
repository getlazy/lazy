/**
 * ACCEPTANCE — Teams core flow 3: chatting with the builder.
 *
 * One walk through the flow the way people use it, against a MANAGED daemon:
 *
 *   1. Alice, in a clone bound to Teams (`lazy clone`'s login record, no
 *      `lazy init`), runs `lazy builder`. It starts her session on the SERVER
 *      through Teams and attaches her terminal; what she types reaches the
 *      session's container and comes back.
 *   2. Carol, in the browser, presses "Start your builder" and opens its
 *      terminal. The Rails app does exactly two things for that, both on the
 *      MEMBER's own actor token (`LazyDaemon::Client.for_user`): the
 *      `startBuilderSession` RPC (`BuilderSessions::StartJob`) and, for the
 *      terminal, the `attachSession` preflight then the attach upgrade
 *      (`Api::SessionAttachesController` + `SessionRelay`). This test makes
 *      those daemon calls the way Rails does; the Rails half is covered by
 *      `lazy-teams/test/surface/builder_sessions_surface_test.rb`,
 *      `lazy-teams/test/clients/lazy_daemon/control_token_sweep_test.rb` (member
 *      token on every call) and `Api::SessionAttachesControllerTest`.
 *   3. Every builder SPENDS ITS OWN MEMBER'S credential: the credential each
 *      container was handed, sent through the daemon's proxy, reaches the
 *      Anthropic upstream as that member's token — never the project's
 *      service credential, never another member's.
 *   4. Bob, who stored no credential, is refused with the reason, and nothing
 *      is launched or billed for him (no silent fallback to the service one).
 *
 * Stood in for (external systems only): Teams' two routes for the clone (the
 * RPC proxy and the attach relay — `relayTeamsRpc`, which admits what the
 * Rails tables admit), the container runtime (fake docker CLI + fake Engine
 * API whose attach echoes), and Anthropic (a loopback upstream that records
 * the credential it was sent). A real Claude Code drawing a real terminal in a
 * real VM is the Mac check: docs/teams-core-flows-mac-check.md §3.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { seedAgentBinaryStamp, startFakeEngine, type FakeEngine } from '../helpers/fake-docker-engine';
import { storageDirFor } from '../helpers/storage';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { relayTeamsRpc } from '../helpers/teams-rpc-proxy-stub';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { NO_OWNER_ENDPOINT_CREDENTIAL_MARKER } from '../../src/daemon/member-credentials';
import { IMAGE_TAG, calculateImageInputManifest, calculateImageInputsHash } from '../../src/capture/claude';
import { writeTeamsLogin } from '../../src/teams/login';
import { auditLogPath } from '../../src/proxy/audit-log';
import { runGit } from '../../src/utils/git';
import type { BuilderSession } from '../../src/storage/types';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const CAROL = 'carol@example.com';
const TOKENS: Record<string, string> = {
  [ALICE]: 'sk-ant-oat01-alice-own',
  [CAROL]: 'sk-ant-oat01-carol-own',
  [SERVICE_CREDENTIAL_USER_ID]: 'sk-ant-oat01-service',
};
const CLI_TOKEN = 'lz_cli_alice';
const PROJECT = 'acme/lazy-toy';
const ENTRY = join(import.meta.dir, '..', '..', 'src', 'index.ts');

describe('Teams core flow: builder chat', () => {
  let ctx: TestContext;
  let workDir: string;
  let clone: string;
  let home: string;
  let unpinBase: () => void;
  let docker: FakeDocker;
  let engine: FakeEngine;
  let target: string;
  const actor: Record<string, string> = {};
  let teams: ReturnType<typeof Bun.serve> | undefined;
  let anthropic: ReturnType<typeof Bun.serve> | undefined;
  const upstreamAuth: string[] = [];
  const proxied: string[] = [];
  const upstreamUrl = () => `http://127.0.0.1:${anthropic!.port}`;

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  /** Teams for a bound clone: RPC proxy + attach relay, on Alice's actor token. */
  function startTeams(): ReturnType<typeof Bun.serve> {
    const base = `/api/projects/${PROJECT}`;
    type Relay = { upstream: WebSocket; pending: Array<string | ArrayBuffer | Uint8Array> };
    return Bun.serve<Relay>({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req, server) {
        const url = new URL(req.url);
        if (req.headers.get('authorization') !== `Bearer ${CLI_TOKEN}`) {
          return Response.json({ error: 'A CLI-scoped API token is required.' }, { status: 401 });
        }
        const attach = new RegExp(`^${base}/sessions/([^/]+)/attach$`).exec(url.pathname);
        if (attach) {
          const upstream = new WebSocket(
            target.replace(/^http/, 'ws') + `/rpc/sessions/${attach[1]}/attach/ws${url.search}`,
            { headers: { Authorization: `Bearer ${actor[ALICE]}`, 'X-Lazy-Project': ctx.root } } as never,
          );
          upstream.binaryType = 'arraybuffer';
          proxied.push(`attach ${attach[1]}`);
          return server.upgrade(req, { data: { upstream, pending: [] } }) ? undefined : new Response('upgrade failed', { status: 400 });
        }
        const relayed = await relayTeamsRpc(req, {
          project: PROJECT, cliToken: CLI_TOKEN, projectRoot: ctx.root, proxied,
          daemonTarget: () => target, memberToken: () => actor[ALICE]!,
        });
        return relayed ?? Response.json({ error: 'not found' }, { status: 404 });
      },
      websocket: {
        open(ws) {
          const { upstream } = ws.data;
          upstream.onmessage = (ev) => ws.send(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
          upstream.onclose = () => ws.close();
          upstream.onopen = () => { for (const m of ws.data.pending.splice(0)) upstream.send(m); };
        },
        message(ws, message) {
          const { upstream } = ws.data;
          if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
          else ws.data.pending.push(message);
        },
        close(ws) { ws.data.upstream.close(); },
      },
    });
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lzcf3-'));
    docker = await installFakeDocker(workDir);
    engine = startFakeEngine(join(workDir, 'engine.sock'));
    anthropic = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        upstreamAuth.push(req.headers.get('authorization') ?? req.headers.get('x-api-key') ?? '');
        await req.text();
        return Response.json({ id: 'msg-cf3', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
      },
    });
    const homesBase = join(workDir, 'homes');
    process.env.LAZY_BUILDER_HOMES_BASE_DIR = homesBase;

    ctx = await setupTestLazy({ fakeClaude: true });
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const patched = before.replace('type = "dangerously-host-process-without-any-isolation"', 'type = "docker"');
    if (patched === before) throw new Error('could not restore [runner] type = "docker" in the generated lazy.toml');
    if (/^\s*\[proxy\]/m.test(patched)) throw new Error('generated lazy.toml already has [proxy]; edit its upstream key instead');
    // The repository's lazy.toml: docker, and the proxy's upstream at the
    // stand-in (a test seam a released managed daemon refuses).
    const repoConfig = `${patched}\n[proxy]\nupstream = "${upstreamUrl()}"\n`;
    await writeFile(configPath, repoConfig);
    // The builder's profile is the PROJECT OWNER's configuration, pushed by
    // Teams (`applyProjectConfig`, below) — a repository may not name an
    // endpoint on a managed host. A fixture cannot use the built-in Anthropic
    // endpoint either: an Anthropic credential is never sent to a non-Anthropic
    // origin, so the profile uses a generic named endpoint.
    const ownerConfig = `${repoConfig}\n[models.roles.builder]\nagent = "builder-stand-in"\n\n` +
      `[agents.builder-stand-in]\nharness = "claude-code"\nmodel = "claude-sonnet-4-6"\nnamed_endpoint = "stand-in"\n\n` +
      `[endpoints.stand-in]\nurl = "${upstreamUrl()}"\ncredential = "builder-account"\n`;
    const controlPlaneConfig = join(workDir, 'control-plane', 'lazy.toml');
    await mkdir(join(workDir, 'control-plane'), { recursive: true });
    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`, {
      dockerfileHash: await calculateImageInputsHash(ctx.root),
      inputs: await calculateImageInputManifest(ctx.root),
    });
    await seedAgentBinaryStamp(ctx.agentHome!);
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_MANAGED_CONFIG_PATH: controlPlaneConfig,
      LAZY_BUILDER_HOMES_BASE_DIR: homesBase,
      PATH: `${docker.binDir}:${process.env.PATH ?? ''}`,
      DOCKER_HOST: `unix://${engine.socketPath}`,
    });
    target = getDaemonTcpTarget(ctx.root)!;
    const shared = readToken(ctx.root)!;
    const pushed = await rpc(shared, 'applyProjectConfig', { toml: ownerConfig, origin: 'control-plane' }) as { applied: boolean };
    if (!pushed.applied) throw new Error(`the owner's config was not applied: ${JSON.stringify(pushed)}`);
    for (const [userId, token] of Object.entries(TOKENS)) {
      // Each member consented to the endpoint Teams showed them: the stand-in.
      await rpc(shared, 'putEndpointCredential', { userId, endpointId: 'stand-in', origin: upstreamUrl(), kind: 'api-key', token });
    }
    for (const email of [ALICE, BOB, CAROL]) {
      actor[email] = (await rpc(shared, 'mintActorToken', { kind: 'user', email }) as { token: string }).token;
    }

    clone = join(workDir, 'clone');
    await runGit(['init', clone], { cwd: workDir });
    await runGit(['config', 'user.email', ALICE], { cwd: clone });
    await runGit(['config', 'user.name', 'Alice'], { cwd: clone });
    await writeFile(join(clone, 'README.md'), '# lazy-toy\n');
    await runGit(['add', '.'], { cwd: clone });
    await runGit(['commit', '-m', 'Initial commit'], { cwd: clone });
    home = join(workDir, 'laptop-home');
    unpinBase = pinDaemonBaseDir(join(workDir, 'laptop-daemon'));
    teams = startTeams();
    await writeTeamsLogin(clone, {
      teamsUrl: `http://127.0.0.1:${teams.port}`, token: CLI_TOKEN, project: PROJECT, projectId: '42',
    });
  }, 240_000);

  afterAll(async () => {
    delete process.env.LAZY_BUILDER_HOMES_BASE_DIR;
    teams?.stop(true);
    anthropic?.stop(true);
    await ctx?.cleanup();
    unpinBase?.();
    engine?.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  /** `lazy builder` in the bound clone: wait to attach, type, see the echo, detach. */
  async function lazyBuilderFromClone(input: string) {
    const proc = Bun.spawn(['bun', 'run', ENTRY, 'builder'], {
      cwd: clone, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: {
        ...process.env, HOME: home, LAZY_DAEMON_BASE_DIR: join(workDir, 'laptop-daemon'), LAZY_TEST: '', LAZY_IS_DAEMON: '',
        // Nothing may be launched on the laptop: no docker on its PATH at all.
        PATH: (process.env.PATH ?? '').split(':').filter((p) => p !== docker.binDir).join(':'),
      },
    });
    let stdout = '';
    let stderr = '';
    const decoder = new TextDecoder();
    const reader = (async () => {
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) stdout += decoder.decode(chunk);
    })();
    const errReader = (async () => {
      for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) stderr += decoder.decode(chunk);
    })();
    const waitFor = async (needle: string) => {
      const deadline = Date.now() + 60_000;
      while (!stdout.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`never saw ${JSON.stringify(needle)}; stdout=${stdout}; stderr=${stderr}`);
        await Bun.sleep(50);
      }
    };
    await waitFor('attached:');
    proc.stdin.write(input);
    await proc.stdin.flush();
    await waitFor(input);
    await proc.stdin.end();
    const exitCode = await proc.exited;
    await Promise.all([reader, errReader]);
    return { stdout, stderr, exitCode };
  }

  /** The browser's terminal: Rails' `SessionRelay` dials this with the member's actor token. */
  async function browserTerminal(memberToken: string, sessionId: string, input: string): Promise<string> {
    const ws = new WebSocket(target.replace(/^http/, 'ws') + `/rpc/sessions/${sessionId}/attach/ws`,
      { headers: { Authorization: `Bearer ${memberToken}`, 'X-Lazy-Project': ctx.root } } as never);
    ws.binaryType = 'arraybuffer';
    let seen = '';
    const decoder = new TextDecoder();
    ws.onmessage = (ev) => { seen += typeof ev.data === 'string' ? ev.data : decoder.decode(ev.data as ArrayBuffer); };
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error(`attach failed: ${seen}`)); });
    const deadline = Date.now() + 30_000;
    while (!seen.includes('"type":"ready"') && Date.now() < deadline) await Bun.sleep(50);
    ws.send(new TextEncoder().encode(input));
    while (!seen.includes(input) && Date.now() < deadline) await Bun.sleep(50);
    ws.close();
    return seen;
  }

  /**
   * Spend as the container would: its agent dials the proxy address it was
   * handed with the credential it was handed. Returns the credential the
   * Anthropic stand-in received for that request.
   */
  async function spendAs(containerName: string): Promise<string> {
    const launch = (await docker.invocations()).find((l) => l.includes(' -d ') && l.includes(`--name ${containerName} `));
    if (!launch) throw new Error(`no launch recorded for ${containerName}`);
    const baseUrl = / -e ANTHROPIC_BASE_URL=(\S+)/.exec(launch)?.[1];
    const handed = / -e ANTHROPIC_(?:AUTH_TOKEN|API_KEY)=(\S+)/.exec(launch)?.[1];
    if (!baseUrl || !handed) throw new Error(`launch carries no proxy address or credential: ${launch}`);
    // The container must hold a placeholder, never a member's real secret.
    for (const real of Object.values(TOKENS)) expect(launch).not.toContain(real);
    const before = upstreamAuth.length;
    const res = await fetch(`${baseUrl.replace('host.docker.internal', '127.0.0.1')}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handed}`, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(upstreamAuth.length).toBe(before + 1);
    return upstreamAuth[before]!.replace(/^Bearer /, '');
  }

  /** Who the proxy audit says paid, for each request so far (polls until `n` exist). */
  async function auditedPayers(n: number): Promise<Array<string | null>> {
    let records: Array<{ userId?: string | null }> = [];
    for (let i = 0; i < 50 && records.length < n; i++) {
      const raw = await readFile(auditLogPath(join(ctx.root, '.lazy')), 'utf-8').catch(() => '');
      records = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (records.length < n) await Bun.sleep(100);
    }
    return records.map((r) => r.userId ?? null);
  }

  async function sessionsOf(email: string): Promise<BuilderSession[]> {
    const all = await rpc(actor[email]!, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[];
    return all.filter((s) => s.memberEmail === email && s.state === 'running');
  }

  // INVARIANT: a member chats with the builder from a bound clone AND from the
  // browser, and every builder turn spends that member's own credential —
  // never the service credential, never another member's, and a member with
  // none is refused rather than silently billed to someone else.
  test('chat from the clone and the browser, each on the member\'s own credential', async () => {
    // 1. Alice, from her bound clone.
    const cli = await lazyBuilderFromClone('hello-from-the-clone');
    expect(cli.exitCode, cli.stderr).toBe(0);
    const [aliceSession] = await sessionsOf(ALICE);
    expect(aliceSession).toBeDefined();
    expect(cli.stdout).toContain(`attached:${aliceSession!.containerName}`);
    expect(proxied).toContain('startBuilderSession');

    // 2. Carol, in the browser: StartJob, then the terminal.
    const carolSession = await rpc(actor[CAROL]!, 'startBuilderSession', {}) as BuilderSession;
    expect(carolSession.memberEmail).toBe(CAROL);
    // The attach controller asks the daemon first, on the member's token.
    await rpc(actor[CAROL]!, 'attachSession', { id: carolSession.id });
    expect(await browserTerminal(actor[CAROL]!, carolSession.id, 'hello-from-the-browser')).toContain('hello-from-the-browser');

    // 3. Each container bills its own member.
    expect(await spendAs(aliceSession!.containerName!)).toBe(TOKENS[ALICE]!);
    expect(await spendAs(carolSession.containerName!)).toBe(TOKENS[CAROL]!);
    // ...and the proxy's audit names the member who paid (attribution).
    expect(await auditedPayers(2)).toEqual([ALICE, CAROL]);

    // 4. Bob has no credential: refused, nothing launched, nothing spent.
    const launches = (await docker.invocations()).filter((l) => l.includes(' -d ')).length;
    const spent = upstreamAuth.length;
    const refusal = await rpc(actor[BOB]!, 'startBuilderSession', {}).then(() => null, (e: unknown) => e);
    expect(refusal).toBeInstanceOf(RpcApplicationError);
    expect((refusal as Error).message).toContain(NO_OWNER_ENDPOINT_CREDENTIAL_MARKER);
    expect((await docker.invocations()).filter((l) => l.includes(' -d ')).length).toBe(launches);
    expect(upstreamAuth.length).toBe(spent);
    expect(await sessionsOf(BOB)).toEqual([]);
  }, 300_000);
});
