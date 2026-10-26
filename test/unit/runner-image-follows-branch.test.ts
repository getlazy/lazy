/**
 * The project's runner image follows its acting branch: when the branch gets a
 * new commit the daemon rebuilds the image in the background from THAT commit's
 * exported tree, and the tag moves only if the build succeeds
 * (src/daemon/runner-image.ts, noteActingBranchAdvance).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, realpath, chmod, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { pinConfig } from '../helpers/pin-config';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { ensureImage, resetUpgradeImageBuild, IMAGE_TAG } from '../../src/capture/claude';
import { FileStorage } from '../../src/storage/file-storage';
import { DiskSpaceManager, setDiskSpaceManager } from '../../src/docker/disk-space';
import { handleRebuildRunnerImage } from '../../src/daemon/rpc-handlers';
import { customImageGate } from '../../src/capture/custom-image-gate';
import { checkImageBuiltFrom } from '../../src/doctor/sweep';
import { projectImageState } from '../../src/daemon/image-state';
import {
  startRunnerImageBoot, runnerImageStatus, resetRunnerImageForTests, noteActingBranchAdvance, customImageReady, cancelRunnerImageBuild,
  runnerImageJob, defaultImageRebuildJob, rebuildRunnerImage, type RunnerImageState, type BranchCommit,
} from '../../src/daemon/runner-image';

async function until(pred: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out; state is ${JSON.stringify(runnerImageStatus())}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const tipAt = (sha: string): BranchCommit => ({ branch: 'main', sha: sha.repeat(40).substring(0, 40) });

describe('the project image follows the acting branch', () => {
  let root: string;
  let cwd: string;
  let docker: FakeDocker;
  let undoDaemonBase: (() => void) | undefined;
  let undoConfig: (() => void) | undefined;
  let exported: string[];
  let imageName: string;
  let dockerDir: string;

  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const boot = () => startRunnerImageBoot(root, { isContainerRunner: async () => ({ binary: docker.binPath }) });
  const deps = () => ({
    exportTree: async (_root: string, commit: string, dir: string) => {
      exported.push(commit);
      await writeFile(join(dir, 'MARKER'), commit);
      // The exported commit carries the project's Dockerfile, which is what gets built.
      await writeFile(join(dir, 'Dockerfile.lazy'), `FROM lazy-runner:${IMAGE_TAG}\nRUN true\n`);
    },
  });
  const advanceTo = (sha: string) => noteActingBranchAdvance(root, { ...deps(), tip: async () => tipAt(sha) });
  // The default image builds beside the custom one at boot; only the custom image's builds are the subject here.
  const customBuilds = async () => (await docker.builds()).filter((l) => l.includes('lazy-custom-'));
  const ready = () => runnerImageStatus().state === 'ready';

  beforeEach(async () => {
    resetRunnerImageForTests();
    undoDaemonBase = pinDaemonBaseDir(await mkdtemp(join(tmpdir(), 'lazy-rimg-adv-base-')));
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-rimg-adv-root-')));
    exported = [];
    cwd = process.cwd();
    process.chdir(root);
    git('init', '-q', '-b', 'main');
    await writeFile(join(root, 'Dockerfile.lazy'), `FROM lazy-runner:${IMAGE_TAG}\nRUN true\n`);
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = "Dockerfile.lazy"\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    undoConfig = pinConfig(root);
    // Outside the repository: the tests commit with `git add -A` and switch branches.
    dockerDir = await mkdtemp(join(tmpdir(), 'lazy-rimg-adv-docker-'));
    docker = await installFakeDocker(dockerDir);
  });

  afterEach(async () => {
    delete process.env.LAZY_MANAGED;
    delete process.env.LAZY_MANAGED_BACKEND;
    process.chdir(cwd);
    resetRunnerImageForTests();
    undoConfig?.();
    undoDaemonBase?.();
    resetUpgradeImageBuild();
    await rm(root, { recursive: true, force: true });
    await rm(dockerDir, { recursive: true, force: true });
  });

  async function bootReady(): Promise<void> {
    await boot();
    await until(ready, 30_000);
    imageName = (runnerImageStatus() as Extract<RunnerImageState, { state: 'ready' }>).imageName;
  }

  const imageId = async () => (await Bun.$`${docker.binPath} image inspect ${imageName} --format {{.Id}}`.text()).trim();

  for (const source of ['custom', 'default']) {
    // INVARIANT: overlapping rebuild clicks never replace a running build.
    // The loser must carry the winning build's log id after asynchronous preflight.
    test(`concurrent cached and uncached rebuilds start one ${source} build`, async () => {
      if (source === 'custom') {
        await bootReady();
      } else {
        await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n');
        await rm(join(root, 'Dockerfile.lazy'));
        git('add', '-A');
        git('commit', '-q', '-m', 'use default image');
        await boot();
      }
      const before = (await docker.builds()).length;
      await docker.slowBuilds(2);
      const results = await Promise.allSettled([
        handleRebuildRunnerImage(root, { noCache: false }),
        handleRebuildRunnerImage(root, { noCache: true }),
      ]);
      const successes = results.filter(r => r.status === 'fulfilled');
      const refusals = results.filter(r => r.status === 'rejected');
      expect(successes).toHaveLength(1);
      expect(refusals).toHaveLength(1);
      const reply = (successes[0] as PromiseFulfilledResult<any>).value;
      const buildId = reply.defaultBuild?.id ?? reply.imageState.build.id;
      expect((refusals[0] as PromiseRejectedResult).reason).toMatchObject({
        status: 409, code: 'image_build_running', details: { buildId },
      });
      await until(async () => (await docker.builds()).length > before);
      const job = source === 'custom' ? runnerImageJob()! : defaultImageRebuildJob()!;
      expect(job.id).toBe(buildId);
      expect(job.controller.signal.aborted).toBe(false);
      await until(() => job.outcome !== 'running');
      expect(job.outcome).toBe('succeeded');
      expect((await docker.builds()).length - before).toBe(1);
    });
  }

for (const noCache of [false, true]) {
  // INVARIANT: the click must answer the live build after disk preflight,
  // even when another caller started that build while the disk probe waited.
  test(`a build starting during disk preflight refuses rebuild (noCache=${noCache})`, async () => {
    await bootReady();
    const storage = new FileStorage(root, { basePath: join(dockerDir, 'store') });
    await storage.initialize();
    const GiB = 1024 ** 3;
    await storage.saveDiskSpaceState({
      needsGrowth: true, images: [], lastRecovery: null,
      buildPressure: { image: imageName, identity: 'old', at: new Date().toISOString(),
        blocked: true, reason: 'enospc', diskBytes: 32 * GiB, requiredBytes: 42 * GiB,
        peakUsedBytes: 30 * GiB, consumedBytes: GiB, failedFreeBytes: 0,
        cacheEvictedBytes: 0, requiredCacheBytes: 0, cacheLimitBytes: null, message: 'old hold' },
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const manager = new DiskSpaceManager(storage, root, {
      filesystem: async () => {
        entered.resolve();
        await release.promise;
        return { totalBytes: 64 * GiB, freeBytes: 32 * GiB };
      },
      inventory: async () => ({ Images: [], Containers: [], BuildCache: [], LayersSize: 0 }),
      buildsRunning: () => 0,
      command: async args => { throw new Error(`unexpected reclaim: ${args.join(' ')}`); },
    });
    setDiskSpaceManager(manager);
    try {
      const pending = handleRebuildRunnerImage(root, { noCache });
      await entered.promise;
      const started = await rebuildRunnerImage();
      expect(started.ok).toBe(true);
      const job = runnerImageJob()!;
      release.resolve();
      await expect(pending).rejects.toMatchObject({
        status: 409, code: 'image_build_running', details: { buildId: job.id },
      });
      expect(runnerImageJob()!.id).toBe(job.id);
      expect(job.controller.signal.aborted).toBe(false);
      await until(() => job.outcome !== 'running');
      expect(job.outcome).toBe('succeeded');
    } finally {
      release.resolve();
      setDiskSpaceManager(null);
      await storage.close();
    }
  });
}

  // INVARIANT: a boot check reusing an image is not a new image build's provenance.
  test('a restart distinguishes a reused image from the build that produced it', async () => {
    await bootReady();
    const original = runnerImageJob()!;
    expect(original.metadata.imageProduced).toBe(true);
    const originalCommit = original.metadata.commit;
    git('commit', '--allow-empty', '-q', '-m', 'unrelated branch advance');
    const tip = git('rev-parse', 'HEAD');
    resetRunnerImageForTests();
    await boot();
    const check = runnerImageJob()!;
    await until(() => check.outcome !== 'running');
    expect(check.outcome).toBe('succeeded');
    expect(check.metadata.imageProduced).toBe(false);
    expect(check.metadata.commit).toBe(tip);
    expect(original.metadata.commit).toBe(originalCommit);
    // A queued advance may follow the check; finish it before cleaning up its files.
    await until(ready, 30_000);
  }, 60_000);

  // INVARIANT: every advance of the acting branch starts ONE background rebuild from that commit's
  // exported tree (never the working tree), and the image says which commit it was built from.
  test('an advance starts one build from the exported commit', async () => {
    await bootReady();
    const before = (await customBuilds()).length;
    const first = await imageId();
    // The tip the daemon booted at is the baseline, not an advance.
    await noteActingBranchAdvance(root, deps());
    expect((await customBuilds()).length).toBe(before);
    await advanceTo('b');
    await until(async () => (await customBuilds()).length === before + 1 && ready() && (runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom !== undefined);
    expect(exported).toEqual([tipAt('b').sha]);
    expect((runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom).toEqual(tipAt('b'));
    const all = await docker.builds();
    const lastCustom = all.map((l, i) => (l.includes('lazy-custom-') ? i : -1)).filter((i) => i >= 0).pop()!;
    const cwd = (await docker.buildCwds())[lastCustom];
    expect(cwd).not.toBe(root);
    expect(cwd).toContain('image-advance');
    // The same tip again is not an advance.
    await advanceTo('b');
    expect((await customBuilds()).length).toBe(before + 1);
    expect(await imageId()).not.toBe(first);
  }, 60_000);

  // INVARIANT: one build at a time. Tips that arrive while a build runs are
  // replaced by the newest, which is built once the running one ends; the commits between are skipped.
  test('an advance during a build queues exactly one more, for the newest tip', async () => {
    await bootReady();
    const before = (await customBuilds()).length;
    await docker.slowBuilds(2);
    await advanceTo('b');
    await until(() => runnerImageStatus().state === 'building');
    await advanceTo('c');
    await advanceTo('d');
    await until(async () => (runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom?.sha === tipAt('d').sha && ready(), 40_000);
    expect(exported).toEqual([tipAt('b').sha, tipAt('d').sha]);
    expect((await customBuilds()).length).toBe(before + 2);
  }, 90_000);

  // INVARIANT: the tag moves only when a build succeeds. A failed advance build leaves the
  // current image in use (launches never wait or fall back), shows the failure, and the next
  // advance builds again.
  test('the image is swapped only on success', async () => {
    await bootReady();
    const first = await imageId();
    await docker.failBuilds();
    await advanceTo('b');
    await until(() => runnerImageStatus().state === 'failed');
    const failed = runnerImageStatus() as Extract<RunnerImageState, { state: 'failed' }>;
    expect(failed.replacing).toBe(true);
    expect(failed.attemptedFrom).toEqual(tipAt('b'));
    expect(customImageReady()).toBe(true);
    expect(await imageId()).toBe(first);
    expect(await ensureImage(docker.binPath)).toBe(imageName);
    // Nothing was pruned: the image in use is the only one there is.
    expect((await docker.invocations()).filter((l) => l.includes('image rm'))).toEqual([]);
  }, 60_000);

  test('the superseded image is removed after a successful swap', async () => {
    await bootReady();
    const first = await imageId();
    await advanceTo('b');
    await until(async () => (await imageId()) !== first && ready());
    await until(async () => (await docker.invocations()).some((l) => l.includes(`image rm ${first}`)));
  }, 60_000);

  // INVARIANT: never build from a task branch — a task branch checked out in the root (an accept
  // is mid-flight) is not an acting branch, so nothing is exported or built from it.
  test('no build from a task branch', async () => {
    await bootReady();
    const before = (await customBuilds()).length;
    git('checkout', '-q', '-b', 'lazy/some-task');
    await writeFile(join(root, 'x.txt'), 'x');
    git('add', '-A');
    git('commit', '-q', '-m', 'task work');
    await noteActingBranchAdvance(root, deps());
    await new Promise((r) => setTimeout(r, 300));
    expect(exported).toEqual([]);
    expect((await customBuilds()).length).toBe(before);
    // Back on the project's branch, a commit there IS an advance.
    git('checkout', '-q', 'main');
    await noteActingBranchAdvance(root, deps()); // records the tip
    await writeFile(join(root, 'y.txt'), 'y');
    git('add', '-A');
    git('commit', '-q', '-m', 'on main');
    await noteActingBranchAdvance(root, deps());
    await until(async () => (await customBuilds()).length === before + 1 && ready());
    expect((runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom?.branch).toBe('main');
  }, 60_000);

  // INVARIANT: where the project Dockerfile is never auto-built (Teams' shared-dockerd backend),
  // an advance builds nothing either.
  test('no build where autoBuildsRootDockerfile is false', async () => {
    await bootReady();
    process.env.LAZY_MANAGED = '1';
    process.env.LAZY_MANAGED_BACKEND = 'local-docker';
    const before = (await customBuilds()).length;
    await advanceTo('b');
    await new Promise((r) => setTimeout(r, 300));
    expect(exported).toEqual([]);
    expect((await customBuilds()).length).toBe(before);
    expect(ready()).toBe(true);
  }, 60_000);

  // INVARIANT: an advance that queues behind a damaged-image repair must not hold the repair's
  // caller (a launch) for a second full build.
  test('a repair does not wait for the advance build queued behind it', async () => {
    await bootReady();
    await docker.slowBuilds(2);
    const repair = customImageGate()!.repair!(imageName).then(() => Date.now());
    await until(() => runnerImageStatus().state === 'building');
    await advanceTo('b');
    const repairedAt = await repair;
    await until(() => (runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom?.sha === tipAt('b').sha && ready(), 40_000);
    // The queued build took its own ~2s after the repair had already returned.
    expect(Date.now() - repairedAt).toBeGreaterThan(1000);
  }, 90_000);

  // INVARIANT: a commit that cannot be exported is a visible failure of the image state, with the
  // image in use kept — not a log line while the page reads "ready".
  test('an export failure is a failed + replacing state', async () => {
    await bootReady();
    await noteActingBranchAdvance(root, { tip: async () => tipAt('b'), exportTree: async () => { throw new Error('git archive failed'); } });
    await until(() => runnerImageStatus().state === 'failed');
    const failed = runnerImageStatus() as Extract<RunnerImageState, { state: 'failed' }>;
    expect(failed.replacing).toBe(true);
    expect(failed.attemptedFrom).toEqual(tipAt('b'));
    expect(failed.error).toContain('git archive failed');
    expect(customImageReady()).toBe(true);
    // The next advance builds again and clears it.
    await advanceTo('c');
    await until(() => ready() && (runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom?.sha === tipAt('c').sha);
  }, 60_000);

  test('boot clears an export a killed daemon left behind', async () => {
    const leftover = join(root, '.lazy', 'image-advance', 'deadbeef-abc');
    await mkdir(leftover, { recursive: true });
    await writeFile(join(leftover, 'MARKER'), 'x');
    await boot();
    await until(ready, 30_000);
    expect(await readdir(join(root, '.lazy')).then((l) => l.includes('image-advance'))).toBe(false);
  }, 60_000);

  // INVARIANT: builtFrom names the commit of the image IN USE: kept through a failed or cancelled
  // replacing rebuild, replaced by the next successful advance.
  test('builtFrom follows the image in use through failure and cancel', async () => {
    await bootReady();
    await advanceTo('b');
    await until(() => (runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom?.sha === tipAt('b').sha && ready());
    await docker.failBuilds();
    await advanceTo('c');
    await until(() => runnerImageStatus().state === 'failed');
    expect((runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom).toEqual(tipAt('b'));
    const shown = await projectImageState(root);
    expect(shown.state === 'failed' && shown.image.builtFrom).toEqual(tipAt('b'));

    await rm(join(dockerDir, 'fake-docker-state', 'fail-build'), { force: true });
    await docker.slowBuilds(5);
    await advanceTo('d');
    await until(() => runnerImageStatus().state === 'building');
    expect((runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom).toEqual(tipAt('b'));
    cancelRunnerImageBuild();
    const cancelled = runnerImageStatus() as Extract<RunnerImageState, { state: 'ready' }>;
    expect(cancelled.state).toBe('ready');
    expect(cancelled.builtFrom).toEqual(tipAt('b'));
  }, 90_000);

  // INVARIANT: the build records its commit on the image, and `lazy doctor` reads it back from there.
  test('the image carries a built-from label that doctor reads', async () => {
    await bootReady();
    await advanceTo('b');
    await until(() => ready() && (runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom ?.sha === tipAt('b').sha);
    expect((await docker.invocations()).some((l) => l.startsWith('build ') && l.includes(`lazy.built.from=main@${tipAt('b').sha}`))).toBe(true);

    const withLabel = join(dockerDir, 'docker-label');
    const without = join(dockerDir, 'docker-nolabel');
    await writeFile(withLabel, `#!/bin/sh\necho main@${tipAt('b').sha}\n`);
    await writeFile(without, '#!/bin/sh\necho\n');
    await chmod(withLabel, 0o755);
    await chmod(without, 0o755);
    const found = await checkImageBuiltFrom('x:1', withLabel);
    expect(found).toEqual({ ok: true, label: `Runner image built from main @ ${tipAt('b').sha.substring(0, 12)}` });
    expect(await checkImageBuiltFrom('x:1', without)).toBeNull();
  }, 60_000);

  // INVARIANT: an advance build whose tag did not move is a FAILURE. Offline, ensureImage swallows a
  // failed build and returns the existing image; reporting that as "built from <new commit>" would
  // name a commit the image never came from.
  test('an offline fallback that left the image alone is a failed + replacing state', async () => {
    await bootReady();
    await advanceTo('b');
    await until(() => ready() && (runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom?.sha === tipAt('b').sha);
    const first = await imageId();
    const toml = join(root, 'lazy.toml');
    await writeFile(toml, (await Bun.file(toml).text()) + '\n[remote]\noffline = true\n');
    await docker.failBuilds();
    await advanceTo('c');
    await until(() => runnerImageStatus().state === 'failed');
    const failed = runnerImageStatus() as Extract<RunnerImageState, { state: 'failed' }>;
    expect(failed.replacing).toBe(true);
    expect(failed.attemptedFrom).toEqual(tipAt('c'));
    expect(failed.error).toContain('was not rebuilt');
    // The image in use still says it came from b, never c.
    expect(failed.builtFrom).toEqual(tipAt('b'));
    expect(await imageId()).toBe(first);
    expect(customImageReady()).toBe(true);
  }, 60_000);

  // INVARIANT: a restart must not lose an advance. The image in use says which commit it came from;
  // at boot that seeds builtFrom, and a tip that has moved since queues exactly one advance build.
  test('boot seeds builtFrom from the image label and builds the tip it is behind', async () => {
    await bootReady();
    await advanceTo('b'); // the image now carries label main@bbbb… and the real tip is something else
    await until(() => ready() && (runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom?.sha === tipAt('b').sha);
    const builds = (await customBuilds()).length;
    const realTip = git('rev-parse', 'HEAD');

    resetRunnerImageForTests(); // the daemon restarts
    await boot();
    // Seeded at once, from the label — not lost with the old process.
    await until(() => (runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom?.sha === tipAt('b').sha || (runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom?.sha === realTip, 30_000);
    await until(() => ready() && (runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom?.sha === realTip, 40_000);
    expect((await customBuilds()).length).toBe(builds + 1);

    // Another restart, now on the tip: nothing to build, and the line is still there.
    resetRunnerImageForTests();
    await boot();
    await until(() => ready() && (runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom?.sha === realTip, 30_000);
    await new Promise((r) => setTimeout(r, 500));
    expect((await customBuilds()).length).toBe(builds + 1);
  }, 120_000);

  // A commit on top of `parent` that only a remote-tracking ref names: what the daemon's fetch
  // leaves behind after a PR/MR was merged on the forge, with the checkout's branch not moved.
  const remoteCommit = (parent: string, ref: string) => {
    const tree = git('rev-parse', `${parent}^{tree}`);
    const sha = git('commit-tree', tree, '-p', parent, '-m', 'merged on the forge');
    git('update-ref', ref, sha);
    return sha;
  };
  // Only the commit is faked; the tip is read from the real refs.
  const noteFromRefs = () => noteActingBranchAdvance(root, deps());

  // INVARIANT: the project branch advancing ON THE FORGE (a PR/MR merged into a protected main,
  // which never moves the checkout's branch) starts exactly one background build from origin's
  // tip, and a launch meanwhile uses the image in use. Without it a Teams project whose main is
  // protected never rebuilt its image at all.
  test('a forge-side merge rebuilds from origin\'s tip without moving the local branch', async () => {
    await bootReady();
    const first = await imageId();
    const local = git('rev-parse', 'main');
    const before = (await customBuilds()).length;
    await docker.slowBuilds(2);
    const tip = remoteCommit(local, 'refs/remotes/origin/main');
    await noteFromRefs();
    await until(() => runnerImageStatus().state === 'building');
    // A launch during the build: the current image, at once.
    expect(customImageReady()).toBe(true);
    expect(await ensureImage(docker.binPath)).toBe(imageName);
    expect(await imageId()).toBe(first);
    await noteFromRefs(); // the same tip again is not another advance
    await until(() => ready() && (runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom?.sha === tip, 40_000);
    expect(exported).toEqual([tip]);
    expect((await customBuilds()).length).toBe(before + 1);
    expect(git('rev-parse', 'main')).toBe(local);
    // The daemon's fast-forward then brings the checkout to the same commit: nothing new to build.
    git('merge', '-q', '--ff-only', 'origin/main');
    await noteFromRefs();
    await new Promise((r) => setTimeout(r, 300));
    expect((await customBuilds()).length).toBe(before + 1);
  }, 90_000);

  // INVARIANT: never a task branch, on origin either: a task branch moving on the forge builds nothing,
  // and neither does an origin branch that does not contain the local one (local commits not pushed yet).
  test('no build for an origin move of a task branch, or an origin behind the local branch', async () => {
    await bootReady();
    const before = (await customBuilds()).length;
    const local = git('rev-parse', 'main');
    remoteCommit(local, 'refs/remotes/origin/lazy/some-task');
    await noteFromRefs();
    // origin/main is at an unrelated older line: the local branch is what the image follows.
    const orphan = git('commit-tree', git('rev-parse', 'main^{tree}'), '-m', 'unrelated');
    git('update-ref', 'refs/remotes/origin/main', orphan);
    await noteFromRefs();
    // A task branch checked out in the root (an accept mid-flight) with origin's copy of it ahead.
    git('checkout', '-q', '-b', 'lazy/some-task');
    remoteCommit(git('rev-parse', 'HEAD'), 'refs/remotes/origin/lazy/some-task');
    await noteFromRefs();
    await new Promise((r) => setTimeout(r, 300));
    expect(exported).toEqual([]);
    expect((await customBuilds()).length).toBe(before);
  }, 60_000);

  // INVARIANT: the boot build builds the acting branch's COMMITTED tree, never the working tree,
  // and the image says which commit it came from.
  test('the boot build builds from the committed tree', async () => {
    await writeFile(join(root, 'UNCOMMITTED'), 'x');
    await bootReady();
    const all = await docker.builds();
    const lastCustom = all.map((l, i) => (l.includes('lazy-custom-') ? i : -1)).filter((i) => i >= 0).pop()!;
    const files = await docker.buildContextFiles(lastCustom);
    expect(files).not.toContain('UNCOMMITTED');
    expect((await docker.buildCwds())[lastCustom]).toContain('image-boot');
    expect((runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom).toEqual({ branch: 'main', sha: git('rev-parse', 'main') });
  }, 60_000);

  // INVARIANT: a background refresh that actually rebuilt builds from the checkout, so the image no
  // longer came from a branch commit — builtFrom is cleared rather than naming one it was not built from.
  test('a refresh that rebuilds clears builtFrom', async () => {
    await bootReady();
    await advanceTo('b');
    await until(() => ready() && (runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom?.sha === tipAt('b').sha);
    // The image is gone from the runtime, so the refresh's check must build it again.
    await Bun.$`${docker.binPath} image rm ${imageName}`.quiet();
    const builds = (await customBuilds()).length;
    customImageGate()!.stale!(imageName);
    await until(async () => (await customBuilds()).length === builds + 1 && ready() && (runnerImageStatus() as { builtFrom?: BranchCommit }).builtFrom === undefined);
  }, 60_000);

  test('the ready sentence names the commit', async () => {
    const { describeRunnerImage } = await import('../../src/daemon/runner-image');
    const s: RunnerImageState = { state: 'ready', imageName: 'x:1', dockerfile: 'Dockerfile.lazy', defaultImage: 'd', readyAt: 'now', builtFrom: tipAt('1') };
    expect(describeRunnerImage(s)).toContain('built from main @ 111111111111');
  });
});
