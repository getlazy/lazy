/**
 * A strict build of the REAL public-docs/ tree with the real navigation.
 */
import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { buildDocsSite } from '../../src/docs/site';
import { DOCS_NAV } from '../../src/docs/nav';

// INVARIANT: the published docs build strict — every page is in the
// navigation, every nav entry has a page, every internal link and #fragment
// resolves, nothing links into docs/, every redirect lands. A page added
// without a nav entry, or a heading renamed under a link, fails here.
test('public-docs/ builds strict against src/docs/nav.ts', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'lazy-docs-strict-'));
  try {
    const manifest = await buildDocsSite({
      docsDir: join(import.meta.dir, '..', '..', 'public-docs'),
      outDir,
      nav: DOCS_NAV,
    });
    expect(manifest.problems).toEqual([]);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

// INVARIANT: a --local build links every page by an explicit index.html (a
// browser shows a folder listing for a directory link on file://), builds
// strict, and the default build keeps directory links. The published URL shape
// is what src/docs/links.ts and old URLs depend on.
test('local build has no directory hrefs and also builds strict; default is unchanged', async () => {
  const docsDir = join(import.meta.dir, '..', '..', 'public-docs');
  const localDir = await mkdtemp(join(tmpdir(), 'lazy-docs-local-'));
  const defaultDir = await mkdtemp(join(tmpdir(), 'lazy-docs-default-'));
  try {
    const local = await buildDocsSite({ docsDir, outDir: localDir, nav: DOCS_NAV, local: true });
    expect(local.problems).toEqual([]);
    await buildDocsSite({ docsDir, outDir: defaultDir, nav: DOCS_NAV });

    const bad: string[] = [];
    for (const file of ['index.html', ...local.pages.map((p) => p.file), ...local.redirects.map((r) => `${r.from}/index.html`)]) {
      const html = await Bun.file(join(localDir, file)).text();
      for (const m of html.matchAll(/(?:href|src|url)="([^"]*)"/g)) {
        const raw = m[1]!.replace(/^0; url=/, '');
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) continue;
        const path = raw.split('#')[0]!;
        if (path === '' ) continue;
        if (!existsSync(resolve(localDir, dirname(file), path))) bad.push(`${file}: missing target ${raw}`);
        if (path.endsWith('/') || path === '.' || path.endsWith('..') || !/\.[a-z0-9]+$/i.test(path)) bad.push(`${file}: ${raw}`);
      }
      const refresh = html.match(/content="0; url=([^"]*)"/)?.[1];
      if (refresh && !refresh.split('#')[0]!.endsWith('index.html')) bad.push(`${file}: refresh ${refresh}`);
    }
    expect(bad).toEqual([]);

    const def = await Bun.file(join(defaultDir, 'index.html')).text();
    expect(def).toContain('href="./how-to/give-feedback/"');
    expect(def).not.toContain('index.html"');
    const nested = await Bun.file(join(defaultDir, 'how-to', 'give-feedback', 'index.html')).text();
    expect(nested).toMatch(/class="next" href="[^"]*\/"/);
    expect(nested).not.toMatch(/href="[^"#]*index\.html/);
  } finally {
    await rm(localDir, { recursive: true, force: true });
    await rm(defaultDir, { recursive: true, force: true });
  }
});

// INVARIANT: pages that were removed keep their URLs through redirect stubs, and
// Start here is the first navigation item.
test('removed pages redirect and Start here leads the navigation', async () => {
  const docsDir = join(import.meta.dir, '..', '..', 'public-docs');
  const outDir = await mkdtemp(join(tmpdir(), 'lazy-docs-redirect-'));
  try {
    const manifest = await buildDocsSite({ docsDir, outDir, nav: DOCS_NAV });
    expect(manifest.problems).toEqual([]);
    const expected: Record<string, string> = {
      'lazy-agent-design': 'architecture/index',
      'lazy-report-example-20260523': 'reference/cli/report',
      'legacy-mcp-config-purge': 'credentials',
    };
    for (const [from, to] of Object.entries(expected)) {
      expect(manifest.redirects).toContainEqual({ from, to });
      expect(await Bun.file(join(outDir, from, 'index.html')).text()).toContain(`../${to}/`);
    }
    expect(DOCS_NAV.sections[0]!.items[0]).toEqual({ path: 'start-here' });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
