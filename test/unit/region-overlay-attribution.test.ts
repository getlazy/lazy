/**
 * WHO set a region's owner, and WHO signed it off.
 *
 * A sign-off is a claim that a person looked at a slice of a change and is
 * content with it. Stored without a name it reads as "somebody checked this",
 * which on a review several people share is worse than no approval at all —
 * nobody can tell who to ask. These tests pin the three halves of the answer:
 * the record keeps attribution PER FIELD, the store never leaves a name
 * standing over somebody else's later edit, and an unattributable write (the
 * single-machine case, and every overlay written before this existed) records
 * nothing rather than inventing an identity.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage/file-storage';
import { applyRegionOverlays, overlayActorName, regionSummary } from '../../src/regions/view';
import type { RegionCover, ReviewRegion } from '../../src/regions/types';

const KIM = { email: 'kim@example.com', name: 'Kim' };
const ADA = { email: 'ada@example.com', name: 'Ada' };

describe('region overlay attribution — the stored record', () => {
  let root: string;
  let storage: FileStorage;
  let taskId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lazy-region-overlay-actor-'));
    const base = join(root, 'store');
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${base}"\n`,
    );
    storage = new FileStorage(root, { basePath: base });
    await storage.initialize();
    taskId = (await storage.createTask('a task with regions')).id;
  });

  afterEach(async () => {
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('a sign-off and an owner each record the person who made them', async () => {
    await storage.setRegionOverlay(taskId, 'task:one', { owner: 'ierceg', actor: KIM });
    const overlay = await storage.setRegionOverlay(taskId, 'task:one', {
      signed_off_sha: 'abc1234',
      actor: ADA,
    });

    expect(overlay.owner_set_by).toEqual(KIM);
    expect(overlay.signed_off_by).toEqual(ADA);
  });

  // INVARIANT: attribution is per FIELD, not per record. Naming a region is a
  // cosmetic edit anyone may make; if it re-stamped the whole overlay, the
  // person who renamed it would appear to have signed it off, which is the
  // failure the names exist to prevent.
  test('renaming a region leaves the sign-off\'s and the owner\'s names alone', async () => {
    await storage.setRegionOverlay(taskId, 'task:one', {
      owner: 'ierceg',
      signed_off_sha: 'abc1234',
      actor: ADA,
    });

    const renamed = await storage.setRegionOverlay(taskId, 'task:one', {
      name: 'The parser slab',
      actor: KIM,
    });

    expect(renamed.name).toBe('The parser slab');
    expect(renamed.owner_set_by).toEqual(ADA);
    expect(renamed.signed_off_by).toEqual(ADA);
  });

  // INVARIANT: whoever is named must be whoever made the value standing there
  // now. An unattributable write REPLACES the name with nothing rather than
  // leaving the previous person's, or a single-machine `lazy regions --owner`
  // would silently re-attribute a Teams reviewer's assignment to themselves.
  test('an unattributed write clears the previous name instead of inheriting it', async () => {
    await storage.setRegionOverlay(taskId, 'task:one', { owner: 'ierceg', actor: ADA });

    const local = await storage.setRegionOverlay(taskId, 'task:one', { owner: 'someone-else' });

    expect(local.owner).toBe('someone-else');
    expect(local.owner_set_by).toBeUndefined();
  });

  test('withdrawing a sign-off takes the name with it, and clearing an owner takes theirs', async () => {
    await storage.setRegionOverlay(taskId, 'task:one', {
      owner: 'ierceg',
      signed_off_sha: 'abc1234',
      actor: ADA,
    });

    const unsigned = await storage.setRegionOverlay(taskId, 'task:one', {
      signed_off_sha: null,
      actor: KIM,
    });
    expect(unsigned.signed_off_sha).toBeUndefined();
    expect(unsigned.signed_off_by).toBeUndefined();

    const unassigned = await storage.setRegionOverlay(taskId, 'task:one', {
      owner: null,
      actor: KIM,
    });
    expect(unassigned.owner).toBeUndefined();
    expect(unassigned.owner_set_by).toBeUndefined();
  });
});

describe('region overlay attribution — what the surfaces get', () => {
  const region = (): ReviewRegion => ({
    id: 'task:one',
    unit: 'task',
    parent_id: null,
    depth: 0,
    title: 'Do the thing',
    from: 'base',
    to: 'head1234',
    provenance: 'accept-tag',
    files: ['src/one.ts'],
    shared_files: [],
    commit_count: 1,
    authors: ['Ada'],
    expansion_reasons: [],
  });

  const cover = (): RegionCover => ({
    version: 2,
    task_id: 't1',
    base_ref: 'main',
    base_sha: 'base',
    head_sha: 'head1234',
    computed_at: Date.now(),
    regions: [region()],
    areas: [{ id: 'area:src', label: 'src', files: ['src/one.ts'], region_ids: ['task:one'] }],
    notes: [],
  });

  test('the overlay merge carries both names onto regions and onto areas', () => {
    const merged = applyRegionOverlays(cover(), [
      {
        unit_id: 'task:one',
        owner: 'ierceg',
        owner_set_by: KIM,
        signed_off_sha: 'head1234',
        signed_off_at: Date.now(),
        signed_off_by: ADA,
        updated_at: Date.now(),
      },
      {
        unit_id: 'area:src',
        owner: 'ierceg',
        owner_set_by: KIM,
        signed_off_sha: 'head1234',
        signed_off_at: Date.now(),
        signed_off_by: ADA,
        updated_at: Date.now(),
      },
    ]);

    expect(merged.regions[0]!.owner_set_by).toEqual(KIM);
    expect(merged.regions[0]!.signed_off_by).toEqual(ADA);
    expect(merged.areas![0]!.owner_set_by).toEqual(KIM);
    expect(merged.areas![0]!.signed_off_by).toEqual(ADA);
  });

  test('the summary row every surface renders carries the names, and the staleness rule is unchanged', () => {
    const signed = { ...region(), signed_off_sha: 'head1234', signed_off_by: ADA, owner: 'ierceg', owner_set_by: KIM };

    const current = regionSummary(signed, { headSha: 'head1234' });
    expect(current.signed_off_current).toBe(true);
    expect(current.signed_off_by).toEqual(ADA);
    expect(current.owner_set_by).toEqual(KIM);

    // A stale sign-off still reads as stale — naming the person does not make
    // an approval current, and the same head comparison decides it.
    const moved = regionSummary(signed, { headSha: 'head5678' });
    expect(moved.signed_off_current).toBe(false);
    expect(moved.signed_off_by).toEqual(ADA);
  });

  // INVARIANT: an overlay written before attribution existed renders exactly as
  // it did then. No actor, and none invented — a placeholder name on an
  // approval is a claim nobody made.
  test('an overlay with no actor produces no name anywhere', () => {
    const summary = regionSummary(
      { ...region(), owner: 'ierceg', signed_off_sha: 'head1234' },
      { headSha: 'head1234' },
    );

    expect(summary.owner).toBe('ierceg');
    expect(summary.owner_set_by).toBeUndefined();
    expect(summary.signed_off_by).toBeUndefined();
    expect(overlayActorName(undefined)).toBeNull();
  });

  test('a person is named by their name, falling back to their email', () => {
    expect(overlayActorName(ADA)).toBe('Ada');
    expect(overlayActorName({ email: 'ada@example.com' })).toBe('ada@example.com');
    expect(overlayActorName({ email: 'ada@example.com', name: '   ' })).toBe('ada@example.com');
  });
});
