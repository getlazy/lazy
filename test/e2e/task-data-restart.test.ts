/** Explicit environment restart through the real daemon and launcher; only Docker is fake. */
import { test, expect } from 'bun:test';
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { successScenario } from '../helpers/fake-claude';
import { installFakeDocker } from '../helpers/fake-docker';
import { readSessionJson, writeSessionJson, findFullTaskId } from '../helpers/storage';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { seedAgentBinaryStamp } from '../helpers/fake-docker-engine';
import { IMAGE_TAG, calculateImageInputManifest, calculateImageInputsHash } from '../../src/capture/claude';
import { taskDataVolumeName } from '../../src/runner/task-data';

test('explicit restart launches the new layout and clears the old-environment notice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'task-data-restart-'));
  const unpin = pinDaemonBaseDir(join(dir, 'daemon'));
  let ctx: TestContext | undefined;
  try {
    const docker = await installFakeDocker(join(dir, 'runtime'));
    ctx = await setupTestLazy({ fakeClaude: true });
    const id = await createTask(ctx, 'Keep my old environment', 'Wait for review');
    await ctx.setClaudeScenario(successScenario({ sessionId: 'fake-task-data' }));
    expectSuccess(await ctx.lazy(['start', id, '--yes']));
    expectSuccess(await ctx.lazy(['wait', id]));
    const uuid = findFullTaskId(ctx.root, id);
    const session = readSessionJson(ctx.root, id)!;
    session.runner_type = 'docker';
    session.container_name = `lazy-${id}`;
    writeSessionJson(ctx.root, id, session);
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf8');
    const after = before.replace('type = "dangerously-host-process-without-any-isolation"', 'type = "docker"');
    expect(after).not.toBe(before);
    await writeFile(configPath, after);
    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`, {
      dockerfileHash: await calculateImageInputsHash(ctx.root),
      inputs: await calculateImageInputManifest(ctx.root),
    });
    await seedAgentBinaryStamp(ctx.agentHome!);
    await docker.seedContainer(session.container_name, { state: 'running' });
    await writeFile(join(docker.stateDir, `old-layout-${session.container_name}`), '1');
    await ctx.restartDaemon({ PATH: `${docker.binDir}:${process.env.PATH ?? ''}` });
    const client = DaemonClient.fromTarget(getDaemonTcpTarget(ctx.root)!, readToken(ctx.root)!);
    const rpc = (method: string, params: Record<string, unknown> = {}) => client.rpc(method, ctx!.root, { taskId: uuid, ...params });
    expect(await rpc('taskData')).toMatchObject({ restartAvailable: true });
    // INVARIANT: only the person's explicit restart replaces this old container.
    expect(await rpc('ensureTaskContainer', { restart: true })).toMatchObject({ alreadyRunning: false });
    const launches = (await docker.invocations()).filter(c => c.startsWith('run -d') && c.includes(`--name ${session.container_name} `));
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain('--label lazy.task-data=1');
    const runtimeLog = await readFile(join(docker.stateDir, 'invocations.log'), 'utf8');
    expect(runtimeLog).toContain(`type=volume,src=${taskDataVolumeName(uuid)},dst=/lazy/data`);
    expect(runtimeLog).toContain('LAZY_TASK_DATA=/lazy/data');
    expect(await rpc('taskData')).toMatchObject({ restartAvailable: false, notice: null });
    expect((await docker.invocations()).filter(c => c.startsWith('volume rm'))).toEqual([]);
  } finally {
    await ctx?.cleanup();
    unpin();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
