/**
 * LFS pointer guard — refuse accepts that would merge raw blobs onto
 * LFS-tracked paths.
 *
 * ## Why this exists as well as the start-time preflight
 *
 * `src/daemon/task-launcher.ts` refuses to launch an agent into an
 * LFS-broken environment, which is where the damage is actually prevented. This
 * is the backstop for everything that check cannot see: a config that broke
 * mid-task, a commit made before lazy managed the branch, a `lazy pair` session
 * on a differently-configured host, or a task started with the check disabled.
 *
 * The two layers answer different questions on purpose. The preflight asks "is
 * this environment capable of committing correctly?"; this asks "is what was
 * actually committed correct?" — and only the second is a property of the data
 * that lands on the target branch.
 *
 * ## The failure it prevents
 *
 * Once a raw 335 MB blob is an ancestor of the target branch, the branch is
 * unpushable to any forge with a blob-size limit, and the only fix is history
 * surgery on a branch other people have already pulled. Refusing the merge
 * keeps the damage contained to one task branch, which is disposable.
 *
 * See `src/git/lfs.ts` for the detection mechanism and the incident it comes
 * from.
 */

import { findNonPointerLfsBlobs, MAX_SCANNED_PATHS, type LfsBlobViolation } from '../git/lfs';
import { docsSuffix } from '../docs/links';

export class LfsPointerRefusedError extends Error {
  readonly violations: LfsBlobViolation[];
  constructor(message: string, violations: LfsBlobViolation[]) {
    super(message);
    this.name = 'LfsPointerRefusedError';
    this.violations = violations;
  }
}

/** Human-readable byte size, for the refusal message. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * The refusal text. Names every file with its size and the commit that put it
 * there, explains the mechanism in one paragraph, and gives the recovery route
 * — per CLAUDE.md, an error must say what happened, why, and what to do.
 */
export function lfsRefusalMessage(
  displayId: string,
  sourceBranch: string,
  targetBranch: string,
  violations: LfsBlobViolation[],
): string {
  const one = violations.length === 1;
  const list = violations
    .map((v) => {
      const where = v.commit
        ? `\n      committed by ${v.commit.sha} "${v.commit.subject}" (${v.commit.date})`
        : '';
      return `  ${v.path}  (${formatBytes(v.sizeBytes)} of raw content)${where}`;
    })
    .join('\n');

  return (
    `Accepting task ${displayId} would merge \`${sourceBranch}\` into \`${targetBranch}\` with ` +
    `${violations.length} file${one ? '' : 's'} stored as RAW CONTENT on ${one ? 'an' : ''} LFS-tracked ` +
    `path${one ? '' : 's'}:\n\n` +
    `${list}\n\n` +
    `${one ? 'This file is' : 'These files are'} tracked by git LFS, so the commit should hold a ` +
    `~130-byte pointer, not the file itself. Git only errors on a broken LFS filter when ` +
    `\`filter.lfs.required\` is true; with it false the clean filter is skipped and the raw bytes ` +
    `are committed silently — which is why nothing failed at commit time.\n\n` +
    `Merging this makes \`${targetBranch}\` unpushable to any forge with a blob-size limit, and ` +
    `undoing it then means rewriting shared history. On the task branch it is still cheap to fix:\n\n` +
    `  1. Fix the environment first, or the re-commit repeats the mistake:\n` +
    `       git lfs install --local && git config filter.lfs.required true\n` +
    `  2. Re-commit the affected path${one ? '' : 's'} through the filter, in the task worktree:\n` +
    `       git rm --cached ${violations.map((v) => v.path).join(' ')} && git add ${violations.map((v) => v.path).join(' ')}\n` +
    `     then commit — and confirm with \`git cat-file -s ${sourceBranch}:${violations[0]!.path}\` ` +
    `that the blob is now pointer-sized.\n` +
    `  3. If the branch's HISTORY still carries the raw blob, the push will still fail: redo the ` +
    `work on a fresh branch (\`lazy redo ${displayId}\`) rather than rewriting it in place.\n\n` +
    `If lazy is wrong and ${one ? 'this file genuinely belongs' : 'these files genuinely belong'} ` +
    `in git as ${one ? 'it is' : 'they are'}, approve ${one ? 'it' : 'each one'} explicitly:\n\n` +
    `  lazy accept ${displayId} ${violations.map((v) => `--approve-file ${v.path}`).join(' ')}\n` +
    docsSuffix('lfs-guard', '\n')
  );
}

export interface EnforceLfsGuardParams {
  /** Repository to run git in (the project root, not a task worktree). */
  projectRoot: string;
  /** Branch being merged. */
  sourceBranch: string;
  /** Branch being merged into. */
  targetBranch: string;
  /** Merge base of the two, i.e. the exclusive lower bound of the scan. */
  mergeBase: string;
  displayId: string;
  /**
   * Paths the caller has already approved (`--approve-file` on the CLI,
   * `approved_files` over MCP/RPC). Reused deliberately rather than adding a
   * second approval channel — same rationale as the resurrection guard: the
   * flag already means "I have looked at this file and I am content for it to
   * land."
   */
  approvedFiles?: string[];
}

export interface EnforceLfsGuardResult {
  /** Violations the caller explicitly approved; empty on a clean accept. */
  approved: LfsBlobViolation[];
  /** Non-fatal notes for the accept's warning list. */
  warnings: string[];
}

/**
 * Enforce the guard for one accept.
 *
 * Throws {@link LfsPointerRefusedError} when the merge would land a raw blob on
 * an LFS-tracked path that has not been approved. Approved violations pass
 * through and are returned so the caller can record them in the accept's
 * warnings — an approved raw blob is still a fact worth having in the audit
 * trail.
 *
 * A repository that does not use LFS costs one `git grep` and returns clean.
 */
export async function enforceLfsGuard(
  params: EnforceLfsGuardParams,
): Promise<EnforceLfsGuardResult> {
  const scan = await findNonPointerLfsBlobs({
    cwd: params.projectRoot,
    ref: params.sourceBranch,
    baseRef: params.mergeBase,
  });

  const warnings: string[] = [];
  if (scan.pathsCapped) {
    warnings.push(
      `LFS guard: \`${params.sourceBranch}\` changes more than ${MAX_SCANNED_PATHS} files, ` +
      `so only the first ${MAX_SCANNED_PATHS} were checked for raw blobs on LFS paths.`,
    );
  }

  if (scan.violations.length === 0) return { approved: [], warnings };

  const approvedSet = new Set(params.approvedFiles ?? []);
  const unapproved = scan.violations.filter((v) => !approvedSet.has(v.path));
  if (unapproved.length > 0) {
    throw new LfsPointerRefusedError(
      lfsRefusalMessage(params.displayId, params.sourceBranch, params.targetBranch, unapproved),
      unapproved,
    );
  }

  warnings.push(
    `Approved ${scan.violations.length} file(s) committed as raw content on LFS-tracked paths: ` +
    `${scan.violations.map((v) => v.path).join(', ')}.`,
  );
  return { approved: scan.violations, warnings };
}
