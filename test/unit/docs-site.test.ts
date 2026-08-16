/**
 * The docs site generator, exercised against a synthetic docs tree.
 *
 * Kept apart from test/unit/docs-links.test.ts on purpose: that file asserts
 * that lazy's REAL docs and its DOCS_PAGES registry agree, and would start
 * failing for content reasons if it also tried to pin down renderer mechanics.
 * This file owns the mechanics and never reads docs/.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildDocsSite, DEFAULT_EXCLUDED_DIRS } from '../../src/docs/site';

let root: string;
let docsDir: string;
let outDir: string;

async function writeDoc(relPath: string, content: string): Promise<void> {
  const target = join(docsDir, relPath);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content, 'utf-8');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-docs-site-test-'));
  docsDir = join(root, 'docs');
  outDir = join(root, 'site');
  await mkdir(docsDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('docs site generator', () => {
  // INVARIANT: heading ids must be GitHub's slugs, because DOCS_PAGES fragments
  // are written to match what a reader gets clicking the same heading in the
  // repo. If these ever diverge, every fragment pointer silently lands at the
  // top of the page instead of the section it names.
  describe('heading slugs match GitHub', () => {
    test('punctuation, case and code spans are slugged the GitHub way', async () => {
      await writeDoc(
        'slugs.md',
        [
          '# Title',
          '',
          "## The daemon won't start",
          '',
          '## `lazy.toml` won\'t parse',
          '',
          '## Every command fails to acquire the storage lock',
          '',
          '## A/B: C & D',
          '',
        ].join('\n'),
      );

      const manifest = await buildDocsSite({ docsDir, outDir });
      expect(manifest.pages[0]!.anchors).toEqual([
        'title',
        'the-daemon-wont-start',
        'lazytoml-wont-parse',
        'every-command-fails-to-acquire-the-storage-lock',
        'ab-c--d',
      ]);
    });

    // GitHub's slugger appends -1, -2 … to repeated headings within ONE
    // document, and restarts the counter for the next document. A slugger
    // shared across pages would give page two's first "Notes" the id `notes-1`,
    // which no link anywhere would ever guess.
    test('duplicate headings get GitHub\'s counter, per document', async () => {
      await writeDoc('a.md', '## Notes\n\n## Notes\n\n## Notes\n');
      await writeDoc('b.md', '## Notes\n');

      const manifest = await buildDocsSite({ docsDir, outDir });
      const byPath = new Map(manifest.pages.map((page) => [page.path, page]));
      expect(byPath.get('a')!.anchors).toEqual(['notes', 'notes-1', 'notes-2']);
      expect(byPath.get('b')!.anchors).toEqual(['notes']);
    });
  });

  describe('link rewriting', () => {
    // The classic pretty-URL bug: docs/a/b.md renders to a/b/index.html, so a
    // sibling link resolved against the SOURCE directory is one level too high
    // once it is served. Rewriting is relative to the rendered page's directory.
    test('sibling and parent .md links resolve from the rendered page directory', async () => {
      await writeDoc('guide/intro.md', '# Intro\n\n[next](./deep.md) [up](../top.md#part-two)\n');
      await writeDoc('guide/deep.md', '# Deep\n');
      await writeDoc('top.md', '# Top\n\n## Part two\n');

      await buildDocsSite({ docsDir, outDir });
      const html = await readFile(join(outDir, 'guide', 'intro', 'index.html'), 'utf-8');
      expect(html).toContain('href="../deep/"');
      expect(html).toContain('href="../../top/#part-two"');
    });

    test('assets are copied and their links rewritten too', async () => {
      await writeDoc('release/notes.md', '# Notes\n\n![arch](diagrams/arch.svg)\n');
      await mkdir(join(docsDir, 'release', 'diagrams'), { recursive: true });
      await writeFile(join(docsDir, 'release', 'diagrams', 'arch.svg'), '<svg/>', 'utf-8');

      const manifest = await buildDocsSite({ docsDir, outDir });
      expect(manifest.assets).toEqual(['release/diagrams/arch.svg']);
      const html = await readFile(join(outDir, 'release', 'notes', 'index.html'), 'utf-8');
      expect(html).toContain('src="../diagrams/arch.svg"');
      expect(await readFile(join(outDir, 'release', 'diagrams', 'arch.svg'), 'utf-8')).toBe('<svg/>');
    });

    test('absolute URLs, mailto and bare fragments pass through untouched', async () => {
      await writeDoc(
        'x.md',
        '# X\n\n[a](https://example.com/y) [b](mailto:x@example.com) [c](#section)\n\n## Section\n',
      );
      await buildDocsSite({ docsDir, outDir });
      const html = await readFile(join(outDir, 'x', 'index.html'), 'utf-8');
      expect(html).toContain('href="https://example.com/y"');
      expect(html).toContain('href="mailto:x@example.com"');
      expect(html).toContain('href="#section"');
    });

    // Reported, never thrown: a stale cross-reference is a content bug that
    // should not block a release. The CLI's --strict turns it fatal for anyone
    // who wants that gate.
    test('links that leave the docs tree are reported, not fatal, and left as written', async () => {
      await writeDoc('y.md', '# Y\n\n[src](../src/git/lfs.ts) [gone](./missing.md)\n');
      const manifest = await buildDocsSite({ docsDir, outDir });
      expect(manifest.unresolvedLinks).toEqual([
        { source: 'y.md', href: '../src/git/lfs.ts' },
        { source: 'y.md', href: './missing.md' },
      ]);
      const html = await readFile(join(outDir, 'y', 'index.html'), 'utf-8');
      expect(html).toContain('href="../src/git/lfs.ts"');
    });

    // The same HTML is served from /v0.21/ and from the site root, so a
    // root-absolute path can only be correct in one of them. The generator
    // never emits one.
    test('every generated link is relative', async () => {
      await writeDoc('a.md', '# A\n\n[b](./sub/b.md)\n');
      await writeDoc('sub/b.md', '# B\n\n[a](../a.md)\n');
      await buildDocsSite({ docsDir, outDir });

      for (const file of ['index.html', join('a', 'index.html'), join('sub', 'b', 'index.html')]) {
        const html = await readFile(join(outDir, file), 'utf-8');
        expect(html).not.toMatch(/href="\/[^/]/);
      }
    });
  });

  describe('tree', () => {
    test('excluded directories are not published', async () => {
      await writeDoc('public.md', '# Public\n');
      await writeDoc('scratch/private.md', '# Private\n');

      const manifest = await buildDocsSite({ docsDir, outDir });
      expect(manifest.pages.map((page) => page.path)).toEqual(['public']);
      expect(DEFAULT_EXCLUDED_DIRS).toContain('scratch');
    });

    test('the exclude list is overridable', async () => {
      await writeDoc('public.md', '# Public\n');
      await writeDoc('scratch/private.md', '# Private\n');
      await writeDoc('spikes/s.md', '# Spike\n');

      const manifest = await buildDocsSite({ docsDir, outDir, exclude: ['spikes'] });
      expect(manifest.pages.map((page) => page.path).sort()).toEqual(['public', 'scratch/private']);
    });

    test('the index lists every page, grouped by directory', async () => {
      await writeDoc('alpha.md', '# Alpha\n');
      await writeDoc('sub/beta.md', '# Beta Page\n');

      await buildDocsSite({ docsDir, outDir });
      const html = await readFile(join(outDir, 'index.html'), 'utf-8');
      expect(html).toContain('href="./alpha/"');
      expect(html).toContain('href="./sub/beta/"');
      expect(html).toContain('Beta Page');
      expect(html).toContain('sub/</h2>');
    });

    test('the title is the first h1, falling back to a prettified file name', async () => {
      await writeDoc('titled.md', '# Real Title\n');
      await writeDoc('untitled.md', 'no heading here\n');

      const manifest = await buildDocsSite({ docsDir, outDir });
      const byPath = new Map(manifest.pages.map((page) => [page.path, page.title]));
      expect(byPath.get('titled')).toBe('Real Title');
      expect(byPath.get('untitled')).toBe('Untitled');
    });

    // The generator owns index.html. A docs/index.md would be silently
    // clobbered by it, so say so instead.
    test('docs/index.md fails loud rather than being silently overwritten', async () => {
      await writeDoc('index.md', '# Home\n');
      await expect(buildDocsSite({ docsDir, outDir })).rejects.toThrow(/docs\/index\.md is not supported/);
    });
  });

  describe('publish artifacts', () => {
    test('.nojekyll is always written and CNAME only when asked', async () => {
      await writeDoc('a.md', '# A\n');

      await buildDocsSite({ docsDir, outDir });
      expect(await readFile(join(outDir, '.nojekyll'), 'utf-8')).toBe('');
      expect(readFile(join(outDir, 'CNAME'), 'utf-8')).rejects.toThrow();

      await buildDocsSite({ docsDir, outDir, cname: 'docs.getlazy.dev' });
      expect(await readFile(join(outDir, 'CNAME'), 'utf-8')).toBe('docs.getlazy.dev\n');
    });

    test('the manifest records path, source, file and anchors for every page', async () => {
      await writeDoc('a.md', '# A\n\n## Sub\n');
      const manifest = await buildDocsSite({ docsDir, outDir, version: 'v9.9' });

      expect(manifest.version).toBe('v9.9');
      expect(manifest.pages).toEqual([
        { path: 'a', source: 'a.md', file: 'a/index.html', title: 'A', anchors: ['a', 'sub'] },
      ]);
      const onDisk = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf-8'));
      expect(onDisk).toEqual(manifest);
    });

    // Deterministic output means a rebuild that changed nothing produces an
    // empty git diff, so the gh-pages branch does not churn on every release.
    test('two builds of the same input are byte-identical', async () => {
      await writeDoc('a.md', '# A\n\n[b](./b.md)\n');
      await writeDoc('b.md', '# B\n');

      await buildDocsSite({ docsDir, outDir: join(root, 'one'), version: 'v1.0' });
      await buildDocsSite({ docsDir, outDir: join(root, 'two'), version: 'v1.0' });

      for (const file of ['index.html', join('a', 'index.html'), 'manifest.json']) {
        expect(await readFile(join(root, 'one', file), 'utf-8')).toBe(
          await readFile(join(root, 'two', file), 'utf-8'),
        );
      }
    });
  });
});
