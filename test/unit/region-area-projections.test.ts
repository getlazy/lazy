/**
 * The ONE area projection that survives — `areaSummary`, the provenance-mode
 * (carve) row — and the sign-off half of it.
 *
 * An area reaches the wire one way now. `reviewRegions` used to send a second,
 * slimmer projection (`listedAreaSummary`); final-turn design §6.3 takes the
 * area axis off every human surface, that RPC now reads the task's DECLARED
 * regions, and the carve — with its areas — is the agent-facing authoring
 * hint alone. One caller, one projection.
 *
 * The sign-off fields stay load-bearing all the same: an agent reading the
 * carve hint once saw an area listed with its owner and no sign-off at all,
 * so every area looked as though nobody had ever signed it off. Invisible on
 * a read, and destructive on a write: a caller comparing "the approval I was
 * shown" against a permanently absent one can neither withdraw one nor be
 * stopped from silently overwriting somebody else's. `signOffSummary` is the
 * one place that half is spelled; this file pins it.
 */

import { describe, test, expect } from 'bun:test';
import { areaSummary } from '../../src/daemon/regions-service';
import type { OverlayActor, RegionArea } from '../../src/regions';

const HEAD = 'head4567890abcdef';
const REN: OverlayActor = { email: 'ren@example.com', name: 'Ren' };
const ADA: OverlayActor = { email: 'ada@example.com', name: 'Ada' };

function area(over: Partial<RegionArea> = {}): RegionArea {
  return {
    id: 'area:src/regions',
    label: 'src/regions',
    files: ['src/regions/view.ts', 'src/regions/areas.ts'],
    region_ids: ['task:add-parser', 'task:tidy-docs'],
    ...over,
  } as RegionArea;
}

/** The fields that say whether an approval stands, and whose it is. */
const SIGN_OFF_FIELDS = ['signed_off_sha', 'signed_off_current', 'signed_off_by'] as const;

function signOffOf(row: Record<string, unknown>) {
  return Object.fromEntries(
    SIGN_OFF_FIELDS.filter((f) => f in row).map((f) => [f, row[f]]),
  );
}

describe('an area projection carries its sign-off', () => {
  // INVARIANT: an area signed off is shown signed off, by the person who did
  // it, stale or not — never as though nobody had approved it.
  test.each([
    ['signed off, current', { signed_off_sha: HEAD, signed_off_by: REN }],
    ['signed off, stale', { signed_off_sha: 'older123456', signed_off_by: ADA }],
    ['signed off by nobody the daemon could name', { signed_off_sha: HEAD }],
    ['never signed off', {}],
    ['owned but not signed off', { owner: 'ada', owner_set_by: ADA }],
  ])('%s', (_name, over) => {
    const row = areaSummary(area(over as Partial<RegionArea>), HEAD) as Record<string, unknown>;

    // `in`, not a bare read: the table's cases are a union of object
    // literals, and a bare `over.signed_off_sha` reaches the members that
    // lack the key — which is exactly the 'never signed off' case.
    const signed = 'signed_off_sha' in over;
    if (signed) {
      expect(row.signed_off_sha).toBe(over.signed_off_sha);
      expect(row.signed_off_current).toBe(over.signed_off_sha === HEAD);
      expect(row.signed_off_by).toEqual('signed_off_by' in over ? over.signed_off_by : undefined);
    } else {
      for (const field of SIGN_OFF_FIELDS) expect(field in row).toBe(false);
    }
    // And an owned-but-unsigned area is not EMPTIED of its overlay half —
    // only the sign-off half goes. Who owns it is a separate approval-axis
    // fact the row must still carry.
    if ('owner' in over) {
      expect(row.owner).toBe(over.owner);
      expect(row.owner_set_by).toEqual(over.owner_set_by);
    }
  });

  // INVARIANT: an area with no sign-off is exactly the object it always was —
  // no empty keys appearing on the wire for every unsigned area.
  test('an area nobody signed off carries no sign-off keys at all', () => {
    const row = areaSummary(area(), HEAD) as Record<string, unknown>;

    for (const field of SIGN_OFF_FIELDS) expect(field in row).toBe(false);
  });

  // The carve is what the flat-cover callers read, so pin its actual values
  // rather than only its agreement with a second projection that no longer
  // exists — one projection wrong in the dark is how the last one stayed wrong.
  test('the projection stays the slim carve shape', () => {
    const row = areaSummary(area(), HEAD) as Record<string, unknown>;

    expect(row.id).toBe('area:src/regions');
    expect(row.label).toBe('src/regions');
    expect(row.files).toBe(2);
    // `region_ids` — the carve's units — is what makes this the FULL shape the
    // provenance reader needs; the web's slim `units` count died with the
    // surface that read it.
    expect(row.region_ids).toEqual(['task:add-parser', 'task:tidy-docs']);
    expect('units' in row).toBe(false);
  });
});
