/**
 * The damaged-image repair against the REAL launch-side code: Docker's
 * "failed to extract layer … invalid tar header" from a `docker run` is turned
 * into a repair, the image is removed with a plain `image rm`, rebuilt without
 * the cache by the build the daemon owns, and the launch retried once.
 *
 * Drives src/capture/claude.ts and src/daemon/runner-image.ts against the fake
 * `docker` binary (test/helpers/fake-docker.ts); the wrapper's own rules (one
 * retry, single-flight, reporting) are in damaged-image.test.ts.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, realpath, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { pinConfig } from '../helpers/pin-config';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import {
  ensureImage, preflightAgentBinaryInImage, runnerImageRepairDeps, resetUpgradeImageBuild, IMAGE_TAG,
} from '../../src/capture/claude';
import { DamagedImageError, resetDamagedImageRepairForTests, withDamagedImageRepair } from '../../src/docker/damaged-image';
import { startRunnerImageBoot, runnerImageStatus, resetRunnerImageForTests } from '../../src/daemon/runner-image';
import { writeAdoptedImage, hashDockerfileContent } from '../../src/daemon/adopted-image';

async function until(pred: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out; state is ${JSON.stringify(runnerImageStatus())}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Every docker call the repair could make that would touch more than the one image. */
const DESTRUCTIVE = /^(volume|system|container|rmi)\b|\bprune\b|\b(rm|image rm) (-f|--force)\b/;

describe('a damaged runner image is repaired on launch', () => {
  let root: string;
  let cwd: string;
  let docker: FakeDocker;
  let undoDaemonBase: (() => void) | undefined;
  let undoConfig: (() => void) | undefined;

  beforeEach(async () => {
    resetRunnerImageForTests();
    resetDamagedImageRepairForTests();
    undoDaemonBase = pinDaemonBaseDir(await mkdtemp(join(tmpdir(), 'lazy-dmg-base-')));
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-dmg-root-')));
    Bun.spawnSync(['git', 'init', '-q', root]);
    cwd = process.cwd();
    process.chdir(root);
    await writeFile(join(root, 'Dockerfile.lazy'), `FROM lazy-runner:${IMAGE_TAG}\nRUN true\n`);
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = "Dockerfile.lazy"\n');
    undoConfig = pinConfig(root);
    docker = await installFakeDocker(root);
  });

  afterEach(async () => {
    process.chdir(cwd);
    resetRunnerImageForTests();
    resetDamagedImageRepairForTests();
    undoConfig?.();
    undoDaemonBase?.();
    resetUpgradeImageBuild();
    await rm(root, { recursive: true, force: true });
  });

  const boot = () => startRunnerImageBoot(root, { isContainerRunner: async () => ({ binary: docker.binPath }) });

  /** The first container a custom-image launch creates: the agent-binary probe. */
  const launch = async () => {
    const image = await ensureImage(docker.binPath);
    await preflightAgentBinaryInImage(image, docker.binPath, 'cursor');
    return image;
  };

  // INVARIANT: Docker's layer-extraction failure on launch is a DamagedImageError
  // naming the image, carrying Docker's own words (the Teams banner reads them).
  test('the launch-side probe turns Docker\'s extraction failure into a damaged-image error', async () => {
    await boot();
    await until(() => runnerImageStatus().state === 'ready', 30_000);
    await docker.damageRuns(1);
    const err = await launch().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DamagedImageError);
    expect((err as DamagedImageError).imageName).toMatch(/^lazy-custom-/);
    expect((err as DamagedImageError).message).toContain('invalid tar header');
  }, 60_000);

  // INVARIANT: the project's own image is repaired by the daemon's tracked
  // build — a no-cache rebuild with its own build job — never inline by the
  // launch; only that image is removed, nothing is forced, nothing pulled.
  test('the project\'s image is removed, rebuilt without cache by the daemon\'s build, and the launch retried once', async () => {
    await boot();
    await until(() => runnerImageStatus().state === 'ready', 30_000);
    const ready = runnerImageStatus() as { imageName: string; buildId?: string | null };
    const callsBefore = (await docker.invocations()).length;
    await docker.damageRuns(1);

    const image = await withDamagedImageRepair({ ...runnerImageRepairDeps(docker.binPath), subject: 'task' }, launch);

    expect(image).toBe(ready.imageName);
    const calls = (await docker.invocations()).slice(callsBefore);
    expect(calls.filter((c) => c.startsWith('image rm '))).toEqual([`image rm ${ready.imageName}`]);
    expect(calls.filter((c) => c.startsWith('build ') && c.includes('--no-cache')).length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((c) => c.startsWith('pull '))).toEqual([]);
    for (const c of calls) expect(c).not.toMatch(DESTRUCTIVE);
    // Probe, damaged; probe again after the repair — no third attempt.
    // Exclude the rebuilt image's self-check, which runs when a valid installed lazy-agent binary is available.
    expect(calls.filter((c) => c.startsWith('run ') && c.includes('--entrypoint which ')).length).toBe(2);
    const after = runnerImageStatus() as { state: string; buildId?: string | null };
    expect(after.state).toBe('ready');
    expect(after.buildId).not.toBe(ready.buildId);
  }, 60_000);

  // INVARIANT: lazy's default image is repaired the same way, through the
  // default-image Rebuild (no pull: the published image could be the torn one).
  test('lazy\'s default image is removed and rebuilt without cache', async () => {
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n');
    await boot();
    const defaultImage = `lazy-runner:${IMAGE_TAG}`;
    expect(await ensureImage(docker.binPath)).toBe(defaultImage);
    const callsBefore = (await docker.invocations()).length;
    await docker.damageRuns(1);
    const damagedLaunch = async () => {
      const image = await ensureImage(docker.binPath);
      const p = Bun.spawn([docker.binPath, 'run', '--rm', image, 'true'], { stderr: 'pipe' });
      const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
      if (code !== 0) throw new DamagedImageError(image, stderr);
      return image;
    };

    expect(await withDamagedImageRepair({ ...runnerImageRepairDeps(docker.binPath), subject: 'builder' }, damagedLaunch)).toBe(defaultImage);
    const calls = (await docker.invocations()).slice(callsBefore);
    expect(calls.filter((c) => c.startsWith('image rm '))).toEqual([`image rm ${defaultImage}`]);
    expect(calls.some((c) => c.startsWith('build ') && c.includes('--no-cache'))).toBe(true);
    expect(calls.filter((c) => c.startsWith('pull '))).toEqual([]);
    for (const c of calls) expect(c).not.toMatch(DESTRUCTIVE);
  }, 60_000);

  // INVARIANT: an image a person chose — a task pin, a worktree adoption — is
  // never removed or rebuilt by a launch.
  test('a task-pinned or worktree-adopted image is left alone', async () => {
    const deps = runnerImageRepairDeps(docker.binPath);
    expect(await deps.canRebuild('some-pinned-image:1')).toBe(false);

    const adoptedDir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-dmg-adopt-')));
    const adoptedFile = join(adoptedDir, 'Dockerfile.lazy');
    await writeFile(adoptedFile, 'FROM debian:bookworm-slim\n# adopted\n');
    const adoptedName = `lazy-custom-aaaaaaaaaaaa:${IMAGE_TAG}`;
    await writeAdoptedImage(root, {
      dockerfilePath: adoptedFile,
      contentHash: hashDockerfileContent(await readFile(adoptedFile, 'utf-8')),
      imageName: adoptedName,
      contextCommit: 'ab'.repeat(20),
    });
    await docker.seedImage(adoptedName);
    expect(await deps.canRebuild(adoptedName)).toBe(false);

    const callsBefore = (await docker.invocations()).length;
    const err = await withDamagedImageRepair({ ...deps, subject: 'task' }, async () => {
      throw new DamagedImageError(adoptedName, 'failed to extract layer sha256:1: archive/tar: invalid tar header');
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain('invalid tar header');
    expect((await docker.invocations()).slice(callsBefore).filter((c) => c.startsWith('image rm'))).toEqual([]);
    await rm(adoptedDir, { recursive: true, force: true });
  }, 60_000);
});
