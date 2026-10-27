/**
 * The project's custom runner image is built when the daemon BOOTS, and a
 * launch never builds it itself (src/daemon/runner-image.ts). While it is not
 * ready, launches either run on lazy's default image because somebody chose
 * that, or are refused (src/daemon/runner-image-choice.ts).
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtemp, writeFile, rm, realpath, readFile, mkdir } from 'fs/promises';
import { writeAdoptedImage, hashDockerfileContent } from '../../src/daemon/adopted-image';
import { join } from 'path';
import { tmpdir } from 'os';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { pinConfig } from '../helpers/pin-config';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { ensureImage, resolveImageRepository, resetUpgradeImageBuild, IMAGE_TAG } from '../../src/capture/claude';
import { RunnerImageNotReadyError, DEFAULT_RUNNER_IMAGE_PIN } from '../../src/capture/custom-image-gate';
import {
  startRunnerImageBoot, runnerImageStatus, resetRunnerImageForTests, retryRunnerImageBuild, syncRunnerImageTarget,
  cancelRunnerImageBuild, describeRunnerImage, type RunnerImageState,
} from '../../src/daemon/runner-image';
import { projectImageState } from '../../src/daemon/image-state';
import {
  confirmRunnerImageForLaunch, taskRunnerImageView, useCustomRunnerImage, runnerImageHold,
  builderRunnerImageBanner, classifyLaunchImage, mustRecreateForRunnerImage, RUNNER_IMAGE_NOT_READY_MARKER, RUNNER_IMAGE_LAST_META_KEY,
} from '../../src/daemon/runner-image-choice';
import { launchImagePin, RUNNER_IMAGE_CHOICE_META_KEY } from '../../src/docker/worktree-image';
import type { Task } from '../../src/types';
import type { Storage } from '../../src/storage/interface';

async function until(pred: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out; state is ${JSON.stringify(runnerImageStatus())}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('the custom runner image is built at daemon boot', () => {
  let root: string;
  let cwd: string;
  let docker: FakeDocker;
  let undoDaemonBase: (() => void) | undefined;
  let undoConfig: (() => void) | undefined;

  beforeEach(async () => {
    // A previous test's straggling build can record a failure after its afterEach reset.
    resetRunnerImageForTests();
    undoDaemonBase = pinDaemonBaseDir(await mkdtemp(join(tmpdir(), 'lazy-rimg-base-')));
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-rimg-root-')));
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
    undoConfig?.();
    undoDaemonBase?.();
    resetUpgradeImageBuild();
    await rm(root, { recursive: true, force: true });
  });

  const boot = () => startRunnerImageBoot(root, { isContainerRunner: async () => ({ binary: docker.binPath }) });

  // INVARIANT: Docker startup is waiting, not a failed build. Readiness probes
  // recover automatically without spending the OOM build-attempt budget.
  test('boot waits for Docker to answer then builds without Retry', async () => {
    await writeFile(join(docker.stateDir, 'info-failures-left'), '2');
    await boot();
    await until(() => (runnerImageStatus() as { waitingForEngine?: boolean }).waitingForEngine === true, 3_000);
    expect((await docker.builds()).length).toBe(0);
    await expect(readFile(join(root, '.lazy', 'runner-image-attempt.json'))).rejects.toThrow();
    await until(() => runnerImageStatus().state === 'ready');
    expect(await ensureImage(docker.binPath)).toMatch(/^lazy-custom-/);
  }, 30_000);

  // INVARIANT: an engine disappearing between readiness and ensureImage is
  // still waiting, not a failed build; only real builds spend the OOM budget.
  test('Docker can answer once then disappear before the build and recover', async () => {
    await writeFile(join(docker.stateDir, 'info-answer-once'), '1');
    await boot();
    await until(() => (runnerImageStatus() as { waitingForEngine?: boolean }).waitingForEngine === true, 3_000);
    expect((await docker.builds()).length).toBe(0);
    await expect(readFile(join(root, '.lazy', 'runner-image-attempt.json'))).rejects.toThrow();
    await rm(join(docker.stateDir, 'info-answer-once'));
    await until(() => runnerImageStatus().state === 'ready');
    expect(await ensureImage(docker.binPath)).toMatch(/^lazy-custom-/);
  }, 30_000);

  // INVARIANT: readiness retries must preserve earlier real failures. Removing
  // those would reset the cross-restart protection against OOM build loops.
  test('a pre-build Docker disappearance preserves earlier failed attempts', async () => {
    const { repository } = await resolveImageRepository(root);
    const record = { imageName: repository + ':' + IMAGE_TAG, failures: 1,
      lastAttemptAt: new Date(Date.now() - 120_000).toISOString(), inProgress: false, error: 'earlier build ran out of memory' };
    await mkdir(join(root, '.lazy'), { recursive: true });
    await writeFile(join(root, '.lazy', 'runner-image-attempt.json'), JSON.stringify(record));
    await writeFile(join(docker.stateDir, 'info-answer-once'), '1');
    await boot();
    await until(() => (runnerImageStatus() as { waitingForEngine?: boolean }).waitingForEngine === true, 3_000);
    expect(JSON.parse(await readFile(join(root, '.lazy', 'runner-image-attempt.json'), 'utf8'))).toEqual(record);
    expect((await docker.builds()).length).toBe(0);
    await rm(join(docker.stateDir, 'info-answer-once'));
    await until(() => runnerImageStatus().state === 'ready');
  }, 30_000);

  // INVARIANT: waiting is visible on every surface and Cancel prevents a
  // later Docker startup from launching work nobody still wants.
  test('waiting explains Docker readiness and can be cancelled', async () => {
    await docker.failInfo();
    await boot();
    await until(() => (runnerImageStatus() as { waitingForEngine?: boolean }).waitingForEngine === true);
    expect(describeRunnerImage()).toContain('as soon as it answers');
    const view = await projectImageState(root, { adoptionView: null });
    expect(view.state).toBe('building');
    if (view.state === 'building') expect(view.reason).toBe(describeRunnerImage());
    cancelRunnerImageBuild();
    await rm(join(docker.stateDir, 'fail-info'));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(runnerImageStatus().state).toBe('failed');
    expect((await docker.builds()).length).toBe(0);
  });

  // INVARIANT: an expired failure is retried before a launch reads readiness;
  // a live daemon must not retain yesterday's Docker-startup refusal forever.
  test('a launch retries an expired failure without an explicit Retry', async () => {
    await docker.failBuilds();
    await boot();
    await until(() => runnerImageStatus().state === 'failed');
    const status = runnerImageStatus() as Extract<RunnerImageState, { state: 'failed' }>;
    const now = Date.now.bind(Date);
    const clock = spyOn(Date, 'now').mockImplementation(() => now() + 120_000);
    try {
      await rm(join(docker.stateDir, 'fail-build'));
      await syncRunnerImageTarget();
      expect(runnerImageStatus().state).toBe('checking');
      await until(() => runnerImageStatus().state === 'ready');
      expect(await ensureImage(docker.binPath)).toBe(status.imageName);
    } finally {
      clock.mockRestore();
    }
  }, 30_000);

  // INVARIANT: while the boot build runs, a launch that wants the custom image
  // is refused and starts NO build of its own — the 25-minute build behind a
  // builder start is exactly what this replaced.
  test('a launch during the boot build is refused and builds nothing itself', async () => {
    await docker.slowBuilds(5);
    await boot();
    await until(() => runnerImageStatus().state === 'building');
    const before = (await docker.builds()).length;
    await expect(ensureImage(docker.binPath)).rejects.toBeInstanceOf(RunnerImageNotReadyError);
    expect((await docker.builds()).length).toBe(before);
    await until(() => runnerImageStatus().state === 'ready', 30_000);
    const name = await ensureImage(docker.binPath);
    expect(name).toMatch(/^lazy-custom-/);
  }, 60_000);

  // INVARIANT: a person's explicit default-image choice runs on lazy's default
  // image while the custom one is still building — never the custom one.
  test('the default image is usable while the custom one builds', async () => {
    await docker.slowBuilds(5);
    await boot();
    await until(() => runnerImageStatus().state === 'building');
    expect(await ensureImage(docker.binPath, { useDefaultImage: true })).toBe(`lazy-runner:${IMAGE_TAG}`);
    expect(await ensureImage(docker.binPath, { pinnedImage: DEFAULT_RUNNER_IMAGE_PIN })).toBe(`lazy-runner:${IMAGE_TAG}`);
    await until(() => runnerImageStatus().state === 'ready', 30_000);
  }, 60_000);

  // INVARIANT: a failed build stays visible — reason and Dockerfile — and a
  // launch afterwards neither builds nor succeeds; only a retry builds again.
  test('a failed build stays failed with its reason until retried', async () => {
    await docker.failBuilds();
    await boot();
    await until(() => runnerImageStatus().state === 'failed');
    const s = runnerImageStatus() as Extract<RunnerImageState, { state: 'failed' }>;
    expect(s.dockerfile).toBe('Dockerfile.lazy');
    expect(s.error.length).toBeGreaterThan(0);
    const before = (await docker.builds()).length;
    await expect(ensureImage(docker.binPath)).rejects.toBeInstanceOf(RunnerImageNotReadyError);
    expect((await docker.builds()).length).toBe(before);
    expect(runnerImageStatus().state).toBe('failed');
    const retried = await retryRunnerImageBuild();
    expect(retried.ok).toBe(true);
    await until(() => runnerImageStatus().state === 'failed');
  }, 60_000);

  // INVARIANT: no custom Dockerfile, no gate — launches behave as they always did.
  test('a project without a custom image registers no gate', async () => {
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n');
    await boot();
    expect(runnerImageStatus().state).toBe('none');
    expect(await ensureImage(docker.binPath)).toBe(`lazy-runner:${IMAGE_TAG}`);
  }, 60_000);

  // INVARIANT: a consented adoption (`lazy upgrade`) keeps its precedence:
  // launches run on the adopted image, the boot build does not track the root
  // image, and a person's default-image choice still gets lazy's default.
  test('an adoption takes precedence and takes the project out of the boot build', async () => {
    const adoptedDir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-rimg-adopt-')));
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
    await boot();
    expect(runnerImageStatus().state).toBe('none');
    expect(await ensureImage(docker.binPath)).toBe(adoptedName);
    expect(await ensureImage(docker.binPath, { pinnedImage: DEFAULT_RUNNER_IMAGE_PIN })).toBe(`lazy-runner:${IMAGE_TAG}`);
    const task = { id: 't1', status: 'blocked', metadata: {} } as unknown as Task;
    expect(await runnerImageHold(task)).toBeNull();
    await rm(adoptedDir, { recursive: true, force: true });
  }, 60_000);

  // INVARIANT: an adoption made after boot ends the tracked root build — the
  // project stops waiting on an image it no longer uses.
  test('an adoption recorded after boot drops the tracked build', async () => {
    await docker.slowBuilds(5);
    await boot();
    await until(() => runnerImageStatus().state === 'building');
    const adoptedDir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-rimg-adopt-')));
    const adoptedFile = join(adoptedDir, 'Dockerfile.lazy');
    await writeFile(adoptedFile, 'FROM debian:bookworm-slim\n# adopted\n');
    await writeAdoptedImage(root, {
      dockerfilePath: adoptedFile,
      contentHash: hashDockerfileContent(await readFile(adoptedFile, 'utf-8')),
      imageName: `lazy-custom-aaaaaaaaaaaa:${IMAGE_TAG}`,
      contextCommit: 'ab'.repeat(20),
    });
    await syncRunnerImageTarget();
    expect(runnerImageStatus().state).toBe('none');
    await rm(adoptedDir, { recursive: true, force: true });
  }, 60_000);

  // INVARIANT: the gate exists from boot on every container-runner daemon, so
  // a custom Dockerfile configured AFTER boot is built by the daemon — never
  // inline by the first launch that notices it.
  test('a custom Dockerfile configured after boot is built by the daemon, not the launch', async () => {
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n');
    await boot();
    expect(runnerImageStatus().state).toBe('none');
    await docker.slowBuilds(5);
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = "Dockerfile.lazy"\n');
    await expect(ensureImage(docker.binPath)).rejects.toBeInstanceOf(RunnerImageNotReadyError);
    await until(() => ['checking', 'building'].includes(runnerImageStatus().state));
    await until(() => runnerImageStatus().state === 'ready', 30_000);
  }, 60_000);

  // INVARIANT: readiness is always asked about the image the project wants
  // NOW. A Dockerfile edited after boot must turn "ready" into "building"
  // before a launch decision, not halfway through the launch.
  test('a Dockerfile edited after boot is not ready until the daemon built it', async () => {
    await boot();
    await until(() => runnerImageStatus().state === 'ready', 30_000);
    const before = (runnerImageStatus() as { imageName: string }).imageName;
    await docker.slowBuilds(3);
    await writeFile(join(root, 'Dockerfile.lazy'), `FROM lazy-runner:${IMAGE_TAG}\nRUN echo changed\n`);
    await syncRunnerImageTarget();
    const s = runnerImageStatus() as { state: string; imageName: string };
    expect(s.imageName).not.toBe(before);
    expect(['checking', 'building']).toContain(s.state);
    const task = { id: 't1', status: 'blocked', metadata: {} } as unknown as Task;
    expect(await runnerImageHold(task)).not.toBeNull();
    await until(() => runnerImageStatus().state === 'ready', 30_000);
  }, 60_000);

  // INVARIANT: a build_inputs change (same image name) is rebuilt by the
  // daemon in the background while launches keep the current image.
  test('changed build inputs keep the current image and rebuild it in the background', async () => {
    await writeFile(join(root, 'Gemfile.lock'), 'v1\n');
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = "Dockerfile.lazy"\nbuild_inputs = ["Gemfile.lock"]\n');
    await boot();
    await until(() => runnerImageStatus().state === 'ready', 30_000);
    const name = (runnerImageStatus() as { imageName: string }).imageName;
    const before = (await docker.builds()).length;
    await writeFile(join(root, 'Gemfile.lock'), 'v2\n');
    expect(await ensureImage(docker.binPath)).toBe(name);
    expect(runnerImageStatus().state).toBe('ready');
    const deadline = Date.now() + 20_000;
    while ((await docker.builds()).length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect((await docker.builds()).length).toBeGreaterThan(before);
  }, 60_000);

  // INVARIANT: a failing background refresh backs off. A launch that finds a
  // ready image with changed inputs forces a refresh, and each attempt is a
  // full build that can exhaust a small guest dockerd's memory.
  test('a refresh that failed is not started again inside its backoff window', async () => {
    await writeFile(join(root, 'Gemfile.lock'), 'v1\n');
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = "Dockerfile.lazy"\nbuild_inputs = ["Gemfile.lock"]\n');
    await boot();
    await until(() => runnerImageStatus().state === 'ready', 30_000);
    const name = (runnerImageStatus() as { imageName: string }).imageName;
    await docker.failBuilds();
    const before = (await docker.builds()).length;
    await writeFile(join(root, 'Gemfile.lock'), 'v2\n');
    expect(await ensureImage(docker.binPath)).toBe(name);
    await until(() => (runnerImageStatus() as { refreshRetryAt?: string }).refreshRetryAt !== undefined, 20_000);
    const after = (await docker.builds()).length;
    expect(after).toBeGreaterThan(before);
    await writeFile(join(root, 'Gemfile.lock'), 'v3\n');
    expect(await ensureImage(docker.binPath)).toBe(name);
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await docker.builds()).length).toBe(after);
  }, 60_000);

  // INVARIANT: a failed project-image build is remembered across a daemon
  // restart. The fleet restarts a daemon that comes back healthy without any
  // backoff of its own, so a build that takes the machine down must not re-run
  // on every boot.
  test('a failed boot build is not re-run by a restarted daemon inside its backoff window', async () => {
    await docker.failBuilds();
    await boot();
    await until(() => runnerImageStatus().state === 'failed', 30_000);
    const after = (await docker.builds()).length;
    resetRunnerImageForTests(); // the daemon restarts; the project root keeps its record
    await boot();
    await until(() => runnerImageStatus().state === 'failed', 30_000);
    expect((runnerImageStatus() as { error: string }).error).toContain('will not try again before');
    await new Promise((r) => setTimeout(r, 500));
    expect((await docker.builds()).length).toBe(after);
  }, 90_000);

  // INVARIANT: a launch-started build that failed is not re-run by the next
  // launch inside its backoff window (default image included). Every task start
  // used to repeat a build that can exhaust the guest dockerd's memory.
  test('a failed default-image build is not repeated by the next launch', async () => {
    await docker.failBuilds();
    await expect(ensureImage(docker.binPath, { useDefaultImage: true })).rejects.toThrow();
    const after = (await docker.builds()).length;
    await expect(ensureImage(docker.binPath, { useDefaultImage: true })).rejects.toThrow(/no new attempt starts before/);
    expect((await docker.builds()).length).toBe(after);
  }, 60_000);

  async function failedBootThenRestart(record: (imageName: string) => object | null) {
    await docker.failBuilds();
    await boot();
    await until(() => runnerImageStatus().state === 'failed', 30_000);
    const imageName = (runnerImageStatus() as { imageName: string }).imageName;
    const builds = (await docker.builds()).length;
    resetRunnerImageForTests();
    const rec = record(imageName);
    if (rec) await writeFile(join(root, '.lazy', 'runner-image-attempt.json'), JSON.stringify(rec));
    await boot();
    await until(() => runnerImageStatus().state === 'failed', 30_000);
    return { imageName, builds };
  }

  // INVARIANT: an attempt that never reported back (the daemon or its build host
  // died during it) counts as a failure, so the OOM-and-restart loop is bounded.
  test('an attempt that never finished defers the restarted daemon, and the build runs once the window passes', async () => {
    const { builds } = await failedBootThenRestart((imageName) => ({ imageName, failures: 0, lastAttemptAt: new Date(Date.now() - 59_000).toISOString(), inProgress: true, error: null }));
    const s = runnerImageStatus() as { error: string; retryAt?: string };
    expect(s.error).toContain('never finished');
    expect(s.retryAt).toBeDefined();
    expect((await docker.builds()).length).toBe(builds);
    await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(s.retryAt!) - Date.now()) + 200));
    await syncRunnerImageTarget();
    const deadline = Date.now() + 20_000;
    while ((await docker.builds()).length === builds && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect((await docker.builds()).length).toBeGreaterThan(builds);
  }, 90_000);

  // INVARIANT: Retry is a person asking again and ignores a stored deferral.
  test('Retry builds even inside a stored backoff window', async () => {
    const { builds } = await failedBootThenRestart((imageName) => ({ imageName, failures: 1, lastAttemptAt: new Date().toISOString(), inProgress: false, error: 'oom' }));
    expect((await docker.builds()).length).toBe(builds);
    const r = await retryRunnerImageBuild();
    expect(r.ok).toBe(true);
    const deadline = Date.now() + 20_000;
    while ((await docker.builds()).length === builds && Date.now() < deadline) await new Promise((r2) => setTimeout(r2, 100));
    expect((await docker.builds()).length).toBeGreaterThan(builds);
  }, 90_000);
});

describe('the default-image confirmation and banner', () => {
  const building: RunnerImageState = {
    state: 'building', imageName: 'lazy-custom-abc:0.1', dockerfile: 'Dockerfile.lazy',
    defaultImage: 'lazy-runner:0.1', startedAt: new Date().toISOString(), reason: null, progress: null,
  };
  const ready: RunnerImageState = {
    state: 'ready', imageName: 'lazy-custom-abc:0.1', dockerfile: 'Dockerfile.lazy',
    defaultImage: 'lazy-runner:0.1', readyAt: new Date().toISOString(),
  };

  // Like FileStorage: the write lands on the store's OWN copy and never on the
  // object the caller holds. A fake that mutated the caller's task hid the bug
  // where a confirmed launch kept its pre-confirmation snapshot.
  const persisted = new Map<string, string>();
  function fakeStorage(_task: Task): Storage {
    return {
      async updateTaskMetadata(id: string, key: string, value: string) {
        persisted.set(`${id}:${key}`, value);
      },
    } as unknown as Storage;
  }
  const mkTask = (metadata: Record<string, string> = {}): Task =>
    ({ id: 't1', status: 'blocked', metadata } as unknown as Task);

  afterEach(() => resetRunnerImageForTests());

  // INVARIANT: never silent — an unconfirmed launch is refused with the marker
  // clients match on, and records nothing.
  test('an unconfirmed launch is refused while the image is not ready', async () => {
    resetRunnerImageForTests(building);
    const task = mkTask();
    await expect(confirmRunnerImageForLaunch(fakeStorage(task), task, false)).rejects.toThrow(RUNNER_IMAGE_NOT_READY_MARKER);
    expect(task.metadata?.[RUNNER_IMAGE_CHOICE_META_KEY]).toBeUndefined();
    expect(await runnerImageHold(task)).not.toBeNull();
  });

  // INVARIANT: the confirmation is recorded on the task, so the daemon's own
  // later turns keep the image the person chose.
  test('a confirmed launch records the choice and launches on the default image', async () => {
    resetRunnerImageForTests(building);
    const task = mkTask();
    await confirmRunnerImageForLaunch(fakeStorage(task), task, true);
    expect(persisted.get(`t1:${RUNNER_IMAGE_CHOICE_META_KEY}`)).toBe('default');
    // INVARIANT: the launch that confirmed it runs on the default image — the
    // caller's snapshot carries the choice it just recorded.
    expect(task.metadata?.[RUNNER_IMAGE_CHOICE_META_KEY]).toBe('default');
    expect(launchImagePin(task)).toBe(DEFAULT_RUNNER_IMAGE_PIN);
    expect(await runnerImageHold(task)).toBeNull();
  });

  // INVARIANT: a consented per-task pin is outside all of this.
  test('a pinned task needs no confirmation', async () => {
    resetRunnerImageForTests(building);
    const task = mkTask({ custom_image: 'lazy-custom-pin:1' });
    await confirmRunnerImageForLaunch(fakeStorage(task), task, false);
    expect(launchImagePin(task)).toBe('lazy-custom-pin:1');
  });

  // INVARIANT: once the project's image is ready nothing switches by itself —
  // the banner turns into an action, and only the action clears the choice.
  test('ready image: the banner offers the switch, and only the action makes it', async () => {
    resetRunnerImageForTests(ready);
    const task = mkTask({
      [RUNNER_IMAGE_CHOICE_META_KEY]: 'default',
      [RUNNER_IMAGE_LAST_META_KEY]: JSON.stringify({ image: 'lazy-runner:0.1', kind: 'fallback', at: '' }),
    });
    expect(launchImagePin(task)).toBe(DEFAULT_RUNNER_IMAGE_PIN);
    const view = taskRunnerImageView(task, false);
    expect(view.banner?.action).toBe('use_custom_image');
    const result = await useCustomRunnerImage(fakeStorage(task), task);
    expect(result.switched).toBe(true);
    expect(launchImagePin(task)).toBeUndefined();
    expect(taskRunnerImageView(task, false).banner?.action).toBeNull();
  });

  test('switching back is refused while the project image is still not ready', async () => {
    resetRunnerImageForTests(building);
    const task = mkTask({ [RUNNER_IMAGE_CHOICE_META_KEY]: 'default' });
    await expect(useCustomRunnerImage(fakeStorage(task), task)).rejects.toThrow(/Cannot switch yet/);
  });

  // INVARIANT: a running container on the other image is never reused — the
  // switch back (or to the default) would otherwise not take effect.
  test('a container on the other image must be recreated', () => {
    const last = (kind: string) => JSON.stringify({ image: 'x', kind, at: '' });
    expect(mustRecreateForRunnerImage(mkTask({ [RUNNER_IMAGE_LAST_META_KEY]: last('fallback') }))).toBe(true);
    expect(mustRecreateForRunnerImage(mkTask({ [RUNNER_IMAGE_LAST_META_KEY]: last('fallback'), [RUNNER_IMAGE_CHOICE_META_KEY]: 'default' }))).toBe(false);
    expect(mustRecreateForRunnerImage(mkTask({ [RUNNER_IMAGE_LAST_META_KEY]: last('custom'), [RUNNER_IMAGE_CHOICE_META_KEY]: 'default' }))).toBe(true);
    expect(mustRecreateForRunnerImage(mkTask({ [RUNNER_IMAGE_LAST_META_KEY]: last('custom') }))).toBe(false);
    expect(mustRecreateForRunnerImage(mkTask())).toBe(false);
  });

  test('a finished task shows no banner', () => {
    resetRunnerImageForTests(ready);
    const t = mkTask({ [RUNNER_IMAGE_CHOICE_META_KEY]: 'default' });
    (t as { status: string }).status = 'complete';
    expect(taskRunnerImageView(t, false).banner).toBeNull();
  });

  test('a launch is classified from what it resolved, not guessed', () => {
    expect(classifyLaunchImage('default', 'lazy-runner:0.1', building)).toBe('fallback');
    expect(classifyLaunchImage('project', 'lazy-custom-abc:0.1', ready)).toBe('custom');
    expect(classifyLaunchImage('project', 'lazy-runner:0.1', { state: 'none' })).toBe('standard');
    expect(classifyLaunchImage('pinned', 'x:1', ready)).toBe('pinned');
  });

  // INVARIANT: a builder on the default image says so, and offers the restart
  // only once the project's image is ready.
  test('builder banner', () => {
    resetRunnerImageForTests(building);
    const session = { state: 'running' as const, runnerImage: { image: 'lazy-runner:0.1', kind: 'fallback' as const } };
    expect(builderRunnerImageBanner(session)?.action).toBeNull();
    resetRunnerImageForTests(ready);
    expect(builderRunnerImageBanner(session)?.action).toBe('restart_builder');
    expect(builderRunnerImageBanner({ state: 'running', runnerImage: { image: 'x', kind: 'custom' } })).toBeNull();
  });
});
