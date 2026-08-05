/**
 * Unit tests for per-builder Claude projects-dir isolation.
 *
 * Isolation is ALWAYS attempted (no config flag) but is self-healing: it falls
 * back to the shared ~/.claude/projects dir whenever it can't work, so it never
 * breaks the builder. There are two fallback layers:
 *   1. HOST-SIDE (here, unit-tested): resolveBuilderProjectsDir returns null when
 *      a resumed session lives nowhere isolated (legacy/shared) — isolating would
 *      hide it and break --resume — and the builder command also catches a
 *      dir-creation failure and degrades to the shared dir.
 *   2. CONTAINER-SIDE (docker-runner.probeProjectsDirWritable, NOT unit-testable):
 *      a write-probe container checks the in-container `user` can write the
 *      overlay; if not, the mount is skipped. This needs docker + an
 *      authenticated interactive claude, so it is verified by the pairing pass.
 *
 * INVARIANT: the isolation dir is STABLE across the upgrade-relaunch loop yet
 * DISTINCT between concurrent invocations. A fresh run mints a new dir; a resume
 * reuses the dir that already holds the target session (so the resumed line keeps
 * its on-disk history and upgrade-resume finds the JSONL); a resume of a session
 * that lives nowhere in the isolation dirs (legacy/shared) does NOT isolate.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile, readdir, stat, utimes } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import {
  builderProjectsRoot,
  resolveBuilderProjectsDir,
  resolveBuilderProjectsDirForLaunch,
  pruneStaleBuilderProjectsDirs,
} from '../../src/builder/projects-isolation';

describe('builder projects-dir isolation', () => {
  let dataDir: string;
  let homeDir: string;
  const lazyRoot = '/repo/some-project';
  const encoded = encodeProjectPath(lazyRoot);

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lazy-projiso-'));
    // A fake host home so seeding reads a controlled shared ~/.claude/projects
    // dir instead of the real user's home.
    homeDir = mkdtempSync(join(tmpdir(), 'lazy-projiso-home-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  /** Seed an isolation dir <root>/<id>/<encoded>/<session>.jsonl. */
  async function seedSession(id: string, sessionId: string): Promise<void> {
    const dir = join(builderProjectsRoot(dataDir), id, encoded);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sessionId}.jsonl`), '{}\n');
  }

  /** Seed a session into the shared host ~/.claude/projects/<encoded>/ dir. */
  async function seedSharedSession(sessionId: string, body = '{}\n'): Promise<string> {
    const dir = join(homeDir, '.claude', 'projects', encoded);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    await writeFile(file, body);
    return file;
  }

  /** List session filenames present in a resolved isolation dir. */
  async function sessionsIn(hostDir: string): Promise<string[]> {
    return (await readdir(join(hostDir, encoded))).filter(f => f.endsWith('.jsonl')).sort();
  }

  test('fresh run mints a new, created, empty isolation dir', async () => {
    const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: null });
    expect(res).not.toBeNull();
    expect(res!.hostDir).toBe(join(builderProjectsRoot(dataDir), res!.id));
    // The encoded-cwd subdir is created so Claude can write straight away.
    const info = await stat(join(res!.hostDir, encoded));
    expect(info.isDirectory()).toBe(true);
  });

  test('two fresh runs get DISTINCT dirs (no cross-capture between concurrent builders)', async () => {
    const a = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: null });
    const b = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: null });
    expect(a!.id).not.toBe(b!.id);
    expect(a!.hostDir).not.toBe(b!.hostDir);
  });

  test('resume REUSES the existing dir that holds the target session', async () => {
    await seedSession('aaaa1111', 'sess-original');
    await seedSession('bbbb2222', 'sess-other');

    const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-original' });
    expect(res).not.toBeNull();
    expect(res!.id).toBe('aaaa1111');
  });

  test('resume of a post-/clear segment in the same dir resolves to that dir (upgrade-resume stability)', async () => {
    // A single invocation accumulates several segments in ONE isolation dir.
    await seedSession('aaaa1111', 'sess-root');
    await seedSession('aaaa1111', 'sess-after-clear');

    // The relaunch loop resumes the NEWEST segment after an upgrade; it must
    // resolve back to the same dir so --resume finds the JSONL.
    const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-after-clear' });
    expect(res!.id).toBe('aaaa1111');
  });

  test('resume of a session that lives nowhere isolated → null (fall back to shared dir, do not hide it)', async () => {
    await seedSession('aaaa1111', 'sess-isolated');
    // 'sess-legacy' was created before isolation existed (lives in the shared dir).
    const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-legacy' });
    expect(res).toBeNull();
  });

  test('resume when no isolation root exists yet → null', async () => {
    const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-x' });
    expect(res).toBeNull();
  });

  // The regression this suite guards: isolation gave each builder its own empty
  // projects dir, so Claude's in-session /resume picker (which reads only that
  // dir) listed NO previous sessions. Seeding copies prior sessions in so the
  // picker lists them again — without letting them be mis-attributed to this run.
  describe('seeding prior sessions into /resume history', () => {
    test('fresh run copies shared-dir sessions in so /resume lists them', async () => {
      await seedSharedSession('sess-a');
      await seedSharedSession('sess-b');

      const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: null, homeDirAbs: homeDir });
      expect(await sessionsIn(res!.hostDir)).toEqual(['sess-a.jsonl', 'sess-b.jsonl']);
    });

    test('fresh run also copies OTHER isolation dirs\' sessions (post-isolation history)', async () => {
      await seedSession('otherbld', 'sess-iso');
      await seedSharedSession('sess-shared');

      const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: null, homeDirAbs: homeDir });
      expect(await sessionsIn(res!.hostDir)).toEqual(['sess-iso.jsonl', 'sess-shared.jsonl']);
    });

    test('seeded copies preserve the source mtime (correct /resume ordering; seen as pre-launch)', async () => {
      const src = await seedSharedSession('sess-old');
      const backdated = new Date(1_600_000_000_000); // fixed instant in the past
      await utimes(src, backdated, backdated);

      const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: null, homeDirAbs: homeDir });
      const copied = await stat(join(res!.hostDir, encoded, 'sess-old.jsonl'));
      expect(Math.round(copied.mtimeMs)).toBe(backdated.getTime());
    });

    test('does NOT clobber a live session already in the reused resume dir', async () => {
      // The resumed line's own copy of the session (its live, appended-to history).
      const liveDir = join(builderProjectsRoot(dataDir), 'aaaa1111', encoded);
      await mkdir(liveDir, { recursive: true });
      await writeFile(join(liveDir, 'sess-live.jsonl'), 'LIVE-CONTENT\n');
      // A stale copy of the same session sitting in the shared dir.
      await seedSharedSession('sess-live', 'STALE-CONTENT\n');

      const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-live', homeDirAbs: homeDir });
      expect(res!.id).toBe('aaaa1111');
      const body = await Bun.file(join(res!.hostDir, encoded, 'sess-live.jsonl')).text();
      expect(body).toBe('LIVE-CONTENT\n');
    });

    test('when the same session lives in several dirs, the newest copy wins', async () => {
      const older = await seedSharedSession('sess-dup', 'OLD\n');
      await utimes(older, new Date(1_000), new Date(1_000));
      // A newer copy of the same session in another isolation dir.
      const newerDir = join(builderProjectsRoot(dataDir), 'newerbld', encoded);
      await mkdir(newerDir, { recursive: true });
      const newer = join(newerDir, 'sess-dup.jsonl');
      await writeFile(newer, 'NEW\n');
      await utimes(newer, new Date(9_000_000), new Date(9_000_000));

      const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: null, homeDirAbs: homeDir });
      const body = await Bun.file(join(res!.hostDir, encoded, 'sess-dup.jsonl')).text();
      expect(body).toBe('NEW\n');
    });

    test('no history anywhere → fresh dir stays empty, no error', async () => {
      const res = await resolveBuilderProjectsDir({ dataDirAbs: dataDir, lazyRoot, resumeId: null, homeDirAbs: homeDir });
      expect(await sessionsIn(res!.hostDir)).toEqual([]);
    });
  });

  // The upgrade-auto-resume regression this suite guards: `lazy builder` resolves
  // the projects dir PER LAUNCH (resolveBuilderProjectsDirForLaunch), keyed on the
  // launch's resume id. After `lazy upgrade` stops the container the relaunch loop
  // re-launches with `--resume <resolvedSessionId>`; the mounted dir must be the
  // one that actually holds THAT session. Resolving once up front (with the
  // initial, often-null resume id) and reusing the dir pointed the relaunch's
  // `--resume` at a dir that didn't contain the session — Claude then printed
  // "No conversation found with session ID".
  describe('resolveBuilderProjectsDirForLaunch (per-launch resolution for upgrade auto-resume)', () => {
    test('fresh launch (resumeId=null) mints and returns a new isolation dir', async () => {
      const dir = await resolveBuilderProjectsDirForLaunch({
        dataDirAbs: dataDir, lazyRoot, resumeId: null, homeDirAbs: homeDir,
      });
      expect(dir).toBeDefined();
      expect(dir!.startsWith(builderProjectsRoot(dataDir))).toBe(true);
      // Created and ready for Claude to write into.
      expect((await stat(join(dir!, encoded))).isDirectory()).toBe(true);
    });

    test('auto-resume: re-resolving with the post-upgrade session id returns the dir that holds it', async () => {
      // The initial fresh launch minted this dir and Claude wrote the session here.
      await seedSession('aaaa1111', 'sess-live');

      // The relaunch resolves the stamped session id — it must land back on the
      // SAME dir so `--resume sess-live` finds the JSONL.
      const dir = await resolveBuilderProjectsDirForLaunch({
        dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-live', homeDirAbs: homeDir,
      });
      expect(dir).toBe(join(builderProjectsRoot(dataDir), 'aaaa1111'));
    });

    test('auto-resume: a session that only lives in the shared dir → undefined (mount shared where it lives)', async () => {
      // Simulates a run whose write-probe was off (isolation disabled that run):
      // the session landed in the shared ~/.claude/projects dir, not any isolation
      // dir. The relaunch must fall back to the shared dir — NOT the (empty) minted
      // isolation dir — or `--resume` fails. This is the exact bug the fix closes.
      await seedSharedSession('sess-in-shared');

      const dir = await resolveBuilderProjectsDirForLaunch({
        dataDirAbs: dataDir, lazyRoot, resumeId: 'sess-in-shared', homeDirAbs: homeDir,
      });
      expect(dir).toBeUndefined();
    });
  });

  describe('pruning', () => {
    test('removes stale dirs, keeps the active one and recent ones', async () => {
      await seedSession('stale111', 'old');
      await seedSession('fresh222', 'new');
      await seedSession('active33', 'cur');

      const root = builderProjectsRoot(dataDir);
      const now = 1_000_000_000_000;
      const maxAge = 1000;
      // Make 'stale111' old by backdating its mtime via utimes.
      const { utimes } = await import('fs/promises');
      const old = new Date(now - maxAge - 1);
      await utimes(join(root, 'stale111'), old, old);

      const removed = await pruneStaleBuilderProjectsDirs(dataDir, 'active33', maxAge, now);
      expect(removed).toEqual(['stale111']);

      const remaining = (await readdir(root)).sort();
      expect(remaining).toEqual(['active33', 'fresh222']);
    });

    test('no-op when the root does not exist', async () => {
      const removed = await pruneStaleBuilderProjectsDirs(dataDir, null);
      expect(removed).toEqual([]);
    });
  });
});
