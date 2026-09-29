/**
 * `endBuilderSession` must not report success when the container stop
 * genuinely fails (docker refuses, the runner cannot reach it) — distinct
 * from "the container is already gone", which IS a success.
 *
 * The daemon now owns this container's lifetime; `endBuilderSession` is the
 * only stop path a member has. Marking a session 'ended' while its container
 * keeps running would strand it forever — a retry short-circuits on
 * `state === 'ended'`, and nothing can reach the container through lazy
 * again.
 *
 * Needs a REAL out-of-process daemon with NOTHING in `src/` mocked
 * (`setupTestLazy({ fakeClaude: true })`, which starts the daemon without the
 * module-mock preload). The end path decides "is it running" with a real
 * `docker inspect` (`probeContainerInfo` via `DockerRunner.probeRunInfo`), and
 * the module mock (`test/mocks/claude.ts`) replaces that function wholesale —
 * under it the probe never reaches any binary, so a mocked daemon cannot
 * express "running, and the stop fails". Both halves are therefore scripted
 * with the fake `docker` binary (`test/helpers/fake-docker.ts`): a seeded
 * running container answers `inspect`, and `failStops()` makes `stop` refuse.
 * The binary reaches the daemon through the PATH it is (re)started with —
 * `Bun.spawn` does not pick up a live mutation of `process.env.PATH` made
 * after a process starts.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { RemoteStorage } from '../../src/storage/remote-storage';

const CONTAINER_NAME = 'lazy-builder-5709fa11';

describe('endBuilderSession: a genuinely failed stop is not reported as success', () => {
  let ctx: TestContext;
  let fakeDir: string;
  let docker: FakeDocker;
  let target: string;
  let token: string;

  beforeEach(async () => {
    fakeDir = await mkdtemp(join(tmpdir(), 'lazy-fake-docker-'));
    docker = await installFakeDocker(fakeDir);

    ctx = await setupTestLazy({ fakeClaude: true });
    // fakeClaude switches the project to the host-process runner; a builder
    // session's container is the docker runner's, so put that back.
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const patched = before.replace(
      'type = "dangerously-host-process-without-any-isolation"',
      'type = "docker"',
    );
    if (patched === before) throw new Error('could not restore [runner] type = "docker" in the generated lazy.toml');
    await writeFile(configPath, patched);
    await ctx.restartDaemon({ PATH: `${docker.binDir}:${process.env.PATH ?? ''}` });

    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    const resolvedToken = readToken(ctx.root);
    if (!resolvedTarget || !resolvedToken) throw new Error('test daemon did not record a TCP target and token');
    target = resolvedTarget;
    token = resolvedToken;
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(fakeDir, { recursive: true, force: true });
  });

  function client() {
    return DaemonClient.fromTarget(target, token);
  }

  function storage(): RemoteStorage {
    return new RemoteStorage(client(), ctx.root, '');
  }

  async function rpcStatus(command: string, params: Record<string, unknown> = {}) {
    try {
      const body = await client().rpc(command, ctx.root, params);
      return { status: 200, body };
    } catch (err) {
      if (!(err instanceof RpcApplicationError)) throw err;
      return { status: err.status, body: { error: err.message } };
    }
  }

  test('a failed stop is reported as an error, and the session is NOT marked ended', async () => {
    // The runtime says the container is up, and refuses to stop it.
    await docker.seedContainer(CONTAINER_NAME, { state: 'running', project: ctx.root });
    await docker.failStops();

    const now = new Date().toISOString();
    await storage().createBuilderSession({
      id: 'sess-5709fa11',
      projectRoot: ctx.root,
      memberEmail: 'test@lazy.test',
      kind: 'interactive',
      state: 'running',
      containerName: CONTAINER_NAME,
      builderId: '5709fa11',
      agentSessionId: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    });

    const { status, body } = await rpcStatus('endBuilderSession', { id: 'sess-5709fa11' });
    expect(status).toBe(502);
    expect((body as { error?: string }).error ?? '').toContain('could not stop container');
    // The refusal is the STOP's, not an unanswered liveness probe's.
    expect((body as { error?: string }).error ?? '').toContain('refused or could not reach');
    expect((await docker.invocations()).some(line => line.startsWith('stop ') && line.includes(CONTAINER_NAME))).toBe(true);

    const after = await storage().getBuilderSession('sess-5709fa11');
    expect(after?.state).toBe('running');
    expect(after?.containerName).toBe(CONTAINER_NAME);
  });

  // Contrast case: a container that is genuinely already gone (never started,
  // or reaped earlier) IS a successful end — this is not "always refuse".
  // No container is seeded, so `docker inspect` answers "No such container".
  test('a container that is already gone still ends successfully', async () => {
    const now = new Date().toISOString();
    await storage().createBuilderSession({
      id: 'sess-alreadygone',
      projectRoot: ctx.root,
      memberEmail: 'test@lazy.test',
      kind: 'interactive',
      state: 'running',
      containerName: 'lazy-builder-0e7e7e7e',
      builderId: '0e7e7e7e',
      agentSessionId: null,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    });

    const { status, body } = await rpcStatus('endBuilderSession', { id: 'sess-alreadygone' });
    expect(status).toBe(200);
    expect((body as { state?: string }).state).toBe('ended');

    const after = await storage().getBuilderSession('sess-alreadygone');
    expect(after?.state).toBe('ended');
    expect(after?.containerName).toBeNull();
  });
});
