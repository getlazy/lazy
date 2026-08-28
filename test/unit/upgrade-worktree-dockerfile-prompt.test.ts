/**
 * Unit tests: worktree Dockerfile adoption for `lazy upgrade` (Part 2).
 *
 * INVARIANT: a task worktree never governs the container image by default.
 * On a TTY, upgrade offers adoption; on yes it persists daemon runtime state
 * (adopted-image.json). Each rebuild clears first so adoption cannot silently
 * outlive the next decision. The old env-override path is gone.
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
import { getAdoptedImagePath } from '../../src/daemon/paths';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { VERSION } from '../../src/version';
import { IMAGE_TAG } from '../../src/capture/image-tag';
import { pathExists } from '../../src/utils/fs';

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

  test('returns the cwd when it is under .lazy/worktrees/', async () => {
    process.chdir(worktree);
    expect(await lazyTaskWorktreeCwd(root)).toBe(worktree);
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

  test('does nothing without a TTY but still clears prior adoption', async () => {
    delete process.env.LAZY_FORCE_TTY;
    delete process.env.LAZY_PROMPT_DEFAULTS;
    // Seed a prior adoption so we can assert the clear.
    const { writeAdoptedImage, hashDockerfileContent } = await import('../../src/daemon/adopted-image');
    const dockerfilePath = join(worktree, 'Dockerfile.lazy');
    const content = await readFile(dockerfilePath, 'utf-8');
    await writeAdoptedImage(root, {
      dockerfilePath,
      contentHash: hashDockerfileContent(content),
      imageName: 'lazy-custom-abc:0.22',
    }, { content });
    expect(await readAdoptedImage(root)).not.toBeNull();

    const result = await maybePromptWorktreeDockerfileAdoption(root);
    expect(result).toBeNull();
    expect(await readAdoptedImage(root)).toBeNull();
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

    const onDisk = await readAdoptedImage(root);
    expect(onDisk).toEqual(result);
    // Adoption must not invent a process env override — it is daemon state only.
    expect(process.env.LAZY_DOCKERFILE_LAZY).toBeUndefined();
  });

  test('leaves adoption cleared when the human declines', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'decline';
    const { writeAdoptedImage } = await import('../../src/daemon/adopted-image');
    await writeAdoptedImage(root, {
      dockerfilePath: '/old',
      contentHash: 'old',
      imageName: 'lazy-custom-old:0.22',
    });

    const result = await maybePromptWorktreeDockerfileAdoption(root);
    expect(result).toBeNull();
    expect(await readAdoptedImage(root)).toBeNull();
    expect(await pathExists(getAdoptedImagePath(root))).toBe(false);
  });
});
