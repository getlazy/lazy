/**
 * E2E: `lazy builder` in a clone bound to Lazy Teams starts a builder session
 * ON THE SERVER and attaches this terminal to it through Teams — launching
 * nothing locally — and the session's conversation lands in the project's
 * store (design doc §5.1, §5.6, §7.3 task 12).
 *
 * What is real: the lazy CLI subprocess in a freshly bound clone (`git init`,
 * `lazy login`'s record, no `lazy init`), its `startBuilderSession` /
 * `attachSession` calls and its WebSocket terminal client; a MANAGED daemon
 * with its gates, per-member actor tokens, the detached builder launch, the
 * attach upgrader and `ExecStream`'s attach relay; the builder capture path
 * (`daemonRemoteStorage` over `POST /builder/storage` with the builder token
 * the daemon minted for THIS session's container).
 *
 * What is stood in for, and why:
 *   - TEAMS is a Bun stub with the two routes a bound clone uses: the RPC
 *     proxy (which admits exactly what the Rails tables admit, read off the
 *     Ruby source) and the attach relay (frames copied verbatim both ways).
 *     The Rails half of both routes is proven in the Rails suite
 *     (`Api::SessionAttachesControllerTest`, `Api::Cli::RpcControllerTest`).
 *   - THE CONTAINER RUNTIME is the fake docker CLI plus a fake Engine API
 *     socket, as in session-attach-route.test.ts. Its attach echoes.
 *   - THE IN-CONTAINER SUPERVISOR's capture tick is performed by the test,
 *     with the real `daemonRemoteStorage` and the config file the daemon
 *     mounted into the launched container: what is NOT exercised is only that
 *     a real Claude Code wrote a transcript file for it to pick up. That half,
 *     and a real Docker attach, belong on the release checklist.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { seedAgentBinaryStamp, startFakeEngine, type FakeEngine } from '../helpers/fake-docker-engine';
import { storageDirFor } from '../helpers/storage';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { relayTeamsRpc } from '../helpers/teams-rpc-proxy-stub';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { IMAGE_TAG, calculateImageInputManifest, calculateImageInputsHash } from '../../src/capture/claude';
import { writeTeamsLogin } from '../../src/teams/login';
import { daemonRemoteStorage } from '../../src/supervisor/builder';
import { runGit } from '../../src/utils/git';
import type { BuilderSession, StoredConversation } from '../../src/storage/types';

const ALICE = 'alice@example.com';
const CLI_TOKEN = 'lz_cli_alice';
const PROJECT = 'acme/lazy-toy';
const ENTRY = join(import.meta.dir, '..', '..', 'src', 'index.ts');

describe('lazy builder in a clone bound to Lazy Teams', () => {
  let ctx: TestContext;
  let workDir: string;
  let clone: string;
  let home: string;
  let unpinBase: () => void;
  let docker: FakeDocker;
  let engine: FakeEngine;
  let target: string;
  let alice: string;
  let teams: ReturnType<typeof Bun.serve> | undefined;
  const proxied: string[] = [];

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  /**
   * Teams, as far as a bound clone can tell: the RPC proxy and the attach
   * relay, each authenticating the clone's CLI token and reaching the daemon
   * on the MEMBER's own actor token, exactly as the Rails routes do.
   */
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
          const upstreamUrl = target.replace(/^http/, 'ws') +
            `/rpc/sessions/${attach[1]}/attach/ws${url.search}`;
          const upstream = new WebSocket(upstreamUrl, {
            headers: { Authorization: `Bearer ${alice}`, 'X-Lazy-Project': ctx.root },
          } as never);
          upstream.binaryType = 'arraybuffer';
          const data: Relay = { upstream, pending: [] };
          proxied.push(`attach ${attach[1]}`);
          return server.upgrade(req, { data }) ? undefined : new Response('upgrade failed', { status: 400 });
        }
        const relayed = await relayTeamsRpc(req, {
          project: PROJECT, cliToken: CLI_TOKEN, projectRoot: ctx.root, proxied,
          daemonTarget: () => target, memberToken: () => alice,
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

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lzbcb-'));
    docker = await installFakeDocker(workDir);
    engine = startFakeEngine(join(workDir, 'engine.sock'));
    const homesBase = join(workDir, 'homes');
    process.env.LAZY_BUILDER_HOMES_BASE_DIR = homesBase;

    ctx = await setupTestLazy({ fakeClaude: true });
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const patched = before.replace('type = "dangerously-host-process-without-any-isolation"', 'type = "docker"');
    if (patched === before) throw new Error('could not restore [runner] type = "docker" in the generated lazy.toml');
    await writeFile(configPath, patched);
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_BUILDER_HOMES_BASE_DIR: homesBase,
      PATH: `${docker.binDir}:${process.env.PATH ?? ''}`,
      DOCKER_HOST: `unix://${engine.socketPath}`,
    });
    target = getDaemonTcpTarget(ctx.root)!;
    const shared = readToken(ctx.root)!;
    await rpc(shared, 'putUserCredential', { userId: ALICE, kind: 'oauth', token: 'sk-ant-oat01-alice-bound' });
    await rpc(shared, 'putUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'sk-ant-oat01-svc-bound' });
    alice = (await rpc(shared, 'mintActorToken', { kind: 'user', email: ALICE }) as { token: string }).token;
    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`, {
      dockerfileHash: await calculateImageInputsHash(ctx.root),
      inputs: await calculateImageInputManifest(ctx.root),
    });
    await seedAgentBinaryStamp(ctx.agentHome!);

    // The laptop: a fresh clone with nothing but a Teams login.
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
    proxied.length = 0;
  });

  afterEach(async () => {
    delete process.env.LAZY_BUILDER_HOMES_BASE_DIR;
    teams?.stop(true);
    await ctx.cleanup();
    unpinBase();
    engine.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  /**
   * Run a CLI command in the bound clone with a live stdin: wait for `ready`
   * in its output, type `input`, wait for `echo`, then close stdin — which is
   * how a piped terminal detaches.
   */
  async function runAttached(args: string[], input: string, echo: string) {
    const proc = Bun.spawn(['bun', 'run', ENTRY, ...args], {
      cwd: clone,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        HOME: home,
        LAZY_DAEMON_BASE_DIR: join(workDir, 'laptop-daemon'),
        LAZY_TEST: '',
        LAZY_IS_DAEMON: '',
        // Nothing may be launched on the laptop: no docker on its PATH at all.
        PATH: (process.env.PATH ?? '').split(':').filter((p) => p !== docker.binDir).join(':'),
      },
    });
    let stdout = '';
    const decoder = new TextDecoder();
    const reader = (async () => {
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) stdout += decoder.decode(chunk);
    })();
    const waitFor = async (needle: string) => {
      const deadline = Date.now() + 60_000;
      while (!stdout.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`never saw ${JSON.stringify(needle)}; stdout=${stdout}`);
        await Bun.sleep(50);
      }
    };
    await waitFor('attached:');
    proc.stdin.write(input);
    await proc.stdin.flush();
    await waitFor(echo);
    await proc.stdin.end();
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    await reader;
    return { stdout, stderr, exitCode };
  }

  // INVARIANT: in a bound clone `lazy builder` launches NOTHING locally: it
  // starts the member's session on the server through Teams and attaches this
  // terminal to it, and a second `lazy builder` joins that same session.
  test('starts a server-side session, attaches through Teams, and a second run joins it', async () => {
    const first = await runAttached(['builder'], 'hello-from-the-laptop', 'hello-from-the-laptop');
    expect(first.exitCode).toBe(0);

    const sessions = await rpc(alice, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[];
    const running = sessions.filter((s) => s.state === 'running');
    expect(running).toHaveLength(1);
    const session = running[0]!;
    expect(session.memberEmail).toBe(ALICE);
    // The bytes went laptop → Teams → daemon → the session's container, and
    // its output came back the same way.
    expect(first.stdout).toContain(`attached:${session.containerName}`);
    expect(first.stderr).toContain(`builder session ${session.id}`);
    expect(proxied).toContain('startBuilderSession');
    expect(proxied).toContain(`attach ${session.id}`);
    expect(engine.attaches).toEqual([session.containerName!]);
    expect(engine.execCreates).toEqual([]);

    const launches = (await docker.invocations()).filter((l) => l.includes(' -d ')).length;
    const second = await runAttached(['builder'], 'again', 'again');
    expect(second.exitCode).toBe(0);
    expect(second.stderr).toContain(`builder session ${session.id}`);
    expect(engine.attaches).toEqual([session.containerName!, session.containerName!]);
    expect((await docker.invocations()).filter((l) => l.includes(' -d ')).length).toBe(launches);
  }, 240_000);

  // INVARIANT: `lazy builder stop` / `end` with no id find the member's own
  // session in ANY state short of ended — a STOPPED session has no container,
  // and discovery that required one could never end it.
  test('lazy builder stop and then end, with no id, reach the member\'s own session', async () => {
    await runAttached(['builder'], 'hi', 'hi');
    const run = async (args: string[]) => {
      const proc = Bun.spawn(['bun', 'run', ENTRY, ...args], {
        cwd: clone, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, HOME: home, LAZY_DAEMON_BASE_DIR: join(workDir, 'laptop-daemon'), LAZY_TEST: '', LAZY_IS_DAEMON: '' },
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code };
    };
    const states = async () =>
      (await rpc(alice, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[]).map((x) => x.state);

    const stopped = await run(['builder', 'stop']);
    expect({ code: stopped.code, err: stopped.stderr }).toEqual({ code: 0, err: expect.any(String) });
    expect(await states()).toEqual(['stopped']);

    const ended = await run(['builder', 'end']);
    expect({ code: ended.code, err: ended.stderr }).toEqual({ code: 0, err: expect.any(String) });
    expect(await states()).toEqual(['ended']);
    expect(proxied).toContain('storage:getActiveBuilderSessionForMember');
  }, 240_000);

  // INVARIANT: `lazy pair` and `lazy shell` in a bound clone launch nothing
  // on the laptop either. They go through Teams to the task's session on the
  // server, and the daemon's refusal — here, a task that has not run a turn,
  // so it has no environment to open yet — is what the person reads, in its
  // own words, before any socket. Options that choose a LOCAL launch are
  // refused by name before anything is asked.
  test('lazy pair and lazy shell go through Teams and show the server\'s refusal', async () => {
    const task = await rpc(alice, 'storage', { method: 'createTask', args: { goal: 'Pair on this' } }) as { id: string; code: string | null };
    await rpc(alice, 'storage', {
      method: 'createSession', args: { taskId: task.id, agentId: 'claude-code', gitBranch: `lazy/${task.id}`, gitStartSha: 'HEAD' },
    });
    const run = async (args: string[]) => {
      const proc = Bun.spawn(['bun', 'run', ENTRY, ...args], {
        cwd: clone, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        env: {
          ...process.env, HOME: home, LAZY_DAEMON_BASE_DIR: join(workDir, 'laptop-daemon'), LAZY_TEST: '', LAZY_IS_DAEMON: '',
          PATH: (process.env.PATH ?? '').split(':').filter((p) => p !== docker.binDir).join(':'),
        },
      });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      return { stderr, code };
    };
    const launchesBefore = (await docker.invocations()).length;

    for (const command of ['pair', 'shell']) {
      proxied.length = 0;
      const result = await run([command, task.id]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('has not run a turn yet');
      expect(proxied).toContain('attachSession');
    }
    // Nothing was run anywhere for these: no container, no exec.
    expect((await docker.invocations()).length).toBe(launchesBefore);
    expect(engine.execCreates).toEqual([]);

    proxied.length = 0;
    const local = await run(['shell', '--host', task.id]);
    expect(local.code).toBe(1);
    expect(local.stderr).toContain('--host');
    expect(proxied).toEqual([]);
  }, 240_000);

  // INVARIANT: the session the laptop attached to captures its conversation
  // into the PROJECT's store (design doc §5.6) — over the daemon's own
  // `/builder/storage` route with the token minted for that container, not
  // anywhere on the laptop — and the laptop reads it back through Teams.
  test("the session's conversation lands in the project's store and is readable from the clone", async () => {
    await runAttached(['builder'], 'plan-the-week', 'plan-the-week');
    const sessions = await rpc(alice, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[];
    const session = sessions.find((s) => s.state === 'running')!;

    // The daemon config the daemon mounted into THIS container's launch.
    const launch = (await docker.invocations()).find((l) => l.includes(' -d ') && l.includes(session.containerName!))!;
    const configPath = /--daemon-config (\S+)/.exec(launch)?.[1];
    expect(configPath).toBeTruthy();
    const mounted = JSON.parse(await readFile(configPath!, 'utf-8')) as { target: string };
    // Inside a container the daemon is `host.docker.internal`; out here it is
    // loopback. Same port, same token, same route.
    const reachable = join(workDir, 'daemon-config.json');
    await writeFile(reachable, JSON.stringify({ ...mounted, target: mounted.target.replace('host.docker.internal', '127.0.0.1') }));

    const capture = await daemonRemoteStorage(reachable);
    const sessionId = randomUUID();
    const conversation: StoredConversation = {
      sessionId, projectPath: '-workspace', cwd: '/workspace', version: '1.0.0', gitBranch: 'main',
      startedAt: '2026-09-22T10:00:00.000Z', endedAt: null, importedAt: Date.now(),
      summary: 'plan the week from a laptop',
      stats: { messageCount: 1, userMessageCount: 1, assistantMessageCount: 0, subagentCount: 0, totalTokens: 1 },
      totalUsage: { inputTokens: 1, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      messages: [{ uuid: randomUUID(), parentUuid: null, timestamp: '2026-09-22T10:00:00.000Z', role: 'user', text: 'plan the week from a laptop', model: null, usage: null }],
      subagents: [],
    } as StoredConversation;
    await capture.saveConversation(conversation);

    // Async on purpose: the stand-in Teams runs in THIS process, and a sync
    // spawn would hold the event loop it needs to answer.
    const listed = Bun.spawn(['bun', 'run', ENTRY, 'builder', 'list'], {
      cwd: clone,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: home, LAZY_DAEMON_BASE_DIR: join(workDir, 'laptop-daemon'), LAZY_TEST: '', LAZY_IS_DAEMON: '' },
    });
    const [out, err, code] = await Promise.all([new Response(listed.stdout).text(), new Response(listed.stderr).text(), listed.exited]);
    expect({ code, err }).toEqual({ code: 0, err: expect.any(String) });
    expect(out).toContain(sessionId.slice(0, 8));
    expect(proxied).toContain('storage:listConversationSummaries');
  }, 240_000);
});
