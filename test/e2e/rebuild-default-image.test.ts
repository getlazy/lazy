/**
 * The broken-image way out for a project on lazy's DEFAULT runner image: the
 * Rebuild a project admin presses must rebuild that image, over the daemon's
 * real wire — never the 409 "This project has no custom runner image to build"
 * that every press returned before, on the machine where it mattered.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { DaemonClient } from '../../src/daemon/client';

async function until<T>(read: () => Promise<T>, pred: (v: T) => boolean, ms = 30_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T = await read();
  while (!pred(last)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, 200));
    last = await read();
  }
  return last;
}

describe('rebuilding lazy\'s default runner image', () => {
  let ctx: TestContext;
  let docker: FakeDocker;
  let proofDir: string;
  let client: DaemonClient;

  beforeEach(async () => {
    proofDir = await mkdtemp(join(tmpdir(), 'lazy-default-rebuild-'));
    docker = await installFakeDocker(proofDir);
    ctx = await setupTestLazy({ fakeClaude: true });
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const onDocker = before.replace('type = "dangerously-host-process-without-any-isolation"', 'type = "docker"');
    if (onDocker === before) throw new Error('could not restore [runner] type = "docker" in the generated lazy.toml');
    await writeFile(configPath, onDocker);
    await ctx.restartDaemon({ PATH: `${docker.binDir}:${process.env.PATH ?? ''}` });
    const c = await DaemonClient.create(ctx.root);
    if (!c) throw new Error('no daemon client for the test project');
    client = c;
  }, 120_000);

  afterEach(async () => {
    await ctx.cleanup();
    await rm(proofDir, { recursive: true, force: true });
  });

  async function rpc(command: string, params: Record<string, unknown> = {}): Promise<any> {
    return client.rpc(command, ctx.root, params);
  }

// INVARIANT: concurrent rebuild clicks start one job and the losing click
// names its log, rather than cancelling the first request's work.
test('overlapping cached and uncached rebuild clicks share one running build', async () => {
  await docker.slowBuilds(2);
  const before = (await docker.builds()).length;
  const outcomes = await Promise.allSettled([
    rpc('rebuildRunnerImage', { noCache: false }),
    rpc('rebuildRunnerImage', { noCache: true }),
  ]);
  const successes = outcomes.filter(r => r.status === 'fulfilled');
  const refusals = outcomes.filter(r => r.status === 'rejected');
  expect(successes).toHaveLength(1);
  expect(refusals).toHaveLength(1);
  const reply = successes[0]!.value;
  const buildId = reply.defaultBuild?.id ?? reply.imageState.build.id;
  expect(refusals[0]!.reason).toMatchObject({ status: 409, details: { buildId } });
  const finished = await until(
    () => rpc('imageBuildLog', { buildId }),
    page => page.build.outcome !== 'running', 30_000, 'the winning rebuild to finish',
  );
  expect(finished.build.outcome).not.toBe('cancelled');
  expect((await docker.builds()).length - before).toBe(1);
});

  // INVARIANT: on a project with no custom image, Rebuild rebuilds lazy's
  // default image — a fresh local build, watchable by its build id. A project
  // admin's way out of "claude in the runner image doesn't run" must never be
  // a button that can only answer 409.
  test('a Rebuild with no Dockerfile rebuilds the default image instead of refusing', async () => {
    expect((await rpc('runnerImage')).imageState.state).not.toBe('failed');
    const buildsBefore = (await docker.builds()).length;

    const rebuilt = await rpc('rebuildRunnerImage');
    expect(rebuilt.defaultBuild.imageName).toMatch(/:/);
    expect(rebuilt.description).toContain('default runner image');

    const log = await until(
      () => rpc('imageBuildLog', { buildId: rebuilt.defaultBuild.id }),
      (p) => p.build.outcome !== 'running', 60_000, 'the default image rebuild',
    );
    expect(log.build.outcome, JSON.stringify(log.build.failure)).toBe('succeeded');
    expect(log.lines.some((l: any) => /rebuild requested/.test(l.text))).toBe(true);
    const builds = (await docker.builds()).slice(buildsBefore);
    expect(builds.length).toBeGreaterThan(0);
    expect(builds.some((b) => b.includes('--no-cache'))).toBe(true);
  }, 120_000);

  // INVARIANT: a running default-image rebuild is the build the project's image
  // state names (what the banner's progress and `log --follow` read), and
  // Cancel stops it.
  test('a running default-image rebuild is shown in the image state and can be cancelled', async () => {
    await docker.slowBuilds(30);
    const rebuilt = await rpc('rebuildRunnerImage');
    await until(() => docker.buildPid(), (pid) => pid !== null, 30_000, 'the default image docker build');
    expect((await rpc('runnerImage')).imageState.build.id).toBe(rebuilt.defaultBuild.id);
    const cancelled = await rpc('cancelImageBuild', { buildId: rebuilt.defaultBuild.id });
    expect(cancelled.cancelled).toBe(rebuilt.defaultBuild.id);
    const log = await rpc('imageBuildLog', { buildId: rebuilt.defaultBuild.id });
    expect(log.build.outcome).toBe('cancelled');
  }, 120_000);

  // INVARIANT: a failed default-image rebuild is narrated in its build log,
  // with docker's error — never a silent nothing.
  test('a failing default-image rebuild says why in its build log', async () => {
    await docker.failBuilds();
    const rebuilt = await rpc('rebuildRunnerImage', { noCache: true });
    const log = await until(
      () => rpc('imageBuildLog', { buildId: rebuilt.defaultBuild.id }),
      (p) => p.build.outcome !== 'running', 60_000, 'the default image rebuild',
    );
    expect(log.build.outcome).toBe('failed');
    expect(log.build.failure.error.length).toBeGreaterThan(0);
  }, 120_000);
});
