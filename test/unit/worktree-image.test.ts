/**
 * Unit tests: per-task worktree image (Part 1 of add-worktree-image-flow).
 *
 * INVARIANT: a worktree Dockerfile reaches the host's docker build ONLY through
 * a human answering a TTY prompt on create/start/edit. Non-TTY, --yes, and
 * already-pinned tasks must never prompt. Missing pins fail loud at launch.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import {
  lazyTaskWorktreeCwd,
  detectWorktreeDockerfileDiff,
  dockerfileContentHash,
  inheritCustomImageMetadata,
  droppedCustomImagePinWarning,
  maybeOfferWorktreeImageForTask,
  missingPinnedImageMessage,
  pinnedCustomImage,
  pinnedCustomImageHash,
  CUSTOM_IMAGE_META_KEY,
  CUSTOM_IMAGE_HASH_META_KEY,
} from '../../src/docker/worktree-image';
import { ensureImage, IMAGE_TAG } from '../../src/capture/claude';
import { installFakeDocker } from '../helpers/fake-docker';
import type { Task } from '../../src/types';
import type { Storage } from '../../src/storage/interface';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    goal: overrides.goal ?? 'g',
    status: overrides.status ?? 'backlog',
    prompt: overrides.prompt ?? '',
    model: overrides.model ?? null,
    code: overrides.code ?? null,
    type: overrides.type ?? 'task',
    priority: overrides.priority ?? 'normal',
    agent_id: overrides.agent_id ?? 'claude-code',
    runner_type: overrides.runner_type ?? null,
    created_at: overrides.created_at ?? Date.now(),
    completed_at: overrides.completed_at ?? null,
    branched_from_sha: overrides.branched_from_sha ?? null,
    close_reason: overrides.close_reason ?? null,
    target: overrides.target ?? { kind: 'branch', branch: 'main' },
    metadata: overrides.metadata ?? null,
    tags: overrides.tags ?? [],
    pending_sync: overrides.pending_sync ?? 0,
  } as Task;
}

/** Minimal storage stub for metadata inherit / offer tests. */
function makeMetaStorage(tasks: Map<string, Task>): Pick<Storage, 'getTask' | 'updateTaskMetadata'> {
  return {
    async getTask(id: string) {
      return tasks.get(id) ?? null;
    },
    async updateTaskMetadata(taskId: string, key: string, value: string) {
      const t = tasks.get(taskId);
      if (!t) throw new Error(`no task ${taskId}`);
      t.metadata = { ...(t.metadata ?? {}), [key]: value };
    },
  };
}

describe('lazyTaskWorktreeCwd (shared)', () => {
  let root: string;
  let worktree: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await mkdtemp(join(tmpdir(), 'lazy-wti-root-'));
    worktree = join(root, '.lazy', 'worktrees', 'my-task');
    await mkdir(worktree, { recursive: true });
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n');
    await writeFile(join(root, '.lazy', 'placeholder'), '');
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  test('returns the cwd when under .lazy/worktrees/', async () => {
    process.chdir(worktree);
    expect(await lazyTaskWorktreeCwd(root)).toBe(worktree);
  });

  test('returns null from the project root', async () => {
    process.chdir(root);
    expect(await lazyTaskWorktreeCwd(root)).toBeNull();
  });
});

describe('detectWorktreeDockerfileDiff (hash-diff detection)', () => {
  let root: string;
  let worktree: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    root = await mkdtemp(join(tmpdir(), 'lazy-wti-diff-'));
    worktree = join(root, '.lazy', 'worktrees', 'branch-task');
    await mkdir(worktree, { recursive: true });
    await writeFile(join(root, 'lazy.toml'), '[project]\nname = "t"\n');
    await writeFile(join(root, '.lazy', 'placeholder'), '');
    await writeFile(join(root, 'Dockerfile.lazy'), 'FROM debian:bookworm-slim\n# root\n');
    process.chdir(worktree);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  test('reports differs=true when worktree Dockerfile content differs from root', async () => {
    await writeFile(join(worktree, 'Dockerfile.lazy'), 'FROM debian:bookworm-slim\n# worktree\n');
    const diff = await detectWorktreeDockerfileDiff(root);
    expect(diff).not.toBeNull();
    expect(diff!.differs).toBe(true);
    expect(diff!.worktreeHash).toBe(sha256('FROM debian:bookworm-slim\n# worktree\n'));
    expect(diff!.referenceHash).toBe(sha256('FROM debian:bookworm-slim\n# root\n'));
  });

  test('reports differs=false when worktree matches root Dockerfile.lazy', async () => {
    await writeFile(join(worktree, 'Dockerfile.lazy'), 'FROM debian:bookworm-slim\n# root\n');
    const diff = await detectWorktreeDockerfileDiff(root);
    expect(diff).not.toBeNull();
    if (!diff) return;
    expect(diff.differs).toBe(false);
    // referenceHash is string | null; matching copies always have a reference.
    expect(diff.referenceHash).not.toBeNull();
    if (diff.referenceHash === null) return;
    expect(diff.worktreeHash).toBe(diff.referenceHash);
  });

  test('returns null when worktree has no Dockerfile.lazy', async () => {
    expect(await detectWorktreeDockerfileDiff(root)).toBeNull();
  });

  test('returns null when cwd is not a task worktree', async () => {
    process.chdir(root);
    await writeFile(join(worktree, 'Dockerfile.lazy'), 'FROM scratch\n');
    expect(await detectWorktreeDockerfileDiff(root)).toBeNull();
  });

  test('dockerfileContentHash matches sha256 hex', () => {
    const body = 'FROM alpine\n';
    expect(dockerfileContentHash(body)).toBe(sha256(body));
  });
});

describe('inheritCustomImageMetadata', () => {
  test('copies custom_image and custom_image_hash from parent', async () => {
    const parent = makeTask({
      id: 'parent',
      metadata: {
        [CUSTOM_IMAGE_META_KEY]: `lazy-custom-abcdef012345:${IMAGE_TAG}`,
        [CUSTOM_IMAGE_HASH_META_KEY]: 'b'.repeat(64),
      },
    });
    const child = makeTask({ id: 'child' });
    const tasks = new Map([['parent', parent], ['child', child]]);
    const storage = makeMetaStorage(tasks) as Storage;

    const ok = await inheritCustomImageMetadata(storage, 'child', parent);
    expect(ok).toBe(true);
    expect(pinnedCustomImage(child)).toBe(`lazy-custom-abcdef012345:${IMAGE_TAG}`);
    expect(pinnedCustomImageHash(child)).toBe('b'.repeat(64));
  });

  test('no-ops when parent has no pin', async () => {
    const parent = makeTask({ id: 'parent', metadata: null });
    const child = makeTask({ id: 'child' });
    const tasks = new Map([['child', child]]);
    const storage = makeMetaStorage(tasks) as Storage;

    expect(await inheritCustomImageMetadata(storage, 'child', parent)).toBe(false);
    expect(child.metadata).toBeNull();
  });
});

describe('droppedCustomImagePinWarning', () => {
  test('returns warning naming the image when task has a pin', () => {
    const task = makeTask({
      id: 'pinned',
      metadata: {
        [CUSTOM_IMAGE_META_KEY]: `lazy-custom-abcdef012345:${IMAGE_TAG}`,
      },
    });
    const warning = droppedCustomImagePinWarning(task);
    expect(warning).toContain(`lazy-custom-abcdef012345:${IMAGE_TAG}`);
    expect(warning).toContain('project root image');
  });

  test('returns null when task has no pin', () => {
    expect(droppedCustomImagePinWarning(makeTask({ id: 'unpinned', metadata: null }))).toBeNull();
    expect(droppedCustomImagePinWarning(null)).toBeNull();
  });
});

describe('maybeOfferWorktreeImageForTask (prompt gating)', () => {
  let root: string;
  let worktree: string;
  let originalCwd: string;
  let origForceTty: string | undefined;
  let origPromptDefaults: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    origForceTty = process.env.LAZY_FORCE_TTY;
    origPromptDefaults = process.env.LAZY_PROMPT_DEFAULTS;

    root = await mkdtemp(join(tmpdir(), 'lazy-wti-offer-'));
    worktree = join(root, '.lazy', 'worktrees', 'offer-task');
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
    await rm(root, { recursive: true, force: true });
  });

  test('does nothing without a TTY', async () => {
    delete process.env.LAZY_FORCE_TTY;
    delete process.env.LAZY_PROMPT_DEFAULTS;
    const task = makeTask({ id: 't1' });
    const tasks = new Map([['t1', task]]);
    const storage = makeMetaStorage(tasks) as Storage;

    const result = await maybeOfferWorktreeImageForTask(root, storage, 't1');
    expect(result).toBeNull();
    expect(task.metadata).toBeNull();
  });

  test('does nothing when skipPrompt (--yes) is set even on a TTY', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    const task = makeTask({ id: 't1' });
    const tasks = new Map([['t1', task]]);
    const storage = makeMetaStorage(tasks) as Storage;

    const result = await maybeOfferWorktreeImageForTask(root, storage, 't1', {
      skipPrompt: true,
    });
    expect(result).toBeNull();
    expect(task.metadata).toBeNull();
  });

  test('does nothing when the human declines on a TTY', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'decline';
    const task = makeTask({ id: 't1' });
    const tasks = new Map([['t1', task]]);
    const storage = makeMetaStorage(tasks) as Storage;

    const result = await maybeOfferWorktreeImageForTask(root, storage, 't1');
    expect(result).toBeNull();
    expect(task.metadata).toBeNull();
  });

  test('does nothing when worktree Dockerfile matches the reference', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    await writeFile(join(worktree, 'Dockerfile.lazy'), 'FROM debian:bookworm-slim\n# root\n');
    const task = makeTask({ id: 't1' });
    const tasks = new Map([['t1', task]]);
    const storage = makeMetaStorage(tasks) as Storage;

    const result = await maybeOfferWorktreeImageForTask(root, storage, 't1');
    expect(result).toBeNull();
    expect(task.metadata).toBeNull();
  });

  test('persists custom_image metadata when the human accepts on a TTY', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    const task = makeTask({ id: 't1' });
    const tasks = new Map([['t1', task]]);
    const storage = makeMetaStorage(tasks) as Storage;

    const docker = await installFakeDocker(root);
    const result = await maybeOfferWorktreeImageForTask(root, storage, 't1', {
      binary: docker.binPath,
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    // pinnedCustomImage returns string | undefined; result is now string.
    expect(pinnedCustomImage(task)).toBe(result);
    expect(pinnedCustomImage(task)).toMatch(/^lazy-custom-[0-9a-f]{12}:/);
    expect(pinnedCustomImageHash(task)).toHaveLength(64);
    expect(pinnedCustomImageHash(task)).toBe(
      sha256('FROM debian:bookworm-slim\n# worktree\n'),
    );
  });
});

describe('ensureImage pinnedImage fail-loud', () => {
  test('returns the pinned image when it exists locally', async () => {
    const base = await mkdtemp(join(tmpdir(), 'lazy-wti-pin-'));
    try {
      const docker = await installFakeDocker(base);
      const ref = `lazy-custom-deadbeefcafe:${IMAGE_TAG}`;
      await docker.seedImage(ref, { dockerfileHash: 'hash' });
      const used = await ensureImage(docker.binPath, { pinnedImage: ref });
      expect(used).toBe(ref);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('throws a loud rebuild message when the pinned image is missing', async () => {
    const base = await mkdtemp(join(tmpdir(), 'lazy-wti-miss-'));
    try {
      const docker = await installFakeDocker(base);
      const ref = `lazy-custom-missing0000:${IMAGE_TAG}`;
      await expect(ensureImage(docker.binPath, { pinnedImage: ref })).rejects.toThrow(
        /will not fall back to the project root image/i,
      );
      await expect(ensureImage(docker.binPath, { pinnedImage: ref })).rejects.toThrow(
        /lazy edit|lazy start/,
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('missingPinnedImageMessage', () => {
  test('names the image and how to rebuild', () => {
    const msg = missingPinnedImageMessage('lazy-custom-abc:0.22', 'my-task');
    expect(msg).toContain('lazy-custom-abc:0.22');
    expect(msg).toContain('my-task');
    expect(msg).toMatch(/lazy edit|lazy start/);
    expect(msg).toMatch(/will not fall back/i);
  });
});
