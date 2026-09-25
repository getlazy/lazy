/**
 * The daemon owns the region carving; CLI, MCP and the web page are clients
 * of these two RPCs and never compute a cover themselves.
 *
 * That is not ceremony: the carving reads a task's worktree at refs only the
 * daemon's own resolution knows (`resolveTaskDiffContext`), and a second
 * implementation would be free to disagree with `lazy diff` about what the
 * review range even is — the exact failure the diff-base invariant exists to
 * prevent.
 */

import {
  applyRegionOverlays,
  blameLineRuns,
  coverShaToRegionMap,
  computeRegionCover,
  countRegionChildren,
  findRegion,
  regionSummary,
  signOffSummary,
  sortRegionsByImpact,
  storeEnrichment,
  visibleRegions,
  REGION_COVER_VERSION,
  type FileLineAttribution,
  type LineAttributionRun,
  type OverlayActor,
  type RegionArea,
  type RegionCover,
  type RegionSummary,
  type ReviewRegion,
  type SupersededUnit,
} from '../regions';
import type { Storage } from '../storage/interface';
import type { ActorIdentity } from './actor-tokens';
import { shortId } from '../task/identity';
import { logger } from '../utils/logger';
import { RpcError } from './rpc-error';
import { getOrCreateStorage } from './rpc-handlers';
import {
  NO_PRESENTATION_NOTE,
  handlePresentedRegions,
  loadPresentedRegions,
} from './regions-presentation';
import { resolveTaskDiffContext } from './task-diff-context';


export async function loadRegionCover(
  storage: Storage,
  projectRoot: string,
  taskRefInput: string,
  opts: {
    /**
     * Accept a cover carved against an older head rather than recomputing.
     *
     * For surfaces that are rendering something else and want the regions as
     * navigation: the Changes tab, and the diff's `region` scoping. Carving a
     * release hub takes seconds, and making a page load pay for it because a
     * sync moved the head is the wrong trade — a region's id and its file list
     * are both fixed by its own commit range, so a stale cover scopes exactly
     * as correctly as a fresh one. It is only MISSING the regions that newer
     * commits would add, which is what the note says.
     */
    allowStale?: boolean;
    /**
     * Answer a cover MISS immediately, carving in the background.
     *
     * A separate decision from `allowStale`, and a stricter one. Accepting an
     * old cover still answers the caller's question; accepting a missing one
     * answers "not yet". That is right for a surface LISTING the regions as
     * navigation — the Changes tab, the Regions tab, `lazy_regions` with no
     * region named — where the alternative is a page that sits for seconds on
     * the first-ever carve of a branch with nothing to show for it.
     *
     * It is wrong for anyone who named a region: `lazy diff --region <id>` and
     * `lazy_regions(region:)` want THAT region, and an empty cover would turn
     * a slow answer into "no region by that name", sending the caller looking
     * for a typo they did not make. Those callers wait.
     */
    allowMissing?: boolean;
  } = {},
): Promise<RegionCover> {
  const ctx = await resolveTaskDiffContext(storage, projectRoot, taskRefInput);
  const stored = usableCover(await storage.getRegionCover(ctx.task.id));
  const head = await headSha(ctx.worktreePath);
  const stale = !!stored && !!head && stored.head_sha !== head;

  if (!stored && opts.allowMissing) {
    // THE FIRST CARVE, asked for by a surface that is rendering something
    // else. Every task predating this feature has no stored cover, and on a
    // release hub the walk is ~800 git invocations and several seconds — so
    // the Changes tab, or an agent's `lazy_regions`, would sit there with no
    // explanation on the one hit that is the slowest possible one.
    //
    // Answer NOW with an empty cover that says it is computing, and carve in
    // the background. `carveOnce` dedupes by `<task>@<head>`, so a reader who
    // reloads joins the run already going instead of starting a second one,
    // and the next render finds the stored cover.
    void carveOnce(storage, ctx.task.id, `${ctx.task.id}@${head ?? 'HEAD'}`, {
      cwd: ctx.worktreePath,
      baseRef: ctx.fromRef,
      branchStartSha: branchStartOf(ctx.task, ctx.sess),
    }).catch((err) => {
      // Nobody is awaiting this, so the only place it can be reported is the
      // log; the next caller that cannot tolerate a stale cover carves again
      // and raises the failure to whoever asked.
      logger.warn(
        `regions: background carve for ${ctx.task.id} failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return {
      task_id: ctx.task.id,
      base_ref: ctx.fromRef,
      base_sha: '',
      head_sha: head ?? '',
      computed_at: Date.now(),
      regions: [],
      notes: ['Review regions are being computed for this task — reload in a moment.'],
      computing: true,
    };
  }

  let cover = stored;
  if (!cover || (stale && !opts.allowStale)) {
    cover = await carveOnce(storage, ctx.task.id, `${ctx.task.id}@${head ?? 'HEAD'}`, {
      cwd: ctx.worktreePath,
      baseRef: ctx.fromRef,
      branchStartSha: branchStartOf(ctx.task, ctx.sess),
    });
  } else if (stale) {
    // Never silently. A reviewer looking at a filter that does not cover the
    // newest commits has to be able to tell.
    //
    // And `head_sha` is stamped with the branch's REAL tip, with the carve
    // sha kept in `carved_at_sha` for the note. Everything downstream that
    // asks "is this still true of the branch" reads `head_sha`, and the one
    // that matters is the SIGN-OFF: `regionSummary` marks a sign-off current
    // when it matches, so comparing a cover carved at H1 against its own H1
    // rendered "signed off @H1" with no stale marker after a sync, a child
    // accept or a human commit moved the branch to H2 without a turn. That is
    // precisely the row the whole mechanism exists to prevent — approval
    // showing over code nobody has looked at — and the stale-tolerant paths
    // (the web tabs, `lazy_regions`) are the two most people use.
    cover = {
      ...cover,
      head_sha: head ?? cover.head_sha,
      carved_at_sha: cover.head_sha,
      notes: [
        ...cover.notes,
        `Carved at ${cover.head_sha.slice(0, 8)}; the branch has moved since. ` +
        'Run `lazy regions <task>` to recarve.',
      ],
    };
  }

  const overlays = await storage.getRegionOverlays(ctx.task.id);
  const merged = applyRegionOverlays(cover, overlays);
  // Most-impactful first, sorted here rather than per surface so the CLI, the
  // web tab and MCP cannot disagree about what "the first region" is. The
  // STORED cover keeps its carve order — this is a presentation decision, and
  // baking it into the record would make a later change to the ordering
  // require a recarve of every task.
  return { ...merged, regions: sortRegionsByImpact(merged.regions) };
}

/**
 * A stored cover this build can read, or null.
 *
 * A cover carved before regions became a partition means something DIFFERENT by
 * `files` — everything a unit touched, not what it owns — so its counts sum to
 * several times the review and its `owned_files`/`contended_files` are gone from
 * the shape entirely. Rendering it would be a confidently wrong answer; it is
 * discarded and the next read carves again, which costs one carve per task,
 * once.
 */
function usableCover(cover: RegionCover | null): RegionCover | null {
  if (!cover) return null;
  return cover.version === REGION_COVER_VERSION ? cover : null;
}

/**
 * Carvings in flight, keyed by `<task id>@<head sha>`.
 *
 * Two callers asking about the same task at the same head do the SAME work:
 * the carve is a pure function of a repo and two refs. Before this, each ran
 * its own several-hundred-git-call walk and then raced the other to write the
 * identical cover back. Now the second awaits the first.
 *
 * Safe because every git call underneath is asynchronous — `runGit` awaits a
 * Bun subprocess and never blocks the event loop — so a waiting caller is
 * genuinely parked rather than holding the daemon. Keyed on the head sha, so a
 * carve for a DIFFERENT head is never shared with one for this head.
 */
const carvesInFlight = new Map<string, Promise<RegionCover>>();

/**
 * Is a carve reading this task's worktree right now?
 *
 * For anything about to DELETE that worktree. `loadRegionCover`'s
 * `allowMissing` path fires an un-awaited carve from any
 * READ — the Changes tab, the Regions tab, `lazy_regions` — and a reviewer
 * opening a merged task that was never carved starts a walk that runs for
 * seconds with nothing tracking it. `git worktree remove` and `git branch -D`
 * then fail against a worktree git is busy in, and the zombie sweep
 * half-completes: worktree gone, local branch left behind.
 *
 * A caller that finds a carve in flight should skip the task ENTIRELY and let
 * the next tick have it, not skip the teardown alone — finalizing the task to
 * `complete` while leaving the worktree behind makes the leak permanent,
 * because the next sweep skips a terminal task.
 */
export function hasCarveInFlight(taskId: string): boolean {
  const prefix = `${taskId}@`;
  for (const key of carvesInFlight.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

async function carveOnce(
  storage: Storage,
  taskId: string,
  key: string,
  input: {
    cwd: string;
    baseRef: string;
    branchStartSha: string | null;
  },
): Promise<RegionCover> {
  const existing = carvesInFlight.get(key);
  if (existing) return existing;

  const pending = (async () => {
    const started = Date.now();

    const cover = await computeRegionCover({
      cwd: input.cwd,
      taskId,
      baseRef: input.baseRef,
      headRef: 'HEAD',
      branchStartSha: input.branchStartSha,
      enrichment: storeEnrichment(storage),
    });
    // A FAILED carve is not an answer, so it is not stored. Persisting it made
    // a transient — a pruned upstream ref, a worktree recovered without its
    // remote-tracking refs — the permanent record: every later read is
    // `allowStale`, so it would serve that empty cover, and the surfaces would
    // report "no work to carve" until the next completed turn. Left unstored,
    // the next read simply carves again.
    if (cover.unresolved) {
      logger.warn(
        `regions: could not carve ${shortId(taskId)} — ${cover.notes.join(' ')} ` +
        '(not stored; the next read will try again)',
      );
      return cover;
    }
    await storage.saveRegionCover(taskId, cover);
    logger.debug(
      `regions: carved ${cover.regions.length} for ${shortId(taskId)} in ${Date.now() - started}ms`,
    );
    return cover;
  })();

  carvesInFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    // Cleared in `finally` so a FAILED carve does not poison the key: the next
    // caller should retry, not inherit the rejection forever.
    carvesInFlight.delete(key);
  }
}

/**
 * The commit this task's branch was cut from, as the store records it.
 *
 * `Session.git_start_sha` first: it is written once when the session is
 * created, from the same `startSha` the launcher wrote to
 * `branched_from_sha`, and it is the cut point the CURRENT session actually
 * ran from — which is what a reopened task needs, since reopen cuts a fresh
 * branch and opens a fresh session. `branched_from_sha` is the fallback for a
 * task whose session predates the field or is missing.
 *
 * REPARENT DELIBERATELY DOES NOT MOVE EITHER (it calls `updateTaskTarget` and
 * nothing else), and that is the property this relies on: `release-v022` was
 * re-parented from v021 to main, and its recorded start is still the v021 tip
 * it was really cut from. Re-pointing it at the new parent would put the
 * inherited v0.15–v0.21 commits back in the walk, which is the whole bug.
 *
 * The carve validates whatever it gets and always keeps the `^base` bound, so
 * a wrong value here degrades to the old, wider range rather than losing work.
 */
function branchStartOf(
  task: { branched_from_sha: string | null },
  session: { git_start_sha?: string } | null,
): string | null {
  return session?.git_start_sha || task.branched_from_sha || null;
}

async function headSha(cwd: string): Promise<string | null> {
  const { runGit } = await import('../utils/git');
  const result = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

export interface RegionsResult {
  taskId: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  computedAt: number;
  notes: string[];
  /** Every region in the cover, at any depth. */
  total: number;
  /** How many the depth cut left visible, before paging. */
  shown: number;
  /** The depth cut in force. */
  depth: number | 'all';
  regions: RegionSummary[];
  /**
   * The CONTENT HASH the selected region's sign-off is current against, when
   * the caller named one region.
   *
   * On a presented region this is the hash over its owned files' blob pairs —
   * the thing a stored sign-off is compared against at read time, so a
   * surface rendering the DETAIL row (which carries the raw region, not a
   * summary with `signed_off_current`) can staleness-mark it by the same
   * rule the summaries used. Absent in provenance (carve) mode, where the
   * head comparison below is the only key there is.
   */
  region_hash?: string;
  /**
   * The coarse PATH grouping — the second axis, present only in provenance
   * (carve) mode, and only when the cover is big enough for provenance alone
   * to be unreadable.
   *
   * Each area names its file count and the regions owning files in it, and is
   * selectable wherever a region id is. Sent alongside the regions rather than
   * instead of them: the reader picks the axis, the surface does not. It is an
   * AGENT-facing axis — §6.3 takes it off every human surface.
   */
  areas?: Array<{
    id: string;
    label: string;
    files: number;
    region_ids: string[];
    owner?: string;
    owner_set_by?: OverlayActor;
    signed_off_sha?: string;
    signed_off_current?: boolean;
    signed_off_by?: OverlayActor;
  }>;
  /** Units whose work survives nowhere, so they are not regions. */
  superseded?: SupersededUnit[];
  /** True when `limit` cut the list short. */
  truncated?: boolean;
  offset?: number;
  /** Present only when the caller named one region — its full file lists. */
  region?: ReviewRegion;
  /**
   * Present when the caller named a unit that COLLAPSED — it owns no file, so
   * it is not a region, but it is still named on every shared file it touched
   * and following that name has to lead somewhere. Carve mode only: an agent
   * following a carve hint's shared-file "also" list is told what became of
   * the unit, not that it does not exist. A presented region is never
   * superseded — its group is the claim itself.
   */
  superseded_unit?: SupersededUnit;
  /**
   * The first carve is still running and `regions` is empty for THAT reason —
   * not because the task has none. Ask again in a moment. Carve mode only: a
   * presentation read is a report read plus a few git calls, and never runs.
   */
  computing?: boolean;
}

/**
 * `regions` RPC — the cover as summaries, plus one region in full when asked.
 *
 * File lists are deliberately NOT in the summary rows: a 1,200-region cover
 * with every path in every row is megabytes of JSON that no surface renders
 * at once, and an agent asking `lazy_regions` wants the map before the detail.
 */
/**
 * The `regions` RPC.
 *
 * TWO SOURCES, ONE SHAPE (final-turn design §6.3). By default this reads the
 * task's PRESENTED regions — the walkthrough its final turn filed, which is
 * what every human surface navigates by. With `provenance: true` it reads the
 * git carve instead: the agent-facing hint (§6.4) that tells a present step
 * where the branch's files came from, which is the one thing the walkthrough
 * cannot say about itself. Everything agent-facing extras the carve carries —
 * `areas`, `superseded`, a `superseded_unit` answer, `computing` — is that
 * mode's alone; no human surface reads them again.
 */
export async function handleRegions(projectRoot: string, params: Record<string, unknown>) {
  if (typeof params.taskId !== 'string' || !params.taskId) {
    throw new RpcError(400, 'taskId is required');
  }
  if (params.provenance !== true) {
    return handlePresentedRegions(projectRoot, params);
  }
  const storage = await getOrCreateStorage();
  // `allowStale` comes from the SURFACE, not from here: a human who typed
  // `lazy regions` asked for the regions and can wait for a recarve; an agent
  // read tool must not cost ten seconds on somebody else's hub.
  const selectedRef = typeof params.region === 'string' && params.region.trim()
    ? params.region.trim()
    : null;
  // A caller who named a region waits for a real cover, even here: answering
  // "still computing" to "show me region X" reads as "there is no region X".
  const cover = await loadRegionCover(storage, projectRoot, params.taskId, {
    allowStale: params.allowStale === true,
    allowMissing: params.allowStale === true && !selectedRef,
  });
  const counts = countRegionChildren(cover.regions);
  // Looked up in the WHOLE cover, never in the visible slice: a caller naming
  // a region must not be told it does not exist because the depth cut hid it.
  // A named ref may resolve to a SUPERSEDED unit rather than a region. That is
  // an answer, not an error, for a LISTING: the reviewer followed an "also
  // touched by" name and deserves to be told what became of it.
  const resolved = selectedRef ? resolveRegionRef(cover, selectedRef) : null;
  const selected = resolved && 'region' in resolved ? resolved.region : null;
  const selectedSuperseded = resolved && 'superseded' in resolved ? resolved.superseded : null;

  // ONE LEVEL AT A TIME, by default. A release branch carves into hundreds of
  // units; handing all of them to a reviewer as one flat list is not a carving,
  // it is the commit log with extra steps. `depth: 'all'` is the escape hatch.
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
    regions: page.map((r) => regionSummary(r, { headSha: cover.head_sha, counts: counts.get(r.id) })),
  };
  // Whether the area axis exists at all is decided by the CARVE
  // (AREA_GROUPING_MIN_REGIONS, in computeRegionCover), not re-decided here.
  // One rule, one place: a second threshold on the read side could disagree
  // with the carve, and then `--region src/foo` resolves against a grouping
  // this surface never listed.
  if (cover.areas?.length) {
    result.areas = cover.areas.map((a) => areaSummary(a, cover.head_sha));
  }
  if (cover.superseded?.length) result.superseded = cover.superseded;
  if (cover.computing) result.computing = true;
  if (offset > 0) result.offset = offset;
  if (offset + page.length < visible.length) result.truncated = true;
  if (selected) result.region = selected;
  if (selectedSuperseded) result.superseded_unit = selectedSuperseded;
  return result;
}

/**
 * An area as a row: the path count, never the paths themselves.
 *
 * Exported for `test/unit/region-area-projections.test.ts`, which runs this and
 * `listedAreaSummary` over the same area and fails if they disagree about the
 * sign-off. The two are deliberately DIFFERENT shapes otherwise — this one
 * carries `region_ids`, the listing carries a `units` count — and that test is
 * what keeps the difference to the part that is deliberate.
 */
export function areaSummary(area: RegionArea, headSha: string) {
  return {
    id: area.id,
    label: area.label,
    files: area.files.length,
    region_ids: area.region_ids,
    ...(area.owner ? { owner: area.owner } : {}),
    ...(area.owner_set_by ? { owner_set_by: area.owner_set_by } : {}),
    // The same staleness and naming rules a region gets, from the same helper:
    // an area is the grouping a release review is divided between people along,
    // so "is this approval current" and "whose is it" matter more here than
    // anywhere, not less. `listRegions` projects an area too and spells these
    // by calling the same function — see signOffSummary for what happened when
    // the two were written out separately.
    ...signOffSummary(area, headSha),
  };
}

/**
 * How deep a listing goes when the caller does not say.
 *
 * Zero — the top-level units, and the children of whichever region the caller
 * selected. On an ordinary task that is the whole cover anyway; on a release
 * hub it is the difference between a few hundred rows and eight hundred.
 */
export const DEFAULT_REGION_DEPTH = 0;

/**
 * A non-negative integer argument, or a refusal naming what was wrong with it.
 *
 * A NUMERIC STRING is accepted — `depth` advertises `type: ['number','string']`
 * so that `"all"` can be passed, and "2" is the obvious next thing a caller
 * tries against a schema like that. Anything else THROWS rather than falling
 * back to the default: the response echoes the depth it actually used, so a
 * silently ignored `depth: "2"` came back as `"depth": 0` and read as
 * confirmation, leaving an agent to conclude the hub has no nested regions.
 * An external surface confirms its inputs or refuses them; quietly answering a
 * different question is the one option that is not allowed.
 *
 * Exported for `handlePresentedRegions`, which must validate the same
 * arguments the same way — a client cannot tell which source a regions call
 * read from, and a looser parse behind its back would be exactly the kind of
 * per-surface drift the one-parser rule exists to prevent.
 */
export function optionalNonNegativeInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric < 0) {
    throw new RpcError(
      400,
      `${name} must be a non-negative number${name === 'depth' ? ' or "all"' : ''}, got ` +
      `${JSON.stringify(value)}.`,
    );
  }
  return Math.floor(numeric);
}

/**
 * Resolve a caller's region reference, or refuse with a reason they can act on.
 *
 * An ambiguous shorthand names the candidates rather than picking one:
 * silently choosing would scope a diff to the wrong work, which is worse than
 * asking again.
 */
export function resolveRegionRef(
  cover: RegionCover,
  ref: string,
): { region: ReviewRegion } | { superseded: SupersededUnit } {
  const found = findRegion(cover, ref);
  if (!found) {
    throw new RpcError(
      404,
      `No region '${ref}' in this task's cover (${cover.regions.length} region(s)). ` +
      'List them with `lazy regions <task>`.',
    );
  }
  if ('ambiguous' in found) {
    throw new RpcError(
      400,
      `Region '${ref}' is ambiguous — it matches ${found.ambiguous.join(', ')}. Use the full id.`,
    );
  }
  return found;
}

/**
 * A caller who needs an actual region — one with files to show.
 *
 * A SUPERSEDED unit resolves (it is named on every shared file it touched, and
 * a name a reviewer is invited to follow has to lead somewhere) but it owns
 * nothing, so there is no diff to scope to it. Saying that is the whole point:
 * "no region by that name" reads as a bug in the carve and sends the reviewer
 * looking for a typo, where "it exists and every line of it was rewritten" is
 * the answer they were actually after.
 */
export function requireRegion(cover: RegionCover, ref: string): ReviewRegion {
  const found = resolveRegionRef(cover, ref);
  if ('superseded' in found) {
    throw new RpcError(
      409,
      `'${ref}' is a superseded unit — it touched ${found.superseded.touched} file(s) and no line ` +
      'of its work survives in this branch, so it owns nothing and has no diff. ' +
      'It is listed under the cover\'s superseded units, not as a region.',
    );
  }
  return found.region;
}

/**
 * WHO an overlay write is by, from the CALLING TOKEN alone.
 *
 * There is deliberately no request field for this, and no fallback: a `reviewer`
 * parameter would let any token record an approval in somebody else's name,
 * which is the one thing a sign-off may not allow. The same posture as
 * `reviewerKey` (src/review-draft.ts), which keys a reviewer's unsent words.
 *
 * A caller the daemon cannot attribute to a person — the CLI, its own review
 * page, the legacy shared token, any control-plane token — records NOTHING,
 * and the surfaces then render exactly what they rendered before this existed.
 * A single-machine install has one user and needs no name; inventing one
 * ("local", the git author) would put a name on an approval that nobody
 * actually gave.
 */
function overlayActorOf(caller: ActorIdentity): OverlayActor | undefined {
  if (caller.kind !== 'user') return undefined;
  // The token's identity, as the store names people — the same mapping
  // `pinActor` makes, so an overlay and a turn written by one caller name the
  // same person. BOTH halves come from the token, which mints with an
  // `(email, name)` pair by name (docs/design/actor-identity-and-remote-clients.md
  // §3.6): the address answers WHICH person and the display name is what a
  // surface renders beside it. Neither is ever read from the request.
  return { email: caller.email, ...(caller.name ? { name: caller.name } : {}) };
}

/** `regionOverlay` RPC — the human layer: name a region, sign one off. */
export async function handleRegionOverlay(
  projectRoot: string,
  params: Record<string, unknown>,
  caller: ActorIdentity = { kind: 'control' },
) {
  if (typeof params.taskId !== 'string' || !params.taskId) {
    throw new RpcError(400, 'taskId is required');
  }
  if (typeof params.region !== 'string' || !params.region.trim()) {
    throw new RpcError(400, 'region is required');
  }
  const storage = await getOrCreateStorage();
  // §6.3: overlays are keyed to the PRESENTED region id — the walkthrough is
  // the partition a human reviews against, so a name, an owner or a sign-off
  // made against a carve id from before this task presented has nothing to
  // land on and is simply not carried across.
  const { cover, hashes, source } = await loadPresentedRegions(storage, projectRoot, params.taskId);
  if (cover.regions.length === 0 && cover.notes.includes(NO_PRESENTATION_NOTE)) {
    throw new RpcError(404, `No presented regions for this task yet. ${NO_PRESENTATION_NOTE}`);
  }
  const region = requireRegion(cover, params.region);

  const patch: {
    name?: string;
    owner?: string | null;
    signed_off_sha?: string | null;
    actor?: OverlayActor;
  } = {};
  const actor = overlayActorOf(caller);
  if (actor) patch.actor = actor;
  if (typeof params.name === 'string') patch.name = params.name.trim().slice(0, 120);
  // An owner is a free-form actor string and nothing more — no roster to
  // validate against, no notification, no Teams identity. Empty clears it, so
  // "unassign" needs no second verb.
  if (typeof params.owner === 'string') {
    const owner = params.owner.trim().slice(0, 120);
    patch.owner = owner === '' ? null : owner;
  }
  if (params.signOff === true) {
    // REFUSED on a hub's DERIVED map, and refusing is the point. Those rows
    // are carve units with a commit range rather than a file-set claim, so
    // there is no per-region content to hash — `signed_off_sha` would be
    // stored as '', which every reader treats as "never signed off"
    // (`signOffSummary`). The RPC would answer 200 with an overlay object
    // while the approval evaporated: a human decision discarded under a
    // surface that said it was taken, which is the exact failure per-region
    // sign-off exists to prevent. Naming and owner-setting are unaffected and
    // still work here.
    if (source === 'children') {
      throw new RpcError(
        409,
        `Region '${region.id}' belongs to this task's DERIVED map — its regions are its ` +
        `children, carved from the merge history, not a walkthrough anyone wrote. There is ` +
        `no per-region content hash to approve against, so a sign-off here could not be ` +
        `recorded or checked. Sign off on the child task itself, or have this task file a ` +
        `walkthrough (\`lazy_report\` with a \`presentation\`) and sign off on its groups. ` +
        `Setting a name or an owner works either way.`,
      );
    }
    // A sign-off is recorded against the CONTENT it approved, never blanket
    // (§6.1). A presented region is hashed over its OWNED files' blob pairs,
    // so a later commit that touched a DIFFERENT region leaves this approval
    // current, and one that touched its own files — including deleting them —
    // stales it. The carve keyed this to the head, which staled every region
    // on every commit anywhere and made sign-off nearly useless on a hub;
    // read time recomputes the same hash and compares.
    patch.signed_off_sha = hashes.get(region.id) ?? '';
  } else if (params.signOff === false) {
    patch.signed_off_sha = null;
  }
  // The ACTOR is not a thing to set — it is who is setting, and a patch
  // carrying it alone still changes nothing. Counting it would have turned
  // "nothing to set" into a silent no-op write for exactly the callers whose
  // identity we now record.
  if (patch.name === undefined && patch.owner === undefined && patch.signed_off_sha === undefined) {
    throw new RpcError(400, 'Nothing to set: pass a name, an owner, or sign off.');
  }

  const overlay = await storage.setRegionOverlay(cover.task_id, region.id, patch);
  return {
    taskId: shortId(cover.task_id),
    region: region.id,
    overlay,
  };
}

/**
 * Per-line unit attribution for the files a Changes view is rendering.
 *
 * SINGLE-CLAIMANT FILES COST NOTHING. Their every changed line belongs to the
 * one unit that touched them — that is what the partition established — so the
 * owner comes straight off the cover with no git at all, and only the
 * multi-claimant files are blamed. That is also why the gutter's default is
 * what it is: the files that need a blame are exactly the files whose lines
 * differ in owner.
 *
 * Computed ON DEMAND, never stored in the cover: a per-line map is the one
 * structure here whose size is proportional to LINES rather than files, and a
 * release cover is already the largest record lazy writes.
 */
export async function fileLineAttribution(
  storage: Storage,
  projectRoot: string,
  taskRefInput: string,
  paths: readonly string[],
): Promise<Map<string, FileLineAttribution>> {
  const out = new Map<string, FileLineAttribution>();
  if (paths.length === 0) return out;

  const cover = await loadRegionCover(storage, projectRoot, taskRefInput, {
    allowStale: true,
    allowMissing: true,
  });
  if (cover.computing || cover.regions.length === 0) return out;

  const topLevel = cover.regions.filter((r) => r.depth === 0 && r.parent_id === null);
  const labelOf = new Map(topLevel.map((r) => [r.id, {
    region: r.id,
    ...(r.task_code ? { code: r.task_code } : {}),
    title: r.name ?? r.title,
  }]));

  const wanted = new Set(paths);
  const ownerOfPath = new Map<string, string>();
  const multi = new Set<string>();
  for (const region of topLevel) {
    for (const p of region.files) if (wanted.has(p)) ownerOfPath.set(p, region.id);
    for (const shared of region.shared_files) if (wanted.has(shared.path)) multi.add(shared.path);
  }

  for (const path of wanted) {
    const owner = ownerOfPath.get(path);
    if (!owner || multi.has(path)) continue;
    const label = labelOf.get(owner);
    if (label) out.set(path, { path, multi: false, runs: [], owner: label });
  }
  if (multi.size === 0) return out;

  const ctx = await resolveTaskDiffContext(storage, projectRoot, taskRefInput);
  const head = await headSha(ctx.worktreePath);
  if (!head || !cover.base_sha) return out;
  const shaToRegion = await coverShaToRegionMap(
    ctx.worktreePath,
    topLevel,
    cover.base_sha,
    head,
  );

  for (const path of multi) {
    const runs: LineAttributionRun[] = [];
    for (const run of await blameLineRuns(ctx.worktreePath, head, path)) {
      const regionId = shaToRegion.get(run.sha);
      const label = regionId ? labelOf.get(regionId) : undefined;
      // A line from outside the carved range — inherited history, or an
      // upstream sync — belongs to no unit of this review. Left unlabelled
      // rather than guessed at: an attribution nobody can act on is worse than
      // a gap the reviewer can see is a gap.
      if (!label) continue;
      const last = runs[runs.length - 1];
      if (last && last.region === label.region && last.end + 1 === run.start) {
        last.end = run.end;
      } else {
        runs.push({ start: run.start, end: run.end, ...label });
      }
    }
    out.set(path, { path, multi: true, runs });
  }
  return out;
}
