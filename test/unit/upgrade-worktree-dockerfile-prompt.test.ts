/**
 * Unit tests: worktree Dockerfile adoption for `lazy upgrade` (Part 2).
 *
 * INVARIANT: a task worktree never governs the container image by default.
 * On a TTY, upgrade offers adoption; on yes it persists daemon runtime state
 * (adopted-image.json). Each rebuild re-decides adoption: announce any valid
 * state (keep or clear), then optionally offer a new worktree Dockerfile.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  lazyTaskWorktreeCwd,
  maybePromptWorktreeDockerfileAdoption,
} from '../../src/upgrade/worktree-dockerfile-prompt';
import {
  readAdoptedImage,
} from '../../src/daemon/adopted-image';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { initGitRepoWithCommit } from '../helpers/git-repo';
import { VERSION } from '../../src/version';
import { IMAGE_TAG } from '../../src/capture/image-tag';

describe('lazyTaskWorktreeCwd', () => {
  let root: string;
  let worktree: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await mkdtemp(join(tmpdir(), 'lazy-wt-root-'));
    worktree = join(root, '.lazy', 'worktrees', 'my-task');
    await mkdir(worktree, { recursive: true });
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n');
    await writeFile(join(root, '.lazy', 'placeholder'), '');
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  test('returns the worktree root when cwd is under .lazy/worktrees/', async () => {
    process.chdir(worktree);
    expect(await lazyTaskWorktreeCwd(root)).toBe(worktree);
  });

  test('returns the worktree root when cwd is a subdirectory of the worktree', async () => {
    const subdir = join(worktree, 'src', 'cli');
    await mkdir(subdir, { recursive: true });
    process.chdir(subdir);
    expect(await lazyTaskWorktreeCwd(root)).toBe(worktree);
  });

  test('returns the worktree root when cwd is reached through a symlink', async () => {
    const linkParent = await mkdtemp(join(tmpdir(), 'lazy-wt-link-'));
    const link = join(linkParent, 'into-worktree');
    try {
      const { symlink } = await import('fs/promises');
      await symlink(worktree, link);
      process.chdir(link);
      expect(await lazyTaskWorktreeCwd(root)).toBe(worktree);
    } finally {
      process.chdir(originalCwd);
      await rm(linkParent, { recursive: true, force: true });
    }
  });

  test('returns null from the project root', async () => {
    process.chdir(root);
    expect(await lazyTaskWorktreeCwd(root)).toBeNull();
  });

  test('returns null from an unrelated directory', async () => {
    const other = await mkdtemp(join(tmpdir(), 'lazy-wt-other-'));
    try {
      process.chdir(other);
      expect(await lazyTaskWorktreeCwd(root)).toBeNull();
    } finally {
      process.chdir(originalCwd);
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe('maybePromptWorktreeDockerfileAdoption', () => {
  let root: string;
  let worktree: string;
  let originalCwd: string;
  let origForceTty: string | undefined;
  let origPromptDefaults: string | undefined;
  let undoDaemonBase: (() => void) | undefined;
  let worktreeHead: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    origForceTty = process.env.LAZY_FORCE_TTY;
    origPromptDefaults = process.env.LAZY_PROMPT_DEFAULTS;

    const daemonBase = await mkdtemp(join(tmpdir(), 'lazy-adopt-daemon-'));
    undoDaemonBase = pinDaemonBaseDir(daemonBase);

    root = await mkdtemp(join(tmpdir(), 'lazy-wt-prompt-'));
    worktree = join(root, '.lazy', 'worktrees', 'branch-task');
    await mkdir(worktree, { recursive: true });
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n');
    await writeFile(join(root, '.lazy', 'placeholder'), '');
    await writeFile(join(root, 'Dockerfile.lazy'), 'FROM debian:bookworm-slim\n# root\n');
    await writeFile(join(worktree, 'Dockerfile.lazy'), 'FROM debian:bookworm-slim\n# worktree\n');
    // The adopted image builds against this worktree directory. It is a real
    // git checkout here only so the informational HEAD field has a value.
    worktreeHead = await initGitRepoWithCommit(worktree, 'worktree fixture');
    process.chdir(worktree);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (origForceTty === undefined) delete process.env.LAZY_FORCE_TTY;
    else process.env.LAZY_FORCE_TTY = origForceTty;
    if (origPromptDefaults === undefined) delete process.env.LAZY_PROMPT_DEFAULTS;
    else process.env.LAZY_PROMPT_DEFAULTS = origPromptDefaults;
    undoDaemonBase?.();
    await rm(root, { recursive: true, force: true });
  });

  test('keeps prior adoption without a TTY and logs the decision', async () => {
    delete process.env.LAZY_FORCE_TTY;
    delete process.env.LAZY_PROMPT_DEFAULTS;
    const { writeAdoptedImage, hashDockerfileContent } = await import('../../src/daemon/adopted-image');
    const dockerfilePath = join(worktree, 'Dockerfile.lazy');
    const content = await readFile(dockerfilePath, 'utf-8');
    await writeAdoptedImage(root, {
      dockerfilePath,
      contentHash: hashDockerfileContent(content),
      imageName: 'lazy-custom-abc:0.22',
    }, { content });
    expect(await readAdoptedImage(root)).not.toBeNull();

    process.chdir(root);
    const result = await maybePromptWorktreeDockerfileAdoption(root);
    expect(result).not.toBeNull();
    expect(result!.imageName).toBe('lazy-custom-abc:0.22');
    expect(await readAdoptedImage(root)).not.toBeNull();
  });

  test('does nothing when worktree Dockerfile.lazy matches the root copy', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    await writeFile(join(worktree, 'Dockerfile.lazy'), 'FROM debian:bookworm-slim\n# root\n');
    const result = await maybePromptWorktreeDockerfileAdoption(root);
    expect(result).toBeNull();
    expect(await readAdoptedImage(root)).toBeNull();
  });

  test('writes adoption when the human accepts on a TTY', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    const result = await maybePromptWorktreeDockerfileAdoption(root);
    expect(result).not.toBeNull();
    expect(result!.dockerfilePath).toBe(join(worktree, 'Dockerfile.lazy'));
    expect(result!.lazyVersion).toBe(VERSION);
    expect(result!.imageName).toMatch(new RegExp(`^lazy-custom-[0-9a-f]{12}:${IMAGE_TAG}$`));
    expect(result!.contentHash).toHaveLength(64);

    // Provenance only — HEAD when the adoption was recorded. The build reads
    // the worktree directory live; this field never gates anything.
    expect(result!.contextCommit).toBe(worktreeHead);

    const onDisk = await readAdoptedImage(root);
    expect(onDisk).toEqual(result);
    // Adoption must not invent a process env override — it is daemon state only.
    expect(process.env.LAZY_DOCKERFILE_LAZY).toBeUndefined();
  });

  test('writes adoption from a subdirectory of the worktree on a TTY', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    const subdir = join(worktree, 'src');
    await mkdir(subdir, { recursive: true });
    process.chdir(subdir);

    const result = await maybePromptWorktreeDockerfileAdoption(root);
    expect(result).not.toBeNull();
    expect(result!.dockerfilePath).toBe(join(worktree, 'Dockerfile.lazy'));
  });

  test('keeps existing adoption when upgrade runs from project root on a TTY', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    const { writeAdoptedImage, hashDockerfileContent } = await import('../../src/daemon/adopted-image');
    const dockerfilePath = join(worktree, 'Dockerfile.lazy');
    const content = await readFile(dockerfilePath, 'utf-8');
    const hash = hashDockerfileContent(content);
    await writeAdoptedImage(root, {
      dockerfilePath,
      contentHash: hash,
      imageName: 'lazy-custom-keepme1234:0.22',
    }, { content });

    process.chdir(root);
    const result = await maybePromptWorktreeDockerfileAdoption(root);
    expect(result).not.toBeNull();
    expect(result!.imageName).toBe('lazy-custom-keepme1234:0.22');
    expect(await readAdoptedImage(root)).not.toBeNull();
  });

  // INVARIANT: the image name covers the build CONTEXT, not just the Dockerfile
  // bytes — two worktrees of one repo routinely hold byte-identical
  // Dockerfile.lazy copies over different trees, and keyed on content alone the
  // second would silently reuse an image built from the first one's files.
  test('names a different image for the same Dockerfile in a different worktree', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    const first = await maybePromptWorktreeDockerfileAdoption(root);
    expect(first).not.toBeNull();

    // A second task worktree holding a byte-identical Dockerfile.
    const other = join(root, '.lazy', 'worktrees', 'other-task');
    await mkdir(other, { recursive: true });
    await writeFile(
      join(other, 'Dockerfile.lazy'),
      await readFile(join(worktree, 'Dockerfile.lazy'), 'utf-8'),
    );
    await initGitRepoWithCommit(other, 'other worktree fixture');
    process.chdir(other);

    const second = await maybePromptWorktreeDockerfileAdoption(root);
    expect(second).not.toBeNull();
    expect(second!.contentHash).toBe(first!.contentHash);
    expect(second!.imageName).not.toBe(first!.imageName);
  });

  // The build context is a live directory, so git is not required at all — a
  // worktree outside git simply has no HEAD to record as provenance.
  test('adopts a worktree that is not a git repo, with no recorded provenance', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    await rm(join(worktree, '.git'), { recursive: true, force: true });

    const result = await maybePromptWorktreeDockerfileAdoption(root);
    expect(result).not.toBeNull();
    expect(result!.contextCommit).toBeUndefined();
    expect(await readAdoptedImage(root)).not.toBeNull();
  });

  test('clears existing adoption when the human declines keep on a TTY from project root', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'decline';
    const { writeAdoptedImage, hashDockerfileContent } = await import('../../src/daemon/adopted-image');
    const dockerfilePath = join(worktree, 'Dockerfile.lazy');
    const content = await readFile(dockerfilePath, 'utf-8');
    await writeAdoptedImage(root, {
      dockerfilePath,
      contentHash: hashDockerfileContent(content),
      imageName: 'lazy-custom-old:0.22',
    }, { content });

    process.chdir(root);
    const result = await maybePromptWorktreeDockerfileAdoption(root);
    expect(result).toBeNull();
    expect(await readAdoptedImage(root)).toBeNull();
  });

  test('does not write adoption when the human declines a new worktree offer', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'decline';

    const result = await maybePromptWorktreeDockerfileAdoption(root);
    expect(result).toBeNull();
    expect(await readAdoptedImage(root)).toBeNull();
  });
});
