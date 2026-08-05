/**
 * Unit tests for the WRITE-TRUST layer of per-builder projects-dir isolation — the
 * residual auto-resume fix. Kept in a separate file from
 * builder-projects-isolation.test.ts (which covers resolution/seeding/pruning) so
 * that suite stays untouched.
 *
 * THE BUG: docker-runner's write-probe (probeProjectsDirWritable) can succeed on
 * the initial builder run — so Claude writes the session into the isolation dir —
 * but transiently FAIL on the upgrade relaunch (a `docker run` timeout under
 * upgrade load). A failed probe dropped the isolation mount and fell back to the
 * shared dir, shadowing the dir holding the session, so `--resume` failed.
 *
 * THE FIX: trust a resume dir over a failing probe — but ONLY when it holds a
 * CONTAINER-WRITTEN copy of the session (Claude created the JSONL there), which
 * proves the container user can write it. The trust must be evidence-based against
 * SEEDING: seedProjectsDirFromHistory copies every prior session into every freshly
 * minted dir HOST-side (mtimes preserved), so a bare "the dir contains this
 * session" match is frequently a host-written SEEDED copy — no write evidence.
 * Seeded copies are recorded in a per-dir `.lazy-seeded.json` manifest and excluded
 * from trust (and never used as a resume mount — they are stale snapshots).
 *
 * INVARIANT: a dir whose only copy of the resume target is a SEEDED one is NOT
 * trusted and is NOT resolved as the mount — resolution falls back to the shared
 * dir where the live session actually is. Otherwise, in the persistently
 * probe-failing (uid-mismatch) environment the probe exists for, trusting a seeded
 * copy would mount an unwritable dir and break the builder — strictly worse than
 * the old probe-gated fallback.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import {
  builderProjectsRoot,
  resolveBuilderProjectsDir,
  resolveBuilderProjectsDirForLaunch,
  isTrustedResumeProjectsDir,
  shouldMountProjectsDir,
} from '../../src/builder/projects-isolation';

describe('builder projects-dir write-trust (seeded-copy safe)', () => {
  let dataDir: string;
  let homeDir: string;
  const lazyRoot = '/repo/some-project';
  const encoded = encodeProjectPath(lazyRoot);

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lazy-projtrust-'));
    homeDir = mkdtempSync(join(tmpdir(), 'lazy-projtrust-home-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  /** Write <root>/<id>/<encoded>/<sessionId>.jsonl (no manifest → legacy dir). */
  async function seedSession(id: string, sessionId: string): Promise<void> {
    const dir = join(builderProjectsRoot(dataDir), id, encoded);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sessionId}.jsonl`), '{}\n');
  }

  /** Write a dir's seed manifest <root>/<id>/.lazy-seeded.json. */
  async function writeManifest(id: string, seededSessionIds: string[]): Promise<void> {
    const dir = join(builderProjectsRoot(dataDir), id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.lazy-seeded.json'), JSON.stringify({ seededSessionIds }) + '\n');
  }

  /** A dir where Claude container-wrote the session: present + manifest omits it. */
  async function seedContainerWritten(id: string, sessionId: string): Promise<void> {
    await seedSession(id, sessionId);
    await writeManifest(id, []);
  }

  /** A dir holding only a host-seeded copy: present + manifest lists it. */
  async function seedCopyOnly(id: string, sessionId: string): Promise<void> {
    await seedSession(id, sessionId);
    await writeManifest(id, [sessionId]);
  }

  /** Write a session into the shared host ~/.claude/projects/<encoded>/ dir. */
  async function seedSharedSession(sessionId: string): Promise<void> {
    const dir = join(homeDir, '.claude', 'projects', encoded);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sessionId}.jsonl`), '{}\n');
  }

  const hostDirOf = (id: string) => join(builderProjectsRoot(dataDir), id);

  // ── isTrustedResumeProjectsDir (per-dir container-write evidence) ──────────────
  describe('isTrustedResumeProjectsDir', () => {
    test('trusts a dir holding a CONTAINER-WRITTEN copy (present, not in manifest)', async () => {
      await seedContainerWritten('aaaa1111', 'sess-S');
      expect(await isTrustedResumeProjectsDir({ hostDir: hostDirOf('aaaa1111'), lazyRoot, resumeId: 'sess-S' })).toBe(true);
    });

    test('does NOT trust a dir holding only a SEEDED copy (present, in manifest)', async () => {
      await seedCopyOnly('bbbb2222', 'sess-S');
      expect(await isTrustedResumeProjectsDir({ hostDir: hostDirOf('bbbb2222'), lazyRoot, resumeId: 'sess-S' })).toBe(false);
    });

    test('does NOT trust a legacy (pre-manifest) dir — provenance unknown, probe-gated', async () => {
      await seedSession('legacy00', 'sess-S'); // no manifest
      expect(await isTrustedResumeProjectsDir({ hostDir: hostDirOf('legacy00'), lazyRoot, resumeId: 'sess-S' })).toBe(false);
    });

    test('does NOT trust when the dir does not hold the session at all', async () => {
      await seedContainerWritten('aaaa1111', 'sess-other');
      expect(await isTrustedResumeProjectsDir({ hostDir: hostDirOf('aaaa1111'), lazyRoot, resumeId: 'sess-S' })).toBe(false);
    });

    test('a fresh run (no resumeId) is never trusted', async () => {
      await seedContainerWritten('aaaa1111', 'sess-S');
      expect(await isTrustedResumeProjectsDir({ hostDir: hostDirOf('aaaa1111'), lazyRoot, resumeId: null })).toBe(false);
    });
  });

  // ── resolution ignores seeded copies (the concrete failure sequence) ───────────
  describe('resolution is seeded-copy safe', () => {
    test('resume target present ONLY as a seeded copy → not isolated (shared-dir fallback)', async () => {
      // Persistently probe-failing env: S was written to the SHARED dir; a later
      // launch seeded a COPY of S into isolation dir B. Resolving to B would mount
      // an unwritable dir and break the builder — resolution must skip it.
      await seedSharedSession('sess-S');
      await seedCopyOnly('bbbb2222', 'sess-S');

      expect(await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-S', homeDirAbs: homeDir })).toBeNull();
      expect(await resolveBuilderProjectsDirForLaunch({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-S', homeDirAbs: homeDir })).toBeUndefined();
    });

    test('container-written dir A is resolved (and trusted) over a seeded copy in B', async () => {
      await seedContainerWritten('aaaa1111', 'sess-S');
      await seedCopyOnly('bbbb2222', 'sess-S');

      const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-S', homeDirAbs: homeDir });
      expect(res!.id).toBe('aaaa1111');
      expect(res!.holdsResumeSession).toBe(true);

      const dir = await resolveBuilderProjectsDirForLaunch({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-S', homeDirAbs: homeDir });
      expect(dir).toBe(hostDirOf('aaaa1111'));
      // The launch pairs the dir with trust (recomputed by the builder command).
      expect(await isTrustedResumeProjectsDir({ hostDir: dir!, lazyRoot, resumeId: 'sess-S' })).toBe(true);
    });

    test('a container-written dir is preferred over a legacy dir that also holds the session', async () => {
      await seedSession('legacy00', 'sess-S');          // legacy copy (no manifest)
      await seedContainerWritten('aaaa1111', 'sess-S'); // provably container-written

      const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-S', homeDirAbs: homeDir });
      expect(res!.id).toBe('aaaa1111');
      expect(res!.holdsResumeSession).toBe(true);
    });

    test('a legacy (pre-manifest) dir holding the session is reused but NOT trusted (probe gates it)', async () => {
      await seedSession('legacy00', 'sess-legacy');

      const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-legacy', homeDirAbs: homeDir });
      expect(res!.id).toBe('legacy00');
      expect(res!.holdsResumeSession).toBe(false);
    });

    test('a fresh mint records its seeded sessions so they never later read as container-written', async () => {
      await seedSharedSession('sess-seeded');
      // Fresh mint seeds the shared session in and records it in the manifest.
      const fresh = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: null, homeDirAbs: homeDir });
      expect(await isTrustedResumeProjectsDir({ hostDir: fresh!.hostDir, lazyRoot, resumeId: 'sess-seeded' })).toBe(false);
      // The only isolated copy is the seeded one → resume is not isolated.
      expect(await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-seeded', homeDirAbs: homeDir })).toBeNull();
    });
  });

  // ── shouldMountProjectsDir (pure flip-safe mount decision) ─────────────────────
  describe('shouldMountProjectsDir (flip-safe mount decision)', () => {
    test('trusted dir mounts even when the write-probe fails (transient failure cannot strand --resume)', () => {
      expect(shouldMountProjectsDir({ trustWritable: true, probeWritable: false })).toBe(true);
    });

    test('trusted dir mounts when the probe passes too', () => {
      expect(shouldMountProjectsDir({ trustWritable: true, probeWritable: true })).toBe(true);
    });

    test('untrusted dir mounts only when the probe passes', () => {
      expect(shouldMountProjectsDir({ trustWritable: false, probeWritable: true })).toBe(true);
    });

    test('untrusted dir with a failing probe falls back to the shared dir', () => {
      expect(shouldMountProjectsDir({ trustWritable: false, probeWritable: false })).toBe(false);
    });
  });
});
