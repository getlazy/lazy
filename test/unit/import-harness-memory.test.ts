/**
 * INVARIANTS for the one-time harness-memory import.
 *
 * Harness memory lived in `<projects-root>/<encoded-cwd>/memory/*.md`, which in
 * lazy sits inside a per-builder overlay — unshared, invisible to agents, and
 * pruned on a timer. The import lifts those files into lazy-owned memory.
 *
 * It MUST be idempotent (doctor can offer it any time and a second run must be
 * a no-op) and must scan BOTH the shared `~/.claude/projects` dir and every
 * per-builder isolation dir under `<data>/builder-projects/`, deduping by
 * record name — the same roots the conversation re-import scans.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createStorage, type Storage } from '../../src/storage';
import { spawnSync } from '../../src/utils/spawn';
import {
  parseHarnessMemory,
  discoverHarnessMemoryFiles,
  importHarnessMemory,
  countImportableMemories,
  formatLongDescriptionNotice,
} from '../../src/import/import-harness-memory';
import { MAX_MEMORY_DESCRIPTION_LENGTH } from '../../src/memory';
import { encodeProjectPath } from '../../src/import/claude-code-logs';

describe('parseHarnessMemory', () => {
  test('parses the frontmatter format the harness writes', () => {
    const parsed = parseHarnessMemory([
      '---',
      'name: vm-credentials-idea',
      'description: Inject VM credentials at boot',
      'metadata:',
      '  type: project',
      '---',
      '',
      'Credentials should be injected at boot time.',
    ].join('\n'));

    expect(parsed.name).toBe('vm-credentials-idea');
    expect(parsed.description).toBe('Inject VM credentials at boot');
    expect(parsed.type).toBe('project');
    expect(parsed.body).toBe('Credentials should be injected at boot time.');
  });

  // A file with no frontmatter still holds real knowledge — import the body
  // rather than dropping the record (dropping is the loss this repairs).
  test('a file without frontmatter still yields a body', () => {
    const parsed = parseHarnessMemory('Just some remembered fact.\n');
    expect(parsed.body).toBe('Just some remembered fact.');
    expect(parsed.name).toBeUndefined();
  });

  // An unknown type must not throw away the record; the caller defaults it.
  test('an unknown type is ignored rather than fatal', () => {
    const parsed = parseHarnessMemory('---\nname: x\nmetadata:\n  type: bogus\n---\nbody\n');
    expect(parsed.type).toBeUndefined();
    expect(parsed.body).toBe('body');
  });
});

describe('harness memory import', () => {
  let testDir: string;
  let homeDir: string;
  let dataDir: string;
  let storage: Storage;

  /** Write a harness memory file under a projects-dir-shaped root. */
  function writeMemoryFile(projectsRoot: string, fileName: string, content: string, mtimeSec?: number): string {
    const dir = join(projectsRoot, encodeProjectPath(testDir), 'memory');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, fileName);
    writeFileSync(path, content);
    if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
    return path;
  }

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'lazy-memimport-'));
    homeDir = mkdtempSync(join(tmpdir(), 'lazy-memimport-home-'));
    dataDir = join(testDir, '.lazy');
    mkdirSync(dataDir, { recursive: true });
    spawnSync(['git', 'init'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: testDir });
    spawnSync(['git', 'config', 'user.email', 't@example.com'], { cwd: testDir });
    writeFileSync(join(testDir, 'README.md'), '# Test\n');
    spawnSync(['git', 'add', '.'], { cwd: testDir });
    spawnSync(['git', 'commit', '-m', 'Initial'], { cwd: testDir });

    storage = await createStorage(testDir, { backend: 'external' });
  });

  afterEach(async () => {
    if (storage) await storage.close();
    for (const dir of [testDir, homeDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  const opts = () => ({ lazyRoot: testDir, dataDirAbs: dataDir, homeDirAbs: homeDir, storage });

  test('imports records from the shared ~/.claude/projects dir', async () => {
    writeMemoryFile(
      join(homeDir, '.claude', 'projects'),
      'vm-credentials-idea.md',
      '---\nname: vm-credentials-idea\ndescription: Inject VM credentials at boot\nmetadata:\n  type: project\n---\n\nBody text.\n',
    );

    const report = await importHarnessMemory(opts());
    expect(report.found).toBe(1);
    expect(report.imported.map(i => i.name)).toEqual(['vm-credentials-idea']);

    const record = await storage.getMemory('vm-credentials-idea');
    expect(record?.description).toBe('Inject VM credentials at boot');
    expect(record?.type).toBe('project');
    expect(record?.body).toBe('Body text.');
    // Lazy performed the write; claiming a human or builder authored it would
    // falsify the append-only history.
    expect(record?.created_by).toBe('system');
  });

  test('scans per-builder isolation dirs too', async () => {
    writeMemoryFile(
      join(dataDir, 'builder-projects', 'builder-1'),
      'overlay-only.md',
      '---\nname: overlay-only\ndescription: Only ever existed in an overlay\nmetadata:\n  type: feedback\n---\n\nOverlay body.\n',
    );

    const report = await importHarnessMemory(opts());
    expect(report.imported.map(i => i.name)).toEqual(['overlay-only']);
    expect((await storage.getMemory('overlay-only'))?.type).toBe('feedback');
  });

  // The same record is seeded into many overlays; the newest copy is the real one.
  test('dedupes the same record across roots, newest copy wins', async () => {
    writeMemoryFile(
      join(dataDir, 'builder-projects', 'builder-old'),
      'shared-note.md',
      '---\nname: shared-note\ndescription: Old copy\nmetadata:\n  type: project\n---\n\nOld body.\n',
      1_600_000_000,
    );
    writeMemoryFile(
      join(dataDir, 'builder-projects', 'builder-new'),
      'shared-note.md',
      '---\nname: shared-note\ndescription: New copy\nmetadata:\n  type: project\n---\n\nNew body.\n',
      1_700_000_000,
    );

    const found = await discoverHarnessMemoryFiles({ lazyRoot: testDir, dataDirAbs: dataDir, homeDirAbs: homeDir });
    expect(found).toHaveLength(1);

    await importHarnessMemory(opts());
    expect((await storage.getMemory('shared-note'))?.body).toBe('New body.');
  });

  // MEMORY.md is the harness's rendered index of the other files, not a record.
  test('skips the harness MEMORY.md index file', async () => {
    const root = join(homeDir, '.claude', 'projects');
    writeMemoryFile(root, 'MEMORY.md', '- [A note](a-note.md) — hook\n');
    writeMemoryFile(root, 'a-note.md', '---\nname: a-note\ndescription: A note\nmetadata:\n  type: project\n---\n\nBody.\n');

    const report = await importHarnessMemory(opts());
    expect(report.imported.map(i => i.name)).toEqual(['a-note']);
    expect(await storage.getMemory('memory')).toBeNull();
  });

  // INVARIANT: idempotent. Doctor may offer the import at any time; a second run
  // must not duplicate records or clobber later human edits.
  test('is idempotent — a second run imports nothing', async () => {
    writeMemoryFile(
      join(homeDir, '.claude', 'projects'),
      'a-note.md',
      '---\nname: a-note\ndescription: A note\nmetadata:\n  type: project\n---\n\nBody.\n',
    );

    const first = await importHarnessMemory(opts());
    expect(first.imported).toHaveLength(1);
    expect(await countImportableMemories(opts())).toBe(0);

    // A human edits the record after the import — the second run must not undo it.
    await storage.saveMemory(
      { name: 'a-note', description: 'A note', type: 'project', body: 'Human-edited body.' },
      'human',
    );

    const second = await importHarnessMemory(opts());
    expect(second.imported).toHaveLength(0);
    expect(second.skippedExisting).toEqual(['a-note']);
    expect((await storage.getMemory('a-note'))?.body).toBe('Human-edited body.');
  });

  // INVARIANT: the importer is MECHANISTIC — it brings records in faithfully.
  // The 200-char description budget belongs to the AUTHORING surfaces
  // (`lazy memory save`, `lazy_memory_save`), not to intake. A harness record
  // written under a different contract must be stored VERBATIM: never rejected
  // (that discards curated knowledge — the exact loss this import repairs) and
  // never truncated (that mangles it). Do not "tighten" this by validating here.
  test('a description over the authoring limit imports verbatim', async () => {
    const longDescription = 'A very long harness description that runs well past the authoring limit. ' + 'x'.repeat(200);
    expect(longDescription.length).toBeGreaterThan(MAX_MEMORY_DESCRIPTION_LENGTH);

    writeMemoryFile(
      join(homeDir, '.claude', 'projects'),
      'long-note.md',
      `---\nname: long-note\ndescription: ${longDescription}\nmetadata:\n  type: feedback\n---\n\nBody.\n`,
    );

    const report = await importHarnessMemory(opts());
    expect(report.errors).toHaveLength(0);
    expect(report.imported.map(i => i.name)).toEqual(['long-note']);

    const record = await storage.getMemory('long-note');
    expect(record?.description).toBe(longDescription);
    expect(record?.description.length).toBe(longDescription.length);

    // Reported as a curation hint, not a failure — the record is in the store.
    expect(report.longDescriptions).toEqual(['long-note']);
    const notice = formatLongDescriptionNotice(report);
    expect(notice).toContain('long-note');
    expect(notice).toContain('verbatim');
  });

  // A record within the limit must not trip the curation hint.
  test('short descriptions are not reported as over the limit', async () => {
    writeMemoryFile(
      join(homeDir, '.claude', 'projects'),
      'a-note.md',
      '---\nname: a-note\ndescription: A note\nmetadata:\n  type: project\n---\n\nBody.\n',
    );

    const report = await importHarnessMemory(opts());
    expect(report.longDescriptions).toEqual([]);
    expect(formatLongDescriptionNotice(report)).toBeNull();
  });

  test('reports nothing to import when no harness memory exists', async () => {
    expect(await countImportableMemories(opts())).toBe(0);
    const report = await importHarnessMemory(opts());
    expect(report.found).toBe(0);
    expect(report.imported).toHaveLength(0);
  });
});
