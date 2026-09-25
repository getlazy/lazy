/**
 * Reading a stored cover: overlay merge, lookup, and the one summary shape
 * every surface renders.
 *
 * CLI, MCP and the web page all answer "what are this task's regions" from
 * here so they cannot disagree about what a region is called or how big it is.
 */

import { areaAsRegion } from './areas';
import type {
  OverlayActor,
  RegionArea,
  RegionCover,
  RegionOverlay,
  ReviewRegion,
  SupersededUnit,
} from './types';
import type { PresentationTier } from '../types';

/**
 * How a person is NAMED on a surface — their display name, falling back to
 * their email.
 *
 * One helper so the CLI, the web page and Teams cannot end up rendering the
 * same sign-off as three different people. Returns null when there is no
 * actor, which is how an overlay written before attribution existed keeps
 * rendering exactly as it always did: no name, and none invented.
 */
export function overlayActorName(actor: OverlayActor | undefined): string | null {
  if (!actor) return null;
  return actor.name?.trim() || actor.email || null;
}

/**
 * The three fields a sign-off puts on the wire — all present together or none
 * of them, which is why they have a name rather than being three optionals a
 * projection remembers to spell.
 */
export interface SignOffSummary {
  signed_off_sha?: string;
  signed_off_current?: boolean;
  signed_off_by?: OverlayActor;
}

/**
 * The sign-off half of a row, for EVERY projection that puts a row on the wire.
 *
 * One function because a sign-off is one concept with three parts that only
 * mean anything together: which commit it was given against, whether the branch
 * has moved past it, and whose approval it is. Spelled out per projection, they
 * drift a field at a time and nothing fails — `listRegions` projected an area
 * with none of them while `areaSummary` projected all three, so a surface
 * reading the flat cover saw every area as never signed off. That is invisible
 * on a read and destructive on a write: a caller comparing "the approval I was
 * shown" against a permanently absent one can neither withdraw nor be stopped
 * from overwriting somebody.
 *
 * Emits nothing at all when the row carries no sign-off, so a row without one
 * is exactly the object it has always been.
 */
export function signOffSummary(
  row: { signed_off_sha?: string; signed_off_by?: OverlayActor },
  headSha: string | undefined,
): SignOffSummary {
  if (!row.signed_off_sha) return {};
  return {
    signed_off_sha: row.signed_off_sha,
    // A sign-off the branch has moved past is stale rather than approval: a row
    // still reading "signed off" over code nobody has looked at is the failure
    // a per-region sign-off exists to prevent. Decided HERE, once, so no
    // surface can answer it differently.
    signed_off_current: !!headSha && row.signed_off_sha === headSha,
    // And the naming rule with it — on a review several people share, an
    // approval with nobody's name on it reads as "somebody checked this".
    ...(row.signed_off_by ? { signed_off_by: row.signed_off_by } : {}),
  };
}

/**
 * An area by its `area:<label>` id or by its bare label.
 *
 * The bare label is accepted because `lazy diff <task> --region src/regions`
 * is what a reviewer types; the prefixed form is what the surfaces print.
 */
export function findArea(cover: RegionCover, ref: string): RegionArea | null {
  const needle = ref.trim();
  if (!needle) return null;
  const bare = needle.startsWith('area:') ? needle.slice('area:'.length) : needle;
  return cover.areas?.find((a) => a.label === bare) ?? null;
}

/**
 * Merge the human overlay into a computed cover.
 *
 * Keyed on the unit id, which is why a refresh appends rather than re-slices:
 * a reviewer's name and sign-off hang on a task/chunk/commit id, not on a
 * generated partition number that would shift under them.
 */
export function applyRegionOverlays(
  cover: RegionCover,
  overlays: RegionOverlay[],
): RegionCover {
  if (overlays.length === 0) return cover;
  const byId = new Map(overlays.map((o) => [o.unit_id, o]));
  return {
    ...cover,
    // Areas take the same overlay merge as regions: they are the grouping a
    // release review is divided between people along, and their ids are derived
    // from the path, so they are as stable a key as a unit id.
    ...(cover.areas
      ? {
        areas: cover.areas.map((area) => {
          const overlay = byId.get(area.id);
          if (!overlay) return area;
          return {
            ...area,
            ...(overlay.name ? { name: overlay.name } : {}),
            ...(overlay.owner ? { owner: overlay.owner } : {}),
            ...(overlay.owner_set_by ? { owner_set_by: overlay.owner_set_by } : {}),
            ...(overlay.signed_off_sha ? { signed_off_sha: overlay.signed_off_sha } : {}),
            ...(overlay.signed_off_at ? { signed_off_at: overlay.signed_off_at } : {}),
            ...(overlay.signed_off_by ? { signed_off_by: overlay.signed_off_by } : {}),
          };
        }),
      }
      : {}),
    regions: cover.regions.map((region) => {
      const overlay = byId.get(region.id);
      if (!overlay) return region;
      return {
        ...region,
        ...(overlay.name ? { name: overlay.name } : {}),
        ...(overlay.owner ? { owner: overlay.owner } : {}),
        ...(overlay.owner_set_by ? { owner_set_by: overlay.owner_set_by } : {}),
        ...(overlay.signed_off_sha ? { signed_off_sha: overlay.signed_off_sha } : {}),
        ...(overlay.signed_off_at ? { signed_off_at: overlay.signed_off_at } : {}),
        ...(overlay.signed_off_by ? { signed_off_by: overlay.signed_off_by } : {}),
      };
    }),
  };
}

/**
 * Find a region by id, or by a unique unambiguous suffix.
 *
 * A reviewer types `fix-timings-hotspots`, not `task:fix-timings-hotspots`.
 * An ambiguous shorthand is refused by name rather than silently resolved to
 * the first match — picking one would scope a diff to the wrong work.
 *
 * A PRESENTATION row carries an agent-authored slug with no carve-style
 * prefix, so the suffix and task-code rules never match one; it resolves by
 * exact id, or by its human label (an overlay name, else the group title)
 * when that is unique. A label is matched case-insensitively because it is
 * prose a reviewer copied off the list, not an id they typed from memory.
 */
export type RegionLookup =
  | { region: ReviewRegion }
  | { superseded: SupersededUnit }
  | { ambiguous: string[] }
  | null;

export function findRegion(cover: RegionCover, ref: string): RegionLookup {
  const needle = ref.trim();
  if (!needle) return null;
  const exact = cover.regions.find((r) => r.id === needle);
  if (exact) return { region: exact };
  // An AREA is selectable exactly where a region is — that is the whole point
  // of the second axis — so it resolves here rather than in each surface.
  // Matched before the suffix rules below so an area label can never be
  // mistaken for a shorthand of a provenance region.
  //
  // Only a CARVED cover can fire this. The presented cover omits `areas`
  // entirely (regions-presentation.ts — the agent's groups are the only
  // human-surface axis), `cover.areas?.` nulls, and resolveRegionRef refuses
  // the ref with a 404; `lazy diff --region` and `?region=` resolve against
  // that presented cover for the same reason. A provenance carve carries
  // areas again, which is the only remaining way in.
  const area = findArea(cover, needle);
  if (area) return { region: areaAsRegion(area) };
  const matches = cover.regions.filter(
    (r) =>
      r.id.endsWith(`:${needle}`) ||
      r.task_code === needle ||
      r.id.startsWith(`commit:${needle}`) ||
      (r.unit === 'presentation' &&
        (r.name ?? r.title).toLowerCase() === needle.toLowerCase()),
  );
  if (matches.length === 1) return { region: matches[0]! };
  if (matches.length > 1) return { ambiguous: matches.map((r) => r.id) };
  // A SUPERSEDED unit is not a region and must still RESOLVE.
  //
  // Every shared file names the other units that touched it, and those names
  // are what a reviewer follows to find out who else has fingerprints on the
  // code. A unit that owns nothing is dropped from `regions` — so following
  // its name landed on "no region by that name", which reads as a bug in the
  // carve and sends the reviewer hunting for a typo they did not make. On a
  // release-sized review that is the common case, not an edge one: 332 units
  // collapse on `main..lazy/release-v022`.
  //
  // The information was never lost — the unit is in `cover.superseded` — so
  // this is the resolution catching up with the attribution. Deliberately LAST,
  // so a live region always wins a name they could share.
  const gone = (cover.superseded ?? []).find(
    (u) => u.id === needle || u.task_code === needle || u.id.endsWith(`:${needle}`),
  );
  if (gone) return { superseded: gone };
  return null;
}

/** The row every surface renders — one region, without its file lists. */
export interface RegionSummary {
  id: string;
  unit: ReviewRegion['unit'];
  parent_id: string | null;
  depth: number;
  /**
   * For a `presentation` region: the walkthrough group's tier, for renderers
   * that order rows display-first (docs above core). Absent on a carved row.
   */
  tier?: PresentationTier;
  /** The reviewer's name for it when there is one, else the derived title. */
  label: string;
  /**
   * One line about the region, from the walkthrough that declared it — its
   * summary, or on the residual row what the walkthrough did not name and any
   * cap it was refused for. Absent on a carved row.
   */
  note?: string;
  /** Files this region OWNS. Across one level these sum to the review's own. */
  files: number;
  /** Of those, how many other units also touched — attribution, not membership. */
  shared: number;
  provenance: ReviewRegion['provenance'];
  expanded: boolean;
  expansion_reasons: string[];
  /** Regions directly inside this one — what expanding it would show. */
  children: number;
  /** Every region inside it, at any depth. */
  descendants: number;
  task_code?: string;
  authors: string[];
  actors?: string[];
  agents?: string[];
  models?: string[];
  /** The reviewer this region is someone's to read. Overlay only, no workflow. */
  owner?: string;
  /**
   * Who assigned that owner — the person, as the daemon derived them from the
   * token that made the write. Absent when the write could not be attributed
   * (the CLI, a control-plane token) and on every overlay written before
   * attribution existed; a surface renders the owner alone then, exactly as
   * before, and never invents a name.
   */
  owner_set_by?: OverlayActor;
  signed_off_sha?: string;
  /**
   * Who signed off. An approval with nobody's name on it reads as "somebody
   * checked this", which on a review several people share is worse than no
   * approval — so when the daemon can name them, every surface does.
   */
  signed_off_by?: OverlayActor;
  /**
   * Whether the sign-off still refers to the code on show.
   *
   * Computed here rather than per surface so CLI, web and MCP cannot disagree
   * about whether an approval is current. A sign-off is stored against the head
   * it was given at precisely so this comparison is possible; without it, a
   * region signed off three turns ago still reads as approved, and the natural
   * reading of that row — "someone looked at this" — sends a reviewer past code
   * nobody has seen. Absent when there is no sign-off at all.
   */
  signed_off_current?: boolean;
}

/** Direct-child and descendant counts for every region in a cover. */
export function countRegionChildren(regions: readonly ReviewRegion[]): Map<string, { children: number; descendants: number }> {
  const counts = new Map<string, { children: number; descendants: number }>();
  for (const r of regions) counts.set(r.id, { children: 0, descendants: 0 });
  const byId = new Map(regions.map((r) => [r.id, r]));
  for (const r of regions) {
    const direct = r.parent_id ? counts.get(r.parent_id) : undefined;
    if (direct) direct.children += 1;
    // Walk up to the root so a grandchild counts for every ancestor. Guarded
    // against a cycle, which a corrupted stored cover could contain.
    let cursor = r.parent_id;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const entry = counts.get(cursor);
      if (entry) entry.descendants += 1;
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
  }
  return counts;
}

/**
 * How much of a region's note a LIST row shows.
 *
 * Long enough that the residual row's two system sentences — the uncovered
 * count and the cap line — are never clipped (a unit test pins that), short
 * enough that a group summary written as the prompts ask for it, a paragraph
 * or two, cannot turn the scannable first cut on a large branch into a wall
 * of prose.
 */
const MAX_NOTE_LINE = 240;

/**
 * A region note as a LIST ROW shows it: its first non-empty line, clipped.
 *
 * One helper for the web strip and `lazy regions`, because two surfaces
 * truncating the same field differently is the same row reading two ways.
 * The full text stays where the group itself is rendered — the Changes
 * block — which is where a reviewer went to read it.
 */
export function regionNoteLine(note: string | undefined): string | undefined {
  if (!note) return undefined;
  const firstLine = note.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return undefined;
  return firstLine.length > MAX_NOTE_LINE
    ? `${firstLine.slice(0, MAX_NOTE_LINE - 1).trimEnd()}…`
    : firstLine;
}

export function regionSummary(
  region: ReviewRegion,
  opts: { headSha?: string; counts?: { children: number; descendants: number } } = {},
): RegionSummary {
  const counts = opts.counts ?? { children: 0, descendants: 0 };
  return {
    id: region.id,
    unit: region.unit,
    parent_id: region.parent_id,
    depth: region.depth,
    label: region.name ?? region.title,
    ...(region.note ? { note: region.note } : {}),
    files: region.files.length,
    shared: region.shared_files.length,
    provenance: region.provenance,
    ...(region.tier ? { tier: region.tier } : {}),
    expanded: region.expansion_reasons.length > 0,
    expansion_reasons: region.expansion_reasons,
    children: counts.children,
    descendants: counts.descendants,
    ...(region.task_code ? { task_code: region.task_code } : {}),
    authors: region.authors,
    ...(region.actors ? { actors: region.actors } : {}),
    ...(region.agents ? { agents: region.agents } : {}),
    ...(region.models ? { models: region.models } : {}),
    ...(region.owner ? { owner: region.owner } : {}),
    ...(region.owner_set_by ? { owner_set_by: region.owner_set_by } : {}),
    ...signOffSummary(region, opts.headSha),
  };
}

/**
 * Order a cover most-impactful first, WITHOUT breaking the hierarchy.
 *
 * Impact is the number of files the region touches. Not added/removed lines:
 * a 4,000-line generated file and a 40-line behaviour change would then trade
 * places, and "how much of the tree does this reach" is the question a
 * reviewer deciding what to open first is actually asking.
 *
 * The sort is applied WITHIN each sibling group and the result re-emitted
 * depth-first, so a region is still immediately followed by the regions it
 * expands into. A flat sort over the whole cover would put the biggest child
 * above its own parent and scatter every family — which is exactly the failure
 * the first version of the strip had, for the opposite reason.
 *
 * Ties break on id so the order is stable across recarves; a reviewer's place
 * in the list must not move because two regions happen to touch four files.
 */
export function sortRegionsByImpact(regions: readonly ReviewRegion[]): ReviewRegion[] {
  const childrenOf = new Map<string | null, ReviewRegion[]>();
  for (const r of regions) {
    const key = r.parent_id;
    const list = childrenOf.get(key);
    if (list) list.push(r);
    else childrenOf.set(key, [r]);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => b.files.length - a.files.length || a.id.localeCompare(b.id));
  }

  const out: ReviewRegion[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null): void => {
    for (const r of childrenOf.get(parentId) ?? []) {
      // Guard against a cycle in a corrupted stored cover: emit once, never
      // recurse into a region already placed.
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      walk(r.id);
    }
  };
  walk(null);

  // Anything whose parent is missing from this cover (a partial or corrupted
  // record) still has to appear — dropping regions silently is the one outcome
  // worse than an odd order.
  for (const r of regions) {
    if (!seen.has(r.id)) out.push(r);
  }
  return out;
}

/**
 * The regions a surface should SHOW: the top `maxDepth` levels, plus the
 * ancestors and direct children of the selected region.
 *
 * This is the fix for a carved review being unreviewable. The cover of a
 * release branch is a tree of several hundred units; flattening it into one
 * list and handing that to a reviewer is not a carving, it is the commit log
 * with extra steps. The tree is computed once and rendered a level at a time —
 * "expanding a hub yields its children" (§1.5.1), which is what the hierarchy
 * was for.
 *
 * Ancestors are included so a selected region is never an orphan row with no
 * visible context, and its direct children so the reviewer can keep going
 * without knowing an id in advance.
 */
export function visibleRegions(
  regions: readonly ReviewRegion[],
  opts: { maxDepth: number | 'all'; selected?: string | null },
): ReviewRegion[] {
  if (opts.maxDepth === 'all') return [...regions];
  const byId = new Map(regions.map((r) => [r.id, r]));
  const keep = new Set<string>();
  for (const r of regions) {
    if (r.depth <= opts.maxDepth) keep.add(r.id);
  }
  const selected = opts.selected ? byId.get(opts.selected) : undefined;
  if (selected) {
    keep.add(selected.id);
    let cursor = selected.parent_id;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      keep.add(cursor);
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
    for (const r of regions) {
      if (r.parent_id === selected.id) keep.add(r.id);
    }
  }
  // Cover order is depth-first, so filtering preserves the hierarchy.
  return regions.filter((r) => keep.has(r.id));
}
