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
 * change that would leave the daemon pointing at an image built for a different
 * lazy: on read, if the adoption's version no longer maps to the current image
 * tag (`imageTagFor`, i.e. major.minor) the file is deleted.
 *
 * WHY THE IMAGE TAG AND NOT THE FULL VERSION (fix-upgrade-image-rebuild-churn).
 * This rule is a LIFECYCLE rule, not a security one — the security posture is
 * the soft pin + content-hash drift + snapshot below, and none of it keys off
 * lazyVersion. Comparing the full VERSION expired every adoption on every
 * upgrade in a source checkout, because VERSION's patch component is the commit
 * count (scripts/version-string.ts): 0.23.1651 → 0.23.1658 across one upgrade.
 * The upgrade then built and promoted the adopted image, the restarted daemon
 * immediately expired the adoption, fell back to the ROOT Dockerfile identity
 * that nothing had built, and rebuilt it synchronously inside the first
 * sync/unblock RPC — a multi-minute stall right after an upgrade that had just
 * spent minutes building. The adopted image ref itself is only ever tagged
 * `:${IMAGE_TAG}` (major.minor — see src/capture/image-tag.ts for why that
 * granularity), so expiring at a finer granularity than the tag could not
 * describe a real image change. A genuine minor-version bump still expires.
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
 * cannot produce a mis-tagged image of unconsented bytes. The docker BUILD
 * CONTEXT is the worktree that held the consented Dockerfile
 * (`adoptedBuildContextRoot`), because its COPY paths name files on that
 * branch — the project root has a different tree.
 *
 * Deliberately NOT an env var and NOT lazy.toml — daemon runtime state only.
 * Per-task pins (metadata.custom_image) never touch this file.
 */

import { createHash } from 'crypto';
import { constants as fsConstants } from 'fs';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { getDataDir } from '../project-paths';
import { VERSION } from '../version';
import { IMAGE_TAG, imageTagFor } from '../capture/image-tag';
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
  /**
   * Lazy VERSION string at adoption. Adoption stays valid while this version
   * maps to the SAME image tag as the running binary (`imageTagFor`, major.minor)
   * — see the header for why not the full VERSION.
   */
  lazyVersion: string;
  /** ISO timestamp when adoption was written. */
  adoptedAt: string;
  /**
   * INFORMATIONAL ONLY: the worktree's HEAD when adoption was recorded, so
   * `lazy doctor` / `lazy upgrade` can say which branch state was consented
   * to. The build reads the worktree LIVE, so this is not a statement about
   * what went into the image. Optional — a record written before it existed
   * still parses, and nothing invalidates an adoption for lacking it.
   */
  contextCommit?: string;
  /**
   * Set when a project admin adopted the Dockerfile from a git REF (a branch
   * or a task's branch) through the daemon's `adoptImageFromRef` RPC — Lazy
   * Teams' way out of a failing Dockerfile.lazy (src/daemon/image-adoption.ts).
   * Absent for a `lazy upgrade` worktree adoption. A ref adoption differs in
   * two lifecycle rules, both because its inputs are lazy-owned copies of a
   * committed tree rather than a live worktree:
   *   - it does NOT expire on a minor-version bump: the daemon's boot build
   *     rebuilds it under the new image tag (expiring it would silently drop a
   *     Teams project back onto the broken file it was rescued from at the
   *     next fleet roll);
   *   - launches do not soft-pin `imageName`: it resolves as the project's
   *     custom Dockerfile and goes through the boot build's gate.
   */
  source?: RefAdoptionSource;
}

/** Where a ref adoption came from and who confirmed it. */
export interface RefAdoptionSource {
  kind: 'ref';
  /** What the admin picked: a branch name, or a task code/id. */
  ref: string;
  refKind: 'branch' | 'task';
  /** The branch actually read (a task's branch for `refKind: 'task'`). */
  branch: string;
  /** The commit whose tree was snapshotted as the build context. */
  commit: string;
  /** The Dockerfile's blob sha in that commit. */
  blob: string;
  /** The Dockerfile path inside the tree (`Dockerfile.lazy` or `[docker].dockerfile`). */
  dockerfile: string;
  adoptedBy: { email: string | null; name: string | null };
  /**
   * The project branch's blob of the same file when the adoption was made, or
   * null when it had none — so a later change on that branch can be shown as
   * "switch back?" without ever switching on its own.
   */
  mainBlobAtAdoption: string | null;
}

/**
 * Where a ref adoption's exported tree — its build CONTEXT — lives: inside the
 * project's own checkout (`<root>/.lazy/adopted-image/`), NEVER the daemon
 * dir. On Lazy Teams' microVM backend the daemon dir is mounted from the HOST,
 * and the host must never hold repository contents ("the repo is inside the
 * machine, never on this host"); only the small record lives there. The
 * checkout is inside the machine, and task containers mount it read-only.
 *
 * Derived from the record, never stored in it, so a recreated machine — whose
 * fresh clone has no such directory — re-exports it to the same place from the
 * recorded commit (`ensureRefAdoptionContext`, src/daemon/image-adoption.ts).
 * Per commit AND blob, so a new adoption never overwrites the one in force.
 */
export function refAdoptionContextsRoot(projectRoot: string): string {
  return join(projectRoot, getDataDir(projectRoot), 'adopted-image');
}

export function refAdoptionContextDir(projectRoot: string, source: RefAdoptionSource): string {
  return join(refAdoptionContextsRoot(projectRoot), `${source.commit.substring(0, 12)}-${source.blob.substring(0, 12)}`);
}

function isRefAdoptionSource(value: unknown): value is RefAdoptionSource {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const by = v.adoptedBy as Record<string, unknown> | undefined;
  const nullableString = (x: unknown) => x === null || typeof x === 'string';
  return v.kind === 'ref' && typeof v.ref === 'string' && (v.refKind === 'branch' || v.refKind === 'task') &&
    typeof v.branch === 'string' && typeof v.commit === 'string' && typeof v.blob === 'string' &&
    typeof v.dockerfile === 'string' && !!by && typeof by === 'object' &&
    nullableString(by.email) && nullableString(by.name) && nullableString(v.mainBlobAtAdoption);
}

function isAdoptedImageState(value: unknown): value is AdoptedImageState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const optionalString = (x: unknown) => x === undefined || typeof x === 'string';
  return (
    typeof v.dockerfilePath === 'string' &&
    typeof v.contentHash === 'string' &&
    typeof v.imageName === 'string' &&
    typeof v.lazyVersion === 'string' &&
    typeof v.adoptedAt === 'string' &&
    optionalString(v.contextCommit) &&
    (v.source === undefined || isRefAdoptionSource(v.source))
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
  options: {
    content?: string;
    /**
     * false: write the record ONLY (a ref adoption, whose Dockerfile already
     * lives in its own lazy-owned context — the flat snapshot is the worktree
     * adoption's). Default true.
     */
    snapshot?: boolean;
  } = {},
): Promise<AdoptedImageState> {
  const full: AdoptedImageState = {
    dockerfilePath: state.dockerfilePath,
    contentHash: state.contentHash,
    imageName: state.imageName,
    lazyVersion: state.lazyVersion ?? VERSION,
    adoptedAt: state.adoptedAt ?? new Date().toISOString(),
    ...(state.contextCommit === undefined ? {} : { contextCommit: state.contextCommit }),
    ...(state.source === undefined ? {} : { source: state.source }),
  };

  // Prefer the caller-supplied consented bytes; else snapshot from the
  // worktree path when readable. Missing path (test / expired fixture) still
  // writes JSON so inspect can report missing-dockerfile — no snapshot then.
  let content = options.snapshot === false ? undefined : options.content;
  if (content === undefined && options.snapshot !== false) {
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

  // Published atomically: a reader sees the previous record or this one,
  // never a torn file, and a failed write leaves the previous one in force.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(full, null, 2)}\n`, 'utf-8');
  await rename(tmp, path);
  // A ref adoption keeps its Dockerfile in its own context; a flat snapshot
  // left by an earlier `lazy upgrade` adoption would describe another image.
  if (options.snapshot === false) {
    // Logged, never thrown: the record above is already published, and a
    // throw here would make the caller treat a live adoption as failed.
    await unlink(getAdoptedDockerfilePath(projectRoot)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') logger.warn(`could not remove the stale adopted Dockerfile snapshot: ${err.message}`);
    });
  }
  return full;
}

/**
 * Delete the adoption file and its Dockerfile snapshot. No-op when absent.
 * Called at the start of every upgrade rebuild so a prior adoption cannot
 * outlive the next decision, and on image-tag expiry / missing Dockerfile /
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
 * Load adoption and enforce the lifecycle: the image tag must match, Dockerfile
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
      `Adopted image expired (was for lazy ${result.state.lazyVersion} → image tag ` +
        `${imageTagFor(result.state.lazyVersion)}, now ${VERSION} → ${IMAGE_TAG}) — ` +
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

  // Expire at the granularity the adopted image ref itself uses (major.minor),
  // not the full VERSION — see the header: the commit-count patch component
  // advances on every upgrade in a source checkout, and expiring on it made
  // every upgrade throw away the image it had just built.
  if (state.source?.kind !== 'ref' && imageTagFor(state.lazyVersion) !== IMAGE_TAG) {
    return { status: 'expired', state };
  }

  // A ref adoption's Dockerfile lives in a context that a recreated machine
  // does not have yet: its presence and bytes are checked — and the context
  // re-exported from the recorded commit when missing — where it is RESOLVED
  // (resolveRefAdoptedDockerfileSnapshot), never by clearing the adoption here.
  if (state.source?.kind === 'ref') return { status: 'valid', state };

  if (!(await pathExists(state.dockerfilePath))) {
    return { status: 'missing-dockerfile', state };
  }

  // Compare current worktree file bytes to the hash consented at adoption time.
  // The worktree is agent-writable, so the read is bounded (see
  // readConsentedDockerfile): anything it will not read cannot be the bytes a
  // human consented to, and is drift.
  const current = await readConsentedDockerfile(state.dockerfilePath);
  if (current === 'missing') return { status: 'missing-dockerfile', state };
  if (current === 'not-a-dockerfile' || hashDockerfileContent(current) !== state.contentHash) {
    return { status: 'content-drifted', state };
  }

  return { status: 'valid', state };
}

/** Larger than any Dockerfile; the same cap `lazy_image_build` reads under. */
const MAX_CONSENTED_DOCKERFILE_BYTES = 1024 * 1024;

/**
 * Read an adopted worktree Dockerfile for the drift check without letting an
 * agent hang or exhaust the daemon: O_NOFOLLOW (a symlink is not the file that
 * was consented to), O_NONBLOCK (a FIFO cannot block the read), fstat on the
 * open descriptor must say regular file, and the read is capped by bytes
 * actually read — a file still growing cannot make the daemon buffer forever.
 */
export async function readConsentedDockerfile(path: string): Promise<string | 'missing' | 'not-a-dockerfile'> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    if (code === 'ELOOP' || code === 'EMLINK') return 'not-a-dockerfile';
    logger.warn(`adopted image: could not open ${path} for the drift check: ${(err as Error).message}`);
    return 'missing';
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > MAX_CONSENTED_DOCKERFILE_BYTES) return 'not-a-dockerfile';
    const buf = Buffer.alloc(MAX_CONSENTED_DOCKERFILE_BYTES + 1);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > MAX_CONSENTED_DOCKERFILE_BYTES) return 'not-a-dockerfile';
    return buf.subarray(0, filled).toString('utf-8');
  } finally {
    await handle.close();
  }
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
 * The consented snapshot of a REF adoption, for every resolution of the
 * project's custom Dockerfile (launches included — see the RefAdoptionSource
 * comment). Null when there is no valid ref adoption. Registers a human label
 * for the snapshot so build announcements and the status surfaces name the
 * branch and commit rather than a daemon-dir path.
 */
export async function resolveRefAdoptedDockerfileSnapshot(projectRoot: string): Promise<string | null> {
  // The Dockerfile inside the adoption's own lazy-owned context, its bytes
  // checked against the consented hash — re-exported from the recorded commit
  // first if the context is missing (a recreated machine). Throws
  // RefAdoptionUnavailableError when that commit is gone: never a silent
  // switch back to the project's own file.
  const adopted = await loadValidAdoptedImage(projectRoot);
  if (adopted?.source?.kind !== 'ref') return null;
  const { ensureRefAdoptionContext } = await import('./image-adoption');
  const path = await ensureRefAdoptionContext(projectRoot, adopted);
  const { labelDockerfileSource } = await import('../capture/claude');
  labelDockerfileSource(path, describeRefAdoption(adopted.source));
  return path;
}

/** "Dockerfile.lazy from lazy/fix-image (abc123def456)" — one phrase for every surface. */
export function describeRefAdoption(source: RefAdoptionSource): string {
  return `${source.dockerfile} from ${source.branch} (${source.commit.substring(0, 12)}), adopted`;
}

/**
 * The directory an adopted image must be built with as its docker context, when
 * `dockerfilePath` is the adopted snapshot. Null for any other Dockerfile —
 * notably the root `[docker].dockerfile`, which keeps the project root.
 *
 * It is the WORKTREE that held the consented Dockerfile, not the snapshot
 * file's own directory (that holds only the Dockerfile). Derived from the
 * recorded worktree path rather than stored as a second field, so an adoption
 * written by any version — including one predating build contexts entirely —
 * resolves the same way.
 */
export async function adoptedBuildContextRoot(
  projectRoot: string,
  dockerfilePath: string,
): Promise<string | null> {
  const adopted = await loadValidAdoptedImage(projectRoot);
  if (!adopted) return null;
  // A ref adoption builds against the ROOT of its exported tree, wherever in
  // it the Dockerfile sits.
  if (adopted.source?.kind === 'ref') {
    const ctx = refAdoptionContextDir(projectRoot, adopted.source);
    return dockerfilePath === join(ctx, adopted.source.dockerfile) ? ctx : null;
  }
  if (dockerfilePath !== getAdoptedDockerfilePath(projectRoot)) return null;
  return dirname(adopted.dockerfilePath);
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
