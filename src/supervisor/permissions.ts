/**
 * File permission violation detection.
 *
 * After each agent turn, checks whether the agent modified or deleted content
 * in protected files. Pure additions (new files, or only added lines) are
 * allowed — they don't violate permissions.
 *
 * Files created by the task itself (not present at the branch point) are also
 * exempt — the permission system protects pre-existing files, not agent-created ones.
 */

import type { FileViolation } from '../types';
import { runGit } from '../utils/git';
import { log } from './log';

/**
 * Thrown when the protected-file scan cannot run (e.g. `git diff` failed).
 * Callers must NOT treat this as "no violations" — an authoritative empty set
 * would clear a prior conflict once empty re-detects are persisted.
 */
export class ViolationScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViolationScanError';
  }
}

/**
 * Check if a file path matches any of the given glob patterns.
 */
function matchesProtectedPattern(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    if (glob.match(filePath)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a file change is a pure addition (no modifications or deletions).
 *
 * A pure addition means either:
 * - The file is entirely new (status 'A' in git diff --name-status)
 * - All hunks in the diff are additions only (no '-' lines in the diff body)
 */
async function isPureAddition(
  worktreePath: string,
  startSha: string,
  endSha: string,
  filePath: string,
  nameStatus: string,
): Promise<boolean> {
  // New file — always a pure addition
  if (nameStatus === 'A') {
    return true;
  }

  // For modified files, check if all hunks are additions only
  const result = await runGit(
    ['diff', startSha, endSha, '--', filePath],
    { cwd: worktreePath },
  );

  if (result.exitCode !== 0) {
    // Can't get diff — treat as violation to be safe
    return false;
  }

  const lines = result.stdout.split('\n');
  for (const line of lines) {
    // Skip diff headers: --- a/file, +++ b/file, diff --git, index, @@
    if (line.startsWith('---') || line.startsWith('+++') ||
        line.startsWith('diff ') || line.startsWith('index ') ||
        line.startsWith('@@') || line.startsWith('\\')) {
      continue;
    }

    // A '-' line in the diff body means content was removed or modified
    if (line.startsWith('-')) {
      return false;
    }
  }

  return true;
}

/**
 * Which of `filePaths` existed at `sha` (the task's branch point) — files that
 * did NOT are the task's own creations and are exempt from violations.
 *
 * ONE `git ls-tree` for the whole set, not a `cat-file -e` per file. This runs
 * on every `lazy show`, every review-page render and every end-of-turn park, and
 * a project protecting every `.ts` under `test/` matches tens of files per scan — the same
 * per-file-spawn cost the Changes-block work was done to remove.
 *
 * `--name-only -z` so a path with a newline or a quote in it cannot be
 * mis-parsed (git would otherwise C-quote it); paths are passed after `--`.
 *
 * INVARIANT: THROWS on failure — the same rule as the `git diff` above, for the
 * same reason. An empty set means "none of these existed at the branch point",
 * i.e. every candidate is a file the task CREATED and is exempt, so
 * detectViolations returns `[]` — indistinguishable from "nothing protected
 * changed". Since the reviewer's decision moved to accept, that empty result is
 * the only thing standing between an unapproved protected edit and the merge:
 * the task parks `blocked` rather than `conflict`, the review page lists
 * nothing, accept sees no outstanding files and merges. One failed git call must
 * not be able to switch the gate off, silently, for every file at once.
 *
 * Callers propagate: `resolveOutstandingViolations` catches a thrown scan and
 * degrades to the conservative records-only answer, which can overstate what is
 * owed but never understate it.
 *
 * Chunked, because the batching that made this one spawn also made one argv out
 * of every candidate path: a hub touching hundreds of protected files must not
 * turn into an argument-list failure — which, before this threw, was a
 * whole-set bypass in a single call.
 */
const LS_TREE_PATH_CHUNK = 200;

async function filesExistingAtSha(
  worktreePath: string,
  sha: string,
  filePaths: readonly string[],
): Promise<Set<string>> {
  if (filePaths.length === 0) return new Set();
  const existing = new Set<string>();
  for (let i = 0; i < filePaths.length; i += LS_TREE_PATH_CHUNK) {
    const chunk = filePaths.slice(i, i + LS_TREE_PATH_CHUNK);
    const result = await runGit(
      ['ls-tree', '--name-only', '-z', sha, '--', ...chunk],
      { cwd: worktreePath },
    );
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || `(exit ${result.exitCode})`;
      log(`[permissions] ls-tree at ${sha.substring(0, 8)} failed: ${detail}`);
      throw new ViolationScanError(
        `protected-file scan failed (git ls-tree ${sha.substring(0, 8)}, ${chunk.length} path(s)): ${detail}`,
      );
    }
    for (const path of result.stdout.split('\0')) {
      if (path) existing.add(path);
    }
  }
  return existing;
}

/**
 * Read a file's blob at a ref (commit SHA or branch name). Returns null when
 * the path does not exist at that ref.
 */
async function fileContentAtRef(
  worktreePath: string,
  ref: string,
  filePath: string,
): Promise<string | null> {
  const result = await runGit(
    ['show', `${ref}:${filePath}`],
    { cwd: worktreePath },
  );
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout;
}

/**
 * True when the file's content at `endSha` is byte-identical to its content at
 * `upstreamMergeRef`. Used to skip merge artifacts: a protected file brought in
 * by a sync merge matches upstream and is not a task-authored violation.
 */
async function fileMatchesUpstream(
  worktreePath: string,
  endSha: string,
  upstreamMergeRef: string,
  filePath: string,
): Promise<boolean> {
  const [endContent, upstreamContent] = await Promise.all([
    fileContentAtRef(worktreePath, endSha, filePath),
    fileContentAtRef(worktreePath, upstreamMergeRef, filePath),
  ]);
  if (endContent === null && upstreamContent === null) {
    return true;
  }
  if (endContent === null || upstreamContent === null) {
    return false;
  }
  return endContent === upstreamContent;
}

/**
 * Detect file permission violations between two SHAs.
 *
 * Returns violations for protected files that were modified or had content deleted.
 * Pure additions (new files or only added lines) are allowed.
 *
 * When branchPointSha is provided, files that did not exist at the branch point
 * (i.e., files created by the task itself) are exempt from violation checks.
 *
 * When upstreamMergeRef is provided (the ref `resolveUpstreamMergeRef` chose,
 * written by the daemon as `upstream_merge_ref` on start/unblock commands),
 * a protected file whose content at endSha matches that ref is treated as an
 * upstream/merge artifact, not a task violation. Task edits that diverge from
 * upstream still flag.
 */
export async function detectViolations(
  worktreePath: string,
  startSha: string,
  endSha: string,
  protectedPatterns: string[],
  branchPointSha?: string,
  upstreamMergeRef?: string,
): Promise<FileViolation[]> {
  log(`[permissions] detectViolations called: patterns=${JSON.stringify(protectedPatterns)}, startSha=${startSha.substring(0, 8)}, endSha=${endSha.substring(0, 8)}, branchPointSha=${branchPointSha?.substring(0, 8) ?? 'none'}, upstreamMergeRef=${upstreamMergeRef ?? 'none'}`);

  if (protectedPatterns.length === 0) {
    log('[permissions] No protected patterns — skipping');
    return [];
  }

  if (startSha === endSha) {
    log('[permissions] startSha === endSha — no changes to check');
    return [];
  }

  // Get list of changed files with their status
  log(`[permissions] Running: git diff --name-status ${startSha.substring(0, 8)} ${endSha.substring(0, 8)}`);
  const result = await runGit(
    ['diff', '--name-status', startSha, endSha],
    { cwd: worktreePath },
  );

  if (result.exitCode !== 0) {
    // INVARIANT: a failed scan is not "no violations". Returning [] here used to
    // fail open; once empty re-detects became authoritative that could clear a
    // real pending conflict. Callers must omit the violations field or keep the
    // prior set — never invent an authoritative empty result from a failed diff.
    const detail = result.stderr.trim() || `(exit ${result.exitCode})`;
    log(`[permissions] Failed to get diff: ${detail}`);
    throw new ViolationScanError(
      `protected-file scan failed (git diff --name-status ${startSha.substring(0, 8)}..${endSha.substring(0, 8)}): ${detail}`,
    );
  }

  log(`[permissions] git diff output: "${result.stdout.trim()}"`);

  if (!result.stdout.trim()) {
    log('[permissions] No changed files');
    return [];
  }

  const violations: FileViolation[] = [];
  const lines = result.stdout.trim().split('\n');

  // Pass 1: every changed file matching a protected pattern, with its status.
  const candidates: Array<{ filePath: string; status: string }> = [];
  for (const line of lines) {
    // Format: "M\tpath/to/file" or "A\tpath/to/file" or "D\tpath/to/file"
    // Rename: "R100\told\tnew"
    const parts = line.split('\t');
    if (parts.length < 2) continue;

    const status = parts[0].charAt(0); // M, A, D, R, C, etc.
    const filePath = status === 'R' || status === 'C' ? parts[2] : parts[1];

    if (!filePath) continue;

    // Check if the file matches a protected pattern
    const matched = matchesProtectedPattern(filePath, protectedPatterns);
    log(`[permissions] File: ${filePath} (status=${status}) matched=${matched}`);
    if (!matched) {
      continue;
    }

    candidates.push({ filePath, status });
  }

  // Files created by the task itself are exempt — the permission system protects
  // pre-existing files, not agent-created ones. One ls-tree for the whole set.
  const existedAtBranchPoint = branchPointSha
    ? await filesExistingAtSha(worktreePath, branchPointSha, candidates.map((c) => c.filePath))
    : null;

  // Pass 2: decide each candidate.
  for (const { filePath, status } of candidates) {
    if (existedAtBranchPoint && !existedAtBranchPoint.has(filePath)) {
      log(`[permissions] Skipping ${filePath}: file did not exist at branch point ${branchPointSha!.substring(0, 8)} (created by this task)`);
      continue;
    }

    // Merge artifact: content at endSha matches the upstream merge ref — upstream's
    // change, already reviewed at its own accept, not this task's edit.
    if (upstreamMergeRef && await fileMatchesUpstream(worktreePath, endSha, upstreamMergeRef, filePath)) {
      log(`[permissions] Skipping ${filePath}: content matches upstream ${upstreamMergeRef}`);
      continue;
    }

    // Deleted files always violate
    if (status === 'D') {
      log(`[permissions] Violation: ${filePath} was deleted`);
      violations.push({
        file: filePath,
        base_sha: startSha,
        status: 'pending',
      });
      continue;
    }

    // Check if the change is a pure addition
    if (!await isPureAddition(worktreePath, startSha, endSha, filePath, status)) {
      log(`[permissions] Violation: ${filePath} was modified (not a pure addition)`);
      violations.push({
        file: filePath,
        base_sha: startSha,
        status: 'pending',
      });
    }
  }

  return violations;
}
