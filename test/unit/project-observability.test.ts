/**
 * What the project's machine is doing, as the daemon answers it
 * (docs/design/project-observability.md): the image build as a watchable,
 * cancellable job with a step-by-step log (src/daemon/image-build-job.ts), the
 * ONE image state (src/daemon/image-state.ts), Rebuild and Cancel
 * (src/daemon/runner-image.ts, src/daemon/image-adoption.ts), the machine's
 * services (src/daemon/machine-observation.ts), and the redaction every
 * admin-visible byte goes through (src/daemon/observability-redaction.ts).
 *
 * Nothing in src/capture/claude.ts is mocked — only the container runtime
 * (the fake docker) and, for the machine, the guest's paths.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, realpath, mkdir, appendFile, chmod, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { pinConfig } from '../helpers/pin-config';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { runGit } from '../../src/utils/git';
import { IMAGE_TAG, resetUpgradeImageBuild, calculateImageInputsHash, calculateImageInputManifest } from '../../src/capture/claude';
import { ImageBuildJob, resetImageBuildJobsForTests, findImageBuildJob, listImageBuildJobs } from '../../src/daemon/image-build-job';
import { customImageGate } from '../../src/capture/custom-image-gate';
import {
  startRunnerImageBoot, runnerImageStatus, resetRunnerImageForTests, rebuildRunnerImage, cancelRunnerImageBuild, customImageReady,
} from '../../src/daemon/runner-image';
import {
  startImageAdoption, previewImageAdoption, adoptionBuildStatus, cancelImageAdoption, dismissImageAdoptionFailure,
  resetImageAdoptionForTests,
} from '../../src/daemon/image-adoption';
import { projectImageState, PROJECT_IMAGE_STATES } from '../../src/daemon/image-state';
import { observeMachine, restartMachineService, resetMachineRestartForTests, GUEST_PATHS, MachineRestartError, MACHINE_SERVICES } from '../../src/daemon/machine-observation';
import { daemonRedactor, redactAnswer, REDACTION_UNAVAILABLE, STRUCTURAL_FIELDS } from '../../src/daemon/observability-redaction';
import { putUserCredential, clearUserCredentialCache } from '../../src/daemon/user-credentials';
import { mintCredentialGrant, clearCredentialGrantCache } from '../../src/proxy/credential-broker';
import { getLogPath, getUserCredentialsPath } from '../../src/daemon/paths';
import { handleImageBuildLog, handleMachineState, handleMachineRestartPreview, handleRestartMachineService, handleRunnerImage, handleShow, initDaemonStorage, getOrCreateStorage, closeAllStorage } from '../../src/daemon/rpc-handlers';
import { REDACTED } from '../../src/utils/redact';
import { startForeignProcess } from '../helpers/foreign-process';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import type { Storage } from '../../src/storage';

/** Every guest path redirected into `dir`. */
function guestPaths(dir: string): typeof GUEST_PATHS {
  return {
    dockerdLog: join(dir, 'lazy-dockerd.log'), dockerdPid: join(dir, 'lazy-dockerd.pid'),
    dockerdHistory: join(dir, 'lazy-dockerd-restarts.log'), dockerdExit: join(dir, 'lazy-dockerd.exit'),
    dockerdRestarts: join(dir, 'lazy-dockerd.restarts'), dockerdGaveUp: join(dir, 'lazy-dockerd.gave-up'),
    dockerdUnresponsiveSince: join(dir, 'lazy-dockerd.unresponsive-since'),
    dockerdRestartRequested: join(dir, 'lazy-dockerd.restart-requested'),
    forwarderLog: join(dir, 'lazy-forwarder.log'), forwarderPid: join(dir, 'lazy-guest-forwarder.pid'), storageRoot: dir,
  };
}

const noTasks = { resolveTask: async () => ({ task: null }) } as unknown as Storage;

/** A real credential as the control plane pushes one, and a placeholder lazy mints. */
const REAL_SECRET = 'sk-ant-oat01-REALmemberSECRETvalue0123456789abcdefABCDEF';
const NON_ANTHROPIC_SECRET = 'ghp_seededForgeTokenValue0123456789abcdefXYZ';

async function until(pred: () => boolean | Promise<boolean>, ms = 20_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; image state ${JSON.stringify(runnerImageStatus())}, adoption ${JSON.stringify(adoptionBuildStatus())}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function git(cwd: string, ...args: string[]) {
  const r = await runGit(args, { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const BUILDKIT = [
  '#0 building with "default" instance using docker driver',
  '#1 [internal] load build definition from Dockerfile.lazy',
  '#1 DONE 0.0s',
  '#4 [1/3] FROM docker.io/library/alpine:3.20',
  '#4 CACHED',
  '#5 [2/3] RUN apt-get update',
  '#5 0.512 Get:1 http://deb.debian.org bookworm InRelease',
  '#5 DONE 12.3s',
  '#6 [3/3] RUN make tools',
  '#6 0.100 compiling',
].join('\n');

// ---------------------------------------------------------------------------

describe('an image build job', () => {
  beforeEach(() => resetImageBuildJobsForTests());

  // INVARIANT: steps, their timing and step N of M come from the build's own
  // output — BuildKit's `#N [n/m]` headers and DONE/CACHED/ERROR lines.
  test('BuildKit plain progress becomes steps with timing and step N of M', () => {
    const job = new ImageBuildJob('project', 'Build x');
    const obs = job.observer();
    obs.onBuildStart!('img:1', 'Dockerfile.lazy');
    for (const line of BUILDKIT.split('\n')) obs.onLine('img:1', line);
    const steps = job.view().steps;
    expect(steps.map((s) => [s.label, s.status])).toEqual([
      ['[1/3] FROM docker.io/library/alpine:3.20', 'cached'],
      ['[2/3] RUN apt-get update', 'done'],
      ['[3/3] RUN make tools', 'running'],
    ]);
    expect(steps[1].durationMs).toBe(12300);
    expect(job.progress()).toEqual({ step: 3, total: 3, label: '[3/3] RUN make tools' });
  });

  test('a failing step is named, with its own output, not BuildKit boilerplate', () => {
    const job = new ImageBuildJob('project', 'Build x');
    const obs = job.observer();
    for (const line of [...BUILDKIT.split('\n'), '#6 0.200 make: *** no rule', '#6 ERROR: process "/bin/sh -c make tools" did not complete successfully: exit code: 2', '------', ' > [3/3] RUN make tools:'])
      obs.onLine('img:1', line);
    obs.onBuildEnd!('img:1', 'failed');
    job.finish('failed', 'Container build failed with exit code 1');
    expect(job.failure?.stepLabel).toBe('[3/3] RUN make tools');
    expect(job.failure?.output).toContain('make: *** no rule');
    expect(job.failure?.output).not.toContain('apt-get');
  });

  test('the classic builder\'s Step n/m lines are steps too, and the one it stopped on failed', () => {
    const job = new ImageBuildJob('project', 'Build x');
    const obs = job.observer();
    for (const line of ['Step 1/2 : FROM alpine', ' ---> abc', 'Step 2/2 : RUN false']) obs.onLine('img:1', line);
    obs.onBuildEnd!('img:1', 'failed');
    expect(job.view().steps.map((s) => s.status)).toEqual(['done', 'failed']);
    expect(job.progress().total).toBe(2);
  });

  // INVARIANT: the log is read by cursor — a reader asks for "after seq N" and
  // never re-reads or misses a line.
  test('lines are read by cursor, and a long poll wakes on the next line', async () => {
    const job = new ImageBuildJob('project', 'Build x');
    job.note('one');
    job.note('two');
    const first = job.read(0, 10);
    expect(first.lines.map((l) => l.text)).toEqual(['one', 'two']);
    const waiting = job.waitForLines(first.lastSeq, 5_000);
    setTimeout(() => job.note('three'), 50);
    const started = Date.now();
    await waiting;
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(job.read(first.lastSeq, 10).lines.map((l) => l.text)).toEqual(['three']);
  });

  // INVARIANT: the log is bounded by construction (telemetry, not storage state).
  test('the log is bounded; the oldest lines go first and the reader is told', () => {
    const job = new ImageBuildJob('project', 'Build x');
    for (let i = 0; i < 6000; i++) job.note(`line ${i}`);
    const page = job.read(0, 10);
    expect(page.truncatedBefore).toBe(true);
    expect(page.lines[0].text).not.toBe('line 0');
    expect(page.lastSeq).toBe(6000);
  });

  test('lazy steps are planned up front and counted in the total', () => {
    const job = new ImageBuildJob('adoption', 'Adopt');
    job.planStep('export', 'Export');
    job.planStep('verify', 'Verify');
    job.beginStep('export', 'Export');
    expect(job.progress()).toEqual({ step: 1, total: 2, label: 'Export' });
    job.endStep('export', 'done');
    job.beginStep('verify', 'Verify');
    expect(job.progress().step).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe('Rebuild and Cancel of the project image', () => {
  let root: string;
  let cwd: string;
  let docker: FakeDocker;
  let undoBase: (() => void) | undefined;
  let undoConfig: (() => void) | undefined;

  beforeEach(async () => {
    resetImageBuildJobsForTests();
    undoBase = pinDaemonBaseDir(await mkdtemp(join(tmpdir(), 'lazy-obs-base-')));
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-obs-root-')));
    Bun.spawnSync(['git', 'init', '-q', root]);
    cwd = process.cwd();
    process.chdir(root);
    await writeFile(join(root, 'Dockerfile.lazy'), `FROM lazy-runner:${IMAGE_TAG}\nRUN true\n`);
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = "Dockerfile.lazy"\n');
    undoConfig = pinConfig(root);
    docker = await installFakeDocker(root);
    // lazy's base image is already current here, so the build under test is
    // the project's own — never the base-first step's.
    await docker.seedImage(`lazy-runner:${IMAGE_TAG}`, {
      dockerfileHash: await calculateImageInputsHash(root, true),
      inputs: await calculateImageInputManifest(root, true),
    });
  });

  afterEach(async () => {
    process.chdir(cwd);
    resetRunnerImageForTests();
    await resetImageAdoptionForTests();
    undoConfig?.();
    undoBase?.();
    resetUpgradeImageBuild();
    await rm(root, { recursive: true, force: true });
  });

  const boot = () => startRunnerImageBoot(root, { isContainerRunner: async () => ({ binary: docker.binPath }) });

  // INVARIANT: Cancel really stops the docker build — the client process is
  // killed — and the state settles at once instead of waiting for it.
  test('Cancel kills the running docker build and says the build was cancelled', async () => {
    await docker.buildOutput(BUILDKIT);
    await docker.slowBuilds(30);
    await boot();
    await until(async () => (await docker.buildPid()) !== null && runnerImageStatus().state === 'building', 20_000, 'the build to start');
    const pid = (await docker.buildPid())!;
    expect(pidAlive(pid)).toBe(true);
    const s = cancelRunnerImageBuild();
    expect(s?.state).toBe('failed');
    await until(() => !pidAlive(pid), 5_000, 'the docker client to die');
    const state = await projectImageState(root);
    expect(state.state).toBe('failed');
    if (state.state !== 'failed') throw new Error('unreachable');
    expect(state.cancelled).toBe(true);
    expect(state.escalation.to).toBe('admin');
    expect(state.escalation.actions).toContain('rebuild');
    // The job records it, and its log shows the build's own lines.
    const job = findImageBuildJob(state.build!.id)!;
    expect(job.outcome).toBe('cancelled');
    expect(job.read(0, 100).lines.some((l) => l.text.includes('RUN apt-get update'))).toBe(true);
    // Nothing settles it back: the build's later death does not overwrite the state.
    await Bun.sleep(300);
    expect(runnerImageStatus().state).toBe('failed');
  }, 60_000);

  // INVARIANT: a Rebuild of a READY image replaces it — launches keep the
  // current image throughout, and a Cancel puts it back to ready.
  test('a Rebuild of a ready image keeps it usable, and Cancel leaves it ready', async () => {
    await boot();
    await until(() => runnerImageStatus().state === 'ready', 30_000, 'ready');
    const buildsBefore = (await docker.builds()).length;
    await docker.slowBuilds(30);
    const r = await rebuildRunnerImage();
    expect(r.ok).toBe(true);
    expect(runnerImageStatus().state).toBe('building');
    expect(customImageReady()).toBe(true);
    const state = await projectImageState(root);
    expect(state.state).toBe('building');
    if (state.state === 'building') expect(state.currentImageInUse).toBe(true);
    await until(async () => (await docker.builds()).length > buildsBefore, 20_000, 'the rebuild to reach docker');
    // A second Rebuild while this one runs is refused — one build at a time.
    expect((await rebuildRunnerImage()).ok).toBe(false);
    cancelRunnerImageBuild();
    expect(runnerImageStatus().state).toBe('ready');
    expect(customImageReady()).toBe(true);
  }, 60_000);

  test('a failed build names the failing step and its output, and it is the admin\'s to fix', async () => {
    await docker.buildOutput([...BUILDKIT.split('\n'), '#6 0.300 make: *** No rule to make target', '#6 ERROR: process "/bin/sh -c make tools" did not complete successfully: exit code: 2'].join('\n'));
    await docker.failBuilds();
    await boot();
    await until(() => runnerImageStatus().state === 'failed', 30_000, 'failed');
    const state = await projectImageState(root);
    if (state.state !== 'failed') throw new Error(`expected failed, got ${state.state}`);
    expect(state.failure.step).toBe('[3/3] RUN make tools');
    expect(state.failure.output).toContain('No rule to make target');
    expect(state.escalation.to).toBe('admin');
    expect(state.escalation.actions).toEqual(['rebuild', 'adopt', 'create_fix_task']);
  }, 60_000);

  test('a runtime that cannot run builds is the maintainer\'s', async () => {
    await docker.buildOutput('ERROR: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
    await docker.failBuilds();
    await boot();
    await until(() => runnerImageStatus().state === 'failed', 30_000, 'failed');
    const state = await projectImageState(root);
    if (state.state !== 'failed') throw new Error('expected failed');
    expect(state.escalation.to).toBe('maintainer');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe('Rebuild of lazy\'s default image', () => {
  let root: string;
  let cwd: string;
  let docker: FakeDocker;
  let undoBase: (() => void) | undefined;
  let undoConfig: (() => void) | undefined;

  beforeEach(async () => {
    resetImageBuildJobsForTests();
    undoBase = pinDaemonBaseDir(await mkdtemp(join(tmpdir(), 'lazy-obs-base-')));
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-obs-default-')));
    Bun.spawnSync(['git', 'init', '-q', root]);
    cwd = process.cwd();
    process.chdir(root);
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n');
    undoConfig = pinConfig(root);
    docker = await installFakeDocker(root);
  });

  afterEach(async () => {
    process.chdir(cwd);
    resetRunnerImageForTests();
    undoConfig?.();
    undoBase?.();
    resetUpgradeImageBuild();
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: an admin's Rebuild of the default image racing a damaged-image
  // repair starts ONE build, and the repair waits for it. The running-build
  // check sat before an await, so both passed it and started two builds.
  test('a Rebuild racing a damaged-image repair starts one build, which the repair waits for', async () => {
    await startRunnerImageBoot(root, { isContainerRunner: async () => ({ binary: docker.binPath }) });
    await docker.slowBuilds(30);
    const rebuilt = rebuildRunnerImage();
    // Two callers of the repair (launches through different runtimes are not
    // single-flighted together) reach the check in the same tick.
    const repair = () => customImageGate()!.repair!(`lazy-runner:${IMAGE_TAG}`).then(() => 'done', (e: Error) => e.message);
    const repaired = repair();
    const repairedToo = repair();
    // Whichever starts the build, the other is refused (the Rebuild) or waits (the repair).
    await rebuilt;
    await until(() => listImageBuildJobs().length > 0, 10_000, 'a build job');
    await Bun.sleep(300);
    expect(listImageBuildJobs().filter((j) => j.outcome === 'running').length).toBe(1);
    cancelRunnerImageBuild();
    for (const j of listImageBuildJobs()) if (j.outcome === 'running') j.controller.abort();
    // The repair waited on the one build rather than being refused by it.
    expect(await repaired).toContain('cancelled');
    expect(await repairedToo).toContain('cancelled');
  }, 60_000);
});


describe('the one image state, around an adoption', () => {
  let base: string;
  let root: string;
  let docker: FakeDocker;
  let undoBase: (() => void) | undefined;
  let undoConfig: (() => void) | undefined;
  let fixCommit: string;
  let cwd: string;

  beforeEach(async () => {
    resetImageBuildJobsForTests();
    await resetImageAdoptionForTests();
    base = await realpath(await mkdtemp(join(tmpdir(), 'lazy-obs-adopt-')));
    undoBase = pinDaemonBaseDir(join(base, 'daemon'));
    docker = await installFakeDocker(base);
    root = join(base, 'repo');
    await mkdir(root);
    await git(root, 'init', '-q', '-b', 'main');
    await git(root, 'config', 'user.email', 't@example.com');
    await git(root, 'config', 'user.name', 'T');
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = ""\n');
    await writeFile(join(root, 'Dockerfile.lazy'), 'FROM alpine:3.20\nRUN exit 1\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'broken image');
    await git(root, 'checkout', '-q', '-b', 'fix-image');
    await writeFile(join(root, 'Dockerfile.lazy'), 'FROM alpine:3.20\nRUN true\n');
    await git(root, 'commit', '-q', '-am', 'working image');
    fixCommit = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', 'main');
    undoConfig = pinConfig(root);
    // Image resolution reads the lazy root from the working directory.
    cwd = process.cwd();
    process.chdir(root);
  });

  afterEach(async () => {
    process.chdir(cwd);
    resetRunnerImageForTests();
    await resetImageAdoptionForTests();
    undoConfig?.();
    undoBase?.();
    await rm(base, { recursive: true, force: true });
  });

  async function adopt() {
    const preview = await previewImageAdoption(root, noTasks, 'fix-image');
    return startImageAdoption(root, noTasks, {
      ref: 'fix-image', commit: fixCommit, contentHash: preview.candidate.contentHash,
      adoptedBy: { email: 'admin@example.com', name: 'Admin' },
    }, { resolveBinary: async () => docker.binPath });
  }

  // INVARIANT (engineer, 2026-10-03): exactly one state — an adoption in
  // progress hides the failed project image it is replacing, and the export
  // and verify are steps of its build, not part of the request.
  test('a failed project image and an adoption in progress read as the adoption only', async () => {
    await docker.failBuilds();
    await startRunnerImageBoot(root, { isContainerRunner: async () => ({ binary: docker.binPath }) });
    await until(() => runnerImageStatus().state === 'failed', 30_000, 'failed');
    expect((await projectImageState(root)).state).toBe('failed');

    await rm(join(docker.stateDir, 'fail-build'));
    await docker.slowBuilds(30);
    const started = await adopt();
    expect(started.state).toBe('building');
    const state = await projectImageState(root);
    expect(state.state).toBe('adoption_in_progress');
    expect(PROJECT_IMAGE_STATES).toContain(state.state);
    await until(() => adoptionBuildStatus().state === 'building' && (adoptionBuildStatus() as { phase: string }).phase === 'building', 20_000, 'the build phase');
    const job = findImageBuildJob((state as { build: { id: string } }).build.id)!;
    expect(job.view().steps.slice(0, 2).map((s) => [s.id, s.status])).toEqual([['export', 'done'], ['verify', 'done']]);

    // Cancel: the docker build dies, the project keeps what it had, and the
    // state is the failed project image again — never both.
    await until(async () => (await docker.buildPid()) !== null, 10_000, 'the adoption build to start');
    const pid = (await docker.buildPid())!;
    cancelImageAdoption();
    await until(() => !pidAlive(pid), 5_000, 'the adoption build to die');
    expect(adoptionBuildStatus().state).toBe('none');
    expect((await projectImageState(root)).state).toBe('failed');
    expect(job.outcome).toBe('cancelled');
  }, 90_000);

  // INVARIANT: a Cancel that lands while the adoption's request is still
  // being checked releases the slot for good — the request is refused, no
  // export or build starts, and the state does not spring back to "building".
  test('a Cancel during the request\'s checks stops the adoption before it starts', async () => {
    const preview = await previewImageAdoption(root, noTasks, 'fix-image');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const pending = startImageAdoption(root, noTasks, {
      ref: 'fix-image', commit: fixCommit, contentHash: preview.candidate.contentHash,
      adoptedBy: { email: 'admin@example.com', name: 'Admin' },
    }, { resolveBinary: async () => { await held; return docker.binPath; } });
    await until(() => adoptionBuildStatus().state === 'building', 5_000, 'the slot to be reserved');
    cancelImageAdoption();
    release();
    await expect(pending).rejects.toThrow(/cancelled before it started/);
    expect(adoptionBuildStatus().state).toBe('none');
    await Bun.sleep(300);
    expect(adoptionBuildStatus().state).toBe('none');
    expect((await docker.builds()).length).toBe(0);
  }, 30_000);

  // INVARIANT: the ways out offered are ones this install can take — no
  // "adopt" where adoptImageFromRef refuses (a dockerd shared with others).
  test('a shared-dockerd install is never offered an adoption', async () => {
    resetRunnerImageForTests({
      state: 'failed', imageName: 'lazy-custom-x:1', dockerfile: 'Dockerfile.lazy', defaultImage: `lazy-runner:${IMAGE_TAG}`,
      failedAt: new Date().toISOString(), error: 'Container build failed with exit code 1', buildId: null,
    });
    const before = await projectImageState(root);
    if (before.state !== 'failed') throw new Error('expected failed');
    expect(before.escalation.actions).toContain('adopt');
    const saved = { m: process.env.LAZY_MANAGED, b: process.env.LAZY_MANAGED_BACKEND };
    process.env.LAZY_MANAGED = '1';
    process.env.LAZY_MANAGED_BACKEND = 'local-docker';
    try {
      const shared = await projectImageState(root);
      if (shared.state !== 'failed') throw new Error('expected failed');
      expect(shared.escalation.actions).not.toContain('adopt');
      expect(shared.escalation.actions).toContain('rebuild');
    } finally {
      if (saved.m === undefined) delete process.env.LAZY_MANAGED; else process.env.LAZY_MANAGED = saved.m;
      if (saved.b === undefined) delete process.env.LAZY_MANAGED_BACKEND; else process.env.LAZY_MANAGED_BACKEND = saved.b;
    }
  });

  test('a failed adoption is its own state until it is put away', async () => {
    await docker.failBuilds();
    await adopt();
    await until(() => adoptionBuildStatus().state === 'failed', 30_000, 'the adoption to fail');
    const state = await projectImageState(root);
    if (state.state !== 'adoption_failed') throw new Error(`expected adoption_failed, got ${state.state}`);
    expect(state.adoption.failedStep).toBe('build');
    expect(state.escalation.actions).toContain('dismiss');
    expect(dismissImageAdoptionFailure()).toBe(true);
    expect((await projectImageState(root)).state).not.toBe('adoption_failed');
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe('redaction of everything an admin reads', () => {
  let root: string;
  let undoBase: (() => void) | undefined;
  let placeholder: string;
  let guest: string;

  beforeEach(async () => {
    resetImageBuildJobsForTests();
    resetMachineRestartForTests();
    clearUserCredentialCache();
    clearCredentialGrantCache();
    undoBase = pinDaemonBaseDir(await mkdtemp(join(tmpdir(), 'lazy-obs-red-')));
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-obs-red-root-')));
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n');
    // A REAL credential the daemon holds (pushed by the control plane) and a
    // PLACEHOLDER it minted for a task container — the two kinds of secret
    // the engineer named.
    await putUserCredential(root, { userId: 'member@example.com', kind: 'oauth', token: REAL_SECRET });
    await putUserCredential(root, { userId: 'other@example.com', kind: 'api-key', token: NON_ANTHROPIC_SECRET });
    placeholder = await mintCredentialGrant(root, { role: 'agent', taskId: 't1', label: 'c1', envKey: 'CLAUDE_CODE_OAUTH_TOKEN' });
    guest = await mkdtemp(join(tmpdir(), 'lazy-obs-guest-'));
  });

  afterEach(async () => {
    undoBase?.();
    clearUserCredentialCache();
    clearCredentialGrantCache();
    resetRunnerImageForTests();
    await rm(root, { recursive: true, force: true });
    await rm(guest, { recursive: true, force: true });
  });

  const leaky = () => `curl -H "x-api-key: ${REAL_SECRET}" -H "Authorization: Bearer ${placeholder}" -H "X-Forge: ${NON_ANTHROPIC_SECRET}"`;

  function expectClean(text: string) {
    expect(text).not.toContain(REAL_SECRET);
    expect(text).not.toContain(placeholder);
    expect(text).not.toContain(NON_ANTHROPIC_SECRET);
    expect(text).toContain(REDACTED);
  }

  // INVARIANT: no admin-visible path lets a held secret or a placeholder out —
  // the live build log, a failed build's output, and every service log.
  test('the live build log', async () => {
    const job = (await import('../../src/daemon/image-build-job')).startImageBuildJob('project', 'Build', root);
    const obs = job.observer();
    obs.onLine('img:1', `#5 [2/3] RUN ${leaky()}`);
    const answer = await redactAnswer(root, { build: job.view(), ...job.read(0, 100) });
    expectClean(JSON.stringify(answer));
    // Through the RPC handler, as Rails reads it.
    const viaRpc = await handleImageBuildLog(root, { buildId: job.id }, { kind: 'control' });
    expectClean(JSON.stringify(viaRpc));
  });

  test('a failed build\'s output, through the runnerImage answer every surface reads', async () => {
    const job = (await import('../../src/daemon/image-build-job')).startImageBuildJob('project', 'Build', root);
    const obs = job.observer();
    obs.onLine('img:1', '#6 [3/3] RUN deploy');
    obs.onLine('img:1', `#6 0.1 ${leaky()}`);
    obs.onLine('img:1', '#6 ERROR: process did not complete successfully: exit code: 1');
    job.finish('failed', `Container build failed\nLast output:\n${leaky()}`);
    resetRunnerImageForTests({
      state: 'failed', imageName: 'lazy-custom-x:1', dockerfile: 'Dockerfile.lazy', defaultImage: `lazy-runner:${IMAGE_TAG}`,
      failedAt: new Date().toISOString(), error: `Container build failed\nLast output:\n${leaky()}`, buildId: null,
    });
    const answer = await handleRunnerImage({}, root);
    const text = JSON.stringify(answer);
    expectClean(text);
    expect((answer as { imageState: { state: string } }).imageState.state).toBe('failed');
    expectClean(JSON.stringify(await redactAnswer(root, job.view())));
  });

  // INVARIANT: the task page's copy of the runner image (`show`) goes through
  // the same redactor as `runnerImage` — it carries the same failure text.
  test('a failed build\'s output, through the task record\'s runnerImage', async () => {
    resetRunnerImageForTests({
      state: 'failed', imageName: 'lazy-custom-x:1', dockerfile: 'Dockerfile.lazy', defaultImage: `lazy-runner:${IMAGE_TAG}`,
      failedAt: new Date().toISOString(), error: `Container build failed\nLast output:\n${leaky()}`, buildId: null,
    });
    await writeFile(join(root, 'lazy.toml'), `[project]\nname = "t"\n[storage]\nbackend = "external"\nexternal_path = "${join(root, 'store')}"\n`);
    const undo = pinConfig(root);
    try {
      initDaemonStorage(root);
      const task = await (await getOrCreateStorage()).createTask('Show the image');
      const answer = (await handleShow(root, { taskId: task.id })) as { runnerImage: unknown };
      expectClean(JSON.stringify(answer.runnerImage));
    } finally {
      await closeAllStorage();
      undo();
    }
  });

  test('every service log', async () => {
    const paths = guestPaths(guest);
    await writeFile(paths.dockerdLog, `time="x" level=info msg="pull" auth="${leaky()}"\n`);
    // The restart history quotes dockerd's log tail when it records a death —
    // exactly where a credential a build echoed resurfaces.
    await writeFile(paths.dockerdHistory, [
      '=== 2026-10-03T14:02:11Z dockerd (pid 812) stopped answering (cause=exited-137, exit_status=137)',
      `--- last lines of /var/log/lazy-dockerd.log:`,
      `time="x" level=error msg="push failed" auth="${leaky()}"`,
      '=== 2026-10-03T14:02:13Z restarting dockerd (restart 1 of 3 allowed in 900s)',
    ].join('\n') + '\n');
    await writeFile(paths.forwarderLog, `socat: ${leaky()}\n`);
    await mkdir(join(getLogPath(root), '..'), { recursive: true });
    await appendFile(getLogPath(root), `[2026-10-03] [proxy] seq=1 ${leaky()}\n`);
    const saved = { m: process.env.LAZY_MANAGED, b: process.env.LAZY_MANAGED_BACKEND };
    process.env.LAZY_MANAGED = '1';
    process.env.LAZY_MANAGED_BACKEND = 'microvm';
    try {
      const view = await observeMachine(root, { lines: 50 }, {
        paths, guestInit: () => '/usr/local/bin/lazy-guest-init', dockerBinary: async () => null, proxy: async () => null,
      });
      const byName = Object.fromEntries(view.services.map((s) => [s.name, s]));
      // Raw: the secrets ARE in the logs (the fixture is real).
      expect(byName.forwarder.log.lines.join('\n')).toContain(REAL_SECRET);
      expect(byName.dockerd.history!.lines.join('\n')).toContain(REAL_SECRET);
      expect(byName.dockerd.history!.lines.join('\n')).toContain(placeholder);
      const clean = await redactAnswer(root, view);
      for (const s of clean.services) {
        if (s.log.available) expectClean(s.log.lines.join('\n'));
      }
      const history = clean.services.find((s) => s.name === 'dockerd')!.history!;
      expect(history.available).toBe(true);
      expectClean(history.lines.join('\n'));
      expect(history.lines.join('\n')).toContain('cause=exited-137');
      expect(clean.services.find((s) => s.name === 'proxy')!.log.lines.length).toBe(1);
    } finally {
      if (saved.m === undefined) delete process.env.LAZY_MANAGED; else process.env.LAZY_MANAGED = saved.m;
      if (saved.b === undefined) delete process.env.LAZY_MANAGED_BACKEND; else process.env.LAZY_MANAGED_BACKEND = saved.b;
    }
    // And through the RPC handler (the daemon's own log reaches it on any machine).
    expect(JSON.stringify(await handleMachineState(root, { lines: 50 }, { kind: 'control' }))).not.toContain(REAL_SECRET);
  });

  // INVARIANT: a placeholder that is no longer in the registry is still
  // recognised — by lazy's own placeholder format, not a guess.
  test('a revoked placeholder is still scrubbed by its format', async () => {
    const revoked = `sk-ant-oat01-lazy-${'ab'.repeat(24)}`;
    const session = `lazy-sess-${'cd'.repeat(32)}`;
    const r = await daemonRedactor(root);
    expect(r.redact(`a ${revoked} b ${session} c`)).toBe(`a ${REDACTED} b ${REDACTED} c`);
  });

  // INVARIANT: an incomplete redactor never destroys the log at ingest — it
  // withholds on READ (redactAnswer), so the log is intact once the store is.
  test('an incomplete redactor withholds on read, never destroys the log', async () => {
    clearUserCredentialCache();
    await writeFile(getUserCredentialsPath(root), '{ not json');
    const job = new ImageBuildJob('project', 'Build');
    job.redactor = await daemonRedactor(root);
    expect(job.redactor.complete).toBe(false);
    job.observer().onLine('img:1', '#5 [2/3] RUN make tools');
    expect(job.read(0, 10).lines[0].text).toBe('#5 [2/3] RUN make tools');
    expect(JSON.stringify(await redactAnswer(root, job.read(0, 10)))).toContain(REDACTION_UNAVAILABLE);
  });

  // INVARIANT: a restart preview must identify the work it authorizes stopping.
  // Withheld IDs could make different running containers appear identical.
  test('an unreadable secret registry refuses a confirmable restart preview', async () => {
    clearUserCredentialCache();
    await writeFile(getUserCredentialsPath(root), '{ not json');
    const saved = { managed: process.env.LAZY_MANAGED, backend: process.env.LAZY_MANAGED_BACKEND };
    process.env.LAZY_MANAGED = '1';
    process.env.LAZY_MANAGED_BACKEND = 'microvm';
    try {
      await expect(handleMachineRestartPreview(root, { kind: 'control' })).rejects.toThrow('Cannot safely show running work');
    } finally {
      if (saved.managed === undefined) delete process.env.LAZY_MANAGED; else process.env.LAZY_MANAGED = saved.managed;
      if (saved.backend === undefined) delete process.env.LAZY_MANAGED_BACKEND; else process.env.LAZY_MANAGED_BACKEND = saved.backend;
    }
  });

  // INVARIANT: if the secret set cannot be loaded, EVERY string is WITHHELD,
  // never shown unredacted — a single word included, because a bare
  // credential has no whitespace. The answer's structure survives only
  // through the fields the schemas NAME as structural, each with its exact
  // shape (STRUCTURAL_FIELDS); never through a heuristic on the value.
  test('an unreadable credential store withholds free text', async () => {
    clearUserCredentialCache();
    await writeFile(getUserCredentialsPath(root), '{ not json');
    const r = await daemonRedactor(root);
    expect(r.complete).toBe(false);
    expect(r.redact(`a log line with ${NON_ANTHROPIC_SECRET}`)).toBe(REDACTION_UNAVAILABLE);
    expect(r.redact('building')).toBe(REDACTION_UNAVAILABLE);
    const answer = await redactAnswer(root, { state: 'building', build: { outcome: 'running', startedAt: '2026-10-04T10:00:00.000Z' } });
    expect(answer).toEqual({ state: 'building', build: { outcome: 'running', startedAt: '2026-10-04T10:00:00.000Z' } });
  });

  // INVARIANT (live review, 2026-10-04): with the registry unreadable, a log
  // line that is ONLY a whitespace-free secret — one array element per line,
  // as a service log or a build log is answered — is withheld, bare or as
  // `token=<secret>`. A whitespace rule let both through to the Machine page.
  test('an unreadable credential store withholds a bare-token log line and token=<secret>', async () => {
    clearUserCredentialCache();
    await writeFile(getUserCredentialsPath(root), '{ not json');
    const lines = [NON_ANTHROPIC_SECRET, `token=${NON_ANTHROPIC_SECRET}`, 'Authorization:Bearer-abc123def456ghi789'];
    const answer = await redactAnswer(root, {
      services: [{ name: 'dockerd', state: 'running', log: { available: true, source: 'docker', lines, truncated: false } }],
      lines: lines.map((text, seq) => ({ seq, at: '2026-10-04T10:00:00Z', source: 'docker', image: 'lazy-runner:0.91', text })),
    });
    const json = JSON.stringify(answer);
    expect(json).not.toContain(NON_ANTHROPIC_SECRET);
    expect(json).not.toContain('abc123def456');
    expect(answer.services[0]!.log.lines).toEqual(lines.map(() => REDACTION_UNAVAILABLE));
    expect(answer.lines.map((l) => l.text)).toEqual(lines.map(() => REDACTION_UNAVAILABLE));
    // The structure the page renders from is intact.
    expect(answer.services[0]!.name).toBe('dockerd');
    expect(answer.services[0]!.state).toBe('running');
    expect(answer.lines[0]!.image).toBe('lazy-runner:0.91');
    // A secret under a STRUCTURAL field name that lacks the field's shape is
    // withheld too: the name alone never lets a value through.
    const sneaky = await redactAnswer(root, { state: NON_ANTHROPIC_SECRET, at: `token=${NON_ANTHROPIC_SECRET}` });
    expect(sneaky).toEqual({ state: REDACTION_UNAVAILABLE, at: REDACTION_UNAVAILABLE });
  });

  // INVARIANT: the structural table covers every image state and machine
  // service the surfaces render, so a fail-closed answer still names them.
  // A NEW state missing here fails closed (withheld) — this test is what says so.
  test('the structural fields cover every image state and machine service', () => {
    for (const state of PROJECT_IMAGE_STATES) expect(STRUCTURAL_FIELDS.state!(state)).toBe(true);
    for (const service of MACHINE_SERVICES) expect(STRUCTURAL_FIELDS.name!(service)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('the machine\'s services', () => {
  let dir: string;
  let undoBase: (() => void) | undefined;
  let root: string;
  let sleeper: ReturnType<typeof Bun.spawn> | null = null;
  let stopForeign: (() => void) | null = null;
  const saved = { m: process.env.LAZY_MANAGED, b: process.env.LAZY_MANAGED_BACKEND };

  beforeEach(async () => {
    resetMachineRestartForTests();
    undoBase = pinDaemonBaseDir(await mkdtemp(join(tmpdir(), 'lazy-obs-mach-')));
    dir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-obs-guest-')));
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-obs-mach-root-')));
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n');
    process.env.LAZY_MANAGED = '1';
    process.env.LAZY_MANAGED_BACKEND = 'microvm';
  });

  afterEach(async () => {
    sleeper?.kill();
    sleeper = null;
    stopForeign?.();
    stopForeign = null;
    if (saved.m === undefined) delete process.env.LAZY_MANAGED; else process.env.LAZY_MANAGED = saved.m;
    if (saved.b === undefined) delete process.env.LAZY_MANAGED_BACKEND; else process.env.LAZY_MANAGED_BACKEND = saved.b;
    undoBase?.();
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  function paths() {
    return guestPaths(dir);
  }

  test('services, their state and resources against the machine', async () => {
    const socat = await startForeignProcess(dir, 'socat');
    stopForeign = socat.kill;
    await writeFile(paths().forwarderPid, String(socat.pid));
    await writeFile(paths().dockerdLog, 'dockerd line 1\ndockerd line 2\n');
    const view = await observeMachine(root, { lines: 1 }, {
      paths: paths(), guestInit: () => '/x/lazy-guest-init', dockerBinary: async () => null, proxy: async () => null,
    });
    expect(view.kind).toBe('microvm');
    const byName = Object.fromEntries(view.services.map((s) => [s.name, s]));
    expect(Object.keys(byName)).toEqual(['dockerd', 'forwarder', 'daemon', 'proxy']);
    expect(byName.forwarder.state).toBe('running');
    expect(byName.forwarder.restart).toBe('guest');
    expect(byName.daemon.state).toBe('running');
    expect(byName.daemon.restart).toBe('fleet');
    expect(byName.dockerd.log.lines).toEqual(['dockerd line 2']);
    expect(byName.dockerd.log.truncated).toBe(true);
    // No proxy port: not running, and that is the maintainer's.
    expect(byName.proxy.state).toBe('stopped');
    expect(byName.proxy.escalation?.to).toBe('maintainer');
    expect(view.resources!.cpu.cores).toBeGreaterThan(0);
    expect(view.resources!.memory.totalBytes).toBeGreaterThan(0);
    expect(view.resources!.disks.length).toBeGreaterThan(0);
  });

  test('a dead forwarder is reported stopped, for the maintainer', async () => {
    await writeFile(paths().forwarderPid, '999999');
    const view = await observeMachine(root, {}, { paths: paths(), guestInit: () => '/x', dockerBinary: async () => null, proxy: async () => null });
    const fwd = view.services.find((s) => s.name === 'forwarder')!;
    expect(fwd.state).toBe('stopped');
    expect(fwd.escalation?.to).toBe('maintainer');
  });

  test('off a Teams microVM there is no forwarder and no guest log to read', async () => {
    delete process.env.LAZY_MANAGED;
    const view = await observeMachine(root, {}, { paths: paths(), guestInit: () => null, dockerBinary: async () => null, proxy: async () => null });
    expect(view.kind).toBe('host');
    const fwd = view.services.find((s) => s.name === 'forwarder')!;
    expect(fwd.state).toBe('not_applicable');
    expect(view.services.find((s) => s.name === 'dockerd')!.log.available).toBe(false);
  });

  // INVARIANT: on local-docker the shared host's name, load, memory and disks
  // are withheld. They describe every tenant on that host, not this project.
  test('a local-docker machine withholds the shared host\'s name and resources', async () => {
    process.env.LAZY_MANAGED = '1';
    process.env.LAZY_MANAGED_BACKEND = 'local-docker';
    const view = await observeMachine(root, {}, { paths: paths(), guestInit: () => null, dockerBinary: async () => null, proxy: async () => null });
    expect(view.kind).toBe('local-docker');
    expect(view.hostname).toBe('');
    expect(view.resources).toBeNull();
    expect(view.resourcesWithheld).toContain('shared host');
  });

  // INVARIANT: only the service itself is ever signalled — a pid file whose pid
  // now belongs to another program is left alone.
  test('a stale pid file\'s process is reported stopped and never signalled', async () => {
    sleeper = Bun.spawn(['sleep', '60']);
    await writeFile(paths().forwarderPid, String(sleeper.pid));
    const view = await observeMachine(root, {}, { paths: paths(), guestInit: () => '/x', dockerBinary: async () => null, proxy: async () => null });
    expect(view.services.find((s) => s.name === 'forwarder')!.state).toBe('stopped');
    const init = join(dir, 'lazy-guest-init');
    await writeFile(init, '#!/bin/sh\necho ready=yes\n');
    await chmod(init, 0o755);
    const r = restartMachineService('forwarder', { paths: paths(), guestInit: () => init });
    await until(() => r.state !== 'running', 15_000, 'the restart');
    expect(r.state).toBe('succeeded');
    expect(pidAlive(sleeper.pid)).toBe(true);
  });

  // INVARIANT: restarting a guest service stops it and re-runs lazy-guest-init.
  test('restarting the forwarder stops it and re-runs lazy-guest-init', async () => {
    const socat = await startForeignProcess(dir, 'socat');
    stopForeign = socat.kill;
    const pid = socat.pid;
    await writeFile(paths().forwarderPid, String(pid));
    const init = join(dir, 'lazy-guest-init');
    const marker = join(dir, 'init-ran');
    await writeFile(init, `#!/bin/sh\necho "args=$*" > ${marker}\necho ready=yes\n`);
    await chmod(init, 0o755);
    const started = restartMachineService('forwarder', { paths: paths(), guestInit: () => init });
    expect(started.state).toBe('running');
    expect(() => restartMachineService('forwarder', { paths: paths(), guestInit: () => init })).toThrow(MachineRestartError);
    await until(() => started.state !== 'running', 15_000, 'the restart');
    expect(started.state).toBe('succeeded');
    expect(started.output).toContain('ready=yes');
    expect(pidAlive(pid)).toBe(false);
    expect(await readFile(marker, 'utf-8')).toContain('--force');
  });

  test('the daemon and the proxy are the fleet\'s to restart, and a non-guest restarts nothing', () => {
    expect(() => restartMachineService('daemon', { guestInit: () => '/x' })).toThrow(/fleet/);
    expect(() => restartMachineService('proxy', { guestInit: () => '/x' })).toThrow(/fleet/);
    expect(() => restartMachineService('dockerd', { guestInit: () => null })).toThrow(/not installed/);
    expect(() => restartMachineService('sshd', { guestInit: () => '/x' })).toThrow(/Unknown service/);
  });

  // INVARIANT: the god-only restart is gated on the backend the fleet
  // DECLARED, never on a guest script merely being installed — a managed
  // daemon on Teams' shared local-docker host (or one not told its backend)
  // restarts nothing, and is not reported as a microVM.
  test('a guest script on a shared host neither allows a restart nor makes it a microVM', async () => {
    process.env.LAZY_MANAGED_BACKEND = 'local-docker';
    expect(() => restartMachineService('dockerd', { guestInit: () => '/x' })).toThrow(/not a Lazy Teams microVM/);
    const view = await observeMachine(root, {}, { paths: paths(), guestInit: () => '/x', dockerBinary: async () => null, proxy: async () => null });
    expect(view.kind).toBe('local-docker');
    delete process.env.LAZY_MANAGED_BACKEND;
    expect(() => restartMachineService('forwarder', { guestInit: () => '/x' })).toThrow(/not a Lazy Teams microVM/);
  });

  test('asking for no log lines reads none', async () => {
    await writeFile(paths().dockerdLog, 'one\ntwo\n');
    const view = await observeMachine(root, { lines: 0 }, { paths: paths(), guestInit: () => '/x', dockerBinary: async () => null, proxy: async () => null });
    const log = view.services.find((s) => s.name === 'dockerd')!.log;
    expect(log.available).toBe(true);
    expect(log.lines).toEqual([]);
  });

  async function fakeDocker(body: string): Promise<string> {
    const bin = join(dir, 'fake-docker');
    await writeFile(bin, `#!/bin/sh\n${body}\n`);
    await chmod(bin, 0o755);
    return bin;
  }

  // INVARIANT: a project admin can see WHY dockerd restarted — the guest's
  // restart history beside its log, how often it restarted lately, and a
  // crash loop or a hang as states of their own; a hang is the maintainer's,
  // a crash loop is the admin's when its latest death was an OOM kill.
  test('dockerd\'s restart history, recent restarts, crash loop and not answering', async () => {
    const now = Math.floor(Date.now() / 1000);
    await writeFile(paths().dockerdRestarts, `${now - 3000}\n${now - 400}\n${now - 60}\n`);
    await writeFile(paths().dockerdHistory,
      '=== 2026-10-03T14:02:11Z dockerd (pid 812) stopped answering (cause=exited-137+oom-killer, exit_status=137)\n' +
      '=== 2026-10-03T14:02:13Z restarting dockerd (restart 1 of 3 allowed in 900s)\n');
    const down = await fakeDocker('echo "Cannot connect to the Docker daemon" >&2; exit 1');
    const observe = async (docker: string) => (await observeMachine(root, {}, {
      paths: paths(), guestInit: () => '/x', dockerBinary: async () => docker, proxy: async () => null,
    })).services.find((s) => s.name === 'dockerd')!;

    await writeFile(paths().dockerdGaveUp, '');
    let dockerd = await observe(down);
    expect(dockerd.state).toBe('crash_loop');
    expect(dockerd.recentRestarts).toEqual({ count: 2, windowSeconds: 900 });
    expect(dockerd.detail).toContain('lazy restarted it 2 times in the last 15 minutes and it stopped again, so lazy stopped restarting it');
    // Past the window, before the guest retries: no self-contradicting "0 times".
    await writeFile(paths().dockerdRestarts, `${now - 3000}\n`);
    expect((await observe(down)).detail).toStartWith('It kept stopping, so lazy stopped restarting it.');
    await writeFile(paths().dockerdRestarts, `${now - 3000}\n${now - 400}\n${now - 60}\n`);
    // INVARIANT: a crash loop whose latest death was an OOM kill is the project admin's to start fixing (reset Docker storage), never only "report to support".
    expect(dockerd.escalation?.to).toBe('admin');
    expect(dockerd.escalation?.summary).toContain('dockerd ran out of memory');
    expect(JSON.stringify(dockerd.escalation)).toContain('reset it from the Machine page');
    // A crash loop that was not an OOM keeps the maintainer escalation.
    await writeFile(paths().dockerdHistory, '=== 2026-10-03T14:02:11Z dockerd (pid 812) stopped answering (cause=exited-1, exit_status=1)\n');
    const plain = await observe(down);
    expect(plain.escalation?.to).toBe('maintainer');
    expect(plain.escalation?.summary).toContain('keeps stopping');
    expect(dockerd.history?.lines.join('\n')).toContain('cause=exited-137+oom-killer');
    await writeFile(paths().dockerdHistory,
      '=== 2026-10-03T14:02:11Z dockerd (pid 812) stopped answering (cause=exited-137+oom-killer, exit_status=137)\n' +
      '=== 2026-10-03T14:02:13Z restarting dockerd (restart 1 of 3 allowed in 900s)\n');

    await rm(paths().dockerdGaveUp);
    const proc = await startForeignProcess(dir, 'dockerd');
    stopForeign = proc.kill;
    await writeFile(paths().dockerdPid, String(proc.pid));
    await writeFile(paths().dockerdUnresponsiveSince, String(now - 90));
    dockerd = await observe(down);
    expect(dockerd.state).toBe('unresponsive');
    expect(dockerd.detail).toMatch(/Running but not answering for 9\ds/);
    expect(dockerd.escalation?.to).toBe('maintainer');

    dockerd = await observe(await fakeDocker('echo "27.3.1|/storage/docker|2"'));
    expect(dockerd.state).toBe('running');
    expect(dockerd.escalation).toBeNull();
    expect(dockerd.detail).toBe('version 27.3.1, 2 containers running; lazy restarted it after it stopped 2 times in the last 15 minutes. Its last stop: dockerd ran out of memory. Give this project\'s machine more memory (the machine size, set by your god-mode admin), then run the build again. If the Docker storage itself has grown too large, a project admin can reset it from the Machine page (or `lazy system machine reset-docker-storage`); builds are cold afterwards.');
    expect(dockerd.history?.available).toBe(true);

    // An old OOM death is not repeated on a healthy dockerd once the restart is out of the window.
    await writeFile(paths().dockerdRestarts, `${now - 3000}\n`);
    expect((await observe(await fakeDocker('echo "27.3.1|/storage/docker|2"'))).detail).toBe('version 27.3.1, 2 containers running');
  });

  test('off a Teams microVM dockerd has no restart history', async () => {
    process.env.LAZY_MANAGED_BACKEND = 'local-docker';
    await writeFile(paths().dockerdHistory, 'x\n');
    const view = await observeMachine(root, {}, { paths: paths(), guestInit: () => '/x', dockerBinary: async () => null, proxy: async () => null });
    const dockerd = view.services.find((s) => s.name === 'dockerd')!;
    expect(dockerd.history).toBeNull();
    expect(dockerd.recentRestarts).toBeNull();
  });

  // INVARIANT: god mode's dockerd Restart is a REQUESTED restart, end to end —
  // through the real lazy-guest-init: no death record in the history admins
  // read, and no entry against the crash budget, so a third restart in the
  // window does not fail as a crash loop.
  test('a god-mode dockerd restart is recorded as requested, never as a crash', async () => {
    const run = join(dir, 'run');
    const bin = join(dir, 'bin');
    const procs = join(dir, 'procs');
    for (const d of [run, bin, procs]) await mkdir(d, { recursive: true });
    const p = { ...paths(), dockerdPid: join(run, 'lazy-dockerd.pid'), dockerdExit: join(run, 'lazy-dockerd.exit'),
      dockerdRestarts: join(run, 'lazy-dockerd.restarts'), dockerdGaveUp: join(run, 'lazy-dockerd.gave-up'),
      dockerdUnresponsiveSince: join(run, 'lazy-dockerd.unresponsive-since'), dockerdRestartRequested: join(run, 'lazy-dockerd.restart-requested') };
    const script = async (name: string, body: string) => {
      await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
      await chmod(join(bin, name), 0o755);
    };
    // dockerd is a process whose program name IS dockerd (a symlink to sleep),
    // so the daemon's identity check lets it signal it; docker answers while it lives.
    const { symlink } = await import('fs/promises');
    await symlink('/bin/sleep', join(procs, 'dockerd'));
    await script('dockerd', `exec "${join(procs, 'dockerd')}" 120`);
    await script('docker', `case "$1" in buildx) exit 0 ;; esac
pid="$(cat "${p.dockerdPid}" 2>/dev/null)"; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || exit 1
[ "$2" = "--format" ] && echo overlay2; exit 0`);
    await script('id', 'echo 0');
    await script('ip', 'exit 0');
    await script('dmesg', 'exit 0');
    const init = join(dir, 'lazy-guest-init');
    const real = join(import.meta.dir, '..', '..', 'src', 'guest', 'lazy-guest-init');
    await writeFile(init, `#!/bin/sh
export PATH="${bin}:$PATH" LAZY_GUEST_RUN_DIR="${run}" LAZY_GUEST_LOG_DIR="${dir}" LAZY_GUEST_DOCKER_DATA_ROOT="${join(dir, 'docker')}" \\
  LAZY_GUEST_DOCKER_STORAGE_DRIVER=overlay2 LAZY_GUEST_DOCKERD_MAX_RESTARTS=1 \
  LAZY_GUEST_CGROUP_ROOT="${join(dir, 'no-cgroup')}"
exec sh "${real}" "$@" --timeout 10
`);
    await chmod(init, 0o755);
    const first = spawnSyncUnsupervised([init, '--ensure'], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
    expect(first.stdout.toString()).toContain('source=started-dockerd');
    try {
      for (let i = 0; i < 3; i++) {
        const before = Number((await readFile(p.dockerdPid, 'utf-8')).trim());
        const r = restartMachineService('dockerd', { paths: p, guestInit: () => init });
        await until(() => r.state !== 'running', 30_000, 'the dockerd restart');
        expect(r.state, r.output ?? '').toBe('succeeded');
        expect(r.output).toContain('source=requested-restart');
        expect(pidAlive(before)).toBe(false);
      }
      const history = await readFile(p.dockerdHistory, 'utf-8');
      expect(history.match(/restart requested from god mode/g)?.length).toBe(3);
      expect(history).not.toContain('cause=');
      const view = await observeMachine(root, {}, { paths: p, guestInit: () => init, dockerBinary: async () => null, proxy: async () => null });
      expect(view.services.find((s) => s.name === 'dockerd')!.recentRestarts?.count).toBe(0);
      // The request is consumed, never left to excuse a later real crash.
      await expect(readFile(p.dockerdRestartRequested, 'utf-8')).rejects.toThrow();
    } finally {
      const pid = Number((await readFile(p.dockerdPid, 'utf-8').catch(() => '0')).trim());
      if (pid > 0 && pidAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 120_000);

  // INVARIANT: restarting a machine service is god mode's verb, and the logs
  // are the control plane's read — a member token is refused outright.
  test('a member token can neither restart a service nor read the machine\'s logs', async () => {
    const member = { kind: 'user' as const, email: 'admin@example.com' };
    await expect(handleRestartMachineService(root, { service: 'dockerd' }, member)).rejects.toThrow(/god-mode/);
    await expect(handleMachineState(root, {}, member)).rejects.toThrow(/control token only/);
    await expect(handleImageBuildLog(root, {}, member)).rejects.toThrow(/control token only/);
  });
});
