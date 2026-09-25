/**
 * Carving a review range into regions — the whole of slice 0's carving.
 *
 * Git FIRST. Every region this produces exists because of `git log`; lazy's
 * store only ever adds a goal, an actor, a model, or a chunk boundary to a
 * region that already exists. A clone with no `.lazy`, no network and no
 * surviving branches still gets a usable region list, because the floor —
 * "the commit itself is the region" — is never empty.
 *
 * Design: docs/spikes/review-partitioning-general.md §1.5.
 */

import {
  branchCandidates,
  humanIdentities,
  listAcceptTagCommits,
  listBranchRefs,
  listRemotes,
  rangePaths,
  refResolves,
  resolveSha,
  unitFromSubject,
  walkFirstParent,
  type SubjectUnit,
  type WalkedCommit,
} from './git';
import {
  commitsInRange,
  computeReviewAttribution,
  listReviewPaths,
  mapCommitsToChain,
  type FileAttribution,
  type ReviewAttribution,
} from './attribution';
import { AREA_GROUPING_MIN_REGIONS, computeAreas } from './areas';
import { runGit } from '../utils/git';
import {
  REGION_COVER_VERSION,
  type RegionCover,
  type RegionProvenance,
  type ReviewRegion,
  type SupersededUnit,
} from './types';

/** One task's facts, as lazy's store knows them. Layer (d) — enrichment only. */
export interface RegionChunkFacts {
  index: number;
  title: string;
  /** Work-only SHA range of the chunk's turns. Both must resolve to be used. */
  from: string;
  to: string;
}

export interface RegionTaskFacts {
  code: string;
  /** The task's full id, so its accept tag can be found. */
  taskId?: string;
  /** Terminal tasks are the only ones whose work can already be on the base. */
  status?: string;
  goal: string;
  /** The branch the task's session ran on, when the store knows it. */
  branch?: string;
  actors: string[];
  agents: string[];
  models: string[];
  chunks: RegionChunkFacts[];
}

/**
 * The store, behind one call. A port rather than a `Storage` parameter so the
 * carving can be unit-tested against a fixture repo with no store at all —
 * which is also the case it has to work in for real.
 */
export interface RegionEnrichment {
  lookupTask(code: string): Promise<RegionTaskFacts | null>;
}

export interface RegionLimits {
  /**
   * Expansion trigger 4, the honest backstop for a unit that trips none of the
   * structural tests and is still enormous. Deliberately NOT a config key: a
   * knob here would be the tuning parameter §1.5.1 says slice 0 does not have.
   */
  sizeBackstopFiles: number;
  /** Recursion depth. A hub → child → its sync-merge → grandchild is depth 3. */
  maxDepth: number;
  /** Hard cap, so a pathological history cannot make the daemon walk forever. */
  maxRegions: number;
}

export const DEFAULT_REGION_LIMITS: RegionLimits = {
  sizeBackstopFiles: 200,
  maxDepth: 6,
  maxRegions: 4000,
};

export interface RegionComputeInput {
  /** Repository or worktree to read. Read-only: no ref ever moves. */
  cwd: string;
  taskId: string;
  /** The base the review range starts at — the same one `lazy diff` resolved. */
  baseRef: string;
  /** Right-hand side of the range. Default HEAD. */
  headRef?: string;
  /**
   * The commit this branch was CUT FROM, when the store knows it
   * (`Session.git_start_sha` / `Task.branched_from_sha`).
   *
   * Without it the walk is bounded only by reachability from the base, and on
   * a STACKED release that is much wider than the review. `main` holds only
   * the squash of each earlier release, so every original commit of v0.15–v0.21
   * is unreachable from `main` and lands in the walk — 145 of the 438
   * first-parent commits of `main..lazy/release-v022`, work whose content is
   * already on main and which contributes nothing to the three-dot diff the
   * review renders. Bounding at the cut point removes exactly those.
   *
   * Validated before use (must resolve, must be an ancestor of head) and
   * ALWAYS combined with the base exclusion, never substituted for it — a
   * stale or wrong value can then only make the range wider, never drop work.
   */
  branchStartSha?: string | null;
  enrichment?: RegionEnrichment | null;
  limits?: Partial<RegionLimits>;
}

interface Ctx {
  cwd: string;
  baseRef: string;
  limits: RegionLimits;
  enrichment: RegionEnrichment | null;
  remotes: string[];
  branchRefs: Set<string>;
  /** commit sha → task id, from the accept tags. Layer 0 of unit identification. */
  acceptTags: Map<string, string>;
  /** task id → its accept commit, the inverse of `acceptTags`. */
  acceptTagByTaskId: Map<string, string>;
  notes: string[];
  /**
   * Commits already carved into a region at a shallower depth.
   *
   * This is what stops an ordinary sync merge from re-carving the whole
   * release underneath one task: a task branch that merged the hub in has the
   * hub's own accepts inside that merge, and those are already top-level
   * regions. Claimed breadth-first — a whole level is claimed before any of
   * it is expanded — so ordering cannot decide who wins.
   */
  claimed: Set<string>;
  /** Unit ids handed out, so a repeated task code cannot collide. */
  usedIds: Set<string>;
  regionCount: number;
  capped: boolean;
  /**
   * Blame tallies for every file of the review, computed ONCE.
   *
   * Shared by every level of the tree: a level only differs in which sibling a
   * given commit sha maps to, never in who wrote a line. Null when the range
   * could not be read, in which case ownership degrades to "newest claimant".
   */
  attribution: ReviewAttribution | null;
  /** Units that owned nothing after partitioning, collected as they collapse. */
  superseded: SupersededUnit[];
  /** region id → how many paths it CLAIMED, kept after the claim is overwritten. */
  claimCounts: Map<string, number>;
}

/**
 * What one expansion is partitioning, and over which commits.
 *
 * `to`/`excludes` are the commit range the level's chain was walked from — the
 * bridge from a blamed commit (which may be off the first-parent line) to the
 * sibling that brought it onto the branch.
 */
interface CarveScope {
  to: string;
  excludes: string[];
  /** Paths this level must partition; null when nothing constrains it. */
  restrictTo: ReadonlySet<string> | null;
}

export async function computeRegionCover(input: RegionComputeInput): Promise<RegionCover> {
  const limits = { ...DEFAULT_REGION_LIMITS, ...(input.limits ?? {}) };
  const headRef = input.headRef ?? 'HEAD';
  const acceptTags = await listAcceptTagCommits(input.cwd);
  const ctx: Ctx = {
    cwd: input.cwd,
    baseRef: input.baseRef,
    limits,
    enrichment: input.enrichment ?? null,
    remotes: await listRemotes(input.cwd),
    branchRefs: await listBranchRefs(input.cwd),
    acceptTags,
    acceptTagByTaskId: new Map([...acceptTags].map(([sha, id]) => [id, sha])),
    notes: [],
    claimed: new Set(),
    usedIds: new Set(),
    regionCount: 0,
    capped: false,
    attribution: null,
    superseded: [],
    claimCounts: new Map(),
  };

  const baseSha = await resolveSha(ctx.cwd, input.baseRef);
  const headSha = await resolveSha(ctx.cwd, headRef);
  if (!baseSha || !headSha) {
    ctx.notes.push(
      `Could not resolve the review range ${input.baseRef}..${headRef} in this worktree — no regions.`,
    );
    return {
      task_id: input.taskId,
      base_ref: input.baseRef,
      base_sha: baseSha ?? '',
      head_sha: headSha ?? '',
      computed_at: Date.now(),
      regions: [],
      notes: ctx.notes,
      // Flagged rather than left to be recognised by its note text: the
      // caller has to tell "carved, and there is nothing" from "could not
      // carve", and a string match on a human-readable sentence is not a
      // contract.
      unresolved: true,
    };
  }

  // The walk starts at the branch's own cut point when the store knows it,
  // and is ALWAYS additionally bounded by `^base`. Both bounds, never one
  // instead of the other: a stale branch start can then only widen the range
  // back towards today's behaviour, never silently drop a region.
  const walkFrom = await resolveWalkStart(ctx, input.branchStartSha ?? null, baseSha, headSha);
  const commits = await walkFirstParent(ctx.cwd, walkFrom, headSha, baseSha);

  // ONE blame pass for the whole review, before any carving. Every level of the
  // tree settles ownership from it, so the cost is proportional to the review's
  // FILE count and not to its region count — which is what keeps the partition
  // inside the budget the incremental refresh was built to protect.
  ctx.attribution = await computeReviewAttribution(ctx.cwd, baseSha, headSha);
  const reviewPaths = new Set(ctx.attribution.paths);

  const regions = await carve(ctx, commits, null, 0, {
    to: headSha,
    excludes: [walkFrom, baseSha],
    restrictTo: reviewPaths,
  });
  // A unit whose every line was later rewritten owns nothing. It is not a
  // region — a reviewer's list should only hold work that is still there — but
  // it is not nothing either, so it is recorded rather than dropped.
  // (Deliberately KEPT after the presentation re-source — see the function.)
  const kept = collapseSuperseded(regions, ctx.superseded, ctx.claimCounts);
  if (ctx.superseded.length > 0) {
    ctx.notes.push(
      `${ctx.superseded.length} unit(s) contributed no surviving lines and are not listed as ` +
      `regions: ${ctx.superseded.slice(0, 8).map((u) => u.task_code ?? u.id).join(', ')}` +
      `${ctx.superseded.length > 8 ? ', …' : ''}.`,
    );
  }

  // The area axis is CARVED only when the provenance list has stopped being
  // readable on its own, rather than always carved and conditionally shown.
  // One rule, at the source: a cover that never offered areas must not resolve
  // `--region src/foo` either, or a reviewer can scope to a grouping no
  // surface ever listed and no surface can take them back out of it.
  const topLevel = kept.filter((r) => r.depth === 0 && r.parent_id === null);
  const areas = topLevel.length >= AREA_GROUPING_MIN_REGIONS ? computeAreas(topLevel) : [];

  if (ctx.capped) {
    ctx.notes.push(
      `Stopped at the ${limits.maxRegions}-region cap; deeper units were left unexpanded.`,
    );
  }
  if (!ctx.enrichment) {
    ctx.notes.push(
      'No store enrichment: regions carry commit subjects and git authors only ' +
      '(no goals, actors, models or review chunks).',
    );
  }

  return {
    version: REGION_COVER_VERSION,
    task_id: input.taskId,
    base_ref: input.baseRef,
    base_sha: baseSha,
    head_sha: headSha,
    computed_at: Date.now(),
    regions: kept,
    areas,
    superseded: ctx.superseded,
    notes: ctx.notes,
  };
}

/**
 * Drop every region that owns no file, and everything nested inside it.
 *
 * A region with no files has no diff to show and nothing to sign off; leaving
 * it in the list is the atomization the partition exists to undo. Its subtree
 * goes with it, because a child partitions its parent's files and a parent with
 * none has nothing to give.
 *
 * Deliberately KEPT when regions re-sourced onto the agent's presentation
 * (final-turn §6), deviating from that slice's removes-list: human surfaces no
 * longer RENDER superseded rows, but this collapse is what keeps them out of
 * `regions` at the source — the carve's `regions` is still a partition's file
 * list, and a zero-file unit would show an empty diff and break "the regions'
 * file counts add up to the change". The dropped units land in
 * `cover.superseded`, which is what keeps a superseded name RESOLVABLE
 * (findRegion's superseded branch) on the provenance side and powers the
 * listing's superseded note. The carve's remaining consumers are the
 * `provenance` source, the wrap-up provenance hint, and the blame
 * attribution — every one reads the collapsed shape.
 */
export function collapseSuperseded(
  regions: readonly ReviewRegion[],
  into: SupersededUnit[],
  claimCounts: ReadonlyMap<string, number>,
): ReviewRegion[] {
  const dropped = new Set<string>();
  const kept: ReviewRegion[] = [];
  for (const region of regions) {
    const orphaned = region.parent_id !== null && dropped.has(region.parent_id);
    if (region.files.length === 0 || orphaned) {
      dropped.add(region.id);
      // Only the units a reviewer could have expected to see are worth naming:
      // a child of an already-collapsed region was never on the list.
      if (!orphaned) {
        into.push({
          id: region.id,
          title: region.name ?? region.title,
          ...(region.task_code ? { task_code: region.task_code } : {}),
          touched: claimCounts.get(region.id) ?? 0,
        });
      }
      continue;
    }
    kept.push(region);
  }
  return kept;
}


/**
 * The blamed-commit → top-level-region bridge, rebuilt from a stored cover.
 *
 * The chain comes from git rather than from the cover, because the cover only
 * holds the first-parent commits that BECAME regions: an upstream sync merge is
 * deliberately not one, and a chain missing it would hand that merge's commits
 * to whichever neighbour claimed them first. A chain commit with no region maps
 * to nothing, which is the right answer for work the carve excluded.
 *
 * Exported because the per-line gutter needs exactly the same bridge: blame
 * names the commit that wrote a line, and the gutter has to label it with the
 * UNIT. Rebuilding it from the stored cover is two git calls for a whole page,
 * against one per file if each file re-derived it.
 */
export async function coverShaToRegionMap(
  cwd: string,
  topLevel: readonly ReviewRegion[],
  baseSha: string,
  headSha: string,
): Promise<Map<string, string>> {
  const result = await runGit(
    ['rev-list', '--first-parent', headSha, `^${baseSha}`],
    { cwd },
  );
  if (result.exitCode !== 0) return new Map();
  const chain = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const regionByChainSha = new Map(topLevel.map((r) => [r.to, r.id]));
  const out = new Map<string, string>();
  for (const [sha, chainSha] of await mapCommitsToChain(cwd, chain, headSha, [baseSha])) {
    const id = regionByChainSha.get(chainSha);
    if (id) out.set(sha, id);
  }
  return out;
}

/**
 * Where the first-parent walk starts: the branch's own cut point when it is
 * usable, else the base.
 *
 * REACHABILITY IS NOT CONTENT, and on a stacked release the two disagree
 * badly. `lazy diff` renders a three-dot diff, whose left-hand side is the
 * merge base — so work that landed on `main` as an earlier release's SQUASH is
 * not in the diff. But the original commits of that release are not reachable
 * from `main` either, so a plain `base..head` walk carves every one of them
 * into a region. On `main..lazy/release-v022` that is 145 of 438 first-parent
 * commits (72 of them accepts), all of them v0.15–v0.21 work already on main.
 * This is the release-commit-resurrection shape (docs/resurrection-guard.md)
 * appearing in provenance rather than in content.
 *
 * Three guards, because a wrong start would DROP regions rather than add them:
 *  - it must resolve in this worktree;
 *  - it must be an ancestor of head (otherwise it is not on this history at
 *    all — a stale value from before a rewrite, say);
 *  - and the caller still excludes `^base`, so the worst case is the old,
 *    wider behaviour.
 */
async function resolveWalkStart(
  ctx: Ctx,
  branchStartSha: string | null,
  baseSha: string,
  headSha: string,
): Promise<string> {
  if (!branchStartSha) return baseSha;
  const resolved = await resolveSha(ctx.cwd, branchStartSha);
  if (!resolved) return baseSha;
  if (!(await isAncestor(ctx.cwd, resolved, headSha))) {
    ctx.notes.push(
      `The recorded branch start ${branchStartSha.slice(0, 8)} is not an ancestor of this branch; ` +
      'carved from the base instead.',
    );
    return baseSha;
  }
  // Say what was left out. These commits ARE on this branch, they are simply
  // not this task's work — they came in with the branch it was cut from — so
  // a reviewer who expected to see them deserves to know where they went.
  const inherited = await countCommits(ctx.cwd, resolved, baseSha);
  if (inherited > 0) {
    ctx.notes.push(
      `Carved from this branch's own start (${resolved.slice(0, 8)}). ` +
      `${inherited} earlier first-parent commit(s) on the branch were inherited from the ` +
      'branch it was cut from and are not carved here.',
    );
  }
  return resolved;
}

/**
 * Is this merge commit an upstream SYNC rather than a unit of work?
 *
 * Two cases, git first:
 *
 * (b) **The merged branch is already in the base.** `merge-base --is-ancestor
 *     <second parent> <base>` — pure git, no store. This is every
 *     `Merge origin/main` on a long-lived branch.
 *
 * (c) **The merged branch was a stacked parent that has since been
 *     squash-accepted onto the base.** Its commits are NOT ancestors of the
 *     base (the accept squashed them), so (b) cannot see it — but lazy's own
 *     accept tag can: if the merged branch's tip carries a task whose accept
 *     commit is in the base, the work arrived on the base by that route and
 *     this merge is a sync too. Store-free repos keep the coarser answer,
 *     which the cover's notes say out loud rather than pretending.
 */
async function isSyncMerge(ctx: Ctx, commit: WalkedCommit): Promise<boolean> {
  const secondParent = commit.parents[1];
  if (!secondParent) return false;

  if (await isAncestor(ctx.cwd, secondParent, ctx.baseRef)) return true;

  // (c) The merged branch names a lazy task. If that task is COMPLETE and its
  // own accept commit is in the base, its work reached the base by that route
  // and this merge carried nothing new — even though its commits are not
  // ancestors of the base, because the accept squashed them.
  //
  // This is the `Merge origin/lazy/release-v021` shape on a stacked release:
  // four such merges on v0.22, the largest of them a 250-file region of pure
  // noise. Their commits are unreachable from main, so (b) cannot see them,
  // but the v021 accept tag is right there on main.
  const code = mergedTaskCode(commit.subject);
  if (!code || !ctx.enrichment) return false;
  const facts = await ctx.enrichment.lookupTask(code).catch(() => null);
  if (!facts?.taskId || facts.status !== 'complete') return false;
  const acceptSha = ctx.acceptTagByTaskId.get(facts.taskId);
  if (!acceptSha) return false;
  return isAncestor(ctx.cwd, acceptSha, ctx.baseRef);
}

const MERGE_REF_RE = /^Merge\s+(?:remote-tracking\s+branch\s+)?['"]?(\S+?)['"]?$/;

/**
 * The lazy task code behind a sync merge's subject, or null.
 *
 * `Merge origin/lazy/release-v021` → `release-v021`. Deliberately narrow: it
 * only recognises the `lazy/<code>` shape that lazy's own sync writes, because
 * a wrong answer here would drop a real region. Anything else falls through to
 * "not a sync" and is carved as usual.
 */
export function mergedTaskCode(subject: string): string | null {
  const match = MERGE_REF_RE.exec(subject.trim());
  if (!match) return null;
  const lazyBranch = /(?:^|\/)lazy\/([^/]+)$/.exec(match[1]!);
  return lazyBranch ? lazyBranch[1]! : null;
}

/** Is `maybeAncestor` an ancestor of (or equal to) `descendant`? */
async function isAncestor(cwd: string, maybeAncestor: string, descendant: string): Promise<boolean> {
  const result = await runGit(
    ['merge-base', '--is-ancestor', maybeAncestor, descendant],
    { cwd },
  );
  return result.exitCode === 0;
}

/** How many first-parent commits are in `from..to`, excluding nothing. */
async function countCommits(cwd: string, to: string, exclude: string): Promise<number> {
  const result = await runGit(
    ['rev-list', '--count', '--first-parent', to, `^${exclude}`],
    { cwd },
  );
  if (result.exitCode !== 0) return 0;
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}

/**
 * Turn one level's commits into regions, then expand the ones §1.5.3 says to.
 *
 * Two passes on purpose. The first claims every commit at this level and
 * settles ownership between siblings; only then does the second pass expand,
 * so a deeper walk can never re-carve a commit its own level already owns.
 */
async function carve(
  ctx: Ctx,
  commits: WalkedCommit[],
  parentId: string | null,
  depth: number,
  scope: CarveScope,
): Promise<ReviewRegion[]> {
  const unclaimed = commits.filter((c) => !ctx.claimed.has(c.sha));
  if (unclaimed.length === 0) return [];
  for (const c of unclaimed) ctx.claimed.add(c.sha);

  // A commit whose first-parent diff touches nothing is not a reviewable
  // region — there is no diff to scope to. It still counts as claimed so a
  // deeper walk cannot resurrect it as a phantom region of its own.
  const withFiles = unclaimed.filter((c) => c.paths.length > 0);
  if (withFiles.length === 0) return [];

  // Nor is a SYNC merge. Its first-parent diff is everything the upstream
  // branch brought in — 208, 172 and 233 files for the largest `Merge
  // origin/main` commits on this repo's own release branch — none of which is
  // this branch's work. Dropping them is the difference between a region list
  // and a list with three enormous meaningless entries at the top.
  const fresh: WalkedCommit[] = [];
  let syncs = 0;
  let unresolvedStackedSyncs = 0;
  for (const commit of withFiles) {
    if (commit.parents.length > 1) {
      if (await isSyncMerge(ctx, commit)) {
        syncs += 1;
        continue;
      }
      // It merged a lazy task branch but we could not establish that the task
      // landed on the base. Might be a sync, might be real work — carved as a
      // region either way, and said out loud rather than guessed.
      if (!ctx.enrichment && mergedTaskCode(commit.subject)) unresolvedStackedSyncs += 1;
    }
    fresh.push(commit);
  }
  if (depth === 0) {
    if (syncs > 0) {
      ctx.notes.push(
        `${syncs} upstream sync merge(s) were not carved as regions — they bring in work ` +
        'that is already on the base, not work this branch did.',
      );
    }
    if (unresolvedStackedSyncs > 0) {
      ctx.notes.push(
        `${unresolvedStackedSyncs} merge(s) of another lazy branch are carved as regions ` +
        'because without the task store there is no way to tell a sync from real work here.',
      );
    }
  }
  if (fresh.length === 0) return [];

  const units: Array<{ commit: WalkedCommit; region: ReviewRegion; subject: SubjectUnit | null }> = [];
  for (const commit of fresh) {
    if (ctx.regionCount >= ctx.limits.maxRegions) {
      ctx.capped = true;
      break;
    }
    const subject = identifyUnit(ctx, commit);
    const region = baseRegion(ctx, commit, subject, parentId, depth);
    ctx.regionCount += 1;
    units.push({ commit, region, subject });
  }

  for (const u of units) ctx.claimCounts.set(u.region.id, u.region.files.length);
  const { unattributed } = partitionOwnership({
    siblings: units.map((u) => u.region),
    shaToRegion: await shaToRegionMap(ctx, commits, units, scope),
    attribution: ctx.attribution,
    scopePaths: scope.restrictTo,
  });
  noteUnattributed(ctx, unattributed, parentId);

  const out: ReviewRegion[] = [];
  for (const u of units) {
    await enrich(ctx, u.region, u.subject);
    out.push(u.region);
    if (depth >= ctx.limits.maxDepth || ctx.regionCount >= ctx.limits.maxRegions) {
      if (ctx.regionCount >= ctx.limits.maxRegions) ctx.capped = true;
      continue;
    }
    // A region with no files has nothing for a child to partition — expanding
    // it would produce a subtree that collapses wholesale a moment later.
    if (u.region.files.length === 0) continue;
    const children = await maybeExpand(ctx, u.commit, u.region, u.subject, depth);
    out.push(...children);
  }
  return out;
}

/**
 * Say out loud that a level could not place some of its files — at EVERY
 * depth, naming the region it happened inside.
 *
 * The partition is a promise about counts, so a file it could not place has to
 * be said out loud: silently coming up short makes every "these add up"
 * reading of the list wrong with no way to notice. That argument does not stop
 * at the top level. It used to: the note was gated on `depth === 0` and every
 * deeper level discarded the answer, so a reviewer who opened a region found
 * its children summing to fewer files than the region itself with nothing
 * accounting for the difference.
 *
 * The natural case is a merge region expanded through its second parent —
 * content introduced by the merge RESOLUTION blames to the merge commit, which
 * is not in any child's range, so no child can claim it.
 */
function noteUnattributed(ctx: Ctx, unattributed: string[], parentId: string | null): void {
  if (unattributed.length === 0) return;
  ctx.notes.push(
    `${unattributed.length} file(s) ${parentId ? `inside \`${parentId}\`` : 'in the review'} ` +
    'could not be attributed to any unit (no surviving lines and no commit in the carved ' +
    `range touched them): ${unattributed.slice(0, 5).join(', ')}` +
    `${unattributed.length > 5 ? ', …' : ''}.`,
  );
}

/**
 * The bridge from a BLAMED commit to the sibling region that owns it.
 *
 * Blame names the commit that really wrote a line, which on a merged task
 * branch is off the first-parent line entirely; a region is identified by the
 * first-parent commit (the accept squash, or the merge). One graph traversal
 * maps the whole level, rather than one `rev-list` per region.
 */
async function shaToRegionMap(
  ctx: Ctx,
  commits: readonly WalkedCommit[],
  units: ReadonlyArray<{ commit: WalkedCommit; region: ReviewRegion }>,
  scope: CarveScope,
): Promise<Map<string, string>> {
  const regionByChainSha = new Map(units.map((u) => [u.commit.sha, u.region.id]));
  const chain = await mapCommitsToChain(
    ctx.cwd,
    commits.map((c) => c.sha),
    scope.to,
    scope.excludes,
  );
  const out = new Map<string, string>();
  for (const [sha, chainSha] of chain) {
    const id = regionByChainSha.get(chainSha);
    if (id) out.set(sha, id);
  }
  return out;
}

/**
 * Which unit is behind this commit, cheapest-and-strongest first.
 *
 * LAYER 0 — the accept TAG. `refs/tags/lazy-accept-<taskId>` is written by
 * accept itself and is already the single source of truth the zombie sweep
 * trusts, so a tag hit is an identification rather than an inference. Measured
 * on this repo's v0.22 release: tags identify 343 of 438 first-parent commits,
 * including one whose subject the convention scan does not match at all, and
 * miss none that it does.
 *
 * LAYER (c) — the subject convention, as the FALLBACK. It is what makes this
 * work on a repo with no lazy tags (any other project, a shallow clone, or
 * this one after the tags are retired), and it is the only layer that survives
 * branch deletion on its own. It is not the primary signal precisely because
 * matching prose is fragile.
 */
function identifyUnit(ctx: Pick<Ctx, 'acceptTags'>, commit: WalkedCommit): SubjectUnit | null {
  const subject = unitFromSubject(commit.subject);
  const taggedTaskId = ctx.acceptTags.get(commit.sha);
  if (!taggedTaskId) return subject;
  // A tag says "lazy task", authoritatively. The subject, when it parses, is
  // still the best source of the human-readable code and title.
  if (subject?.kind === 'lazy-task') return { ...subject, taskId: taggedTaskId };
  return {
    kind: 'lazy-task',
    code: taggedTaskId.slice(0, 8),
    taskId: taggedTaskId,
    title: subject?.title || commit.subject || taggedTaskId.slice(0, 8),
  };
}

/** A region for one commit, before enrichment and before ownership is settled. */
function baseRegion(
  ctx: Pick<Ctx, 'usedIds'>,
  commit: WalkedCommit,
  subject: SubjectUnit | null,
  parentId: string | null,
  depth: number,
): ReviewRegion {
  const from = commit.parents[0] ?? `${commit.sha}^`;
  const files = [...new Set(commit.paths)].sort();
  return {
    id: mintRaw(ctx, unitIdFor(commit, subject)),
    unit: subject ? 'task' : 'commit',
    parent_id: parentId,
    depth,
    title: subject?.title || commit.subject || commit.sha.slice(0, 8),
    from,
    to: commit.sha,
    provenance: subject?.taskId ? 'accept-tag' : 'commit',
    // Still the CLAIM at this point — everything the range touches.
    // `partitionOwnership` narrows it to what the region actually owns.
    files,
    shared_files: [],
    commit_count: 1,
    authors: commit.identities.map((i) => i.name || i.email),
    expansion_reasons: [],
    ...(subject?.kind === 'lazy-task' && subject.code ? { task_code: subject.code } : {}),
  };
}

function unitIdFor(commit: WalkedCommit, subject: SubjectUnit | null): string {
  if (subject?.kind === 'lazy-task' && subject.code) return `task:${subject.code}`;
  if (subject?.kind === 'pr-merge' && subject.branch) return `branch:${subject.branch}`;
  if (subject?.kind === 'pr-squash' && subject.pr) return `pr:${subject.pr}`;
  return `commit:${commit.sha.slice(0, 12)}`;
}

function mintRaw(ctx: Pick<Ctx, 'usedIds'>, preferred: string): string {
  if (!ctx.usedIds.has(preferred)) {
    ctx.usedIds.add(preferred);
    return preferred;
  }
  for (let n = 2; ; n++) {
    const candidate = `${preferred}~${n}`;
    if (!ctx.usedIds.has(candidate)) {
      ctx.usedIds.add(candidate);
      return candidate;
    }
  }
}

export interface PartitionInput {
  /**
   * The sibling regions, in WALK ORDER — newest first. The order is the
   * documented tiebreak, so it is part of the contract, not an accident.
   *
   * Each one's `files` is still its CLAIM (everything its range touches) on the
   * way in, and is its OWNED set on the way out.
   */
  siblings: ReviewRegion[];
  /** commit sha → the sibling id whose unit brought that commit onto the branch. */
  shaToRegion: ReadonlyMap<string, string>;
  /** Blame tallies for the whole review. Null degrades to "newest claimant wins". */
  attribution: ReviewAttribution | null;
  /**
   * The paths this expansion is partitioning — the review's own file list at
   * the top level, the parent region's owned files below it.
   *
   * Two jobs. It DROPS a claim on a path that is not in the review at all (a
   * file a unit changed and a later unit changed back), which is what lets the
   * top-level counts sum to the diff's own file count. And it ADOPTS a path no
   * sibling's first-parent diff claimed but blame can attribute — without it
   * a file that arrived through a merge nobody carved would belong to no region
   * and the partition would silently be short.
   */
  scopePaths: ReadonlySet<string> | null;
}

/**
 * Decide, for every file, the ONE region that owns it (§1.5.5, replaced).
 *
 * Ownership is settled WITHIN one expansion, never across the whole cover: a
 * hub and its own child both touching a file is not two regions disagreeing,
 * it is the same work seen at two resolutions.
 *
 * The rule inside an expansion is blame-weighted: `git blame` the branch's
 * final version of the file, keep the lines authored inside the review range,
 * attribute each to the sibling whose unit brought that commit onto the branch,
 * and the sibling with the most surviving lines owns the file. That is the
 * honest reading of "whose work is this file" on a release branch, where a late
 * fix task rewrites what a feature task introduced: whoever is still standing
 * in the code the reviewer will read.
 *
 * TIEBREAK: the NEWEST claimant along the first-parent line. Ties are real —
 * two units adding one line each to a CHANGELOG is the common case — and the
 * newest unit is the one whose edit the older one had to accommodate, so it is
 * the better place to start reading. Deterministic because the walk order is.
 *
 * Returns the scope paths nothing could be attributed to; a top-level caller
 * says so in a note rather than quietly coming up short.
 */
export function partitionOwnership(input: PartitionInput): { unattributed: string[] } {
  const { siblings, shaToRegion, attribution, scopePaths } = input;
  const order = new Map(siblings.map((r, i) => [r.id, i]));

  // path → claimant ids in walk order. A claim is "my range touched this".
  const claims = new Map<string, string[]>();
  for (const region of siblings) {
    for (const path of region.files) {
      if (scopePaths && !scopePaths.has(path)) continue;
      const list = claims.get(path);
      if (list) list.push(region.id);
      else claims.set(path, [region.id]);
    }
  }
  if (scopePaths) {
    for (const path of scopePaths) if (!claims.has(path)) claims.set(path, []);
  }

  const owned = new Map<string, string[]>(siblings.map((r) => [r.id, []]));
  const shared = new Map<string, ReviewRegion['shared_files']>(siblings.map((r) => [r.id, []]));
  const unattributed: string[] = [];

  for (const [path, claimants] of claims) {
    const file = attribution?.byPath.get(path);
    const tally = new Map<string, number>();
    for (const [sha, lines] of file?.lines ?? []) {
      const id = shaToRegion.get(sha);
      if (!id || !order.has(id)) continue;
      tally.set(id, (tally.get(id) ?? 0) + lines);
    }

    const winner = pickOwner(path, claimants, tally, order, file, shaToRegion);
    if (!winner) {
      unattributed.push(path);
      continue;
    }
    owned.get(winner)!.push(path);

    const others = [...new Set([...claimants, ...tally.keys()])]
      .filter((id) => id !== winner)
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    if (others.length > 0) {
      const total = [...tally.values()].reduce((a, b) => a + b, 0);
      shared.get(winner)!.push({
        path,
        also: others,
        lines: tally.get(winner) ?? 0,
        total_lines: total,
      });
    }
  }

  for (const region of siblings) {
    region.files = owned.get(region.id)!.sort();
    region.shared_files = shared.get(region.id)!.sort((a, b) => a.path.localeCompare(b.path));
  }
  return { unattributed };
}

/**
 * The one region a file belongs to, strongest signal first.
 *
 * 1. Most surviving blamed lines.
 * 2. Nothing survives (a deleted file, a binary, a change a later unit undid):
 *    the LAST unit to touch it in the range — "deleted-only files go to the
 *    unit that deleted them", generalised to the same rule for every file
 *    blame cannot weigh.
 * 3. No attribution at all (no blame data, e.g. a fixture or a store-free
 *    degrade): the newest claimant, which is the pre-blame behaviour.
 */
function pickOwner(
  path: string,
  claimants: readonly string[],
  tally: ReadonlyMap<string, number>,
  order: ReadonlyMap<string, number>,
  file: FileAttribution | undefined,
  shaToRegion: ReadonlyMap<string, string>,
): string | null {
  let best: string | null = null;
  let bestLines = 0;
  for (const [id, lines] of tally) {
    if (lines > bestLines || (lines === bestLines && best !== null
      && (order.get(id) ?? 0) < (order.get(best) ?? 0))) {
      best = id;
      bestLines = lines;
    }
  }
  if (best) return best;

  const lastTouch = file?.lastTouch ? shaToRegion.get(file.lastTouch) : undefined;
  if (lastTouch && order.has(lastTouch)) return lastTouch;

  const byOrder = [...claimants].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return byOrder[0] ?? null;
}

/** Layer (d): the store's goal, acting identity and chunks, when it has them. */
async function enrich(ctx: Ctx, region: ReviewRegion, subject: SubjectUnit | null): Promise<void> {
  if (!ctx.enrichment || subject?.kind !== 'lazy-task' || !subject.code) return;
  let facts: RegionTaskFacts | null = null;
  try {
    facts = await ctx.enrichment.lookupTask(subject.code);
  } catch (err) {
    // Enrichment is never a prerequisite. A store that cannot answer costs a
    // goal and a model name, not the region — but say so rather than pretend.
    ctx.notes.push(
      `Store lookup failed for ${subject.code}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (!facts) return;
  if (facts.goal) region.title = facts.goal;
  if (facts.actors.length) region.actors = facts.actors;
  if (facts.agents.length) region.agents = facts.agents;
  if (facts.models.length) region.models = facts.models;
}

/**
 * Recover the unit's own commits and, when §1.5.3 says to, carve them.
 *
 * Recovery order is §1.5.2's: a merge exposes its branch through the second
 * parent with no recovery at all; a squash needs a surviving ref; and when
 * neither is there the commit stays the region.
 */
async function maybeExpand(
  ctx: Ctx,
  commit: WalkedCommit,
  region: ReviewRegion,
  subject: SubjectUnit | null,
  depth: number,
): Promise<ReviewRegion[]> {
  const hasChunks = await countChunks(ctx, subject) >= 2;
  const recovered = await recoverSubRange(ctx, commit, subject);

  if (!recovered) {
    // Git recovered nothing — a deleted branch. Chunks are the only expansion
    // left, and only if a test fires.
    const plan = planExpansion(ctx, region, [], { nested: false, hasChunks });
    if (!plan || plan.into !== 'chunks') return [];
    return chunkRegions(ctx, region, subject, depth, plan.reasons);
  }

  // Trigger 1 asks whether ANOTHER unit's work flowed in, which is not the
  // same question as "is there a merge here". A task branch that merged the
  // hub in to stay current has a merge and hides nothing; a branch that
  // absorbed another task's accepts hides real work, and on this repo that
  // work sits BEHIND the merge rather than on the first-parent line. So the
  // scan runs over the whole recovered range, and only when a merge put
  // something off the first-parent line in the first place.
  const nested = recovered.commits.some((c) => identifyUnit(ctx, c) !== null)
    || (recovered.commits.some((c) => c.parents.length > 1)
      && await rangeHidesUnits(ctx, recovered.from, recovered.to));

  const plan = planExpansion(ctx, region, recovered.commits, { nested, hasChunks });
  if (!plan) return [];

  region.provenance = recovered.provenance;
  region.commit_count = recovered.commits.length;

  if (plan.into === 'chunks') {
    const chunks = await chunkRegions(ctx, region, subject, depth, plan.reasons);
    if (chunks.length > 0) return chunks;
    // The store promised chunks and the worktree could not resolve their SHAs.
    // Fall through to the git answer rather than silently expanding nothing.
  }

  region.expansion_reasons = plan.reasons;
  // The children partition their PARENT's owned files, which is what makes the
  // tree coherent: opening a region shows the same files split finer, never a
  // different set.
  const children = await carve(ctx, recovered.commits, region.id, depth + 1, {
    to: recovered.to,
    excludes: [recovered.from, ctx.baseRef],
    restrictTo: new Set(region.files),
  });
  if (children.length > 0) return children;

  // Every recovered commit was already claimed elsewhere — an upstream sync
  // merge, typically. Nothing was hidden here, so this is a leaf after all.
  region.expansion_reasons = [];
  return [];
}

/** How many review chunks the store has for this unit, or 0 without one. */
async function countChunks(ctx: Ctx, subject: SubjectUnit | null): Promise<number> {
  if (!ctx.enrichment || subject?.kind !== 'lazy-task' || !subject.code) return 0;
  const facts = await ctx.enrichment.lookupTask(subject.code).catch(() => null);
  return facts?.chunks.length ?? 0;
}

interface RecoveredRange {
  commits: WalkedCommit[];
  provenance: RegionProvenance;
  /** The range the commits came from, for the off-first-parent subject scan. */
  from: string;
  to: string;
}

/**
 * Does anything in this range — including off the first-parent line — name
 * another unit?
 *
 * One `git log --format=%s`, run only for a range that actually has a merge
 * in it. This is the call that finds a release hub whose children arrived
 * through a merge rather than as first-parent squashes, which is how the
 * largest accepts in lazy's own v0.22 release are shaped.
 */
async function rangeHidesUnits(ctx: Ctx, from: string, to: string): Promise<boolean> {
  const result = await runGit(
    ['log', '--format=%s', `${from}..${to}`, `^${ctx.baseRef}`],
    { cwd: ctx.cwd },
  );
  if (result.exitCode !== 0 || !result.stdout) return false;
  return result.stdout.split('\n').some((s) => unitFromSubject(s.trim()) !== null);
}

async function recoverSubRange(
  ctx: Ctx,
  commit: WalkedCommit,
  subject: SubjectUnit | null,
): Promise<RecoveredRange | null> {
  // (a) A real merge needs no recovery: its second parent IS the branch tip.
  if (commit.parents.length > 1) {
    const commits = await walkFirstParent(
      ctx.cwd,
      commit.parents[0]!,
      commit.parents[1]!,
      ctx.baseRef,
    );
    return commits.length
      ? {
        commits,
        provenance: 'merge-parent',
        from: commit.parents[0]!,
        to: commit.parents[1]!,
      }
      : null;
  }

  // (a)/(c) A squash exposes nothing — recover the branch by ref.
  if (!subject) return null;
  const refs = branchCandidates(subject, ctx.remotes);
  // The store may know the exact branch the session ran on; try it first.
  if (subject.kind === 'lazy-task' && subject.code && ctx.enrichment) {
    const facts = await ctx.enrichment.lookupTask(subject.code).catch(() => null);
    if (facts?.branch) refs.unshift(`refs/heads/${facts.branch}`);
  }
  for (const ref of refs) {
    if (!ctx.branchRefs.has(ref)) continue;
    // `<squash>^..<branch>` and NOT a merge-base range: the squash's parent is
    // the target tip at accept time, so everything the branch merged in from
    // upstream is already reachable from it and drops out. A merge-base range
    // would drag the whole upstream sync back in as if the task had written it.
    const from = commit.parents[0] ?? `${commit.sha}^`;
    const commits = await walkFirstParent(ctx.cwd, from, ref, ctx.baseRef);
    if (commits.length) return { commits, provenance: 'branch-ref', from, to: ref };
  }
  if (subject.kind === 'lazy-task' || subject.kind === 'pr-merge') {
    ctx.notes.push(
      `No surviving branch for ${subjectLabel(subject)} — kept as a single commit-level region.`,
    );
  }
  return null;
}

function subjectLabel(subject: SubjectUnit): string {
  return subject.code ?? subject.branch ?? `#${subject.pr ?? '?'}`;
}

/**
 * §1.5.3's tests, and — the part the spec leaves implicit — what a unit that
 * trips one should expand INTO.
 *
 * The distinction is what keeps a carved review reviewable. §1.5.1's hierarchy
 * is hub → child task → review chunk; a bare COMMIT is the leaf only when the
 * store is absent. Shattering a coherent task into its individual commits is
 * therefore not a level of the hierarchy at all, it is below it — and doing it
 * whenever any test fired is what produced 1,271 regions on this repo's own
 * release, 732 of them bare commits and 238 of those touching two files or
 * fewer. Nobody reviews that.
 *
 * So a test says WHETHER, and the strongest available structure says INTO WHAT:
 *
 *  - another unit's work is inside  → expand into those UNITS. Always worth it:
 *    this is the release hub hiding thirty child tasks.
 *  - the turns differ in actor/agent/model → expand into review CHUNKS, never
 *    commits. "Handed between a person and an agent" is a statement about
 *    intervals of work, which is exactly what a chunk is.
 *  - it is simply too big to hold → chunks if the store has them, else commits.
 *    This is the honest backstop, and the one case where bare commits genuinely
 *    beat one 400-file blob.
 *  - more than one PERSON wrote it → commits, the spec's own short-circuit.
 *
 * Trigger 2 counts HUMANS, via {@link humanIdentities}. Counting raw
 * `Co-authored-by:` trailers made it fire on essentially every task branch
 * here, because lazy stamps the agent as a co-author: 471 `Lazy <noreply@…>`
 * and 15 `Claude Opus 4.8 <noreply@…>` across v0.22. The spike predicted this
 * test would be inert on an agent-driven repo and load-bearing on a human one;
 * counting machines inverted that.
 */
export type ExpansionTarget = 'units' | 'chunks' | 'commits';

export interface ExpansionPlan {
  into: ExpansionTarget;
  reasons: string[];
}

export function planExpansion(
  ctx: Pick<Ctx, 'limits'>,
  region: ReviewRegion,
  sub: WalkedCommit[],
  opts: { nested: boolean; hasChunks: boolean },
): ExpansionPlan | null {
  const reasons: string[] = [];
  let into: ExpansionTarget | null = null;

  if (opts.nested) {
    reasons.push('contains merges or squashes of other units');
    into = 'units';
  }

  const varied = [
    region.actors && region.actors.length > 1 ? 'actors' : null,
    region.agents && region.agents.length > 1 ? 'agents' : null,
    region.models && region.models.length > 1 ? 'models' : null,
  ].filter(Boolean);
  if (varied.length && opts.hasChunks) {
    reasons.push(`turns differ in ${varied.join(', ')}`);
    into ??= 'chunks';
  }

  const oversized = region.files.length >= ctx.limits.sizeBackstopFiles;
  if (oversized) {
    reasons.push(`${region.files.length} files (size backstop)`);
    into ??= opts.hasChunks ? 'chunks' : 'commits';
  }

  const people = humanIdentities(sub);
  if (people.length > 1) {
    reasons.push(`${people.length} people wrote it (${people.slice(0, 3).join(', ')})`);
    into ??= 'commits';
  }

  return into ? { into, reasons } : null;
}

/**
 * Level 3 — the review chunks of a task, when the store has them and the turns
 * differ enough to be worth separating (§1.5.1, §1.5.3 test 3).
 *
 * Both sha ends must resolve here: a chunk's range comes from turn records,
 * and a worktree that never had those commits (a fresh clone, a deleted
 * branch) must degrade to no chunks rather than to an empty diff.
 */
async function chunkRegions(
  ctx: Ctx,
  region: ReviewRegion,
  subject: SubjectUnit | null,
  depth: number,
  reasons: string[],
): Promise<ReviewRegion[]> {
  if (!ctx.enrichment || subject?.kind !== 'lazy-task' || !subject.code) return [];
  const facts = await ctx.enrichment.lookupTask(subject.code).catch(() => null);
  if (!facts || facts.chunks.length < 2) return [];

  const children: ReviewRegion[] = [];
  for (const chunk of facts.chunks) {
    if (ctx.regionCount >= ctx.limits.maxRegions) {
      ctx.capped = true;
      break;
    }
    if (!(await refResolves(ctx.cwd, chunk.from)) || !(await refResolves(ctx.cwd, chunk.to))) {
      continue;
    }
    const files = await rangePaths(ctx.cwd, chunk.from, chunk.to);
    if (files.length === 0) continue;
    ctx.regionCount += 1;
    children.push({
      id: mintRaw(ctx, `chunk:${subject.code}#${chunk.index}`),
      unit: 'chunk',
      parent_id: region.id,
      depth: depth + 1,
      title: chunk.title,
      from: chunk.from,
      to: chunk.to,
      provenance: 'chunk',
      files: files.sort(),
      shared_files: [],
      commit_count: 0,
      authors: region.authors,
      expansion_reasons: [],
      task_code: subject.code,
      ...(region.actors ? { actors: region.actors } : {}),
      ...(region.agents ? { agents: region.agents } : {}),
      ...(region.models ? { models: region.models } : {}),
    });
  }
  if (children.length < 2) {
    // One chunk is not a carving, it is the task again. Undo the accounting.
    ctx.regionCount -= children.length;
    return [];
  }
  for (const child of children) ctx.claimCounts.set(child.id, child.files.length);
  // Chunks are RANGES the store handed us rather than a first-parent chain, so
  // their commit membership is read range by range. There are only ever a
  // handful, and they are the level nothing else can reconstruct.
  const shaToRegion = new Map<string, string>();
  for (const child of children) {
    for (const sha of await commitsInRange(ctx.cwd, child.from, child.to)) {
      // First writer wins: chunks are consecutive, so an overlap is a store
      // artefact, and giving a shared commit to the earlier chunk is at least
      // deterministic.
      if (!shaToRegion.has(sha)) shaToRegion.set(sha, child.id);
    }
  }
  const { unattributed } = partitionOwnership({
    siblings: children,
    shaToRegion,
    attribution: ctx.attribution,
    scopePaths: new Set(region.files),
  });
  // Same rule here as in `carve`: a chunk level that cannot place one of its
  // parent's files says so rather than quietly losing it.
  noteUnattributed(ctx, unattributed, region.id);
  region.expansion_reasons = reasons;
  return children;
}
