/**
 * Unit tests: host-side detection of the session a builder launch was running
 * (src/builder/session-detect.ts).
 *
 * This is the kill-proof half of the upgrade-relaunch-resume fix. The
 * in-container supervisor's stamp only runs if the supervisor gets to run — it
 * did not under `docker kill`, and it still will not under an OOM, a crash, or a
 * sleeping machine. The host can always tell, because Claude's session JSONL is
 * written into a directory the host bind-mounted.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  pickLaunchSessionId,
  detectBuilderLaunchSessionId,
} from '../../src/builder/session-detect';
import { encodeProjectPath } from '../../src/import/claude-code-logs';

describe('pickLaunchSessionId', () => {
  test('picks the newest file touched at or after launch', () => {
    const id = pickLaunchSessionId(
      [
        { sessionId: 'old', mtimeMs: 500 },
        { sessionId: 'first', mtimeMs: 1_100 },
        { sessionId: 'latest', mtimeMs: 1_900 },
      ],
      1_000,
      null,
    );
    // A single run rolls to a fresh JSONL on /clear, compaction and resume, so
    // the resume target is the NEWEST owned file, not the one it started on.
    expect(id).toBe('latest');
  });

  // INVARIANT: files older than the launch instant are never candidates. This is
  // what excludes host-SEEDED conversations: seedProjectsDirFromHistory copies
  // prior sessions into the per-builder dir before launch and deliberately
  // preserves their original mtimes, so they must sort as pre-launch. Do not
  // relax this to "newest file in the dir" — a fresh builder would then resume
  // whatever old conversation happened to be seeded next to it.
  test('ignores pre-launch (seeded) files entirely', () => {
    const id = pickLaunchSessionId(
      [
        { sessionId: 'seeded-a', mtimeMs: 10 },
        { sessionId: 'seeded-b', mtimeMs: 20 },
      ],
      1_000,
      null,
    );
    expect(id).toBeNull();
  });

  test('falls back to the resume id when nothing was touched', () => {
    // Resumed, then quit without Claude writing anything: still that session.
    const id = pickLaunchSessionId([{ sessionId: 'seeded', mtimeMs: 10 }], 1_000, 'resumed-id');
    expect(id).toBe('resumed-id');
  });

  test('a touched file beats the resume id', () => {
    const id = pickLaunchSessionId(
      [{ sessionId: 'rolled-to', mtimeMs: 2_000 }],
      1_000,
      'resumed-id',
    );
    expect(id).toBe('rolled-to');
  });

  test('empty input with no resume id yields null', () => {
    expect(pickLaunchSessionId([], 1_000, null)).toBeNull();
  });
});

describe('detectBuilderLaunchSessionId', () => {
  let root: string;
  let home: string;
  let isolated: string;

  /** Write a session JSONL for `lazyRoot` under `projectsDir` with an explicit mtime. */
  async function writeSession(
    projectsDir: string,
    lazyRoot: string,
    sessionId: string,
    mtimeMs: number,
  ): Promise<void> {
    const dir = join(projectsDir, encodeProjectPath(lazyRoot));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    await writeFile(file, '{"type":"user"}\n');
    const secs = mtimeMs / 1000;
    await utimes(file, secs, secs);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-bsd-root-'));
    home = await mkdtemp(join(tmpdir(), 'lazy-bsd-home-'));
    isolated = await mkdtemp(join(tmpdir(), 'lazy-bsd-iso-'));
  });

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(home, { recursive: true, force: true }),
      rm(isolated, { recursive: true, force: true }),
    ]);
  });

  test('finds the session written into the per-builder isolation dir', async () => {
    const launchedAtMs = Date.now();
    await writeSession(isolated, root, 'live-session', launchedAtMs + 5_000);

    const id = await detectBuilderLaunchSessionId({
      lazyRoot: root,
      projectsHostDir: isolated,
      launchedAtMs,
      resumeId: null,
      homeDirAbs: home,
    });
    expect(id).toBe('live-session');
  });

  // INVARIANT: the isolation dir wins when it has an answer. Every file in it
  // belongs to THIS builder; the shared dir cannot distinguish concurrent
  // builders of the same repo and is only a fallback.
  test('prefers the isolation dir over the shared ~/.claude/projects dir', async () => {
    const launchedAtMs = Date.now();
    await writeSession(isolated, root, 'mine', launchedAtMs + 1_000);
    // Newer, but written by some OTHER builder into the shared dir.
    await writeSession(join(home, '.claude', 'projects'), root, 'someone-else', launchedAtMs + 9_000);

    const id = await detectBuilderLaunchSessionId({
      lazyRoot: root,
      projectsHostDir: isolated,
      launchedAtMs,
      resumeId: null,
      homeDirAbs: home,
    });
    expect(id).toBe('mine');
  });

  // The isolation mount is dropped when the container-user write-probe fails, and
  // isolation can be off entirely — then Claude writes to the shared dir and that
  // is where the evidence is.
  test('falls back to the shared dir when the isolation dir has nothing', async () => {
    const launchedAtMs = Date.now();
    await writeSession(join(home, '.claude', 'projects'), root, 'shared-session', launchedAtMs + 1_000);

    const id = await detectBuilderLaunchSessionId({
      lazyRoot: root,
      projectsHostDir: isolated,
      launchedAtMs,
      resumeId: null,
      homeDirAbs: home,
    });
    expect(id).toBe('shared-session');
  });

  test('seeded (pre-launch) files do not masquerade as this launch', async () => {
    const launchedAtMs = Date.now();
    // Seeding preserves original mtimes, so a seeded copy is older than launch.
    await writeSession(isolated, root, 'seeded-old', launchedAtMs - 60_000);

    const id = await detectBuilderLaunchSessionId({
      lazyRoot: root,
      projectsHostDir: isolated,
      launchedAtMs,
      resumeId: null,
      homeDirAbs: home,
    });
    expect(id).toBeNull();
  });

  test('reports the resume id when no dir yields a post-launch file', async () => {
    const id = await detectBuilderLaunchSessionId({
      lazyRoot: root,
      projectsHostDir: isolated,
      launchedAtMs: Date.now(),
      resumeId: 'resumed-id',
      homeDirAbs: home,
    });
    expect(id).toBe('resumed-id');
  });

  // INVARIANT: never throws. This runs on the builder's exit path; the only
  // thing worse than not knowing the session id is turning a normal quit into a
  // crash. Missing dirs are the common case (a builder that never wrote).
  test('missing directories are not an error', async () => {
    const id = await detectBuilderLaunchSessionId({
      lazyRoot: root,
      projectsHostDir: join(isolated, 'does-not-exist'),
      launchedAtMs: Date.now(),
      resumeId: null,
      homeDirAbs: join(home, 'does-not-exist'),
    });
    expect(id).toBeNull();
  });
});
