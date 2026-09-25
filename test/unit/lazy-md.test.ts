/**
 * LAZY.md discovery — the ordering, bounding and rendering rules a prompt layer
 * must not be allowed to drift on.
 *
 * The wiring into the five launch paths is asserted end-to-end in
 * test/e2e/lazy-md.test.ts; these tests pin the parts that decide WHAT an agent
 * reads and in WHICH order.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  LAZY_MD_CHAR_BUDGET,
  LAZY_MD_MAX_DEPTH,
  ancestorChain,
  buildLazyMdSection,
  collectLazyMdFiles,
  renderLazyMdSection,
} from '../../src/task/lazy-md';

let root: string;
let outside: string;

/** Write a LAZY.md at a repo-relative directory, creating it if needed. */
async function writeLazyMd(relDir: string, content: string): Promise<void> {
  const dir = relDir ? join(root, relDir) : root;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'LAZY.md'), content);
}

beforeEach(async () => {
  // realpath: macOS tmpdir() is a /var symlink to /private/var, and the module
  // composes paths from the root it is given — comparing against a raw
  // mkdtemp path would compare two spellings of the same directory. The same
  // trap applies to readWorktreeFileNoFollow's containment check.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'lazy-md-')));
  root = join(base, 'worktree');
  outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), 'HOST SECRET\n');
});

afterEach(async () => {
  await rm(join(root, '..'), { recursive: true, force: true });
});

describe('ancestorChain', () => {
  // INVARIANT: the chain is ordered ROOT-FIRST, so the file closest to where the
  // agent starts is read LAST. Claude Code concatenates CLAUDE.md that way, and
  // last-read-wins is what makes a deeper file able to refine a shallower one.
  test('orders the chain root-first', () => {
    expect(ancestorChain(root, join(root, 'services', 'api'))).toEqual([
      root,
      join(root, 'services'),
      join(root, 'services', 'api'),
    ]);
  });

  // INVARIANT: a startDir outside the root collapses to the root alone. The
  // walk must never climb ABOVE the worktree — the directories above it belong
  // to lazy's own store, not to the project.
  test('never climbs above the root', () => {
    expect(ancestorChain(root, join(root, '..', 'elsewhere'))).toEqual([root]);
    expect(ancestorChain(root, root)).toEqual([root]);
  });
});

describe('collectLazyMdFiles', () => {
  test('finds nothing in a project with no LAZY.md', async () => {
    const collection = await collectLazyMdFiles(root);
    expect(collection.files).toEqual([]);
    expect(collection.skipped).toEqual([]);
  });

  test('loads the root file for a turn starting at the root', async () => {
    await writeLazyMd('', 'root rules');
    const collection = await collectLazyMdFiles(root);
    expect(collection.files.map(f => f.relativePath)).toEqual(['LAZY.md']);
    expect(collection.files[0]!.content).toBe('root rules');
  });

  // INVARIANT: nested LAZY.md files are loaded UP FRONT, not on demand. Claude
  // Code defers subdirectory CLAUDE.md until the agent reads a file there; lazy
  // has no hook into an agent's file reads, so a nested file is either injected
  // at launch or never seen at all.
  test('sweeps nested files shallowest-first after the ancestor chain', async () => {
    await writeLazyMd('', 'root');
    await writeLazyMd('services/api', 'api');
    await writeLazyMd('web', 'web');

    const collection = await collectLazyMdFiles(root);
    expect(collection.files.map(f => f.relativePath)).toEqual([
      'LAZY.md',
      'web/LAZY.md',
      'services/api/LAZY.md',
    ]);
  });

  // INVARIANT: a file on the ancestor chain is never also emitted by the nested
  // sweep. Duplicating it would charge its characters twice against the budget
  // and read the same instructions to the agent twice.
  test('does not repeat an ancestor-chain file in the sweep', async () => {
    await writeLazyMd('', 'root');
    await writeLazyMd('services', 'services');

    const collection = await collectLazyMdFiles(root, { startDir: join(root, 'services') });
    expect(collection.files.map(f => f.relativePath)).toEqual(['LAZY.md', 'services/LAZY.md']);
  });

  // INVARIANT: directories the project's cascading .gitignore files ignore are
  // never descended into — and neither are dot-directories. .gitignore is the
  // source of truth for "not our tree" (so a hard-coded tool list cannot drift
  // from the project); the dot-dir rule is a hard skip so .lazy cannot leak one
  // task's LAZY.md into another's prompt even when it is not gitignored.
  test('skips gitignored directories and every dot-directory', async () => {
    await writeFile(join(root, '.gitignore'), 'node_modules/\ndist/\n');
    await writeLazyMd('node_modules/pkg', 'vendored');
    await writeLazyMd('dist', 'built');
    await writeLazyMd('.lazy/worktrees/other-task', 'another task');
    await writeLazyMd('src', 'mine');

    const collection = await collectLazyMdFiles(root);
    expect(collection.files.map(f => f.relativePath)).toEqual(['src/LAZY.md']);
  });

  // INVARIANT: a nested .gitignore applies from its directory downward, the
  // same cascade git uses. Loading only the root file would miss per-package
  // ignore rules in a monorepo.
  test('honours a nested .gitignore for the subtree below it', async () => {
    await mkdir(join(root, 'services'), { recursive: true });
    await writeFile(join(root, 'services', '.gitignore'), 'generated/\n');
    await writeLazyMd('services/generated', 'gen');
    await writeLazyMd('services/api', 'api');
    await writeLazyMd('web', 'web');

    const collection = await collectLazyMdFiles(root);
    expect(collection.files.map(f => f.relativePath)).toEqual([
      'web/LAZY.md',
      'services/api/LAZY.md',
    ]);
  });

  // Negation works for siblings (last matching rule wins). Re-including a path
  // under an ignored PARENT is impossible in git — we never descend into the
  // parent, so a nested `!kept/` under `vendor/` would never be consulted.
  test('a negated gitignore pattern re-includes a sibling directory', async () => {
    await writeFile(join(root, '.gitignore'), 'secret/\nvisible/\n!visible/\n');
    await writeLazyMd('secret', 'skipped');
    await writeLazyMd('visible', 'kept');

    const collection = await collectLazyMdFiles(root);
    expect(collection.files.map(f => f.relativePath)).toEqual(['visible/LAZY.md']);
  });

  test('without a matching gitignore entry, ordinary directories are still swept', async () => {
    // No .gitignore at all — and no hard-coded tool list to fall back on. A
    // directory named node_modules is walked like any other; the project's
    // ignore file is what opts it out.
    await writeLazyMd('node_modules/pkg', 'vendored');
    await writeLazyMd('src', 'mine');

    const collection = await collectLazyMdFiles(root);
    expect(collection.files.map(f => f.relativePath)).toEqual([
      'src/LAZY.md',
      'node_modules/pkg/LAZY.md',
    ]);
  });

  test('stops descending past the depth cap', async () => {
    const deep = Array.from({ length: LAZY_MD_MAX_DEPTH + 1 }, (_, i) => `d${i}`).join('/');
    await writeLazyMd(deep, 'too deep');
    await writeLazyMd('d0', 'shallow');

    const collection = await collectLazyMdFiles(root);
    expect(collection.files.map(f => f.relativePath)).toEqual(['d0/LAZY.md']);
  });

  // INVARIANT: LAZY_MD_MAX_DEPTH is levels below the root — a file exactly that
  // many directory segments down is still loaded.
  test('loads a nested file at exactly the depth cap', async () => {
    const atCap = Array.from({ length: LAZY_MD_MAX_DEPTH }, (_, i) => `d${i}`).join('/');
    await writeLazyMd(atCap, 'at the cap');

    const collection = await collectLazyMdFiles(root);
    expect(collection.files.map(f => f.relativePath)).toEqual([`${atCap}/LAZY.md`]);
  });

  // INVARIANT: content past the budget is NAMED, never silently dropped. An
  // agent told nothing would treat a partial set of instructions as the
  // complete one and act confidently on rules it was never given.
  test('names files that did not fit the budget', async () => {
    await writeLazyMd('', 'x'.repeat(80));
    await writeLazyMd('a', 'y'.repeat(80));

    const collection = await collectLazyMdFiles(root, { budget: 100 });
    expect(collection.files.map(f => f.relativePath)).toEqual(['LAZY.md']);
    expect(collection.skipped).toEqual(['a/LAZY.md']);
  });

  // INVARIANT: budget overflow fails closed. An oversized root must not be
  // dropped while a later smaller nested file is still injected — that would
  // hand the agent leaf rules without the root rules the design treats as
  // primary.
  test('stops collecting after the first file that exceeds the budget', async () => {
    await writeLazyMd('', 'x'.repeat(150));
    await writeLazyMd('a', 'y'.repeat(10));

    const collection = await collectLazyMdFiles(root, { budget: 100 });
    expect(collection.files).toEqual([]);
    expect(collection.skipped).toEqual(['LAZY.md', 'a/LAZY.md']);
  });

  // INVARIANT: never follow a symlink out of the worktree when reading LAZY.md.
  // The worktree is agent-writable; a planted symlink would otherwise let the
  // daemon inject host file bytes into the next system prompt (same confused-
  // deputy class as review expand / readWorktreeFileNoFollow).
  test('does not follow a LAZY.md symlink outside the worktree', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'LAZY.md'));
    await writeLazyMd('src', 'safe');

    const collection = await collectLazyMdFiles(root);
    expect(collection.files.map(f => f.relativePath)).toEqual(['src/LAZY.md']);
    expect(collection.files[0]!.content).toBe('safe');
    expect(JSON.stringify(collection)).not.toContain('HOST SECRET');
  });

  test('does not follow a LAZY.md symlink inside the worktree either', async () => {
    await writeLazyMd('src', 'real');
    await symlink(join(root, 'src', 'LAZY.md'), join(root, 'LAZY.md'));

    const collection = await collectLazyMdFiles(root);
    // Root is a symlink → skipped; nested regular file still loads.
    expect(collection.files.map(f => f.relativePath)).toEqual(['src/LAZY.md']);
  });

  test('does not descend through a directory symlink', async () => {
    await mkdir(join(outside, 'pkg'), { recursive: true });
    await writeFile(join(outside, 'pkg', 'LAZY.md'), 'HOST SECRET\n');
    await symlink(join(outside, 'pkg'), join(root, 'linked'));
    await writeLazyMd('src', 'safe');

    const collection = await collectLazyMdFiles(root);
    expect(collection.files.map(f => f.relativePath)).toEqual(['src/LAZY.md']);
    expect(JSON.stringify(collection)).not.toContain('HOST SECRET');
  });

  test('defaults to a bounded budget', () => {
    expect(LAZY_MD_CHAR_BUDGET).toBeGreaterThan(0);
  });
});

describe('renderLazyMdSection', () => {
  // INVARIANT: no LAZY.md means an EMPTY section, not a section explaining that
  // there is nothing. A project that ships none pays nothing and is told
  // nothing, exactly like the shared-memory index.
  test('renders nothing when nothing was found', () => {
    expect(renderLazyMdSection({ files: [], skipped: [] })).toBe('');
  });

  test('labels each file with its path and keeps injection order', () => {
    const section = renderLazyMdSection({
      files: [
        { path: '/r/LAZY.md', relativePath: 'LAZY.md', content: 'root rules\n' },
        { path: '/r/web/LAZY.md', relativePath: 'web/LAZY.md', content: 'web rules\n' },
      ],
      skipped: [],
    });

    expect(section).toContain('### LAZY.md');
    expect(section).toContain('root rules');
    expect(section).toContain('### web/LAZY.md');
    expect(section.indexOf('### LAZY.md')).toBeLessThan(section.indexOf('### web/LAZY.md'));
    expect(section).not.toContain('{{LAZY_MD_FILES}}');
  });

  test('tells the agent which files were left out', () => {
    const section = renderLazyMdSection({
      files: [{ path: '/r/LAZY.md', relativePath: 'LAZY.md', content: 'root' }],
      skipped: ['services/api/LAZY.md'],
    });
    expect(section).toContain('services/api/LAZY.md');
    expect(section).toContain('NOT loaded');
  });

  // INVARIANT: LAZY.md body is inserted verbatim. String.replace with a string
  // replacement would interpret $$, $&, $1, … and corrupt shell variables or
  // prices in the project's own instructions.
  test('preserves $ sequences in LAZY.md content', () => {
    const section = renderLazyMdSection({
      files: [
        {
          path: '/r/LAZY.md',
          relativePath: 'LAZY.md',
          content: 'Pay $100; backup is $$HOME; match is $&; group is $1.\n',
        },
      ],
      skipped: [],
    });
    expect(section).toContain('Pay $100; backup is $$HOME; match is $&; group is $1.');
    expect(section).not.toContain('{{LAZY_MD_FILES}}');
  });
});

describe('buildLazyMdSection', () => {
  // INVARIANT: a prompt layer never fails a launch. A project's instruction
  // files being unreadable degrades the turn; refusing to start it is worse.
  test('returns an empty section rather than throwing on a bad root', async () => {
    expect(await buildLazyMdSection(join(root, 'does-not-exist'))).toBe('');
  });

  test('renders the discovered files for a real root', async () => {
    await writeLazyMd('', 'run the suite inside the lazy container');
    const section = await buildLazyMdSection(root);
    expect(section).toContain('run the suite inside the lazy container');
    expect(section).toContain('LAZY.md');
  });
});
