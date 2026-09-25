/**
 * E2E: a terminal attaches to a daemon-owned builder session over
 * `GET /rpc/sessions/:id/attach/ws` — authenticated by an actor token, on a
 * MANAGED daemon whose dashboard shell answers 404.
 *
 * What is real: the daemon, its managed-mode gates, `resolveRpcActor` on a
 * minted per-member token, `startBuilderSession`'s detached launch (against the
 * fake docker CLI, as in builder-session-start-proof.test.ts), the
 * `attachSession` RPC, the WebSocket upgrade, the shell framing and the
 * `ExecStream` relay. What is fake: the container runtime. The CLI half is
 * `test/helpers/fake-docker.ts`; the Engine API half — the unix socket
 * `ExecStream` hijacks — is a small in-test server reached through
 * `DOCKER_HOST`, which records every attach and exec it is asked for. That
 * record is what proves a dropped socket reattaches to the SAME container: the
 * container's process lives in the runtime, not in the socket, so a second
 * attach must name the same container and nothing may have been launched or
 * exec'd in between.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';

import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { storageDirFor } from '../helpers/storage';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { SERVICE_CREDENTIAL_USER_ID } from '../../src/daemon/user-credentials';
import {
  IMAGE_TAG,
  calculateImageInputManifest,
  calculateImageInputsHash,
} from '../../src/capture/claude';
import type { BuilderSession } from '../../src/storage/types';
import type { AttachSessionInfo } from '../../src/daemon/session-attach';
import { seedAgentBinaryStamp, startFakeEngine, type FakeEngine } from '../helpers/fake-docker-engine';

const ALICE_EMAIL = 'alice@example.com';
const BOB_EMAIL = 'bob@example.com';

/** Open an attach socket; resolve once it has seen `ready` and the banner. */
function openAttach(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers } as never);
  ws.binaryType = 'arraybuffer';
  const output: string[] = [];
  const control: Array<{ type: string; [k: string]: unknown }> = [];
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`attach did not become ready; control=${JSON.stringify(control)} output=${output.join('')}`)), 20_000);
    const check = () => {
      if (control.some((m) => m.type === 'ready') && output.join('').includes('attached:')) {
        clearTimeout(timer);
        resolve();
      }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') control.push(JSON.parse(ev.data));
      else output.push(new TextDecoder().decode(ev.data as ArrayBuffer));
      check();
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('attach socket errored')); };
    ws.onclose = (ev) => { clearTimeout(timer); reject(new Error(`attach socket closed early (${ev.code} ${ev.reason})`)); };
  });
  const closed = () => new Promise<void>((resolve) => {
    ws.onclose = () => resolve();
    ws.onerror = () => resolve();
    ws.close();
  });
  return { ws, output, control, opened, closed };
}

describe('session attach route', () => {
  let ctx: TestContext;
  let sharedToken: string;
  let target: string;
  let docker: FakeDocker;
  let engine: FakeEngine;
  let workDir: string;

  async function rpc(token: string, command: string, params: Record<string, unknown> = {}) {
    return await DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  }

  async function mintUserToken(email: string): Promise<string> {
    return (await rpc(sharedToken, 'mintActorToken', { kind: 'user', email }) as { token: string }).token;
  }

  async function startAliceSession(): Promise<{ alice: string; session: BuilderSession }> {
    await rpc(sharedToken, 'putUserCredential', { userId: ALICE_EMAIL, kind: 'oauth', token: 'sk-ant-oat01-alice-attach' });
    await rpc(sharedToken, 'putUserCredential', { userId: SERVICE_CREDENTIAL_USER_ID, kind: 'oauth', token: 'sk-ant-oat01-service-attach' });
    const alice = await mintUserToken(ALICE_EMAIL);
    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`, {
      dockerfileHash: await calculateImageInputsHash(ctx.root),
      inputs: await calculateImageInputManifest(ctx.root),
    });
    await seedAgentBinaryStamp(ctx.agentHome!);
    const session = await rpc(alice, 'startBuilderSession', {}) as BuilderSession;
    expect(session.state).toBe('running');
    return { alice, session };
  }

  function wsUrl(path: string): string {
    return target.replace(/^http/, 'ws') + path;
  }

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'lzatt-'));
    docker = await installFakeDocker(workDir);
    engine = startFakeEngine(join(workDir, 'engine.sock'));
    const homesBase = join(workDir, 'homes');
    process.env.LAZY_BUILDER_HOMES_BASE_DIR = homesBase;

    ctx = await setupTestLazy({ fakeClaude: true });
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const patched = before.replace(
      'type = "dangerously-host-process-without-any-isolation"',
      'type = "docker"',
    );
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
    sharedToken = readToken(ctx.root)!;
    if (!target || !sharedToken) throw new Error('test daemon did not record a TCP target and token');
  });

  afterEach(async () => {
    delete process.env.LAZY_BUILDER_HOMES_BASE_DIR;
    await ctx.cleanup();
    engine.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  // INVARIANT: in managed mode the dashboard shell is gone (404) and the
  // attach route is how a member reaches a session — authenticated by their
  // actor token, never by a dashboard session. The dashboard route must not
  // come back to make the attach route work, and the attach route must not
  // be gated by the dashboard's guard.
  test('authenticates with an actor token while the dashboard shell 404s in managed mode', async () => {
    const { alice, session } = await startAliceSession();

    const dashboardShell = await fetch(`${target}/tasks/anything/shell/ws`, {
      headers: { Authorization: `Bearer ${alice}` },
    });
    expect(dashboardShell.status).toBe(404);

    const info = await rpc(alice, 'attachSession', {}) as AttachSessionInfo;
    expect(info.sessionId).toBe(session.id);
    expect(info.kind).toBe('builder');
    expect(info.container).toBe(session.containerName!);
    expect(info.attachPath).toBe(`/rpc/sessions/${session.id}/attach/ws`);

    const headers = { Authorization: `Bearer ${alice}`, 'X-Lazy-Project': ctx.root };

    // No token: the /rpc gate, answered before anything is looked up.
    const anonymous = await fetch(`${target}${info.attachPath}`, { headers: { 'X-Lazy-Project': ctx.root } });
    expect(anonymous.status).toBe(401);

    // Another member's valid token: a 403, and no socket.
    const bob = await mintUserToken(BOB_EMAIL);
    const bobAttempt = await fetch(`${target}${info.attachPath}`, {
      headers: { Authorization: `Bearer ${bob}`, 'X-Lazy-Project': ctx.root },
    });
    expect(bobAttempt.status).toBe(403);
    let bobRpc: unknown = null;
    try { await rpc(bob, 'attachSession', { id: session.id }); } catch (err) { bobRpc = err; }
    expect(bobRpc).toBeInstanceOf(RpcApplicationError);
    expect((bobRpc as RpcApplicationError).status).toBe(403);

    // Alice's token: a real terminal, relayed both ways.
    const attach = openAttach(wsUrl(info.attachPath), headers);
    await attach.opened;
    expect(attach.output.join('')).toContain(`attached:${session.containerName}`);
    attach.ws.send(new TextEncoder().encode('ping-from-alice'));
    await Bun.sleep(300);
    expect(attach.output.join('')).toContain('ping-from-alice');
    await attach.closed();

    expect(engine.attaches).toEqual([session.containerName!]);
    expect(engine.execCreates).toEqual([]);
  }, 180_000);

  // INVARIANT: on a MANAGED daemon a member's builder session is theirs even
  // when team mode is off. Team mode means "some member stored a credential";
  // a session outlives its member's credential, so once that is removed the
  // project is back on the service credential alone with the session still
  // running. Keyed on team mode, any member could then list, stop and end it.
  test('on a managed daemon another member cannot list, stop or end a session', async () => {
    const { session } = await startAliceSession();
    await rpc(sharedToken, 'revokeUserCredential', { userId: ALICE_EMAIL });
    const bob = await mintUserToken(BOB_EMAIL);

    const bobList = await rpc(bob, 'storage', { method: 'listBuilderSessions', args: { projectRoot: ctx.root } }) as BuilderSession[];
    expect(bobList.map((s) => s.id)).not.toContain(session.id);

    for (const command of ['stopBuilderSession', 'endBuilderSession']) {
      let refused: unknown = null;
      try { await rpc(bob, command, { id: session.id }); } catch (err) { refused = err; }
      expect(refused).toBeInstanceOf(RpcApplicationError);
      expect((refused as RpcApplicationError).status).toBe(403);
    }
    expect(await docker.containers()).toContain(session.containerName!);
  }, 180_000);

  // INVARIANT: a dropped socket DETACHES; the session outlives it. The
  // reattach reaches the same container, and nothing is launched or exec'd in
  // between — the container's process is the session (§5.7).
  test('a dropped socket reattaches to the SAME container rather than starting a second one', async () => {
    const { alice, session } = await startAliceSession();
    const launchesBefore = (await docker.invocations()).filter((l) => l.includes(' -d ')).length;
    const url = wsUrl(`/rpc/sessions/${session.id}/attach/ws`);
    const headers = { Authorization: `Bearer ${alice}`, 'X-Lazy-Project': ctx.root };

    // The drop is a clean client close; the daemon's close path (exec.close()
    // on the socket) is the same for an abrupt one.
    const first = openAttach(url, headers);
    await first.opened;
    await first.closed();

    const second = openAttach(url, headers);
    await second.opened;
    expect(second.output.join('')).toContain(`attached:${session.containerName}`);
    await second.closed();

    expect(engine.attaches).toEqual([session.containerName!, session.containerName!]);
    expect(engine.execCreates).toEqual([]);
    const launchesAfter = (await docker.invocations()).filter((l) => l.includes(' -d ')).length;
    expect(launchesAfter).toBe(launchesBefore);
    expect(await docker.containers()).toContain(session.containerName!);

    // The registry still holds the one running session.
    const again = await rpc(alice, 'attachSession', {}) as AttachSessionInfo;
    expect(again.sessionId).toBe(session.id);
    expect(again.container).toBe(session.containerName!);
  }, 180_000);

  // INVARIANT: on a laptop the one user finds their own session with no id.
  // attachSession is a READ, so the identity gate never stamps it; the
  // session row was written by startBuilderSession under the daemon's git
  // identity, so discovery must resolve that same identity to match it.
  test('locally, attachSession with no id finds the session startBuilderSession started', async () => {
    const homesBase = join(workDir, 'homes');
    await ctx.restartDaemon({
      LAZY_BUILDER_HOMES_BASE_DIR: homesBase,
      PATH: `${docker.binDir}:${process.env.PATH ?? ''}`,
      DOCKER_HOST: `unix://${engine.socketPath}`,
    });
    target = getDaemonTcpTarget(ctx.root)!;
    sharedToken = readToken(ctx.root)!;
    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`, {
      dockerfileHash: await calculateImageInputsHash(ctx.root),
      inputs: await calculateImageInputManifest(ctx.root),
    });
    await seedAgentBinaryStamp(ctx.agentHome!);

    const session = await rpc(sharedToken, 'startBuilderSession', {}) as BuilderSession;
    expect(session.state).toBe('running');
    expect(session.memberEmail).toBeTruthy();

    const info = await rpc(sharedToken, 'attachSession', {}) as AttachSessionInfo;
    expect(info.sessionId).toBe(session.id);
    expect(info.container).toBe(session.containerName!);
  }, 180_000);
});
