/**
 * INVARIANTS for capturing the builder scratch dir into the project store.
 *
 * The load-bearing ones:
 *
 * 1. **Bounded by construction.** The store travels with the project and gets
 *    pushed around; an unbounded stream in it once grew the store to 677 MiB
 *    and broke a push. Scratch is capped per-file and per-sandbox, and the caps
 *    are not configurable.
 * 2. **Whole or not at all.** Content is never truncated to fit. A file that
 *    cannot be persisted is recorded BY NAME with a reason, and a warning says
 *    so — a silently-unpersisted artifact must never look persisted.
 * 3. **Capture never deletes.** The store outliving the live directory is the
 *    entire point; a `rm` in the scratch dir must not destroy an artifact the
 *    engineer was about to read. Removal is explicit (`lazy scratch rm`).
 * 4. **The builder↔human boundary survives.** Making scratch durable and
 *    searchable did not make it an agent channel: `lazy_scratch` and the
 *    `in:scratch` search scope are rejected for a task agent, server-side.
 *
 * Do not weaken these to accommodate a change — each is a design reversal.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { mkdir, writeFile, rm, symlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { syncScratchDir } from '../../src/builder/scratch-sync';
import {
  MAX_SCRATCH_FILE_BYTES,
  MAX_SCRATCH_SANDBOX_BYTES,
  assertScratchFileWithinCap,
  formatBytes,
} from '../../src/builder/scratch-limits';
import { createAllHandlers, type McpToolContext } from '../../src/mcp/tools';
import type { Task, ScratchFile, ScratchFileInput, Actor } from '../../src/types';

describe('builder scratch capture', () => {
  let testDir: string;
  let scratchDir: string;
  let storage: Storage;
  let task: Task;

  const sync = () => syncScratchDir({ scratchDir, storage, actor: 'builder', sessionId: 'sess-1' });

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-scratch-test-'));
    mkdirSync(join(testDir, '.lazy'), { recursive: true });
    spawnSyncUnsupervised(['git', 'init'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'config', 'user.email', 't@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSyncUnsupervised(['git', 'add', '.'], { cwd: testDir });
    spawnSyncUnsupervised(['git', 'commit', '-m', 'Initial'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external' });
    task = await storage.createTask('Test task', undefined, undefined, 'test-task');

    scratchDir = mkdtempSync(join(tmpdir(), 'lazy-scratch-dir-'));
  });

  afterEach(async () => {
    if (storage) await storage.close();
    if (testDir) rmSync(testDir, { recursive: true, force: true });
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  });

  // --- The ordinary path -------------------------------------------------

  test('captures text files with provenance, nested paths included', async () => {
    await writeFile(join(scratchDir, 'accept-foo.md'), '# Accept\n\nLooks good.\n');
    await mkdir(join(scratchDir, 'notes'), { recursive: true });
    await writeFile(join(scratchDir, 'notes', 'analysis.txt'), 'the numbers\n');

    const result = await sync();

    expect(result.stored.map(e => e.path).sort()).toEqual(['accept-foo.md', 'notes/analysis.txt']);
    expect(result.skipped).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);

    const stored = await storage.getScratchFile('accept-foo.md');
    expect(stored?.content).toBe('# Accept\n\nLooks good.\n');
    expect(stored?.skipped).toBeUndefined();
    expect(stored?.session_id).toBe('sess-1');
    expect(stored?.updated_by).toBe('builder');

    // Nested paths are forward-slashed regardless of platform separator, so a
    // stored path is the same string a builder or the CLI would type.
    expect((await storage.listScratchFiles()).map(f => f.path)).toContain('notes/analysis.txt');
  });

  test('an unchanged file is not rewritten on the next pass', async () => {
    await writeFile(join(scratchDir, 'note.md'), 'stable\n');
    await sync();
    const first = await storage.getScratchFile('note.md');

    const second = await sync();
    expect(second.stored).toHaveLength(0);
    expect(second.unchanged).toBe(1);

    // updated_at is what tells the engineer when an artifact last changed —
    // a no-op sync every 30s must not churn it.
    expect((await storage.getScratchFile('note.md'))?.updated_at).toBe(first!.updated_at);
  });

  test('an edited file is re-stored', async () => {
    await writeFile(join(scratchDir, 'note.md'), 'v1\n');
    await sync();
    await writeFile(join(scratchDir, 'note.md'), 'v2\n');

    const result = await sync();
    expect(result.stored.map(e => e.path)).toEqual(['note.md']);
    expect((await storage.getScratchFile('note.md'))?.content).toBe('v2\n');
  });

  // --- INVARIANT: capture never deletes ----------------------------------

  test('removing a file from the live dir leaves the captured copy', async () => {
    await writeFile(join(scratchDir, 'gone.md'), 'read me later\n');
    await sync();

    await rm(join(scratchDir, 'gone.md'));
    await writeFile(join(scratchDir, 'other.md'), 'still here\n');
    await sync();

    const still = await storage.getScratchFile('gone.md');
    expect(still?.content).toBe('read me later\n');
  });

  test('an empty or missing scratch dir is a no-op, not an error', async () => {
    const empty = await sync();
    expect(empty).toEqual({ stored: [], skipped: [], unchanged: 0, warnings: [] });

    rmSync(scratchDir, { recursive: true, force: true });
    const missing = await sync();
    expect(missing.stored).toHaveLength(0);
  });

  // --- INVARIANT: whole or not at all ------------------------------------

  test('a file over the per-file cap is recorded by name only, with a warning', async () => {
    const big = 'x'.repeat(MAX_SCRATCH_FILE_BYTES + 1);
    await writeFile(join(scratchDir, 'dump.log'), big);

    const result = await sync();

    expect(result.stored).toHaveLength(0);
    expect(result.skipped).toEqual([
      { path: 'dump.log', size: big.length, skipped: 'too_large' },
    ]);

    const record = await storage.getScratchFile('dump.log');
    expect(record?.skipped).toBe('too_large');
    // NOT a truncated body: the content is empty and the true size is recorded.
    expect(record?.content).toBe('');
    expect(record?.size).toBe(big.length);

    // The warning must name the file, the cap, and where the body still is.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('dump.log');
    expect(result.warnings[0]).toContain(formatBytes(MAX_SCRATCH_FILE_BYTES));
    expect(result.warnings[0]).toContain(join(scratchDir, 'dump.log'));
  });

  test('a binary file is recorded by name only, with a warning', async () => {
    // Invalid UTF-8: a lone continuation byte. Node's lossy decoder would turn
    // this into U+FFFD rather than fail, which is why detection is fatal-mode.
    await writeFile(join(scratchDir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0xff, 0xfe]));

    const result = await sync();

    expect(result.skipped.map(e => e.skipped)).toEqual(['binary']);
    expect((await storage.getScratchFile('shot.png'))?.content).toBe('');
    expect(result.warnings[0]).toContain('not UTF-8');
  });

  test('an unchanged skipped record is not rewritten either', async () => {
    await writeFile(join(scratchDir, 'shot.png'), Buffer.from([0xff, 0xfe, 0x00]));
    await sync();

    const second = await sync();
    expect(second.skipped).toHaveLength(0);
    expect(second.unchanged).toBe(1);
    expect(second.warnings).toHaveLength(0);
  });

  test('assertScratchFileWithinCap throws rather than trimming', () => {
    expect(() => assertScratchFileWithinCap({
      path: 'huge.md',
      content: 'y'.repeat(MAX_SCRATCH_FILE_BYTES + 1),
    })).toThrow(/per-file cap/i);

    // The storage layer enforces it for EVERY caller, not just capture.
    expect(storage.saveScratchFile(
      { path: 'huge.md', content: 'y'.repeat(MAX_SCRATCH_FILE_BYTES + 1), size: 1 },
      'builder',
    )).rejects.toThrow(/per-file cap/i);
  });

  // --- Not content -------------------------------------------------------

  test('dotfiles and symlinks are not captured', async () => {
    await writeFile(join(scratchDir, '.DS_Store'), 'noise\n');
    await mkdir(join(scratchDir, '.git'), { recursive: true });
    await writeFile(join(scratchDir, '.git', 'config'), 'secret\n');
    await writeFile(join(testDir, 'outside.txt'), 'repository content\n');
    await symlink(join(testDir, 'outside.txt'), join(scratchDir, 'link.txt'));
    await writeFile(join(scratchDir, 'real.md'), 'content\n');

    const result = await sync();

    // A symlink would otherwise pull repo or $HOME content into the store.
    expect(result.stored.map(e => e.path)).toEqual(['real.md']);
    expect(await storage.getScratchFile('link.txt')).toBeNull();
    expect(await storage.getScratchFile('.DS_Store')).toBeNull();
  });

  // --- The MCP boundary --------------------------------------------------

  const agentCtx = (): McpToolContext => ({ taskId: task.id, worktreePath: testDir, storage });
  const builderCtx = (): McpToolContext => ({ taskId: '', worktreePath: testDir, storage });

  test('lazy_scratch lists and reads for the builder', async () => {
    await writeFile(join(scratchDir, 'accept-foo.md'), 'the message\n');
    await sync();

    const scratch = createAllHandlers(builderCtx()).get('lazy_scratch')!;

    const list = (await scratch({})) as any;
    expect(list.total).toBe(1);
    expect(list.files[0].path).toBe('accept-foo.md');

    const one = (await scratch({ path: 'accept-foo.md' })) as any;
    expect(one.content).toBe('the message\n');

    await expect(scratch({ path: 'nope.md' })).rejects.toThrow(/No captured scratch file/);
  });

  // INVARIANT (builder↔human boundary): scratch is not a channel to agents.
  // Gating only the tool would leave `in:scratch` as a hole, so BOTH are shut.
  test('lazy_scratch is REJECTED for task agents', async () => {
    const scratch = createAllHandlers(agentCtx()).get('lazy_scratch')!;
    await expect(scratch({})).rejects.toThrow(/not readable by task agents/i);
  });

  test('in:scratch search is REJECTED for task agents, and scratch hits are filtered out', async () => {
    await writeFile(join(scratchDir, 'secret-notes.md'), 'zamboni handoff details\n');
    await sync();

    const agentSearch = createAllHandlers(agentCtx()).get('lazy_search')!;
    await expect(agentSearch({ query: 'in:scratch zamboni' }))
      .rejects.toThrow(/not searchable by task agents/i);
    await expect(agentSearch({ query: 'zamboni', filter: 'scratch' }))
      .rejects.toThrow(/not searchable by task agents/i);

    // A plain query that would otherwise MATCH scratch content returns nothing
    // from scratch — the boundary is not just about the `in:` spelling.
    const plain = (await agentSearch({ query: 'zamboni' })) as any;
    expect((plain.results ?? []).some((r: any) => r.type === 'scratch')).toBe(false);

    const fuzzy = (await agentSearch({ query: 'zamboni', fuzzy: true })) as any;
    expect((fuzzy.results ?? []).some((r: any) => r.type === 'scratch')).toBe(false);

    // The builder, by contrast, finds it.
    const builderSearch = createAllHandlers(builderCtx()).get('lazy_search')!;
    const found = (await builderSearch({ query: 'in:scratch zamboni' })) as any;
    expect(found.results.some((r: any) => r.type === 'scratch')).toBe(true);
  });
});

// --- INVARIANT: the sandbox budget is seeded from the store ---------------
//
// Driven against a stub rather than FileStorage: proving the 32 MiB cap with
// real files would mean writing (and JSON round-tripping) 32 MiB per assertion.
// The behaviour under test is entirely in syncScratchDir's accounting.
describe('builder scratch sandbox budget', () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'lazy-scratch-budget-'));
  });
  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  /** Minimal Storage stub exposing only the scratch methods sync uses. */
  function stubStorage(seed: ScratchFile[] = []) {
    const files = new Map(seed.map(f => [f.path, f]));
    return {
      files,
      listScratchFiles: async () => [...files.values()],
      saveScratchFile: async (input: ScratchFileInput, actor: Actor) => {
        const record: ScratchFile = {
          path: input.path,
          content: input.content,
          size: input.size,
          ...(input.skipped ? { skipped: input.skipped } : {}),
          created_at: files.get(input.path)?.created_at ?? 1,
          updated_at: 2,
          updated_by: actor,
        };
        files.set(input.path, record);
        return record;
      },
    } as unknown as Storage & { files: Map<string, ScratchFile> };
  }

  function seededFull(): ScratchFile {
    return {
      path: 'already-there.md',
      content: 'z'.repeat(MAX_SCRATCH_SANDBOX_BYTES - 10),
      size: MAX_SCRATCH_SANDBOX_BYTES - 10,
      created_at: 1,
      updated_at: 1,
      updated_by: 'builder',
    };
  }

  test('a file past the sandbox cap is recorded by name only, with a warning', async () => {
    const storage = stubStorage([seededFull()]);
    await writeFile(join(scratchDir, 'new.md'), 'x'.repeat(100));

    const result = await syncScratchDir({ scratchDir, storage, actor: 'builder' });

    expect(result.stored).toHaveLength(0);
    expect(result.skipped).toEqual([{ path: 'new.md', size: 100, skipped: 'sandbox_full' }]);
    expect(storage.files.get('new.md')!.content).toBe('');
    expect(result.warnings[0]).toContain('lazy scratch rm');
    expect(result.warnings[0]).toContain(formatBytes(MAX_SCRATCH_SANDBOX_BYTES));

    // Seeding the budget from the STORE (not tracking it incrementally) is what
    // stops repeated passes from walking past the cap one file at a time.
    const second = await syncScratchDir({ scratchDir, storage, actor: 'builder' });
    expect(second.unchanged).toBe(1);
    expect(second.stored).toHaveLength(0);
  });

  test('smallest first: one huge dump does not starve the ordinary documents', async () => {
    // Room for a little more than the small note, but nowhere near the dump.
    const headroom = 2000;
    const seed: ScratchFile = {
      path: 'seed.md',
      content: 'z'.repeat(MAX_SCRATCH_SANDBOX_BYTES - headroom),
      size: MAX_SCRATCH_SANDBOX_BYTES - headroom,
      created_at: 1,
      updated_at: 1,
      updated_by: 'builder',
    };
    const storage = stubStorage([seed]);

    // 'a-dump.md' sorts FIRST alphabetically and is written FIRST — only the
    // size ordering saves the note.
    await writeFile(join(scratchDir, 'a-dump.md'), 'x'.repeat(headroom - 1));
    await writeFile(join(scratchDir, 'z-note.md'), 'the note\n');

    const result = await syncScratchDir({ scratchDir, storage, actor: 'builder' });

    expect(result.stored.map(e => e.path)).toEqual(['z-note.md']);
    expect(result.skipped.map(e => e.path)).toEqual(['a-dump.md']);
    expect(storage.files.get('z-note.md')!.content).toBe('the note\n');
  });
});
