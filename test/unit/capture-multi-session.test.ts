/**
 * Unit/integration tests for multi-segment conversation capture.
 *
 * THE BUG: a single builder/pair run is NOT one Claude Code JSONL file. Claude
 * opens a fresh `<uuid>.jsonl` on `/clear`, on compaction, and on resume. The
 * old capture latched onto exactly ONE file, so every other segment of a run
 * was silently dropped — that's the "checkered" / mostly-missing capture in
 * `lazy builder list`. These tests pin the fix: capture persists EVERY
 * new-or-modified session file for the project.
 *
 * They also pin two resilience properties:
 *   - A capture that runs mid-session (the incremental path / a non-graceful
 *     exit's last tick) still persists everything written so far.
 *   - encodeProjectPath matches Claude Code's real cwd→dirname encoding,
 *     including characters like `_` — a mismatch there finds NO directory and
 *     loses an entire environment's history (the total-loss case).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile, utimes } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  encodeProjectPath,
  discoverProjectSessionFiles,
} from '../../src/import/claude-code-logs';
import {
  snapshotSessionFiles,
  captureNewOrModifiedConversations,
  captureConversation,
  type SessionSnapshot,
} from '../../src/import/capture-session';
import type { StoredConversation } from '../../src/storage/types';
import type { Storage } from '../../src/storage';

/** A minimal in-memory Storage that records saveConversation calls. */
function fakeStorage() {
  const saved = new Map<string, StoredConversation>();
  let closed = false;
  const storage = {
    saveConversation: async (c: StoredConversation) => {
      saved.set(c.sessionId, c);
    },
    listConversations: async () => Array.from(saved.values()),
    close: async () => {
      closed = true;
    },
  } as unknown as Storage;
  return { storage, saved, isClosed: () => closed };
}

/** Write a one-turn JSONL session file (user + assistant) for a sessionId. */
async function writeSessionFile(
  projectDir: string,
  sessionId: string,
  cwd: string,
  userText: string,
  assistantText: string,
): Promise<string> {
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: `${sessionId}-u`,
      timestamp: '2026-06-03T10:00:00Z',
      sessionId,
      cwd,
      version: '1.0.0',
      gitBranch: 'main',
      message: { role: 'user', content: userText },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: `${sessionId}-a`,
      parentUuid: `${sessionId}-u`,
      timestamp: '2026-06-03T10:00:05Z',
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: assistantText }],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    }),
  ];
  const path = join(projectDir, `${sessionId}.jsonl`);
  await writeFile(path, lines.join('\n') + '\n', 'utf-8');
  return path;
}

describe('encodeProjectPath matches Claude Code dir naming', () => {
  // INVARIANT: every non-alphanumeric char maps to a single dash, with no
  // collapsing of runs. A path like `/Users/foo/.lazy` yields `--lazy` (two
  // dashes: one for `/`, one for `.`). This must mirror Claude Code exactly —
  // otherwise the computed ~/.claude/projects/<encoded> dir doesn't exist and
  // NOTHING is captured for that environment (total-loss bug).
  test('replaces dots and slashes (observed double-dash for /.)', () => {
    expect(encodeProjectPath('/Users/ierceg/prg/lazy-dev/.lazy/worktrees/foo'))
      .toBe('-Users-ierceg-prg-lazy-dev--lazy-worktrees-foo');
  });

  // The narrow old encoding only replaced `/` and `.`, so underscores leaked
  // through and the directory lookup missed — this is the regression guard.
  test('replaces underscores and spaces too', () => {
    expect(encodeProjectPath('/Users/foo/my_project'))
      .toBe('-Users-foo-my-project');
    expect(encodeProjectPath('/Users/foo/My Project'))
      .toBe('-Users-foo-My-Project');
  });
});

describe('multi-segment conversation capture', () => {
  let tempDir: string;
  let fakeHome: string;
  let repoRoot: string;
  let projectDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'lazy-capture-test-'));
    fakeHome = join(tempDir, 'home');
    repoRoot = join(tempDir, 'repo');
    await mkdir(repoRoot, { recursive: true });

    projectDir = join(fakeHome, '.claude', 'projects', encodeProjectPath(repoRoot));
    await mkdir(projectDir, { recursive: true });

    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('captures EVERY session file a run produced (the /clear + compaction case)', async () => {
    // Before launch: one pre-existing conversation from a prior run.
    await writeSessionFile(projectDir, 'old-session', repoRoot, 'old prompt', 'old reply');
    const before = await snapshotSessionFiles(repoRoot);

    // The run writes three NEW session files (initial, post-/clear, post-compaction).
    await writeSessionFile(projectDir, 'seg-1', repoRoot, 'first prompt', 'first reply');
    await writeSessionFile(projectDir, 'seg-2', repoRoot, 'second prompt', 'second reply');
    await writeSessionFile(projectDir, 'seg-3', repoRoot, 'third prompt', 'third reply');

    const { storage, saved } = fakeStorage();
    const result = await captureNewOrModifiedConversations(repoRoot, before, storage);

    // All three new segments captured; the pre-existing one is left alone.
    expect(result.captured.sort()).toEqual(['seg-1', 'seg-2', 'seg-3']);
    expect(result.errors).toEqual([]);
    expect(saved.has('seg-1')).toBe(true);
    expect(saved.has('seg-2')).toBe(true);
    expect(saved.has('seg-3')).toBe(true);
    expect(saved.has('old-session')).toBe(false);
  });

  test('captures a resumed (appended-in-place) file as modified', async () => {
    // Pre-existing session that the run will resume and append to.
    const resumedPath = await writeSessionFile(projectDir, 'resumed', repoRoot, 'q1', 'a1');
    // Backdate its mtime so the post-launch append is detectable.
    const past = new Date('2026-06-03T09:00:00Z');
    await utimes(resumedPath, past, past);
    const before = await snapshotSessionFiles(repoRoot);

    // Resume appends more turns (file grows + mtime advances).
    await writeFile(
      resumedPath,
      (await Bun.file(resumedPath).text()) +
        JSON.stringify({
          type: 'user',
          uuid: 'resumed-u2',
          timestamp: '2026-06-03T11:00:00Z',
          sessionId: 'resumed',
          cwd: repoRoot,
          version: '1.0.0',
          gitBranch: 'main',
          message: { role: 'user', content: 'q2 after resume' },
        }) + '\n',
      'utf-8',
    );

    const { storage, saved } = fakeStorage();
    const result = await captureNewOrModifiedConversations(repoRoot, before, storage);

    expect(result.captured).toEqual(['resumed']);
    expect(saved.get('resumed')?.messages.some(m => m.text === 'q2 after resume')).toBe(true);
  });

  test('incremental pass skips files unchanged since last capture', async () => {
    const before = await snapshotSessionFiles(repoRoot);
    await writeSessionFile(projectDir, 'seg-1', repoRoot, 'p1', 'r1');

    const { storage, saved } = fakeStorage();
    const captured: SessionSnapshot = new Map();

    // First pass captures seg-1.
    let r = await captureNewOrModifiedConversations(repoRoot, before, storage, captured);
    expect(r.captured).toEqual(['seg-1']);

    // Second pass with nothing changed → no re-save.
    r = await captureNewOrModifiedConversations(repoRoot, before, storage, captured);
    expect(r.captured).toEqual([]);

    // A new segment appears → only it is captured.
    await writeSessionFile(projectDir, 'seg-2', repoRoot, 'p2', 'r2');
    r = await captureNewOrModifiedConversations(repoRoot, before, storage, captured);
    expect(r.captured).toEqual(['seg-2']);
    expect(saved.size).toBe(2);
  });

  test('non-graceful exit: a mid-session capture still persists work so far', async () => {
    // Simulates the incremental monitor's last tick before a kill: only one
    // segment has been written, and the graceful final flush never runs.
    const before = await snapshotSessionFiles(repoRoot);
    await writeSessionFile(projectDir, 'killed-run', repoRoot, 'work in progress', 'partial reply');

    const { storage, saved } = fakeStorage();
    await captureNewOrModifiedConversations(repoRoot, before, storage);

    expect(saved.has('killed-run')).toBe(true);
    expect(await storage.listConversations()).toHaveLength(1);
  });

  test('one failing file does not block the others, and the error surfaces', async () => {
    const before = await snapshotSessionFiles(repoRoot);
    await writeSessionFile(projectDir, 'good', repoRoot, 'ok', 'fine');
    await writeSessionFile(projectDir, 'bad', repoRoot, 'will fail', 'on save');

    const saved = new Map<string, StoredConversation>();
    const storage = {
      saveConversation: async (c: StoredConversation) => {
        if (c.sessionId === 'bad') throw new Error('disk full');
        saved.set(c.sessionId, c);
      },
      close: async () => {},
    } as unknown as Storage;

    const result = await captureNewOrModifiedConversations(repoRoot, before, storage);

    expect(saved.has('good')).toBe(true);
    expect(result.captured).toEqual(['good']);
    // The failure is surfaced, not swallowed.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].sessionId).toBe('bad');
    expect(result.errors[0].error.message).toContain('disk full');
  });

  test('captureConversation persists all segments and returns the newest as resume target', async () => {
    const before = await snapshotSessionFiles(repoRoot);
    const p1 = await writeSessionFile(projectDir, 'seg-1', repoRoot, 'p1', 'r1');
    const p2 = await writeSessionFile(projectDir, 'seg-2', repoRoot, 'p2', 'r2');
    // Make seg-2 strictly newer.
    await utimes(p1, new Date('2026-06-03T10:00:00Z'), new Date('2026-06-03T10:00:00Z'));
    await utimes(p2, new Date('2026-06-03T10:05:00Z'), new Date('2026-06-03T10:05:00Z'));

    const { storage, saved, isClosed } = fakeStorage();
    const newest = await captureConversation(repoRoot, before, 'Builder', storage);

    expect(saved.has('seg-1')).toBe(true);
    expect(saved.has('seg-2')).toBe(true);
    expect(newest).toBe('seg-2');
    // existingStorage was provided → captureConversation must NOT close it.
    expect(isClosed()).toBe(false);
  });

  test('discoverProjectSessionFiles reports stat info for change detection', async () => {
    await writeSessionFile(projectDir, 'seg-1', repoRoot, 'p1', 'r1');
    const files = await discoverProjectSessionFiles(repoRoot);
    expect(files).toHaveLength(1);
    expect(files[0].sessionId).toBe('seg-1');
    expect(files[0].size).toBeGreaterThan(0);
    expect(files[0].mtimeMs).toBeGreaterThan(0);
  });
});
