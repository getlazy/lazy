import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage/file-storage';
import { parseConversation, extractSummary, conversationStats } from '../../src/import/claude-code-logs';
import { toStoredConversation } from '../../src/import/conversation-storage';
import { stitchBuilders, lineageFromMessages, LineageCollector } from '../../src/builder/identity';
import { resolveBuilderTranscript } from '../../src/builder/identity-transcript';
import { groupScratchBySession } from '../../src/builder/scratch-view';
import type { BuilderSession, StoredConversation } from '../../src/storage/types';

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'builder-segments');
const A = 'aaaaaaaa-0000-4000-8000-000000000001'; // fresh start
const B = 'bbbbbbbb-0000-4000-8000-000000000002'; // compaction of A
const C = 'cccccccc-0000-4000-8000-000000000003'; // resume of B (leafUuid)
const D = 'dddddddd-0000-4000-8000-000000000004'; // /clear: new Builder
const E = 'eeeeeeee-0000-4000-8000-000000000005'; // legacy copy-on-resume of D
/** A fixture record uuid by its short tag (see the fixtures README). */
const U = (tag: string) => `00000000-0000-4000-8000-0000000000${tag}`;

let root: string;
let base: string;
let projects: string;
let storage: FileStorage;

async function segment(id: string): Promise<StoredConversation> {
  const parsed = await parseConversation('-repo', id, projects);
  return toStoredConversation(parsed, extractSummary(parsed), conversationStats(parsed));
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'lazy-builder-identity-'));
  base = join(root, 'store');
  projects = join(root, 'projects');
  mkdirSync(base, { recursive: true });
  mkdirSync(join(projects, '-repo'), { recursive: true });
  for (const f of readdirSync(FIXTURES)) {
    if (f.endsWith('.jsonl')) copyFileSync(join(FIXTURES, f), join(projects, '-repo', f));
  }
  writeFileSync(join(root, 'lazy.toml'), `[storage]\nbackend = "external"\nexternal_path = "${base}"\n`);
  storage = new FileStorage(root, { basePath: base });
  await storage.initialize();
});

afterEach(async () => {
  await storage.close();
  rmSync(root, { recursive: true, force: true });
});

describe('segment lineage', () => {
  test('a compaction segment references the record before the boundary', async () => {
    const b = await segment(B);
    expect(b.lineage?.externalRefs).toEqual([U('a4')]);
    expect(b.lineage?.firstUuid).toBe(U('b0'));
  });

  test('a /clear segment points nowhere outside itself', async () => {
    const d = await segment(D);
    expect(d.lineage?.externalRefs).toEqual([]);
    expect(d.lineage?.forkedFromSessionIds).toEqual([]);
  });

  test('forkedFrom names the session a branch was cut from', () => {
    const c = new LineageCollector();
    c.observe({ uuid: 'x1', parentUuid: null, forkedFrom: { sessionId: 'orig', messageUuid: 'm9' } });
    expect(c.finish('mine')).toMatchObject({ forkedFromSessionIds: ['orig'], externalRefs: ['m9'] });
  });
});

describe('stitching', () => {
  // INVARIANT: /clear starts a new Builder; compaction and resume continue the
  // current one. A Builder is the conversation a human had, never a session file.
  test('compaction and resume continue a Builder; /clear starts a new one', async () => {
    const segs = await Promise.all([A, B, C, D, E].map(segment));
    const builders = stitchBuilders(segs.map((s) => ({ ...s, lineage: s.lineage! })));
    expect(builders.map((b) => b.segments)).toEqual([[D, E], [A, B, C]]);
  });

  // INVARIANT: a Builder's id is its FIRST segment's session id, so it never
  // changes as later segments join it.
  test('the Builder id is the first segment and survives new segments', async () => {
    const [a, b] = await Promise.all([A, B].map(segment));
    const before = stitchBuilders([{ ...a, lineage: a.lineage! }]);
    const after = stitchBuilders([a, b].map((s) => ({ ...s, lineage: s.lineage! })));
    expect(before[0].id).toBe(A);
    expect(after[0].id).toBe(A);
    expect(after[0].title).toBe('Plan the builder identity work');
  });

  test('segments captured before lineage was recorded still fold by shared history', async () => {
    const [d, e] = await Promise.all([D, E].map(segment));
    const legacy = [d, e].map((s) => ({ ...s, lineage: lineageFromMessages(s.messages) }));
    expect(stitchBuilders(legacy).map((b) => b.segments)).toEqual([[D, E]]);
  });
});

describe('stitching edge cases', () => {
  const seg = (sessionId: string, startedAt: string, endedAt: string, lineage: Partial<import('../../src/builder/identity').SegmentLineage>) => ({
    sessionId, startedAt, endedAt, summary: sessionId,
    lineage: { firstUuid: null, tailUuids: [], externalRefs: [], forkedFromSessionIds: [], ...lineage },
  });

  // INVARIANT: leafUuid is never lineage. last-prompt records name the file's
  // own leaf and summary records may name other conversations; a /clear that
  // carries one must still start a new Builder.
  test('a /clear carrying a leafUuid of another segment stays its own Builder', () => {
    const c = new LineageCollector();
    c.observe({ type: 'summary', summary: 'older title', leafUuid: U('a4') });
    c.observe({ type: 'last-prompt', leafUuid: U('a4') });
    c.observe({ type: 'user', uuid: U('f1'), parentUuid: null });
    const clear = c.finish('ffffffff-0000-4000-8000-000000000006');
    expect(clear.externalRefs).toEqual([]);
    const builders = stitchBuilders([
      seg(A, '2026-09-26T10:00:00Z', '2026-09-26T10:01:00Z', { firstUuid: U('a1'), tailUuids: [U('a1'), U('a4')] }),
      { ...seg('ffffffff-0000-4000-8000-000000000006', '2026-09-26T11:00:00Z', '2026-09-26T11:01:00Z', {}), lineage: clear },
    ]);
    expect(builders).toHaveLength(2);
  });

  test('a copy-on-resume whose id sorts first still leaves the original as the Builder id', () => {
    const shared = { firstUuid: U('d1'), tailUuids: [U('d1'), U('d2')] };
    const original = seg('99999999-0000-4000-8000-000000000009', '2026-09-26T13:00:00Z', '2026-09-26T13:00:02Z', shared);
    const copy = seg('11111111-0000-4000-8000-000000000001', '2026-09-26T13:00:00Z', '2026-09-26T14:00:00Z', { ...shared, tailUuids: [...shared.tailUuids, U('e1')] });
    const [b] = stitchBuilders([copy, original]);
    expect(b.id).toBe(original.sessionId);
    expect(b.segments).toEqual([original.sessionId, copy.sessionId]);
  });

  test('non-UUID message ids (Pi) never join segments by message-derived lineage', () => {
    const msgs = [{ uuid: 'a1b2c3d4', parentUuid: null }, { uuid: 'e5f6a7b8', parentUuid: 'a1b2c3d4' }];
    const l = lineageFromMessages(msgs);
    expect(l).toEqual({ firstUuid: null, tailUuids: [], externalRefs: [], forkedFromSessionIds: [] });
    const builders = stitchBuilders([
      { ...seg('p1', '2026-09-26T10:00:00Z', '2026-09-26T10:00:00Z', {}), lineage: l },
      { ...seg('p2', '2026-09-26T11:00:00Z', '2026-09-26T11:00:00Z', {}), lineage: lineageFromMessages(msgs) },
    ]);
    expect(builders).toHaveLength(2);
  });
});

describe('Storage Builders', () => {
  async function saveAll(): Promise<void> {
    for (const id of [A, B, C, D, E]) await storage.saveConversation(await segment(id));
  }

  test('listBuilders returns one row per Builder with summed stats', async () => {
    await saveAll();
    const builders = await storage.listBuilders();
    expect(builders.map((b) => b.id)).toEqual([D, A]);
    const first = builders[1];
    expect(first.segments).toEqual([A, B, C]);
    expect(first.stats.userMessageCount).toBe(3);
    expect(first.run).toBeNull();
  });

  test('getBuilder resolves any segment id or a unique prefix to its Builder', async () => {
    await saveAll();
    expect((await storage.getBuilder(C))?.id).toBe(A);
    expect((await storage.getBuilder('cccc'))?.id).toBe(A);
    expect(await storage.getBuilder('ffff')).toBeNull();
  });

  test('segments stored without lineage fold into Builders with no re-import', async () => {
    for (const id of [D, E]) {
      const { lineage: _drop, ...legacy } = await segment(id);
      await storage.saveConversation(legacy as StoredConversation);
    }
    expect((await storage.listBuilders()).map((b) => b.segments)).toEqual([[D, E]]);
  });

  test('the live run is a badge on the Builder it is in', async () => {
    await saveAll();
    const now = new Date().toISOString();
    const run: BuilderSession = {
      id: 'run-1', projectRoot: root, memberEmail: null, kind: 'interactive', state: 'running',
      containerName: 'lazy-builder-x', builderId: 'x', agentSessionId: C,
      createdAt: now, updatedAt: now, endedAt: null,
    };
    await storage.createBuilderSession(run);
    const builders = await storage.listBuilders();
    expect(builders.find((b) => b.id === A)?.run).toEqual({ id: 'run-1', state: 'running', live: true });
    expect(builders.find((b) => b.id === D)?.run).toBeNull();
  });

  // INVARIANT: promote numbers messages the way the caller showed them — a
  // Builder id over the joined transcript, a later segment's exact id over that
  // segment alone (Teams still renders one segment per page).
  test('promote numbers over the Builder, or over one later segment named exactly', async () => {
    await saveAll();
    const viaBuilder = await storage.promoteConversation(A, { from: 5, to: 5, actor: 'human' });
    expect(viaBuilder.session_id).toBe(A);
    expect(viaBuilder.task.prompt).toContain('Where were we?');
    const viaSegment = await storage.promoteConversation(C, { from: 1, to: 1, actor: 'human' });
    expect(viaSegment.session_id).toBe(C);
    expect(viaSegment.task.prompt).toContain('Where were we?');
  });

  test('the joined transcript spans every segment and drops copied history', async () => {
    await saveAll();
    const one = await resolveBuilderTranscript(storage, B);
    if (!one || 'ambiguous' in one) throw new Error('expected a Builder');
    expect(one.conversation.sessionId).toBe(A);
    expect(one.conversation.messages.map((m) => m.text)).toContain('Where were we?');
    const two = await resolveBuilderTranscript(storage, E);
    if (!two || 'ambiguous' in two) throw new Error('expected a Builder');
    expect(two.conversation.messages.map((m) => m.uuid)).toEqual([U('d1'), U('d2'), U('e1')]);
  });
});

describe('scratch provenance', () => {
  // INVARIANT: a scratch file's provenance is the Builder that wrote it, so a
  // compaction mid-conversation does not move the file to another "owner".
  test('a file written in a later segment is stamped with the Builder id', async () => {
    for (const id of [A, B]) await storage.saveConversation(await segment(id));
    const file = await storage.saveScratchFile(
      { path: 'digest.md', content: 'x', size: 1, session_id: B }, 'builder',
    );
    expect(file.session_id).toBe(B);
    expect(file.builder_id).toBe(A);
  });

  test('an unknown segment is left unstamped rather than guessed', async () => {
    const file = await storage.saveScratchFile(
      { path: 'n.md', content: 'x', size: 1, session_id: 'not-captured' }, 'builder',
    );
    expect(file.builder_id).toBeUndefined();
  });

  test('files from two segments of one Builder list in one group', async () => {
    for (const id of [A, B]) await storage.saveConversation(await segment(id));
    const files = [
      { path: 'a.md', content: '', size: 0, session_id: A, created_at: 1, updated_at: 1, updated_by: 'builder' as const },
      { path: 'b.md', content: '', size: 0, session_id: B, created_at: 2, updated_at: 2, updated_by: 'builder' as const },
    ];
    const groups = groupScratchBySession(files, await storage.listBuilders());
    expect(groups).toHaveLength(1);
    expect(groups[0].builder_id).toBe(A);
  });
});
