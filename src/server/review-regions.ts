/**
 * The regions surface: a TAB of its own, and a card on Changes.
 *
 * Regions are the map and Changes is the territory, so the map gets its own
 * page — third in the strip, ahead of Changes. It began as a filter bar
 * squeezed above the diff, which put the map after the territory and buried
 * the one view that makes a large branch navigable.
 *
 * Two renderers, one list:
 *
 *  - {@link regionsTabHtml} — the full list, on the Regions tab. Every row
 *    links into `changes?region=<id>`, so picking a region is still a FILTER
 *    on the diff rather than a separate rendering of it. Unselected regions
 *    collapse under "Other regions" rather than disappearing — raw detail one
 *    click away, the same rule the rest of the review surface follows.
 *  - {@link regionsCardHtml} — a compact pointer on Changes: how many regions,
 *    the largest few by name, and the way to the tab. Deliberately NOT the
 *    list again; that would be the same information twice and push the diff
 *    further down. With a region selected it inverts and names the filter in
 *    force, because a scoped diff that does not say it is scoped lies about
 *    how big the change is.
 */

import {
  overlayActorName,
  regionNoteLine,
  type OverlayActor,
  type RegionSummary,
} from '../regions';
import { TIER_DISPLAY_RANK } from '../storage/presentation';
import { escapeHtml } from './review-diff';

/**
 * "signed off @abc1234 by Kim", stale-marked, or nameless when the write could
 * not be attributed — the same sentence the CLI prints, so two people reading
 * the same sign-off on two surfaces read the same words.
 */
function signOffText(r: Pick<RegionSummary, 'signed_off_sha' | 'signed_off_current' | 'signed_off_by'>): string | null {
  if (!r.signed_off_sha) return null;
  const who = overlayActorName(r.signed_off_by);
  // Content-keyed, not head-keyed (§6.1): what the approval was given against
  // is this region's own files, so only their change makes it stale — and the
  // words must say that, not "the branch moved", which on a hub is nearly
  // always somebody ELSE's commit.
  return `signed off @${r.signed_off_sha.slice(0, 8)}${who ? ` by ${who}` : ''}` +
    (r.signed_off_current ? '' : ' — STALE, the region\'s content has changed');
}

/** "owner ierceg (set by Kim)" — the label, and who put it there when known. */
function ownerText(owner: string, setBy: OverlayActor | undefined): string {
  const who = overlayActorName(setBy);
  return `owner ${owner}${who ? ` (set by ${who})` : ''}`;
}

/** What `ReviewActions.listRegions` hands back — everything a surface may show. */
export interface RegionCoverPayload {
  regions: RegionSummary[];
  notes: string[];
}

/**
 * Turn a cover into the task page's `regions` extras — the ONE place that
 * decides which of the cover's parts a surface is given.
 *
 * Both routes that render regions (the Regions tab and the Changes embed) go
 * through this. They used to spell the object out themselves, and each listed
 * `rows/active/notes` only, so a field added to the payload had to be
 * remembered at every call site. A field in the payload now reaches every
 * surface or none, rather than whichever call site someone remembered.
 */
export function regionExtras(
  cover: RegionCoverPayload,
  active: string | null,
): {
  rows: RegionSummary[];
  active: string | null;
  notes: string[];
} {
  return {
    rows: cover.regions,
    active,
    notes: cover.notes,
  };
}

/** How many regions are shown before the rest fold into "Other regions". */
const STRIP_VISIBLE = 12;

export interface RegionsStripOptions {
  taskId: string;
  regions: RegionSummary[];
  /** The `?region=` value in force, or null for the unfiltered view. */
  active: string | null;
  /** Notes the read wants said out loud (no walkthrough yet, and the like). */
  notes: string[];
  /**
   * Render even a single region.
   *
   * The Changes tab suppresses a one-region strip — a filter offering the
   * reviewer their only choice is noise. The Regions TAB does not: a reader
   * who clicked "Regions" asked to see them, and an empty page in answer to a
   * direct question is worse than a list of one.
   */
  forceRender?: boolean;
}

/**
 * The renderer options for a task page's `regions` extras.
 *
 * Same reason as {@link regionExtras}: every surface that draws regions builds
 * its options here, so a part of the cover cannot reach one renderer and not
 * another because a call site spelled four of six fields out by hand.
 */
export function regionsStripOptions(
  taskId: string,
  extras: {
    rows?: RegionSummary[];
    active?: string | null;
    notes?: string[];
  } | undefined,
): RegionsStripOptions {
  return {
    taskId,
    regions: extras?.rows ?? [],
    active: extras?.active ?? null,
    notes: extras?.notes ?? [],
  };
}

/**
 * What an EMPTY cover renders, which is not always nothing.
 *
 * Two different states arrive here looking identical — zero regions — and the
 * difference matters to whoever is reading:
 *
 *  - no walkthrough has been filed yet — no human-facing park has run the
 *    step — and its `notes` say so (render the note: "no regions yet, the
 *    next park files them" is a different and honest answer, where silence
 *    reads as a bug);
 *  - the task genuinely has nothing to partition (render nothing — the
 *    Changes tab then looks exactly as it did before regions existed).
 */
function emptyCoverHtml(opts: RegionsStripOptions): string {
  if (opts.notes.length === 0) return '';
  return (
    `<section class="rv-regions-card">` +
    `<strong>No review regions.</strong> ` +
    `<span class="rv-hint">${escapeHtml(collapseNotes(opts.notes).join(' '))}</span>` +
    `</section>`
  );
}

/**
 * The strip rows in review DISPLAY order, not the cover's data order.
 *
 * INVARIANT: the whole review page reads docs/maintained above code
 * (`sortPresentationGroupsForDisplay`, `report-policy`) — and the strip is
 * part of that page, rendered BEFORE the presented blocks. A strip in the
 * agent's declared order and blocks in display order would be two renderings
 * of the same groups disagreeing on one page, and a reviewer's top-down read
 * would meet the code group first. Ties and carved rows (which have no tier)
 * keep the cover's own order, stable, so a carve's depth-first shape — a
 * region followed by the regions it expands into — survives untouched.
 */
export function sortStripRows(rows: readonly RegionSummary[]): RegionSummary[] {
  return rows
    .map((r, index) => ({ r, index }))
    .sort((a, b) => {
      const rank = (x: RegionSummary) => (x.tier !== undefined ? TIER_DISPLAY_RANK[x.tier] : 99);
      const rankDiff = rank(a.r) - rank(b.r);
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map(({ r }) => r);
}

/**
 * Render the strip, or nothing at all.
 *
 * Nothing when there are fewer than two regions: a task with one commit has a
 * cover of one region, and a filter offering the reviewer their only choice is
 * noise. The Changes tab then looks exactly as it did before regions existed.
 */
export function regionsStripHtml(opts: RegionsStripOptions): string {
  const { taskId, active } = opts;

  // ONE LEVEL AT A TIME. The cover of a release branch is a tree of several
  // hundred units, and a flat list of all of them is not a carved review —
  // it is the commit log with extra steps. The strip shows the top level plus
  // the ancestors and children of whatever is selected, so clicking a region
  // both scopes the diff AND opens the level below it. "Expanding a hub yields
  // its children" (spec §1.5.1) is what the hierarchy was for.
  const regions = sortStripRows(visibleStripRows(opts.regions, active));
  if (regions.length < (opts.forceRender ? 1 : 2)) return '';

  // Within the level the cover's own depth-first order is preserved — a region
  // immediately followed by the regions it expands into. Sorting by size here
  // scattered every child away from its parent, which is exactly the structure
  // the strip exists to show.
  //
  // The fold is then a prefix of that order, widened when it has to be so the
  // selected region is never the one hidden.
  const selectedAt = active ? regions.findIndex((r) => r.id === active) : -1;
  const cut = Math.max(STRIP_VISIBLE, selectedAt + 1);
  const shown = regions.slice(0, cut);
  const hidden = regions.slice(cut);

  const rows = shown.map((r) => regionRowHtml(taskId, r, r.id === active)).join('');
  const hiddenRows = hidden.map((r) => regionRowHtml(taskId, r, false)).join('');

  const notes = opts.notes.length
    ? `<p class="rv-hint">${escapeHtml(collapseNotes(opts.notes).join(' '))}</p>`
    : '';

  const deeper = opts.regions.length - regions.length;

  return (
    `<section class="rv-regions" id="rv-regions">` +
    `<div class="rv-regions-head">` +
    `<strong>${regions.length} review region${regions.length === 1 ? '' : 's'}</strong>` +
    (deeper > 0 ? ` <span class="rv-hint">(+${deeper} nested inside them)</span>` : '') +
    (active
      ? ` — showing <code>${escapeHtml(active)}</code> · ` +
        `<a href="${escapeHtml(changesHref(taskId, null))}">show all</a>`
      : ' — pick one to scope the diff below') +
    `</div>` +
    `<ul class="rv-regions-list">${rows}</ul>` +
    (hiddenRows
      ? `<details class="rv-regions-more">` +
        `<summary>Other regions (${hidden.length})</summary>` +
        `<ul class="rv-regions-list">${hiddenRows}</ul>` +
        `</details>`
      : '') +
    notes +
    `</section>`
  );
}

/**
 * The rows one level of the tree shows: every top-level region, plus the
 * ancestors and direct children of the selected one.
 *
 * Ancestors so a selected region is never an orphan row with no context, and
 * children so clicking a hub is how you get into it.
 */
export function visibleStripRows(
  regions: readonly RegionSummary[],
  active: string | null,
): RegionSummary[] {
  const byId = new Map(regions.map((r) => [r.id, r]));
  const keep = new Set<string>();
  for (const r of regions) if (r.depth === 0) keep.add(r.id);
  const selected = active ? byId.get(active) : undefined;
  if (selected) {
    keep.add(selected.id);
    let cursor = selected.parent_id;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      keep.add(cursor);
      cursor = byId.get(cursor)?.parent_id ?? null;
    }
    for (const r of regions) if (r.parent_id === selected.id) keep.add(r.id);
  }
  return regions.filter((r) => keep.has(r.id));
}

function regionRowHtml(taskId: string, r: RegionSummary, isActive: boolean): string {
  const indent = Math.min(r.depth, 4);
  const noteLine = regionNoteLine(r.note);
  const who = [r.actors?.join('/'), r.models?.join('/')].filter(Boolean).join(' ')
    || r.authors.join(', ');
  const meta = [
    `${r.files} file${r.files === 1 ? '' : 's'}`,
    r.shared > 0 ? `${r.shared} also touched by others` : null,
    r.owner ? ownerText(r.owner, r.owner_set_by) : null,
    r.unit,
    who || null,
    // A sign-off the branch has moved past is marked stale rather than shown
    // as approval: a row reading "signed off" over code nobody has looked at
    // is the one failure a per-region sign-off exists to prevent. It also names
    // who signed, when the daemon knew them.
    signOffText(r),
    r.descendants > 0
      ? `${r.descendants} inside${isActive ? '' : ' — open to see them'}`
      : null,
  ].filter(Boolean).join(' · ');

  return (
    `<li class="rv-region${isActive ? ' rv-region-active' : ''}` +
    `${r.signed_off_sha && !r.signed_off_current ? ' rv-region-stale' : ''}"` +
    ` style="--rv-region-depth:${indent}">` +
    `<a href="${escapeHtml(changesHref(taskId, isActive ? null : r.id))}" class="rv-region-link">` +
    `<span class="rv-region-label">${escapeHtml(r.label)}</span>` +
    `<code class="rv-region-id">${escapeHtml(r.id)}</code>` +
    `</a>` +
    `<span class="rv-region-meta">${escapeHtml(meta)}</span>` +
    // The walkthrough's line about this region. On "Other changes" it is how
    // many changed files it did not name — and, when one was recorded, the
    // cap that forced it: a reviewer must be able to see "the walkthrough hit
    // the cap" without reading the agent's turn.
    //
    // Clipped to one line by the SAME helper `lazy regions` uses: a group
    // summary is a paragraph or two by design, and the strip's whole job is
    // to be scannable. The full text is on the group itself, in Changes.
    (noteLine ? `<p class="rv-hint rv-region-note">${escapeHtml(noteLine)}</p>` : '') +
    `</li>`
  );
}

/** The Changes-tab URL for a region filter, or for the unfiltered view. */
export function changesHref(taskId: string, region: string | null): string {
  // taskId is the ESCAPED path segment (taskPathSegment) — interpolate raw;
  // the region id is a raw value and is escaped once.
  const base = `/tasks/${taskId}/changes`;
  return region ? `${base}?region=${encodeURIComponent(region)}` : base;
}

/**
 * Collapse the carving's repeated "no surviving branch" notes into a count.
 *
 * On a large release those repeat once per deleted branch. The reviewer needs
 * to know it happened and how often, not to read it three hundred times.
 */
export function collapseNotes(notes: string[]): string[] {
  const missing = notes.filter((n) => n.startsWith('No surviving branch for'));
  const rest = notes.filter((n) => !n.startsWith('No surviving branch for'));
  if (missing.length <= 2) return [...rest, ...missing];
  return [
    ...rest,
    `${missing.length} units had no surviving branch and stayed commit-level regions.`,
  ];
}

/** The Regions tab's own URL, where the full list lives. */
export function regionsTabHref(taskId: string): string {
  // taskId is the ESCAPED path segment (taskPathSegment) — interpolate raw.
  return `/tasks/${taskId}/regions`;
}

/**
 * The Regions TAB: the full list, as the page's own content.
 *
 * The strip this reuses was designed as a filter bar squeezed above a diff;
 * given a tab of its own it is simply the list, so the body is the strip plus
 * a heading that says what a region is. Keeping one renderer means the tab and
 * the (now much smaller) Changes card can never disagree about a region's size
 * or its ownership split.
 */
export function regionsTabHtml(opts: RegionsStripOptions): string {
  const { regions } = opts;
  if (regions.length === 0) {
    // A reader who clicked "Regions" asked a direct question, so the answer is
    // never a blank page.
    const empty = emptyCoverHtml(opts);
    return empty ? `<h2>Review regions</h2>${empty}` : '';
  }
  const intro =
    `<p class="rv-hint">Each region is a group the task declared — the ` +
    `walkthrough it filed the last time it parked for you, in the order it meant you to ` +
    `review by. Picking one scopes the ` +
    `<a href="/tasks/${escapeHtml(opts.taskId)}/changes">Changes</a> tab to it. ` +
    `Regions are a <strong>partition</strong>: every file belongs to exactly one group, ` +
    `the one that claimed it whole, so the counts below add up to the size of the ` +
    `change. A file other groups quote as a snippet says so, and names them.</p>`;
  return `<h2>Review regions</h2>${intro}` +
    regionsStripHtml({ ...opts, forceRender: true });
}

/**
 * The compact card the CHANGES tab shows instead of the whole list.
 *
 * Regions earned their own tab, so repeating the full list above every diff
 * would be the same information twice and push the actual changes further
 * down. What stays here is the part a reviewer needs *while looking at the
 * diff*: how many units are in front of them, the largest few by name, and a
 * way through to the tab. Deliberately NOT a set of per-region filter links —
 * that is the tab's job.
 *
 * When a region IS selected the card inverts: it names the filter in force and
 * offers the way out, because a scoped diff that does not say it is scoped is
 * a diff that silently lies about how big the change is.
 */
export function regionsCardHtml(opts: RegionsStripOptions): string {
  const { taskId, active } = opts;
  const regions = sortStripRows(opts.regions);
  if (regions.length === 0) return emptyCoverHtml(opts);

  const tab = regionsTabHref(taskId);

  if (active) {
    // The banner inverts to name the filter in force, because a scoped diff
    // that does not say it is scoped is a diff that silently lies about how
    // big the change is. Region ids are the only filter values now (§6.3 —
    // the walkthrough is the partition a human navigates), so the lookup
    // cannot miss: a `?region=` naming nothing renders as the raw id with no
    // invented counts around it.
    const selected = regions.find((r) => r.id === active);
    const label = selected?.label ?? active;
    const files = selected?.files;
    const owner = selected?.owner;
    const ownerSetBy = selected?.owner_set_by;
    const size = files === undefined
      ? ''
      : ` — ${files} file${files === 1 ? '' : 's'}` +
        (owner ? `, ${ownerText(owner, ownerSetBy)}` : '');
    // WHAT A SCOPED DIFF ACTUALLY SHOWS. Scoping is by FILE against the task's
    // whole range, not by the region's own commits, so on a file two units
    // both touched the diff below includes the other unit's edits as well.
    // That is deliberate — a hunk shown without the surrounding cumulative
    // state is a diff that does not apply — but a reviewer reading one region
    // and attributing everything in it to that region gets the attribution
    // wrong, and no surface said so. The file is still this region's alone to
    // review: ownership is a partition, and the other units are named on it.
    const shared = selected && selected.shared > 0
      ? ` <span class="rv-hint">${selected.shared} of these files ` +
        `${selected.shared === 1 ? 'was' : 'were'} also touched by other units, so the diff for ` +
        `${selected.shared === 1 ? 'it' : 'them'} includes those units' edits too.</span>`
      : '';
    return (
      `<section class="rv-regions-card rv-regions-card-active">` +
      `<strong>Showing one region:</strong> ${escapeHtml(label)}${escapeHtml(size)}` +
      ` · <a href="${escapeHtml(changesHref(taskId, null))}">show all changes</a>` +
      ` · <a href="${escapeHtml(tab)}">all ${regions.length} regions</a>` +
      shared +
      `</section>`
    );
  }

  // Already sorted most-impactful first by the daemon, so "the top three" is a
  // slice rather than a second opinion about what impact means.
  const top = regions.filter((r) => r.depth === 0).slice(0, 3);
  const names = top
    .map((r) => `${escapeHtml(truncateLabel(r.label))} <span class="rv-region-id">(${r.files})</span>`)
    .join(', ');

  return (
    `<section class="rv-regions-card">` +
    `<strong>${regions.length} review region${regions.length === 1 ? '' : 's'}</strong>` +
    (names ? ` — largest: ${names}` : '') +
    ` · <a href="${escapeHtml(tab)}">open Regions</a> to scope this diff to one` +
    `</section>`
  );
}

/**
 * Keep the card to one line with three names on it.
 *
 * Real region labels are task GOALS, which run to a sentence — three of those
 * unabbreviated is a paragraph above the diff, which is the thing this card
 * exists to avoid.
 */
function truncateLabel(s: string): string {
  return s.length > 44 ? `${s.slice(0, 43)}…` : s;
}
