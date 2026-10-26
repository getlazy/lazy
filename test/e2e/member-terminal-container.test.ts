/**
 * E2E: a member's task terminal on a shared (managed) daemon runs in a
 * container of its OWN — never the task's — as that container's `shell` tmux
 * session; turns run beside it, and only what would remove her files waits.
 *
 * What is real: the daemon in managed mode, `resolveRpcActor` on a minted
 * per-member token, the `attachSession` RPC, the WebSocket upgrade, the member
 * entry under the lifecycle lock, the member container's `docker run` argv, the
 * member's credential minting, the `ExecStream` relay, the unblock path's
 * launch beside her, and the reject/close refusal and its confirmed form. What is fake: the container runtime — the CLI half is
 * `test/helpers/fake-docker.ts` (which records every argv), the Engine API half
 * is `startFakeEngine` with exec enabled (which records which container every
 * exec was created in, and with what environment).
 *
 * The task itself ran its turn on the host-process runner with the fake agent;
 * its session is then re-labelled `docker` and the daemon restarted managed on
 * the docker runner. That is the one fixture step that is not a lazy command:
 * a docker-runner turn cannot complete against a fake runtime.
 *
 * NOT PROVABLE HERE, and therefore unit-tested on the argv and needing a real
 * Docker (or smolvm guest) to see end to end: that the kernel really gives the
 * member container its own PID namespace (a `nohup` a turn left running is
 * invisible in it), and that `docker rm -f` really kills what the member left
 * running.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { join, dirname } from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';

import { getTaskSessionBinding, clearSessionCredentialCache, revokeTaskSessionBinding } from '../../src/daemon/session-credentials';
import { mintMcpToken } from '../../src/daemon/mcp-tokens';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { getWorktreePath, getWorktreePathForRef } from '../../src/task/identity';
import { runMcpSession } from '../helpers/mcp-session';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess, extractTaskId } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { storageDirFor, taskFilePath, readSessionJson, writeSessionJson, findFullTaskId, readTurns, readTaskStatus, readTaskJson, setTaskStatus } from '../helpers/storage';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { IMAGE_TAG, calculateImageInputManifest, calculateImageInputsHash } from '../../src/capture/claude';
import type { AttachSessionInfo } from '../../src/daemon/session-attach';
import { relayTeamsRpc } from '../helpers/teams-rpc-proxy-stub';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { writeTeamsLogin } from '../../src/teams/login';
import { runGit } from '../../src/utils/git';
import { seedAgentBinaryStamp, startFakeEngine, type FakeEngine } from '../helpers/fake-docker-engine';
import { shellSessionCommand } from '../../src/terminal/shell-session';
import { readDispatchedCommandId } from '../../src/protocol/io';
import { heartbeatRequestHeaders, readHeartbeatEnvelope } from '../../src/daemon/heartbeat';
import { FileStorage } from '../../src/storage/file-storage';
import { memberEndpointUsageKey } from '../../src/proxy/usage-limits';
import { MEMBER_PAIR_CREATION_KEY } from '../../src/task/created-by-own-agent';
import { readActiveWaits } from '../../src/protocol/waiting';
import { getLogPath } from '../../src/daemon/paths';

// INVARIANT: real daemon suites own their environment. A developer's managed
// mode, config, identity or mock settings must never change this fixture.
const ambientLazyEnv = new Map<string, string>();
let daemonBase: string;
beforeAll(async () => {
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('LAZY_') && value !== undefined) {
      ambientLazyEnv.set(key, value);
      delete process.env[key];
    }
  }
  daemonBase = await mkdtemp(join(tmpdir(), 'member-terminal-daemons-'));
  process.env.LAZY_DAEMON_BASE_DIR = daemonBase;
});
afterAll(async () => {
  await rm(daemonBase, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (key.startsWith('LAZY_')) delete process.env[key];
  for (const [key, value] of ambientLazyEnv) process.env[key] = value;
});

const ALICE_EMAIL = 'alice@example.com';

const TURN_SCOPED_CALLS: Array<{ tool: string; args: Record<string, unknown> }> = [
  { tool: 'lazy_final', args: { note: 'Member must not declare the agent final' } },
  { tool: 'lazy_report', args: { sections: [{ kind: 'commentary', body: 'Member must not replace the agent report' }], presentation: { groups: [] } } },
  { tool: 'lazy_update_progress', args: { message: 'Member must not overwrite agent progress' } },
  { tool: 'lazy_justify_protected', args: { file: 'README.md', reason: 'Member must not justify agent changes' } },
  { tool: 'lazy_justify_maintain', args: { group: 'docs', reason: 'Member must not justify agent omissions' } },
  { tool: 'lazy_commit', args: { message: 'Member must not commit the agent work' } },
  { tool: 'lazy_raise', args: { blocking: true, content: 'Member must not declare the agent needs input' } },
  { tool: 'lazy_raised_item_comment', args: { item_id: '12345678', content: 'Member must not write under the agent turn' } },
];

function openTerminal(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers } as never);
  ws.binaryType = 'arraybuffer';
  const output: string[] = [];
  const control: Array<{ type: string; [k: string]: unknown }> = [];
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`terminal did not open; control=${JSON.stringify(control)} output=${output.join('')}`)), 30_000);
    const check = () => {
      if (control.some((m) => m.type === 'ready') && output.join('').includes('exec:')) {
        clearTimeout(timer);
        resolve();
      }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') control.push(JSON.parse(ev.data));
      else output.push(new TextDecoder().decode(ev.data as ArrayBuffer));
      check();
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('terminal socket errored')); };
    ws.onclose = (ev) => { clearTimeout(timer); reject(new Error(`terminal socket closed early (${ev.code} ${ev.reason})`)); };
  });
  const closed = () => new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.onclose = () => resolve();
    ws.onerror = () => resolve();
    // Match the browser: an explicit close ends the session; a dropped socket can reconnect.
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end' }));
    ws.close();
  });
  return { ws, output, control, opened, closed };
}

/** Docker exec inherits the container's create-time environment, then overrides it. */
function memberEnv(run: string, execEnv: string[]): Record<string, string> {
  return Object.fromEntries([
    ...Array.from(run.matchAll(/-e ([A-Z_]+)=([^ ]*)/g), m => [m[1]!, m[2]!]),
    ...execEnv.map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]),
  ]);
}

describe('a member terminal on a shared daemon', () => {
  let ctx: TestContext;
  let workDir: string;
  let docker: FakeDocker;
  let engine: FakeEngine;
  let target: string;
  let sharedToken: string;
  let taskId: string;
  let fullTaskId: string;
  let sessionId: string;
  let taskContainer: string;

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  async function restartMemberDaemon(extra: Record<string, string> = {}) {
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      PATH: `${docker.binDir}:${process.env.PATH ?? ''}`, DOCKER_HOST: `unix://${engine.socketPath}`,
      ...extra,
    });
    target = getDaemonTcpTarget(ctx.root)!;
    sharedToken = readToken(ctx.root)!;
    if (!target || !sharedToken) throw new Error('test daemon did not record a TCP target and token');
  }

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lzmember-'));
    docker = await installFakeDocker(workDir);
    engine = startFakeEngine(join(workDir, 'engine.sock'), { allowExec: true });

    // A task that has run a turn and is waiting for a human.
    ctx = await setupTestLazy({ fakeClaude: true });
    taskId = await createTask(ctx, 'Member terminal', 'Do the work');
    await ctx.setClaudeScenario(successScenario({ sessionId: 'fake-sess-member' }));
    expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    fullTaskId = findFullTaskId(ctx.root, taskId);

    // Re-label the session and the project onto the docker runner (see header).
    const session = readSessionJson(ctx.root, taskId)!;
    session.runner_type = 'docker';
    session.container_name = session.container_name ?? `lazy-${taskId}`;
    writeSessionJson(ctx.root, taskId, session);
    sessionId = session.id;
    taskContainer = session.container_name;
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const patched = before.replace('type = "dangerously-host-process-without-any-isolation"', 'type = "docker"');
    if (patched === before) throw new Error('could not set [runner] type = "docker" in the generated lazy.toml');
    await writeFile(configPath, patched);

    // Seeded BEFORE the managed daemon starts: its launch warmup prepares the
    // image and agent binary at once, and unseeded it would compile a real one.
    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`, {
      dockerfileHash: await calculateImageInputsHash(ctx.root),
      inputs: await calculateImageInputManifest(ctx.root),
    });
    await seedAgentBinaryStamp(ctx.agentHome!);
    await restartMemberDaemon();

    await rpc(sharedToken, 'putUserCredential', { userId: ALICE_EMAIL, kind: 'oauth', token: 'sk-ant-oat01-alice-member' });
    await rpc(sharedToken, 'putUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'sk-ant-oat01-service-member' });
    // Between turns the task's own container stays up, with whatever a turn
    // left running in it.
    await docker.seedContainer(taskContainer, { state: 'running', project: ctx.root });
  }, 180_000);

  async function seedMemberUsage() {
    // Connect accounts FIRST: reconnecting deliberately clears their readings.
    // Then seed through Storage with the daemon stopped, and restart to read.
    expectSuccess(await ctx.lazy(['daemon', 'stop']));
    const storage = new FileStorage(ctx.root, { basePath: storageDirFor(ctx.root) });
    try {
      for (const email of [ALICE_EMAIL, 'bob@example.com', SERVICE_CREDENTIAL_USER_ID]) {
        await storage.saveUsageLimitReading({
          credential: memberEndpointUsageKey(email, 'builtin:anthropic'), ts: Date.now(),
          upstream: 'https://api.anthropic.com', backend: 'claude', status: 200,
          taskId: fullTaskId, model: null,
          headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.1' },
        });
      }
    } finally {
      await storage.close();
    }
    await restartMemberDaemon();
  }

  afterEach(async () => {
    await ctx.cleanup();
    engine.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  /** Create a real member home/binding, then represent its persisted Docker labels. */
  async function leftoverEnvironment(state: string) {
    const token = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;
    await docker.onExec('case "$*" in *list-sessions*) echo "1 1";; esac; exit 0');
    const info = await rpc(token, 'attachSession', { id: sessionId }) as AttachSessionInfo;
    const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=shell`, { Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root });
    await term.opened;
    const run = (await docker.invocations()).find(l => l.startsWith('run -d') && l.includes('--name lazymember-'))!;
    const name = /--name (\S+)/.exec(run)![1]!;
    const bindingKey = /--label lazy.member-binding=(\S+)/.exec(run)![1]!;
    // A dropped connection detaches; it does not ask to end the environment.
    term.ws.close();
    expectSuccess(await ctx.lazy(['daemon', 'stop']));
    await docker.seedContainer(name, { state, project: ctx.root, member: { taskId: fullTaskId, email: ALICE_EMAIL, bindingKey } });
    return { name, bindingKey, token };
  }

  // INVARIANT: a daemon restart preserves open-task member environments in
  // either runtime state, and re-pins their original credential before access.
  for (const state of ['running', 'exited']) {
    test(`${state} member environments survive restart and terminal reconnect`, async () => {
      const { name, bindingKey, token } = await leftoverEnvironment(state);
      await writeFile(join(docker.stateDir, 'container-ip'), '172.30.0.19');
      await restartMemberDaemon();
      expect(await docker.containers()).toContain(name);
      clearSessionCredentialCache();
      const binding = await getTaskSessionBinding(ctx.root, bindingKey);
      expect(binding?.revokedAt).toBeNull();
      expect(binding?.ownerUserId).toBe(ALICE_EMAIL);
      expect(binding?.origin).toBe('172.30.0.19');
      const calls = await docker.invocations();
      expect(calls.includes(`start ${name}`)).toBe(state === 'exited');
      expect(calls).not.toContain(`rm -f ${name}`);
      // The persisted recovery mark also survives another restart before access.
      await restartMemberDaemon();
      const info = await rpc(token, 'attachSession', { id: sessionId }) as AttachSessionInfo;
      const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=shell`, { Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root });
      await term.opened;
      expect(engine.execCreates.at(-1)).toBe(name);
      expect((await docker.invocations()).filter(l => l.startsWith('run -d') && l.includes('--name lazymember-'))).toHaveLength(1);
      await term.closed();
    }, 180_000);
  }

  // INVARIANT: refusing a reconnect is not the member exiting their shells.
  // An empty recovered environment stays protected through the vacate grace.
  test('a refused reconnect preserves a recovered environment without shells', async () => {
    const { name, token } = await leftoverEnvironment('exited');
    await docker.onExec('case "$*" in *list-sessions*) echo "0 0";; esac; exit 0');
    await restartMemberDaemon();
    // Plain credential revocation refuses a new terminal without ending an
    // existing environment; departure uses endEnvironments explicitly.
    await rpc(sharedToken, 'revokeUserCredential', { userId: ALICE_EMAIL });
    const info = await rpc(token, 'attachSession', { id: sessionId }) as AttachSessionInfo;
    const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=shell`, { Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root });
    await expect(term.opened).rejects.toThrow();
    await term.closed();
    await Bun.sleep(31_000);
    expect(await docker.containers()).toContain(name);
    expect(await docker.invocations()).not.toContain(`rm -f ${name}`);
  }, 180_000);

  // INVARIANT: a failed inventory cannot revoke a retained environment's
  // credentials, or create its replacement before recovery can validate it.
  test('temporary startup inventory failure preserves the environment and its credential', async () => {
    const { name, bindingKey, token } = await leftoverEnvironment('exited');
    await writeFile(join(docker.stateDir, 'fail-member-ps'), '1');
    await restartMemberDaemon();
    clearSessionCredentialCache();
    expect((await getTaskSessionBinding(ctx.root, bindingKey))?.revokedAt).toBeNull();
    expect(await docker.invocations()).not.toContain(`rm -f ${name}`);
    const info = await rpc(token, 'attachSession', { id: sessionId }) as AttachSessionInfo;
    const refused = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=shell`, { Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root });
    await expect(refused.opened).rejects.toThrow();
    await refused.closed();
    await writeFile(join(docker.stateDir, 'container-ip'), '172.30.0.23');
    await rm(join(docker.stateDir, 'fail-member-ps'));
    const recovered = async () => {
      clearSessionCredentialCache();
      return (await getTaskSessionBinding(ctx.root, bindingKey))?.origin === '172.30.0.23';
    };
    for (let i = 0; i < 300 && !(await recovered()); i++) await Bun.sleep(100);
    expect(await recovered()).toBe(true);
    const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=shell`, { Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root });
    await term.opened;
    expect(engine.execCreates.at(-1)).toBe(name);
    expect(await docker.invocations()).not.toContain(`rm -f ${name}`);
    expect((await docker.invocations()).filter(l => l.startsWith('run -d') && l.includes('--name lazymember-'))).toHaveLength(1);
    await term.closed();
  }, 180_000);

  // INVARIANT: a temporary runtime failure cannot destroy a stopped member
  // environment; reconnect retries recovery with the original credential.
  test('failed startup restart keeps the environment for terminal retry', async () => {
    const { name, bindingKey, token } = await leftoverEnvironment('exited');
    await writeFile(join(docker.stateDir, 'fail-start'), '1');
    await restartMemberDaemon();
    expect(await docker.containers()).toContain(name);
    expect(await docker.invocations()).not.toContain(`rm -f ${name}`);
    clearSessionCredentialCache();
    expect((await getTaskSessionBinding(ctx.root, bindingKey))?.revokedAt).toBeNull();
    await rm(join(docker.stateDir, 'fail-start'));
    await writeFile(join(docker.stateDir, 'container-ip'), '172.30.0.21');
    const info = await rpc(token, 'attachSession', { id: sessionId }) as AttachSessionInfo;
    const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=shell`, { Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root });
    await term.opened;
    expect(engine.execCreates.at(-1)).toBe(name);
    clearSessionCredentialCache();
    expect((await getTaskSessionBinding(ctx.root, bindingKey))?.origin).toBe('172.30.0.21');
    expect((await docker.invocations()).filter(l => l.startsWith('run -d') && l.includes('--name lazymember-'))).toHaveLength(1);
    await term.closed();
  }, 180_000);

  // INVARIANT: inspection failure is not proof an environment is invalid.
  // Recovery retains its original binding, revalidates it, and pins the live
  // address before terminal access; a connection revoked meanwhile is refused.
  for (const state of ['running', 'exited']) {
    for (const failure of ['address', 'env']) {
      test(`${state} member environment recovers after temporary ${failure} inspection failure`, async () => {
        const { name, bindingKey, token } = await leftoverEnvironment(state);
        const flag = join(docker.stateDir, `fail-member-${failure}`);
        await writeFile(flag, '1');
        await restartMemberDaemon();
        clearSessionCredentialCache();
        expect((await getTaskSessionBinding(ctx.root, bindingKey))?.revokedAt).toBeNull();
        expect(await docker.invocations()).not.toContain(`rm -f ${name}`);
        const info = await rpc(token, 'attachSession', { id: sessionId }) as AttachSessionInfo;
        const refused = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=shell`, { Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root });
        await expect(refused.opened).rejects.toThrow();
        await refused.closed();
        await writeFile(join(docker.stateDir, 'container-ip'), '172.30.0.25');
        await rm(flag);
        const recovered = async () => {
          clearSessionCredentialCache();
          return (await getTaskSessionBinding(ctx.root, bindingKey))?.origin === '172.30.0.25';
        };
        for (let i = 0; i < 300 && !(await recovered()); i++) await Bun.sleep(100);
        expect(await recovered()).toBe(true);
        const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=shell`, { Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root });
        await term.opened;
        expect(engine.execCreates.at(-1)).toBe(name);
        expect(await docker.invocations()).not.toContain(`rm -f ${name}`);
        await term.closed();
      }, 180_000);
    }
  }

  test('a member credential revoked while recovery is pending is never reused', async () => {
    const { name, bindingKey } = await leftoverEnvironment('exited');
    const flag = join(docker.stateDir, 'fail-member-address');
    await writeFile(flag, '1');
    await restartMemberDaemon();
    await rpc(sharedToken, 'revokeUserCredential', { userId: ALICE_EMAIL });
    await rm(flag);
    for (let i = 0; i < 300 && (await docker.containers()).includes(name); i++) await Bun.sleep(100);
    expect(await docker.containers()).not.toContain(name);
    clearSessionCredentialCache();
    expect((await getTaskSessionBinding(ctx.root, bindingKey))?.revokedAt).not.toBeNull();
  }, 180_000);

  for (const ending of ['complete', 'abandoned', 'deleted', 'revoked', 'wrong-owner', 'departed']) {
    test(`restart removes a stopped member environment whose task or credential is ${ending}`, async () => {
      const { name, bindingKey } = await leftoverEnvironment('exited');
      if (ending === 'complete' || ending === 'abandoned') setTaskStatus(ctx.root, taskId, ending);
      const storage = new FileStorage(ctx.root, { basePath: storageDirFor(ctx.root) });
      try {
        if (ending === 'deleted') await rm(dirname(taskFilePath(ctx.root, taskId, 'task.json')), { recursive: true });
        if (ending === 'revoked') {
          clearSessionCredentialCache();
          await revokeTaskSessionBinding(ctx.root, bindingKey);
        }
        if (ending === 'wrong-owner') {
          const { bindTurnCredential } = await import('../../src/daemon/session-credentials');
          clearSessionCredentialCache();
          await bindTurnCredential(ctx.root, { taskId: bindingKey, sessionId, ownerUserId: 'bob@example.com', kind: 'oauth' });
        }
        if (ending === 'departed') {
          const { revokeUserCredential, clearUserCredentialCache } = await import('../../src/daemon/user-credentials');
          clearUserCredentialCache();
          await revokeUserCredential(ctx.root, ALICE_EMAIL);
        }
      } finally { await storage.close(); }
      await restartMemberDaemon();
      expect(await docker.containers()).not.toContain(name);
      expect(await docker.invocations()).toContain(`rm -f ${name}`);
      expect(await docker.invocations()).not.toContain(`start ${name}`);
      clearSessionCredentialCache();
      expect((await getTaskSessionBinding(ctx.root, bindingKey))?.revokedAt).toBeNumber();
    }, 180_000);
  }

  for (const { profile, accountEndpoint, inheritedLevel } of [
    { profile: 'pinned' },
    { profile: 'chain' },
    { profile: 'chain', accountEndpoint: 'first', inheritedLevel: 'team' },
    { profile: 'chain', accountEndpoint: 'later', inheritedLevel: 'project' },
  ]) {
    // INVARIANT: Teams Pair and Chat run any Claude Code profile through the
    // proxy on the attaching member's connections, with per-request failover.
    test(`Pair and Chat route the task's ${profile} profile on the member's connections${inheritedLevel ? ` (${accountEndpoint} at account level, other tier inherited from ${inheritedLevel})` : ''}`, async () => {
      const keyFor = (endpoint: string) => inheritedLevel && endpoint !== accountEndpoint
        ? `alice-${inheritedLevel}-${endpoint}-key` : `alice-${endpoint}-key`;
      const seen: Array<{ endpoint: string; key: string | null; model: string }> = [];
      let refuseFirst = false;
      const stub = (endpoint: string) => Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
        if (req.method !== 'POST') return new Response('ok');
        const body = await req.json() as { model: string };
        seen.push({ endpoint, key: req.headers.get('x-api-key'), model: body.model });
        if (endpoint === 'first' && refuseFirst) return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'full' } }, { status: 429, headers: { 'retry-after': '60' } });
        return Response.json({ type: 'message', model: body.model, content: [] });
      } });
      const first = stub('first');
      const later = stub('later');
      try {
        const firstUrl = `http://127.0.0.1:${first.port}`;
        const laterUrl = `http://127.0.0.1:${later.port}`;
        const toml = (await readFile(join(ctx.root, 'lazy.toml'), 'utf8')) + `
[endpoints.first]
url = "${firstUrl}"
credential = "first-key"
[endpoints.later]
url = "${laterUrl}"
credential = "later-key"
[agents.pinned]
harness = "claude-code"
model = "pinned-model"
named_endpoint = "later"
[agents.chain]
harness = "claude-code"
tiers = [{ endpoint = "first", model = "first-model" }, { endpoint = "later", model = "later-model" }]
`;
        await restartMemberDaemon({ LAZY_MANAGED_CONFIG_PATH: join(workDir, 'control-plane.toml') });
        expect(await rpc(sharedToken, 'applyProjectConfig', { toml, origin: 'control-plane' })).toMatchObject({ applied: true });
        const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;
        await rpc(alice, 'editTask', { taskId: fullTaskId, agent: profile });
        await rpc(sharedToken, 'revokeUserCredential', { userId: ALICE_EMAIL });
        await rpc(sharedToken, 'putEndpointCredential', { userId: 'bob@example.com', endpointId: 'later', origin: laterUrl, kind: 'api-key', token: 'bob-later-key' });
        const refused = await rpc(alice, 'attachSession', { id: sessionId }) as AttachSessionInfo;
        expect(refused.credentialMissing).toBe(true);
        expect(refused.refusals?.pair).toContain(profile === 'pinned' ? 'endpoint "later"' : 'endpoint "first"');
        expect(refused.refusals?.chat).toContain('Connections (account, team, or project)');
        expect((await docker.invocations()).filter(l => l.startsWith('run -d') && l.includes('--name lazymember-'))).toHaveLength(0);
        // Rails resolves the member's account/team/project hierarchy before
        // delivery (covered by MemberPairInheritedConnectionsTest). This
        // daemon receives those selected connections under the same member.
        const endpoints = accountEndpoint === 'later' ? [['later', laterUrl], ['first', firstUrl]] : [['first', firstUrl], ['later', laterUrl]];
        for (const [index, [endpoint, origin]] of endpoints.entries()) {
          await rpc(sharedToken, 'putEndpointCredential', { userId: ALICE_EMAIL, endpointId: endpoint, origin, kind: 'api-key', token: keyFor(endpoint!) });
          if (inheritedLevel && index === 0) {
            const missing = endpoint === 'first' ? 'later' : 'first';
            const partial = await rpc(alice, 'attachSession', { id: sessionId }) as AttachSessionInfo;
            expect(partial.refusals?.pair).toContain(`endpoint "${missing}"`);
            expect(partial.refusals?.chat).toContain('Connections (account, team, or project)');
          }
        }
        // The simulated member process sends from its runtime-reported address.
        await writeFile(join(docker.stateDir, 'container-ip'), '127.0.0.1');
        const info = await rpc(alice, 'attachSession', { id: sessionId }) as AttachSessionInfo;
        expect(info.refusals?.pair).toBeUndefined();
        expect(info.refusals?.chat).toBeUndefined();
        for (const mode of ['pair', 'chat']) {
          const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=${mode}`, { Authorization: `Bearer ${alice}`, 'X-Lazy-Project': ctx.root });
          try {
            await term.opened;
            expect(engine.execCmds.at(-1)).toContain('--member-mcp-config');
            const run = (await docker.invocations()).find(l => l.startsWith('run -d') && l.includes('--name lazymember-'))!;
            expect(run).not.toContain('alice-first-key');
            expect(run).not.toContain('alice-later-key');
            const env = memberEnv(run, engine.execEnvs.at(-1)!);
            const token = env.ANTHROPIC_AUTH_TOKEN;
            const proxyUrl = env.ANTHROPIC_BASE_URL.replace('host.docker.internal', '127.0.0.1');
            const cmd = engine.execCmds.at(-1)!;
            const model = cmd[cmd.indexOf('--model') + 1];
            const send = () => fetch(`${proxyUrl}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Hello' }] }) });
            const response = await send();
            expect(response.status, await response.text()).toBe(200);
            if (profile === 'chain' && mode === 'pair') {
              refuseFirst = true;
              const fallback = await send();
              expect(fallback.status, await fallback.text()).toBe(200);
            }
          } finally { await term.closed(); }
        }
        expect(seen.length).toBeGreaterThan(0);
        for (const call of seen) {
          expect(call.key).toBe(keyFor(call.endpoint));
          expect(call.model).toBe(profile === 'pinned' ? 'pinned-model' : `${call.endpoint}-model`);
        }
        if (profile === 'chain') expect(new Set(seen.map(c => c.endpoint))).toEqual(new Set(['first', 'later']));
        if (profile === 'pinned') {
          // The environment survives a profile edit. A new conversation must
          // use the new chain, not the container's original pinned endpoint.
          await rpc(alice, 'editTask', { taskId: fullTaskId, agent: 'chain' });
          const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=chat`, { Authorization: `Bearer ${alice}`, 'X-Lazy-Project': ctx.root });
          try {
            await term.opened;
            const run = (await docker.invocations()).find(l => l.startsWith('run -d') && l.includes('--name lazymember-'))!;
            const env = memberEnv(run, engine.execEnvs.at(-1)!);
            const cmd = engine.execCmds.at(-1)!;
            const model = cmd[cmd.indexOf('--model') + 1];
            expect(model).toBe('first-model');
            const response = await fetch(`${env.ANTHROPIC_BASE_URL.replace('host.docker.internal', '127.0.0.1')}/v1/messages`, {
              method: 'POST', headers: { authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`, 'content-type': 'application/json' },
              body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Hello' }] }),
            });
            expect(response.status, await response.text()).toBe(200);
            expect(seen.at(-1)).toEqual({ endpoint: 'first', key: 'alice-first-key', model: 'first-model' });
            expect((await docker.invocations()).filter(l => l.startsWith('run -d') && l.includes('--name lazymember-'))).toHaveLength(1);
          } finally { await term.closed(); }
        }
      } finally { first.stop(true); later.stop(true); }
    }, 180_000);
  }

  // INVARIANT (engineer, 2026-10-24: "I cannot now pair with Codex"): a
  // member's Pair on a Codex task runs Codex in the member's OWN container,
  // resuming the agent's thread from the rollout the home carried in, on the
  // member's own OpenAI connection — a placeholder bound to the member, the
  // proxy's Codex endpoint, never the key itself. Chat on Codex is refused with
  // why (its read-only mode cannot run in a container), before any socket.
  test("a member's Pair on a Codex task resumes its thread on the member's own connection", async () => {
    const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;
    await rpc(alice, 'editTask', { taskId: fullTaskId, agent: 'codex' });
    await rpc(sharedToken, 'putEndpointCredential', {
      userId: ALICE_EMAIL, endpointId: 'builtin:openai', origin: 'https://api.openai.com', kind: 'api-key', token: 'alice-openai-key',
    });
    const worktree = getWorktreePath(ctx.root, readTaskJson(ctx.root, taskId) as never);
    const rolloutDir = join(worktree, '.lazy-task-sandbox', '.codex', 'sessions', '2026', '10', '24');
    await (await import('fs/promises')).mkdir(rolloutDir, { recursive: true });
    await writeFile(join(rolloutDir, 'rollout-2026-10-24T05-48-26-fake-sess-member.jsonl'), '{"type":"session_meta"}\n');
    const codexSession = readSessionJson(ctx.root, taskId)!;
    codexSession.agent_session_id = 'fake-sess-member';
    writeSessionJson(ctx.root, taskId, codexSession);

    const info = await rpc(alice, 'attachSession', { id: sessionId }) as AttachSessionInfo;
    expect(info.refusals?.pair).toBeUndefined();
    expect(info.refusals?.chat).toContain('Chat is not available for Codex');

    const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=pair`, { Authorization: `Bearer ${alice}`, 'X-Lazy-Project': ctx.root });
    try {
      await term.opened;
      const cmd = engine.execCmds.at(-1)!;
      expect(cmd[cmd.indexOf('--agent') + 1]).toBe('codex');
      expect(cmd).toContain('--member-session');
      expect(cmd[cmd.indexOf('--resume') + 1]).toBe('fake-sess-member');
      const run = (await docker.invocations()).find(l => l.startsWith('run -d') && l.includes('--name lazymember-'))!;
      expect(run).toContain(':/home/user/.codex');
      expect(run).not.toContain('alice-openai-key');
      const env = memberEnv(run, engine.execEnvs.at(-1)!);
      expect(env.OPENAI_API_KEY).toBeTruthy();
      expect(env.OPENAI_API_KEY).not.toBe('alice-openai-key');
      expect(env.LAZY_CODEX_API_BASE).toMatch(/^http:\/\/host\.docker\.internal:\d+\/v1$/);
      for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) expect(env[key] ?? '').toBe('');
    } finally { await term.closed(); }
  }, 180_000);

  // INVARIANT: every new Pair/Chat exec uses the current connection's auth
  // form, even in a container created on a different profile and credential.
  test('Pair and Chat refresh gateway API-key containers onto Anthropic OAuth', async () => {
    const toml = (await readFile(join(ctx.root, 'lazy.toml'), 'utf8')) + `
[endpoints.gateway]
url = "https://gateway.example.com"
credential = "gateway-key"
[agents.gateway]
harness = "claude-code"
model = "gateway-model"
named_endpoint = "gateway"
`;
    await restartMemberDaemon({ LAZY_MANAGED_CONFIG_PATH: join(workDir, 'control-plane.toml') });
    expect(await rpc(sharedToken, 'applyProjectConfig', { toml, origin: 'control-plane' })).toMatchObject({ applied: true });
    const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;
    await rpc(sharedToken, 'putEndpointCredential', { userId: ALICE_EMAIL, endpointId: 'gateway', origin: 'https://gateway.example.com', kind: 'api-key', token: 'alice-gateway-key' });
    await rpc(sharedToken, 'putUserCredential', { userId: ALICE_EMAIL, kind: 'oauth', token: 'alice-oauth-secret' });
    await rpc(alice, 'editTask', { taskId: fullTaskId, agent: 'gateway' });
    await writeFile(join(docker.stateDir, 'container-ip'), '127.0.0.1');
    const info = await rpc(alice, 'attachSession', { id: sessionId }) as AttachSessionInfo;
    for (const profile of ['gateway', 'claude-code', 'gateway']) {
      await rpc(alice, 'editTask', { taskId: fullTaskId, agent: profile });
      for (const mode of ['pair', 'chat']) {
        const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=${mode}`, { Authorization: `Bearer ${alice}`, 'X-Lazy-Project': ctx.root });
        try {
          await term.opened;
          const runs = (await docker.invocations()).filter(l => l.startsWith('run -d') && l.includes('--name lazymember-'));
          expect(runs).toHaveLength(1);
          const env = memberEnv(runs[0]!, engine.execEnvs.at(-1)!);
          expect(env.ANTHROPIC_API_KEY).toBe('');
          expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe(profile === 'claude-code' ? '1' : '');
          for (const key of ['DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']) {
            expect(env[key]).toBe(profile === 'gateway' ? '1' : '');
          }
          if (profile === 'gateway') {
            expect(env.ANTHROPIC_AUTH_TOKEN.length).toBeGreaterThan(0);
            expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
          } else {
            expect(env.CLAUDE_CODE_OAUTH_TOKEN).toMatch(/^lazy-sess-/);
            expect(env.ANTHROPIC_AUTH_TOKEN).toBe('');
          }
          expect(JSON.stringify(env)).not.toContain('alice-oauth-secret');
          expect(JSON.stringify(env)).not.toContain('alice-gateway-key');
        } finally { await term.closed(); }
      }
    }
  }, 180_000);

  // INVARIANT: a member Pair conversation question is admitted and executed
  // on that member's account, even when the project has no service credential.
  test('Pair asks a stored conversation without a service credential', async () => {
    await rpc(sharedToken, 'revokeUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID });
    const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;
    const conversationId = '12121212-0000-0000-0000-000000000001';
    await rpc(alice, 'storage', {
      method: 'saveConversation',
      args: { conversation: {
        sessionId: conversationId, projectPath: ctx.root, summary: 'Retry policy',
        messages: [{ role: 'user', text: 'How many retries?' }, { role: 'assistant', text: 'Three retries.' }],
        stats: { messageCount: 2, userMessageCount: 1, assistantMessageCount: 1 },
      } },
    });
    await docker.setOneshotResponse('Three retries.');
    await docker.onExec(`case "$*" in *list-sessions*) echo "1 $(date +%s)";; esac; exit 0`);
    const info = await rpc(alice, 'attachSession', { id: sessionId }) as AttachSessionInfo;
    const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=pair`, {
      Authorization: `Bearer ${alice}`, 'X-Lazy-Project': ctx.root,
    });
    try {
      await term.opened;
      const cmd = engine.execCmds.at(-1)!;
      const configPath = cmd[cmd.indexOf('--member-mcp-config') + 1]!;
      const memberName = engine.execCreates.at(-1)!;
      const run = (await docker.invocations()).find(l => l.startsWith('run -d') && l.includes(`--name ${memberName} `))!;
      const mount = /-v (\S+):\/run\/lazy-member-mcp:ro/.exec(run)![1]!;
      const config = JSON.parse(await readFile(join(mount, configPath.split('/').at(-1)!), 'utf-8'));
      const response = await fetch(`${target}/mcp/${fullTaskId}/lazy_conversation_ask`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'X-Lazy-Project': ctx.root, 'Content-Type': 'application/json', ...heartbeatRequestHeaders() },
        body: JSON.stringify({ arguments: { session_id: conversationId, question: 'What did we decide?' } }),
      });
      const envelope = await readHeartbeatEnvelope(response, 'lazy_conversation_ask');
      expect(envelope.status, JSON.stringify(envelope.body)).toBe(200);
      expect(JSON.stringify(envelope.body)).toContain('Three retries.');
      const oneshots = (await docker.invocations()).filter(l => l.startsWith('run ') && l.includes('lazy.oneshot=1'));
      expect(oneshots.length).toBeGreaterThan(0);
      expect(oneshots[0]).toMatch(/-e CLAUDE_CODE_OAUTH_TOKEN=lazy-sess-\S+/);
    } finally {
      await term.closed();
    }
  }, 180_000);

  // INVARIANT: a member's terminal runs in a FRESH container of their own,
  // built from the task's image on the task's worktree, carrying their
  // credential and nothing of a turn's (no MCP config, no protocol dir) — and
  // the exec lands there, never in the task's container, as its `shell` tmux
  // session. A turn may start while it is open (engineer, 2026-10-21); a
  // reject or close waits for her, or ends her sessions when confirmed.
  test("runs in the member's own container, and never keeps turns off the task", async () => {
    const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;

    // Discovery needs nothing running: the member's container is made on open.
    const info = await rpc(alice, 'attachSession', { id: sessionId }) as AttachSessionInfo;
    expect(info.kind).toBe('task');
    expect(info.refusals?.shell).toBeUndefined();

    const headers = { Authorization: `Bearer ${alice}`, 'X-Lazy-Project': ctx.root };
    const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=shell`, headers);
    await term.opened;

    const runs = (await docker.invocations()).filter((l) => l.startsWith('run -d') && l.includes('lazymember-'));
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    const memberName = /--name (lazymember-\S+)/.exec(run)![1]!;
    expect(run).toContain(`--label lazy.member-terminal=${fullTaskId}`);
    expect(run).toMatch(/-e CLAUDE_CODE_OAUTH_TOKEN=lazy-sess-\S+/);
    expect(run).not.toContain('LAZY_DAEMON_CONFIG');
    expect(run).not.toContain('protocol');
    // The turn-writable sandbox home is never mounted: the home is lazy-built.
    expect(run).not.toContain('.lazy-task-sandbox');
    expect(run).toMatch(new RegExp(`member-homes/[^ ]*/${memberName}/.claude:/home/user/.claude`));
    expect(run).not.toMatch(/--(pid|ipc|volumes-from)/);
    // A network of its own, never the task containers' default bridge.
    expect(run).toContain('--network lazy-members');
    expect(await docker.invocations()).toContain('network create --driver bridge --opt com.docker.network.bridge.name=lzmember0 --opt com.docker.network.bridge.enable_icc=false --label lazy.member-network=1 lazy-members');
    expect(run).not.toContain(taskContainer);
    // Her git reads daemon-written copies of the pointer files, never the
    // worktree's own .git, which a process beside the worktree could rewrite.
    expect(run).toMatch(new RegExp(`member-homes/\\S*/git-pointers/dotgit-[a-f0-9]{64}:\\S*/\\.git:ro`));
    const pointerMounts = [...run.matchAll(/-v (\S+):(\S+\/(?:worktrees\/[^/\s]+\/\.git|commondir|gitdir)):ro/g)];
    expect(pointerMounts.map((m) => m[2]!.split('/').pop())).toEqual(['.git', 'commondir', 'gitdir']);
    for (const m of pointerMounts) expect(m[1]).toContain('/git-pointers/');

    // INVARIANT: a member's entry leaves the task's own container RUNNING
    // (engineer's decision on raised item f1219a6f, 2026-10-05, replacing "the
    // entry stops it"). It holds the task's SHARED services, which keep running
    // while members work; everything in it is suspect and contained, and her
    // git reads the checked, read-only pointer copies asserted above. Bringing
    // it up without a turn is not refused on her account either.
    const invocations = await docker.invocations();
    expect(invocations.filter((l) => l.includes(taskContainer) && /^(kill|stop|rm)\b/.test(l))).toEqual([]);
    const running = await Bun.spawn([docker.binPath, 'ps', '--filter', `name=^/${taskContainer}$`, '--format', '{{.ID}}'], { stdout: 'pipe' });
    expect((await new Response(running.stdout).text()).trim()).not.toBe('');
    // Control-plane plumbing, so asked on the control token as Teams does.
    const broughtUp = await rpc(sharedToken, 'ensureTaskContainer', { taskId: fullTaskId }) as { alreadyRunning: boolean; containerName: string };
    expect(broughtUp.alreadyRunning).toBe(true);
    expect(broughtUp.containerName).toBe(taskContainer);

    // The exec went into Alice's container, carrying no credential of its own.
    expect(engine.execCreates).toEqual([memberName]);
    expect(term.output.join('')).toContain(`exec:${memberName}`);
    expect(engine.execEnvs[0]!.filter((e) => /TOKEN|KEY/.test(e))).toEqual([]);

    // Her shell is the container's `shell` tmux session, so a reconnect lands
    // back in it.
    // Its notice (who else is in the task) rides as an argument after the script.
    const notice = engine.execCmds[0]![4] ?? null;
    expect(engine.execCmds[0]).toEqual(shellSessionCommand('shell', notice));
    expect(notice).toContain('agent:');

    // What would REMOVE her files waits for her: a reject and a close are
    // refused, naming her and the way to confirm, and change nothing.
    const turnsBefore = readTurns(ctx.root, taskId).length;
    const statusBefore = readTaskStatus(ctx.root, taskId);
    for (const [command, params] of [
      ['rejectTask', { reason: 'not this way' }],
      ['closeTask', { reason: 'not needed' }],
    ] as const) {
      let err: unknown = null;
      try {
        await rpc(alice, command, { taskId: fullTaskId, ...params });
      } catch (e) { err = e; }
      expect(err instanceof RpcApplicationError ? `${command}: ${err.status} ${err.message}` : `${command}: ${String(err)}`)
        .toContain(`${command}: 409`);
      expect((err as Error).message).toContain(ALICE_EMAIL);
      expect((err as Error).message).toContain('--end-sessions');
    }
    expect(readTurns(ctx.root, taskId).length).toBe(turnsBefore);
    expect(readTaskStatus(ctx.root, taskId)).toBe(statusBefore);

    // A turn is NOT held off while she is in: the unblock is accepted and its
    // feedback turn recorded, with her terminal still open.
    let launchErr: unknown = null;
    try {
      await rpc(alice, 'unblockTask', { taskId: fullTaskId, message: 'carry on' });
    } catch (err) { launchErr = err; }
    if (launchErr) expect((launchErr as Error).message).not.toContain(ALICE_EMAIL);
    expect(readTurns(ctx.root, taskId).length).toBeGreaterThan(turnsBefore);
    expect(engine.execCreates).toEqual([memberName]);

    // INVARIANT: an idle environment survives with no client, even when its
    // last activity predates the former twelve-hour cutoff.
    // Past the 30-second disconnect grace, the same container is still there.
    await docker.onExec(`case "$*" in *list-sessions*) echo "0 1 shell";; esac; exit 0`);
    await term.closed();
    await Bun.sleep(33_000);
    expect(await docker.invocations()).not.toContain(`rm -f ${memberName}`);
    const reconnected = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=shell`, headers);
    await reconnected.opened;
    expect(engine.execCreates.at(-1)).toBe(memberName);
    await reconnected.closed();
  }, 180_000);

  // INVARIANT: pairing authenticates as its MEMBER, independently of the task's
  // turn owner. Its credential cannot claim another task, survive its socket,
  // or survive the member leaving. Several members may pair at once.
  test('paired members have working, attributed tools with independent revocation', async () => {
    const bobEmail = 'bob@example.com';
    await rpc(sharedToken, 'putUserCredential', { userId: bobEmail, kind: 'oauth', token: 'sk-ant-oat01-bob-member' });
    await seedMemberUsage();
    await docker.onExec(`case "$*" in *list-sessions*) echo "1 $(date +%s)";; esac; exit 0`);
    const members = [];
    for (const [email, name] of [[ALICE_EMAIL, 'Alice'], [bobEmail, 'Bob']]) {
      const actor = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email, name }) as { token: string }).token;
      const info = await rpc(actor, 'attachSession', { id: sessionId }) as AttachSessionInfo;
      expect(info.refusals?.pair).toBeUndefined();
      const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=pair`, {
        Authorization: `Bearer ${actor}`, 'X-Lazy-Project': ctx.root,
      });
      await term.opened;
      const cmd = engine.execCmds.at(-1)!;
      expect(cmd).toContain('--member-session');
      const configPath = cmd[cmd.indexOf('--member-mcp-config') + 1]!;
      const memberName = engine.execCreates.at(-1)!;
      const run = (await docker.invocations()).find((l) => l.startsWith('run -d') && l.includes(`--name ${memberName} `))!;
      const mount = /-v (\S+):\/run\/lazy-member-mcp:ro/.exec(run)![1]!;
      const config = JSON.parse(await readFile(join(mount, configPath.split('/').at(-1)!), 'utf-8'));
      expect(config.taskId).toBe(fullTaskId);
      // The fake runtime does not supply container DNS: this subprocess uses
      // the same credential with the test daemon's loopback address instead.
      const proxyConfig = join(workDir, `${memberName}-mcp.json`);
      await writeFile(proxyConfig, JSON.stringify({ ...config, target }));
      members.push({ term, config, email, name, actor, proxyConfig, memberName });
    }
    expect(members[0]!.config.token).not.toBe(members[1]!.config.token);
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
    const call = async (token: string, tool: string, args: Record<string, unknown>, claim = fullTaskId, project = ctx.root) => {
      const response = await fetch(`${target}/mcp/${claim}/${tool}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lazy-Project': project, 'Content-Type': 'application/json' },
        body: JSON.stringify({ arguments: args }),
      });
      return { status: response.status, body: await response.text() };
    };
    for (const member of members) {
      // INVARIANT: two members pairing on the SAME task each see their own
      // credential, never the task's spender, another member, or the service.
      const limits = await call(member.config.token, 'lazy_usage_limits', {});
      expect(limits.status, limits.body).toBe(200);
      const view = JSON.parse(limits.body).result;
      expect(view.scope).toBe('member');
      expect(view.readings.map((r: { credential: string }) => r.credential))
        .toEqual([memberEndpointUsageKey(member.email, 'builtin:anthropic')]);
      expect(limits.body).not.toContain(member.email === ALICE_EMAIL ? bobEmail : ALICE_EMAIL);
      expect(limits.body).not.toContain(SERVICE_CREDENTIAL_USER_ID);
      // Member attachments belong to the task, not its agent's session.
      const attached = await call(member.config.token, 'lazy_artifact_add', { name: `${member.name}.txt`, content: 'Member reference' });
      expect(attached.status, attached.body).toBe(200);
      expect(JSON.parse(attached.body).result.origin).toBe('input');
      const artifacts = await rpc(sharedToken, 'storage', { method: 'listTaskArtifacts', args: { taskId: fullTaskId } }) as Array<{ name: string; session_id?: string }>;
      const artifact = artifacts.find(a => a.name === `${member.name}.txt`);
      expect(artifact).toBeDefined();
      expect(artifact!.session_id).toBeUndefined();
      const replies = await runMcpSession(ctx.root, fullTaskId, getWorktreePath(ctx.root, readTaskJson(ctx.root, taskId) as any), [
        { method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'paired-member', version: '1' } } },
        { method: 'tools/list', id: 2 },
        { method: 'tools/call', id: 3, params: { name: 'lazy_show', arguments: { task_id: fullTaskId } } },
        { method: 'tools/call', id: 4, params: { name: 'lazy_comment', arguments: { task_id: fullTaskId, message: `From ${member.name}` } } },
      ], { daemonConfigPath: member.proxyConfig });
      for (const id of [3, 4]) {
        const reply = replies.find((r) => r.id === id)!;
        expect(reply.error).toBeUndefined();
        expect(reply.result?.isError, JSON.stringify(reply)).not.toBe(true);
        expect(reply.result?.content).toBeDefined();
      }
      const tools = replies.find((r) => r.id === 2)!.result!.tools as Array<{ name: string }>;
      expect(tools.map((t) => t.name)).toContain('lazy_create');
      expect(tools.map((t) => t.name)).not.toContain('lazy_memory_save');
      for (const { tool, args } of TURN_SCOPED_CALLS) {
        expect(tools.map((t) => t.name)).not.toContain(tool);
        // Bypass discovery: the daemon must refuse a stale or handwritten call.
        const refused = await call(member.config.token, tool, args);
        expect(refused.status, refused.body).toBe(403);
      }
    }
    const shown = await rpc(sharedToken, 'show', { taskId: fullTaskId, sections: ['comments'] }) as any;
    // The comments are store rows, not an identity merely echoed by the client.
    const comments = shown.comments ?? shown.task?.comments;
    for (const member of members) {
      expect(comments.find((c: any) => c.content === `From ${member.name}` || c.message === `From ${member.name}`))
        .toMatchObject({ actor_email: member.email, actor_name: member.name });
    }
    for (const member of members) {
      const created = await call(member.config.token, 'lazy_create', { goal: `Child for ${member.name}`, prompt: 'Do work' });
      expect(created.status, created.body).toBe(200);
      const child = JSON.parse(created.body).result;
      const started = await call(member.config.token, 'lazy_start', { task_id: child.full_id });
      expect(started.status, started.body).toBe(200);
      const childSession = readSessionJson(ctx.root, child.id)!;
      expect(childSession.turn_owner_email).toBe(member.email);
      expect(childSession.turn_owner_name).toBe(member.name);
      clearSessionCredentialCache();
      const binding = await getTaskSessionBinding(ctx.root, child.full_id);
      expect(binding?.ownerUserId).toBe(member.email);
    }
    const token = members[0]!.config.token;
    const unrelated = await createTask(ctx, 'Unrelated', 'Other work', { token: members[0]!.actor });
    expect((await call(token, 'lazy_show', { task_id: fullTaskId }, findFullTaskId(ctx.root, unrelated))).status).toBe(403);
    expect((await call(token, 'lazy_show', { task_id: fullTaskId }, '_')).status).toBe(403);
    expect((await call(token, 'lazy_show', { task_id: fullTaskId }, fullTaskId, '/another/project')).status).toBe(400);
    const outsideWrite = await call(token, 'lazy_comment', { task_id: unrelated, message: 'must refuse' });
    expect(outsideWrite.body).toContain('not a child');
    // Even a real task token between turns cannot borrow the pairing authority.
    const taskToken = await mintMcpToken(ctx.root, { kind: 'task', taskId: fullTaskId }, 'test-task');
    expect((await call(taskToken, 'lazy_create', { goal: 'must refuse' })).status).toBe(403);

    await members[0]!.term.closed();
    await Bun.sleep(100);
    expect((await call(token, 'lazy_show', { task_id: fullTaskId })).status).toBe(401);
    expect((await call(members[1]!.config.token, 'lazy_show', { task_id: fullTaskId })).status).toBe(200);
    await rpc(sharedToken, 'revokeUserCredential', { userId: bobEmail, endEnvironments: true });
    expect(await docker.invocations()).toContain(`rm -f ${members[1]!.memberName}`);
    expect((await call(members[1]!.config.token, 'lazy_show', { task_id: fullTaskId })).status).toBe(401);
    await members[1]!.term.closed();
  }, 180_000);

  // INVARIANT: completing a task ends even detached idle member environments.
  // Teardown happens after acceptance; persistent shells cannot hold cleanup forever.
  test('accept ends a detached idle environment and revokes its credential', async () => {
    const worktree = getWorktreePathForRef(ctx.root, taskId);
    await writeFile(join(worktree, 'member-accept.txt'), 'accepted work\n');
    expect(ctx.git('-C', worktree, 'add', 'member-accept.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'commit', '-m', 'Work ready for accept').exitCode).toBe(0);

    const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;
    await docker.onExec('case "$*" in *list-sessions*) echo "0 1 shell";; esac; exit 0');
    const info = await rpc(alice, 'attachSession', { id: sessionId }) as AttachSessionInfo;
    const term = openTerminal(
      `${target.replace(/^http/, 'ws')}${info.attachPath}?mode=shell`,
      { Authorization: `Bearer ${alice}`, 'X-Lazy-Project': ctx.root },
    );
    await term.opened;
    const memberName = engine.execCreates.at(-1)!;
    const run = (await docker.invocations()).find(l => l.startsWith('run -d') && l.includes(`--name ${memberName} `))!;
    const bindingKey = /--label lazy.member-binding=(\S+)/.exec(run)![1]!;
    clearSessionCredentialCache();
    expect((await getTaskSessionBinding(ctx.root, bindingKey))?.revokedAt).toBeNull();
    await term.closed();

    const accepted = await rpc(alice, 'acceptTask', {
      taskId: fullTaskId, actor: 'human', memberAccept: true, reason: 'Ship the work',
    }) as { followThroughPending?: { steps: string[] } };
    expect(readTaskStatus(ctx.root, taskId)).toBe('complete');
    expect(accepted.followThroughPending?.steps ?? []).toEqual([]);
    expect(await docker.invocations()).toContain(`rm -f ${memberName}`);
    clearSessionCredentialCache();
    const binding = await getTaskSessionBinding(ctx.root, bindingKey);
    expect(binding?.revokedAt).toBeNumber();
    expect(await Bun.file(join(worktree, 'member-accept.txt')).exists()).toBe(false);
    expect(readTaskJson(ctx.root, taskId)?.metadata?.accept_followthrough).toBeFalsy();
  }, 180_000);

  // INVARIANT: a CONFIRMED close ends a member's sessions first — her
  // container removed, its credential revoked — and then goes ahead.
  test('a close confirmed to end her sessions removes her environment, then closes', async () => {
    const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;
    await docker.onExec(`case "$*" in *list-sessions*) echo "1 $(date +%s)";; esac; exit 0`);
    const info = await rpc(alice, 'attachSession', { id: sessionId }) as AttachSessionInfo;
    const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=shell`, { Authorization: `Bearer ${alice}`, 'X-Lazy-Project': ctx.root });
    await term.opened;
    const memberName = /--name (lazymember-\S+)/.exec((await docker.invocations()).find((l) => l.startsWith('run -d') && l.includes('lazymember-'))!)![1]!;

    await rpc(alice, 'closeTask', { taskId: fullTaskId, reason: 'not needed', endMemberSessions: true });
    expect(await docker.invocations()).toContain(`rm -f ${memberName}`);
    expect(readTaskStatus(ctx.root, taskId)).toBe('abandoned');
    await term.closed().catch(() => {});
  }, 180_000);

  // INVARIANT: several members may be inside one task at once, each in their
  // own container; humans coordinate (engineer, 2026-10-21). What would remove
  // the files waits for ALL of them and names them all.
  test('a second member gets their own container beside the first, and a close names both', async () => {
    const BOB_EMAIL = 'bob@example.com';
    await rpc(sharedToken, 'putUserCredential', { userId: BOB_EMAIL, kind: 'oauth', token: 'sk-ant-oat01-bob-member' });
    const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;
    const bob = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: BOB_EMAIL }) as { token: string }).token;
    await docker.onExec(`case "$*" in *list-sessions*) echo "1 $(date +%s)";; esac; exit 0`);
    const open = async (token: string) => {
      const info = await rpc(token, 'attachSession', { id: sessionId }) as AttachSessionInfo;
      expect(info.refusals?.shell).toBeUndefined();
      const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=shell`, { Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root });
      await term.opened;
      return term;
    };
    const aliceTerm = await open(alice);
    const bobTerm = await open(bob);
    const runs = (await docker.invocations()).filter((l) => l.startsWith('run -d') && l.includes('lazymember-'));
    expect(runs).toHaveLength(2);
    const names = runs.map((r) => /--name (lazymember-\S+)/.exec(r)![1]!);
    expect(new Set(names).size).toBe(2);
    expect(new Set(engine.execCreates)).toEqual(new Set(names));

    let err: unknown = null;
    try {
      await rpc(alice, 'closeTask', { taskId: fullTaskId, reason: 'not needed' });
    } catch (e) { err = e; }
    expect((err as RpcApplicationError).status).toBe(409);
    expect((err as Error).message).toContain(ALICE_EMAIL);
    expect((err as Error).message).toContain(BOB_EMAIL);

    await rpc(alice, 'closeTask', { taskId: fullTaskId, reason: 'not needed', endMemberSessions: true });
    const after = await docker.invocations();
    for (const n of names) expect(after).toContain(`rm -f ${n}`);
    expect(readTaskStatus(ctx.root, taskId)).toBe('abandoned');
    await aliceTerm.closed().catch(() => {});
    await bobTerm.closed().catch(() => {});
  }, 180_000);

  // INVARIANT: a member who LEFT the team loses their environments at once —
  // regardless of activity — and only theirs; a plain credential
  // revoke (no `endEnvironments`) leaves a running environment alone.
  test("a departed member's container is removed at once, a plain revoke leaves it", async () => {
    const BOB_EMAIL = 'bob@example.com';
    await rpc(sharedToken, 'putUserCredential', { userId: BOB_EMAIL, kind: 'oauth', token: 'sk-ant-oat01-bob-member' });
    const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;
    const bob = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: BOB_EMAIL }) as { token: string }).token;
    await docker.onExec(`case "$*" in *list-sessions*) echo "1 $(date +%s)";; esac; exit 0`);
    const terms = [];
    const containerNames = async () => (await docker.invocations())
      .filter((l) => l.startsWith('run -d') && l.includes('lazymember-'))
      .map((r) => /--name (lazymember-\S+)/.exec(r)![1]!);
    // One at a time, so each container name can be attributed to its member.
    const nameOf: Record<string, string> = {};
    for (const [email, token] of [[ALICE_EMAIL, alice], [BOB_EMAIL, bob]] as const) {
      const info = await rpc(token, 'attachSession', { id: sessionId }) as AttachSessionInfo;
      const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=shell`, { Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root });
      await term.opened;
      terms.push(term);
      const names = await containerNames();
      nameOf[email] = names.find((n) => !Object.values(nameOf).includes(n))!;
    }
    expect(nameOf[ALICE_EMAIL]).toBeTruthy();
    expect(nameOf[BOB_EMAIL]).toBeTruthy();
    expect(nameOf[ALICE_EMAIL]).not.toBe(nameOf[BOB_EMAIL]);
    const removals = async () => (await docker.invocations()).filter((l) => l.startsWith('rm -f lazymember-'));

    await rpc(sharedToken, 'revokeUserCredential', { userId: ALICE_EMAIL });
    expect(await removals()).toEqual([]);

    await rpc(sharedToken, 'revokeUserCredential', { userId: ALICE_EMAIL, endEnvironments: true });
    expect(await removals()).toEqual([`rm -f ${nameOf[ALICE_EMAIL]}`]);

    // Bob's is untouched by a plain revoke of his own credential.
    await rpc(sharedToken, 'revokeUserCredential', { userId: BOB_EMAIL });
    expect(await removals()).toEqual([`rm -f ${nameOf[ALICE_EMAIL]}`]);
    for (const t of terms) await t.closed().catch(() => {});
  }, 180_000);

  // INVARIANT: a member's Chat — the browser's Chat tab and `lazy chat` from a
  // clone bound to Teams, which attaches here in `chat` mode — runs in her own
  // container on HER credential, which the container holds only as a lazy
  // placeholder. No other credential is spent and the secret never leaves the
  // daemon.
  test("a member's chat runs in her own container on her own credential", async () => {
    const alice = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;
    const info = await rpc(alice, 'attachSession', { id: sessionId }) as AttachSessionInfo;
    expect(info.refusals?.chat).toBeUndefined();

    const headers = { Authorization: `Bearer ${alice}`, 'X-Lazy-Project': ctx.root };
    const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=chat`, headers);
    await term.opened;

    const runs = (await docker.invocations()).filter((l) => l.startsWith('run -d') && l.includes('lazymember-'));
    expect(runs).toHaveLength(1);
    const memberName = /--name (lazymember-\S+)/.exec(runs[0]!)![1]!;
    expect(runs[0]).toMatch(/-e CLAUDE_CODE_OAUTH_TOKEN=lazy-sess-\S+/);
    expect(runs[0]).not.toContain('sk-ant-oat01-alice-member');
    expect(runs[0]).not.toContain('sk-ant-oat01-service-member');
    const cmd = engine.execCmds.at(-1)!;
    const configPath = cmd[cmd.indexOf('--member-mcp-config') + 1]!;
    const configDir = /-v (\S+):\/run\/lazy-member-mcp:ro/.exec(runs[0]!)![1]!;
    const config = JSON.parse(await readFile(join(configDir, configPath.split('/').at(-1)!), 'utf-8'));
    const write = await fetch(`${target}/mcp/${fullTaskId}/lazy_create`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'X-Lazy-Project': ctx.root, 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: { goal: 'Chat must never write' } }),
    });
    expect(write.status, await write.text()).toBe(403);
    expect(engine.execCreates).toEqual([memberName]);
    expect(engine.execEnvs[0]!.filter((e) => /TOKEN|KEY/.test(e))).toEqual([]);
    await term.closed();
  }, 180_000);

  // INVARIANT: `lazy chat` (and pair/shell) from a clone bound to Teams reads the
  // daemon's per-mode refusal BEFORE opening a socket, so a member with no Claude
  // account connected is told to connect one — the browser's sentence — instead
  // of an unexplained failed attach. Nothing is created for them, and no other
  // credential is spent in their place.
  test('lazy chat from a bound clone, by a member with no credential, is refused by name', async () => {
    const BOB = 'bob@example.com';
    const bob = (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email: BOB }) as { token: string }).token;
    const laptop = join(workDir, 'laptop');
    const clone = join(laptop, 'clone');
    await runGit(['init', '-b', 'main', clone], { cwd: workDir });
    const unpin = pinDaemonBaseDir(join(laptop, 'daemon'));
    const teams = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => (await relayTeamsRpc(req, {
        project: 'acme/lazy-toy', cliToken: 'lz_cli_bob', projectRoot: ctx.root,
        daemonTarget: () => target, memberToken: () => bob,
      })) ?? Response.json({ error: 'not found' }, { status: 404 }),
    });
    try {
      await writeTeamsLogin(clone, {
        teamsUrl: `http://127.0.0.1:${teams.port}`, token: 'lz_cli_bob', project: 'acme/lazy-toy', projectId: '42',
      });
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LAZY_')));
      const proc = Bun.spawn(['bun', 'run', join(import.meta.dir, '..', '..', 'src', 'index.ts'), 'chat', fullTaskId], {
        cwd: clone, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
        env: { ...inherited, HOME: join(laptop, 'home'), LAZY_DAEMON_BASE_DIR: join(laptop, 'daemon'), NO_COLOR: '1' },
      });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(1);
      expect(stderr).toContain(BOB);
      expect(stderr).toContain('endpoint "builtin:anthropic"');
      expect(stderr).toContain('Connections (account, team, or project)');
      expect((await docker.invocations()).filter((l) => l.startsWith('run -d') && l.includes('lazymember-'))).toEqual([]);
      expect(engine.execCreates).toEqual([]);
    } finally {
      teams.stop(true);
      unpin();
    }
  }, 180_000);
});

describe('member connections cannot speak for a supervised work turn', () => {
  let ctx: TestContext;
  let workDir: string;
  let engine: FakeEngine;

  afterEach(async () => {
    await ctx?.cleanup();
    engine?.stop();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  // INVARIANT: member Pair children wake a parked cluster and interrupt its
  // supervised agent's wait; the agent channel remains available to all readers.
  test('Pair-created children wake the cluster and interrupt its wait', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'member-pair-children-'));
    const holdFile = join(workDir, 'hold-turn');
    const runningFile = join(workDir, 'running');
    const docker = await installFakeDocker(workDir);
    engine = startFakeEngine(join(workDir, 'engine.sock'), { allowExec: true });
    ctx = await setupTestLazy({ withDaemon: true });
    const made = await ctx.lazy(['create', '--type', 'cluster', '--goal', 'Run added children', '--prompt', 'Drive the children']);
    expectSuccess(made);
    const taskId = extractTaskId(made.stdout);
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const session = readSessionJson(ctx.root, taskId)!;
    session.runner_type = 'docker';
    writeSessionJson(ctx.root, taskId, session);
    await writeFile(runningFile, 'running');
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_MOCK_HOLD_TURN_FILE: holdFile, LAZY_MOCK_RUNNING_CONTAINERS: runningFile,
      PATH: `${docker.binDir}:${process.env.PATH ?? ''}`, DOCKER_HOST: `unix://${engine.socketPath}`,
    });
    const target = getDaemonTcpTarget(ctx.root)!;
    const control = readToken(ctx.root)!;
    const rpc = (token: string, command: string, params: Record<string, unknown> = {}) =>
      DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
    for (const userId of [ALICE_EMAIL, SERVICE_CREDENTIAL_USER_ID]) {
      await rpc(control, 'putUserCredential', {
        userId, kind: 'oauth', token: 'sk-ant-oat01-member-test',
        ...(userId === SERVICE_CREDENTIAL_USER_ID ? { ownerEmail: ALICE_EMAIL } : {}),
      });
    }
    const actor = (await rpc(control, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;
    await docker.onExec(`case "$*" in *list-sessions*) echo "1 $(date +%s)";; esac; exit 0`);
    const info = await rpc(actor, 'attachSession', { id: session.id }) as AttachSessionInfo;
    const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=pair`, {
      Authorization: `Bearer ${actor}`, 'X-Lazy-Project': ctx.root,
    });
    const call = async (token: string, tool: string, args: Record<string, unknown>) => {
      const response = await fetch(`${target}/mcp/${fullTaskId}/${tool}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root, 'Content-Type': 'application/json', ...heartbeatRequestHeaders() },
        body: JSON.stringify({ arguments: args }),
      });
      return readHeartbeatEnvelope(response, tool);
    };
    const until = async (what: string, check: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 30_000;
      while (!(await check())) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}\n${await readFile(getLogPath(ctx.root), 'utf-8')}`);
        await Bun.sleep(50);
      }
    };
    const protocol = join(ctx.protocolBase, fullTaskId);
    const pending: Promise<unknown>[] = [];
    try {
      await term.opened;
      const cmd = engine.execCmds.at(-1)!;
      const configPath = cmd[cmd.indexOf('--member-mcp-config') + 1]!;
      const memberName = engine.execCreates.at(-1)!;
      const run = (await docker.invocations()).find(l => l.startsWith('run -d') && l.includes(`--name ${memberName} `))!;
      const mount = /-v (\S+):\/run\/lazy-member-mcp:ro/.exec(run)![1]!;
      const config = JSON.parse(await readFile(join(mount, configPath.split('/').at(-1)!), 'utf-8'));
      await rm(runningFile);
      await writeFile(holdFile, 'hold');
      const previousDispatch = readDispatchedCommandId(protocol);
      const first = await call(config.token, 'lazy_create', { goal: 'First Pair child', prompt: 'Do work' });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const child = (first.body as any).result;
      expect((readTaskJson(ctx.root, child.id) as any).metadata[MEMBER_PAIR_CREATION_KEY]).toBe('true');
      const shown = await rpc(actor, 'show', { taskId: child.full_id, sections: ['status-history'] }) as any;
      expect(shown.statusHistory[0]).toMatchObject({ actor: 'agent', actor_email: ALICE_EMAIL });
      await until('the added child to dispatch a cluster turn', () => {
        const id = readDispatchedCommandId(protocol);
        return readTaskStatus(ctx.root, taskId) === 'working' && id !== null && id !== previousDispatch;
      });
      expect(readDispatchedCommandId(protocol)).not.toBeNull();
      const starting = call(config.token, 'lazy_start', { task_id: child.full_id });
      pending.push(starting);
      await until('child turn dispatch', () => readDispatchedCommandId(join(ctx.protocolBase, child.full_id)) !== null);
      const agentToken = await mintMcpToken(ctx.root, { kind: 'task', taskId: fullTaskId }, 'cluster-agent');
      const waiting = call(agentToken, 'lazy_wait', { task_id: child.full_id, timeout: 10 });
      pending.push(waiting);
      await until('the cluster wait', async () => (await readActiveWaits(protocol)).length > 0);
      // The waiting marker precedes the handler's initial child snapshot.
      await Bun.sleep(200);
      const second = await call(config.token, 'lazy_create', { goal: 'Second Pair child', prompt: 'More work' });
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      const answer = await waiting;
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      expect((answer.body as any).result.interrupted.reason).toBe('subtask_added');
      expect(JSON.stringify(answer.body)).toContain((second.body as any).result.full_id);
    } finally {
      await rm(holdFile, { force: true });
      await Promise.allSettled(pending);
      await term.closed();
    }
  }, 180_000);

  // INVARIANT: only the task agent owns its turn's final, report, progress,
  // decisions and commits. A member's tools cannot inject any of them, even
  // while that agent is working. The module mock holds a launched turn open;
  // task status is never hand-set to manufacture live-turn authority.
  test('Pair and Chat preserve agent authority across turn tools, waits and accept', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'member-pair-turn-'));
    const holdFile = join(workDir, 'hold-turn');
    const runningFile = join(workDir, 'member-container-running');
    await writeFile(runningFile, 'running');
    const docker = await installFakeDocker(workDir);
    engine = startFakeEngine(join(workDir, 'engine.sock'), { allowExec: true });
    ctx = await setupTestLazy({ withDaemon: true });
    const taskId = await createTask(ctx, 'Pair turn boundary', 'Do work');
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expectSuccess(await ctx.lazy(['wait', taskId]));
    const childMade = await ctx.lazyMocked(['branch', taskId, '--goal', 'Ready child', '--prompt', 'Do child work', '--yes'], MOCK_CLAUDE_SUCCESS);
    expectSuccess(childMade);
    const childId = /Created variant task ([a-f0-9]{8})/.exec(childMade.stdout)![1]!;
    expectSuccess(await ctx.lazy(['wait', childId]));
    const childWorktree = getWorktreePath(ctx.root, readTaskJson(ctx.root, childId) as any);
    await writeFile(join(childWorktree, 'child.txt'), 'Child work\n');
    ctx.git('-C', childWorktree, 'add', 'child.txt');
    ctx.git('-C', childWorktree, 'commit', '-m', 'Child work ready for accept');
    const waitId = await createTask(ctx, 'Wait target', 'Stay working during the member wait');
    const fullTaskId = findFullTaskId(ctx.root, taskId);
    const session = readSessionJson(ctx.root, taskId)!;
    session.runner_type = 'docker';
    writeSessionJson(ctx.root, taskId, session);
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_MOCK_HOLD_TURN_FILE: holdFile,
      // The module mock otherwise reports every container dead, replacing
      // Pair's environment (and revoking its token) when Chat attaches.
      LAZY_MOCK_RUNNING_CONTAINERS: runningFile,
      PATH: `${docker.binDir}:${process.env.PATH ?? ''}`, DOCKER_HOST: `unix://${engine.socketPath}`,
    });
    const target = getDaemonTcpTarget(ctx.root)!;
    const control = readToken(ctx.root)!;
    const rpc = (token: string, command: string, params: Record<string, unknown> = {}) =>
      DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
    await rpc(control, 'putUserCredential', { userId: ALICE_EMAIL, kind: 'oauth', token: 'sk-ant-oat01-alice-member' });
    const actor = (await rpc(control, 'mintActorToken', { kind: 'user', email: ALICE_EMAIL }) as { token: string }).token;
    await docker.onExec(`case "$*" in *list-sessions*) echo "1 $(date +%s)";; esac; exit 0`);
    const connections: Array<{ term: ReturnType<typeof openTerminal>; token: string }> = [];
    const call = async (token: string, tool: string, args: Record<string, unknown>, heartbeat = false) => {
      const reply = await fetch(`${target}/mcp/${fullTaskId}/${tool}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Lazy-Project': ctx.root, 'Content-Type': 'application/json', ...(heartbeat ? heartbeatRequestHeaders() : {}) },
        body: JSON.stringify({ arguments: args }),
      });
      if (heartbeat) {
        const envelope = await readHeartbeatEnvelope(reply, tool);
        return { status: envelope.status, body: JSON.stringify(envelope.body) };
      }
      return { status: reply.status, body: await reply.text() };
    };
    const marker = join(ctx.protocolBase, fullTaskId, 'final.json');
    const finalBytes = async () => {
      try { return await readFile(marker, 'utf-8'); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error(`Could not read the agent final at ${marker}: ${err}`);
      }
    };
    const refuseTurnCalls = async () => {
      const before = await finalBytes();
      for (const { token } of connections) {
        for (const { tool, args } of TURN_SCOPED_CALLS) {
          const refused = await call(token, tool, args);
          expect(refused.status, `${tool}: ${refused.body}`).toBe(403);
          expect(refused.body).toContain('not available');
        }
      }
      expect(await finalBytes()).toBe(before);
    };
    try {
      for (const mode of ['pair', 'chat']) {
        const info = await rpc(actor, 'attachSession', { id: session.id }) as AttachSessionInfo;
        const term = openTerminal(`${target.replace(/^http/, 'ws')}${info.attachPath}?mode=${mode}`, {
          Authorization: `Bearer ${actor}`, 'X-Lazy-Project': ctx.root,
        });
        await term.opened;
        const cmd = engine.execCmds.at(-1)!;
        const configPath = cmd[cmd.indexOf('--member-mcp-config') + 1]!;
        const memberName = engine.execCreates.at(-1)!;
        const run = (await docker.invocations()).find(l => l.startsWith('run -d') && l.includes(`--name ${memberName} `))!;
        const mount = /-v (\S+):\/run\/lazy-member-mcp:ro/.exec(run)![1]!;
        const config = JSON.parse(await readFile(join(mount, configPath.split('/').at(-1)!), 'utf-8'));
        connections.push({ term, token: config.token });
      }
      expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
      await refuseTurnCalls();

      // No task supervisor exists in this mock runtime. Force a fresh launch
      // rather than delivering command.json to a pretend running container.
      await rm(runningFile);
      await writeFile(holdFile, 'hold');
      const protocol = join(ctx.protocolBase, fullTaskId);
      const previousDispatch = readDispatchedCommandId(protocol);
      const launched = rpc(actor, 'unblockTask', { taskId: fullTaskId, message: 'Continue while I pair' });
      const waitLaunched = rpc(actor, 'startTask', { taskId: findFullTaskId(ctx.root, waitId) });
      try {
        const deadline = Date.now() + 20_000;
        // A working transition precedes dispatch, which clears the old final.
        // Only declare after this turn's command has actually been written.
        while ((!readDispatchedCommandId(protocol) || readDispatchedCommandId(protocol) === previousDispatch || readTaskStatus(ctx.root, waitId) !== 'working') && Date.now() < deadline) await Bun.sleep(50);
        expect(readDispatchedCommandId(protocol)).not.toBeNull();
        expect(readDispatchedCommandId(protocol)).not.toBe(previousDispatch);
        expect(readTaskStatus(ctx.root, taskId)).toBe('working');
        expect(readTaskStatus(ctx.root, waitId)).toBe('working');
        const agentToken = await mintMcpToken(ctx.root, { kind: 'task', taskId: fullTaskId }, 'task-agent');
        const final = await call(agentToken, 'lazy_final', { note: 'The task agent owns this final' });
        expect(final.status, final.body).toBe(200);
        const agentFinal = await finalBytes();
        expect(agentFinal).toContain('The task agent owns this final');
        await refuseTurnCalls();
        expect(await finalBytes()).toBe(agentFinal);

        // INVARIANT: the member is beside the parent agent, so cannot borrow
        // that agent's exemption for merging into its own working branch.
        const accepted = await call(connections[0]!.token, 'lazy_accept', { task_id: childId });
        expect(accepted.status, accepted.body).toBe(409);
        expect(accepted.body).toContain('Parent task');
        expect(accepted.body).toContain('is currently working');
        expect(readTaskStatus(ctx.root, childId)).toBe('blocked');

        const comment = await call(connections[0]!.token, 'lazy_comment', { task_id: taskId, message: 'Queued for the task agent alone' });
        expect(comment.status, comment.body).toBe(200);
        const notesBefore = readSessionJson(ctx.root, taskId)?.notes_delivered_through;
        const budgetBefore = readTaskJson(ctx.root, taskId).metadata?.non_human_turn_count;
        // INVARIANT: member waits never claim/ack the task agent's comments or
        // spend its delivery budget, even with a connected heartbeat caller.
        for (const { token } of connections) {
          const waited = await call(token, 'lazy_wait', { task_id: waitId, timeout: 2 }, true);
          expect(waited.status, waited.body).toBe(200);
          expect(waited.body).not.toContain('comment_added');
          expect(waited.body).not.toContain('Queued for the task agent alone');
          expect(JSON.parse(waited.body).result.timed_out).toBe(true);
        }
        expect(readSessionJson(ctx.root, taskId)?.notes_delivered_through).toBe(notesBefore);
        expect(readTaskJson(ctx.root, taskId).metadata?.non_human_turn_count).toBe(budgetBefore);
        // A member can wait on the paired task: their connection is beside,
        // and cannot prevent the task's supervised turn from ending.
        const ownWait = await call(connections[0]!.token, 'lazy_wait', { task_id: taskId, timeout: 1 }, true);
        expect(ownWait.status, ownWait.body).toBe(200);
        expect(JSON.parse(ownWait.body).result.timed_out).toBe(true);
        expect(readSessionJson(ctx.root, taskId)?.notes_delivered_through).toBe(notesBefore);
        expect(readTaskJson(ctx.root, taskId).metadata?.non_human_turn_count).toBe(budgetBefore);
      } finally {
        await rm(holdFile, { force: true });
        await Promise.all([launched, waitLaunched]);
      }
      expectSuccess(await ctx.lazy(['wait', taskId]));
      expectSuccess(await ctx.lazy(['wait', waitId]));
    } finally {
      await rm(holdFile, { force: true });
      for (const { term } of connections) await term.closed();
    }
  }, 180_000);
});
