/**
 * The docs.getlazy.dev static site generator: `docs/**\/*.md` → HTML + a manifest.
 *
 * WHY THIS IS HAND-ROLLED. The site has exactly three jobs — render markdown,
 * slug headings the way GitHub slugs them, and rewrite intra-docs links — and a
 * general-purpose SSG would bring a theme system, a plugin graph and a config
 * file to do them. Plain Bun plus `marked` plus `github-slugger` is the whole
 * dependency budget, and the output is deterministic (no timestamps), so a
 * rebuild that changed nothing produces a git-empty commit rather than churn.
 *
 * WHY IT LIVES IN src/ AND NOT scripts/. `test/unit/docs-links.test.ts` builds
 * the site in-process to validate every {@link DOCS_PAGES} URL and `#fragment`
 * against the RENDERER, and `src/**` is what the public repo ships (see
 * .releaseinclude) — a generator under scripts/ would leave that test importing
 * a file that does not exist there. scripts/build-docs-site.ts is the CLI
 * wrapper around this module and holds no logic of its own.
 *
 * ANCHOR PARITY IS THE POINT. DOCS_PAGES carries fragments like
 * `troubleshooting#lazytoml-wont-parse`, which are GitHub's slugs for those
 * headings — that is what a reader gets when they click the same heading in the
 * repo. `github-slugger` implements exactly GitHub's algorithm, including its
 * duplicate-suffix counter, so the site and the repo agree. Slugs are computed
 * from the heading's rendered TEXT (`` `lazy.toml` won't parse `` → the text
 * `lazy.toml won't parse`), never from its markdown source, because that is
 * what GitHub does.
 *
 * The generator never talks to the network and never shells out, so everything
 * about the site except "is it actually served" is testable offline.
 */

import { mkdir, readdir, readFile, writeFile, copyFile, rm } from 'fs/promises';
import { dirname, join, posix } from 'path';
import { fileURLToPath } from 'url';
import { Marked } from 'marked';
import GithubSlugger from 'github-slugger';
import type { DocsNav, NavItem } from './nav';
import { validateDiagram } from './diagrams';

/** One rendered page, as recorded in the manifest. */
export interface DocsSitePage {
  /** URL path with no leading slash and no extension: `troubleshooting`, `design/loop-queue-mode`. */
  path: string;
  /** The `docs/`-relative markdown file this was rendered from. */
  source: string;
  /** Output file, relative to the site root: `troubleshooting/index.html`. */
  file: string;
  /** Page title — the first level-1 heading, else a prettified file name. */
  title: string;
  /** Every heading anchor id emitted on this page, in document order. */
  anchors: string[];
}

/** A relative link the generator could not resolve to anything it published. */
export interface DocsSiteUnresolvedLink {
  /** The `docs/`-relative file the link was written in. */
  source: string;
  /** The href exactly as it appeared in the markdown. */
  href: string;
}

/** The machine-readable description of a built site. */
export interface DocsSiteManifest {
  /** Version directory this build is for (`v0.21`), or null for an unversioned build. */
  version: string | null;
  /** Every rendered page, sorted by path. */
  pages: DocsSitePage[];
  /** Non-markdown files copied through verbatim (images, diagrams), sorted. */
  assets: string[];
  /**
   * Relative links that point at nothing this site publishes — a missing page or
   * asset, or a `#fragment` that is not a heading on its target page. Never fatal
   * here — see {@link buildDocsSite}.
   */
  unresolvedLinks: DocsSiteUnresolvedLink[];
  /** Redirect stubs written, from the navigation manifest. */
  redirects: { from: string; to: string }[];
  /**
   * Everything `strict` refuses, one human-readable line each: unresolved
   * links, links into the internal `docs/` tree, pages the navigation does not
   * list, navigation entries with no page, redirects that do not resolve.
   */
  problems: string[];
}

export interface BuildDocsSiteOptions {
  /** Directory holding the markdown tree (this repo's `docs/`). */
  docsDir: string;
  /** Directory to write the site into. Created if absent; existing content is left alone unless `clean`. */
  outDir: string;
  /**
   * `docs/`-relative directory names to skip entirely. Defaults to
   * {@link DEFAULT_EXCLUDED_DIRS}. Matching is on the full relative directory
   * path, so `design` excludes `public-docs/design/` but not `public-docs/x/design/`.
   */
  exclude?: string[];
  /** Version label rendered in the page header (`v0.21`). Purely cosmetic; also recorded in the manifest. */
  version?: string | null;
  /** Remove `outDir` before writing. Off by default so a caller can layer builds. */
  clean?: boolean;
  /** Emit a `CNAME` file with this hostname (GitHub Pages custom domain). */
  cname?: string;
  /**
   * The navigation manifest (`DOCS_NAV` from src/docs/nav.ts for the real
   * site). Drives the sidebar, breadcrumbs, previous/next, the index page and
   * redirect stubs. Without one, pages get no sidebar and the index lists every
   * page grouped by directory.
   */
  nav?: DocsNav;
  /**
   * Throw, after writing the site, when {@link DocsSiteManifest.problems} is
   * non-empty. The error lists every problem, not just the first.
   */
  strict?: boolean;
  /**
   * Preview mode for opening the output from `file://`: every internal link names
   * its `index.html` explicitly, because a browser shows a folder listing for a
   * directory link on disk. The default output (directory links) is unchanged.
   */
  local?: boolean;
}

/**
 * Directories under `public-docs/` the site never publishes.
 *
 * The primary control on what is public is the TREE, not this list:
 * `public-docs/` is the published documentation and `docs/` is internal
 * material (spikes, research, reviews, obsolete designs, runbooks) that the
 * generator never reads and `.releaseinclude` never ships. Where a file lives
 * decides who may read it.
 *
 * This list survives that split as defence in depth, for a working directory
 * that ends up inside the public tree anyway. It is a DENY list — a new
 * directory under `public-docs/` is published by default — which is exactly
 * why the tree split, and not this constant, is what the policy rests on.
 * See docs/docs-site.md § What gets published.
 */
export const DEFAULT_EXCLUDED_DIRS = ['scratch'];

/** Files under `public-docs/` that are never published regardless of directory. */
const EXCLUDED_FILE_NAMES = new Set(['.DS_Store']);

/** Extensions copied through verbatim as assets. Anything else is ignored. */
const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
  '.mmd', '.json', '.txt', '.csv', '.pdf',
]);

/**
 * Build the site.
 *
 * Returns the manifest rather than only writing it, so tests can assert against
 * the structure without re-reading JSON off disk.
 *
 * Unresolved links are REPORTED, not thrown. A stale cross-reference inside a
 * doc is a content bug that predates any given build, and failing the release
 * on one would make an unrelated typo block shipping. The CLI prints them and
 * `--strict` turns them fatal for anyone who wants that gate.
 */
export async function buildDocsSite(options: BuildDocsSiteOptions): Promise<DocsSiteManifest> {
  const { docsDir, outDir } = options;
  const exclude = new Set(options.exclude ?? DEFAULT_EXCLUDED_DIRS);
  const version = options.version ?? null;
  const local = options.local ?? false;

  if (options.clean) {
    await rm(outDir, { recursive: true, force: true });
  }

  const { markdown, assets } = await collectTree(docsDir, exclude);

  if (markdown.includes('index.md')) {
    throw new Error(
      `public-docs/index.md is not supported by the docs site generator: the generator owns ` +
      `index.html (it renders the page listing there). Rename the file, or teach ` +
      `src/docs/site.ts to use it as the site index.`,
    );
  }

  const nav = options.nav ?? null;
  const redirects = nav?.redirects ?? [];
  const problems: string[] = [];

  // Everything the site publishes, so link rewriting can tell "points at a page
  // we render" from "points at something that will 404". A redirect source is
  // publishable too: its stub sends the reader on.
  const redirectSources = new Set(redirects.map((redirect) => `${redirect.from}.md`));
  const knownPages = new Set([...markdown, ...redirectSources]);
  const knownAssets = new Set(assets);

  const pages: DocsSitePage[] = [];
  const bodies = new Map<string, string>();
  const unresolvedLinks: DocsSiteUnresolvedLink[] = [];
  const fragmentLinks: (FragmentLink & { source: string })[] = [];
  const idsBySource = new Map<string, Set<string>>();

  for (const source of markdown) {
    const raw = await readFile(join(docsDir, source), 'utf-8');
    const rendered = renderPage({ source, markdown: raw, knownPages, knownAssets, local });
    for (const diagram of rendered.diagrams) {
      try { await validateDiagram(diagram); }
      catch (error) { problems.push(`${source}: invalid Mermaid diagram: ${String(error)}`); }
    }
    unresolvedLinks.push(...rendered.unresolved.map((href) => ({ source, href })));
    fragmentLinks.push(...rendered.fragmentLinks.map((link) => ({ source, ...link })));

    const pagePath = source.replace(/\.md$/, '');
    const file = posix.join(pagePath, 'index.html');
    bodies.set(pagePath, rendered.html);
    idsBySource.set(source, new Set([...rendered.anchors, ...htmlIds(rendered.html)]));
    pages.push({ path: pagePath, source, file, title: rendered.title, anchors: rendered.anchors });
  }

  pages.sort((a, b) => a.path.localeCompare(b.path));

  // A link to a heading that is not on its page lands the reader at the top,
  // silently — as much a dead end as a missing page, so it counts as unresolved.
  // Ids written as raw HTML (`<a id="…">`) count: they are real targets.
  // A fragment on a redirect source is not checked here: the stub has no
  // headings, and the redirect's own target is checked below.
  for (const link of fragmentLinks) {
    if (redirectSources.has(link.target)) continue;
    if (!idsBySource.get(link.target)?.has(link.fragment)) {
      unresolvedLinks.push({ source: link.source, href: link.href });
    }
  }

  for (const link of unresolvedLinks) {
    const sourceDir = posix.dirname(link.source) === '.' ? '' : posix.dirname(link.source);
    const target = posix.normalize(posix.join(sourceDir, link.href.split('#')[0] ?? ''));
    problems.push(
      target === '../docs' || target.startsWith('../docs/')
        ? `${link.source}: link into the internal docs/ tree, which is never published: ${link.href}`
        : `${link.source}: broken link: ${link.href}`,
    );
  }

  const titles = new Map(pages.map((page) => [page.path, page.title]));
  const resolvedNav = nav ? resolveNav(nav, pages, problems) : null;

  for (const page of pages) {
    const chrome = resolvedNav ? navChrome(resolvedNav, page.path, local) : null;
    const html = pageHtml({
      title: page.title,
      body: withOutline(bodies.get(page.path) ?? ''),
      version,
      // Depth of the page directory, so the header link back to the index is relative.
      toRoot: relativeToRoot(page.path),
      chrome,
      local,
    });
    await writeOut(outDir, page.file, html);
  }

  for (const redirect of redirects) {
    const [targetPath = '', fragment] = redirect.to.split('#');
    if (titles.has(redirect.from)) {
      // Never write the stub over a real page.
      problems.push(`redirect ${redirect.from}: a page still exists at that path; delete it or drop the redirect`);
      continue;
    }
    const targetIds = idsBySource.get(`${targetPath}.md`);
    if (!targetIds && targetPath !== '') {
      problems.push(`redirect ${redirect.from} -> ${redirect.to}: no page at ${targetPath}`);
    } else if (fragment && !targetIds?.has(fragment)) {
      problems.push(`redirect ${redirect.from} -> ${redirect.to}: no heading #${fragment} on ${targetPath}`);
    }
    const href = siteHref(redirect.from, targetPath, local) + (fragment ? `#${fragment}` : '');
    await writeOut(outDir, posix.join(redirect.from, 'index.html'), redirectHtml(titles.get(targetPath) ?? redirect.to, href));
  }

  for (const asset of assets) {
    const target = join(outDir, ...asset.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(docsDir, asset), target);
  }

  // Offline search: the index is a .js file setting a global, because a browser
  // blocks fetch() of a .json from file://.
  await writeOut(outDir, SEARCH_INDEX_FILE, searchIndexJs(pages, bodies));
  await copyFile(fileURLToPath(new URL('./search.js', import.meta.url)), join(outDir, SEARCH_SCRIPT_FILE));
  const bundle = await Bun.build({ entrypoints: [fileURLToPath(new URL('./diagrams-browser.ts', import.meta.url))], target: 'browser', minify: true });
  if (!bundle.success) throw new Error(`Could not bundle docs diagrams: ${bundle.logs.join('\n')}`);
  await writeOut(outDir, 'diagrams.js', await bundle.outputs[0]!.text());

  await writeOut(
    outDir,
    'index.html',
    resolvedNav ? navIndexHtml(resolvedNav, version, local) : indexHtml(pages, version, local),
  );

  // GitHub Pages runs Jekyll unless told not to, and Jekyll silently drops any
  // path with a leading underscore. Nothing here has one today; the file costs
  // nothing and removes a whole class of "why is that page missing".
  await writeOut(outDir, '.nojekyll', '');

  if (options.cname) {
    await writeOut(outDir, 'CNAME', `${options.cname}\n`);
  }

  const manifest: DocsSiteManifest = {
    version,
    pages,
    assets: [...assets].sort(),
    unresolvedLinks,
    redirects: redirects.map(({ from, to }) => ({ from, to })),
    problems,
  };
  await writeOut(outDir, 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');

  if (options.strict && problems.length > 0) {
    throw new Error(
      `docs site strict build found ${problems.length} problem(s):\n` +
      problems.map((problem) => `  - ${problem}`).join('\n'),
    );
  }

  return manifest;
}

export const SEARCH_INDEX_FILE = 'search-index.js';
export const SEARCH_SCRIPT_FILE = 'search.js';

/** Generated CLI reference: the whole help text (usage and flags) is indexed, code blocks included. */
const FULL_CODE_PREFIXES = ['reference/cli/'];

/** One indexed page: `s` is `[heading, anchor id, plain body text]` per section; the first may have no heading. */
export interface SearchIndexPage {
  p: string;
  t: string;
  s: [string, string, string][];
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function htmlText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * The terms worth finding in an example: flags (`--env-file`), `[section]`
 * headers and `key =` names. Prose inside a code block is left out, so the
 * index stays small.
 */
export function codeTerms(code: string): string[] {
  const terms = new Set<string>();
  for (const flag of code.matchAll(/(?<![\w-])--[a-z][\w-]*/gi)) terms.add(flag[0]);
  for (const header of code.matchAll(/^\s*\[{1,2}([A-Za-z_][\w.-]*)\]{1,2}\s*$/gm)) terms.add(`[${header[1]}]`);
  for (const key of code.matchAll(/^\s*([A-Za-z_][\w.-]*)\s*=/gm)) terms.add(key[1]!);
  return [...terms];
}

/** A code block's text with its line breaks kept (the term extractor reads lines). */
function preText(pre: string): string {
  return decodeEntities(pre.replace(/<[^>]*>/g, ''));
}

/**
 * Split a rendered page body into searchable sections at its headings. With
 * `fullCode` the code blocks are indexed whole (the CLI reference); otherwise
 * only their flags and config keys are, appended to the section's text.
 */
export function searchSections(html: string, fullCode: boolean): [string, string, string][] {
  const sections: [string, string, string][] = [];
  let heading = '';
  let id = '';
  let last = 0;
  const flush = (end: number): void => {
    const chunk = html.slice(last, end);
    const blocks = [...chunk.matchAll(/<pre[\s\S]*?<\/pre>/g)].map((m) => preText(m[0]));
    const prose = htmlText(chunk.replace(/<pre[\s\S]*?<\/pre>/g, ' '));
    const code = fullCode
      ? blocks.join(' ').replace(/\s+/g, ' ').trim()
      : codeTerms(blocks.join('\n')).join(' ');
    const body = [prose, code].filter(Boolean).join(' ');
    if (heading !== '' || body !== '') sections.push([heading, id, body]);
  };
  for (const match of html.matchAll(/<h([1-6]) id="([^"]*)">([\s\S]*?)<\/h\1>/g)) {
    flush(match.index ?? 0);
    heading = htmlText((match[3] ?? '').replace(/<a class="anchor"[\s\S]*?<\/a>/, ''));
    id = decodeEntities(match[2] ?? '');
    last = (match.index ?? 0) + match[0].length;
  }
  flush(html.length);
  return sections;
}

function searchIndexJs(pages: DocsSitePage[], bodies: Map<string, string>): string {
  const index = pages.map((page): SearchIndexPage => ({
    p: page.path,
    t: page.title,
    s: searchSections(bodies.get(page.path) ?? '', FULL_CODE_PREFIXES.some((prefix) => page.path.startsWith(prefix))),
  }));
  // `<` is escaped so no page text can close the script it is served as.
  return `window.LAZY_DOCS_INDEX=${JSON.stringify({ v: 1, pages: index }).replace(/</g, '\\u003c')};\n`;
}

/** Walk the docs tree, returning `docs/`-relative markdown and asset paths (posix separators). */
async function collectTree(
  docsDir: string,
  exclude: Set<string>,
): Promise<{ markdown: string[]; assets: string[] }> {
  const markdown: string[] = [];
  const assets: string[] = [];

  async function walk(relDir: string): Promise<void> {
    const entries = await readdir(join(docsDir, relDir), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relDir ? posix.join(relDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (exclude.has(rel) || entry.name.startsWith('.')) continue;
        await walk(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (EXCLUDED_FILE_NAMES.has(entry.name)) continue;
      if (rel.endsWith('.md')) {
        markdown.push(rel);
      } else if (ASSET_EXTENSIONS.has(extname(entry.name))) {
        assets.push(rel);
      }
    }
  }

  await walk('');
  return { markdown: markdown.sort(), assets: assets.sort() };
}

function extname(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** `foo/bar` → `../../`; `foo` → `../`; `` → `` (used for links back to the site root). */
function relativeToRoot(pagePath: string): string {
  const depth = pagePath.split('/').length;
  return '../'.repeat(depth);
}

async function writeOut(outDir: string, file: string, content: string): Promise<void> {
  const target = join(outDir, ...file.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf-8');
}

interface RenderPageInput {
  source: string;
  markdown: string;
  knownPages: Set<string>;
  knownAssets: Set<string>;
  local: boolean;
}

interface RenderedPage {
  html: string;
  title: string;
  anchors: string[];
  unresolved: string[];
  fragmentLinks: FragmentLink[];
  diagrams: string[];
}

/**
 * Percent-decode a fragment for comparison with heading slugs. A malformed
 * escape (`#50%-off`) is compared as written — it then simply does not match —
 * because a link problem is reported, never fatal to the build.
 */
function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch (err) {
    if (err instanceof URIError) return fragment;
    throw err;
  }
}

/** A link with a `#fragment` into a page this site renders; `target` is that page's source path. */
interface FragmentLink {
  href: string;
  target: string;
  fragment: string;
}

/**
 * Render one markdown file, collecting its heading anchors and rewriting its
 * relative links to site paths.
 *
 * A fresh {@link Marked} and a fresh {@link GithubSlugger} per page is
 * deliberate: the slugger's duplicate counter is per-DOCUMENT on GitHub, so
 * sharing one across pages would start appending `-1` to the second page's
 * repeated heading and silently break its anchors.
 */
function renderPage(input: RenderPageInput): RenderedPage {
  const { source, markdown, knownPages, knownAssets, local } = input;
  const slugger = new GithubSlugger();
  const anchors: string[] = [];
  const unresolved: string[] = [];
  const fragmentLinks: FragmentLink[] = [];
  const diagrams: string[] = [];
  let title = '';

  // Where this page's HTML lands, so rewritten links can be relative to it.
  const pageDir = source.replace(/\.md$/, '');
  const sourceDir = posix.dirname(source) === '.' ? '' : posix.dirname(source);

  const rewrite = (href: string): string => {
    const result = resolveHref({ href, sourceDir, pageDir, knownPages, knownAssets, local });
    if (result === null) {
      unresolved.push(href);
      return href;
    }
    // Remember `page.md#frag` / `#frag` links into our own pages: whether the
    // fragment exists is only knowable once every page's anchors are collected.
    const hashAt = href.indexOf('#');
    if (hashAt !== -1 && hashAt < href.length - 1 && !/^([a-z][a-z0-9+.-]*:|\/)/i.test(href)) {
      const pathPart = href.slice(0, hashAt);
      const target = pathPart === '' ? source : posix.normalize(posix.join(sourceDir, pathPart));
      if (target.endsWith('.md')) {
        fragmentLinks.push({ href, target, fragment: decodeFragment(href.slice(hashAt + 1)) });
      }
    }
    return result;
  };

  const marked = new Marked({
    renderer: {
      code(token: { text: string; lang?: string }) {
        if (token.lang !== 'mermaid') {
          return false;
        }
        const caption = token.text.match(/^%% caption: (.+)$/m)?.[1];
        if (!caption) {
          diagrams.push('INVALID CAPTION');
          return '<p>Diagram has no caption.</p>';
        }
        const source = token.text.replace(/^%% caption: .+\n?/m, '');
        diagrams.push(source);
        return `<figure class="doc-diagram"><pre>${escapeHtml(source)}</pre><figcaption>${escapeHtml(caption)}</figcaption></figure>\n`;
      },
      heading(this: { parser: { parseInline(tokens: unknown[]): string } }, token: {
        depth: number;
        tokens: unknown[];
      }) {
        const text = this.parser.parseInline(token.tokens);
        const id = slugger.slug(plainText(token.tokens));
        anchors.push(id);
        // Plain text from the TOKENS, escaped once at output. Stripping tags from
        // the rendered HTML kept its entities (`&#39;`), which the page template
        // then escaped a second time.
        if (token.depth === 1 && !title) title = titleText(token.tokens);
        return `<h${token.depth} id="${escapeAttr(id)}">` +
          `<a class="anchor" href="#${escapeAttr(id)}" aria-hidden="true">#</a>${text}` +
          `</h${token.depth}>\n`;
      },
      link(this: { parser: { parseInline(tokens: unknown[]): string } }, token: {
        href: string;
        title?: string | null;
        tokens: unknown[];
      }) {
        const href = rewrite(token.href);
        const titleAttr = token.title ? ` title="${escapeAttr(token.title)}"` : '';
        const external = /^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('mailto:');
        const rel = external ? ' rel="noopener noreferrer"' : '';
        return `<a href="${escapeAttr(href)}"${titleAttr}${rel}>${this.parser.parseInline(token.tokens)}</a>`;
      },
      image(token: { href: string; title?: string | null; text: string }) {
        const href = rewrite(token.href);
        const titleAttr = token.title ? ` title="${escapeAttr(token.title)}"` : '';
        return `<img src="${escapeAttr(href)}" alt="${escapeAttr(token.text)}"${titleAttr} loading="lazy">`;
      },
    },
  });

  const html = marked.parse(markdown, { async: false }) as string;

  if (!title) title = prettifyName(source);

  return { html, title, anchors, unresolved, fragmentLinks, diagrams };
}

interface ResolveHrefInput {
  href: string;
  /** `docs/`-relative directory the markdown file lives in (`''` at the root). */
  sourceDir: string;
  /** Site-relative directory the rendered page lands in. */
  pageDir: string;
  knownPages: Set<string>;
  knownAssets: Set<string>;
  local: boolean;
}

/**
 * Rewrite one href, or return null when it points at nothing this site publishes.
 *
 * Absolute URLs, `mailto:`, protocol-relative URLs and pure `#fragment` links
 * pass through untouched. Everything else is resolved against the markdown
 * file's directory and then re-expressed relative to the rendered page's
 * directory — which is NOT the same directory, because `public-docs/a/b.md` renders to
 * `a/b/index.html`. Getting that wrong is the classic pretty-URL bug: every
 * sibling link ends up one level too high.
 *
 * Site-relative (`/foo`) links are left alone: the same HTML is served from both
 * `/v0.21/` and `/`, so an absolute path can only be right in one of them. The
 * generator never emits one, and a doc that hand-writes one is on its own.
 */
function resolveHref(input: ResolveHrefInput): string | null {
  const { href, sourceDir, pageDir, knownPages, knownAssets, local } = input;

  if (href === '') return href;
  if (href.startsWith('#')) return href;
  if (href.startsWith('//')) return href;
  if (href.startsWith('/')) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href;

  const hashAt = href.indexOf('#');
  const fragment = hashAt === -1 ? '' : href.slice(hashAt);
  const pathPart = hashAt === -1 ? href : href.slice(0, hashAt);

  // A bare `#frag` was handled above; `foo.md#frag` and `foo.md` both land here.
  if (pathPart === '') return href;

  const target = posix.normalize(posix.join(sourceDir, pathPart));
  if (target.startsWith('..')) return null; // escapes docs/ — not ours to serve

  if (target.endsWith('.md')) {
    if (!knownPages.has(target)) return null;
    const targetDir = target.replace(/\.md$/, '');
    return `${relativeSitePath(pageDir, targetDir)}/${local ? 'index.html' : ''}${fragment}`;
  }

  if (knownAssets.has(target)) {
    return `${relativeSitePath(pageDir, target)}${fragment}`;
  }

  return null;
}

/**
 * A relative path from one site directory to another site path, always starting
 * with `./` or `../` so it can never be mistaken for a protocol-relative URL.
 */
function relativeSitePath(fromDir: string, to: string): string {
  const rel = posix.relative(fromDir, to);
  if (rel === '') return '.';
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * The plain-text content of inline tokens, which is what GitHub slugs.
 *
 * `` ## `lazy.toml` won't parse `` slugs from `lazy.toml won't parse`, not from
 * the backticked markdown — the difference decides whether the fragment is
 * `lazytoml-wont-parse` (right) or something with backticks stripped
 * differently (wrong, and only discovered by a reader hitting a dead anchor).
 */
function plainText(tokens: unknown[]): string {
  let out = '';
  for (const token of tokens as Array<{ type?: string; text?: string; tokens?: unknown[] }>) {
    if (token.tokens && token.type !== 'codespan') {
      out += plainText(token.tokens);
    } else if (typeof token.text === 'string') {
      out += token.text;
    }
  }
  return out;
}

/** Like {@link plainText}, but drops raw inline HTML, which is markup, not words. */
function titleText(tokens: unknown[]): string {
  let out = '';
  for (const token of tokens as Array<{ type?: string; text?: string; tokens?: unknown[] }>) {
    if (token.type === 'html') continue;
    if (token.tokens && token.type !== 'codespan') {
      out += titleText(token.tokens);
    } else if (typeof token.text === 'string') {
      out += token.text;
    }
  }
  return out.trim();
}

/** `id`/`name` attributes written as raw HTML in a page (`<a id="removing-someone">`). */
function htmlIds(html: string): string[] {
  const ids: string[] = [];
  for (const match of html.matchAll(/<a\s(?:[^>]*\s)?(?:id|name)="([^"]+)"/g)) {
    if (match[1]) ids.push(match[1]);
  }
  return ids;
}

function prettifyName(source: string): string {
  const base = source.replace(/\.md$/, '').split('/').pop() ?? source;
  return base.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

/** Inlined so a page is one request and works from any directory depth. */
const STYLES = `
:root { color-scheme: light dark; --fg:#1b1f23; --bg:#fff; --muted:#57606a; --line:#d8dee4; --link:#0969da; --code:#f6f8fa; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e6edf3; --bg:#0d1117; --muted:#9198a1; --line:#30363d; --link:#4493f8; --code:#161b22; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
.wrap { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1.25rem 6rem; }
header.site { border-bottom:1px solid var(--line); }
header.site .wrap { max-width:76rem; display:flex; flex-wrap:wrap; gap:.75rem; align-items:baseline; padding-block:1rem; }
header.site a { color:var(--fg); text-decoration:none; font-weight:600; }
header.site .version { color:var(--muted); font-size:.85rem; }
a { color: var(--link); }
h1,h2,h3,h4,h5,h6 { line-height:1.25; margin:2rem 0 .75rem; scroll-margin-top:1rem; }
h1 { font-size:1.9rem; margin-top:1rem; }
h2 { font-size:1.4rem; padding-bottom:.25rem; border-bottom:1px solid var(--line); }
a.anchor { float:left; margin-left:-1em; padding-right:.25em; color:var(--muted); text-decoration:none; opacity:0; }
h1:hover a.anchor, h2:hover a.anchor, h3:hover a.anchor, h4:hover a.anchor { opacity:1; }
code { background:var(--code); padding:.15em .35em; border-radius:4px; font-size:.9em; }
pre { background:var(--code); padding:1rem; border-radius:6px; overflow-x:auto; }
pre code { background:none; padding:0; font-size:.85em; }
table { border-collapse:collapse; width:100%; overflow-x:auto; display:block; }
.doc-diagram { margin:1.5rem 0; overflow-x:auto; }
.doc-diagram svg { min-width:40rem; max-width:100%; height:auto; background:#fff; border:1px solid var(--line); border-radius:8px; }
.doc-diagram figcaption { color:var(--muted); font-size:.9rem; text-align:center; }
th,td { border:1px solid var(--line); padding:.4rem .6rem; text-align:left; }
blockquote { margin:1rem 0; padding:.25rem 1rem; border-left:4px solid var(--line); color:var(--muted); }
img { max-width:100%; }
hr { border:0; border-top:1px solid var(--line); margin:2rem 0; }
ul.pages { list-style:none; padding:0; }
ul.pages li { padding:.3rem 0; border-bottom:1px solid var(--line); }
ul.pages .path { color:var(--muted); font-size:.8rem; margin-left:.5rem; }
h2.group { margin-top:2.5rem; }
p.intro { color:var(--muted); margin-top:-.25rem; }
ul.pages li.group { border-bottom:0; padding-top:.9rem; font-weight:600; color:var(--muted); font-size:.85rem; text-transform:uppercase; letter-spacing:.03em; }
ul.pages li.in-group { padding-left:1rem; }
header.site .contents { margin-left:auto; font-weight:400; font-size:.9rem; color:var(--link); }
.layout { display:grid; grid-template-columns:minmax(0,1fr); max-width:76rem; margin:0 auto; }
.layout main { min-width:0; max-width:46rem; padding:1.5rem 1.25rem 4rem; }
.sidebar { border-top:1px solid var(--line); padding:1rem 1.25rem 4rem; font-size:.92rem; }
.sidebar summary { cursor:pointer; padding:.25rem .4rem; border-radius:4px; }
.sidebar > details > summary { font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin-top:.6rem; }
.sidebar li.group > details > summary { color:var(--muted); }
.sidebar ul { list-style:none; margin:0; padding:0; }
.sidebar li { margin:.1rem 0; }
.sidebar details > ul { padding-left:.5rem; }
.sidebar li.group ul { padding-left:.75rem; border-left:1px solid var(--line); }
.sidebar a { text-decoration:none; display:block; padding:.1rem .4rem; border-radius:4px; }
.sidebar a[aria-current="page"] { background:var(--code); color:var(--fg); font-weight:600; }
nav.crumbs { font-size:.85rem; color:var(--muted); }
nav.pager { display:flex; justify-content:space-between; gap:1rem; margin-top:3rem; border-top:1px solid var(--line); padding-top:1rem; }
nav.pager a { text-decoration:none; max-width:48%; }
nav.pager a.next { text-align:right; margin-left:auto; }
nav.pager span { display:block; font-size:.8rem; color:var(--muted); }
header.site .search { position:relative; order:3; flex:1 0 100%; min-width:0; }
nav.toc { margin:1rem 0 1.5rem; padding:.5rem .9rem; border:1px solid var(--line); border-radius:6px; background:var(--code); font-size:.92rem; }
nav.toc summary { cursor:pointer; font-weight:600; }
nav.toc ul { margin:.4rem 0 .2rem; padding-left:1.1rem; columns:1; }
nav.toc li { margin:.15rem 0; }
@media (min-width: 40rem) { nav.toc ul { columns:2; } }
header.site .search input { font:inherit; font-size:.9rem; padding:.25rem .6rem; width:100%; color:var(--fg); background:var(--bg); border:1px solid var(--line); border-radius:6px; }
header.site .search ul.results { position:absolute; right:0; top:2.2rem; z-index:10; width:min(32rem,90vw); max-height:70vh; overflow-y:auto; margin:0; padding:.25rem; list-style:none; background:var(--bg); border:1px solid var(--line); border-radius:6px; box-shadow:0 6px 24px rgba(0,0,0,.2); }
header.site .search ul.results[hidden] { display:none; }
header.site .search ul.results a { display:block; padding:.4rem .6rem; border-radius:4px; font-weight:400; color:var(--fg); }
header.site .search ul.results a strong { display:block; font-size:.9rem; }
header.site .search ul.results a span { display:block; font-size:.8rem; color:var(--muted); }
header.site .search ul.results a[aria-selected="true"], header.site .search ul.results a:hover { background:var(--code); }
header.site .search li.none { padding:.4rem .6rem; color:var(--muted); font-size:.9rem; }
@media (min-width: 60rem) {
  header.site .search { margin-left:auto; order:0; flex:1 1 6rem; max-width:14rem; }
  header.site .contents { display:none; }
  .layout { grid-template-columns:16rem minmax(0,1fr); }
  .sidebar { grid-column:1; grid-row:1; border-top:0; border-right:1px solid var(--line); position:sticky; top:0; align-self:start; max-height:100vh; overflow-y:auto; }
  .layout main { grid-column:2; padding-left:2.5rem; }
}
`.trim();

/** One navigation entry after `dir` items are expanded and titles are known. */
interface NavEntry {
  path: string;
  title: string;
  section: string;
  /** Sub-group label inside the section, if any. */
  group: string | null;
  /**
   * The directory a `{ dir }` item expanded this entry from, when that directory
   * has an `index` page. Outside that directory the sidebar and the front page show
   * only the index, so 100+ generated pages do not swamp the navigation.
   */
  collapsedDir?: string;
}

interface ResolvedNav {
  sections: { title: string; id: string; intro: string; entries: NavEntry[] }[];
  /** Every published page, for the collapsed "All pages" list at the bottom of the sidebar. */
  allPages: NavEntry[];
  /** Every entry in reading order — what previous/next follows. */
  order: NavEntry[];
}

/**
 * Expand the manifest against the pages that actually exist, recording a
 * problem for each entry with no page, each page listed twice, and each page the
 * manifest does not list.
 */
function resolveNav(nav: DocsNav, pages: DocsSitePage[], problems: string[]): ResolvedNav {
  const titles = new Map(pages.map((page) => [page.path, page.title]));
  const listed = new Set<string>();
  const slugger = new GithubSlugger();
  const order: NavEntry[] = [];
  const sections: ResolvedNav['sections'] = [];

  for (const section of nav.sections) {
    const entries: NavEntry[] = [];
    const add = (path: string, title: string | undefined, group: string | null, collapsedDir?: string): void => {
      if (path !== '' && !titles.has(path)) {
        problems.push(`navigation lists ${path}, but public-docs/${path}.md does not exist`);
        return;
      }
      if (listed.has(path)) {
        problems.push(`navigation lists ${path || 'the index'} more than once`);
        return;
      }
      listed.add(path);
      entries.push({ path, title: title ?? titles.get(path) ?? 'Overview', section: section.title, group, collapsedDir });
    };
    const addItem = (item: NavItem, group: string | null): void => {
      if ('group' in item) {
        for (const child of item.items) addItem(child, item.group);
      } else if ('dir' in item) {
        const prefix = `${item.dir}/`;
        const index = `${item.dir}/index`;
        const hasIndex = titles.has(index);
        // The directory's own index page leads its group; the rest follow in path order.
        const inDir = pages.map((page) => page.path).filter((path) => path.startsWith(prefix));
        const ordered = hasIndex ? [index, ...inDir.filter((path) => path !== index)] : inDir;
        for (const path of ordered) add(path, undefined, group ?? item.title, hasIndex ? item.dir : undefined);
      } else {
        add(item.path, item.title, group);
      }
    };
    for (const item of section.items) addItem(item, null);
    order.push(...entries);
    sections.push({ title: section.title, id: slugger.slug(section.title), intro: section.intro, entries });
  }

  for (const page of pages) {
    if (!listed.has(page.path)) {
      problems.push(`${page.source} is not listed in the navigation (src/docs/nav.ts)`);
    }
  }
  const allPages = [...pages]
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((page): NavEntry => ({ path: page.path, title: page.title, section: ALL_PAGES_TITLE, group: null }));
  return { sections, order, allPages };
}

const ALL_PAGES_TITLE = 'All pages';

/** Relative href from the page at `from` to the page at `to` (`''` is the index). */
function siteHref(from: string, to: string, local: boolean): string {
  const up = from === '' ? './' : relativeToRoot(from);
  const leaf = local ? 'index.html' : '';
  return to === '' ? `${up}${leaf}` : `${up}${to}/${leaf}`;
}

interface NavChrome {
  sidebar: string;
  breadcrumbs: string;
  pager: string;
}

/** Whether a nav entry is shown in a listing for the page at `current` (see `collapsedDir`). */
function shownFor(entry: NavEntry, current: string): boolean {
  if (!entry.collapsedDir) return true;
  return entry.path === `${entry.collapsedDir}/index` || current.startsWith(`${entry.collapsedDir}/`);
}

/** Sidebar, breadcrumbs and previous/next for one page. */
function navChrome(nav: ResolvedNav, current: string, local: boolean): NavChrome {
  const link = (entry: NavEntry): string => {
    const here = entry.path === current;
    return `<a href="${escapeAttr(siteHref(current, entry.path, local))}"${here ? ' aria-current="page"' : ''}>` +
      `${escapeHtml(entry.title)}</a>`;
  };

  // Every branch is a <details> (no JS, works from file://) that starts closed
  // unless it holds the current page, so the reader sees where they are.
  const sidebarSections = nav.sections
    .filter((section) => section.entries.length > 0)
    .map((section) => {
      const open = section.entries.some((entry) => entry.path === current);
      let html = `<details class="branch"${open ? ' open' : ''}><summary>${escapeHtml(section.title)}</summary>\n<ul>`;
      let group: string | null = null;
      let groupHtml = '';
      let groupOpen = false;
      const flush = (): void => {
        if (group === null) return;
        html += `<li class="group"><details class="branch"${groupOpen ? ' open' : ''}>` +
          `<summary>${escapeHtml(group)}</summary><ul>${groupHtml}</ul></details></li>`;
        group = null;
        groupHtml = '';
        groupOpen = false;
      };
      for (const entry of section.entries) {
        // A generated group named like its section would just repeat the heading.
        const label = entry.group === section.title ? null : entry.group;
        if (label !== group) flush();
        if (label === null) {
          html += `<li>${link(entry)}</li>`;
        } else {
          group = label;
          groupHtml += `<li>${link(entry)}</li>`;
          if (entry.path === current) groupOpen = true;
        }
      }
      flush();
      return `${html}</ul></details>`;
    });
  // Collapsed always: it repeats pages the tree above already places, so it must
  // never open on its own or carry a second current-page marker.
  const allPages = nav.allPages.length > 0
    ? `<details class="branch all-pages"><summary>${ALL_PAGES_TITLE}</summary>\n<ul>` +
      nav.allPages
        .map((entry) => `<li><a href="${escapeAttr(siteHref(current, entry.path, local))}">${escapeHtml(entry.title)}</a></li>`)
        .join('') +
      '</ul></details>'
    : '';
  const sidebar = [...sidebarSections, allPages].filter(Boolean).join('\n');

  const at = nav.order.findIndex((entry) => entry.path === current);
  const entry = at === -1 ? null : nav.order[at]!;
  const section = entry ? nav.sections.find((candidate) => candidate.title === entry.section) : undefined;
  const breadcrumbs = entry && section && entry.path !== ''
    ? `<nav class="crumbs" aria-label="Breadcrumbs"><a href="${escapeAttr(siteHref(current, '', local))}#${escapeAttr(section.id)}">` +
      `${escapeHtml(section.title)}</a>${entry.group ? ` › ${escapeHtml(entry.group)}` : ''} › ` +
      `<span aria-current="page">${escapeHtml(entry.title)}</span></nav>`
    : '';

  const prev = at > 0 ? nav.order[at - 1] : undefined;
  const next = at !== -1 ? nav.order[at + 1] : undefined;
  const pager = prev || next
    ? `<nav class="pager" aria-label="Previous and next">` +
      (prev ? `<a class="prev" href="${escapeAttr(siteHref(current, prev.path, local))}"><span>Previous</span>${escapeHtml(prev.title)}</a>` : '<span></span>') +
      (next ? `<a class="next" href="${escapeAttr(siteHref(current, next.path, local))}"><span>Next</span>${escapeHtml(next.title)}</a>` : '<span></span>') +
      `</nav>`
    : '';

  return { sidebar, breadcrumbs, pager };
}

/** A page gets an "On this page" outline from this many h2 headings up. */
export const OUTLINE_MIN_H2 = 5;
/** The outline starts open up to this many entries; a longer one opens on click. */
const OUTLINE_OPEN_MAX = 14;

/**
 * Insert an "On this page" outline (the page's h2 headings, linked by their
 * existing anchors) after the title of a long page. Static HTML in a native
 * `<details>`: it works with no script, in both builds, at any width. Pages
 * with fewer h2 headings than {@link OUTLINE_MIN_H2} are returned unchanged.
 */
export function withOutline(html: string): string {
  const entries = [...html.matchAll(/<h2 id="([^"]*)">([\s\S]*?)<\/h2>/g)].map((m) => ({
    id: m[1] ?? '',
    text: htmlText((m[2] ?? '').replace(/<a class="anchor"[\s\S]*?<\/a>/, '')),
  }));
  if (entries.length < OUTLINE_MIN_H2) return html;
  const outline = `<nav class="toc" aria-label="On this page"><details${entries.length <= OUTLINE_OPEN_MAX ? ' open' : ''}>` +
    `<summary>On this page</summary><ul>` +
    entries.map((e) => `<li><a href="#${e.id}">${escapeHtml(e.text)}</a></li>`).join('') +
    `</ul></details></nav>\n`;
  const h1 = html.match(/<\/h1>\n?/);
  if (!h1 || h1.index === undefined) return outline + html;
  const at = h1.index + h1[0].length;
  return html.slice(0, at) + outline + html.slice(at);
}

function pageHtml(input: {
  title: string;
  body: string;
  version: string | null;
  toRoot: string;
  chrome?: NavChrome | null;
  local?: boolean;
}): string {
  const version = input.version ? `<span class="version">${escapeHtml(input.version)}</span>` : '';
  const chrome = input.chrome ?? null;
  // The sidebar comes AFTER the content in the document, so a phone shows the
  // page first; on a wide screen the grid places it on the left.
  const main = chrome
    ? `<div class="layout">
<main>
${chrome.breadcrumbs}
${input.body}
${chrome.pager}
</main>
<nav class="sidebar" id="contents" aria-label="Documentation">
${chrome.sidebar}
</nav>
</div>`
    : `<main class="wrap">
${input.body}
</main>`;
  const contents = chrome ? `<a class="contents" href="#contents">Contents</a>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)} — lazy docs</title>
<style>${STYLES}</style>
<script defer src="${input.toRoot || './'}${SEARCH_INDEX_FILE}"></script>
<script defer src="${input.toRoot || './'}diagrams.js"></script>
<script defer src="${input.toRoot || './'}${SEARCH_SCRIPT_FILE}" data-root="${input.toRoot || './'}"${input.local ? ' data-local="1"' : ''}></script>
</head>
<body>
<header class="site"><div class="wrap"><a href="${input.local ? `${input.toRoot}index.html` : input.toRoot || '.'}">lazy documentation</a>${version}${contents}</div></header>
${main}
</body>
</html>
`;
}

/** The index page: the navigation tree with each section's intro. */
function navIndexHtml(nav: ResolvedNav, version: string | null, local: boolean): string {
  const sections = nav.sections
    .filter((section) => section.entries.some((entry) => entry.path !== ''))
    .map((section) => {
      let html = `<h2 class="group" id="${escapeAttr(section.id)}">${escapeHtml(section.title)}</h2>\n` +
        `<p class="intro">${escapeHtml(section.intro)}</p>\n<ul class="pages">`;
      let group: string | null = null;
      for (const entry of section.entries) {
        if (entry.path === '' || !shownFor(entry, '')) continue;
        if (entry.group !== group && entry.group !== null) {
          html += `<li class="group">${escapeHtml(entry.group)}</li>`;
        }
        group = entry.group;
        html += `<li${entry.group ? ' class="in-group"' : ''}><a href="./${escapeAttr(entry.path)}/${local ? 'index.html' : ''}">${escapeHtml(entry.title)}</a></li>`;
      }
      return `${html}</ul>`;
    })
    .join('\n');

  const body = `<h1>lazy documentation</h1>
<p>lazy runs coding agents on your repository as tasks: each task works on its own branch, in its own
container, and stops for you to review, send feedback, and accept its work into your branch. The easiest
way in is the dashboard: open it in your browser with <code>lazy dashboard</code>. The <code>lazy</code>
command line covers everything too, and its strongest tool is the builder in your terminal. Lazy Teams
(private alpha) brings the same workflow to a shared team server.</p>
<p>New here? Begin with <a href="./start-here/${local ? 'index.html' : ''}">Start here</a>. ${escapeHtml(nav.sections[0]?.intro ?? '')} ${
    version ? `This is <strong>${escapeHtml(version)}</strong>.` : ''
  }</p>
${sections}`;

  return pageHtml({ title: 'lazy documentation', body, version, toRoot: '', chrome: navChrome(nav, '', local), local });
}

/**
 * A stub for a page that moved: meta refresh, canonical link and a visible
 * link, all relative, so the same stub works under `/v0.NN/` and at the root.
 */
function redirectHtml(title: string, href: string): string {
  const target = escapeAttr(href);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moved: ${escapeHtml(title)} — lazy docs</title>
<link rel="canonical" href="${target}">
<meta http-equiv="refresh" content="0; url=${target}">
</head>
<body>
<p>This page has moved to <a href="${target}">${escapeHtml(title)}</a>.</p>
</body>
</html>
`;
}

function indexHtml(pages: DocsSitePage[], version: string | null, local: boolean): string {
  const groups = new Map<string, DocsSitePage[]>();
  for (const page of pages) {
    const dir = page.path.includes('/') ? page.path.slice(0, page.path.lastIndexOf('/')) : '';
    const list = groups.get(dir);
    if (list) list.push(page);
    else groups.set(dir, [page]);
  }

  const sections: string[] = [];
  for (const dir of [...groups.keys()].sort()) {
    const heading = dir === '' ? '' : `<h2 class="group">${escapeHtml(dir)}/</h2>\n`;
    const items = (groups.get(dir) ?? [])
      .map(
        (page) =>
          `<li><a href="./${escapeAttr(page.path)}/${local ? 'index.html' : ''}">${escapeHtml(page.title)}</a>` +
          `<span class="path">${escapeHtml(page.path)}</span></li>`,
      )
      .join('\n');
    sections.push(`${heading}<ul class="pages">\n${items}\n</ul>`);
  }

  const body = `<h1>lazy documentation</h1>
<p>Every page of lazy's documentation. ${
    version ? `This is <strong>${escapeHtml(version)}</strong>.` : ''
  }</p>
${sections.join('\n')}`;

  return pageHtml({ title: 'lazy documentation', body, version, toRoot: '', local });
}

