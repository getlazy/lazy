/**
 * The second axis: grouping a big review by PATH AREA.
 *
 * Provenance answers "who wrote this". On an ordinary task that is the only
 * axis anyone needs. On a release hub it produces a few hundred accurate,
 * unusable rows — and worse, rows that are just the child tasks restated, which
 * were each already reviewed at their own accept. What the reviewer of a
 * release is actually asking is "what parts of the system moved", and that is a
 * question about paths.
 *
 * Areas partition the review's files on their own axis, so the two groupings
 * never have to agree about anything except the file set.
 */

import type { RegionArea, ReviewRegion } from './types';

/**
 * Directories that are a repo's SOURCE ROOT rather than a part of the system.
 *
 * The rule is "the first path segment", with one exception: a first segment
 * that only says "this is code" tells the reviewer nothing, because every file
 * is under it. `src/` alone would be a single area holding the whole review.
 * For those, the area is the first TWO segments — `src/regions`, `test/unit` —
 * which on a real tree is the subsystem.
 *
 * Deliberately a short fixed list rather than a heuristic ("a directory holding
 * more than N% of the review"): a grouping whose meaning shifts with the
 * contents of the diff cannot be compared between two reviews, and a reviewer
 * cannot learn it.
 */
const SOURCE_ROOTS = new Set(['src', 'lib', 'app', 'apps', 'packages', 'test', 'tests']);

/** Files at the repo root, which have no directory to be grouped by. */
export const ROOT_AREA_LABEL = '(root)';

/** The area label for one path. Pure, deterministic, no repo access. */
export function areaOf(path: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length <= 1) return ROOT_AREA_LABEL;
  const first = segments[0]!;
  if (SOURCE_ROOTS.has(first) && segments.length > 2) return `${first}/${segments[1]}`;
  return first;
}

/**
 * How many top-level regions a cover needs before the area axis is worth
 * showing.
 *
 * Below it, provenance IS the readable grouping and a second list of the same
 * files under different headings is noise. Eight is the point at which the
 * provenance list stops fitting in one glance; it is not tuned against
 * anything, and the surfaces say which axis they are showing either way.
 */
export const AREA_GROUPING_MIN_REGIONS = 8;

/**
 * Group a partitioned cover's top-level regions by path area.
 *
 * Takes the regions AFTER partitioning, so every file appears once and an
 * area's file count is a real count rather than a sum of overlaps. Areas are
 * ordered largest first, and so are the regions named inside each.
 */
export function computeAreas(topLevel: readonly ReviewRegion[]): RegionArea[] {
  const files = new Map<string, string[]>();
  const regionFiles = new Map<string, Map<string, number>>();

  for (const region of topLevel) {
    for (const path of region.files) {
      const label = areaOf(path);
      const list = files.get(label);
      if (list) list.push(path);
      else files.set(label, [path]);
      let counts = regionFiles.get(label);
      if (!counts) {
        counts = new Map();
        regionFiles.set(label, counts);
      }
      counts.set(region.id, (counts.get(region.id) ?? 0) + 1);
    }
  }

  const areas: RegionArea[] = [];
  for (const [label, paths] of files) {
    const counts = regionFiles.get(label) ?? new Map<string, number>();
    areas.push({
      id: `area:${label}`,
      label,
      files: [...paths].sort(),
      region_ids: [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([id]) => id),
    });
  }
  // Largest first, ties by label so the order is stable across recarves.
  areas.sort((a, b) => b.files.length - a.files.length || a.label.localeCompare(b.label));
  return areas;
}

/**
 * An area rendered as a region, so every surface that can scope to a region can
 * scope to an area with no second code path.
 *
 * It is NOT a member of the cover's `regions` — putting it there would break
 * the partition invariant, since an area's files are the same files the
 * provenance regions already own, counted along the other axis.
 */
export function areaAsRegion(area: RegionArea): ReviewRegion {
  return {
    id: area.id,
    unit: 'area',
    parent_id: null,
    depth: 0,
    title: area.label,
    from: '',
    to: '',
    provenance: 'area',
    files: area.files,
    shared_files: [],
    commit_count: 0,
    authors: [],
    expansion_reasons: [],
    ...(area.name ? { name: area.name } : {}),
    ...(area.owner ? { owner: area.owner } : {}),
    ...(area.owner_set_by ? { owner_set_by: area.owner_set_by } : {}),
    ...(area.signed_off_sha ? { signed_off_sha: area.signed_off_sha } : {}),
    ...(area.signed_off_at ? { signed_off_at: area.signed_off_at } : {}),
    ...(area.signed_off_by ? { signed_off_by: area.signed_off_by } : {}),
  };
}
