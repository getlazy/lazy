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
 * Needs a REAL out-of-process daemon (`setupTestLazy({ withDaemon: true })`),
 * for two independent reasons discovered while writing this suite:
 *
 *  - `isRunning` reaches `isContainerRunning` from `src/capture/claude.ts`,
 *    which the e2e module mock (`test/mocks/claude.ts`, loaded via
 *    `--preload` for every `withDaemon` daemon) REPLACES: the mock's version
 *    ignores the real docker binary entirely and instead reports "running"
 *    based on the mere EXISTENCE of a file named by
 *    `LAZY_MOCK_RUNNING_CONTAINERS` (test/mocks/claude.ts's own doc comment).
 *    So the "is it running" half of this test is driven by that marker file,
 *    not a fake `docker ps`.
 *  - `stopRun` (`DockerRunner.stopRun`, docker-runner.ts) is NOT part of that
 *    mock's replaced surface — it is a real method that really shells out —
 *    so the "does the stop fail" half needs a real fake `docker` binary on
 *    PATH. That only works if the daemon PROCESS itself is started with that
 *    PATH baked into its own environment at spawn time: `Bun.spawn` does not
 *    pick up a live mutation of `process.env.PATH` made after a process
 *    starts (confirmed empirically — an in-process daemon's spawn calls kept
 *    resolving the ambient `docker` lookup, never a PATH-mutated one).
 *    `daemonEnv` gives the child daemon process that PATH from birth.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, writeFile, chmod, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { RemoteStorage } from '../../src/storage/remote-storage';

const CONTAINER_NAME = 'lazy-builder-5709fa11';

describe('endBuilderSession: a genuinely failed stop is not reported as success', () => {
  let ctx: TestContext;
  let fakeBinDir: string;
  let runningMarker: string;
  let target: string;
  let token: string;

  beforeEach(async () => {
    fakeBinDir = await mkdtemp(join(tmpdir(), 'lazy-fake-docker-'));
    runningMarker = join(fakeBinDir, 'running-containers-marker');

    // Only `stop` needs to be scripted — `isRunning` is answered by the
    // module mock via LAZY_MOCK_RUNNING_CONTAINERS (see the header comment).
    // `docker stop --time ...` -> exit 1: the stop genuinely fails.
    // Anything else -> exit 0, so unrelated docker calls do not blow up.
    const script = `#!/bin/sh
case "$*" in
  *"stop --time"*) exit 1 ;;
  *) exit 0 ;;
esac
`;
    await writeFile(join(fakeBinDir, 'docker'), script);
    await chmod(join(fakeBinDir, 'docker'), 0o755);

    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
        LAZY_MOCK_RUNNING_CONTAINERS: runningMarker,
      },
    });
    const resolvedTarget = getDaemonTcpTarget(ctx.root);
    const resolvedToken = readToken(ctx.root);
    if (!resolvedTarget || !resolvedToken) throw new Error('test daemon did not record a TCP target and token');
    target = resolvedTarget;
    token = resolvedToken;
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(fakeBinDir, { recursive: true, force: true });
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
    // The marker file's mere existence is what the mocked isRunning() checks.
    await writeFile(runningMarker, '');

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

    const after = await storage().getBuilderSession('sess-5709fa11');
    expect(after?.state).toBe('running');
    expect(after?.containerName).toBe(CONTAINER_NAME);
  });

  // Contrast case: a container that is genuinely already gone (never started,
  // or reaped earlier) IS a successful end — this is not "always refuse".
  // No running-marker file is written, so the mocked isRunning() reports false.
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
