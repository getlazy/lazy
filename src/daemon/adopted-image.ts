/**
 * Daemon-adopted worktree image (Part 2 of add-worktree-image-flow).
 *
 * When `lazy upgrade` runs from a task worktree and the human consents, the
 * worktree's Dockerfile.lazy is built as a content-addressed lazy-custom-<hash>
 * image and this file records the adoption under the daemon dir:
 *
 *   ~/.lazy/daemon/<slug>/adopted-image.json
 *   ~/.lazy/daemon/<slug>/adopted-Dockerfile   ← consented bytes for builds
 *
 * The adopted image applies to the daemon and ALL launches that do not already
 * have a Part 1 per-task pin. It STICKS until the next upgrade rebuild decides
 * again (clear or rewrite), and it MUST NOT silently outlive a binary version
 * change: on read, if lazyVersion !== current VERSION the file is deleted.
 *
 * SECURITY: launches treat adoption as a soft pin on `imageName` — they never
 * re-hash / rebuild from `dockerfilePath`. A task agent can edit the worktree
 * Dockerfile after consent; rebuilding from that path would run those edits as
 * host docker build steps. If the file's content hash drifts from `contentHash`,
 * adoption is cleared (fall through to root). If the image is missing locally,
 * launches fail loud — same posture as a Part 1 pin.
 *
 * Upgrade's own build (latch on) resolves the *snapshot* (`adopted-Dockerfile`),
 * never the live worktree path — so a write between consent and `docker build`
 * cannot produce a mis-tagged image of unconsented bytes.
 *
 * Deliberately NOT an env var and NOT lazy.toml — daemon runtime state only.
 * Per-task pins (metadata.custom_image) never touch this file.
 */

import { createHash } from 'crypto';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { VERSION } from '../version';
import { pathExists } from '../utils/fs';
import { logger } from '../utils/logger';
import { getAdoptedDockerfilePath, getAdoptedImagePath } from './paths';

export interface AdoptedImageState {
  /**
   * Absolute path to the WORKTREE Dockerfile that was adopted — used for
   * post-consent drift detection only. Upgrade builds read the snapshot at
   * getAdoptedDockerfilePath(), not this path.
   */
  dockerfilePath: string;
  /** Full sha256 of that Dockerfile's content at adoption time. */
  contentHash: string;
  /** Full image ref, e.g. lazy-custom-abc123def456:0.22 */
  imageName: string;
  /** Lazy VERSION string at adoption — must match current VERSION to stay valid. */
  lazyVersion: string;
  /** ISO timestamp when adoption was written. */
  adoptedAt: string;
}

function isAdoptedImageState(value: unknown): value is AdoptedImageState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.dockerfilePath === 'string' &&
    typeof v.contentHash === 'string' &&
    typeof v.imageName === 'string' &&
    typeof v.lazyVersion === 'string' &&
    typeof v.adoptedAt === 'string'
  );
}

/** Full sha256 of Dockerfile text — must match what writeAdoptedImage stores. */
export function hashDockerfileContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Read the adoption file without validating VERSION or path existence.
 * Returns null when missing or unparseable. Prefer `loadValidAdoptedImage`
 * for launch/resolution paths.
 */
export async function readAdoptedImage(
  projectRoot: string,
): Promise<AdoptedImageState | null> {
  const path = getAdoptedImagePath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new Error(
      `failed to read adopted image state at ${path}: ${err instanceof Error ? err.message : err}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `failed to parse adopted image state at ${path}: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (!isAdoptedImageState(parsed)) {
    throw new Error(
      `adopted image state at ${path} is missing required fields ` +
        `(dockerfilePath, contentHash, imageName, lazyVersion, adoptedAt)`,
    );
  }
  return parsed;
}

/**
 * Persist adoption. Creates the daemon dir if needed. Overwrites any prior
 * adoption for this project.
 *
 * When `content` is provided (or the worktree Dockerfile is readable), also
 * writes `adopted-Dockerfile` with those exact bytes — the only file upgrade
 * builds may read. Pass `content` from the consent prompt so the snapshot is
 * the bytes the human saw, not a later re-read of the worktree.
 */
export async function writeAdoptedImage(
  projectRoot: string,
  state: Omit<AdoptedImageState, 'lazyVersion' | 'adoptedAt'> & {
    lazyVersion?: string;
    adoptedAt?: string;
  },
  options: { content?: string } = {},
): Promise<AdoptedImageState> {
  const full: AdoptedImageState = {
    dockerfilePath: state.dockerfilePath,
    contentHash: state.contentHash,
    imageName: state.imageName,
    lazyVersion: state.lazyVersion ?? VERSION,
    adoptedAt: state.adoptedAt ?? new Date().toISOString(),
  };

  // Prefer the caller-supplied consented bytes; else snapshot from the
  // worktree path when readable. Missing path (test / expired fixture) still
  // writes JSON so inspect can report missing-dockerfile — no snapshot then.
  let content = options.content;
  if (content === undefined) {
    try {
      content = await readFile(state.dockerfilePath, 'utf-8');
    } catch {
      content = undefined;
    }
  }

  const path = getAdoptedImagePath(projectRoot);
  await mkdir(dirname(path), { recursive: true });

  if (content !== undefined) {
    const hash = hashDockerfileContent(content);
    if (hash !== full.contentHash) {
      throw new Error(
        `cannot write adopted image: content hash ${hash.slice(0, 12)}… does not match ` +
          `recorded contentHash ${full.contentHash.slice(0, 12)}… — refusing to snapshot mismatched bytes`,
      );
    }
    await writeFile(getAdoptedDockerfilePath(projectRoot), content, 'utf-8');
  }

  await writeFile(path, `${JSON.stringify(full, null, 2)}\n`, 'utf-8');
  return full;
}

/**
 * Delete the adoption file and its Dockerfile snapshot. No-op when absent.
 * Called at the start of every upgrade rebuild so a prior adoption cannot
 * outlive the next decision, and on VERSION expiry / missing Dockerfile /
 * content drift.
 */
export async function clearAdoptedImage(projectRoot: string): Promise<boolean> {
  const path = getAdoptedImagePath(projectRoot);
  const snapshot = getAdoptedDockerfilePath(projectRoot);
  let cleared = false;

  try {
    await unlink(path);
    cleared = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new Error(
        `failed to clear adopted image state at ${path}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  try {
    await unlink(snapshot);
    cleared = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new Error(
        `failed to clear adopted Dockerfile snapshot at ${snapshot}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return cleared;
}

export type AdoptedImageLoadResult =
  | { status: 'none' }
  | { status: 'valid'; state: AdoptedImageState }
  | { status: 'expired'; state: AdoptedImageState }
  | { status: 'missing-dockerfile'; state: AdoptedImageState }
  | { status: 'content-drifted'; state: AdoptedImageState };

/**
 * Load adoption and enforce the lifecycle: VERSION must match, Dockerfile
 * must still exist with the consented content hash. Expired / missing /
 * drifted states are cleared so they cannot wedge launches or rebuild from
 * post-consent agent edits.
 *
 * Pass `expire: false` for read-only surfaces (doctor) that want to report
 * the raw state without mutating it — rare; default is to expire in place.
 */
export async function loadValidAdoptedImage(
  projectRoot: string,
  options: { expire?: boolean } = {},
): Promise<AdoptedImageState | null> {
  const result = await inspectAdoptedImage(projectRoot);
  const expire = options.expire !== false;

  if (result.status === 'valid') return result.state;

  if (result.status === 'expired') {
    logger.info(
      `Adopted image expired (was for lazy ${result.state.lazyVersion}, now ${VERSION}) — ` +
        `clearing ${getAdoptedImagePath(projectRoot)}. Re-run \`lazy upgrade\` from a worktree to adopt again.`,
    );
    if (expire) await clearAdoptedImage(projectRoot);
    return null;
  }

  if (result.status === 'missing-dockerfile') {
    // Do not wedge every launch on a deleted worktree path — that was the
    // stale-env-override incident. Clear and fall through to root.
    logger.warn(
      `Adopted Dockerfile missing at ${result.state.dockerfilePath} — clearing adoption. ` +
        `Container images fall back to [docker].dockerfile until the next upgrade adopts again.`,
    );
    if (expire) await clearAdoptedImage(projectRoot);
    return null;
  }

  if (result.status === 'content-drifted') {
    // INVARIANT: never rebuild from a worktree Dockerfile that changed after
    // human consent — an agent could have edited it. Clear; require a new TTY
    // upgrade prompt to adopt again.
    logger.warn(
      `Adopted Dockerfile at ${result.state.dockerfilePath} changed after consent ` +
        `(hash ${result.state.contentHash.slice(0, 12)}… no longer matches) — clearing adoption. ` +
        `Re-run \`lazy upgrade\` from a worktree TTY to adopt the new content.`,
    );
    if (expire) await clearAdoptedImage(projectRoot);
    return null;
  }

  return null;
}

/**
 * Classify adoption without mutating (unless you then call clear yourself).
 * Used by doctor and tests; launch paths use `loadValidAdoptedImage`.
 *
 * Drift / missing checks use the LIVE worktree path in state.dockerfilePath —
 * that is what an agent can edit. The snapshot is for builds only.
 */
export async function inspectAdoptedImage(
  projectRoot: string,
): Promise<AdoptedImageLoadResult> {
  const state = await readAdoptedImage(projectRoot);
  if (!state) return { status: 'none' };

  if (state.lazyVersion !== VERSION) {
    return { status: 'expired', state };
  }

  if (!(await pathExists(state.dockerfilePath))) {
    return { status: 'missing-dockerfile', state };
  }

  // Compare current worktree file bytes to the hash consented at adoption time.
  let current: string;
  try {
    current = await readFile(state.dockerfilePath, 'utf-8');
  } catch {
    // Unreadable after exists check — treat like missing (clear, don't rebuild).
    return { status: 'missing-dockerfile', state };
  }
  if (hashDockerfileContent(current) !== state.contentHash) {
    return { status: 'content-drifted', state };
  }

  return { status: 'valid', state };
}

/**
 * Absolute path of the consented Dockerfile snapshot used by upgrade builds.
 * Returns null when adoption is invalid or the snapshot was never written.
 */
export async function resolveAdoptedDockerfileSnapshot(
  projectRoot: string,
): Promise<string | null> {
  const adopted = await loadValidAdoptedImage(projectRoot);
  if (!adopted) return null;

  const snapshot = getAdoptedDockerfilePath(projectRoot);
  if (!(await pathExists(snapshot))) {
    // JSON without a snapshot (pre-TOCTOU adoption, or write that skipped
    // because the worktree path was already gone): do not fall back to the
    // worktree path — that reopens the hash/build TOCTOU. Clear and rebuild
    // via a fresh TTY upgrade.
    logger.warn(
      `Adopted Dockerfile snapshot missing at ${snapshot} — clearing adoption. ` +
        `Re-run \`lazy upgrade\` from a worktree TTY to adopt again.`,
    );
    await clearAdoptedImage(projectRoot);
    return null;
  }
  return snapshot;
}

/**
 * Error text when a daemon-adopted image is missing at launch.
 * Exported so unit tests lock the "fail loud / how to re-adopt" contract.
 */
export function missingAdoptedImageMessage(imageName: string): string {
  return (
    `This project has a daemon-adopted container image "${imageName}", but that image is not present locally. ` +
    `It was likely removed (docker image rm / docker system prune). ` +
    `Lazy will not fall back to the project root image while adoption is in effect. ` +
    `To rebuild and re-adopt: from a task worktree whose Dockerfile.lazy you want, run ` +
    `\`lazy upgrade\` (or \`lazy upgrade --images\`) on a TTY and accept the adoption prompt.`
  );
}
