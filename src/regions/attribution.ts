/**
 * Blame-weighted ownership — the rule that makes a carved review a PARTITION.
 *
 * The question is "of the lines this review added or changed, which unit's
 * work is still standing in the final version". `git blame` of the branch tip
 * answers it directly: a line surviving at head and authored by a commit INSIDE
 * the review range is, by construction, a line the review's own three-dot diff
 * added. So there is no hunk parsing here and no need to restrict the blame to
 * a line range — filtering the blame's shas to the range does exactly that, and
 * does it with one `git blame` per changed file rather than two.
 *
 * Everything is keyed on COMMIT SHA, not on a file's region: one blame pass
 * serves every level of the tree, because each level only has to map the same
 * shas to a different set of sibling units.
 */

import { runGit } from '../utils/git';

/** Surviving-line counts for one path, by the commit that authored them. */
export interface FileAttribution {
  /** commit sha → lines of this file at head that the commit authored. */
  lines: Map<string, number>;
  /** Total of `lines` — the review's surviving footprint in this file. */
  total: number;
  /**
   * The last in-range commit to touch the path, for a file blame cannot speak
   * for: one that is DELETED at head, a binary file, or one whose review lines
   * were all later removed again. Resolved lazily, and only for those files.
   */
  lastTouch?: string;
}

/**
 * Blame-derived attribution for every path in a review range.
 *
 * One `git diff --name-status` for the file list, then one `git blame` per
 * file that still exists at head. That is the budget the carve is held to:
 * proportional to the review's file count, not to its commit count, and shared
 * by every level of the region tree.
 */
export interface ReviewAttribution {
  /** Every path in `base...head`, in the order git listed them. */
  paths: string[];
  /** Paths the review DELETES. Blame cannot speak for these. */
  deleted: Set<string>;
  byPath: Map<string, FileAttribution>;
}

/**
 * Every path the review's three-dot diff touches, with the deleted ones flagged.
 *
 * Three-dot deliberately: that is what `lazy diff` renders and what the
 * partition has to sum to. A two-dot range would include upstream's own work
 * whenever the branch is behind.
 */
export async function listReviewPaths(
  cwd: string,
  baseSha: string,
  headSha: string,
): Promise<{ paths: string[]; deleted: Set<string> }> {
  const result = await runGit(
    ['diff', '-z', '--name-status', '--no-renames', `${baseSha}...${headSha}`],
    { cwd },
  );
  const paths: string[] = [];
  const deleted = new Set<string>();
  if (result.exitCode !== 0 || !result.stdout) return { paths, deleted };
  // `-z` emits `<status>\0<path>\0` pairs. `--no-renames` keeps it to two
  // fields per record: a rename would add a third and shift every pair after
  // it, and a review that renames a file is reviewing both paths anyway.
  const fields = result.stdout.split('\0').filter((f) => f.length > 0);
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i]!;
    const path = fields[i + 1]!;
    paths.push(path);
    if (status.startsWith('D')) deleted.add(path);
  }
  return { paths, deleted };
}

const BLAME_HEADER_RE = /^([0-9a-f]{40}) \d+ (\d+) (\d+)$/;

/** A run of consecutive final-image lines that one commit authored. */
export interface BlameRun {
  sha: string;
  /** 1-based post-image line numbers, inclusive. */
  start: number;
  end: number;
}

/**
 * The same blame, kept as RUNS rather than reduced to per-commit counts.
 *
 * The porcelain group header is `<sha> <orig line> <final line> <count>`, so a
 * run is right there in the output — {@link blameLineCounts} sums the count and
 * throws the final line away, which is exactly the boundary the per-line gutter
 * needs. Two readers of one command rather than one reader and a second git
 * call, and neither pays for the other: the carve never wants runs, and the
 * gutter never wants totals.
 *
 * Runs come back sorted by line, and adjacent runs of the same commit are
 * merged — git emits one group per contiguous stretch it found, which for a
 * file edited twice by the same commit is several groups that read as one run.
 */
export async function blameLineRuns(
  cwd: string,
  headSha: string,
  path: string,
): Promise<BlameRun[]> {
  const result = await runGit(
    ['blame', '--porcelain', '--no-abbrev', headSha, '--', path],
    { cwd },
  );
  if (result.exitCode !== 0 || !result.stdout) return [];
  const runs: BlameRun[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = BLAME_HEADER_RE.exec(line);
    if (!match) continue;
    const sha = match[1]!;
    const start = Number.parseInt(match[2]!, 10);
    const end = start + Number.parseInt(match[3]!, 10) - 1;
    const last = runs[runs.length - 1];
    if (last && last.sha === sha && last.end + 1 === start) last.end = end;
    else runs.push({ sha, start, end });
  }
  runs.sort((a, b) => a.start - b.start);
  return runs;
}

/**
 * Lines of `path` at `headSha` grouped by the commit that authored them.
 *
 * `--porcelain` rather than `--line-porcelain`: the header of each group
 * already carries the group's line COUNT, which is all a tally needs, and the
 * per-line form is several times the output for the same answer. Content lines
 * are TAB-prefixed in this format, so a line of source that looks like a header
 * cannot be mistaken for one.
 *
 * Never throws. A file blame cannot read — binary, gone, a submodule — comes
 * back empty and falls through to the last-touch fallback.
 */
export async function blameLineCounts(
  cwd: string,
  headSha: string,
  path: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const result = await runGit(
    ['blame', '--porcelain', '--no-abbrev', headSha, '--', path],
    { cwd },
  );
  if (result.exitCode !== 0 || !result.stdout) return counts;
  for (const line of result.stdout.split('\n')) {
    const match = BLAME_HEADER_RE.exec(line);
    if (!match) continue;
    const sha = match[1]!;
    counts.set(sha, (counts.get(sha) ?? 0) + Number.parseInt(match[3]!, 10));
  }
  return counts;
}

/**
 * The last commit inside the review range to touch a path.
 *
 * The honest answer for a file blame cannot weigh: a DELETED file goes to the
 * unit that deleted it, which is what this returns, and a file whose review
 * lines were all overwritten by a later unit goes to that later unit.
 */
export async function lastTouchingCommit(
  cwd: string,
  baseSha: string,
  headSha: string,
  path: string,
): Promise<string | null> {
  const result = await runGit(
    ['log', '--format=%H', '-1', headSha, `^${baseSha}`, '--', path],
    { cwd },
  );
  if (result.exitCode !== 0) return null;
  return result.stdout.trim().split('\n')[0]?.trim() || null;
}

/**
 * Blame every file of a review range, once.
 *
 * `only` restricts the pass to a subset of the paths — the incremental refresh
 * re-settles just the files a turn touched and must not pay for the rest.
 */
export async function computeReviewAttribution(
  cwd: string,
  baseSha: string,
  headSha: string,
  only?: ReadonlySet<string>,
): Promise<ReviewAttribution> {
  const { paths, deleted } = await listReviewPaths(cwd, baseSha, headSha);
  const inRange = await commitsInRange(cwd, baseSha, headSha);
  const byPath = new Map<string, FileAttribution>();
  const wanted = only ? paths.filter((p) => only.has(p)) : paths;

  const attributeOne = async (path: string): Promise<void> => {
    const lines = new Map<string, number>();
    let total = 0;
    if (!deleted.has(path)) {
      for (const [sha, count] of await blameLineCounts(cwd, headSha, path)) {
        // A line written before the review started belongs to nobody here.
        // This is what turns a whole-file blame into "the lines the review
        // touched" without a single hunk being parsed.
        if (!inRange.has(sha)) continue;
        lines.set(sha, count);
        total += count;
      }
    }
    const entry: FileAttribution = { lines, total };
    if (total === 0) {
      const last = await lastTouchingCommit(cwd, baseSha, headSha, path);
      if (last) entry.lastTouch = last;
    }
    byPath.set(path, entry);
  };

  // Bounded concurrency, because this is the one part of the carve whose cost
  // scales with the review rather than with its history: a 2,258-file release
  // is 2,258 `git blame` subprocesses, and run one at a time that is most of a
  // minute of a background carve spent waiting on process startup. Bounded
  // rather than unbounded so a huge review cannot fork a thousand children at
  // once on the machine the daemon is sharing with everything else.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(BLAME_CONCURRENCY, wanted.length) }, async () => {
      for (let i = next++; i < wanted.length; i = next++) {
        await attributeOne(wanted[i]!);
      }
    }),
  );

  return { paths, deleted, byPath };
}

/** How many `git blame` subprocesses the attribution pass keeps in flight. */
const BLAME_CONCURRENCY = 8;

/** Every commit reachable from head and not from base — one `rev-list`. */
export async function commitsInRange(
  cwd: string,
  baseSha: string,
  headSha: string,
): Promise<Set<string>> {
  const result = await runGit(['rev-list', headSha, `^${baseSha}`], { cwd });
  if (result.exitCode !== 0 || !result.stdout) return new Set();
  return new Set(result.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
}

/**
 * Map every commit of a range to the FIRST-PARENT commit that brought it in.
 *
 * Blame answers with the commit that really wrote a line, which on a merged
 * task branch is a commit off the first-parent line — while a region is
 * identified by the first-parent commit (the accept squash, or the merge). So
 * the tally needs the bridge between them, and it needs it without one
 * `rev-list` per region: on a release hub that would be several hundred
 * subprocesses for a question one traversal answers.
 *
 * One `rev-list --parents` builds the graph; the chain is then walked
 * OLDEST-FIRST, claiming everything reachable from each chain commit that is
 * not already claimed. Oldest-first is what makes it a single pass: by the time
 * a chain commit C is processed its first parent is already claimed, so the
 * traversal stops there immediately and only walks C's side branch. Whatever it
 * reaches is exactly the work C brought onto the branch.
 */
export async function mapCommitsToChain(
  cwd: string,
  chainNewestFirst: readonly string[],
  headSha: string,
  excludes: readonly string[],
): Promise<Map<string, string>> {
  const owner = new Map<string, string>();
  if (chainNewestFirst.length === 0) return owner;

  const args = ['rev-list', '--parents', headSha];
  for (const ex of excludes) if (ex) args.push(`^${ex}`);
  const result = await runGit(args, { cwd });
  if (result.exitCode !== 0 || !result.stdout) {
    // No graph, so the only honest mapping is each chain commit to itself.
    for (const sha of chainNewestFirst) owner.set(sha, sha);
    return owner;
  }

  const parents = new Map<string, string[]>();
  for (const line of result.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    const sha = parts[0];
    if (!sha) continue;
    parents.set(sha, parts.slice(1));
  }

  for (let i = chainNewestFirst.length - 1; i >= 0; i--) {
    const root = chainNewestFirst[i]!;
    if (owner.has(root)) continue;
    const stack = [root];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (owner.has(sha)) continue;
      // Outside the range entirely: not this review's work at all.
      if (!parents.has(sha)) continue;
      owner.set(sha, root);
      for (const parent of parents.get(sha) ?? []) {
        if (!owner.has(parent)) stack.push(parent);
      }
    }
  }
  return owner;
}
