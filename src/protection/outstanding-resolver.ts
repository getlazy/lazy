/**
 * One resolver for "which protected files does this task still owe a decision
 * on" — the answer every reviewer-facing surface and the accept gate read.
 *
 * The rule and the two failure modes it closes are documented in
 * src/protection/outstanding.ts. This module is the git-side half: it works out
 * WHAT to scan and never throws — a scan it cannot run degrades to the
 * conservative records-only answer rather than to "nothing is owed".
 *
 * Lives under src/protection/ rather than src/daemon/ deliberately: the web
 * review page needs the same answer, and src/server/ must not import from
 * src/daemon/ (the daemon imports the server, so that edge would be a cycle).
 * Everything it depends on — config, git, detection, the diff-base resolver —
 * is neutral.
 *
 * ## The range is the task's DIRECT changes — widened by what children deferred
 *
 * INVARIANT: the range comes from `resolveTaskDirectDiff` — the resolver
 * `lazy diff` and the review page already use — never from a locally computed
 * ref (CLAUDE.md's diff-base rule) and never from the unrestricted whole-branch
 * range.
 *
 * The whole-branch range is wrong here for a task with accepted children: a
 * release hub's branch CONTAINS every accepted child's squash, so scanning it
 * re-asks about every protected file those children touched — each of which was
 * already approved at that child's own accept, on that child's own records.
 * On a project that protects every `.ts` under `test/` that is potentially hundreds of
 * files, refusing every release accept and parking the hub in `conflict` after
 * every turn. Gating on the same range the reviewer is shown is both correct and
 * the only thing they can act on.
 *
 * But "the direct range" alone is wrong in the other direction for an
 * AGENT-audience child. Its protected-file push-back records what the agent
 * kept, but that is not a human approval decision, so its files are deferred to
 * the hub's human-facing review. The scan's path set is the task's direct paths UNION the
 * attributed paths of its agent-audience accepted children (`plan.childAttribution`,
 * built from the same tag map and first-parent walk at zero extra git cost), and
 * the no-direct-changes shortcut narrows to match: a hub whose own path set is
 * empty still owes its children's deferred files. Human-audience children asked
 * no such deferral — their files stay excluded and their approvals join.
 *
 * ## Approvals span the accepted children
 *
 * A child's accept records its approvals on the CHILD's turns. Those are human
 * decisions when the child is human-audience, so they join this task's approved
 * set — and clear this task's own pending records for the same files (its final
 * push-back writes those mechanistically, a question asked, not a decision
 * made). An agent-audience child's approval is its agent's answer to its own
 * prompt, not a human's — it never joins. This task's own latest record still
 * wins per file: a file it rejected stays outstanding even if a child approved
 * it, and a file it approved needs no child record.
 *
 * INVARIANT: what a child's approval clears is THAT CHILD'S edit of the file,
 * and nothing else on the branch. Two other edits of the same path can exist,
 * and a path carrying either drops out of the child union entirely:
 *
 *   - one this task made ITSELF — it is in `plan.paths`, the same direct range
 *     `lazy diff` renders. The human approved the child's version of
 *     `CHANGELOG.md` at the child's accept and has been asked nothing about the
 *     hub's own later edit of it.
 *   - one an AGENT-audience child DEFERRED to this final (`deferredPaths`,
 *     §14 below). No human approved that edit, which is the whole reason it
 *     widens the scan; a human-audience sibling's approval of the
 *     same path is a decision about a different edit. Their own approval does
 *     not clear it (it never joins the union at all), so a sibling's must not
 *     either — a hub with one child of each audience touching `CHANGELOG.md` is
 *     the ordinary release case.
 *
 * Dropping such a path from the union rather than only from the outstanding
 * list keeps the two answers agreeing — a file cannot be reported approved and
 * outstanding at once.
 *
 * The test is `plan.paths` and NOT per-child attribution, deliberately. An
 * UNATTRIBUTED child's accept (no tag, no matching subject) is not excluded
 * from the direct set either (src/task-diff-base.ts, "show twice, never
 * hide"), so its paths sit inside `plan.paths` and its approvals stop
 * clearing. That is the same range in both answers on purpose: `lazy diff`
 * presents those files as the hub's own change, and a file the reviewer is
 * SHOWN as this task's work while the gate quietly does not ask about it is
 * exactly the silently-narrowed gate this rule exists to close. Narrowing by
 * `childAttribution.attributed` would buy back the clear at the cost of that
 * alignment. Over-asking costs one decision on files the reviewer can see;
 * under-asking merges a protected change nobody looked at. Both directions are
 * pinned in test/unit/outstanding-resolver.test.ts.
 *
 * The degraded records-only path has no range to compare against and keeps the
 * older, broader clear — without git it cannot tell the hub's own edit from
 * the child's, and its whole job is to answer without git.
 *
 * ## Cost
 *
 * Every `lazy show`, every review-page render and every end-of-turn park calls
 * this, so the warm path is the one that matters.
 *
 * A WARM READ COSTS ONE `git rev-parse HEAD` and nothing else — a config read,
 * a stat, that one spawn, then a map lookup. Everything expensive sits BELOW the
 * cache check on purpose: `resolveTaskDirectDiff` (a `for-each-ref` over every
 * accept tag plus a first-parent log with per-commit path lists, worst on
 * exactly the release hub that gets viewed most), the `merge-base`, the
 * branch-wide `git diff --name-status`, the batched `ls-tree`, and the per-child
 * contribution reads (session + turns + status changelog for every accepted
 * child) — all of it runs at cache-fill time only, which is what the memo exists
 * to amortize. The child-approval union rides the cache VALUE, so a warm read
 * never opens a child's records. Keep it that way: a cache below the range
 * computation still pays for the range.
 *
 * Resolving HEAD by reading `.git` ourselves would be re-implementing plumbing
 * to save a call that walks no tree, so that one spawn stays.
 *
 * The RECORDS half is pure and always recomputed, which is what makes a fresh
 * approval show up immediately without the cache having to know about it. A
 * project with no protected patterns and nothing owed returns before any of
 * this, and `lazy list` never calls the resolver at all.
 *
 * ## Staleness window, by design
 *
 * The cache is keyed on HEAD, and the child contributions are computed only at
 * fill time. A child record that changes without any commit landing on this
 * branch — a no-op re-accept of a reopened child whose tip is already an
 * ancestor — keeps serving the pre-change union until HEAD moves. That can only
 * OVER-ask (a fresh approval not yet joined), never under-ask: an approval that
 * disappears does so through a later accept, which is a commit. The same window
 * predates the union for the detected set itself — a reopened child's paths
 * re-enter the plan only when the plan is recomputed.
 */

import { createHash } from 'crypto';
import { loadConfig } from '../config/loader';
import { runGit } from '../utils/git';
import { logger } from '../utils/logger';
import { pathExists } from '../utils/fs';
import { detectViolations } from '../supervisor/permissions';
import {
  classifyHubChildren,
  resolveTaskDirectDiff,
  type ChildAttribution,
  type TaskDirectDiffPlan,
} from '../task-diff-base';
import { getWorktreePath } from '../task/identity';
import { audienceOf, type TaskAudience } from '../task/audience';
import {
  approvedFilesFromRecords,
  outstandingFromDetection,
  outstandingFromRecords,
  pendingFilesFromRecords,
  violationRecordsByFile,
} from './outstanding';
import type { Storage } from '../storage/interface';
import type { Actor, FileViolation, Session, Task, Turn } from '../types';

export interface OutstandingViolations {
  /** Protected files still in the task's own changes with no approval recorded. */
  outstanding: FileViolation[];
  /**
   * Files a human has already approved, latest decision per file: this task's
   * own approvals plus those recorded at human-audience accepted children's
   * own accepts for paths this task did not itself change, minus files this
   * task itself rejected.
   */
  approved: string[];
  /** Everything the scan saw, decided or not. Empty when it could not run. */
  detected: FileViolation[];
  /** True when the answer came from records alone (no scan). */
  degraded: boolean;
}

/**
 * What this task's accepted children contribute to its protected-file answer.
 * Approvals count only from human-audience children; deferrals (paths the hub
 * must ask about) only from agent-audience ones.
 */
interface ChildContributions {
  childApproved: string[];
  deferredPaths: string[];
}

/**
 * Detection results keyed on (task, HEAD sha, effective patterns) — the three
 * things that can change what a scan would find, and the three that are cheap
 * to learn before doing any of the work.
 *
 * Why those three are enough. The BASE cannot move without HEAD moving: it is
 * the merge-base with the parent, so parent commits that are not in this
 * branch's history do not shift it, and anything that does bring them in (a
 * sync, accepting a child into this branch) is itself a commit here. The
 * DIRECT-DIFF PATH SET is derived from the first-parent log of that same range,
 * so it moves with HEAD too — except for uncommitted work, which only ever
 * widens the path FILTER and can never widen what `detectViolations` sees,
 * because that reads two commits and never the working tree.
 *
 * Anything else moving — a new approval, a new turn — changes only the records
 * half, which is recomputed on every call. That is what makes a fresh ✅ show up
 * without the cache having to know it happened. (A pending record's path is part
 * of the effective pattern list, so deciding one does re-key, correctly.)
 *
 * Bounded and FIFO-evicted. This is a memo, not state: losing it costs one scan.
 */
const detectionCache = new Map<string, CachedScan>();
const DETECTION_CACHE_MAX = 256;

/**
 * One scan's answer plus the child-approval union it was answered with —
 * already restricted to paths this task did not change itself, so a warm read
 * cannot revive the broader clear.
 */
interface CachedScan {
  detected: FileViolation[];
  childApproved: string[];
}

// A newline separator, not a NUL. The first cut of this used a literal NUL byte
// typed into the source, which made git classify this whole module as BINARY:
// every diff surface rendered it as "Binary files differ", ripgrep skipped it,
// and `git blame` was unavailable — on the one new file a reviewer most needed
// to read. test/unit/source-text-only.test.ts now fails if any source file
// carries one. A path cannot contain a newline in any of these parts (git would
// have quoted it), so this separates them unambiguously and stays readable.
function cacheKey(parts: readonly string[]): string {
  return createHash('sha1').update(parts.join('\n')).digest('hex');
}

function cacheGet(key: string): CachedScan | undefined {
  return detectionCache.get(key);
}

function cachePut(key: string, value: CachedScan): void {
  if (detectionCache.size >= DETECTION_CACHE_MAX) {
    const oldest = detectionCache.keys().next();
    if (!oldest.done) detectionCache.delete(oldest.value);
  }
  detectionCache.set(key, value);
}

/** Test seam: drop every memoized scan. Never needed in production. */
export function clearOutstandingViolationsCache(): void {
  detectionCache.clear();
}

/**
 * Resolve the two-dot start SHA for the task's own changes.
 *
 * The plan's base may be a BRANCH (three-dot semantics: what the task added
 * since it diverged) or a concrete SHA (two-dot). `detectViolations` diffs
 * two-dot, so a branch base is resolved to its merge-base with HEAD here —
 * which is also the branch point, and therefore the right answer to "did this
 * file exist before the task started".
 */
async function scanStartSha(
  worktreePath: string,
  base: { ref: string; twoDot: boolean },
): Promise<string | null> {
  if (base.twoDot) return base.ref;
  const mergeBase = await runGit(['merge-base', base.ref, 'HEAD'], { cwd: worktreePath });
  if (mergeBase.exitCode !== 0) return null;
  return mergeBase.stdout.trim() || null;
}

async function headSha(worktreePath: string): Promise<string | null> {
  const head = await runGit(['rev-parse', 'HEAD'], { cwd: worktreePath });
  if (head.exitCode !== 0) return null;
  return head.stdout.trim() || null;
}

/**
 * The patterns to scan for: the project's, plus the exact path of every file a
 * reviewer is still owed a decision on.
 *
 * The second half is how a NARROWED pattern is handled. `protected` says what is
 * guarded from here on; it does not retract a question a reviewer was already
 * asked about a file that WAS protected when the agent changed it. Adding the
 * exact paths (a literal path is a glob matching itself) keeps those files in
 * the scan, which also means they still drop out the moment the agent reverts
 * one — the right behaviour in both directions, and no extra git call.
 */
function effectivePatterns(configured: readonly string[], turns: Turn[]): string[] {
  const merged = new Set(configured);
  for (const file of pendingFilesFromRecords(turns)) merged.add(file);
  return [...merged];
}

/**
 * Who created the child — the actor on its first status-changelog entry.
 *
 * Mirrors `resolveWrapUpPlan` (src/daemon/wrap-up-plan.ts) exactly, so the
 * audience a child's wrap-up ran under and the audience read here can never
 * disagree: `system`-created tasks leave undefined and let `audienceOf` fall
 * through to its safe default.
 *
 * Exported because the review prompt's audience derivation (§8) reads the
 * same two inputs and must answer the same question the same way.
 */
export async function createdByOf(
  storage: Pick<Storage, 'getStatusHistory'>,
  child: Task,
): Promise<Actor | null | undefined> {
  try {
    const actor = (await storage.getStatusHistory(child.id))[0]?.actor;
    return actor === 'human' || actor === 'builder' || actor === 'agent' ? actor : null;
  } catch (err) {
    // The changelog is a fallback input, not a gate.
    logger.debug(
      `Child ${child.id.substring(0, 8)}: status history unavailable: ` +
      `${err instanceof Error ? err.message : err}; audience falls back to the turns.`,
    );
    return undefined;
  }
}

/**
 * What this task's accepted children contribute to its protected-file answer.
 *
 * Per child: derive the audience exactly as the child's own wrap-up did —
 * `audienceOf` over its turns with the creation actor as fallback — then either
 * join its approvals (human-audience: the decisions a human made at that
 * child's accept) or widen the deferred set with its attributed paths
 * (agent-audience: protected files that final never asked about). The paths
 * come from `plan.childAttribution` — in `attribution`, keyed by child id — so
 * this costs git nothing.
 *
 * A child whose records cannot be read is treated as agent-audience with no
 * approvals: the conservative direction both ways. Its paths still widen the
 * scan (a question may be asked that the child's records would have answered)
 * and nothing is cleared that might still be owed.
 */
async function childContributionsFor(
  storage: Storage,
  acceptedChildren: readonly Task[],
  attribution: ReadonlyMap<string, ChildAttribution> | null,
): Promise<ChildContributions> {
  const childApproved = new Set<string>();
  const deferredPaths = new Set<string>();
  for (const child of acceptedChildren) {
    let audience: TaskAudience;
    let approved: string[] = [];
    try {
      const session = await storage.getSessionByTaskId(child.id);
      const childTurns = session ? await storage.getSessionTurns(session.id) : [];
      audience = audienceOf({ turns: childTurns, createdBy: await createdByOf(storage, child) });
      approved = approvedFilesFromRecords(childTurns);
    } catch (err) {
      audience = 'agent';
      logger.debug(
        `Child ${child.id.substring(0, 8)}: turns unavailable: ` +
        `${err instanceof Error ? err.message : err}; treating as agent-audience with no approvals.`,
      );
    }
    if (audience === 'human') {
      for (const file of approved) childApproved.add(file);
    } else if (attribution) {
      for (const file of attribution.get(child.id)?.paths ?? []) deferredPaths.add(file);
    }
  }
  return {
    childApproved: [...childApproved].sort(),
    deferredPaths: [...deferredPaths].sort(),
  };
}

/**
 * The child approvals that may clear something here: the ones for paths no
 * OTHER edit on this branch still owes a decision on.
 *
 * A human decided about ONE child's edit of the file at that child's own
 * accept. Two other edits of the same path are not covered by it, and both are
 * dropped from the union:
 *
 *   - `plan.paths` — this task's own changes (accepted children's squashes
 *     already excluded). The hub edited `CHANGELOG.md` after the child was
 *     accepted; nobody has been asked about that edit.
 *   - `deferredPaths` — what an AGENT-audience accepted child contributed. Its
 *     push-back record is not a human decision, so its edit is exactly what
 *     this task's review owes. A sibling's approval must
 *     not answer for it, for the same reason that child's own approval does not
 *     (`childContributionsFor` never joins an agent-audience child's records).
 *     A hub with one child of each audience touching `CHANGELOG.md` is the
 *     ordinary release case, not an exotic one.
 *
 * Both are one question at the hub's accept, asked about a file the reviewer
 * can see; clearing either merges an edit nobody approved.
 *
 * `paths: undefined` means the plan is not scoped to direct changes, which
 * happens only when there are no accepted children at all — and then there are
 * no child approvals either, so the list is already empty.
 */
function clearableChildApprovals(
  childApproved: readonly string[],
  plan: TaskDirectDiffPlan,
  deferredPaths: readonly string[],
): string[] {
  if (!plan.scopedToDirect || !plan.paths) return [...childApproved];
  const owed = new Set([...plan.paths, ...deferredPaths]);
  return childApproved.filter((file) => !owed.has(file));
}

/**
 * The accepted children, for the degraded records-only path (no plan in hand).
 */
async function acceptedChildrenOf(storage: Storage, task: Task): Promise<Task[]> {
  return classifyHubChildren(await storage.getChildTasks(task.id)).accepted;
}

/**
 * The approval surface: this task's own approvals plus those recorded on its
 * human-audience accepted children, minus files this task itself rejected —
 * its latest record wins per file, so a rejected file is not reported approved
 * even when a child approved it.
 */
function combineApprovals(turns: Turn[], childApproved: readonly string[]): string[] {
  const own = violationRecordsByFile(turns);
  const merged = new Set(approvedFilesFromRecords(turns));
  for (const file of childApproved) {
    if (own.get(file)?.status !== 'rejected') merged.add(file);
  }
  return [...merged].sort();
}

/**
 * A child's approval clears an outstanding file — including this task's own
 * pending record for it, which its final push-back wrote as a QUESTION asked,
 * not a decision made — unless this task's own latest record says `rejected`.
 */
function outstandingWithChildApprovals(
  outstanding: FileViolation[],
  turns: Turn[],
  childApproved: readonly string[],
): FileViolation[] {
  if (childApproved.length === 0) return outstanding;
  const childSet = new Set(childApproved);
  const own = violationRecordsByFile(turns);
  return outstanding.filter(
    (v) => !childSet.has(v.file) || own.get(v.file)?.status === 'rejected',
  );
}

export async function resolveOutstandingViolations(
  projectRoot: string,
  task: Task,
  session: Pick<Session, 'upstream_merge_sha' | 'git_branch'>,
  turns: Turn[],
  storage: Storage,
): Promise<OutstandingViolations> {
  const answer = (
    detected: FileViolation[],
    childApproved: readonly string[],
  ): OutstandingViolations => ({
    outstanding: outstandingWithChildApprovals(
      outstandingFromDetection(detected, turns),
      turns,
      childApproved,
    ),
    approved: combineApprovals(turns, childApproved),
    detected,
    degraded: false,
  });
  const degraded = async (reason: string): Promise<OutstandingViolations> => {
    logger.debug(
      `Task ${task.id.substring(0, 8)}: protected-file scan unavailable (${reason}); ` +
      `falling back to the recorded set.`,
    );
    let childApproved: string[] = [];
    try {
      // The records-only answer still honours child approvals: the hub's own
      // pending records for child files (its final push-back writes those) must
      // not re-ask a decision a human-audience child already made.
      childApproved = (
        await childContributionsFor(storage, await acceptedChildrenOf(storage, task), null)
      ).childApproved;
    } catch (err) {
      logger.debug(
        `Task ${task.id.substring(0, 8)}: child approval lookup unavailable: ` +
        `${err instanceof Error ? err.message : err}; answering from this task's records alone.`,
      );
    }
    return {
      outstanding: outstandingWithChildApprovals(outstandingFromRecords(turns), turns, childApproved),
      approved: combineApprovals(turns, childApproved),
      detected: [],
      degraded: true,
    };
  };

  try {
    const config = await loadConfig(projectRoot);
    const patterns = effectivePatterns(config.permissions.protected, turns);
    // Nothing configured and nothing owed: there is no question to ask, and that
    // is authoritative rather than degraded. No child reads either — with no
    // protected patterns there is no protected-file domain at all.
    if (patterns.length === 0) return answer([], []);

    const worktreePath = getWorktreePath(projectRoot, task);
    if (!(await pathExists(worktreePath))) return await degraded('worktree is gone');

    // THE CACHE CHECK COMES FIRST, above every expensive call. The tip and the
    // pattern list are the whole key, and both are cheap to learn: one
    // `rev-parse`, and a pattern list already in hand. Everything below —
    // `resolveTaskDirectDiff` most of all, which walks every accept tag and the
    // whole first-parent log — is what the memo exists to skip. A version of
    // this that checked the cache after computing the range still paid for the
    // range on every `lazy show` and every review render, which is the cost the
    // Changes-block work had just removed.
    const endSha = await headSha(worktreePath);
    if (!endSha) return await degraded('could not resolve HEAD');
    const key = cacheKey([task.id, endSha, patterns.slice().sort().join(',')]);
    const cached = cacheGet(key);
    if (cached) return answer(cached.detected, cached.childApproved);

    const plan: TaskDirectDiffPlan = await resolveTaskDirectDiff({
      task, session, storage, projectRoot, worktreePath, config,
    });
    // Child contributions, keyed the way the plan already grouped them. Filled
    // once per HEAD (cache-fill time) and cached with the scan — a warm read
    // never opens a child's records.
    const attribution = new Map<string, ChildAttribution>(
      (plan.childAttribution ?? []).map((a) => [a.childId, a]),
    );
    const contributions = await childContributionsFor(storage, plan.acceptedChildren, attribution);
    // Restricted to paths nothing else on this branch still owes a decision on
    // — a child's approval answers for that child's edit, never for this task's
    // own later one, nor for a sibling's deferred one. Computed here, above the
    // cache write, so the cached union is the restricted one and a warm read
    // cannot revive the broader clear.
    const childApproved = clearableChildApprovals(
      contributions.childApproved,
      plan,
      contributions.deferredPaths,
    );

    // Scoped to direct changes and the task owes nothing of its own AND no
    // agent-audience child deferred anything here — a hub whose whole branch is
    // its children's accepted work, none of it deferred to this final. Nothing
    // to ask about. NARROWED (final-turn §14): an agent-audience child's
    // deferred obligations are exactly what the hub's final owes, so they keep
    // the scan alive even when the hub changed nothing itself.
    if (
      plan.scopedToDirect &&
      (plan.paths?.length ?? 0) === 0 &&
      contributions.deferredPaths.length === 0
    ) {
      cachePut(key, { detected: [], childApproved });
      return answer([], childApproved);
    }

    const startSha = await scanStartSha(worktreePath, plan.base);
    if (!startSha) return await degraded('could not resolve the scan range');

    const scanned = await detectViolations(
      worktreePath,
      startSha,
      endSha,
      patterns,
      startSha,
      plan.base.twoDot ? undefined : plan.base.ref,
    );
    // The path restriction is applied AFTER detection rather than handed to
    // git: `detectViolations` owns the diff, and a restricted diff would also
    // change what "pure addition" means for a file the hub and a child both
    // touched. Same trade-off resolveTaskDirectDiff documents for the rendered
    // diff — the hub's own edit keeps the file in, the child's alone does not.
    //
    // The filter is WIDENED by the deferred paths (final-turn §14): an
    // agent-audience child's protected files are invisible to the direct path
    // set — its squash is excluded as reviewed at the child — yet still owed a
    // hub-final decision. Non-protected paths in the union are harmless: the
    // scan only reports protected files.
    const scanPaths = plan.scopedToDirect
      ? [...new Set([...(plan.paths ?? []), ...contributions.deferredPaths])]
      : undefined;
    const detected = plan.scopedToDirect
      ? scanned.filter((v) => scanPaths!.includes(v.file))
      : scanned;
    cachePut(key, { detected, childApproved });
    return answer(detected, childApproved);
  } catch (err) {
    return await degraded(err instanceof Error ? err.message : String(err));
  }
}
