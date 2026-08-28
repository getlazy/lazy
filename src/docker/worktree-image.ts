/**
 * Per-task worktree image: human-consented custom images from a task worktree.
 *
 * INVARIANT: a worktree's Dockerfile.lazy reaches the host's docker build ONLY
 * through a human answering a TTY prompt on create/start/edit. Non-TTY, --yes,
 * MCP, builder, and scripts never prompt and never pin — they keep the
 * root-resolved image. Agents must not be able to choose the image.
 *
 * Persistence is task metadata (not a first-class Task field):
 *   custom_image      — full image ref, e.g. lazy-custom-abc123def456:0.22
 *   custom_image_hash — full sha256 of the Dockerfile content that was built
 *
 * Launch resolution: stored task image if set (fail loud if missing), else
 * daemon-adopted image (Part 2), else root.
 */

import { createHash } from 'crypto';
import { readFile, realpath } from 'fs/promises';
import { isAbsolute, join, relative } from 'path';
import { getDataDir } from '../cli/init';
import { isTTY, promptYesNo } from '../cli/editor';
import { theme } from '../cli/theme';
import {
  buildImageFromDockerfilePath,
  localImageExists,
  resolveCustomDockerfile,
} from '../capture/claude';
import { getRemoteDefaultBranch } from '../git/operations';
import type { Storage } from '../storage/interface';
import type { Task } from '../types';
import { pathExists } from '../utils/fs';
import { runGit } from '../utils/git';

/** Dockerfile filename compared and offered from a task worktree. */
export const WORKTREE_DOCKERFILE = 'Dockerfile.lazy';

/** Task metadata: full image ref pinned for every later turn. */
export const CUSTOM_IMAGE_META_KEY = 'custom_image';

/** Task metadata: full sha256 of the Dockerfile content used for the pin. */
export const CUSTOM_IMAGE_HASH_META_KEY = 'custom_image_hash';

/**
 * Return the absolute cwd when it is a lazy task worktree under `projectRoot`,
 * otherwise null. Uses realpath so symlink spellings (macOS /var vs /private/var)
 * do not false-negative.
 */
export async function lazyTaskWorktreeCwd(projectRoot: string): Promise<string | null> {
  let cwd: string;
  let root: string;
  try {
    cwd = await realpath(process.cwd());
    root = await realpath(projectRoot);
  } catch {
    // Unreadable cwd/root — treat as "not a worktree" so optional prompts never
    // fail the surrounding command.
    return null;
  }

  if (cwd === root) return null;

  const worktreesDir = join(root, getDataDir(root), 'worktrees');
  if (!(await pathExists(worktreesDir))) return null;

  let worktreesReal: string;
  try {
    worktreesReal = await realpath(worktreesDir);
  } catch {
    return null;
  }

  const rel = relative(worktreesReal, cwd);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;

  return cwd;
}

/** Full sha256 of Dockerfile (or other) text — matches what we store on the task. */
export function dockerfileContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export interface DockerfileReference {
  /** File contents to hash-compare against the worktree copy. */
  content: string;
  /** Short label for the prompt ("origin/main", a path, …). */
  label: string;
}

/**
 * Reference Dockerfile for "does this worktree differ?" comparison.
 *
 * Prefer `origin/<default-branch>:Dockerfile.lazy` when origin exists and that
 * blob is readable; otherwise the project root's resolved `[docker].dockerfile`
 * (or root `Dockerfile.lazy`).
 */
export async function resolveDockerfileReference(
  projectRoot: string,
): Promise<DockerfileReference | null> {
  const fromOrigin = await readOriginDefaultDockerfile(projectRoot);
  if (fromOrigin) return fromOrigin;
  return readRootReferenceDockerfile(projectRoot);
}

async function readOriginDefaultDockerfile(
  projectRoot: string,
): Promise<DockerfileReference | null> {
  // Confirm origin exists before treating getRemoteDefaultBranch's "main"
  // fallback as a real remote ref.
  const remote = await runGit(['remote', 'get-url', 'origin'], {
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (remote.exitCode !== 0) return null;

  const branch = await getRemoteDefaultBranch(projectRoot);
  const show = await runGit(['show', `origin/${branch}:${WORKTREE_DOCKERFILE}`], {
    cwd: projectRoot,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (show.exitCode !== 0) return null;

  return { content: show.stdout, label: `origin/${branch}` };
}

async function readRootReferenceDockerfile(
  projectRoot: string,
): Promise<DockerfileReference | null> {
  try {
    const custom = await resolveCustomDockerfile(projectRoot);
    if (custom) {
      return { content: await readFile(custom, 'utf-8'), label: custom };
    }
  } catch {
    // Config names a missing file — fall through to the conventional root name.
  }

  const rootDf = join(projectRoot, WORKTREE_DOCKERFILE);
  if (await pathExists(rootDf)) {
    return {
      content: await readFile(rootDf, 'utf-8'),
      label: `${WORKTREE_DOCKERFILE} (project root)`,
    };
  }
  return null;
}

export interface WorktreeDockerfileDiff {
  worktreeDockerfile: string;
  worktreeHash: string;
  referenceLabel: string;
  referenceHash: string | null;
  differs: boolean;
}

/**
 * Compare the cwd worktree's Dockerfile.lazy to the reference.
 * Returns null when cwd is not a task worktree or has no Dockerfile.lazy.
 */
export async function detectWorktreeDockerfileDiff(
  projectRoot: string,
): Promise<WorktreeDockerfileDiff | null> {
  const worktreeCwd = await lazyTaskWorktreeCwd(projectRoot);
  if (!worktreeCwd) return null;

  const worktreeDockerfile = join(worktreeCwd, WORKTREE_DOCKERFILE);
  if (!(await pathExists(worktreeDockerfile))) return null;

  const worktreeContent = await readFile(worktreeDockerfile, 'utf-8');
  const worktreeHash = dockerfileContentHash(worktreeContent);
  const reference = await resolveDockerfileReference(projectRoot);
  const referenceHash = reference ? dockerfileContentHash(reference.content) : null;
  const differs = referenceHash === null || referenceHash !== worktreeHash;

  return {
    worktreeDockerfile,
    worktreeHash,
    referenceLabel: reference?.label ?? 'project root',
    referenceHash,
    differs,
  };
}

/** Read the pinned image ref from task metadata, if any. */
export function pinnedCustomImage(task: Task | null | undefined): string | undefined {
  const image = task?.metadata?.[CUSTOM_IMAGE_META_KEY];
  return image && image.length > 0 ? image : undefined;
}

/** Read the pinned Dockerfile content hash from task metadata, if any. */
export function pinnedCustomImageHash(task: Task | null | undefined): string | undefined {
  const hash = task?.metadata?.[CUSTOM_IMAGE_HASH_META_KEY];
  return hash && hash.length > 0 ? hash : undefined;
}

/**
 * Copy parent custom_image / custom_image_hash onto a newly created child.
 * No-op when the parent has no pin. Used by CLI and MCP create alike.
 */
export async function inheritCustomImageMetadata(
  storage: Storage,
  childTaskId: string,
  parent: Task | null | undefined,
): Promise<boolean> {
  const image = pinnedCustomImage(parent);
  const hash = pinnedCustomImageHash(parent);
  if (!image || !hash) return false;

  await storage.updateTaskMetadata(childTaskId, CUSTOM_IMAGE_META_KEY, image);
  await storage.updateTaskMetadata(childTaskId, CUSTOM_IMAGE_HASH_META_KEY, hash);
  return true;
}

/**
 * Warning for clone/redo when the source task had a per-task image pin.
 * Clone and redo are fresh starts — they use the root-resolved image, not an
 * inherited pin (which may be missing or stale and fail late). Subtask create
 * still uses inheritCustomImageMetadata.
 */
export function droppedCustomImagePinWarning(task: Task | null | undefined): string | null {
  const image = pinnedCustomImage(task);
  if (!image) return null;
  return (
    `Source task had a custom container image pin (${image}) — this fresh task uses the ` +
    `project root image. To use that image again, run lazy start or lazy edit from a ` +
    `task worktree TTY and accept the image prompt.`
  );
}

export interface OfferWorktreeImageOptions {
  /**
   * When true (CLI `--yes`, non-interactive scripts), never prompt.
   * MCP/builder never call this helper.
   */
  skipPrompt?: boolean;
  /** Container runtime binary (docker/podman). Defaults to docker. */
  binary?: string;
}

/**
 * CLI-only, TTY-only: if cwd is a task worktree whose Dockerfile.lazy differs
 * from the reference, ask whether to build it and pin it on `taskId`.
 *
 * Default NO. On yes: build content-addressed lazy-custom-<hash> and persist
 * metadata. Skips when the task already has a pin whose image is still local
 * (ask once); if the pin's image is gone, offers rebuild (recovery).
 *
 * Returns the image ref when newly pinned (or rebuilt), null otherwise.
 */
export async function maybeOfferWorktreeImageForTask(
  projectRoot: string,
  storage: Storage,
  taskId: string,
  options: OfferWorktreeImageOptions = {},
): Promise<string | null> {
  // Non-TTY / --yes / scripts: never prompt, never pin from a worktree.
  if (options.skipPrompt || !isTTY()) return null;

  const diff = await detectWorktreeDockerfileDiff(projectRoot);
  if (!diff || !diff.differs) return null;

  const task = await storage.getTask(taskId);
  if (!task) return null;

  const existing = pinnedCustomImage(task);
  if (existing) {
    const binary = options.binary ?? 'docker';
    // Already pinned and still present — ask once, do not re-prompt.
    if (await localImageExists(existing, binary)) return null;
    // Pin is stale (pruned). Fall through so the human can rebuild.
  }

  console.log('');
  const accepted = await promptYesNo(
    `This worktree's ${WORKTREE_DOCKERFILE} differs from ${diff.referenceLabel} — ` +
      `build it and use it for this task? Build steps run under the host's docker.`,
    false,
  );
  if (!accepted) return null;

  const binary = options.binary ?? 'docker';
  const built = await buildImageFromDockerfilePath(
    projectRoot,
    diff.worktreeDockerfile,
    { binary },
  );

  await storage.updateTaskMetadata(taskId, CUSTOM_IMAGE_META_KEY, built.imageName);
  await storage.updateTaskMetadata(taskId, CUSTOM_IMAGE_HASH_META_KEY, built.contentHash);

  console.log(
    `  ${theme.success('Pinned')} ${built.imageName} for this task ` +
      `(hash ${built.contentHash.slice(0, 12)}…). Later turns use it with no prompt.`,
  );
  console.log('');

  return built.imageName;
}

/**
 * Error text when a task's pinned image is missing at launch.
 * Exported so unit tests lock the "fail loud / how to rebuild" contract.
 */
export function missingPinnedImageMessage(
  imageName: string,
  taskLabel?: string,
): string {
  const where = taskLabel ? `Task ${taskLabel} is` : 'This task is';
  return (
    `${where} pinned to container image "${imageName}", but that image is not present locally. ` +
    `It was likely removed (docker image rm / docker system prune). ` +
    `Lazy will not fall back to the project root image mid-task. ` +
    `To rebuild: from a task worktree whose Dockerfile.lazy you want, run ` +
    `\`lazy edit <task>\` or \`lazy start <task>\` on a TTY and accept the Dockerfile prompt ` +
    `(the missing pin is treated as rebuildable).`
  );
}
