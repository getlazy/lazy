import { describe, test, expect, afterEach, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_DOCS_URL,
  DOCS_DOMAIN,
  DOCS_PAGES,
  DOCS_VERSION_SEGMENT,
  docsFooter,
  docsSuffix,
  docsUrl,
  docsVersionSegment,
  getDocsBaseUrl,
  normalizeDocsUrl,
  resetDocsBaseUrl,
  setDocsBaseUrl,
  type DocsPage,
} from '../../src/docs/links';
import { buildDocsSite, type DocsSiteManifest } from '../../src/docs/site';
import { VERSION } from '../../src/version';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const PAGES = Object.keys(DOCS_PAGES) as DocsPage[];

/**
 * The site built from THIS repo's docs/ tree, shared by every test below that
 * needs it. Built once — the generator is pure and its output is deterministic,
 * so one build serves them all.
 */
let manifest: DocsSiteManifest;
let siteDir: string;

beforeAll(async () => {
  siteDir = await mkdtemp(join(tmpdir(), 'lazy-docs-site-'));
  manifest = await buildDocsSite({
    docsDir: join(REPO_ROOT, 'public-docs'),
    outDir: siteDir,
    version: DOCS_VERSION_SEGMENT,
  });
});

afterAll(async () => {
  await rm(siteDir, { recursive: true, force: true });
});

describe('docs links', () => {
  afterEach(() => {
    resetDocsBaseUrl();
  });

  // INVARIANT: a link that 404s is worse than no link at all. The docs site
  // renders this repo's docs/ tree, so every registered page must name a
  // markdown file that actually exists. Deleting or renaming a docs page
  // without updating DOCS_PAGES fails here rather than in a user's terminal.
  describe('registry', () => {
    for (const page of PAGES) {
      test(`${page} points at a docs file that exists`, async () => {
        const source = DOCS_PAGES[page].source;
        const info = await stat(join(REPO_ROOT, 'public-docs', source));
        expect(info.isFile()).toBe(true);
      });
    }

    // INVARIANT: the URL convention is `<base>/<docs path without .md>`.
    // A path that does not derive from its source file means the convention
    // drifted, and the link resolves to a page the site does not render.
    for (const page of PAGES) {
      test(`${page} path follows the <source-without-.md> convention`, () => {
        const { path, source } = DOCS_PAGES[page];
        const expected = source.replace(/\.md$/, '');
        const [base] = path.split('#');
        expect(base).toBe(expected);
      });
    }

    test('paths carry no leading or trailing slash', () => {
      for (const page of PAGES) {
        expect(DOCS_PAGES[page].path.startsWith('/')).toBe(false);
        expect(DOCS_PAGES[page].path.endsWith('/')).toBe(false);
      }
    });
  });

  // INVARIANT: every registered page resolves ON THE SITE WE ACTUALLY BUILD.
  //
  // Anchors are validated against the RENDERER, not against a grep of the
  // markdown, because the fragment is not in the markdown — it is derived from
  // the heading by GitHub's slugging algorithm, and every step of that
  // derivation is a place to be wrong. `## \`lazy.toml\` won't parse` becomes
  // `lazytoml-wont-parse` only if the slugger sees the heading's rendered TEXT
  // (backticks gone, apostrophe dropped, dot dropped); a grep would happily
  // "confirm" a fragment the site never emits, and a repeated heading picks up
  // a `-1` suffix that no amount of reading the source reveals. Building the
  // site here means the thing under test is the thing that gets served.
  describe('registry resolves against the generated site', () => {
    test('the generator emits a page for every registered path', () => {
      const emitted = new Set(manifest.pages.map((page) => page.path));
      for (const page of PAGES) {
        const [base] = DOCS_PAGES[page].path.split('#');
        expect({ page, base, emitted: emitted.has(base) }).toEqual({ page, base, emitted: true });
      }
    });

    test('every #fragment is an anchor the page actually renders', () => {
      const byPath = new Map(manifest.pages.map((page) => [page.path, page]));
      for (const page of PAGES) {
        const [base, fragment] = DOCS_PAGES[page].path.split('#');
        if (!fragment) continue;
        const rendered = byPath.get(base);
        expect(rendered).toBeDefined();
        expect({ page, fragment, present: rendered!.anchors.includes(fragment) }).toEqual({
          page,
          fragment,
          present: true,
        });
      }
    });

    test('the rendered page really carries that id in its HTML', async () => {
      // Belt and braces on the manifest: an anchor recorded but not emitted
      // would still 404 for a reader. Checked on the one page that has
      // registered fragments rather than on all 58, because this is a check on
      // the manifest/HTML agreement, not on each page's content.
      const html = await Bun.file(join(siteDir, 'troubleshooting', 'index.html')).text();
      for (const page of PAGES) {
        const [, fragment] = DOCS_PAGES[page].path.split('#');
        if (!fragment || !DOCS_PAGES[page].path.startsWith('troubleshooting')) continue;
        expect(html).toContain(`id="${fragment}"`);
      }
    });
  });

  // INVARIANT: a pointer printed by a build lands on the docs THAT build
  // shipped with. The site keeps one directory per minor and never rewrites an
  // old one, so a version-pinned URL stays correct forever; an unpinned one
  // silently drifts onto whatever the docs say a year later.
  describe('version pinning', () => {
    test('the default base is the domain plus this build\'s version segment', () => {
      expect(DOCS_VERSION_SEGMENT).toBe(`v${VERSION.split('.').slice(0, 2).join('.')}`);
      expect(DEFAULT_DOCS_URL).toBe(`${DOCS_DOMAIN}/${DOCS_VERSION_SEGMENT}`);
      expect(docsUrl('search')).toBe(`${DOCS_DOMAIN}/${DOCS_VERSION_SEGMENT}/search`);
    });

    test('the segment is major.minor only — the patch and -alpha never reach it', () => {
      expect(docsVersionSegment('0.21.1373')).toBe('v0.21');
      expect(docsVersionSegment('0.21.1373-alpha')).toBe('v0.21');
      expect(docsVersionSegment('1.0.0')).toBe('v1.0');
    });

    // A version string that is not a numeric pair means no segment rather than
    // a garbage one: the site root serves a copy of the newest version, so an
    // unpinned pointer still resolves, while `/vgarbage/` never would.
    test('a non-numeric version yields no segment instead of a broken one', () => {
      expect(docsVersionSegment('')).toBe(null);
      expect(docsVersionSegment('nightly')).toBe(null);
      expect(docsVersionSegment('0')).toBe(null);
      expect(docsVersionSegment('0.x.1')).toBe(null);
    });

    // INVARIANT: a configured mirror is used VERBATIM. Appending our version
    // layout to someone else's site would 404 in a way they cannot fix from
    // their side — mirrors own their own paths.
    test('a configured mirror never gains a version segment', () => {
      expect(normalizeDocsUrl('https://docs.acme.internal/lazy')).toBe('https://docs.acme.internal/lazy');
      setDocsBaseUrl(normalizeDocsUrl('https://docs.acme.internal/lazy'));
      expect(docsUrl('search')).toBe('https://docs.acme.internal/lazy/search');
      expect(docsUrl('search')).not.toContain(DOCS_VERSION_SEGMENT!);
    });
  });

  describe('normalizeDocsUrl', () => {
    test('an absent key means the default domain', () => {
      expect(normalizeDocsUrl(undefined)).toBe(DEFAULT_DOCS_URL);
      expect(normalizeDocsUrl(null)).toBe(DEFAULT_DOCS_URL);
    });

    test('"" and false disable doc pointers', () => {
      expect(normalizeDocsUrl('')).toBe(null);
      expect(normalizeDocsUrl('   ')).toBe(null);
      expect(normalizeDocsUrl(false)).toBe(null);
    });

    test('accepts http(s) bases and strips trailing slashes', () => {
      expect(normalizeDocsUrl('https://docs.example.com')).toBe('https://docs.example.com');
      expect(normalizeDocsUrl('https://docs.example.com/')).toBe('https://docs.example.com');
      expect(normalizeDocsUrl('https://example.com/lazy/docs//')).toBe('https://example.com/lazy/docs');
      expect(normalizeDocsUrl('http://localhost:4000')).toBe('http://localhost:4000');
      expect(normalizeDocsUrl('  https://docs.example.com  ')).toBe('https://docs.example.com');
    });

    // INVARIANT: an unusable value in lazy.toml is the user's bug and they hear
    // about it at load time — silently dropping to "no links ever appear" would
    // leave them debugging a missing feature instead of a typo.
    test('rejects non-strings, non-URLs and unsupported schemes', () => {
      expect(() => normalizeDocsUrl(true)).toThrow(/must be a string/);
      expect(() => normalizeDocsUrl(42)).toThrow(/must be a string/);
      expect(() => normalizeDocsUrl({})).toThrow(/must be a string/);
      expect(() => normalizeDocsUrl('docs.getlazy.dev')).toThrow(/not a valid URL/);
      expect(() => normalizeDocsUrl('file:///tmp/docs')).toThrow(/not supported/);
      expect(() => normalizeDocsUrl('ftp://docs.example.com')).toThrow(/not supported/);
    });

    test('error messages name the section and the way out', () => {
      expect(() => normalizeDocsUrl('nope')).toThrow(/\[docs\]/);
      expect(() => normalizeDocsUrl('nope')).toThrow(/to disable documentation links/);
    });
  });

  describe('composition', () => {
    test('defaults to the hosted domain', () => {
      expect(getDocsBaseUrl()).toBe(DEFAULT_DOCS_URL);
      expect(docsUrl('protected-branches')).toBe(`${DEFAULT_DOCS_URL}/protected-branches`);
    });

    test('fragment slugs survive composition', () => {
      expect(docsUrl('troubleshooting-daemon')).toBe(
        `${DEFAULT_DOCS_URL}/troubleshooting#the-daemon-wont-start`,
      );
    });

    test('a configured mirror replaces the domain everywhere', () => {
      setDocsBaseUrl('https://docs.acme.internal/lazy');
      expect(docsUrl('search')).toBe('https://docs.acme.internal/lazy/search');
      expect(docsSuffix('search')).toBe(' Check documentation at https://docs.acme.internal/lazy/search');
      expect(docsFooter()).toBe('\n\nDocumentation: https://docs.acme.internal/lazy');
    });

    test('setDocsBaseUrl strips a trailing slash so composition never doubles it', () => {
      setDocsBaseUrl('https://docs.example.com/');
      expect(docsUrl('memory')).toBe('https://docs.example.com/memory');
    });

    test('docsSuffix uses the caller-supplied separator', () => {
      expect(docsSuffix('memory', '\n\n')).toBe(
        `\n\nCheck documentation at ${DEFAULT_DOCS_URL}/memory`,
      );
    });

    test('docsFooter without a page points at the docs home', () => {
      expect(docsFooter()).toBe(`\n\nDocumentation: ${DEFAULT_DOCS_URL}`);
    });
  });

  // INVARIANT: doc pointers are a SUPPLEMENT, never load-bearing. With docs
  // disabled every helper yields an empty string, so a call site can
  // interpolate it unconditionally and the message still reads correctly.
  describe('disabled', () => {
    test('every helper degrades to nothing', () => {
      setDocsBaseUrl(null);
      expect(getDocsBaseUrl()).toBe(null);
      expect(docsUrl('protected-branches')).toBe(null);
      expect(docsSuffix('protected-branches')).toBe('');
      expect(docsSuffix('protected-branches', '\n\n')).toBe('');
      expect(docsFooter()).toBe('');
      expect(docsFooter('troubleshooting')).toBe('');
    });

    test('an empty string install is the same as disabled', () => {
      setDocsBaseUrl('');
      expect(getDocsBaseUrl()).toBe(null);
      expect(docsFooter('search')).toBe('');
    });

    test('interpolating a disabled pointer leaves the message intact', () => {
      setDocsBaseUrl(null);
      const message = `Error: something went wrong. Run 'lazy doctor'.${docsSuffix('troubleshooting')}`;
      expect(message).toBe(`Error: something went wrong. Run 'lazy doctor'.`);
    });
  });
});
