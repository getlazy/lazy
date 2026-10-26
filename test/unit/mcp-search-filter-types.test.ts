/**
 * Unit test: lazy_search's `filter` enum can select every entity type search emits.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createSearchHandler, searchTool, type McpToolContext } from '../../src/mcp/tools';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { testStorageOptions } from '../helpers/storage';
import { isolateLazyEnv } from '../helpers/isolated-lazy-env';

isolateLazyEnv();

// The handler's own plural-stripping, restated so the test fails if the enum and the
// entity types drift: any type search can emit must be reachable from some enum value.
const EMITTED_TYPES = ['task', 'prompt', 'turn', 'commit', 'comment', 'raised', 'conversation', 'memory', 'scratch', 'review_comment', 'artifact', 'message', 'journal'];
const IRREGULAR: Record<string, string> = { memories: 'memory', raised: 'raised', followups: 'raised' };
const typeOf = (f: string) => IRREGULAR[f] ?? f.replace(/s$/, '');

describe('lazy_search filter', () => {
  let dir: string;
  let storage: Storage;
  let ctx: McpToolContext;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lazy-mcp-filter-'));
    mkdirSync(join(dir, '.lazy'), { recursive: true });
    spawnSyncUnsupervised(['git', 'init'], { cwd: dir });
    spawnSyncUnsupervised(['git', 'config', 'user.name', 'T'], { cwd: dir });
    spawnSyncUnsupervised(['git', 'config', 'user.email', 't@example.com'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '#\n');
    spawnSyncUnsupervised(['git', 'add', '.'], { cwd: dir });
    spawnSyncUnsupervised(['git', 'commit', '-m', 'i'], { cwd: dir });
    storage = await createStorage(dir, testStorageOptions(dir));
    ctx = { taskId: '', worktreePath: dir, storage };
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // INVARIANT: every entity type search can emit is selectable through the filter enum,
  // so a new entity cannot be silently unfilterable.
  test('every emitted entity type is reachable from the enum', () => {
    const enumValues = (searchTool.inputSchema.properties as any).filter.enum as string[];
    const reachable = new Set(enumValues.map(typeOf));
    for (const t of EMITTED_TYPES) expect(reachable.has(t), t).toBe(true);
  });

  test('filtering an id search by journal and messages returns the hit', async () => {
    const task = await storage.createTask('Filter task');
    const journal = await storage.appendJournalEntry(task.id, 'a journal note');
    const message = await storage.createSystemMessage({ source: 't', title: 'T', body: 'b', kind: 'notice' });
    const run = createSearchHandler(ctx);

    const j = await run({ query: journal.id.slice(0, 8), filter: 'journal' }) as any;
    expect(j.results.map((r: any) => r.id)).toContain(journal.id);
    const m = await run({ query: message.id.slice(0, 8), filter: 'messages' }) as any;
    expect(m.results.map((r: any) => r.id)).toContain(message.id);
  });
});
