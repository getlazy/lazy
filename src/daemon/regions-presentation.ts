/**
 * The presentation a task declared, READ AS ITS REGIONS — or, for a task with
 * landed subtasks, a map derived from those children.
 *
 * Final-turn design §6: the agent's own `lazy_report` walkthrough is the
 * partition the reviewer navigates — the group IS the region, not a
 * git-derived carve. This module is the one LOADER for that answer; the carve
 * (`src/regions/compute.ts`) survives only as the agent-facing provenance
 * hint (§6.4) and is never read by a human surface again.
 *
 * What a presentation group already had (agent-declared, file-crossing,
 * tiered, with a residual group) is exactly what a region lacks a partition
 * invariant for; what a region has that a group lacked is an id to hang an
 * overlay on. So the row below is the group re-projected, not a new idea:
 * `files` is its membership claim, `id` is its stable slug, and the residual
 * group owns everything the diff contains that no group claimed whole.
 *
 * Deliberately NOT in `src/daemon/regions-service.ts`: that file is already
 * the largest in the daemon and its concerns are the carve's; the two files
 * also must not share a name with `src/storage/presentation.ts`, which owns
 * the SAVE boundary.
 */

import { createHash } from 'node:crypto';
import {
  applyRegionOverlays,
  blobPairs,
  countRegionChildren,
  listReviewPaths,
  regionSummary,
  resolveSha,
  visibleRegions,
  type RegionCover,
  type ReviewRegion,
} from '../regions';
import {
  appendResidualGroup,
  capName,
  capRefusalLine,
  fileClaimsFromGroups,
  fileItemPaths,
  groupIdOf,
} from '../storage/presentation';
import type { Storage } from '../storage/interface';
import type {
  PresentationCapRefusal,
  PresentationGroup,
  ReviewPresentation,
  Task,
  TurnReport,
} from '../types';
import { shortId } from '../task/identity';
import { isHubTask, outstandingChildren } from '../task/hub';
import { RpcError } from './rpc-error';
import { getOrCreateStorage } from './rpc-handlers';
import { resolveTaskDiffContext } from './task-diff-context';
import { logger } from '../utils/logger';
import {
  DEFAULT_REGION_DEPTH,
  optionalNonNegativeInt,
  resolveRegionRef,
  type RegionsResult,
} from './regions-service';

/** What every surface tells an agent that asks about a task with no presentation yet. */
export const NO_PRESENTATION_NOTE =
  'This task has no presented regions yet — they appear once a human-facing ' +
  'park files a walkthrough (`lazy_report` with a `presentation`). ' +
  'Pass `provenance: true` to scope to a git-derived carve instead.';

/** Leading note on a HUB's derived map, so nobody reads it as an authored one. */
export const HUB_DERIVED_NOTE =
  'Derived from this task\'s children: nobody wrote this walkthrough. Each region ' +
  'below is one accepted child\'s work, carved off its accept commit. A region an ' +
  'agent declares with `lazy_report` replaces this map entirely.';

/** A region row synthesized from a presentation group, with its overlay merged in. */
export interface PresentedRegions {
  cover: RegionCover;
  /**
   * WHERE these rows came from, so a caller can tell an authored walkthrough
   * from a hub's derived map without inspecting the notes.
   *
   * It is not decoration: a derived map has no per-region content hash (see
   * {@link hashes}), so a SIGN-OFF against one cannot be stored or checked.
   * The overlay RPC reads this and refuses rather than accepting an approval
   * it would silently drop.
   */
  source: 'presentation' | 'children';
  /**
   * Region id → the content hash its sign-off is checked against at read
   * time. Presented rows never have a commit range to diff, so "has this
   * region changed since the approval" is answered by these pairs — one
   * `<old>:<new>` blob pair per owned file, hashed together. That is the one
   * behavioural improvement the presentation switch buys (final-turn design
   * §6.1): a sign-off survives a commit that touched a different region.
   *
   * EMPTY on a derived hub map, and that is the whole reason `source` exists:
   * those rows are carve units with a commit range rather than a file-set
   * claim, so there is no per-region content to hash.
   */
  hashes: Map<string, string>;
}

/** The region row one group becomes. Its `files` are the `kind: 'file'` claims. */
function presentedRow(
  group: PresentationGroup,
  baseSha: string,
  headSha: string,
  id: string,
): ReviewRegion {
  return {
    id,
    unit: 'presentation',
    parent_id: null,
    depth: 0,
    title: group.title,
    from: baseSha,
    to: headSha,
    provenance: 'presentation',
    // The walkthrough group's tier, read by every renderer that orders rows
    // display-first (docs above core — `sortPresentationGroupsForDisplay`).
    // The agent's declared order stays the data order; this is display weight.
    tier: group.tier,
    // The group's summary read as the row's note: on a region list it is the
    // one line saying what this slice is, and for a residual row it is where
    // "N of M files are not named" and any cap refusal live.
    ...(group.summary ? { note: group.summary } : {}),
    files: group.items.flatMap((item) => (item.kind === 'file' ? fileItemPaths(item) : [])),
    // A presented row has no siblings carved from a shared history, so there
    // is nobody to attribute a shared file to — the walkthrough itself is the
    // attribution. The partition invariant still holds: every diff path is in
    // exactly one row's `files`.
    shared_files: [],
    commit_count: 0,
    authors: [],
    expansion_reasons: [],
  };
}

/**
 * Hash a region's OWNED files from the range's blob pairs, sorted by path.
 *
 * Sorted so the hash is a function of the CONTENT SET, not of the order git
 * happened to report — a rebase that reorders otherwise-identical changes
 * must not stale an approval nobody's region actually changed.
 */
function regionHash(files: readonly string[], pairs: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const path of [...files].sort()) {
    const pair = pairs.get(path);
    // A claimed path outside the diff range (unchanged since base, or
    // diff-filtered away) contributes nothing: the region's content is
    // unchanged by definition, and hashing a placeholder would stale the
    // sign-off on the very commit the presentation was written against.
    if (pair) hash.update(`${path}\0${pair}\n`);
  }
  return hash.digest('hex');
}

/**
 * Synthesize the region rows from a presentation, as a pure function.
 *
 * Everything a caller could want to vary is a parameter, so the unit tests
 * run this without a git repo or a store; `loadPresentedRegions` is the thin
 * glue that reads those inputs. Groups keep the AGENT'S narrative order —
 * the order is the walkthrough's story (§6.1), the one thing a carve could
 * never supply — with the residual last.
 */
export function presentedRegions(
  taskId: string,
  presentation: ReviewPresentation,
  inputs: {
    baseRef: string;
    baseSha: string;
    headSha: string;
    /** Every path the review range changes — the partition's universe. */
    diffPaths: readonly string[];
    /** Path → blob pair, for the per-region sign-off hashes. */
    pairs: ReadonlyMap<string, string>;
    overlays: Parameters<typeof applyRegionOverlays>[1];
    /**
     * A cap a walkthrough on this task was refused for. Stated on the
     * residual row and, so it is visible even when nothing is left over, as
     * a cover note.
     */
    capRefusal?: PresentationCapRefusal;
    /**
     * Whether that refusal was recorded WITH the walkthrough being shown.
     * False when it came off an earlier report, which decides only how the
     * line is worded — never whether it is said.
     */
    capRefusalSameReport?: boolean;
  },
): PresentedRegions {
  const {
    baseRef, baseSha, headSha, diffPaths, pairs, overlays, capRefusal,
    capRefusalSameReport = true,
  } = inputs;
  const claims = fileClaimsFromGroups(presentation.groups);
  const groups = appendResidualGroup(
    presentation.groups,
    [...diffPaths],
    claims,
    {
      ...(capRefusal ? { capRefusal } : {}),
      capRefusalSameReport,
    },
  );
  // A cap refusal is said ONCE. The residual row is the better place for it —
  // it is where a reviewer is deciding what to make of an unassigned block —
  // so the cover note carries it only when the walkthrough left nothing over
  // and there is no such row.
  const residualCarriesCap = diffPaths.some((p) => !claims.has(p));

  // INVARIANT: every region row carries a DISTINCT id, and this boundary
  // ENFORCES it rather than trusting the save boundary to have. Two rows under
  // one id is a silent partition loss — `--region <id>` resolves to the first
  // and omits the other's files, the `hashes` map below keeps only the last,
  // and a sign-off recorded against that id covers files nobody opened.
  // `assignPresentationGroupIds` is the primary rule, but it only reaches
  // reports saved since it existed: a presentation stored BEFORE ids were
  // minted has no stored ids at all, so every id here is `groupIdOf`'s
  // title-slug fallback, and two groups whose titles slugify alike ("Retry
  // path" and "Retry/path") still arrive colliding.
  //
  // Ids are therefore handed out in order, seeding `usedIds` as they go. The
  // residual group is appended LAST, so this also keeps the property the
  // precomputed set existed for: an agent who titled a group "Other changes" —
  // allowed, the walkthrough may legitimately group that way — keeps that id
  // and the derived residual yields to it with a suffix, rather than shadowing
  // content the overlay is keyed on.
  const usedIds = new Set<string>();
  const regions = groups.map((g) => {
    const id = mintUniqueRegionId(groupIdOf(g), usedIds);
    usedIds.add(id);
    return presentedRow(g, baseSha, headSha, id);
  });

  const cover: RegionCover = {
    task_id: taskId,
    base_ref: baseRef,
    base_sha: baseSha,
    head_sha: headSha,
    computed_at: Date.now(),
    regions,
    // With no residual row to carry it, the cap rides the cover note — and
    // says the OTHER thing: the cap bit, and the walkthrough that followed
    // covers the whole change. The residual wording ("some of these files may
    // be unassigned") would point at a block that does not exist, reading as
    // a defect report about the good outcome.
    notes: capRefusal && !residualCarriesCap
      ? [capRefusalLine(capRefusal, { residual: false, sameReport: capRefusalSameReport })]
      : [],
  };
  const merged = applyRegionOverlays(cover, overlays);
  const hashes = new Map<string, string>();
  for (const region of merged.regions) {
    hashes.set(region.id, regionHash(region.files, pairs));
  }
  return { cover: merged, hashes, source: 'presentation' };
}

/** The save boundary's suffix rule, applied to whatever id arrives here. */
function mintUniqueRegionId(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * The task's newest presentation, across sessions.
 *
 * Same recency rule the save boundary applies when it needs a predecessor's
 * group ids — the newest report that declared one wins, by the same
 * `(updated_at ?? created_at)` key. A restarted session's final turn
 * supersedes whatever an earlier session walked.
 */
export async function latestPresentationReport(
  storage: Storage,
  taskId: string,
): Promise<TurnReport | null> {
  const reports = await storage.getTaskTurnReports(taskId);
  let best: TurnReport | null = null;
  let bestAt = -1;
  for (const report of reports) {
    if (!report.presentation) continue;
    const at = report.updated_at ?? report.created_at;
    if (at > bestAt) {
      best = report;
      bestAt = at;
    }
  }
  return best;
}

/** The presentation alone, for callers with nothing to say about its report. */
export async function latestPresentation(
  storage: Storage,
  taskId: string,
): Promise<ReviewPresentation | null> {
  return (await latestPresentationReport(storage, taskId))?.presentation ?? null;
}

/**
 * The newest cap refusal recorded on ANY of the task's reports.
 *
 * Read independently of the walkthrough, because the case the record exists
 * for is precisely the one with no walkthrough to hang it on: the agent hit
 * the cap and never filed a fitting one — gave up, wrote prose instead, or
 * the turn was killed. Keying it to the presentation would have made the cap
 * visible only when it had already been worked around, which is the failure
 * it was added to end.
 */
export async function latestCapRefusal(
  storage: Storage,
  taskId: string,
): Promise<PresentationCapRefusal | null> {
  const reports = await storage.getTaskTurnReports(taskId);
  let best: PresentationCapRefusal | null = null;
  let bestAt = -1;
  for (const report of reports) {
    const refusal = report.presentation_cap_refusal;
    if (!refusal) continue;
    const at = report.updated_at ?? report.created_at;
    if (at > bestAt) {
      best = refusal;
      bestAt = at;
    }
  }
  return best;
}

/**
 * A task with no presentation: regions from nothing, and the hint above —
 * plus the cap, when one refused the walkthrough that would have been here.
 * "No walkthrough" and "the walkthrough was refused for being too big" are
 * different answers, and only the second tells the reviewer to go looking.
 */
function emptyCover(taskId: string, capRefusal?: PresentationCapRefusal | null): RegionCover {
  return {
    task_id: taskId,
    base_ref: 'HEAD',
    base_sha: '',
    head_sha: '',
    computed_at: Date.now(),
    regions: [],
    notes: capRefusal
      ? [capRefusedWithoutWalkthroughNote(capRefusal), NO_PRESENTATION_NOTE]
      : [NO_PRESENTATION_NOTE],
  };
}

/**
 * The regions a HUB presents: its children, derived, with no model turn.
 *
 * A task whose branch is mostly its children's accepted work has a reviewer
 * question that a walkthrough is the wrong shape for — "what has landed, and
 * what is still out?" — and an answer git already holds. The provenance carve
 * keys on the accept tags, so an accepted child is ALREADY one unit of it;
 * this adds the two things the carve cannot know, both as notes: that nobody
 * authored this map, and which children have not landed yet.
 *
 * Recomputation is HEAD-keyed for free: `loadRegionCover` stores its cover
 * against the head it carved, so the carve re-runs when a child lands or a
 * human commits, and never otherwise.
 *
 * `hashes` is deliberately empty — a carved region's staleness is answered by
 * the cover's head exactly as it is on the provenance surfaces, and inventing
 * per-region content hashes here would make the same region stale on one
 * surface and current on another. The `source` field carries that fact out to
 * the overlay RPC, which refuses a sign-off it could not record.
 */
async function hubRegions(
  storage: Storage,
  projectRoot: string,
  taskRefInput: string,
  taskId: string,
  children: readonly Task[],
  opts: { allowStale?: boolean; allowMissing?: boolean; leadNotes?: readonly string[] },
): Promise<PresentedRegions> {
  // Dynamic import: regions-service imports THIS module for the presented
  // surfaces, so the carve loader can only be reached the other way at
  // call time.
  const { loadRegionCover } = await import('./regions-service');
  const cover = await loadRegionCover(storage, projectRoot, taskRefInput, opts);
  // Children that can STILL land. A closed or rejected one is `abandoned` and
  // never will, so naming it here would promise a reviewer something that can
  // never arrive — the same reason it does not make a task a hub in the first
  // place (src/task/hub.ts).
  const outstanding = outstandingChildren(children);
  // `leadNotes` first: when a stored walkthrough was passed over, why it was
  // passed over is the first thing a reader who remembers seeing one needs.
  const notes = [...(opts.leadNotes ?? []), HUB_DERIVED_NOTE, ...cover.notes];
  if (outstanding.length > 0) {
    notes.push(
      `${outstanding.length} child task${outstanding.length === 1 ? '' : 's'} not accepted into ` +
      `this branch yet: ${outstanding
        .map((child) => `${child.code ?? shortId(child.id)} (${child.status})`)
        .join(', ')}. Their work is NOT in the regions above.`,
    );
  }
  return { cover: { ...cover, task_id: taskId, notes }, hashes: new Map(), source: 'children' };
}

/**
 * A task's current head, or null when it cannot be read.
 *
 * Its own resolver rather than a hoist out of the main path: this runs BEFORE
 * the source is decided, on the one branch that needs it, and must never turn
 * a regions read into a 400 for a worktree it did not otherwise have to touch.
 */
async function resolveTaskHeadSha(
  storage: Storage,
  projectRoot: string,
  taskRefInput: string,
): Promise<string | null> {
  try {
    const ctx = await resolveTaskDiffContext(storage, projectRoot, taskRefInput, { fullBranch: true });
    return (await resolveSha(ctx.worktreePath, 'HEAD')) ?? null;
  } catch (err) {
    logger.debug(
      `loadPresentedRegions: could not read HEAD for ${taskRefInput} to date the stored ` +
      `walkthrough (${err instanceof Error ? err.message : err}); treating it as current.`,
    );
    return null;
  }
}

/**
 * Why a hub is being shown its children rather than the walkthrough on record.
 *
 * Named with the two SHAs because the reader's question is "how old is what I
 * am not being shown" — and because a walkthrough whose head is one commit
 * behind and one that predates every child read identically otherwise.
 */
export function staleWalkthroughNote(presentedSha: string | undefined, headSha: string): string {
  const at = presentedSha
    ? `was written at \`${presentedSha.substring(0, 8)}\` and the branch has moved since ` +
      `(\`${headSha.substring(0, 8)}\`)`
    : 'was written before lazy recorded which head a walkthrough describes, so it cannot be ' +
      'shown to be current';
  return (
    `An authored walkthrough is on record but ${at}, so it is NOT what you are being shown. ` +
    'A task presented by its children re-derives this map whenever the branch moves; the ' +
    'walkthrough would have stayed frozen at the head it was written for.'
  );
}

/**
 * Whether the walkthrough on record still describes the branch.
 *
 * ONLY a hub asks. A leaf task's stale walkthrough is re-authored at its next
 * human-facing park, so passing it over would show the reviewer nothing at all
 * in exchange for nothing gained; a hub never runs the presentation step
 * again, so its stale walkthrough would be frozen for the life of the task.
 *
 * Fails SAFE toward today's answer: a head that cannot be resolved returns
 * `true`, because "we could not check" must not hide a walkthrough somebody
 * wrote. An UNSTAMPED walkthrough is not current — not because it is known to
 * be old, but because it cannot be shown to be current, and for a hub the
 * derived map is the better answer to an open question. Every walkthrough
 * filed since `presentation_head_sha` existed carries one.
 */
function walkthroughIsCurrent(report: TurnReport, headSha: string | null): boolean {
  if (!headSha) return true;
  return report.presentation_head_sha === headSha;
}

/**
 * The cap line for a task with NO stored walkthrough — a different sentence
 * from {@link capRefusalLine}, which talks about the files in a residual
 * block. Here there is no partition at all, and that is the news.
 */
export function capRefusedWithoutWalkthroughNote(refusal: PresentationCapRefusal): string {
  return (
    `A walkthrough was refused for exceeding ${capName(refusal)} — ${refusal.actual} declared — ` +
    'and no smaller one was filed, so this change has no walkthrough because of the cap.'
  );
}

/**
 * Read a task's presentation as its regions, and never throw for "none yet".
 *
 * The report is read FIRST, storage-only: an agent probing `lazy_regions` on
 * a mid-flight task gets the hint rather than a 400 from a worktree resolution
 * that has nothing to resolve. Only once a presentation exists does the
 * loader touch the worktree, to frame the diff the groups partition and to
 * hash each region's own files.
 *
 * Order matters, and it is the one the design fixes (§6.5): an AUTHORED
 * walkthrough wins while it is CURRENT. A hub whose agent wrote one at the
 * present head is presented by it; a hub whose walkthrough the branch has
 * moved past falls through to the derived map, exactly as one that never wrote
 * a walkthrough at all, because a hub never gets to author a second one. A
 * LEAF keeps its walkthrough however old — its next park re-authors it.
 */
export async function loadPresentedRegions(
  storage: Storage,
  projectRoot: string,
  taskRefInput: string,
  opts: {
    /**
     * Serve a hub's derived map from a cover carved at an older head, and
     * answer a missing one immediately rather than carving inline.
     *
     * For surfaces LISTING regions as navigation — the web Changes tab, a
     * `lazy_regions` call that named none. A caller that NAMED a region wants
     * that region, and an empty cover would read to it as "no region by that
     * name", so those callers leave this off and wait for the carve.
     */
    lenientHubCarve?: boolean;
  } = {},
): Promise<PresentedRegions> {
  const { task } = await storage.resolveTask(taskRefInput);
  if (!task) throw new RpcError(404, `Task not found: ${taskRefInput}`);

  const report = await latestPresentationReport(storage, task.id);
  const authored = report?.presentation;

  // The SAME predicate the wrap-up plan drops the presentation step on
  // (src/task/hub.ts). If these two ever disagree, a task authors no
  // walkthrough and is then told it has none — which is precisely what a
  // childless `cluster` used to be told.
  const children = await storage.getChildTasks(task.id);
  const hub = isHubTask(task, children);

  // INVARIANT (review 6ac1a2b8): an authored walkthrough outranks the derived
  // children map only while it is CURRENT.
  //
  // The two halves of the hub rule pull opposite ways once a walkthrough
  // already exists. `wrapUpPlanFor` drops `present` from BOTH lists for a hub,
  // so a hub never authors another one; and "authored always wins" made the
  // derived map unreachable. Together they froze one particular walkthrough
  // forever — and the path there is ordinary, not exotic: a parent task's
  // first turn spawns subtasks and parks, which at that moment is not a hub,
  // so it authors a walkthrough of an almost-empty branch. The first child to
  // land makes it a hub, and that first-turn map is what every surface served
  // from then on, with every later file in "Other changes" and nothing saying
  // the map predated the branch.
  //
  // So the stamp decides. For a LEAF nothing changes: it keeps its
  // walkthrough however old, because its next human-facing park re-authors it.
  let staleNote: string | undefined;
  let presentation = authored;
  if (authored && hub) {
    const headSha = await resolveTaskHeadSha(storage, projectRoot, taskRefInput);
    if (!walkthroughIsCurrent(report!, headSha)) {
      presentation = undefined;
      staleNote = staleWalkthroughNote(report!.presentation_head_sha, headSha ?? '');
    }
  }

  if (!presentation) {
    // Checked BEFORE the cap-refusal cover, deliberately: that cover's
    // sentence says this change has no walkthrough because of the cap, and on
    // a hub that premise is false — it has the derived map below. A hub is
    // never asked for a walkthrough at all, so a refusal recorded on one
    // explains nothing its reader needs.
    if (hub) {
      return hubRegions(storage, projectRoot, taskRefInput, task.id, children, {
        allowStale: opts.lenientHubCarve,
        allowMissing: opts.lenientHubCarve,
        ...(staleNote ? { leadNotes: [staleNote] } : {}),
      });
    }
    return {
      cover: emptyCover(task.id, await latestCapRefusal(storage, task.id)),
      hashes: new Map(),
      source: 'presentation',
    };
  }

  // `fullBranch` for the same reason the diff's `--region` implies it (§6.3):
  // a region is a navigational map of the WHOLE branch — on a release hub the
  // default diff excludes accepted children's files, and every presented
  // group is made of exactly files some child brought. Residual completeness
  // is a partition invariant, not a per-surface preference.
  const ctx = await resolveTaskDiffContext(storage, projectRoot, taskRefInput, {
    fullBranch: true,
  });
  const headSha = (await resolveSha(ctx.worktreePath, 'HEAD')) ?? '';
  // Resolved to a sha rather than passed through as typed: `listReviewPaths`
  // and `blobPairs` both interpolate the ref into a three-dot range, and a
  // branch-name base resolves the same merge base either way — but a sha in
  // the cover is what makes `base_sha` comparable across reads.
  const baseSha = (await resolveSha(ctx.worktreePath, ctx.fromRef)) ?? ctx.fromRef;

  const pairs = headSha
    ? await blobPairs(ctx.worktreePath, `${baseSha}...${headSha}`)
    : new Map<string, string>();
  // Three dots even when the rendered diff is two-dot: for a concrete SHA
  // base the merge base IS the base, so both spellings produce the same
  // paths — and `listReviewPaths` already reads the range this way, which is
  // the comparison the residual has to agree with.
  const diffPaths = headSha
    ? (await listReviewPaths(ctx.worktreePath, baseSha, headSha)).paths
    : [];
  const overlays = await storage.getRegionOverlays(task.id);

  return presentedRegions(task.id, presentation, {
    baseRef: ctx.fromRef,
    baseSha,
    headSha,
    diffPaths,
    pairs,
    overlays,
    ...capRefusalFor(report, await latestCapRefusal(storage, task.id)),
  });
}

/**
 * Which refusal this walkthrough is shown with, and how it is attributed.
 *
 * The refusal recorded WITH the walkthrough is the strongest answer — same
 * report row, so "the walkthrough hit the cap" is literally true. But a
 * session that hits the cap and is then interrupted or watchdogged records it
 * on ITS report, and the session that resumes files the smaller walkthrough on
 * a row of its own — and long hub turns, which are the ones that hit caps at
 * all, are exactly the turns that get interrupted. Keying the line to the row
 * would lose the cap in that case, which is the "it reads like the agent chose
 * to leave things out" failure this work exists to end.
 *
 * So the task-wide refusal is the fallback, and the WORDING carries the
 * difference rather than the line being dropped: it says a walkthrough on this
 * task was refused and this one came after, never that this one hit the cap.
 */
export function capRefusalFor(
  report: TurnReport | null,
  taskWide: PresentationCapRefusal | null,
): { capRefusal?: PresentationCapRefusal; capRefusalSameReport?: boolean } {
  if (report?.presentation_cap_refusal) {
    return { capRefusal: report.presentation_cap_refusal, capRefusalSameReport: true };
  }
  // The fallback RETIRES. A refusal older than the walkthrough on record has
  // been answered by it — the agent hit the cap, then wrote something that
  // fits — so annotating that walkthrough would tell the reviewer files may
  // be unassigned "because of the cap" when they are unassigned by choice.
  // Left to run, a cap from turn 4 decorated a complete walkthrough at turn
  // 40 forever, which teaches a reviewer to ignore the line: the same end
  // state as never showing it, only louder.
  //
  // Newer than the walkthrough is the case that is still true: the agent had
  // this walkthrough on record, tried to file a bigger one, and was refused
  // without replacing it.
  const walkthroughAt = report ? report.updated_at ?? report.created_at : 0;
  if (taskWide && taskWide.created_at > walkthroughAt) {
    return { capRefusal: taskWide, capRefusalSameReport: false };
  }
  return {};
}

/**
 * `regions` RPC — the presentation as summaries, plus one region in full.
 *
 * The carve-mode twin of `handleRegions`, with the shape it returns kept
 * IDENTICAL so no client can tell which source a call read from — except
 * that `areas` and `superseded` are never set: those are the carve's own
 * axes, and inventing them for a presentation would present a grouping no
 * group ever declared (§6.3).
 */
export async function handlePresentedRegions(
  projectRoot: string,
  params: Record<string, unknown>,
): Promise<RegionsResult> {
  if (typeof params.taskId !== 'string' || !params.taskId) {
    throw new RpcError(400, 'taskId is required');
  }
  const storage = await getOrCreateStorage();
  const selectedRef = typeof params.region === 'string' && params.region.trim()
    ? params.region.trim()
    : null;
  const { cover, hashes } = await loadPresentedRegions(storage, projectRoot, params.taskId, {
    // A caller that named a region wants THAT region; one listing them is
    // navigating and must not sit through a hub's first carve.
    lenientHubCarve: !selectedRef,
  });
  const counts = countRegionChildren(cover.regions);
  const resolved = selectedRef ? resolveRegionRef(cover, selectedRef) : null;
  const selected = resolved && 'region' in resolved ? resolved.region : null;

  const maxDepth = params.depth === 'all'
    ? 'all' as const
    : optionalNonNegativeInt(params.depth, 'depth') ?? DEFAULT_REGION_DEPTH;
  const visible = visibleRegions(cover.regions, { maxDepth, selected: selected?.id ?? null });

  const offset = optionalNonNegativeInt(params.offset, 'offset') ?? 0;
  const limit = optionalNonNegativeInt(params.limit, 'limit');
  const page = limit === undefined
    ? visible.slice(offset)
    : visible.slice(offset, offset + limit);

  const result: RegionsResult = {
    taskId: shortId(cover.task_id),
    baseRef: cover.base_ref,
    baseSha: cover.base_sha,
    headSha: cover.head_sha,
    computedAt: cover.computed_at,
    notes: cover.notes,
    total: cover.regions.length,
    shown: visible.length,
    depth: maxDepth,
    regions: page.map((r) =>
      // Staleness is answered by the region's OWN content hash, not the head
      // — the whole point of keying a sign-off to what was actually approved.
      regionSummary(r, { headSha: hashes.get(r.id) ?? cover.head_sha, counts: counts.get(r.id) }),
    ),
  };
  if (offset > 0) result.offset = offset;
  if (offset + page.length < visible.length) result.truncated = true;
  if (selected) {
    result.region = selected;
    // The DETAIL row carries the raw region (no `signed_off_current`), so the
    // CLI's detail view staleness-marks it against this — the same content
    // hash the summaries compared, not the head.
    result.region_hash = hashes.get(selected.id);
  }
  return result;
}