/**
 * A real daemon, a ready project image and a fake docker: an accept advances the
 * project's branch, the daemon rebuilds the image in the background from that
 * commit, and a launch while it builds uses the current image without waiting
 * (src/daemon/runner-image.ts, noteActingBranchAdvance).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { createTask } from '../helpers/fixtures';
import { readTaskStatus, setTaskStatus, readSessionJson, taskFilePath } from '../helpers/storage';
import { seedFinal } from '../helpers/final';

async function until(pred: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('the project image follows the project branch', () => {
  let ctx: TestContext;
  let docker: FakeDocker;
  let proofDir: string;

  beforeEach(async () => {
    proofDir = await mkdtemp(join(tmpdir(), 'lazy-rimg-e2e-follow-'));
    docker = await installFakeDocker(proofDir);
    ctx = await setupTestLazy({ fakeClaude: true });
    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const onDocker = before.replace('type = "dangerously-host-process-without-any-isolation"', 'type = "docker"');
    if (onDocker === before) throw new Error('could not restore [runner] type = "docker" in the generated lazy.toml');
    const patched = onDocker.replace('dockerfile = ""', 'dockerfile = "Dockerfile.lazy"');
    if (patched === onDocker) throw new Error('could not set [docker] dockerfile in the generated lazy.toml');
    await writeFile(configPath, patched);
    await writeFile(join(ctx.root, 'Dockerfile.lazy'), 'FROM debian:bookworm-slim\nRUN true\n');
    await ctx.restartDaemon({ PATH: `${docker.binDir}:${process.env.PATH ?? ''}` });
    await until(async () => (await project()).state === 'ready', 60_000);
  }, 120_000);

  afterEach(async () => {
    await ctx.cleanup();
    await rm(proofDir, { recursive: true, force: true });
  });

  async function project(): Promise<Record<string, any>> {
    const r = await ctx.lazy(['system', 'runner-image', '--json']);
    return r.exitCode === 0 ? JSON.parse(r.stdout).project : { state: 'unknown' };
  }

  /** A task parked with real committed work, ready to accept. */
  async function taskWithWork(goal: string): Promise<string> {
    const taskId = await createTask(ctx, goal, 'Say hello.');
    const started = await ctx.lazy(['start', taskId, '--yes']);
    expect(started.exitCode, started.stderr + started.stdout).toBe(0);
    await ctx.lazy(['stop', taskId, '--yes']);
    setTaskStatus(ctx.root, taskId, 'blocked');
    const worktree = join(ctx.root, '.lazy', 'worktrees', taskId);
    await writeFile(join(worktree, 'feature.txt'), 'feature\n');
    expect(ctx.git('-C', worktree, 'add', 'feature.txt').exitCode).toBe(0);
    expect(ctx.git('-C', worktree, 'commit', '-m', 'Add feature').exitCode).toBe(0);
    // A real accept, not an empty one: the session recorded the commit.
    const sha = ctx.git('-C', worktree, 'rev-parse', 'HEAD').stdout.trim();
    const sess = readSessionJson(ctx.root, taskId)!;
    await writeFile(taskFilePath(ctx.root, taskId, 'commits.json'), JSON.stringify({
      commits: [{ id: 'c1', session_id: sess.id, sha, message: 'Add feature', status: 'committed', timestamp: Date.now() }],
    }));
    await seedFinal(ctx, taskId);
    return taskId;
  }

  // INVARIANT: an accept that advances the project's branch starts a background
  // rebuild from that commit, and a launch during it uses the current image at
  // once — it never waits for the build and never falls back to the default image.
  test('an accept starts a background build and a launch during it uses the old image', async () => {
    const buildsBefore = (await docker.builds()).filter((l) => l.includes('lazy-custom-')).length;
    await docker.slowBuilds(12);
    const taskId = await taskWithWork('image follows branch');
    const accepted = await ctx.lazy(['accept', taskId, '--yes']);
    expect(accepted.exitCode, accepted.stdout + accepted.stderr).toBe(0);
    expect(await readTaskStatus(ctx.root, taskId)).toBe('complete');

    await until(async () => (await project()).state === 'building');
    const building = await project();
    expect(building.replacing).toBe(true);
    expect(building.attemptedFrom.branch.length).toBeGreaterThan(0);

    const other = await createTask(ctx, 'launch during the rebuild', 'Say hello.');
    const t0 = Date.now();
    const started = await ctx.lazy(['start', other, '--yes']);
    expect(started.exitCode, started.stdout + started.stderr).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect((await project()).state).toBe('building');
    const log = (await docker.invocations()).join('\n');
    expect(log).toMatch(/lazy-custom-\S+ sh -c/);

    await until(async () => (await project()).state === 'ready', 60_000);
    const done = JSON.parse((await ctx.lazy(['system', 'runner-image', '--json'])).stdout);
    expect(done.imageState.image.builtFrom.sha).toBe(building.attemptedFrom.sha);
    expect(done.description).toContain(`built from ${building.attemptedFrom.branch} @ ${building.attemptedFrom.sha.substring(0, 12)}`);
    expect((await docker.builds()).filter((l) => l.includes('lazy-custom-')).length).toBe(buildsBefore + 1);
  }, 180_000);
});
