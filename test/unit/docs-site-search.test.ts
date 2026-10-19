/**
 * The offline search of the docs site: the generated index and the search script.
 */
import { test, expect } from 'bun:test';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Window } from 'happy-dom';
import { buildDocsSite, SEARCH_INDEX_FILE, type SearchIndexPage } from '../../src/docs/site';
import { DOCS_NAV } from '../../src/docs/nav';

const docsDir = join(import.meta.dir, '..', '..', 'public-docs');

async function loadIndex(outDir: string): Promise<{ v: number; pages: SearchIndexPage[] }> {
  const js = await readFile(join(outDir, SEARCH_INDEX_FILE), 'utf-8');
  expect(js.startsWith('window.LAZY_DOCS_INDEX=')).toBe(true);
  return JSON.parse(js.slice('window.LAZY_DOCS_INDEX='.length).replace(/;\s*$/, ''));
}

async function loadSearch(index: unknown): Promise<Window['window'] & { LazyDocsSearch: any }> {
  const window = new Window();
  (window as any).LAZY_DOCS_INDEX = index;
  window.eval(await readFile(join(import.meta.dir, '..', '..', 'src', 'docs', 'search.js'), 'utf-8'));
  return window as any;
}

// INVARIANT: the search index is one .js file (fetch of a .json is blocked on
// file://), covers every page the navigation lists, and every anchor in it is a
// real heading id on that page. A result that lands at the top of the page
// instead of its heading is a silent dead end.
test('index is a .js global covering every nav page, with anchors that exist', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'lazy-docs-search-'));
  try {
    const manifest = await buildDocsSite({ docsDir, outDir, nav: DOCS_NAV });
    const index = await loadIndex(outDir);
    expect(index.pages.map((p) => p.p).sort()).toEqual(manifest.pages.map((p) => p.path).sort());

    const bad: string[] = [];
    for (const page of index.pages) {
      const html = await readFile(join(outDir, page.p, 'index.html'), 'utf-8');
      for (const [, id] of page.s) {
        if (id !== '' && !html.includes(`id="${id}"`)) bad.push(`${page.p}#${id}`);
      }
    }
    expect(bad).toEqual([]);

    // Generated CLI reference is indexed with its help text, flags included.
    const cli = index.pages.find((p) => p.p === 'reference/cli/start');
    expect(cli?.s.some(([, , body]) => body.includes('--env-file'))).toBe(true);
    // Hand-written pages carry body text.
    expect(index.pages.find((p) => p.p === 'start-here')?.s.some(([, , body]) => body.length > 0)).toBe(true);

    const html = await readFile(join(outDir, 'start-here', 'index.html'), 'utf-8');
    expect(html).toContain('src="../search-index.js"');
    expect(html).toContain('data-root="../"');
    expect(html).not.toContain('data-local');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

// INVARIANT: result links are built like the rest of the build's links — directory
// links when published, an explicit index.html for a --local (file://) build.
test('local build: result links end in index.html; published build: directory links', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'lazy-docs-search-local-'));
  try {
    const manifest = await buildDocsSite({ docsDir, outDir, nav: DOCS_NAV, local: true });
    expect(manifest.problems).toEqual([]);
    const page = await readFile(join(outDir, 'start-here', 'index.html'), 'utf-8');
    expect(page).toContain('data-local="1"');

    const win = await loadSearch(await loadIndex(outDir));
    const results = win.LazyDocsSearch.search((win as any).LAZY_DOCS_INDEX, 'accept');
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      const link = win.LazyDocsSearch.href('../', true, r);
      expect(link.split('#')[0]).toMatch(/\/index\.html$/);
      expect(win.LazyDocsSearch.href('../', false, r).split('#')[0]).toMatch(/\/$/);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

// INVARIANT: ranking is title > heading > body, matching is case-insensitive,
// every word must match, and there are at most 10 results, one per page.
test('ranking: title beats heading beats body', async () => {
  const index = {
    v: 1,
    pages: [
      { p: 'c', t: 'Other', s: [['', '', 'we mention Widget here']] },
      { p: 'b', t: 'Other two', s: [['Using the widget', 'using-the-widget', 'text']] },
      { p: 'a', t: 'Widget guide', s: [['', '', 'intro']] },
      ...Array.from({ length: 20 }, (_, i) => ({ p: `x${i}`, t: `T${i}`, s: [['', '', 'widget']] })),
    ],
  };
  const win = await loadSearch(index);
  const results = win.LazyDocsSearch.search(index, 'WIDGET');
  expect(results.slice(0, 3).map((r: { path: string }) => r.path)).toEqual(['a', 'b', 'c']);
  expect(results.length).toBe(10);
  expect(results[1].id).toBe('using-the-widget');
  expect(results[2].snippet).toContain('Widget');
  expect(win.LazyDocsSearch.search(index, 'widget nonsense')).toEqual([]);
  expect(win.LazyDocsSearch.search(index, '   ')).toEqual([]);
});

// INVARIANT: on every page, in both builds, the script tags point (relative to
// the page) at files that exist, data-root climbs back to the site root, and
// data-local is set only in the --local build. The script builds result links
// from those attributes, so a wrong one sends every result to a dead URL.
test('every page wires the search scripts correctly in both modes', async () => {
  const { existsSync } = await import('fs');
  for (const local of [false, true]) {
    const outDir = await mkdtemp(join(tmpdir(), 'lazy-docs-search-wire-'));
    try {
      const manifest = await buildDocsSite({ docsDir, outDir, nav: DOCS_NAV, local });
      const index = await loadIndex(outDir);
      const indexed = new Set(index.pages.map((p) => p.p));
      const listed = DOCS_NAV.sections.flatMap((s) => s.items.flatMap(function walk(i: any): string[] {
        return 'path' in i ? [i.path] : 'items' in i ? i.items.flatMap(walk) : [];
      })).filter((p) => p !== '');
      for (const p of listed) expect(indexed.has(p)).toBe(true);

      const bad: string[] = [];
      for (const file of ['index.html', ...manifest.pages.map((p) => p.file)]) {
        const html = await readFile(join(outDir, file), 'utf-8');
        const depth = file === 'index.html' ? 0 : file.split('/').length - 1;
        const root = depth === 0 ? './' : '../'.repeat(depth);
        const tag = html.match(/<script defer src="([^"]*search\.js)" data-root="([^"]*)"([^>]*)>/);
        if (!tag) { bad.push(`${file}: no search script`); continue; }
        if (tag[1] !== `${root}search.js` || tag[2] !== root) bad.push(`${file}: ${tag[1]} ${tag[2]}`);
        if ((tag[3] === ' data-local="1"') !== local) bad.push(`${file}: data-local`);
        if (!html.includes(`src="${root}search-index.js"`)) bad.push(`${file}: index src`);
      }
      expect(bad).toEqual([]);
      expect(existsSync(join(outDir, 'search.js')) && existsSync(join(outDir, 'search-index.js'))).toBe(true);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }
});

// INVARIANT: searching a flag finds the command that takes it, in the published
// and the file:// build alike, and a CLI help body outranks incidental prose
// mentions. Code blocks elsewhere are indexed by their flags and config keys
// only, so config-only terms are findable without bloating the index.
for (const local of [false, true]) {
  test(`flags and code-only config terms are searchable (${local ? 'file://' : 'published'} build)`, async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'lazy-docs-search-'));
    try {
      await buildDocsSite({ docsDir, outDir, nav: DOCS_NAV, local });
      const index = await loadIndex(outDir);
      const { LazyDocsSearch } = await loadSearch(index);

      const env = LazyDocsSearch.search(index, '--env-file');
      expect(env.map((r: any) => r.path)).toContain('reference/cli/start');
      expect(env[0].path.startsWith('reference/cli/')).toBe(true);

      const usage = LazyDocsSearch.search(index, '--override-usage-pause');
      expect(usage.map((r: any) => r.path)).toContain('reference/cli/start');

      // A key that appears in a fenced config example.
      const key = LazyDocsSearch.search(index, 'auto_resume');
      expect(key.length).toBeGreaterThan(0);

      // Title ranking still wins.
      expect(LazyDocsSearch.search(index, 'lazy start')[0].path).toBe('reference/cli/start');

      // Every anchor a result links to exists on its page.
      const html = await readFile(join(outDir, 'reference/cli/start', 'index.html'), 'utf-8');
      for (const r of env) {
        const url = LazyDocsSearch.href('./', local, r);
        expect(url.endsWith(local ? 'index.html' + (r.id ? '#' + r.id : '') : (r.id ? '#' + r.id : ''))).toBe(true);
      }
      expect(html).toContain('<h1');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
}
