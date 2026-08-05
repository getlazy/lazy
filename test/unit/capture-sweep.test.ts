/**
 * Unit tests for the daemon-side live capture sweep and for the rot/history
 * classification `lazy doctor` renders its verdict from.
 *
 * INVARIANT: the sweep is the ONLY live capture path for Claude sessions lazy
 * runs on the host (fidelity summaries on accept, `lazy report`, memory
 * compaction) — those never enter a builder container, so nothing else watches
 * them. It must therefore capture new sessions, re-save a session that grew
 * mid-run, and never lose the rest of a sweep to one bad file.
 *
 * INVARIANT: the sweep must NOT re-parse history. Parsing every stored session
 * on every tick would burn minutes of CPU on a real store, so a first sighting
 * of an already-stored session records its stat and parses nothing. A change to
 * that fast path is a performance regression, not a refactor.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile, utimes } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { encodeProjectPath } from '../../src/import/claude-code-logs';
import { builderProjectsRoot } from '../../src/builder/projects-isolation';
import { sweepConversations, createSweepCursor } from '../../src/import/capture-sweep';
import {
  classifyMissingConversations,
  CAPTURE_SETTLE_MS,
  CAPTURE_ROT_WINDOW_MS,
} from '../../src/import/reimport-conversations';
import { ONESHOT_SESSION, oneshotBody } from '../helpers/oneshot-session';
import type { StoredConversation } from '../../src/storage/types';
import type { Storage } from '../../src/storage/interface';

/**
 * Minimal in-memory Storage stub — the sweep only ever calls two conversation
 * methods, and a real FileStorage would need the storage lock the daemon holds.
 * Counts isConversationImported calls so the "don't re-parse history" fast path
 * is observable.
 */
function makeStorageStub(preloaded: string[] = []) {
  const saved = new Map<string, StoredConversation>();
  for (const id of preloaded) saved.set(id, { sessionId: id } as StoredConversation);
  const stub = {
    saved,
    importedChecks: 0,
    saveCalls: [] as string[],
    async isConversationImported(sessionId: string): Promise<boolean> {
      stub.importedChecks++;
      return saved.has(sessionId);
    },
    async saveConversation(conv: StoredConversation): Promise<void> {
      stub.saveCalls.push(conv.sessionId);
      saved.set(conv.sessionId, conv);
    },
  };
  return stub as unknown as typeof stub & Storage;
}

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

describe('capture sweep', () => {
  let homeDir: string;
  let dataDir: string;
  const lazyRoot = '/repo/sweep-me';
  const encoded = encodeProjectPath(lazyRoot);

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'lazy-sweep-home-'));
    dataDir = mkdtempSync(join(tmpdir(), 'lazy-sweep-data-'));
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

  test('captures a host-side session the moment it appears', async () => {
    // This is the regression: `runClaudeOneshot` writes here and NOTHING used to
    // pick it up, so a later reimport kept finding same-day conversations.
    await seedShared('a1111111-0000-0000-0000-000000000001', 2);
    const storage = makeStorageStub();
    const cursor = createSweepCursor();

    const result = await sweepConversations({ ...opts(), storage, cursor });

    expect(result.captured).toEqual(['a1111111-0000-0000-0000-000000000001']);
    expect(storage.saved.get('a1111111-0000-0000-0000-000000000001')!.stats.messageCount).toBe(4);
  });

  test('also covers the builder isolation dirs (backstop for in-container capture)', async () => {
    await seedIsolation('builderA', 'b2222222-0000-0000-0000-000000000002', 1);
    const storage = makeStorageStub();
    const result = await sweepConversations({ ...opts(), storage, cursor: createSweepCursor() });
    expect(result.captured).toEqual(['b2222222-0000-0000-0000-000000000002']);
  });

  test('a second sweep with no changes parses and saves nothing', async () => {
    await seedShared('c3333333-0000-0000-0000-000000000003', 1);
    const storage = makeStorageStub();
    const cursor = createSweepCursor();

    await sweepConversations({ ...opts(), storage, cursor });
    const second = await sweepConversations({ ...opts(), storage, cursor });

    expect(second.scanned).toBe(1);
    expect(second.captured).toEqual([]);
    expect(storage.saveCalls).toEqual(['c3333333-0000-0000-0000-000000000003']);
  });

  test('re-saves a session that grew, so a long-running session stays current', async () => {
    const sid = 'd4444444-0000-0000-0000-000000000004';
    const file = await seedShared(sid, 1);
    const storage = makeStorageStub();
    const cursor = createSweepCursor();

    await sweepConversations({ ...opts(), storage, cursor });
    expect(storage.saved.get(sid)!.stats.messageCount).toBe(2);

    await writeFile(file, jsonlBody(sid, lazyRoot, 3));
    const second = await sweepConversations({ ...opts(), storage, cursor });

    expect(second.captured).toEqual([sid]);
    expect(storage.saved.get(sid)!.stats.messageCount).toBe(6);
  });

  // INVARIANT: daemon start must not re-parse the whole conversation history.
  test('first sighting of an already-stored session records its stat without parsing', async () => {
    const sid = 'e5555555-0000-0000-0000-000000000005';
    await seedShared(sid, 1);
    const storage = makeStorageStub([sid]);
    const cursor = createSweepCursor();

    const first = await sweepConversations({ ...opts(), storage, cursor });
    expect(first.captured).toEqual([]);
    expect(storage.saveCalls).toEqual([]);

    // The stat is now the baseline, so the next tick doesn't even ask storage.
    const before = storage.importedChecks;
    const second = await sweepConversations({ ...opts(), storage, cursor });
    expect(second.captured).toEqual([]);
    expect(storage.importedChecks).toBe(before);
  });

  test('skips empty shells and retries them once they have content', async () => {
    const sid = 'f6666666-0000-0000-0000-000000000006';
    const file = await seedShared(sid, 0, '\n');
    const storage = makeStorageStub();
    const cursor = createSweepCursor();

    const first = await sweepConversations({ ...opts(), storage, cursor });
    expect(first.skippedEmpty).toEqual([sid]);
    expect(storage.saved.size).toBe(0);

    await writeFile(file, jsonlBody(sid, lazyRoot, 1));
    const second = await sweepConversations({ ...opts(), storage, cursor });
    expect(second.captured).toEqual([sid]);
  });

  test('one failing session does not abort the sweep, and is retried next tick', async () => {
    const bad = 'aa000000-0000-0000-0000-00000000000b';
    const good = 'bb000000-0000-0000-0000-00000000000c';
    await seedShared(bad, 1);
    await seedShared(good, 1);

    const storage = makeStorageStub();
    let failOnce = true;
    const original = storage.saveConversation.bind(storage);
    (storage as unknown as { saveConversation: Storage['saveConversation'] }).saveConversation = async conv => {
      if (conv.sessionId === bad && failOnce) {
        failOnce = false;
        throw new Error('disk on fire');
      }
      return original(conv);
    };
    const cursor = createSweepCursor();

    const first = await sweepConversations({ ...opts(), storage, cursor });
    expect(first.captured).toContain(good);
    expect(first.errors.map(e => e.sessionId)).toEqual([bad]);

    // The cursor was deliberately left unset for the failure, so it retries.
    const second = await sweepConversations({ ...opts(), storage, cursor });
    expect(second.captured).toEqual([bad]);
  });

  test('sweeping an empty machine is a no-op, not an error', async () => {
    const storage = makeStorageStub();
    const result = await sweepConversations({ ...opts(), storage, cursor: createSweepCursor() });
    expect(result).toMatchObject({ scanned: 0, captured: [], errors: [] });
  });

  test('mtime, not just size, marks a session as changed', async () => {
    // A same-size rewrite is rare but real (an edit in place); the cursor keys
    // on size AND mtime so it isn't missed.
    const sid = 'cc000000-0000-0000-0000-00000000000d';
    const file = await seedShared(sid, 1);
    const storage = makeStorageStub();
    const cursor = createSweepCursor();
    await sweepConversations({ ...opts(), storage, cursor });

    const future = new Date(Date.now() + 60_000);
    await utimes(file, future, future);
    const second = await sweepConversations({ ...opts(), storage, cursor });
    expect(second.captured).toEqual([sid]);
  });

  /**
   * INVARIANT: the sweep must NEVER capture lazy's own `claude -p` housekeeping
   * runs. Every accept writes a fidelity-summary session into the same shared
   * projects dir the sweep watches; capturing them made them ~83% of the store
   * and buried real builder conversations. They are marked at the source — see
   * src/import/machine-oneshot.ts.
   */
  describe('machine-generated one-shots', () => {
    test('skips a one-shot while still capturing the real session beside it', async () => {
      await seedShared(ONESHOT_SESSION, 1, oneshotBody(ONESHOT_SESSION, lazyRoot));
      await seedShared('d4444444-0000-0000-0000-00000000000e', 2);

      const storage = makeStorageStub();
      const result = await sweepConversations({ ...opts(), storage, cursor: createSweepCursor() });

      expect(result.captured).toEqual(['d4444444-0000-0000-0000-00000000000e']);
      expect(result.skippedMachineOneshots).toBe(1);
      expect(result.scanned).toBe(1); // one-shots are not even scanned candidates
      expect(storage.saved.has(ONESHOT_SESSION)).toBe(false);
    });

    test('never asks storage about a one-shot at all', async () => {
      // Not just "doesn't save" — a skipped session must cost nothing: no
      // isConversationImported round-trip, no parse.
      await seedShared(ONESHOT_SESSION, 1, oneshotBody(ONESHOT_SESSION, lazyRoot));
      const storage = makeStorageStub();
      await sweepConversations({ ...opts(), storage, cursor: createSweepCursor() });
      expect(storage.importedChecks).toBe(0);
      expect(storage.saveCalls).toEqual([]);
    });

    test('a one-shot stays skipped when it is re-swept after growing', async () => {
      const file = await seedShared(ONESHOT_SESSION, 1, oneshotBody(ONESHOT_SESSION, lazyRoot));
      const storage = makeStorageStub();
      const cursor = createSweepCursor();
      await sweepConversations({ ...opts(), storage, cursor });

      const future = new Date(Date.now() + 60_000);
      await utimes(file, future, future);
      const second = await sweepConversations({ ...opts(), storage, cursor });
      expect(second.captured).toEqual([]);
      expect(second.skippedMachineOneshots).toBe(1);
    });

    test('one-shots in a builder isolation dir are skipped too', async () => {
      await seedIsolation('builderA', ONESHOT_SESSION, 1, oneshotBody(ONESHOT_SESSION, lazyRoot));
      const storage = makeStorageStub();
      const result = await sweepConversations({ ...opts(), storage, cursor: createSweepCursor() });
      expect(result.captured).toEqual([]);
      expect(result.skippedMachineOneshots).toBe(1);
    });
  });
});

/**
 * INVARIANT: capture rot must FAIL `lazy doctor`, not warn. Conversation capture
 * has broken silently twice; both times it was found months later by accident.
 * Recent-and-still-missing is a current break; old-and-missing is recoverable
 * history; too-fresh is still in flight.
 */
describe('capture rot classification', () => {
  const now = 1_800_000_000_000;
  const at = (agoMs: number) => ({ sessionId: `s-${agoMs}`, mtimeMs: now - agoMs });

  test('recent, settled misses are rot', () => {
    const c = classifyMissingConversations([at(CAPTURE_SETTLE_MS + 60_000), at(60 * 60_000)], now);
    expect(c.rotted).toHaveLength(2);
    expect(c.historical).toHaveLength(0);
    expect(c.inFlight).toHaveLength(0);
  });

  test('a session written seconds ago is in flight, never rot', () => {
    const c = classifyMissingConversations([at(1_000), at(CAPTURE_SETTLE_MS - 1)], now);
    expect(c.inFlight).toHaveLength(2);
    expect(c.rotted).toHaveLength(0);
  });

  test('misses older than the window are recoverable history, not rot', () => {
    const c = classifyMissingConversations([at(CAPTURE_ROT_WINDOW_MS + 1), at(30 * 24 * 60 * 60_000)], now);
    expect(c.historical).toHaveLength(2);
    expect(c.rotted).toHaveLength(0);
  });

  test('no misses classifies to nothing at all', () => {
    expect(classifyMissingConversations([], now)).toEqual({ rotted: [], historical: [], inFlight: [] });
  });
});
