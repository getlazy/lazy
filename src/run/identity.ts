/**
 * The names a COMMIT RUN goes by — the product running at one commit without a
 * task (src/daemon/commit-run.ts). Pure, so every rule here is testable
 * without git, docker or a store.
 *
 * A run is addressed in three places, and all three are DERIVED from its slug
 * rather than stored on its row: its service hostname, its checkout's
 * directory and its container's name. A row is not trusted to name a directory
 * lazy deletes or a container lazy removes — the slug is checked against
 * {@link isRunSlug} before any of them is computed.
 */

import { createHash } from 'crypto';
import { join } from 'path';
import { getDataDir } from '../project-paths';
import type { CommitRun, CommitRunTarget } from '../storage/types';

/** Longest slug a BRANCH run gets — room for `--<service>--p<id>` under a 63-character DNS label. */
export const MAX_BRANCH_SLUG_LENGTH = 40;

/** How many hex digits of a commit a sha run's slug carries. */
export const SHA_SLUG_HEX = 12;

/** Prefix of every sha run's slug. */
export const SHA_SLUG_PREFIX = 'sha-';

/**
 * Prefix of a run checkout's directory under `<root>/.lazy/worktrees/`. No task
 * code can start with `lazy-` (src/task/identity.ts reserves it), so a run's
 * checkout can never be mistaken for a task's, while the path-shaped helpers
 * (git pointer checks, the `.lazy/` mask, the split git mounts) still treat it
 * exactly like one.
 */
export const RUN_WORKTREE_PREFIX = 'lazy-run-';

/**
 * Prefix of a run container's name. Deliberately NOT `lazy-`: every sweep that
 * treats a `^lazy-` container as a task supervisor (shutdown, the restart
 * reaper) must never take a run's container for one. Runs are found by label.
 */
export const RUN_CONTAINER_PREFIX = 'lazyrun-';

/** Label every run container carries; its value is the run id. */
export const RUN_CONTAINER_LABEL = 'lazy.commit-run';

/** A slug lazy itself could have produced: a DNS label of at most 63 characters. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isRunSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

/** A full or abbreviated commit id as a person would type it. */
export function isShaLike(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

/**
 * The slug of a branch run: the branch name lowercased, every run of
 * characters that cannot be in a DNS label turned into one `-`, trimmed, and
 * cut to {@link MAX_BRANCH_SLUG_LENGTH}. `feature/Login.v2` → `feature-login-v2`.
 * A name with nothing usable in it gets `branch-<8 hex of its sha256>`.
 */
export function branchRunSlug(branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_BRANCH_SLUG_LENGTH)
    .replace(/-+$/, '');
  if (slug) return slug;
  return `branch-${createHash('sha256').update(branch).digest('hex').slice(0, 8)}`;
}

/** The slug of a sha run: `sha-<first 12 hex>`. */
export function shaRunSlug(sha: string): string {
  return `${SHA_SLUG_PREFIX}${sha.toLowerCase().slice(0, SHA_SLUG_HEX)}`;
}

export function runSlugFor(target: CommitRunTarget): string {
  return target.kind === 'branch' ? branchRunSlug(target.branch) : shaRunSlug(target.sha);
}

/** Whether two targets name the same thing (one run per branch, one per commit). */
export function sameRunTarget(a: CommitRunTarget, b: CommitRunTarget): boolean {
  if (a.kind === 'branch' && b.kind === 'branch') return a.branch === b.branch;
  if (a.kind === 'sha' && b.kind === 'sha') return a.sha.toLowerCase() === b.sha.toLowerCase();
  return false;
}

/** `branch main` / `commit 1a2b3c4d5e6f` — for messages. */
export function describeCommitRunTarget(run: Pick<CommitRun, 'target'>): string {
  return run.target.kind === 'branch'
    ? `branch ${run.target.branch}`
    : `commit ${run.target.sha.slice(0, SHA_SLUG_HEX)}`;
}

function assertSlug(slug: string): void {
  if (!isRunSlug(slug)) throw new Error(`Refusing to act on a run whose slug '${slug}' is not one lazy produces.`);
}

/** The run's checkout: `<root>/.lazy/worktrees/lazy-run-<slug>`. */
export function runWorktreePath(projectRoot: string, slug: string): string {
  assertSlug(slug);
  return join(projectRoot, getDataDir(projectRoot), 'worktrees', `${RUN_WORKTREE_PREFIX}${slug}`);
}

/**
 * The run's container: `lazyrun-<slug>-<8 hex of the project root>`. The
 * project part keeps two projects sharing one container runtime — both running
 * `main`, the commonest run there is — from fighting over one name.
 */
export function runContainerName(projectRoot: string, slug: string): string {
  assertSlug(slug);
  const project = createHash('sha256').update(projectRoot).digest('hex').slice(0, 8);
  return `${RUN_CONTAINER_PREFIX}${slug}-${project}`;
}

/** The session id a terminal attaches to a run's container with (src/daemon/session-attach.ts). */
export const RUN_ATTACH_PREFIX = 'run:';

export function runAttachSessionId(runId: string): string {
  return `${RUN_ATTACH_PREFIX}${runId}`;
}

/** The dashboard path a client renders a run at; the service proxy redirects a dead run's navigation there. */
export function runPagePath(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}
