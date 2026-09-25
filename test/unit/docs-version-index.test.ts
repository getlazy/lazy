/**
 * The docs site's landing page lists every published /vMAJOR.MINOR/ directory.
 *
 * INVARIANT: the list is sourced from the publish tree itself and rewritten on
 * every publish, including a re-publish of an OLD version, when the root copy is
 * deliberately left alone. Without that, the root page — a copy of the newest
 * build — is the only way in, and older versions are undiscoverable.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  injectVersionIndex,
  sortVersionsNewestFirst,
  writeVersionIndex,
  VERSION_INDEX_START,
} from '../../src/docs/version-index';

const PAGE = '<html><body><main class="wrap">\n<h1>lazy documentation</h1>\n</main>\n</body></html>\n';

describe('docs version index', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dvi-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('sorts numerically, newest first, ignoring non-version names', () => {
    expect(sortVersionsNewestFirst(['v0.9', 'v0.22', 'blog', 'v1.0', 'v0.21', 'v0.x'])).toEqual([
      'v1.0',
      'v0.22',
      'v0.21',
      'v0.9',
    ]);
  });

  test('inserts before </main> into a page rendered without a marker', () => {
    const html = injectVersionIndex(PAGE, ['v0.22', 'v0.21']);
    expect(html).toContain('<a href="./v0.22/">v0.22</a>');
    expect(html.indexOf(VERSION_INDEX_START)).toBeLessThan(html.indexOf('</main>'));
  });

  test('replaces an existing block instead of stacking a second one', () => {
    const once = injectVersionIndex(PAGE, ['v0.21']);
    const twice = injectVersionIndex(once, ['v0.22', 'v0.21']);
    expect(twice.split(VERSION_INDEX_START).length).toBe(2);
    expect(twice).toContain('./v0.22/');
  });

  test('refuses a page the generator did not render', () => {
    expect(() => injectVersionIndex('<html></html>', ['v0.22'])).toThrow(/<\/main>/);
  });

  test('re-publishing an old version adds it to a root page that is not refreshed', async () => {
    // Root is the v0.22 copy and already lists v0.22; v0.20 is newly re-published.
    for (const v of ['v0.22', 'v0.20']) await mkdir(join(dir, v));
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, 'index.html'), injectVersionIndex(PAGE, ['v0.22']));

    expect(await writeVersionIndex(dir)).toEqual(['v0.22', 'v0.20']);
    const html = await readFile(join(dir, 'index.html'), 'utf-8');
    expect(html).toContain('<h1>lazy documentation</h1>');
    expect(html.indexOf('./v0.22/')).toBeLessThan(html.indexOf('./v0.20/'));
  });
});
