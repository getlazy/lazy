/**
 * Unit tests for the built-in conversation recovery core.
 *
 * INVARIANT: recovery scans BOTH the shared ~/.claude/projects dir AND every
 * per-builder isolation dir, dedupes the same session across dirs (seeding
 * copies it into many), skips sessions already in the store (idempotent), and
 * skips empty JSONL shells instead of persisting content-free stubs. This is a
 * recovery tool for weeks of builder conversations lost to the capture bug — a
 * regression that drops a source dir or re-imports duplicates silently loses or
 * corrupts that history.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import { builderProjectsRoot } from '../../src/builder/projects-isolation';
import {
  discoverCandidateSessions,
  reimportConversations,
  countMissingConversations,
} from '../../src/import/reimport-conversations';
import { ONESHOT_SESSION, oneshotBody } from '../helpers/oneshot-session';
import type { StoredConversation } from '../../src/storage/types';
import type { Storage } from '../../src/storage/interface';

/**
 * Minimal in-memory Storage stub exposing only the conversation methods the
 * recovery core actually calls. Cast through `unknown` — recovery never touches
 * the other ~70 Storage methods, and a real FileStorage would need the storage
 * lock, which is exactly what recovery must NOT depend on.
 */
function makeStorageStub(preloaded: string[] = []) {
  const saved = new Map<string, StoredConversation>();
  for (const id of preloaded) {
    saved.set(id, { sessionId: id } as StoredConversation);
  }
  const stub = {
    saved,
    async isConversationImported(sessionId: string): Promise<boolean> {
      return saved.has(sessionId);
    },
    async saveConversation(conv: StoredConversation): Promise<void> {
      saved.set(conv.sessionId, conv);
    },
  };
  return stub as unknown as typeof stub & Storage;
}

/** Build a valid Claude Code session JSONL body with N user/assistant turns. */
function jsonlBody(sessionId: string, cwd: string, turns: number): string {
  const lines: string[] = [];
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({
      type: 'user',
      uuid: `${sessionId}-u${i}`,
      parentUuid: i > 0 ? `${sessionId}-a${i - 1}` : null,
      timestamp: `2026-07-12T10:0${i}:00Z`,
      sessionId,
      cwd,
      version: '1.0.0',
      gitBranch: 'main',
      message: { role: 'user', content: `question ${i}` },
    }));
    lines.push(JSON.stringify({
      type: 'assistant',
      uuid: `${sessionId}-a${i}`,
      parentUuid: `${sessionId}-u${i}`,
      timestamp: `2026-07-12T10:0${i}:05Z`,
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `answer ${i}` }],
        model: 'claude-opus-4-8',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }));
  }
  return lines.join('\n') + '\n';
}

describe('reimport-conversations core', () => {
  let homeDir: string;
  let dataDir: string;
  const lazyRoot = '/repo/recover-me';
  const encoded = encodeProjectPath(lazyRoot);

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'lazy-reimport-home-'));
    dataDir = mkdtempSync(join(tmpdir(), 'lazy-reimport-data-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Write a session JSONL into the shared ~/.claude/projects dir. */
  async function seedShared(sessionId: string, turns: number, body?: string): Promise<string> {
    const dir = join(homeDir, '.claude', 'projects', encoded);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    await writeFile(file, body ?? jsonlBody(sessionId, lazyRoot, turns));
    return file;
  }

  /** Write a session JSONL into a per-builder isolation dir. */
  async function seedIsolation(id: string, sessionId: string, turns: number, body?: string): Promise<string> {
    const dir = join(builderProjectsRoot(dataDir), id, encoded);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    await writeFile(file, body ?? jsonlBody(sessionId, lazyRoot, turns));
    return file;
  }

  const opts = () => ({ lazyRoot, dataDirAbs: dataDir, homeDirAbs: homeDir });

  test('discovers sessions from BOTH the shared dir and isolation dirs', async () => {
    await seedShared('11111111-0000-0000-0000-000000000001', 1);
    await seedIsolation('builderA', '22222222-0000-0000-0000-000000000002', 1);
    await seedIsolation('builderB', '33333333-0000-0000-0000-000000000003', 1);

    const found = await discoverCandidateSessions(opts());
    const ids = found.map(f => f.sessionId).sort();
    expect(ids).toEqual([
      '11111111-0000-0000-0000-000000000001',
      '22222222-0000-0000-0000-000000000002',
      '33333333-0000-0000-0000-000000000003',
    ]);
  });

  test('dedupes the same session across dirs, preferring the largest copy', async () => {
    const sid = 'dddddddd-0000-0000-0000-000000000001';
    // Shared copy: 1 turn (small). Isolation copy: 3 turns (larger — more content).
    await seedShared(sid, 1);
    const bigFile = await seedIsolation('builderA', sid, 3);

    const found = await discoverCandidateSessions(opts());
    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe(sid);
    // The winning candidate must be the larger isolation copy.
    expect(found[0].filePath).toBe(bigFile);

    const storage = makeStorageStub();
    const report = await reimportConversations({ ...opts(), storage });
    expect(report.imported).toHaveLength(1);
    // 3 turns => 6 messages parsed from the larger copy, not 2 from the shared one.
    expect(storage.saved.get(sid)!.stats.messageCount).toBe(6);
  });

  test('imports missing sessions and skips ones already in the store', async () => {
    await seedShared('aaaaaaaa-0000-0000-0000-000000000001', 2);
    await seedIsolation('builderA', 'bbbbbbbb-0000-0000-0000-000000000002', 2);

    const storage = makeStorageStub(['aaaaaaaa-0000-0000-0000-000000000001']);
    const report = await reimportConversations({ ...opts(), storage });

    expect(report.found).toBe(2);
    expect(report.imported.map(i => i.sessionId)).toEqual(['bbbbbbbb-0000-0000-0000-000000000002']);
    expect(report.skippedAlready).toEqual(['aaaaaaaa-0000-0000-0000-000000000001']);
    expect(report.errors).toHaveLength(0);
  });

  test('is idempotent — a second run imports nothing new', async () => {
    await seedIsolation('builderA', 'cccccccc-0000-0000-0000-000000000001', 2);
    const storage = makeStorageStub();

    const first = await reimportConversations({ ...opts(), storage });
    expect(first.imported).toHaveLength(1);

    const second = await reimportConversations({ ...opts(), storage });
    expect(second.imported).toHaveLength(0);
    expect(second.skippedAlready).toEqual(['cccccccc-0000-0000-0000-000000000001']);
  });

  test('skips empty JSONL shells instead of persisting content-free stubs', async () => {
    // A file Claude opened before any turn landed — no user/assistant messages.
    await seedIsolation('builderA', 'eeeeeeee-0000-0000-0000-000000000001', 0, '\n');
    await seedIsolation('builderB', 'ffffffff-0000-0000-0000-000000000002', 1);

    const storage = makeStorageStub();
    const report = await reimportConversations({ ...opts(), storage });

    expect(report.imported.map(i => i.sessionId)).toEqual(['ffffffff-0000-0000-0000-000000000002']);
    expect(report.skippedEmpty).toEqual(['eeeeeeee-0000-0000-0000-000000000001']);
    expect(storage.saved.has('eeeeeeee-0000-0000-0000-000000000001')).toBe(false);
  });

  test('countMissingConversations counts only sessions not already in the store', async () => {
    await seedShared('a1111111-0000-0000-0000-000000000001', 1);
    await seedIsolation('builderA', 'b2222222-0000-0000-0000-000000000002', 1);
    await seedIsolation('builderB', 'c3333333-0000-0000-0000-000000000003', 1);

    const storage = makeStorageStub(['a1111111-0000-0000-0000-000000000001']);
    const missing = await countMissingConversations({ ...opts(), storage });
    expect(missing).toBe(2);
  });

  test('no sessions anywhere → empty report, nothing imported', async () => {
    const storage = makeStorageStub();
    const report = await reimportConversations({ ...opts(), storage });
    expect(report.found).toBe(0);
    expect(report.imported).toHaveLength(0);
    expect(storage.saved.size).toBe(0);
  });

  /**
   * INVARIANT: lazy's own `claude -p` housekeeping runs (fidelity summaries on
   * accept, `lazy report`, LLM memory compaction) are marked at the source and
   * never imported. They were ~83% of the store and drowned real builder
   * conversations in `lazy builder list` and search. See src/import/machine-oneshot.ts.
   */
  describe('machine-generated one-shots', () => {
    test('a one-shot is not a candidate, and a real session next to it still imports', async () => {
      await seedShared(ONESHOT_SESSION, 1, oneshotBody(ONESHOT_SESSION, lazyRoot));
      await seedShared('a1111111-0000-0000-0000-00000000000a', 2);

      const found = await discoverCandidateSessions(opts());
      expect(found.map(f => f.sessionId)).toEqual(['a1111111-0000-0000-0000-00000000000a']);

      const storage = makeStorageStub();
      const report = await reimportConversations({ ...opts(), storage });
      expect(report.imported.map(i => i.sessionId)).toEqual(['a1111111-0000-0000-0000-00000000000a']);
      expect(report.skippedMachineOneshots).toBe(1);
      expect(storage.saved.has(ONESHOT_SESSION)).toBe(false);
    });

    test('one-shots are excluded from a one-shot-only run', async () => {
      await seedShared(ONESHOT_SESSION, 1, oneshotBody(ONESHOT_SESSION, lazyRoot));
      const storage = makeStorageStub();
      const report = await reimportConversations({ ...opts(), storage });
      expect(report.found).toBe(0);
      expect(report.skippedMachineOneshots).toBe(1);
      expect(storage.saved.size).toBe(0);
    });

    // INVARIANT: keeps `lazy doctor`'s capture-rot check honest. A deliberately
    // skipped session must never count as uncaptured, or the check goes red
    // forever after every accept.
    test('a one-shot never counts as a missing/uncaptured conversation', async () => {
      await seedShared(ONESHOT_SESSION, 1, oneshotBody(ONESHOT_SESSION, lazyRoot));
      await seedIsolation('builderA', 'b2222222-0000-0000-0000-00000000000b', 1);

      const storage = makeStorageStub(['b2222222-0000-0000-0000-00000000000b']);
      expect(await countMissingConversations({ ...opts(), storage })).toBe(0);
    });

    test('one-shots in a builder isolation dir are skipped too', async () => {
      await seedIsolation('builderA', ONESHOT_SESSION, 1, oneshotBody(ONESHOT_SESSION, lazyRoot));
      const found = await discoverCandidateSessions(opts());
      expect(found).toHaveLength(0);
    });
  });
});
