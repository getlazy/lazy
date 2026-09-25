/**
 * E2E: a member's task terminal on a shared (managed) daemon runs in a
 * container of its OWN — never the task's — and no turn starts while it is open.
 *
 * What is real: the daemon in managed mode, `resolveRpcActor` on a minted
 * per-member token, the `attachSession` RPC, the WebSocket upgrade, the member
 * entry under the lifecycle lock, the member container's `docker run` argv, the
 * member's credential minting, the `ExecStream` relay, and the unblock path's
 * launch refusal. What is fake: the container runtime — the CLI half is
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

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { storageDirFor, readSessionJson, writeSessionJson, findFullTaskId, readTurns, readTaskStatus } from '../helpers/storage';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import { IMAGE_TAG, calculateImageInputManifest, calculateImageInputsHash } from '../../src/capture/claude';
import type { AttachSessionInfo } from '../../src/daemon/session-attach';
import { seedAgentBinaryStamp, startFakeEngine, type FakeEngine } from '../helpers/fake-docker-engine';

const ALICE_EMAIL = 'alice@example.com';

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
    ws.onclose = () => resolve();
    ws.onerror = () => resolve();
    ws.close();
  });
  return { ws, output, control, opened, closed };
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

    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      PATH: `${docker.binDir}:${process.env.PATH ?? ''}`,
      DOCKER_HOST: `unix://${engine.socketPath}`,
    });
    target = getDaemonTcpTarget(ctx.root)!;
    sharedToken = readToken(ctx.root)!;
    if (!target || !sharedToken) throw new Error('test daemon did not record a TCP target and token');

    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`, {
      dockerfileHash: await calculateImageInputsHash(ctx.root),
      inputs: await calculateImageInputManifest(ctx.root),
    });
    await seedAgentBinaryStamp(ctx.agentHome!);
    await rpc(sharedToken, 'putUserCredential', { userId: ALICE_EMAIL, kind: 'oauth', token: 'sk-ant-oat01-alice-member' });
    await rpc(sharedToken, 'putUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'sk-ant-oat01-service-member' });
    // Between turns the task's own container stays up, with whatever a turn
    // left running in it.
    await docker.seedContainer(taskContainer, { state: 'running', project: ctx.root });
  }, 180_000);

  afterEach(async () => {
    await ctx.cleanup();
    engine.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  // INVARIANT: a member's terminal runs in a FRESH container of their own,
  // built from the task's image on the task's worktree, carrying their
  // credential and nothing of a turn's (no MCP config, no protocol dir) — and
  // the exec lands there, never in the task's container. While it is open no
  // turn can start on the task.
  test("runs in the member's own container, and keeps turns off the task while open", async () => {
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
    expect(run).toMatch(new RegExp(`member-homes/\\S*/git-pointers/dotgit:\\S*/\\.git:ro`));
    const pointerMounts = [...run.matchAll(/-v (\S+):(\S+\/(?:worktrees\/[^/\s]+\/\.git|commondir|gitdir)):ro/g)];
    expect(pointerMounts.map((m) => m[2]!.split('/').pop())).toEqual(['.git', 'commondir', 'gitdir']);
    for (const m of pointerMounts) expect(m[1]).toContain('/git-pointers/');

    // INVARIANT: no process of a turn runs beside a member. Her entry stopped
    // the task's own container — before hers was started — so nothing a turn
    // left running (a watcher able to rewrite .git, say) is alive while she
    // works; and it cannot be brought back up while she is inside.
    const invocations = await docker.invocations();
    const stopAt = invocations.findIndex((l) => l === `kill ${taskContainer}`);
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeLessThan(invocations.findIndex((l) => l.startsWith('run -d') && l.includes('lazymember-')));
    const running = await Bun.spawn([docker.binPath, 'ps', '--filter', `name=^/${taskContainer}$`, '--format', '{{.ID}}'], { stdout: 'pipe' });
    expect((await new Response(running.stdout).text()).trim()).toBe('');
    let broughtUp: unknown = null;
    try {
      await rpc(alice, 'ensureTaskContainer', { taskId: fullTaskId });
    } catch (err) { broughtUp = err; }
    expect(broughtUp).toBeInstanceOf(RpcApplicationError);
    expect((broughtUp as RpcApplicationError).status).toBe(409);
    expect((broughtUp as Error).message).toContain(ALICE_EMAIL);

    // The exec went into Alice's container, carrying no credential of its own.
    expect(engine.execCreates).toEqual([memberName]);
    expect(term.output.join('')).toContain(`exec:${memberName}`);
    expect(engine.execEnvs[0]!.filter((e) => /TOKEN|KEY/.test(e))).toEqual([]);

    // No turn starts while she is in: the launch is refused, naming her —
    // and refused BEFORE anything is recorded. A feedback turn written ahead
    // of the refusal would be a half-dispatched turn the redelivery path
    // later hands the agent as unconsumed feedback.
    const turnsBefore = readTurns(ctx.root, taskId).length;
    const statusBefore = readTaskStatus(ctx.root, taskId);
    let refused: unknown = null;
    try {
      await rpc(alice, 'unblockTask', { taskId: fullTaskId, message: 'carry on' });
    } catch (err) { refused = err; }
    expect(readTurns(ctx.root, taskId).length).toBe(turnsBefore);
    expect(readTaskStatus(ctx.root, taskId)).toBe(statusBefore);
    expect(refused).toBeInstanceOf(RpcApplicationError);
    expect((refused as RpcApplicationError).status).toBe(409);
    expect((refused as Error).message).toContain(ALICE_EMAIL);
    expect((await docker.invocations()).filter((l) => l.startsWith('run -d') && !l.includes('lazymember-'))).toEqual([]);

    // Nor does anything else touch her files: a sync with something to merge,
    // an accept, a reject and a close are all refused, naming her, and none of
    // them changes the task.
    await writeFile(join(ctx.root, 'upstream-change.txt'), 'new on main\n');
    for (const args of [['add', 'upstream-change.txt'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'upstream']]) {
      const git = Bun.spawnSync(['git', ...args], { cwd: ctx.root });
      if (git.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${git.stderr.toString()}`);
    }
    for (const [command, params] of [
      ['syncTask', {}],
      ['acceptTask', {}],
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
    }
    expect(readTurns(ctx.root, taskId).length).toBe(turnsBefore);
    expect(readTaskStatus(ctx.root, taskId)).toBe(statusBefore);

    await term.closed();

    // Her session ends 30 seconds after her last terminal closes: the
    // container (and anything she left running in it) is removed, its
    // credential is revoked, and the task takes turns again.
    await Bun.sleep(33_000);
    expect(await docker.invocations()).toContain(`rm -f ${memberName}`);
    // …and its home is handed back and gone, not left on the machine.
    const homeDir = new RegExp(`-v (\\S*member-homes/\\S*/${memberName})/.claude:`).exec(run)![1]!;
    expect(await Bun.file(join(homeDir, 'lazy-member-home.json')).exists()).toBe(false);
    let after: unknown = null;
    try {
      await rpc(alice, 'unblockTask', { taskId: fullTaskId, message: 'carry on' });
    } catch (err) { after = err; }
    if (after) expect((after as Error).message).not.toContain(ALICE_EMAIL);
  }, 180_000);
});
