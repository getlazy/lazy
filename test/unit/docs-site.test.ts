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
import { buildDocsSite, DEFAULT_EXCLUDED_DIRS, withOutline, OUTLINE_MIN_H2 } from '../../src/docs/site';
import type { DocsNav } from '../../src/docs/nav';

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

    // INVARIANT: a fragment naming a heading its page does not have is an
    // unresolved link. The reader lands at the top of the page with no hint the
    // section is gone, so a page-only check passed while anchors rotted.
    test('fragments are checked against the target page headings', async () => {
      await writeDoc('a.md', '# A\n\n[ok](./b.md#real-heading) [bad](./b.md#gone) [self](#here) [selfbad](#nope) [malformed](./b.md#50%-off)\n\n## Here\n');
      await writeDoc('b.md', '# B\n\n## Real heading\n');
      const manifest = await buildDocsSite({ docsDir, outDir });
      expect(manifest.unresolvedLinks).toEqual([
        { source: 'a.md', href: './b.md#gone' },
        { source: 'a.md', href: '#nope' },
        { source: 'a.md', href: './b.md#50%-off' },
      ]);
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

  // INVARIANT: a page title is plain text escaped exactly once. Taking it from
  // rendered heading HTML kept entities like `&#39;`, which the template then
  // escaped again — readers saw "Reaching a task&amp;#39;s dev server".
  test('titles with quotes, ampersands and code are escaped once', async () => {
    await writeDoc('t.md', "# A task's `lazy.toml` & <b>more</b>\n");
    const manifest = await buildDocsSite({ docsDir, outDir });
    expect(manifest.pages[0]!.title).toBe("A task's lazy.toml & more");
    const html = await readFile(join(outDir, 't', 'index.html'), 'utf-8');
    expect(html).toContain("<title>A task's lazy.toml &amp; more — lazy docs</title>");
    expect(html).not.toContain('&amp;#39;');
  });
});

describe('navigation manifest', () => {
  const nav = (redirects: { from: string; to: string }[] = []): DocsNav => ({
    sections: [
      { title: 'Start here', intro: 'Begin here.', items: [{ path: '', title: 'Overview' }] },
      { title: 'Guides', intro: 'Do things.', items: [{ path: 'one' }, { path: 'two', title: 'Second' }] },
      {
        title: 'Reference',
        intro: 'Look things up.',
        items: [{ dir: 'reference/cli', title: 'CLI' }, { group: 'Config', items: [{ path: 'conf' }] }],
      },
    ],
    redirects,
  });

  beforeEach(async () => {
    await writeDoc('one.md', '# One\n\n## Part\n');
    await writeDoc('two.md', '# Two\n');
    await writeDoc('conf.md', '# Conf\n');
    await writeDoc('reference/cli/b.md', '# lazy b\n');
    await writeDoc('reference/cli/a.md', '# lazy a\n\n[one](../../one.md)\n');
  });

  test('sidebar marks the current page, breadcrumbs name the section, prev/next follow the manifest', async () => {
    const manifest = await buildDocsSite({ docsDir, outDir, nav: nav() });
    expect(manifest.problems).toEqual([]);
    const two = await readFile(join(outDir, 'two', 'index.html'), 'utf-8');
    expect(two).toContain('<a href="../two/" aria-current="page">Second</a>');
    expect(two).toContain('<a href="../#guides">Guides</a> › <span aria-current="page">Second</span>');
    expect(two).toContain('class="prev" href="../one/"');
    // `dir` items expand sorted, so reference/cli/a follows two.
    expect(two).toContain('class="next" href="../reference/cli/a/"');

    const a = await readFile(join(outDir, 'reference', 'cli', 'a', 'index.html'), 'utf-8');
    expect(a).toContain('href="../../../one/"');
    expect(a).toContain('Reference</a> › CLI › <span aria-current="page">lazy a</span>');
    expect(a).toContain('class="next" href="../../../reference/cli/b/"');
    expect(a).not.toMatch(/href="\/[^/]/);
  });

  test('the index renders sections with their intros', async () => {
    await buildDocsSite({ docsDir, outDir, nav: nav() });
    const index = await readFile(join(outDir, 'index.html'), 'utf-8');
    expect(index).toContain('<h2 class="group" id="guides">Guides</h2>');
    expect(index).toContain('<p class="intro">Do things.</p>');
    expect(index).toContain('href="./reference/cli/b/"');
    // The version index rewrite inserts before </main>.
    expect(index).toContain('</main>');
  });

  // INVARIANT: a `{ dir }` group with an index page leads with that index, and outside the
  // directory only the index is listed. The generated CLI reference is 100+ pages; listing them
  // all on every page buried the rest of the navigation, and the overview sat mid-list.
  test('a dir with an index leads with it and collapses outside the directory', async () => {
    await writeDoc('reference/cli/index.md', '# CLI reference\n');
    const manifest = await buildDocsSite({ docsDir, outDir, nav: nav() });
    expect(manifest.problems).toEqual([]);
    const two = await readFile(join(outDir, 'two', 'index.html'), 'utf-8');
    expect(two).toContain('class="next" href="../reference/cli/index/"');
    expect(two).toContain('href="../reference/cli/index/"');
    // The sidebar now keeps the group in a collapsed <details> instead of omitting its pages.
    expect(two).toContain('<details class="branch"><summary>CLI</summary><ul><li><a href="../reference/cli/index/">');
    // The page body (not the sidebar's All pages list) shows only the directory's index.
    const index = (await readFile(join(outDir, 'index.html'), 'utf-8')).split('<nav class="sidebar"')[0]!;
    expect(index).toContain('href="./reference/cli/index/"');
    expect(index).not.toContain('href="./reference/cli/b/"');
    const a = await readFile(join(outDir, 'reference', 'cli', 'a', 'index.html'), 'utf-8');
    expect(a).toContain('href="../../../reference/cli/b/"');
    expect(a).toContain('class="prev" href="../../../reference/cli/index/"');
  });

  test('redirect stubs are relative and links to a redirect source resolve', async () => {
    await writeDoc('two.md', '# Two\n\n[old](./old.md) [oldfrag](./old.md#x)\n');
    const manifest = await buildDocsSite({ docsDir, outDir, nav: nav([{ from: 'old', to: 'one#part' }]) });
    expect(manifest.problems).toEqual([]);
    const stub = await readFile(join(outDir, 'old', 'index.html'), 'utf-8');
    expect(stub).toContain('<meta http-equiv="refresh" content="0; url=../one/#part">');
    expect(stub).toContain('<link rel="canonical" href="../one/#part">');
    expect(stub).toContain('<a href="../one/#part">One</a>');
    const two = await readFile(join(outDir, 'two', 'index.html'), 'utf-8');
    expect(two).toContain('href="../old/"');
  });

  test('--local writes index.html into every link, including redirect stubs', async () => {
    await writeDoc('two.md', '# Two\n\n[old](./old.md) [one](./one.md#part)\n');
    const manifest = await buildDocsSite({ docsDir, outDir, nav: nav([{ from: 'old', to: 'one#part' }]), local: true });
    expect(manifest.problems).toEqual([]);
    const stub = await readFile(join(outDir, 'old', 'index.html'), 'utf-8');
    expect(stub).toContain('content="0; url=../one/index.html#part"');
    expect(stub).toContain('<link rel="canonical" href="../one/index.html#part">');
    expect(stub).toContain('<a href="../one/index.html#part">One</a>');
    const two = await readFile(join(outDir, 'two', 'index.html'), 'utf-8');
    expect(two).toContain('href="../old/index.html"');
    expect(two).toContain('href="../one/index.html#part"');
    expect(two).toContain('<a href="../two/index.html" aria-current="page">Second</a>');
    expect(two).toContain('<a href="../index.html#guides">Guides</a>');
    expect(two).toContain('class="prev" href="../one/index.html"');
    expect(two).toContain('class="next" href="../reference/cli/a/index.html"');
    const index = await readFile(join(outDir, 'index.html'), 'utf-8');
    expect(index).toContain('href="./reference/cli/b/index.html"');
  });

  test('images under images/ are copied and resolve', async () => {
    await mkdir(join(docsDir, 'images'), { recursive: true });
    await writeFile(join(docsDir, 'images', 'shot.png'), 'png', 'utf-8');
    await writeDoc('conf.md', '# Conf\n\n![shot](images/shot.png)\n');
    const manifest = await buildDocsSite({ docsDir, outDir, nav: nav(), strict: true });
    expect(manifest.assets).toEqual(['images/shot.png']);
    expect(await readFile(join(outDir, 'images', 'shot.png'), 'utf-8')).toBe('png');
    expect(await readFile(join(outDir, 'conf', 'index.html'), 'utf-8')).toContain('src="../images/shot.png"');
  });

  // INVARIANT: strict lists EVERY problem, not the first, so one build tells a
  // writer everything to fix.
  test('strict fails with every problem listed', async () => {
    await writeDoc('stray.md', '# Stray\n\n[gone](./gone.md) [bad](./one.md#nope) [internal](../docs/x.md) [raw](#anchored)\n\n<a id="anchored"></a>\n');
    const n = nav([{ from: 'moved', to: 'one#missing' }, { from: 'moved2', to: 'nowhere' }]);
    n.sections[1]!.items.push({ path: 'ghost' });
    const error = await buildDocsSite({ docsDir, outDir, nav: n, strict: true }).then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message).toContain('stray.md: broken link: ./gone.md');
    expect(error?.message).toContain('stray.md: broken link: ./one.md#nope');
    expect(error?.message).toContain('stray.md: link into the internal docs/ tree');
    expect(error?.message).not.toContain('#anchored');
    expect(error?.message).toContain('navigation lists ghost, but public-docs/ghost.md does not exist');
    expect(error?.message).toContain('stray.md is not listed in the navigation');
    expect(error?.message).toContain('redirect moved -> one#missing: no heading #missing on one');
    expect(error?.message).toContain('redirect moved2 -> nowhere: no page at nowhere');
  });

  test('strict reports duplicates, a redirect over a real page, and data-id is no anchor', async () => {
    await writeDoc('two.md', '# Two\n\n[x](./one.md#fake)\n');
    await writeDoc('one.md', '# One\n\n<a data-id="fake"></a>\n');
    const n = nav([{ from: 'conf', to: 'one' }]);
    n.sections[1]!.items.push({ path: 'one' });
    const error = await buildDocsSite({ docsDir, outDir, nav: n, strict: true }).then(
      () => null,
      (err: Error) => err,
    );
    expect(error?.message).toContain('navigation lists one more than once');
    expect(error?.message).toContain('redirect conf: a page still exists at that path');
    expect(error?.message).toContain('two.md: broken link: ./one.md#fake');
    // The real page is never overwritten by the stub.
    expect(await readFile(join(outDir, 'conf', 'index.html'), 'utf-8')).toContain('<h1 id="conf">');
  });
});

describe('collapsible sidebar', () => {
  const nav: DocsNav = {
    sections: [
      { title: 'Guides', intro: 'Do things.', items: [{ path: 'one' }, { path: 'two' }] },
      {
        title: 'Reference',
        intro: 'Look things up.',
        items: [{ dir: 'reference/cli', title: 'CLI' }, { group: 'Config', items: [{ path: 'conf' }] }],
      },
      { title: 'Architecture', intro: 'Parts.', items: [{ dir: 'architecture', title: 'Architecture' }] },
    ],
    redirects: [],
  };

  beforeEach(async () => {
    await writeDoc('one.md', '# One\n');
    await writeDoc('two.md', '# Two\n');
    await writeDoc('conf.md', '# Conf\n');
    await writeDoc('reference/cli/a.md', '# lazy a\n');
  });

  // INVARIANT: only the branch holding the current page starts open; every other
  // section and sub-group is collapsed. The reader sees where they are without
  // scrolling a tree of every page.
  test('only the current branch is open', async () => {
    await buildDocsSite({ docsDir, outDir, nav });
    const html = await readFile(join(outDir, 'reference', 'cli', 'a', 'index.html'), 'utf-8');
    const opens = [...html.matchAll(/<details class="branch[^"]*"( open)?><summary>([^<]*)</g)].map((m) => [m[2], !!m[1]]);
    expect(opens).toEqual([
      ['Guides', false],
      ['Reference', true],
      ['CLI', true],
      ['Config', false],
      ['All pages', false],
    ]);
  });

  // INVARIANT: "All pages" is the last, always-collapsed branch and the only
  // place the full page list lives; an empty nav directory breaks nothing.
  test('All pages is last, collapsed, and lists every page', async () => {
    const manifest = await buildDocsSite({ docsDir, outDir, nav, strict: true });
    const html = await readFile(join(outDir, 'one', 'index.html'), 'utf-8');
    const summaries = [...html.matchAll(/<summary>([^<]*)</g)].map((m) => m[1]);
    expect(summaries.at(-1)).toBe('All pages');
    expect(html).toContain('<details class="branch all-pages"><summary>All pages');
    const list = html.slice(html.indexOf('all-pages'));
    for (const page of manifest.pages) expect(list).toContain(`href="../${page.path}/"`);
  });
});

// INVARIANT: a long page gets a static "On this page" outline built from its
// existing h2 anchors (no script, no URL change); a short page gets none.
test('long pages get an On this page outline; short pages do not', () => {
  const h = (n: number) => Array.from({ length: n }, (_, i) => `<h2 id="s${i}"><a class="anchor" href="#s${i}" aria-hidden="true">#</a>Part ${i}</h2>\n<p>x</p>`).join('\n');
  const long = withOutline(`<h1 id="t">T</h1>\n${h(OUTLINE_MIN_H2)}`);
  expect(long).toContain('<nav class="toc"');
  expect(long).toContain('<a href="#s0">Part 0</a>');
  expect(long.indexOf('class="toc"')).toBeGreaterThan(long.indexOf('</h1>'));
  expect(withOutline(`<h1 id="t">T</h1>\n${h(OUTLINE_MIN_H2 - 1)}`)).not.toContain('class="toc"');
});
