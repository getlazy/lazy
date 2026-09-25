import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { FileStorage } from '../../src/storage/file-storage';
import type { StoredConversation } from '../../src/storage/types';

/**
 * INVARIANT: the conversation listing index is derived, never a second source
 * of truth. Transcript files under conversations/ are what must survive; the
 * sidecar (conversations-index.json at the store root) is rebuilt when missing,
 * stale, or corrupt. A failed index write must not lose or corrupt a transcript.
 */

function makeConversation(overrides: Partial<StoredConversation> = {}): StoredConversation {
  const sessionId = overrides.sessionId ?? randomUUID();
  return {
    sessionId,
    projectPath: '-tmp',
    cwd: '/tmp',
    version: '1.0.0',
    gitBranch: 'main',
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T11:00:00.000Z',
    importedAt: 1,
    summary: 'hello from the human',
    stats: {
      messageCount: 1,
      userMessageCount: 1,
      assistantMessageCount: 0,
      subagentCount: 0,
      totalTokens: 10,
    },
    totalUsage: {
      inputTokens: 4,
      outputTokens: 6,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
    messages: [{
      uuid: randomUUID(),
      parentUuid: null,
      timestamp: '2026-09-01T10:00:00.000Z',
      role: 'user',
      text: 'hello from the human',
      model: null,
      usage: null,
    }],
    subagents: [],
    ...overrides,
  };
}

describe('FileStorage conversation listing index', () => {
  let root: string;
  let base: string;
  let storage: FileStorage;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'lazy-conv-index-'));
    base = join(root, 'store');
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(root, 'lazy.toml'),
      `[storage]\nbackend = "external"\nexternal_path = "${base}"\n`,
    );
    storage = new FileStorage(root, { basePath: base });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  function indexPath(): string {
    return join(base, 'conversations-index.json');
  }

  function transcriptPath(sessionId: string): string {
    return join(base, 'conversations', `${sessionId}.json`);
  }

  function readIndex(): { version: number; entries: Array<{ sessionId: string; summary: string }> } {
    return JSON.parse(readFileSync(indexPath(), 'utf-8'));
  }

  test('an empty store lists nothing and does not create an index file', async () => {
    expect(await storage.listConversationSummaries()).toEqual([]);
    expect(existsSync(indexPath())).toBe(false);
  });

  test('saveConversation writes a sidecar index of listing metadata', async () => {
    const conv = makeConversation({
      summary: 'what is left for the release?',
      messages: [{
        uuid: randomUUID(),
        parentUuid: null,
        timestamp: '2026-09-01T10:00:00.000Z',
        role: 'user',
        text: 'secret-transcript-body',
        model: null,
        usage: null,
      }],
    });
    await storage.saveConversation(conv);

    expect(existsSync(indexPath())).toBe(true);
    const index = readIndex();
    expect(index.version).toBe(1);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].sessionId).toBe(conv.sessionId);
    expect(index.entries[0].summary).toBe('what is left for the release?');
    expect(JSON.stringify(index)).not.toContain('secret-transcript-body');
  });

  test('listConversationSummaries matches listConversations metadata and omits transcripts', async () => {
    const older = makeConversation({
      sessionId: randomUUID(),
      startedAt: '2026-08-01T00:00:00.000Z',
      summary: 'older',
    });
    const newer = makeConversation({
      sessionId: randomUUID(),
      startedAt: '2026-09-01T00:00:00.000Z',
      summary: 'newer',
    });
    await storage.saveConversation(older);
    await storage.saveConversation(newer);

    const summaries = await storage.listConversationSummaries();
    const full = await storage.listConversations();
    expect(summaries.map((s) => s.sessionId)).toEqual(full.map((c) => c.sessionId));
    expect(summaries.map((s) => s.summary)).toEqual(['newer', 'older']);
    expect(summaries[0]).not.toHaveProperty('messages');
    expect(full[0].messages.length).toBeGreaterThan(0);
  });

  test('a missing index is rebuilt from transcript files', async () => {
    const conv = makeConversation();
    await storage.saveConversation(conv);
    unlinkSync(indexPath());
    expect(existsSync(indexPath())).toBe(false);

    const summaries = await storage.listConversationSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].sessionId).toBe(conv.sessionId);
    expect(existsSync(indexPath())).toBe(true);
    expect(readIndex().entries[0].sessionId).toBe(conv.sessionId);
  });

  test('a corrupt index is rebuilt rather than erroring', async () => {
    const conv = makeConversation({ summary: 'still listed' });
    await storage.saveConversation(conv);
    writeFileSync(indexPath(), '{not json');

    const summaries = await storage.listConversationSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summary).toBe('still listed');
    expect(readIndex().version).toBe(1);
  });

  test('an out-of-band transcript write is picked up as stale and rebuilt', async () => {
    const conv = makeConversation({ summary: 'original' });
    await storage.saveConversation(conv);

    const raw = JSON.parse(readFileSync(transcriptPath(conv.sessionId), 'utf-8')) as StoredConversation;
    raw.summary = 'changed on disk';
    writeFileSync(transcriptPath(conv.sessionId), JSON.stringify(raw, null, 2));

    const summaries = await storage.listConversationSummaries();
    expect(summaries[0].summary).toBe('changed on disk');
    expect(readIndex().entries[0].summary).toBe('changed on disk');
  });

  test('deleteConversation removes the transcript and the index entry', async () => {
    const keep = makeConversation({ summary: 'keep' });
    const drop = makeConversation({ summary: 'drop' });
    await storage.saveConversation(keep);
    await storage.saveConversation(drop);

    expect(await storage.deleteConversation(drop.sessionId)).toBe(true);
    expect(existsSync(transcriptPath(drop.sessionId))).toBe(false);
    expect(await storage.listConversationSummaries()).toEqual([
      expect.objectContaining({ sessionId: keep.sessionId, summary: 'keep' }),
    ]);
    expect(readIndex().entries.map((e) => e.sessionId)).toEqual([keep.sessionId]);
  });

  // INVARIANT: never-corrupt-storage. The index is derived. A failed index
  // write after a successful transcript write must leave the conversation
  // readable; the next list rebuilds from the files.
  test('a failed index write does not lose the conversation file', async () => {
    mkdirSync(indexPath());
    const conv = makeConversation({ summary: 'survived an index write failure' });
    await storage.saveConversation(conv);

    expect(await storage.loadConversation(conv.sessionId)).not.toBeNull();
    const summaries = await storage.listConversationSummaries();
    expect(summaries.map((s) => s.sessionId)).toEqual([conv.sessionId]);
    expect(summaries[0].summary).toBe('survived an index write failure');
  });

  test('the index file is not treated as a stored conversation', async () => {
    const conv = makeConversation();
    await storage.saveConversation(conv);
    expect(await storage.listConversations()).toHaveLength(1);
    expect((await storage.listConversations())[0].sessionId).toBe(conv.sessionId);
  });
});
