/**
 * Resurrection guard — refuse accepts that silently re-add files the target
 * branch deliberately deleted.
 *
 * ## The defect class
 *
 * Proven incident (see docs/spikes/v012-release-resurrection-audit.md): the
 * "Release v0.12" commit re-added the SSE module, tmux plumbing and four other
 * husks that `main` had deleted, plus reverted a live behavioural fix. Nobody
 * did anything wrong at accept time — the squash-accept was byte-faithful. The
 * damage entered earlier, through the release branch's own `Merge origin/main`
 * commits, because of the merge base.
 *
 * v0.11's hub landed on `main` as a SQUASH, so v0.11's original commits are not
 * ancestors of `main`. The stacked v0.12 hub still carried those originals, so
 * `merge-base(hub, main)` was PRE-v0.11. Every file born in v0.11 therefore had
 * **no version at the merge base**. When `main` later deleted such a file, git
 * saw not "you deleted what I kept" (a resolvable delete/keep) but "the hub
 * added a file I never had" — a one-sided add, taken wholesale, no conflict,
 * nothing to review.
 *
 * ## What is actually checked
 *
 * A file is silently ADDED to the target by this merge exactly when it is
 *
 *   1. present on the source branch, AND
 *   2. absent on the target branch, AND
 *   3. absent at `merge-base(source, target)`.
 *
 * Condition 3 is what separates the hazard from ordinary staleness: a file that
 * exists at the base and was deleted on the target merges correctly (git deletes
 * it, or raises a modify/delete conflict a human must resolve). Only the
 * no-version-at-base case lands silently.
 *
 * That set still contains the source branch's legitimately new files, so it is
 * narrowed by one more question: **did the target branch ever delete this
 * path?** If it did, the merge is putting back something the target removed on
 * purpose. That is a resurrection, and it needs a human to say so out loud.
 *
 * Note the widely-quoted shorthand `git diff --diff-filter=D main...hub` does
 * NOT detect this — three-dot diffs are taken from the merge base, and in the
 * very topology that causes the bug the resurrected file has no version there,
 * so it shows up as nothing at all. This module computes the intersection above
 * instead.
 *
 * ## Scope and limits
 *
 * - Runs on EVERY accept, not just release hubs. The hazard is a property of
 *   merge topology (squash-accepted parent + stacked child), not of release
 *   semantics; a stacked feature hub is exposed identically.
 * - File granularity only. The v0.12 incident also reverted individual hunks
 *   (the auto-react budget-gate regression); no cheap git query distinguishes a
 *   reverted hunk from an intentional edit, so that is out of reach here.
 * - The "did the target ever delete this path" probe reads ordinary commit
 *   diffs, so a deletion that exists ONLY inside a merge commit's combined diff
 *   is not seen. Lazy lands work on the target as squash or fast-forward
 *   commits, so this is not a gap in practice; where it is, the guard
 *   under-reports rather than blocking a clean accept.
 */

import { runGit } from '../utils/git';
import { docsSuffix, docsUrl } from '../docs/links';

/** One file the accept would put back on the target branch. */
export interface Resurrection {
  /** Repo-relative path, as git reports it. */
  path: string;
  /** The commit on the target branch that deleted it. */
  deletedBy: {
    sha: string;
    subject: string;
    /** Author date, ISO-8601. */
    date: string;
  };
}

/**
 * Cap on how many candidate paths are probed for a prior deletion.
 *
 * A source branch that adds thousands of files is a vendored tree or a
 * generated bundle, not the topology this guard is about. Bounding the work
 * keeps accept's cost predictable; the cap is reported by the caller rather
 * than applied silently (see {@link DetectResurrectionsResult.candidatesCapped}).
 */
const MAX_CANDIDATES = 2000;

/** Pathspecs per `git log` invocation, to stay clear of argv length limits. */
const PATHSPEC_CHUNK = 200;

export interface DetectResurrectionsParams {
  /** Repository to run git in (the project root, not a task worktree). */
  projectRoot: string;
  /** Branch being merged. */
  sourceBranch: string;
  /** Branch being merged into. */
  targetBranch: string;
}

export interface DetectResurrectionsResult {
  resurrections: Resurrection[];
  /**
   * True when the candidate set exceeded {@link MAX_CANDIDATES} and was
   * truncated, so `resurrections` may be incomplete. Never silently swallowed —
   * the caller says so.
   */
  candidatesCapped: boolean;
}

async function gitLines(args: string[], cwd: string, what: string): Promise<string[]> {
  const result = await runGit(args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(
      `resurrection guard: ${what} failed (git ${args.join(' ')}): ` +
      `${result.stderr || `exit ${result.exitCode}`}`,
    );
  }
  return result.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * Files this merge would add to the target that the target had deleted.
 *
 * Read-only: three `git` reads plus one `git log` per chunk of candidates.
 * Throws when git fails — an unreadable repository must not read as "clean".
 */
export async function detectResurrections(
  params: DetectResurrectionsParams,
): Promise<DetectResurrectionsResult> {
  const { projectRoot, sourceBranch, targetBranch } = params;

  // Files absent at merge-base(target, source) but present on source.
  // `--no-renames` on purpose: a path the target renamed away and the source
  // brings back under the OLD name is a resurrection, and rename detection
  // would classify it as R and hide it.
  const addedSinceBase = await gitLines(
    ['diff', '--no-renames', '--diff-filter=A', '--name-only', `${targetBranch}...${sourceBranch}`],
    projectRoot,
    'listing files the source adds relative to the merge base',
  );
  if (addedSinceBase.length === 0) {
    return { resurrections: [], candidatesCapped: false };
  }

  // Files absent on the target tip but present on source (two-dot: tree vs tree).
  const absentOnTarget = new Set(
    await gitLines(
      ['diff', '--no-renames', '--diff-filter=A', '--name-only', targetBranch, sourceBranch],
      projectRoot,
      'listing files the source has and the target does not',
    ),
  );

  const allCandidates = addedSinceBase.filter((p) => absentOnTarget.has(p));
  const candidatesCapped = allCandidates.length > MAX_CANDIDATES;
  const candidates = candidatesCapped ? allCandidates.slice(0, MAX_CANDIDATES) : allCandidates;
  if (candidates.length === 0) {
    return { resurrections: [], candidatesCapped };
  }

  // Of those, which did the target branch once contain and deliberately delete?
  const found = new Map<string, Resurrection>();
  for (let i = 0; i < candidates.length; i += PATHSPEC_CHUNK) {
    const chunk = candidates.slice(i, i + PATHSPEC_CHUNK);
    // One record per commit: a header line, then the paths that commit deleted.
    // \x1f separates fields; a blank line separates records.
    const raw = await runGit(
      [
        'log',
        '--no-renames',
        '--diff-filter=D',
        '--name-only',
        '--format=\x1e%H\x1f%aI\x1f%s',
        targetBranch,
        '--',
        ...chunk,
      ],
      { cwd: projectRoot },
    );
    if (raw.exitCode !== 0) {
      throw new Error(
        `resurrection guard: could not read deletion history of '${targetBranch}': ` +
        `${raw.stderr || `exit ${raw.exitCode}`}`,
      );
    }

    for (const record of raw.stdout.split('\x1e')) {
      const lines = record.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      if (lines.length === 0) continue;
      const [sha, date, ...subjectParts] = lines[0]!.split('\x1f');
      if (!sha) continue;
      const deletedBy = {
        sha: sha.substring(0, 8),
        date: (date ?? '').split('T')[0] ?? '',
        subject: subjectParts.join('\x1f'),
      };
      for (const path of lines.slice(1)) {
        // `git log` walks newest-first; the first (newest) deletion of a path is
        // the one that made it absent on the target, so never overwrite.
        if (!found.has(path)) found.set(path, { path, deletedBy });
      }
    }
  }

  const resurrections = candidates
    .filter((p) => found.has(p))
    .map((p) => found.get(p)!);

  return { resurrections, candidatesCapped };
}

export class ResurrectionRefusedError extends Error {
  readonly resurrections: Resurrection[];
  constructor(message: string, resurrections: Resurrection[]) {
    super(message);
    this.name = 'ResurrectionRefusedError';
    this.resurrections = resurrections;
  }
}

/**
 * The refusal text. Names every file, who deleted it and when, explains the
 * mechanism in one paragraph, and gives the two commands that resolve it —
 * per CLAUDE.md, an error must say what happened, why, and what to do.
 */
export function resurrectionRefusalMessage(
  displayId: string,
  sourceBranch: string,
  targetBranch: string,
  resurrections: Resurrection[],
): string {
  const plural = resurrections.length === 1 ? 'file' : 'files';
  const list = resurrections
    .map((r) => `  ${r.path}\n      deleted by ${r.deletedBy.sha} "${r.deletedBy.subject}" (${r.deletedBy.date})`)
    .join('\n');
  const approveFlags = resurrections.map((r) => `--approve-file ${r.path}`).join(' ');

  return (
    `Accepting task ${displayId} would merge \`${sourceBranch}\` into \`${targetBranch}\` and ` +
    `RE-ADD ${resurrections.length} ${plural} that \`${targetBranch}\` deliberately deleted:\n\n` +
    `${list}\n\n` +
    `\`${sourceBranch}\` has no version of ${resurrections.length === 1 ? 'this file' : 'these files'} at its merge base with ` +
    `\`${targetBranch}\`, so git sees the deletion as nothing to merge and takes the branch's copy ` +
    `wholesale — no conflict, nothing to review. This is how the v0.12 release resurrected the dead ` +
    `SSE module for eight releases (docs/spikes/v012-release-resurrection-audit.md).\n\n` +
    `If ${resurrections.length === 1 ? 'it is' : 'they are'} dead on \`${targetBranch}\`, delete ` +
    `${resurrections.length === 1 ? 'it' : 'them'} on \`${sourceBranch}\` and re-run the accept.\n\n` +
    `If bringing ${resurrections.length === 1 ? 'it' : 'them'} back is intentional, approve ` +
    `${resurrections.length === 1 ? 'it' : 'each one'} explicitly:\n\n` +
    `  lazy accept ${displayId} ${approveFlags}\n` +
    docsSuffix('resurrection-guard', '\n')
  );
}

export interface EnforceResurrectionGuardParams extends DetectResurrectionsParams {
  displayId: string;
  /**
   * Paths the caller has already approved (`--approve-file` on the CLI,
   * `approved_files` over MCP/RPC). Reused deliberately rather than adding a
   * second approval channel: the flag already means "I have looked at this file
   * and I am content for it to land", which is exactly the judgement asked for
   * here.
   */
  approvedFiles?: string[];
}

export interface EnforceResurrectionGuardResult {
  /** Resurrections the caller explicitly approved; empty on a clean accept. */
  approved: Resurrection[];
  /** Non-fatal notes for the accept's warning list. */
  warnings: string[];
}

/**
 * Enforce the guard for one accept.
 *
 * Throws {@link ResurrectionRefusedError} when the merge would re-add a deleted
 * file that has not been approved. Approved resurrections pass through and are
 * returned so the caller can record them in the accept's warnings — an approved
 * resurrection is still a fact worth having in the audit trail.
 */
export async function enforceResurrectionGuard(
  params: EnforceResurrectionGuardParams,
): Promise<EnforceResurrectionGuardResult> {
  const { resurrections, candidatesCapped } = await detectResurrections(params);
  const warnings: string[] = [];

  if (candidatesCapped) {
    warnings.push(
      `Resurrection guard: \`${params.sourceBranch}\` adds more than ${MAX_CANDIDATES} files, ` +
      `so only the first ${MAX_CANDIDATES} were checked for re-added deletions.`,
    );
  }

  if (resurrections.length === 0) return { approved: [], warnings };

  const approvedSet = new Set(params.approvedFiles ?? []);
  const unapproved = resurrections.filter((r) => !approvedSet.has(r.path));
  if (unapproved.length > 0) {
    throw new ResurrectionRefusedError(
      resurrectionRefusalMessage(params.displayId, params.sourceBranch, params.targetBranch, unapproved),
      unapproved,
    );
  }

  warnings.push(
    `Approved re-addition of ${resurrections.length} file(s) \`${params.targetBranch}\` had deleted: ` +
    `${resurrections.map((r) => r.path).join(', ')}`,
  );
  return { approved: resurrections, warnings };
}

/**
 * The advisory a stacked child gets when its parent lands as a squash.
 *
 * This is where the hazard is CREATED, and lazy deliberately only warns here
 * rather than repairing it: reparenting moves a pointer, but repairing the merge
 * base means merging into somebody else's worktree during an accept the human
 * asked for on a different task. That is exactly the hidden side effect
 * CLAUDE.md forbids, and a conflict raised there would strand a task nobody was
 * looking at. `lazy sync` is the operation that owns upstream merges, so the
 * advisory names it; {@link enforceResurrectionGuard} is the hard backstop if it
 * is ignored.
 *
 * Returns null when there is nothing to advise about.
 */
export function stackedChildAdvisory(childCount: number, targetBranch: string): string | null {
  if (childCount <= 0) return null;
  const one = childCount === 1;
  return (
    `That ${one ? 'child keeps its' : `${childCount} children keep their`} pre-squash history, so ` +
    `${one ? 'its' : 'their'} merge base with ` +
    `\`${targetBranch}\` is now behind the work that just landed. Run \`lazy sync\` on ` +
    `${one ? 'it' : 'each'} before it is accepted — an out-of-date base is what lets deletions made on ` +
    `\`${targetBranch}\` silently reappear (lazy refuses such an accept; see ` +
    // In-sentence reference: the hosted page when doc pointers are on, the
    // in-repo file when a project has turned them off.
    `${docsUrl('resurrection-guard') ?? 'public-docs/resurrection-guard.md'})`
  );
}
