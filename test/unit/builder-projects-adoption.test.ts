/**
 * Unit tests for EXPLICIT adoption of a resume target — `lazy builder --import`.
 *
 * THE RULE: a session with NO container-written copy in any overlay has never run
 * under lazy's builder isolation. Resuming it means picking an overlay and making
 * it authoritative for that session — an ADOPTION, not a resume. That used to
 * happen silently (mint a dir, seed the session in, mount it). Now it must be
 * opted into: resolution returns null by default, `lazy builder` turns that into
 * an actionable error, and `--import` performs the same overlay selection +
 * seeding deliberately.
 *
 * INVARIANT: adoption changes only INTENT, never write TRUST. An adopted copy is
 * still host-written, so isTrustedResumeProjectsDir stays false for it and the
 * docker write-probe still gates the mount. The seeded-copy safety this builds on
 * is covered in builder-projects-isolation-trust.test.ts.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import {
  builderProjectsRoot,
  resolveBuilderProjectsDir,
  resolveBuilderProjectsDirForLaunch,
  isTrustedResumeProjectsDir,
  classifyResumeSession,
} from '../../src/builder/projects-isolation';

describe('builder resume adoption (--import)', () => {
  let dataDir: string;
  let homeDir: string;
  const lazyRoot = '/repo/some-project';
  const encoded = encodeProjectPath(lazyRoot);

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lazy-projadopt-'));
    homeDir = mkdtempSync(join(tmpdir(), 'lazy-projadopt-home-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  const hostDirOf = (id: string) => join(builderProjectsRoot(dataDir), id);

  async function seedSession(id: string, sessionId: string, body = '{}\n'): Promise<void> {
    const dir = join(builderProjectsRoot(dataDir), id, encoded);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sessionId}.jsonl`), body);
  }

  async function writeManifest(id: string, seededSessionIds: string[]): Promise<void> {
    const dir = join(builderProjectsRoot(dataDir), id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.lazy-seeded.json'), JSON.stringify({ seededSessionIds }) + '\n');
  }

  /** Claude wrote the session here: present + manifest omits it. */
  async function seedContainerWritten(id: string, sessionId: string): Promise<void> {
    await seedSession(id, sessionId);
    await writeManifest(id, []);
  }

  /** Only a host-seeded copy here: present + manifest lists it. */
  async function seedCopyOnly(id: string, sessionId: string, body?: string): Promise<void> {
    await seedSession(id, sessionId, body);
    await writeManifest(id, [sessionId]);
  }

  async function seedSharedSession(sessionId: string, body = '{}\n'): Promise<void> {
    const dir = join(homeDir, '.claude', 'projects', encoded);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sessionId}.jsonl`), body);
  }

  async function readManifestIds(hostDir: string): Promise<{ seeded: string[]; adopted: string[] }> {
    const raw = JSON.parse(await readFile(join(hostDir, '.lazy-seeded.json'), 'utf-8'));
    return { seeded: raw.seededSessionIds ?? [], adopted: raw.adoptedSessionIds ?? [] };
  }

  // ── case 1: container-written somewhere → resumes silently ────────────────────
  test('a container-written copy anywhere resumes without --import (no error path)', async () => {
    await seedContainerWritten('aaaa1111', 'sess-S');
    await seedCopyOnly('bbbb2222', 'sess-S'); // a seeded copy elsewhere is irrelevant

    expect(await classifyResumeSession({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-S', homeDirAbs: homeDir }))
      .toBe('isolated');
    const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-S', homeDirAbs: homeDir });
    expect(res!.id).toBe('aaaa1111');
    expect(res!.holdsResumeSession).toBe(true);
  });

  test('a legacy (pre-manifest) dir holding the session also resumes without --import', async () => {
    // Provenance is unknown, not provably host-seeded — it may well be a container
    // write from before the manifest existed. Erroring here would break resumes
    // that work today, so legacy dirs stay resumable (and stay probe-gated).
    await seedSession('legacy00', 'sess-L');

    expect(await classifyResumeSession({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-L', homeDirAbs: homeDir }))
      .toBe('isolated');
  });

  // ── case 2: seeded-only / shared-only → needs import ──────────────────────────
  test('a seeded-only copy is needs-import and does NOT resolve without --import', async () => {
    await seedCopyOnly('bbbb2222', 'sess-S');

    expect(await classifyResumeSession({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-S', homeDirAbs: homeDir }))
      .toBe('needs-import');
    expect(await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-S', homeDirAbs: homeDir }))
      .toBeNull();
    expect(await resolveBuilderProjectsDirForLaunch({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-S', homeDirAbs: homeDir }))
      .toBeUndefined();
  });

  test('a session living only in the shared host dir is needs-import', async () => {
    await seedSharedSession('sess-shared');

    expect(await classifyResumeSession({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-shared', homeDirAbs: homeDir }))
      .toBe('needs-import');
    expect(await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-shared', homeDirAbs: homeDir }))
      .toBeNull();
  });

  test('an id that exists nowhere is unknown, not needs-import (no misleading --import advice)', async () => {
    expect(await classifyResumeSession({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-bogus', homeDirAbs: homeDir }))
      .toBe('unknown');
    expect(await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-bogus', homeDirAbs: homeDir, adopt: true }))
      .toBeNull();
  });

  test('classifyResumeSession creates nothing (a bare classification is side-effect free)', async () => {
    await seedSharedSession('sess-shared');
    await classifyResumeSession({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-shared', homeDirAbs: homeDir });
    // No isolation root minted by classification alone.
    expect(await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-shared', homeDirAbs: homeDir }))
      .toBeNull();
  });

  // ── case 3: --import adopts and mounts ────────────────────────────────────────
  test('--import adopts a seeded-only copy in place: same dir, mounted, still untrusted', async () => {
    await seedCopyOnly('bbbb2222', 'sess-S', '{"line":"seeded"}\n');

    const res = await resolveBuilderProjectsDir({
      dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-S', homeDirAbs: homeDir, adopt: true,
    });
    // Same overlay selection the pre-gate silent path produced.
    expect(res!.id).toBe('bbbb2222');
    expect(res!.hostDir).toBe(hostDirOf('bbbb2222'));
    // Adoption is intent, not write evidence — trust semantics are unchanged.
    expect(res!.holdsResumeSession).toBe(false);
    expect(await isTrustedResumeProjectsDir({ hostDir: res!.hostDir, lazyRoot, resumeId: 'sess-S' })).toBe(false);

    const ids = await readManifestIds(res!.hostDir);
    expect(ids.seeded).toContain('sess-S');
    expect(ids.adopted).toEqual(['sess-S']);
  });

  test('--import mints a dir for a shared-only session and seeds it in', async () => {
    await seedSharedSession('sess-shared', '{"line":"from-shared"}\n');

    const res = await resolveBuilderProjectsDir({
      dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-shared', homeDirAbs: homeDir, adopt: true,
    });
    expect(res).not.toBeNull();
    // The session was copied into the minted dir, so Claude can resume it there.
    expect(await readFile(join(res!.hostDir, encoded, 'sess-shared.jsonl'), 'utf-8')).toBe('{"line":"from-shared"}\n');
    expect(await isTrustedResumeProjectsDir({ hostDir: res!.hostDir, lazyRoot, resumeId: 'sess-shared' })).toBe(false);
    expect((await readManifestIds(res!.hostDir)).adopted).toEqual(['sess-shared']);
  });

  test('after adoption, a plain resume resolves to the adopted dir — --import is not needed twice', async () => {
    await seedSharedSession('sess-shared');
    const adopted = await resolveBuilderProjectsDir({
      dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-shared', homeDirAbs: homeDir, adopt: true,
    });

    expect(await classifyResumeSession({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-shared', homeDirAbs: homeDir }))
      .toBe('isolated');
    const again = await resolveBuilderProjectsDir({
      dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-shared', homeDirAbs: homeDir,
    });
    expect(again!.id).toBe(adopted!.id);
    // Still not trusted: the copy is host-written until Claude appends to it.
    expect(again!.holdsResumeSession).toBe(false);
  });

  test('an adopted copy is never overwritten by seeding from another dir', async () => {
    // INVARIANT: the adopted dir is the live home of that line. Seeding refreshes
    // stale SEEDED copies from the newest copy elsewhere; an adopted copy is
    // excluded, or a newer stale snapshot elsewhere could clobber live history.
    await seedSharedSession('sess-shared', '{"line":"old"}\n');
    const adopted = await resolveBuilderProjectsDir({
      dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-shared', homeDirAbs: homeDir, adopt: true,
    });
    // A newer copy appears elsewhere (another dir's seeded snapshot, touched later).
    await seedCopyOnly('cccc3333', 'sess-shared', '{"line":"newer-elsewhere"}\n');

    const again = await resolveBuilderProjectsDir({
      dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-shared', homeDirAbs: homeDir,
    });
    expect(again!.id).toBe(adopted!.id);
    expect(await readFile(join(adopted!.hostDir, encoded, 'sess-shared.jsonl'), 'utf-8')).toBe('{"line":"old"}\n');
  });

  test('a container-written copy still wins over an adopted one (real write evidence first)', async () => {
    await seedSharedSession('sess-S');
    const adoptedDir = await resolveBuilderProjectsDir({
      dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-S', homeDirAbs: homeDir, adopt: true,
    });
    await seedContainerWritten('aaaa1111', 'sess-S');

    const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-S', homeDirAbs: homeDir });
    expect(res!.id).toBe('aaaa1111');
    expect(res!.id).not.toBe(adoptedDir!.id);
    expect(res!.holdsResumeSession).toBe(true);
  });
});
