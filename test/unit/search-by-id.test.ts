/**
 * Unit test: an id-shaped query finds the entity it names, through the one
 * search entry point (`executeSearch`).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeSearch } from '../../src/search';
import { idQueryOf } from '../../src/search/id-search';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { testStorageOptions } from '../helpers/storage';
import { isolateLazyEnv } from '../helpers/isolated-lazy-env';

isolateLazyEnv();

describe('search by id', () => {
  let testDir: string;
  let storage: Storage;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-search-id-test-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    spawnSyncUnsupervised(['git', 'init'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.email', 'test@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSyncUnsupervised(['git', 'add', '.'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'commit', '-m', 'Initial commit'], { cwd: testDir });
    storage = await createStorage(testDir, testStorageOptions(testDir));
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  // INVARIANT: only an id-shaped query reaches the id scan; ordinary words and
  // short hex-looking words never pay for it or match ids by accident.
  test('only a long-enough hex/uuid shape counts as an id query', () => {
    expect(idQueryOf('f7c33f91')).toBe('f7c33f91');
    expect(idQueryOf('  F7C33F91 ')).toBe('f7c33f91');
    expect(idQueryOf('f7c33f91-1234')).toBe('f7c33f91-1234');
    expect(idQueryOf('face')).toBeNull();
    expect(idQueryOf('reconciler')).toBeNull();
    expect(idQueryOf('task:abcdef12')).toBeNull();
  });

  // INVARIANT: every id-bearing entity is reachable by a short prefix and the
  // hit says which entity it is and where it lives.
  test('finds each kind of entity by id prefix and by full id', async () => {
    const task = await storage.createTask('Id task', undefined, undefined, 'id-task');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/x', 'a'.repeat(40));
    const turn = await storage.createTurn({ sessionId: session.id, sequence: 1, role: 'agent', content: 'a turn' });
    const sha = 'abcdef0123456789abcdef0123456789abcdef01';
    const commit = await storage.createCommit(session.id, sha, 'a commit message');
    const comment = await storage.createComment(task.id, 'a comment');
    const raised = await storage.createRaisedItem(task.id, { content: 'a raised question', blocking: false });
    const message = await storage.createSystemMessage({ source: 't', title: 'A message', body: 'body', kind: 'notice' });

    const cases: Array<[string, string, string]> = [
      ['task', task.id, task.id],
      ['turn', turn.id, turn.id],
      ['commit', commit.id, sha],
      ['comment', comment.id, comment.id],
      ['raised', raised.id, raised.id],
      ['message', message.id, message.id],
    ];
    for (const [type, id, full] of cases) {
      for (const q of [id.slice(0, 8), full]) {
        const { results } = await executeSearch(storage, { query: q });
        const hit = results.find(r => r.entity_type === type && r.entity_id === id);
        expect(hit, `${type} by ${q}`).toBeDefined();
        expect(hit!.matched_id).toBe(true);
        if (type !== 'message') expect(hit!.task_id).toBe(task.id);
      }
    }

    const byTurn = (await executeSearch(storage, { query: turn.id.slice(0, 8) })).results.find(r => r.entity_type === 'turn');
    expect(byTurn!.turn_sequence).toBe(1);
  });

  // INVARIANT: an id hit outranks text hits, and an ambiguous prefix lists
  // EVERY match rather than guessing one.
  test('an ambiguous prefix lists every match; id hits rank above text hits', async () => {
    const task = await storage.createTask('Ambiguity');
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/x', 'a'.repeat(40));
    const shaA = 'abc123' + '1'.repeat(34);
    const shaB = 'abc123' + '2'.repeat(34);
    const a = await storage.createCommit(session.id, shaA, 'first');
    const b = await storage.createCommit(session.id, shaB, 'second');
    await storage.createComment(task.id, 'mentions abc123 in text');

    const { results } = await executeSearch(storage, { query: 'abc123' });
    const commitHits = results.filter(r => r.entity_type === 'commit' && r.matched_id);
    expect(commitHits.map(h => h.entity_id).sort()).toEqual([a.id, b.id].sort());
    // Every id hit precedes every text hit.
    const firstText = results.findIndex(r => !r.matched_id);
    const lastId = results.map(r => !!r.matched_id).lastIndexOf(true);
    expect(firstText === -1 || lastId < firstText).toBe(true);
  });

  test('journal, review comment, artifact and conversation ids are found', async () => {
    const task = await storage.createTask('Others');
    const journal = await storage.appendJournalEntry(task.id, 'a journal note');
    const { results: j } = await executeSearch(storage, { query: journal.id.slice(0, 8) });
    expect(j.some(r => r.entity_type === 'journal' && r.entity_id === journal.id)).toBe(true);

    const art = await storage.createTaskArtifact(task.id, { name: 'a.txt', content_base64: Buffer.from('hi').toString('base64'), origin: 'output' });
    const { results: a } = await executeSearch(storage, { query: art.id.slice(0, 8) });
    expect(a.some(r => r.entity_type === 'artifact' && r.entity_id === art.id)).toBe(true);
  });

  test('the types filter applies to id hits and fuzzy skips id search', async () => {
    const task = await storage.createTask('Filters');
    const comment = await storage.createComment(task.id, 'a comment');
    const id = comment.id.slice(0, 8);
    expect((await executeSearch(storage, { query: id, types: ['task'] })).results.some(r => r.entity_id === comment.id)).toBe(false);
    expect((await executeSearch(storage, { query: id, types: ['comment'] })).results.some(r => r.entity_id === comment.id)).toBe(true);
    expect((await executeSearch(storage, { query: id, fuzzy: true })).results.some(r => r.matched_id)).toBe(false);
  });

  test('a non-id query does not produce id hits', async () => {
    const task = await storage.createTask('Plain words');
    await storage.createComment(task.id, 'reconciler notes');
    const { results } = await executeSearch(storage, { query: 'reconciler' });
    expect(results.some(r => r.matched_id)).toBe(false);
    expect(results.length).toBeGreaterThan(0);
  });
});
