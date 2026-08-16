/**
 * Git LFS detection and integrity primitives.
 *
 * ## The defect class
 *
 * Proven incident (a lazy-managed project, 2026-08): a repository tracked
 * `datasets/**` with `filter=lfs`. In the environment the agent committed from,
 * `filter.lfs.process` was set but EMPTY and `filter.lfs.required` was false.
 * Git's documented behaviour in that state is to skip the clean filter and store
 * the file verbatim — `git add` exited 0, printed nothing, and committed a
 * 335 MB raw blob where a 134-byte pointer belonged. The commit landed on a lazy
 * task branch, the push failed on the forge's 100 MiB blob limit, and recovering
 * took manual history surgery.
 *
 * The enemy is git's own semantics: **with `filter.lfs.required=false` a missing
 * or broken filter is not an error.** "Nothing errored" is precisely the failure
 * mode, which is why this cannot be left to the agent to notice. Verified
 * locally: with `required=true` the same `git add` fails with
 * `fatal: <path>: clean filter 'lfs' failed`; with `required=false` it succeeds
 * silently.
 *
 * ## What this module is for
 *
 * Two independent layers use it, and neither needs the `git-lfs` binary:
 *
 * - {@link inspectLfsEnvironment} answers "would a commit made here be correct?"
 *   before an agent is ever launched (`src/daemon/task-launcher.ts`, and the
 *   `lazy doctor` check that carries the full remedy).
 * - {@link findNonPointerLfsBlobs} answers "did a commit made anywhere store raw
 *   bytes on an LFS path?" at accept time (`src/protection/lfs-guard.ts`). This
 *   is the backstop that holds even when the preflight was bypassed or the
 *   config broke mid-task.
 *
 * Everything here reads git data only — object contents, attributes and config.
 * `git-lfs` is consulted for exactly one question (is the binary installed), and
 * a repository with no git-lfs at all is still fully diagnosable.
 *
 * ## Reading attributes at a ref, on any git
 *
 * `git check-attr` normally answers for the working tree, but both callers need
 * the attributes as of a specific commit — accept runs from the project root,
 * whose checkout is some other branch entirely. `git check-attr --source=<ref>`
 * would do it but only landed in git 2.40, and lazy supports older gits (the
 * container here ships 2.39.5).
 *
 * So {@link lfsTrackedPaths} builds a throwaway index from the ref
 * (`GIT_INDEX_FILE=<temp> git read-tree <ref>`) and asks `check-attr --cached`.
 * That is git's own attribute engine, at the requested ref, on every git version
 * — no hand-rolled `.gitattributes` pattern matcher to drift from git's
 * wildmatch semantics. It writes only to the temp index, never to the
 * repository, so it is safe against the read-only git dir agents run under.
 *
 * ## Known limits
 *
 * - Detection scans CHECKED-IN `.gitattributes` files. A repo that enables LFS
 *   solely through `.git/info/attributes` or `core.attributesFile` is not
 *   detected as LFS-using (though once detected, `check-attr` does honour
 *   those). Untracked/uncommitted `.gitattributes` likewise.
 * - The accept-time scan looks at files changed between the merge base and the
 *   branch tip. Pre-existing raw blobs on the target branch are somebody else's
 *   damage and are deliberately not this accept's business.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { runGit, type GitResult } from '../utils/git';

/** First line of every LFS pointer file (LFS v1 pointer spec). */
export const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';

/**
 * Size ceiling for something that could still be a pointer.
 *
 * A real pointer is three short lines (~130 bytes). The spec allows extension
 * lines, so this is generously above any legitimate pointer while still being
 * far below any file worth tracking in LFS. A blob over this is reported
 * without reading its contents — the whole point is to avoid pulling a 335 MB
 * blob into memory to discover it is 335 MB.
 */
export const MAX_LFS_POINTER_BYTES = 1024;

/** Paths per `git check-attr` invocation, to stay clear of argv length limits. */
const PATHSPEC_CHUNK = 200;

/**
 * Cap on how many changed paths the accept-time scan considers.
 *
 * A branch touching more than this is a vendored tree or a generated bundle,
 * not the topology this guard is about. The cap is reported to the caller
 * rather than applied silently — see {@link LfsScanResult.pathsCapped}.
 */
export const MAX_SCANNED_PATHS = 5000;

/** Run git, throwing with context instead of returning a failure. */
async function git(
  args: string[],
  cwd: string,
  what: string,
  env?: Record<string, string>,
): Promise<GitResult> {
  const result = await runGit(args, { cwd, env });
  if (result.exitCode !== 0) {
    throw new Error(
      `git LFS check: ${what} failed (git ${args.join(' ')}): ` +
      `${result.stderr || `exit ${result.exitCode}`}`,
    );
  }
  return result;
}

/**
 * Checked-in `.gitattributes` files at `ref` that enable the LFS filter.
 *
 * One `git grep` over the tree — cheap on any repo size, and it never needs a
 * checkout. Paths are returned repo-relative, with git's `<ref>:` prefix
 * stripped.
 */
export async function lfsAttributeFilesAtRef(cwd: string, ref: string): Promise<string[]> {
  const result = await runGit(
    ['grep', '-l', '--fixed-strings', 'filter=lfs', ref, '--', '*.gitattributes'],
    { cwd },
  );

  // 0 = matches, 1 = no matches. Anything else is a real error (bad ref,
  // unreadable object database) and must not read as "no LFS here".
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) {
    throw new Error(
      `git LFS check: could not scan '${ref}' for .gitattributes ` +
      `(git grep): ${result.stderr || `exit ${result.exitCode}`}`,
    );
  }

  const prefix = `${ref}:`;
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line));
}

/**
 * Does this repository use git LFS, as of `ref`?
 *
 * Answers false for a repository with no commits (nothing is tracked yet, so
 * nothing can be mis-committed) rather than throwing — `lazy start` on a fresh
 * repo is a normal thing to do.
 */
export async function repoUsesLfs(cwd: string, ref: string = 'HEAD'): Promise<boolean> {
  const head = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], { cwd });
  if (head.exitCode !== 0) return false;
  return (await lfsAttributeFilesAtRef(cwd, ref)).length > 0;
}

/**
 * Of `paths`, those whose `filter` attribute resolves to `lfs` at `ref`.
 *
 * Uses git's own attribute engine against a throwaway index built from the ref
 * (see the module comment). Returns paths in the order given.
 */
export async function lfsTrackedPaths(
  cwd: string,
  ref: string,
  paths: string[],
): Promise<string[]> {
  if (paths.length === 0) return [];

  const indexDir = await mkdtemp(join(tmpdir(), 'lazy-lfs-idx-'));
  const indexFile = join(indexDir, 'index');
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await git(['read-tree', ref], cwd, `building a temporary index from '${ref}'`, env);

    const tracked = new Set<string>();
    for (let i = 0; i < paths.length; i += PATHSPEC_CHUNK) {
      const chunk = paths.slice(i, i + PATHSPEC_CHUNK);
      const result = await git(
        ['check-attr', '--cached', '-z', 'filter', '--', ...chunk],
        cwd,
        `reading the 'filter' attribute at '${ref}'`,
        env,
      );
      // NUL-separated triples: <path> NUL filter NUL <value> NUL
      const fields = result.stdout.split('\0');
      for (let f = 0; f + 2 < fields.length; f += 3) {
        const path = fields[f];
        const value = fields[f + 2];
        if (path && value === 'lfs') tracked.add(path);
      }
    }

    return paths.filter((p) => tracked.has(p));
  } finally {
    // Best-effort: the temp index is ours alone and lives under the OS temp
    // dir, so a failed unlink leaks one small file rather than affecting
    // anything. Never allowed to mask the real error from the try block.
    await rm(indexDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** A blob committed on an LFS-tracked path that is not an LFS pointer. */
export interface LfsBlobViolation {
  /** Repo-relative path, as git reports it. */
  path: string;
  /** Size of the committed blob, in bytes. */
  sizeBytes: number;
  /** The most recent commit in the scanned range that touched this path. */
  commit: { sha: string; subject: string; date: string } | null;
}

export interface LfsScanResult {
  violations: LfsBlobViolation[];
  /** Number of LFS-tracked paths actually inspected. */
  trackedPathsChecked: number;
  /**
   * True when the changed-file set exceeded {@link MAX_SCANNED_PATHS} and was
   * truncated, so `violations` may be incomplete. Never silently swallowed —
   * the caller says so.
   */
  pathsCapped: boolean;
}

/** Is the blob at `<ref>:<path>` an LFS pointer? */
async function blobIsPointer(cwd: string, ref: string, path: string): Promise<{ pointer: boolean; sizeBytes: number }> {
  const sizeResult = await git(
    ['cat-file', '-s', `${ref}:${path}`],
    cwd,
    `reading the size of '${path}' at '${ref}'`,
  );
  const sizeBytes = Number.parseInt(sizeResult.stdout.trim(), 10);
  if (!Number.isFinite(sizeBytes)) {
    throw new Error(
      `git LFS check: git reported a non-numeric size for '${path}' at '${ref}': ` +
      `'${sizeResult.stdout.trim()}'`,
    );
  }
  // Big enough that it cannot be a pointer — do not read it.
  if (sizeBytes > MAX_LFS_POINTER_BYTES) return { pointer: false, sizeBytes };

  const blob = await git(
    ['cat-file', 'blob', `${ref}:${path}`],
    cwd,
    `reading '${path}' at '${ref}'`,
  );
  return { pointer: blob.stdout.startsWith(LFS_POINTER_PREFIX), sizeBytes };
}

export interface FindNonPointerLfsBlobsParams {
  /** Repository to run git in. */
  cwd: string;
  /** Branch or SHA whose committed blobs are inspected. */
  ref: string;
  /** Exclusive lower bound — normally `merge-base(target, ref)`. */
  baseRef: string;
}

/**
 * Files changed between `baseRef` and `ref` that are LFS-tracked but whose
 * committed blob is raw content rather than a pointer.
 *
 * Read-only, and works with no `git-lfs` binary installed: it only asks git for
 * attributes, blob sizes and blob prefixes. Throws when git fails — an
 * unreadable repository must not read as clean.
 */
export async function findNonPointerLfsBlobs(
  params: FindNonPointerLfsBlobsParams,
): Promise<LfsScanResult> {
  const { cwd, ref, baseRef } = params;

  if (!(await repoUsesLfs(cwd, ref))) {
    return { violations: [], trackedPathsChecked: 0, pathsCapped: false };
  }

  // Two-dot against the merge base: the files this branch presents that the
  // base did not. --no-renames so a renamed raw blob is judged under its new
  // path rather than hidden as an R entry.
  const diff = await git(
    ['diff', '--no-renames', '--diff-filter=ACMR', '--name-only', '-z', baseRef, ref],
    cwd,
    `listing files changed between '${baseRef}' and '${ref}'`,
  );
  const allChanged = diff.stdout.split('\0').map((p) => p.trim()).filter((p) => p.length > 0);
  const pathsCapped = allChanged.length > MAX_SCANNED_PATHS;
  const changed = pathsCapped ? allChanged.slice(0, MAX_SCANNED_PATHS) : allChanged;
  if (changed.length === 0) {
    return { violations: [], trackedPathsChecked: 0, pathsCapped };
  }

  const tracked = await lfsTrackedPaths(cwd, ref, changed);
  if (tracked.length === 0) {
    return { violations: [], trackedPathsChecked: 0, pathsCapped };
  }

  const violations: LfsBlobViolation[] = [];
  for (const path of tracked) {
    const { pointer, sizeBytes } = await blobIsPointer(cwd, ref, path);
    if (pointer) continue;
    violations.push({ path, sizeBytes, commit: await lastCommitTouching(cwd, baseRef, ref, path) });
  }

  return { violations, trackedPathsChecked: tracked.length, pathsCapped };
}

/** The newest commit in `baseRef..ref` that touched `path`, for attribution. */
async function lastCommitTouching(
  cwd: string,
  baseRef: string,
  ref: string,
  path: string,
): Promise<LfsBlobViolation['commit']> {
  const result = await runGit(
    ['log', '-1', '--format=%H\x1f%aI\x1f%s', `${baseRef}..${ref}`, '--', path],
    { cwd },
  );
  // Attribution is a nicety on top of a violation we have already proven, so a
  // failure here degrades to "no commit named" rather than losing the finding.
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;
  const [sha, date, ...subject] = result.stdout.trim().split('\x1f');
  if (!sha) return null;
  return {
    sha: sha.substring(0, 8),
    date: (date ?? '').split('T')[0] ?? '',
    subject: subject.join('\x1f'),
  };
}

/** A specific way the LFS setup is broken, with a stable code for tests. */
export interface LfsEnvironmentProblem {
  code: 'binary-missing' | 'filter-unset' | 'not-required';
  /** One line: what is wrong. The remedy lives in `lazy doctor`. */
  message: string;
  /** The command that fixes it — printed by `lazy doctor`, not at the point of occurrence. */
  remedy: string;
}

export interface LfsEnvironmentReport {
  /** False when the repo does not use LFS at all; every other field is then inert. */
  usesLfs: boolean;
  /** Is the `git-lfs` binary callable here? */
  binaryPresent: boolean;
  /** e.g. `git-lfs/3.3.0` — present only when the binary is. */
  binaryVersion?: string;
  /** The three filter hooks, as git resolves them from this directory. Empty string = unset or blank. */
  filters: { process: string; clean: string; smudge: string };
  /** `filter.lfs.required` as git resolves it. False is what makes breakage silent. */
  required: boolean;
  /** Empty when the environment would commit LFS content correctly. */
  problems: LfsEnvironmentProblem[];
}

/** `git config --get <key>`, with unset and blank both collapsing to ''. */
async function configValue(cwd: string, key: string): Promise<string> {
  const result = await runGit(['config', '--get', key], { cwd });
  // Exit 1 means "not set", which is a normal answer here, not an error.
  if (result.exitCode !== 0) return '';
  return result.stdout.trim();
}

/**
 * Would a commit made in `cwd` store LFS content correctly?
 *
 * Answers for the directory given, because that is the directory `git add` will
 * run in — `lazy_commit` stages and commits host-side in the task worktree (see
 * `src/mcp/tools.ts`), so the worktree's resolved git config is the one that
 * decides whether a pointer or 335 MB of raw bytes lands.
 *
 * Never repairs anything. Rewriting a user's git config behind their back is
 * exactly the hidden side effect CLAUDE.md forbids; lazy detects and refuses,
 * the human fixes it deliberately.
 */
export async function inspectLfsEnvironment(
  cwd: string,
  ref: string = 'HEAD',
): Promise<LfsEnvironmentReport> {
  const inert = {
    binaryPresent: false,
    filters: { process: '', clean: '', smudge: '' },
    required: false,
    problems: [],
  };

  if (!(await repoUsesLfs(cwd, ref))) {
    return { usesLfs: false, ...inert };
  }

  const version = await runGit(['lfs', 'version'], { cwd });
  const binaryPresent = version.exitCode === 0;

  const filters = {
    process: await configValue(cwd, 'filter.lfs.process'),
    clean: await configValue(cwd, 'filter.lfs.clean'),
    smudge: await configValue(cwd, 'filter.lfs.smudge'),
  };
  const required = (await configValue(cwd, 'filter.lfs.required')).toLowerCase() === 'true';

  const problems: LfsEnvironmentProblem[] = [];

  if (!binaryPresent) {
    problems.push({
      code: 'binary-missing',
      message: 'the `git-lfs` binary is not installed or not on PATH',
      remedy: 'Install git-lfs (https://git-lfs.com), then run `git lfs install --local` in the repository.',
    });
  }

  // git-lfs installs all three; `process` alone is enough for modern git, but a
  // partial set is the shape the incident had (process present but EMPTY) and
  // there is no legitimate reason for it. Treat anything short of the full set
  // as broken rather than guessing which half git will use.
  const unset = (Object.keys(filters) as Array<keyof typeof filters>).filter((k) => filters[k] === '');
  if (unset.length > 0) {
    problems.push({
      code: 'filter-unset',
      message: `the LFS clean/smudge filter is not configured here (${unset.map((k) => `filter.lfs.${k}`).join(', ')} unset or empty)`,
      remedy: 'Run `git lfs install --local` in the repository to write the filter config.',
    });
  }

  if (!required) {
    problems.push({
      code: 'not-required',
      message: '`filter.lfs.required` is false, so git commits raw file contents instead of failing when the filter is broken',
      remedy: 'Run `git config filter.lfs.required true` in the repository (`git lfs install --local` sets it too).',
    });
  }

  return {
    usesLfs: true,
    binaryPresent,
    ...(binaryPresent ? { binaryVersion: version.stdout.split('\n')[0]?.trim() } : {}),
    filters,
    required,
    problems,
  };
}
