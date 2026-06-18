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
import { mkdir, writeFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import {
  builderProjectsRoot,
  resolveBuilderProjectsDir,
  pruneStaleBuilderProjectsDirs,
} from '../../src/builder/projects-isolation';

describe('builder projects-dir isolation', () => {
  let dataDir: string;
  const lazyRoot = '/repo/some-project';
  const encoded = encodeProjectPath(lazyRoot);

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'lazy-projiso-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Seed an isolation dir <root>/<id>/<encoded>/<session>.jsonl. */
  async function seedSession(id: string, sessionId: string): Promise<void> {
    const dir = join(builderProjectsRoot(dataDir), id, encoded);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sessionId}.jsonl`), '{}\n');
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
