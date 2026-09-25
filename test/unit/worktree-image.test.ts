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
  pinnedCustomImageContext,
  pinnedCustomImageHash,
  CUSTOM_IMAGE_META_KEY,
  CUSTOM_IMAGE_HASH_META_KEY,
  CUSTOM_IMAGE_CONTEXT_META_KEY,
} from '../../src/docker/worktree-image';
import { ensureImage, IMAGE_TAG } from '../../src/capture/claude';
import { installFakeDocker } from '../helpers/fake-docker';
import { initGitRepoWithCommit } from '../helpers/git-repo';
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
  let worktreeHead: string;
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
    // A real git worktree so HEAD can be recorded as provenance. The build
    // context is the directory itself, so the commit is informational only.
    worktreeHead = await initGitRepoWithCommit(worktree, 'worktree fixture');
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
    // The stored hash stays a PURE content hash — drift detection compares the
    // live worktree file against it. The IMAGE NAME is the one that also covers
    // the context directory.
    expect(pinnedCustomImageHash(task)).toBe(
      sha256('FROM debian:bookworm-slim\n# worktree\n'),
    );
    // Provenance only: HEAD when the image was built, not a statement about
    // what went into it (the context is the live directory).
    expect(pinnedCustomImageContext(task)).toBe(worktreeHead);
  });

  // INVARIANT: the build context is the worktree's tree, not the project root.
  // The two live on different branches; building the worktree's Dockerfile
  // against the root's tree resolves its COPY paths against the wrong files.
  test('builds against the worktree tree, not the project root', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    // A file that exists ONLY on the worktree branch — the shape of the wild
    // report (COPY engine-e2e/build.rs → "not found").
    await mkdir(join(worktree, 'extra'), { recursive: true });
    await writeFile(join(worktree, 'extra', 'file.txt'), 'branch-only\n');
    await writeFile(
      join(worktree, 'Dockerfile.lazy'),
      'FROM debian:bookworm-slim\nCOPY extra/file.txt /extra.txt\n',
    );

    const task = makeTask({ id: 't1' });
    const storage = makeMetaStorage(new Map([['t1', task]])) as Storage;
    const docker = await installFakeDocker(root);
    await maybeOfferWorktreeImageForTask(root, storage, 't1', { binary: docker.binPath });

    const cwds = await docker.buildCwds();
    expect(cwds).toHaveLength(1);
    expect(cwds[0]).not.toBe(root);
    const files = await docker.buildContextFiles(0);
    expect(files).toContain('extra/file.txt');
    expect(files).toContain('Dockerfile.lazy');
  });

  // The context is the worktree as it is ON DISK, exactly like running
  // `docker build` there by hand: uncommitted files are part of the build.
  test('includes uncommitted files — the context is the live directory', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    await writeFile(join(worktree, 'never-committed.txt'), 'on disk only\n');

    const task = makeTask({ id: 't1' });
    const storage = makeMetaStorage(new Map([['t1', task]])) as Storage;
    const docker = await installFakeDocker(root);
    await maybeOfferWorktreeImageForTask(root, storage, 't1', { binary: docker.binPath });

    const files = await docker.buildContextFiles(0);
    expect(files).toContain('Dockerfile.lazy');
    expect(files).toContain('never-committed.txt');
  });

  // The consented Dockerfile itself is the ONE deliberate exception: its exact
  // bytes are what the human read at the prompt, committed or not.
  test('uses the consented Dockerfile bytes even when uncommitted', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    const uncommitted = 'FROM debian:bookworm-slim\n# edited, not committed\n';
    await writeFile(join(worktree, 'Dockerfile.lazy'), uncommitted);

    const task = makeTask({ id: 't1' });
    const storage = makeMetaStorage(new Map([['t1', task]])) as Storage;
    const docker = await installFakeDocker(root);
    await maybeOfferWorktreeImageForTask(root, storage, 't1', { binary: docker.binPath });

    expect(pinnedCustomImageHash(task)).toBe(sha256(uncommitted));
    // The recorded HEAD is provenance and does not move for an uncommitted
    // edit — it says when the build ran, not what was in it.
    expect(pinnedCustomImageContext(task)).toBe(worktreeHead);
  });

  // Byte-identical Dockerfiles in two worktrees are two images: naming by
  // content alone let one task reuse an image built from another's files.
  test('names different images for the same Dockerfile in different worktrees', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    const docker = await installFakeDocker(root);

    const first = makeTask({ id: 't1' });
    await maybeOfferWorktreeImageForTask(
      root,
      makeMetaStorage(new Map([['t1', first]])) as Storage,
      't1',
      { binary: docker.binPath },
    );

    // A second task worktree holding the very same Dockerfile bytes.
    const other = join(root, '.lazy', 'worktrees', 'other-task');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'Dockerfile.lazy'), 'FROM debian:bookworm-slim\n# worktree\n');
    await initGitRepoWithCommit(other, 'other worktree fixture');
    process.chdir(other);

    const second = makeTask({ id: 't2' });
    await maybeOfferWorktreeImageForTask(
      root,
      makeMetaStorage(new Map([['t2', second]])) as Storage,
      't2',
      { binary: docker.binPath },
    );

    expect(pinnedCustomImageHash(second)).toBe(pinnedCustomImageHash(first));
    expect(pinnedCustomImage(second)).not.toBe(pinnedCustomImage(first));
  });

  // git is not required: the context is a directory, so a worktree outside
  // git still builds — it simply has no HEAD to record as provenance.
  test('offers in a non-git worktree, recording no provenance', async () => {
    process.env.LAZY_FORCE_TTY = '1';
    process.env.LAZY_PROMPT_DEFAULTS = 'accept';
    const bare = await mkdtemp(join(tmpdir(), 'lazy-wti-nogit-'));
    try {
      const nonGitWorktree = join(bare, '.lazy', 'worktrees', 'plain-task');
      await mkdir(nonGitWorktree, { recursive: true });
      await writeFile(join(bare, 'lazy.toml'), '[project]\nname = "t"\n');
      await writeFile(join(bare, '.lazy', 'placeholder'), '');
      await writeFile(join(bare, 'Dockerfile.lazy'), 'FROM debian:bookworm-slim\n# root\n');
      await writeFile(
        join(nonGitWorktree, 'Dockerfile.lazy'),
        'FROM debian:bookworm-slim\n# worktree\n',
      );
      process.chdir(nonGitWorktree);

      const task = makeTask({ id: 't1' });
      const storage = makeMetaStorage(new Map([['t1', task]])) as Storage;
      const docker = await installFakeDocker(bare);
      const result = await maybeOfferWorktreeImageForTask(bare, storage, 't1', {
        binary: docker.binPath,
      });

      expect(result).not.toBeNull();
      if (result === null) return;
      expect(pinnedCustomImage(task)).toBe(result);
      expect(pinnedCustomImageContext(task)).toBeUndefined();
      expect(await docker.builds()).toHaveLength(1);
      expect((await docker.buildCwds())[0]).toBe(nonGitWorktree);
    } finally {
      process.chdir(originalCwd);
      await rm(bare, { recursive: true, force: true });
    }
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

describe('pins made before build contexts were recorded', () => {
  // INVARIANT: a stored image fails loud only when it is MISSING. Recording the
  // build context is new; every pin created before it exists on disk today with
  // no `custom_image_context`, and those tasks must keep launching exactly as
  // they did. Launch reads `custom_image` and nothing else — the context key is
  // consent-time provenance, never a launch-time precondition — so an
  // unrecorded context can neither block a launch nor silently redirect one to
  // the root image.
  const legacyRef = `lazy-custom-0123456789ab:${IMAGE_TAG}`;

  function legacyPinnedTask(): Task {
    return makeTask({
      id: 'legacy',
      metadata: {
        [CUSTOM_IMAGE_META_KEY]: legacyRef,
        [CUSTOM_IMAGE_HASH_META_KEY]: 'a'.repeat(64),
        // No CUSTOM_IMAGE_CONTEXT_META_KEY — this is the whole point.
      },
    });
  }

  test('the pin still resolves with no recorded context', () => {
    const task = legacyPinnedTask();
    expect(pinnedCustomImage(task)).toBe(legacyRef);
    expect(pinnedCustomImageHash(task)).toBe('a'.repeat(64));
    expect(pinnedCustomImageContext(task)).toBeUndefined();
  });

  test('launch uses the stored image when it exists, without a context', async () => {
    const base = await mkdtemp(join(tmpdir(), 'lazy-wti-legacy-'));
    try {
      const docker = await installFakeDocker(base);
      await docker.seedImage(legacyRef, { dockerfileHash: 'a'.repeat(64) });

      const used = await ensureImage(docker.binPath, {
        pinnedImage: pinnedCustomImage(legacyPinnedTask())!,
      });

      expect(used).toBe(legacyRef);
      // Not rebuilt: a launch must never re-derive an image from worktree
      // content, and least of all from a context it was never told about.
      expect(await docker.builds()).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('a missing legacy image still fails loud rather than falling back', async () => {
    const base = await mkdtemp(join(tmpdir(), 'lazy-wti-legacy-miss-'));
    try {
      const docker = await installFakeDocker(base);
      await expect(
        ensureImage(docker.binPath, { pinnedImage: pinnedCustomImage(legacyPinnedTask())! }),
      ).rejects.toThrow(/will not fall back to the project root image/i);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('a subtask inherits a contextless pin without inventing a context', async () => {
    const parent = legacyPinnedTask();
    const child = makeTask({ id: 'child' });
    const storage = makeMetaStorage(new Map([['legacy', parent], ['child', child]])) as Storage;

    expect(await inheritCustomImageMetadata(storage, 'child', parent)).toBe(true);
    expect(pinnedCustomImage(child)).toBe(legacyRef);
    expect(pinnedCustomImageContext(child)).toBeUndefined();
    expect(Object.keys(child.metadata ?? {})).not.toContain(CUSTOM_IMAGE_CONTEXT_META_KEY);
  });
});
