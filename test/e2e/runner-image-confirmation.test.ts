/**
 * A real daemon, a project with its own `Dockerfile.lazy`, and a fake docker
 * whose builds are slow: the daemon's boot build is still running, so a launch
 * needs the person's explicit "run on lazy's default image" — and without it
 * nothing is written (src/daemon/runner-image-choice.ts).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { createTask } from '../helpers/fixtures';
import { readTaskStatus, readTaskJson, setTaskStatus, setTaskMetadata, readSessionJson, writeSessionJson } from '../helpers/storage';
import { calculateImageInputsHash, calculateImageInputManifest, IMAGE_TAG } from '../../src/capture/claude';

async function until(pred: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('launching while the project runner image builds', () => {
  let ctx: TestContext;
  let docker: FakeDocker;
  let proofDir: string;

  beforeEach(async () => {
    proofDir = await mkdtemp(join(tmpdir(), 'lazy-rimg-e2e-'));
    docker = await installFakeDocker(proofDir);
    await docker.slowBuilds(60);
    // The fake-binary seam, not the module mock: the daemon must run the real
    // image code (the mock replaces it wholesale). It switches the runner to
    // the host process, so docker is put back below.
    ctx = await setupTestLazy({ fakeClaude: true });

    const configPath = join(ctx.root, 'lazy.toml');
    const before = await readFile(configPath, 'utf-8');
    const onDocker = before.replace('type = "dangerously-host-process-without-any-isolation"', 'type = "docker"');
    if (onDocker === before) throw new Error('could not restore [runner] type = "docker" in the generated lazy.toml');
    const patched = onDocker.replace('dockerfile = ""', 'dockerfile = "Dockerfile.lazy"');
    if (patched === onDocker) throw new Error('could not set [docker] dockerfile in the generated lazy.toml');
    await writeFile(configPath, patched);
    await writeFile(join(ctx.root, 'Dockerfile.lazy'), 'FROM debian:bookworm-slim\nRUN true\n');
    // lazy's default image is already on this host (current for this project),
    // as it is wherever lazy ran before: the fallback launch below needs it,
    // and only the project's own image is still building.
    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`, {
      dockerfileHash: await calculateImageInputsHash(ctx.root, true),
      inputs: await calculateImageInputManifest(ctx.root, true),
    });

    await ctx.restartDaemon({ PATH: `${docker.binDir}:${process.env.PATH ?? ''}` });
    await until(async () => {
      const r = await ctx.lazy(['system', 'runner-image', '--json']);
      if (r.exitCode !== 0) return false;
      return ['checking', 'building'].includes(JSON.parse(r.stdout).project.state);
    });
  }, 120_000);

  afterEach(async () => {
    await ctx.cleanup();
    await rm(proofDir, { recursive: true, force: true });
  });

  // INVARIANT: never silent, and never lossy — a launch nobody confirmed is
  // refused before anything is written; the task stays exactly as it was.
  test('an unconfirmed non-interactive start is refused and changes nothing', async () => {
    const taskId = await createTask(ctx, 'runner image confirmation', 'Say hello.');
    const result = await ctx.lazy(['start', taskId]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("runner image is not ready");
    expect(result.stderr).toContain('--default-image');
    expect(await readTaskStatus(ctx.root, taskId)).toBe('backlog');
    const view = JSON.parse((await ctx.lazy(['system', 'runner-image', taskId, '--json'])).stdout);
    expect(view.task.choseDefault).toBe(false);
    expect(view.task.needsConfirmation).toBe(true);
  }, 60_000);

  // INVARIANT: the confirmation is the person's, it is recorded on the task so
  // later turns keep the image they chose, and the VERY launch that confirmed
  // it runs on lazy's default image — not refused by the gate because the
  // launch kept a pre-confirmation snapshot of the task.
  test('--default-image records the choice and launches on the default image', async () => {
    const taskId = await createTask(ctx, 'runner image confirmation', 'Say hello.');
    const result = await ctx.lazy(['start', taskId, '--default-image']);
    expect(result.stdout).toContain("Running on lazy's default runner image");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readTaskStatus(ctx.root, taskId)).toBe('working');
    // The fake logs each argv as text, and a `docker run` argv spans lines (a
    // header value and the supervisor script carry newlines): the image is the
    // word right before the container command.
    const log = (await docker.invocations()).join('\n');
    expect(log).toContain(`lazy-runner:${IMAGE_TAG} sh -c`);
    expect(log).not.toMatch(/lazy-custom-\S+ sh -c/);
    const view = JSON.parse((await ctx.lazy(['system', 'runner-image', taskId, '--json'])).stdout);
    expect(view.task.choseDefault).toBe(true);
    expect(view.task.needsConfirmation).toBe(false);
  }, 60_000);

  // INVARIANT: read-only turns never wait for the project's image (engineer
  // decision 2026-10-02). An ask while it builds runs at once on lazy's default
  // image, with no confirmation, writes no default-image CHOICE (so the task's
  // later work turns are not pinned to it), and never leaves the task
  // `interrupted` — which auto-resume would turn into an unrequested WORK turn.
  test('an ask while the image builds runs on the default image and pins nothing', async () => {
    const taskId = await createTask(ctx, 'runner image ask', 'Say hello.');
    const started = await ctx.lazy(['start', taskId, '--default-image']);
    expect(started.exitCode, started.stderr).toBe(0);
    // Park it as a finished turn would, with a resumable agent session, and
    // take the person's default-image choice away again.
    await ctx.lazy(['stop', taskId, '--yes']);
    setTaskStatus(ctx.root, taskId, 'blocked');
    const session = readSessionJson(ctx.root, taskId)!;
    writeSessionJson(ctx.root, taskId, { ...session, agent_session_id: 'sess-abc', ended_at: null });
    setTaskMetadata(ctx.root, taskId, 'runner_image_choice', '');

    const runsBefore = (await docker.invocations()).join('\n').split('lazy-runner:').length;
    const asked = await ctx.lazy(['ask', taskId, '-m', 'What is left?', '--no-wait']);
    expect(asked.exitCode, asked.stdout + asked.stderr).toBe(0);
    expect(asked.stdout + asked.stderr).not.toContain('runner image is not ready');
    const log = (await docker.invocations()).join('\n');
    expect(log.split('lazy-runner:').length).toBeGreaterThan(runsBefore);
    expect(log).not.toMatch(/lazy-custom-\S+ sh -c/);
    expect(await readTaskStatus(ctx.root, taskId)).not.toBe('interrupted');
    const meta = readTaskJson(ctx.root, taskId).metadata ?? {};
    expect(meta.runner_image_choice ?? '').toBe('');
    expect(JSON.parse(meta.runner_image_last).kind).toBe('readonly');
  }, 90_000);
});

describe('a ready runner image that disappears before an ask', () => {
  let ctx: TestContext;
  let docker: FakeDocker;
  let proofDir: string;

  beforeEach(async () => {
    proofDir = await mkdtemp(join(tmpdir(), 'lazy-rimg-e2e-gone-'));
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
    await until(async () => {
      const r = await ctx.lazy(['system', 'runner-image', '--json']);
      return r.exitCode === 0 && JSON.parse(r.stdout).project.state === 'ready';
    }, 60_000);
  }, 120_000);

  afterEach(async () => {
    await ctx.cleanup();
    await rm(proofDir, { recursive: true, force: true });
  });

  // INVARIANT: when the image the daemon reported ready is gone by the time an
  // ask launches, the gate refuses it inside the launch — and the read-only
  // turn still runs, on lazy's default image, instead of failing or leaving
  // the task `interrupted`.
  test('the ask falls back to the default image and the task is not interrupted', async () => {
    const taskId = await createTask(ctx, 'runner image gone', 'Say hello.');
    const started = await ctx.lazy(['start', taskId]);
    expect(started.exitCode, started.stderr).toBe(0);
    await ctx.lazy(['stop', taskId, '--yes']);
    setTaskStatus(ctx.root, taskId, 'blocked');
    const session = readSessionJson(ctx.root, taskId)!;
    writeSessionJson(ctx.root, taskId, { ...session, agent_session_id: 'sess-abc', ended_at: null });

    // The image vanishes from the runtime (pruned by someone else).
    const imageName = JSON.parse((await ctx.lazy(['system', 'runner-image', '--json'])).stdout).project.imageName as string;
    const prefix = imageName.replace(/[:/]/g, '_');
    for (const f of await readdir(join(docker.stateDir, 'images'))) {
      if (f.startsWith(prefix)) await rm(join(docker.stateDir, 'images', f), { recursive: true, force: true });
    }

    // A stopped task keeps its container, and an ask into a kept container
    // launches nothing — so remove it (as a prune would), or the image gate
    // under test is never reached.
    const removed = Bun.spawnSync([docker.binPath, 'rm', '-f', `lazy-${taskId}`]);
    expect(removed.exitCode).toBe(0);

    const asked = await ctx.lazy(['ask', taskId, '-m', 'What is left?', '--no-wait']);
    expect(asked.exitCode, asked.stdout + asked.stderr).toBe(0);
    expect(await readTaskStatus(ctx.root, taskId)).not.toBe('interrupted');
    const meta = readTaskJson(ctx.root, taskId).metadata ?? {};
    expect(meta.runner_image_choice ?? '').toBe('');
    expect(JSON.parse(meta.runner_image_last).kind).toBe('readonly');
  }, 120_000);
});
