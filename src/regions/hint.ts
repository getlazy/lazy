import { areaOf } from './areas';
import type { RegionCover, ReviewRegion } from './types';

/**
 * How many top-level units the hint names before it collapses the rest into a
 * count. The hint is an ORIENTATION, not a second rendering of the whole
 * cover — the agent's own `lazy_regions` read is the full list — and eight is
 * the point past which a bullet list stops being scannable inside a prompt.
 */
const HINT_ROWS = 8;

/** How many distinct area labels one row may name before it collapses to a count. */
const HINT_AREAS_PER_ROW = 2;

/** Truncate a unit title to keep one row a one-glance line. */
function titleOf(region: ReviewRegion): string {
  const title = region.title.trim();
  if (!title) return '';
  return title.length > 60 ? `${title.slice(0, 59)}…` : title;
}

/**
 * The provenance hint the presentation prompt carries (final-turn design
 * §6.4): where this branch's files came from, carved from git alone, delivered
 * as a PROMPT SECTION the agent reads before it decides its presentation
 * groups.
 *
 * Deliberately NOT the full cover. The agent-facing carve (via `lazy_regions`)
 * already renders every unit with its attribution; this section exists so the
 * agent does not have to KNOW to ask — so it names only the units big enough
 * to shape a walkthrough: the task's top-level units, largest first, as
 * "N files in these areas — <id> (<what it was>)". Group the diff by what
 * moved in the system, the hint says; never by which task moved it.
 *
 * Returns '' when there is nothing to orient by — a cover that could not be
 * computed at all ("unresolved") or one with no surviving units — so the
 * prompt's section collapses to its standing prose, which already says the
 * hint is advisory and may be absent. WHY it is absent is the agent's own
 * `lazy_regions` read to learn (which renders a failed carve's reason); the
 * hint repeating it would spend prompt on a dead end.
 */
export function renderProvenanceHint(cover: RegionCover): string {
  if (cover.unresolved) return '';
  const top = cover.regions.filter((r) => r.depth === 0);
  if (top.length === 0) return '';

  const byFiles = [...top].sort(
    (a, b) => b.files.length - a.files.length || a.id.localeCompare(b.id),
  );
  const shown = byFiles.slice(0, HINT_ROWS);
  const rows = shown.map((r) => {
    const areas = [...new Set(r.files.map((f) => areaOf(f)))];
    const areaLabel =
      areas.length === 0
        ? '(no files)'
        : areas.length <= 2
          ? areas.join(', ')
          : `${areas.slice(0, 2).join(', ')} +${areas.length - 2} more`;
    const what = titleOf(r);
    return `- ${r.files.length} file${r.files.length === 1 ? '' : 's'} in ${areaLabel} — \`${r.id}\`${what ? ` (${what})` : ''}`;
  });
  const rest = byFiles.slice(HINT_ROWS);
  if (rest.length > 0) {
    const restFiles = rest.reduce((n, r) => n + r.files.length, 0);
    rows.push(`- … ${rest.length} more unit${rest.length === 1 ? '' : 's'}, ${restFiles} file${restFiles === 1 ? '' : 's'} total — run \`lazy_regions\` for the whole carve`);
  }
  return rows.join('\n');
}