/**
 * Unit tests: worktree Dockerfile prompt for `lazy upgrade`.
 *
 * INVARIANT: a task worktree never governs the container image by default; the
 * only override is LAZY_DOCKERFILE_LAZY. Developers often forget to export it
 * when upgrading from a worktree — this prompt asks on a TTY before any image
 * build starts so the answer can change what gets built.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  lazyTaskWorktreeCwd,
  maybePromptWorktreeDockerfileOverride,
} from '../../src/upgrade/worktree-dockerfile-prompt';

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

describe('maybePromptWorktreeDockerfileOverride', () => {
  let root: string;
  let worktree: string;
  let originalCwd: string;
  let origForceTty: string | undefined;
  let origPromptDefaults: string | undefined;
  let origOverride: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    origForceTty = process.env.LAZY_FORCE_TTY;
    origPromptDefaults = process.env.LAZY_PROMPT_DEFAULTS;
    origOverride = process.env.LAZY_DOCKERFILE_LAZY;

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
    if (origOverride === undefined) delete process.env.LAZY_DOCKERFILE_LAZY;
    else process.env.LAZY_DOCKERFILE_LAZY = origOverride;
    await rm(root, { recursive: true, force: true });
  });

  test('does nothing without a TTY', async () => {
    delete process.env.LAZY_FORCE_TTY;
    delete process.env.LAZY_PROMPT_DEFAULTS;
    await maybePromptWorktreeDockerfileOverride(root);
    expect(process.env.LAZY_DOCKERFILE_LAZY).toBeUndefined();
  });

  test('does nothing when LAZY_DOCKERFILE_LAZY is already set', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    process.env.LAZY_DOCKERFILE_LAZY = '/already/set';
    await maybePromptWorktreeDockerfileOverride(root);
    expect(process.env.LAZY_DOCKERFILE_LAZY).toBe('/already/set');
  });

  test('does nothing when worktree Dockerfile.lazy matches the root copy', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    await writeFile(join(worktree, 'Dockerfile.lazy'), 'FROM debian:bookworm-slim\n# root\n');
    await maybePromptWorktreeDockerfileOverride(root);
    expect(process.env.LAZY_DOCKERFILE_LAZY).toBeUndefined();
  });

  test('sets LAZY_DOCKERFILE_LAZY when the human accepts on a TTY', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    await maybePromptWorktreeDockerfileOverride(root);
    expect(process.env.LAZY_DOCKERFILE_LAZY).toBe(join(worktree, 'Dockerfile.lazy'));
  });

  test('leaves LAZY_DOCKERFILE_LAZY unset when the human declines', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'decline';
    await maybePromptWorktreeDockerfileOverride(root);
    expect(process.env.LAZY_DOCKERFILE_LAZY).toBeUndefined();
  });
});
