/**
 * Regression tests for the resume-pick half of `fix-builder-resume-stale-pick`.
 *
 * THE INCIDENT: one session existed in six isolation dirs. The COMPLETE transcript
 * (3555 lines) lived in a dir that had SEEDED it and then let Claude append two
 * hours of conversation to that seeded copy. Nothing ever reclassified a
 * seeded-then-grown copy, so it stayed in the `seededOnly` list. Meanwhile a copy
 * frozen two hours earlier was the only entry in the `usable` list — and merely
 * MOUNTING it bumped its mtime, making the stale copy look freshest. Resume mounted
 * it, and two hours of conversation silently disappeared from the builder.
 *
 * THE INVARIANTS THIS FILE PINS:
 *
 *   1. Length, not recency, measures history. Session JSONLs are append-only, so a
 *      copy's SIZE is evidence and its mtime is not — mounting a file bumps mtime
 *      without adding a byte. A stale container-written copy must never beat a
 *      longer one just by being touched later.
 *   2. A seeded copy that GREW past its recorded seed-time size was appended to by
 *      Claude inside the container. It is therefore container-written after all:
 *      resumable AND write-trusted, despite its seeded label.
 *   3. Seeding never clobbers a grown copy. It is that line's own live history.
 *   4. Ungrown seeded copies stay unresumable without `--import`. The adoption gate
 *      is deliberate (see builder-projects-adoption.test.ts) and none of the above
 *      may weaken it.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile, readFile, utimes, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import {
  builderProjectsRoot,
  resolveBuilderProjectsDir,
  classifyResumeSession,
  isTrustedResumeProjectsDir,
} from '../../src/builder/projects-isolation';

const SESSION = '28b7199b-84d0-4802-961d-e3859217c8ab';

/** A short transcript, and a longer one that EXTENDS it byte-for-byte. */
const SHORT = 'turn-1\nturn-2\n';
const LONG = SHORT + 'turn-3\nturn-4\nturn-5\n';
/** Longer than SHORT, but NOT an extension of it — a genuinely divergent line. */
const DIVERGENT = 'other-1\nother-2\nother-3\nother-4\n';

describe('builder resume picks the copy with the most history', () => {
  let dataDir: string;
  let homeDir: string;
  const lazyRoot = '/repo/stale-pick';
  const encoded = encodeProjectPath(lazyRoot);

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lazy-stalepick-'));
    homeDir = mkdtempSync(join(tmpdir(), 'lazy-stalepick-home-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  function dirOf(id: string): string {
    return join(builderProjectsRoot(dataDir), id);
  }

  /** Write `<root>/<id>/<encoded>/<session>.jsonl` with a chosen mtime. */
  async function writeSession(id: string, content: string, mtimeMs?: number): Promise<string> {
    const dir = join(dirOf(id), encoded);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${SESSION}.jsonl`);
    await writeFile(file, content);
    if (mtimeMs !== undefined) await utimes(file, new Date(mtimeMs), new Date(mtimeMs));
    return file;
  }

  /** Write a dir's `.lazy-seeded.json`. Omit `stats` to simulate a pre-v2 manifest. */
  async function writeManifest(
    id: string,
    manifest: {
      seededSessionIds?: string[];
      adoptedSessionIds?: string[];
      seededFileStats?: Record<string, { size: number; mtimeMs: number }>;
    },
  ): Promise<void> {
    await mkdir(dirOf(id), { recursive: true });
    await writeFile(join(dirOf(id), '.lazy-seeded.json'), JSON.stringify(manifest, null, 2) + '\n');
  }

  const resolve = (resumeId: string | null = SESSION) =>
    resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId, homeDirAbs: homeDir });

  test('a seeded copy Claude appended to beats a stale container-written copy that was merely touched', async () => {
    // The incident, minimized. `stale` holds the frozen container-written copy and
    // has the NEWEST mtime (mounting it bumped the file without adding content).
    // `grown` holds the seeded-then-appended full transcript, with an older mtime.
    await writeSession('stale', SHORT, 3_000_000);
    await writeManifest('stale', { seededSessionIds: [], adoptedSessionIds: [] });

    await writeSession('grown', LONG, 1_000_000);
    await writeManifest('grown', {
      seededSessionIds: [SESSION],
      adoptedSessionIds: [],
      seededFileStats: { [SESSION]: { size: SHORT.length, mtimeMs: 500_000 } },
    });

    const picked = await resolve();
    expect(picked?.hostDir).toBe(dirOf('grown'));
    // INVARIANT: growth IS container-write evidence — only Claude, inside the
    // container, can have added those bytes to a host-seeded copy. So the dir earns
    // the write-trust fast path just as a rank-2 dir does.
    expect(picked?.holdsResumeSession).toBe(true);
    expect(
      await isTrustedResumeProjectsDir({ hostDir: dirOf('grown'), lazyRoot, resumeId: SESSION }),
    ).toBe(true);
  });

  test('a grown seeded copy classifies as isolated, not needs-import', async () => {
    await writeSession('grown', LONG, 1_000_000);
    await writeManifest('grown', {
      seededSessionIds: [SESSION],
      seededFileStats: { [SESSION]: { size: SHORT.length, mtimeMs: 500_000 } },
    });

    expect(await classifyResumeSession({ dataDirAbs: dataDir, lazyRoot, resumeId: SESSION, homeDirAbs: homeDir }))
      .toBe('isolated');
  });

  test('a pre-v2 manifest still promotes a longer seeded copy that EXTENDS the usable one', async () => {
    // No seededFileStats, so growth is undecidable — the byte-prefix proof is the
    // only evidence available, and it is enough to resume from (but not to trust).
    await writeSession('stale', SHORT, 3_000_000);
    await writeManifest('stale', { seededSessionIds: [] });

    await writeSession('grown', LONG, 1_000_000);
    await writeManifest('grown', { seededSessionIds: [SESSION] });

    const picked = await resolve();
    expect(picked?.hostDir).toBe(dirOf('grown'));
    // INVARIANT: promotion by prefix does NOT confer write trust. A host re-seed
    // extends a copy too, so this is not proof the CONTAINER can write here — and
    // write trust is what lets a failing write-probe be overridden. Probe-gate it.
    expect(picked?.holdsResumeSession).toBe(false);
  });

  test('a longer seeded copy that DIVERGES does not displace the usable pick', async () => {
    await writeSession('written', SHORT, 3_000_000);
    await writeManifest('written', { seededSessionIds: [] });

    await writeSession('divergent', DIVERGENT, 1_000_000);
    await writeManifest('divergent', { seededSessionIds: [SESSION] });
    expect(DIVERGENT.length).toBeGreaterThan(SHORT.length);

    // Not an extension ⇒ not the same conversation carried further. Keep the
    // container-written pick and warn rather than guess.
    const picked = await resolve();
    expect(picked?.hostDir).toBe(dirOf('written'));
  });

  test('an ungrown seeded copy is still not resumable without --import', async () => {
    // INVARIANT: the adoption gate stands. Growth and prefix promotion only rescue
    // copies with positive evidence; a plain seeded snapshot has none.
    await writeSession('seeded-only', SHORT, 3_000_000);
    await writeManifest('seeded-only', {
      seededSessionIds: [SESSION],
      seededFileStats: { [SESSION]: { size: SHORT.length, mtimeMs: 3_000_000 } },
    });

    expect(await resolve()).toBeNull();
    expect(await classifyResumeSession({ dataDirAbs: dataDir, lazyRoot, resumeId: SESSION, homeDirAbs: homeDir }))
      .toBe('needs-import');
  });

  test('seeding never overwrites a grown copy with a shorter one', async () => {
    // INVARIANT: a seeded copy that grew is this line's own live history. Seeding
    // refreshes stale seeded copies, but must leave a grown one alone even when the
    // source's mtime is newer — otherwise resuming here silently truncates the run.
    const grownFile = await writeSession('grown', LONG, 1_000_000);
    await writeManifest('grown', {
      seededSessionIds: [SESSION],
      seededFileStats: { [SESSION]: { size: SHORT.length, mtimeMs: 500_000 } },
    });
    // A shorter copy elsewhere, with a much NEWER mtime — the shape that used to win.
    await writeSession('stale', SHORT, 9_000_000);
    await writeManifest('stale', { seededSessionIds: [] });

    await resolve(); // runs seedProjectsDirFromHistory into the resolved dir
    expect(await readFile(grownFile, 'utf-8')).toBe(LONG);
  });

  test('seeding a fresh dir records each copy\'s seed-time size, so later growth is detectable', async () => {
    await writeSession('origin', SHORT, 1_000_000);
    await writeManifest('origin', { seededSessionIds: [] });

    // A plain `lazy builder` run: fresh dir, seeded from history.
    const fresh = await resolve(null);
    expect(fresh).not.toBeNull();
    const manifest = JSON.parse(await readFile(join(fresh!.hostDir, '.lazy-seeded.json'), 'utf-8'));
    expect(manifest.seededSessionIds).toContain(SESSION);
    const seededFile = join(fresh!.hostDir, encoded, `${SESSION}.jsonl`);
    expect(manifest.seededFileStats?.[SESSION]?.size).toBe((await stat(seededFile)).size);

    // Now Claude appends to the seeded copy inside the container — the exact move
    // that used to leave the copy permanently misclassified as a stale snapshot.
    await writeFile(seededFile, LONG);
    expect(
      await isTrustedResumeProjectsDir({ hostDir: fresh!.hostDir, lazyRoot, resumeId: SESSION }),
    ).toBe(true);
    expect((await resolve())?.hostDir).toBe(fresh!.hostDir);
  });
});
