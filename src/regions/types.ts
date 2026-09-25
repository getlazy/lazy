import type { PresentationTier } from '../types';

/**
 * Review regions — the shape of a carved review.
 *
 * A region IS a unit of provenance (a task, a review chunk, or a bare commit),
 * never a cluster: there is no modularity metric and no tuning parameter here
 * beyond the size backstop. See docs/spikes/review-partitioning-general.md
 * §1.5 for the design and why clustering was deliberately parked.
 */

/**
 * The three levels a region can be at, deepest last — plus `area`, which is
 * not a level at all.
 *
 * An AREA is the second, coarser axis a hub is grouped by (a path area such as
 * `src/regions`). It is synthesized on read from the cover's `areas`, never
 * carved, and never mixes with the provenance tree: a reviewer selects one the
 * same way they select a region, and that is the whole of its resemblance.
 *
 * A PRESENTATION unit is a group the task's agent declared in its own
 * final-turn walkthrough (final-turn design §6) — the partition the reviewer
 * navigates, read from the turn report rather than carved. Like an area it is
 * synthesized on read, never carved.
 */
export type RegionUnitKind = 'task' | 'chunk' | 'commit' | 'area' | 'presentation';

/**
 * How the unit's commits were recovered. Stated on the surface because these
 * are not equally trustworthy: an accept tag is an identification lazy itself
 * wrote, a merge's second parent IS the branch, a named ref might have moved
 * since, and a bare commit is the floor.
 *
 * `presentation` is the one provenance that is not a commit-recovery method at
 * all: the unit was DECLARED by the agent that wrote the diff, and its file
 * list is a claim rather than a measurement. That difference is exactly why it
 * is stated rather than inferred — a reviewer weighting "the agent says these
 * five files are the migration" against "git says these 302 units exist" needs
 * to know which one they are reading.
 */
export type RegionProvenance =
  | 'accept-tag'
  | 'merge-parent'
  | 'branch-ref'
  | 'commit'
  | 'chunk'
  | 'area'
  | 'presentation';

/**
 * A file this region OWNS that other sibling units also touched.
 *
 * Attribution, never membership: the file belongs to exactly one region (see
 * {@link RegionCover}), and this records who else has fingerprints on it so a
 * reviewer reading the region knows the edits are not all its own.
 */
export interface RegionSharedFile {
  path: string;
  /** Ids of the other sibling regions whose commits also touch this path. */
  also: string[];
  /** Surviving lines in the review that blame to THIS region's commits. */
  lines: number;
  /** Surviving lines in the review that blame to any unit in this expansion. */
  total_lines: number;
}

/**
 * The person behind an overlay write, as the daemon derived it from the token
 * that made the call.
 *
 * NEVER read from a request field. A sign-off is a claim that a named person
 * looked at a slice of a change; a name the caller supplies is a claim about
 * somebody else, which is the one thing an approval record may not accept. The
 * derivation is `overlayActorOf` in src/daemon/regions-service.ts, and a caller
 * the daemon cannot attribute to a person (the CLI, its own review page, a
 * control-plane token) records NOTHING here rather than an invented identity.
 *
 * The name is carried alongside the email because the daemon has no user
 * directory to resolve anybody against later — without it, a surface rendering
 * an old sign-off could only print an address.
 */
export interface OverlayActor {
  /** Which PERSON, as git names them — the durable half. */
  email: string;
  /** Their display name at the time of the act, when the write carried one. */
  name?: string;
}

export interface ReviewRegion {
  /**
   * Stable unit id — `task:<code>`, `pr:<number>`, `branch:<name>`,
   * `chunk:<unit>#<n>` or `commit:<sha>`. Identity is the unit, NOT a
   * position in a slicing, which is what makes a refresh append rather than
   * re-slice and lets a human overlay survive it.
   */
  id: string;
  unit: RegionUnitKind;
  /** Region this one came from expanding, or null at the top level. */
  parent_id: string | null;
  depth: number;
  /** Task goal, chunk intent, or commit subject. */
  title: string;
  /** Two-dot commit range whose diff IS this region. */
  from: string;
  to: string;
  provenance: RegionProvenance;
  /**
   * For a `presentation` region: the walkthrough group's tier, carried on the
   * row so every renderer can read the display order (docs above core, per
   * `sortPresentationGroupsForDisplay`) without re-reading the report. The
   * agent's DECLARED order stays the data order everywhere — this is display
   * weight only. Absent on a carved region, which has no tier.
   */
  tier?: PresentationTier;
  /**
   * One line ABOUT this region, from the walkthrough that declared it: the
   * group's own summary, or — on the residual row — how much of the change
   * the walkthrough did not name and any cap it was refused for.
   *
   * Carried on the row so every region surface (web, CLI, MCP) says the same
   * thing without re-reading the report. Absent on a carved region.
   */
  note?: string;
  /**
   * The paths this region OWNS — its share of the partition.
   *
   * Every file of the review is in exactly one sibling's `files`, decided by
   * blame-weighted ownership (see {@link RegionCover}). A path this region's
   * commits touched but did not win is NOT here; it appears in the winner's
   * {@link shared_files} with this region named.
   */
  files: string[];
  /** The subset of `files` other sibling units also touched, naming them. */
  shared_files: RegionSharedFile[];
  commit_count: number;
  /** Git authors and `Co-authored-by:` identities, deduped. */
  authors: string[];
  /** Reasons §1.5.3 gave for expanding this unit; empty on a leaf. */
  expansion_reasons: string[];
  /** Enrichment from lazy's store — absent on a repo with no `.lazy`. */
  task_code?: string;
  actors?: string[];
  agents?: string[];
  models?: string[];
  /** Human overlay, merged in on read and keyed to `id`. */
  name?: string;
  /** Free-form actor the reviewer put on this region. No workflow attached. */
  owner?: string;
  /** Who set that owner, when the daemon knew. Absent on an unattributed write. */
  owner_set_by?: OverlayActor;
  signed_off_sha?: string;
  signed_off_at?: number;
  /** Who signed it off, when the daemon knew. Cleared with the sign-off. */
  signed_off_by?: OverlayActor;
}

/**
 * A unit that contributed to the branch but owns no file after partitioning —
 * everything it wrote was later rewritten by another unit.
 *
 * Kept as a cover-level list rather than as a zero-file region: provenance is
 * not lost, and the reviewer's list only has regions with work in them.
 */
export interface SupersededUnit {
  id: string;
  title: string;
  task_code?: string;
  /** How many paths it touched, all of them now owned by someone else. */
  touched: number;
}

/**
 * A coarse PATH grouping of a cover — the second axis a hub is read along.
 *
 * Provenance answers "who wrote this"; an area answers "what part of the tree
 * is this". A release hub carves into hundreds of provenance regions, which is
 * an accurate map and an unusable one; areas are a few dozen and are what a
 * reviewer actually navigates by. Areas partition the review's files too, on
 * their own axis, so the two groupings never have to agree about anything
 * except the file set.
 */
export interface RegionArea {
  /** `area:<label>` — selectable anywhere a region id is. */
  id: string;
  /** The path prefix, e.g. `src/regions`, `test`, or `(root)`. */
  label: string;
  files: string[];
  /** Ids of the provenance regions owning files in this area, largest first. */
  region_ids: string[];
  /**
   * Human overlay, merged in on read exactly as a region's is.
   *
   * An area is the grouping a release reviewer divides between people, so it
   * has to be able to carry an owner; its id is derived from the path and is
   * therefore as intrinsic as a unit id, which is what overlays require.
   */
  name?: string;
  owner?: string;
  owner_set_by?: OverlayActor;
  signed_off_sha?: string;
  signed_off_at?: number;
  signed_off_by?: OverlayActor;
}

/**
 * The cover shape this build writes and reads.
 *
 * Bumped when the PARTITION replaced the cover (v0.23): a region's `files` went
 * from "everything its range touches" to "everything it owns", and
 * `owned_files`/`contended_files` are gone. A stored cover from before that is
 * not a subset of this shape — its `files` sum to far more than the review —
 * so it is discarded and recarved rather than rendered as if it meant the same
 * thing.
 */
export const REGION_COVER_VERSION = 2;

/**
 * A task's region cover. A PARTITION: every file in the review diff belongs to
 * exactly ONE top-level region, and the regions' file counts sum to the number
 * of files in the diff.
 *
 * Slice 0 made this a cover — a file could belong to as many regions as had
 * touched it. On an ordinary task that rarely collides; on a release hub, where
 * late fix tasks rewrite what feature tasks introduced, almost every core file
 * had several claimants, so the region sizes summed to several times the
 * review's own size and a sign-off on one region said nothing about the file's
 * other claimants. Ownership is now decided per file by BLAME: whichever unit
 * wrote the most lines that survive in the branch's final version owns it, and
 * every other claimant becomes attribution (`shared_files`) rather than
 * membership.
 */
export interface RegionCover {
  /** {@link REGION_COVER_VERSION}. Absent on a pre-partition cover. */
  version?: number;
  task_id: string;
  /** The ref the review range starts at — the same base `lazy diff` uses. */
  base_ref: string;
  base_sha: string;
  head_sha: string;
  computed_at: number;
  regions: ReviewRegion[];
  /** The coarse path grouping — the second axis. Empty on a tiny review. */
  areas?: RegionArea[];
  /** Units whose work survives nowhere, kept so provenance is not lost. */
  superseded?: SupersededUnit[];
  /**
   * What the carving could not do, said plainly: branches it could not
   * recover, caps it hit, enrichment that was absent. Never silence.
   */
  notes: string[];
  /**
   * This cover is EMPTY because the carve is still running, not because the
   * task has no regions. Set only on the transient object a `allowStale`
   * caller gets on a cover miss; a stored cover never carries it, and a
   * surface must say so rather than render "no regions".
   */
  computing?: boolean;
  /**
   * The head the cover was CARVED at, when that differs from `head_sha`.
   *
   * A stale-tolerant read stamps `head_sha` with the branch's REAL tip and
   * moves the carve-time sha here, so that everything judging "is this still
   * true of the branch" — a sign-off, above all — compares against the branch
   * rather than against the cover's own age. Absent on a fresh cover, where
   * the two are the same thing.
   */
  carved_at_sha?: string;
  /**
   * The review range did not resolve, so this cover is empty for THAT reason.
   *
   * Never persisted: a failed carve must not become the stored answer, or a
   * transient (a pruned upstream ref, a worktree recovered without its
   * remote-tracking refs) is served as "this branch has no work" until the
   * next completed turn.
   */
  unresolved?: boolean;
}

/**
 * A human's annotations on one region, keyed to the unit id so every refresh
 * preserves them. Stored apart from the computed cover for the same reason.
 */
export interface RegionOverlay {
  unit_id: string;
  /** Reviewer-chosen name, shown instead of the derived title. */
  name?: string;
  /**
   * Who this region is someone's to review. A free-form actor string — there
   * is deliberately no assignment workflow, no notification and no Teams
   * identity behind it yet; the field exists so a partitioned review can be
   * divided between people at all, which a multiset could not express.
   */
  owner?: string;
  /**
   * The person who set that owner, derived from their token.
   *
   * Attribution is PER FIELD rather than per record: naming a region later must
   * not make it look as though that person assigned the owner, and it must not
   * overwrite who signed off. Absent when the write could not be attributed —
   * including on every overlay written before this field existed, which renders
   * exactly as it did then.
   */
  owner_set_by?: OverlayActor;
  /** Head sha the sign-off was recorded against — a sign-off is never blanket. */
  signed_off_sha?: string;
  signed_off_at?: number;
  /**
   * The person who signed off, derived from their token.
   *
   * Lives and dies with `signed_off_sha`: withdrawing a sign-off clears it, and
   * a fresh sign-off replaces it, so there can never be a name attached to an
   * approval that is no longer recorded.
   */
  signed_off_by?: OverlayActor;
  updated_at: number;
}

/**
 * One run of consecutive post-image lines that belong to one unit.
 *
 * Post-image line numbers, because the gutter labels the code the reviewer is
 * reading — a removed line is not in the final version and has no owner there.
 */
export interface LineAttributionRun {
  /** 1-based, inclusive, in the file's head version. */
  start: number;
  end: number;
  /** The owning region's id. */
  region: string;
  /** Task code when the unit is a lazy task — the gutter's label and link. */
  code?: string;
  /** The region's title, for the hover. */
  title: string;
}

export interface FileLineAttribution {
  path: string;
  /**
   * More than one unit touched this file.
   *
   * Decides the gutter's DEFAULT, which is the whole point of computing it:
   * on a single-claimant file every changed line is the same unit's by
   * construction, so a per-line gutter would be one label repeated down the
   * page and is off by default. A file several units touched is the one kind
   * of file a carved review most needs help with, so it is on.
   */
  multi: boolean;
  /** Runs, line-ordered. Empty on a single-claimant file — see `owner`. */
  runs: LineAttributionRun[];
  /** The one unit that owns the file, when only one touched it. */
  owner?: { region: string; code?: string; title: string };
}
