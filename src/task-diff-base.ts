/**
 * One answer to "which ref is a task's diff rendered against?"
 *
 * A task diff is only meaningful if its base is the ref the task branch was CUT
 * from. The launcher cuts it through `resolveUpstreamMergeRef` (see
 * src/remote/upstream-ref.ts and the CLAUDE.md invariant it implements), so every
 * diff surface must resolve it through the same function — otherwise the diff
 * attributes somebody else's history to the task.
 *
 * That split is exactly what produced the fleet 90k-file diff
 * (fix-fleet-task-diff-base). A fleet-provisioned project is a fresh `git clone`
 * whose lazy.toml gets `driver = "github"`, so:
 *
 *   - the launcher resolved `main` → `origin/main` (fetch first) and cut the task
 *     branch from the CURRENT upstream tip;
 *   - the diff used the raw LOCAL `main`, which in such a clone is frozen at
 *     clone time forever — nothing ever pulls it, and accepts into a protected
 *     default land on the forge, not locally.
 *
 * `main...HEAD` then has its merge base at the clone-time commit, so the diff
 * showed every upstream commit since provisioning as if the task had written it.
 * On a Teams hosted-git project the clone happens when `main` is still the
 * one-file seed commit, which is why the first task's diff was the entire
 * repository.
 *
 * Resolution here is deliberately NO-NETWORK (`refreshRemote: false`): rendering
 * a diff must not fetch, must not fail offline, and does not need to — a
 * three-dot diff is merge-base-based, so a remote-tracking ref that is a few
 * commits stale produces an identical diff. The DECISION (local ref vs remote
 * ref) is the same one the launcher made.
 *
 * A second question lives here too: on a task with accepted children (a release
 * hub), which of those files are the hub's *own* work? `resolveTaskDirectDiff`
 * answers that so CLI, MCP, web and TUI cannot disagree. See the function
 * docs for why we path-restrict the three-dot diff rather than inventing a
 * second git invocation.
 */

import type { ResolvedConfig } from './config/types';
import type { Storage } from './storage/interface';
import type { Session, Task, TaskStatus } from './types';
import { createDriver } from './remote';
import { resolveUpstreamMergeRef } from './remote/upstream-ref';
import { acceptTagName, getRemoteDefaultBranch, hasUncommittedChanges } from './git/operations';
import { displayId, getBranchNameFromId, shortId } from './task/identity';
import { integrationBranchOf, parentTaskIdOf } from './task-target';
import { runGit } from './utils/git';
import { logger } from './utils/logger';

export interface TaskDiffBase {
  /** The ref to diff against. Always one that resolves in `worktreePath`. */
  ref: string;
  /** True when the base is a concrete SHA and must be diffed with `..`. */
  twoDot: boolean;
  /** The parent/integration branch name the base was derived from. */
  parentBranch: string;
  /** Divergence warnings from the shared resolution, for surfaces that show them. */
  warnings: string[];
}

async function refResolves(ref: string, cwd: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
  return result.exitCode === 0;
}

/**
 * Resolve the base ref for a task's own diff (branch point → HEAD).
 *
 * Never throws and never fetches: a diff surface that fails because a forge is
 * unreachable is worse than one rendered from the refs already on disk. When
 * nothing resolves, falls back through the session's `upstream_merge_sha` and
 * finally the parent branch name itself, so the caller's git invocation reports
 * the real error rather than this function inventing one.
 */
export async function resolveTaskDiffBase(opts: {
  task: Task;
  session: Pick<Session, 'upstream_merge_sha'>;
  storage: Storage;
  projectRoot: string;
  worktreePath: string;
  config: ResolvedConfig;
}): Promise<TaskDiffBase> {
  const { task, session, storage, projectRoot, worktreePath, config } = opts;
  const warnings: string[] = [];

  // Stacked task: its base is the parent TASK's branch. Top-level: the branch it
  // was explicitly created against, else the repo's integration branch — never
  // whatever branch happens to be checked out.
  const parentId = parentTaskIdOf(task);
  const parentBranch = parentId
    ? await getBranchNameFromId(parentId, storage)
    : (integrationBranchOf(task)
      ?? await getRemoteDefaultBranch(projectRoot, config.remote.git_remote));

  const candidates: string[] = [];
  try {
    const resolution = await resolveUpstreamMergeRef(
      createDriver(config),
      parentBranch,
      worktreePath,
      { remoteName: config.remote.git_remote, refreshRemote: false },
    );
    warnings.push(...resolution.warnings);
    candidates.push(resolution.ref);
  } catch (err) {
    // Resolution is advisory for a read-only diff: fall through to the plain
    // branch rather than refusing to render anything.
    logger.debug(
      `resolveTaskDiffBase: upstream resolution failed for ${parentBranch}: ` +
      `${err instanceof Error ? err.message : err}`,
    );
  }
  // The local branch is the second choice, not the first — see the module docs.
  if (!candidates.includes(parentBranch)) candidates.push(parentBranch);

  for (const ref of candidates) {
    if (await refResolves(ref, worktreePath)) {
      return { ref, twoDot: false, parentBranch, warnings };
    }
  }

  // Neither ref exists here (worktree recovered from a remote branch, parent
  // branch already deleted). The sync merge point is a concrete commit on this
  // branch, so it needs a two-dot range.
  if (session.upstream_merge_sha) {
    return { ref: session.upstream_merge_sha, twoDot: true, parentBranch, warnings };
  }
  return { ref: parentBranch, twoDot: false, parentBranch, warnings };
}

/**
 * Statuses that mean a child is still live on the hub — listed under
 * "In progress" on the review Changes block, never as accepted work.
 * Backlog and abandoned are neither: they have not landed and are not running.
 */
const HUB_IN_PROGRESS_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'working',
  'blocked',
  'pairing',
  'interrupted',
  'submitted',
  'merging',
  'conflict',
  'zombie',
]);

export interface HubChildGroups {
  accepted: Task[];
  inProgress: Task[];
}

/**
 * Split a task's direct children into the two groups the hub review surfaces.
 *
 * Accepted = `complete` (the child's squash/merge has landed on the hub).
 * In progress = still live. Everything else (backlog, abandoned) is omitted
 * from the minimal Changes list — the later Subtasks tab owns the full set.
 */
export function classifyHubChildren(children: Task[]): HubChildGroups {
  const accepted: Task[] = [];
  const inProgress: Task[] = [];
  for (const child of children) {
    if (child.status === 'complete') accepted.push(child);
    else if (HUB_IN_PROGRESS_STATUSES.has(child.status)) inProgress.push(child);
  }
  return { accepted, inProgress };
}

/**
 * How a hub's "own" diff is scoped relative to the whole-branch three-dot
 * range `resolveTaskDiffBase` already named.
 *
 * A release hub's branch contains every accepted child's squash. A tree-to-tree
 * `base...HEAD` is therefore the union of those children — hundreds of files
 * that were each already reviewed at accept. Direct changes are the first-parent
 * commits that are NOT those squash/merge commits, plus any uncommitted work
 * in the hub worktree.
 *
 * Why path-restrict the existing three-dot diff rather than concatenating
 * per-commit patches: the review page, file-lines expand, and `getDiffFull`
 * already speak one unified `git diff`. Restricting it to paths touched by
 * those first-parent commits reuses that pipeline and still drops the
 * children's files. The trade-off is honest and documented: if the hub later
 * edits a file a child also touched, the three-dot hunk for that file includes
 * the child's lines too. A release hub's own commits typically touch a handful
 * of files (changelog dating, version); the 1,843-file failure was the union
 * of 301 children, which this drops. A large *direct* diff is a later ToC
 * problem, not a reason to cap here.
 *
 * `fullBranch: true` is the escape hatch (`--full-branch` / `full_branch`):
 * same base, no path restriction, today's whole-branch diff.
 */
export interface TaskDirectDiffPlan {
  base: TaskDiffBase;
  /**
   * Paths the diff is restricted to. `undefined` means unrestricted (no
   * accepted children, or the caller asked for the whole branch). An empty
   * array means scoped and the hub has no files of its own — callers MUST
   * treat that as an empty diff, not pass `[]` to git (which means "all").
   */
  paths: string[] | undefined;
  /** True when accepted-child squash commits were excluded from the path set. */
  scopedToDirect: boolean;
  acceptedChildren: Task[];
  inProgressChildren: Task[];
  /**
   * Per accepted child: which paths its accept contributed to this branch, when
   * that could be attributed. Present only when `scopedToDirect` — it is built
   * from the same tag map and first-parent walk that produced `paths`, at zero
   * extra git cost. Absent otherwise.
   */
  childAttribution?: ChildAttribution[];
}

/**
 * The paths one accepted child's accept contributed to the hub's branch.
 *
 * This is the mirror of `paths`' exclusion: the direct diff DROPS these paths
 * (they were reviewed at the child's own accept), and callers that must widen
 * the set back — the protected-file resolver asks again about files an
 * agent-audience child deferred to the hub's final — read them from here
 * rather than walking git a second time.
 */
export interface ChildAttribution {
  /** The accepted child's task id. */
  childId: string;
  /** Paths the child's accept commit(s) touched on this branch. */
  paths: string[];
  /**
   * False when no commit could be attributed: the child has no accept tag and
   * no first-parent commit whose subject matches, or its tagged commit is not
   * in the walked range. Its paths are unknown — and because an unattributed
   * commit is also never EXCLUDED, they are already inside `paths`. Callers
   * must not read `paths: []` as "the child touched nothing".
   */
  attributed: boolean;
}

/**
 * Paths (or the empty-diff sentinel) to pass to `getDiffFull` / `getDiffStat`.
 *
 * Never returns `[]` to mean "unrestricted" — that is git's "whole tree".
 * `empty: true` is the only safe encoding of "scoped, nothing to show".
 */
export function gitDiffPaths(plan: TaskDirectDiffPlan): {
  paths: string[] | undefined;
  empty: boolean;
} {
  if (!plan.scopedToDirect) return { paths: undefined, empty: false };
  if (!plan.paths || plan.paths.length === 0) return { paths: [], empty: true };
  return { paths: plan.paths, empty: false };
}

/**
 * Resolve a task's *direct* diff: the same base as `resolveTaskDiffBase`,
 * optionally restricted to paths the task itself changed after excluding
 * accepted children's merge/squash commits.
 *
 * Never throws and never fetches. Git cost is constant in child count (one
 * for-each-ref of every accept tag, one first-parent log of SHA + subject +
 * paths). A missing accept tag falls back to the first-parent commit whose
 * subject is `Accept task <id>:` / `Accept task <code>:`, matched in-process.
 * A child with neither is not excluded — better to show a file twice than to
 * hide a hub commit we could not attribute.
 *
 * `tipRef` is the right-hand side of the range (default `HEAD`). The TUI's
 * worktree-gone fallback diffs the task branch from the project root and
 * must pass that branch here so the first-parent walk matches the diff.
 */
export async function resolveTaskDirectDiff(opts: {
  task: Task;
  session: Pick<Session, 'upstream_merge_sha' | 'git_branch'>;
  storage: Storage;
  projectRoot: string;
  worktreePath: string;
  config: ResolvedConfig;
  /** Escape hatch: do not exclude accepted children. */
  fullBranch?: boolean;
  /** Right-hand side of the range. Default HEAD (the worktree). */
  tipRef?: string;
}): Promise<TaskDirectDiffPlan> {
  const base = await resolveTaskDiffBase(opts);
  const children = await opts.storage.getChildTasks(opts.task.id);
  const { accepted, inProgress } = classifyHubChildren(children);
  const tipRef = opts.tipRef ?? 'HEAD';

  if (opts.fullBranch || accepted.length === 0) {
    return {
      base,
      paths: undefined,
      scopedToDirect: false,
      acceptedChildren: accepted,
      inProgressChildren: inProgress,
    };
  }

  const cwd = opts.worktreePath;
  // Three git calls, independent of child count: one for-each-ref of every
  // accept tag, one first-parent log (SHA + subject + paths), then the
  // existing dirty-worktree pair. A per-child rev-parse/grep/diff-tree loop
  // is what made release-v022's review page spawn 600+ gits — the page this
  // function exists to keep small.
  const tagToCommit = await listAcceptTagCommits(cwd);
  const firstParent = await listFirstParentCommits(base.ref, tipRef, cwd);
  const exclude = excludeAcceptedChildShas(accepted, tagToCommit, firstParent);
  const childAttribution = accepted.map((child) => attributeChild(child, tagToCommit, firstParent));
  const paths = new Set<string>();
  for (const commit of firstParent) {
    if (exclude.has(commit.sha)) continue;
    for (const p of commit.paths) paths.add(p);
  }
  // Uncommitted work in the hub worktree is always the hub's own — include
  // those paths so a dirty hub still reviews what is on disk. Only when the
  // tip is HEAD: a branch-name tip has no dirty tree.
  if (tipRef === 'HEAD' && await hasUncommittedChanges(cwd)) {
    for (const p of await dirtyPaths(cwd)) paths.add(p);
  }

  return {
    base,
    paths: [...paths],
    scopedToDirect: true,
    acceptedChildren: accepted,
    inProgressChildren: inProgress,
    childAttribution,
  };
}

/**
 * Which paths one accepted child's accept contributed to the hub's branch.
 *
 * The mirror of `excludeAcceptedChildShas`: same tag-preferred lookup, same
 * subject fallback, over the same two maps — zero extra git calls. A child
 * with a tag whose commit is outside the walked range gets `attributed: false`
 * with empty paths; its exclusion also failed (the tag SHA was never in the
 * walk), so its paths are inside the direct set and nothing is lost.
 */
function attributeChild(
  child: Task,
  tagToCommit: Map<string, string>,
  firstParent: FirstParentCommit[],
): ChildAttribution {
  const tagged = tagToCommit.get(acceptTagName(child.id));
  const commits = tagged
    ? firstParent.filter((commit) => commit.sha === tagged)
    : firstParent.filter((commit) =>
        acceptSubjectNeedles(child).some((needle) => commit.subject.includes(needle))
      );
  const paths = new Set<string>();
  for (const commit of commits) {
    for (const p of commit.paths) paths.add(p);
  }
  return { childId: child.id, paths: [...paths], attributed: commits.length > 0 };
}

/**
 * Every `lazy-accept-<id>` tag in the repo, peeled to a commit SHA.
 *
 * One `for-each-ref`: `%( *objectname )` is the peeled commit on an annotated
 * tag and empty on a lightweight tag, where `%(objectname)` is already the
 * commit. Callers look children up in the map — never `rev-parse` per child.
 */
async function listAcceptTagCommits(cwd: string): Promise<Map<string, string>> {
  const result = await runGit(
    [
      'for-each-ref',
      '--format=%(refname:short) %(*objectname) %(objectname)',
      'refs/tags/lazy-accept-*',
    ],
    { cwd },
  );
  const map = new Map<string, string>();
  if (result.exitCode !== 0) return map;
  for (const line of result.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    // Annotated: name, peeled commit, tag object. Lightweight: name, commit
    // (`*objectname` empty, so split collapses to two fields).
    const name = parts[0]!;
    const sha = parts.length >= 3 ? (parts[1] || parts[2]!) : parts[1]!;
    if (name && sha) map.set(name, sha);
  }
  return map;
}

interface FirstParentCommit {
  sha: string;
  subject: string;
  paths: string[];
}

/**
 * First-parent commits in `<from>..<tip>` with subject and paths, in one log.
 *
 * `%H%x00%s` keeps the SHA/subject split unambiguous; `--name-only` lists
 * each commit's paths underneath. Used both for the walk and for the
 * subject-fallback (in-process `Accept task <id>:` match — no `--grep`).
 */
async function listFirstParentCommits(
  fromRef: string,
  tipRef: string,
  cwd: string,
): Promise<FirstParentCommit[]> {
  const result = await runGit(
    [
      'log',
      '--first-parent',
      '--name-only',
      '--format=%H%x00%s',
      `${fromRef}..${tipRef}`,
    ],
    { cwd },
  );
  if (result.exitCode !== 0 || !result.stdout) return [];
  return parseFirstParentLog(result.stdout);
}

function parseFirstParentLog(stdout: string): FirstParentCommit[] {
  const commits: FirstParentCommit[] = [];
  let current: FirstParentCommit | null = null;
  for (const raw of stdout.split('\n')) {
    const nul = raw.indexOf('\0');
    if (nul >= 0) {
      if (current) commits.push(current);
      current = {
        sha: raw.slice(0, nul).trim(),
        subject: raw.slice(nul + 1),
        paths: [],
      };
      continue;
    }
    const path = raw.trim();
    if (path && current) current.paths.push(path);
  }
  if (current) commits.push(current);
  return commits;
}

/**
 * SHAs to drop from the first-parent walk: each accepted child's accept-tag
 * commit, or — when the tag is missing — any first-parent whose subject
 * carries `Accept task <id>:` / `Accept task <code>:`.
 *
 * In-process over the maps from the two batched git calls. A child with
 * neither tag nor matching subject is not excluded — better to show a file
 * twice than to hide a hub commit we could not attribute.
 */
function excludeAcceptedChildShas(
  accepted: Task[],
  tagToCommit: Map<string, string>,
  firstParent: FirstParentCommit[],
): Set<string> {
  const exclude = new Set<string>();
  for (const child of accepted) {
    const tagged = tagToCommit.get(acceptTagName(child.id));
    if (tagged) {
      exclude.add(tagged);
      continue;
    }
    const needles = acceptSubjectNeedles(child);
    for (const commit of firstParent) {
      if (needles.some((needle) => commit.subject.includes(needle))) {
        exclude.add(commit.sha);
      }
    }
  }
  return exclude;
}

function acceptSubjectNeedles(child: Task): string[] {
  const needles = [`Accept task ${shortId(child.id)}:`];
  if (child.code) needles.push(`Accept task ${child.code}:`);
  const shown = displayId(child);
  if (shown !== shortId(child.id) && shown !== child.code) {
    needles.push(`Accept task ${shown}:`);
  }
  return needles;
}

async function dirtyPaths(cwd: string): Promise<string[]> {
  const result = await runGit(['diff', '--name-only', 'HEAD'], { cwd });
  if (result.exitCode !== 0) return [];
  return result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}
