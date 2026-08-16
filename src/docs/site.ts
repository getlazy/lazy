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
import { Marked } from 'marked';
import GithubSlugger from 'github-slugger';

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
  /** Relative links that point at nothing this site publishes. Never fatal here — see {@link buildDocsSite}. */
  unresolvedLinks: DocsSiteUnresolvedLink[];
}

export interface BuildDocsSiteOptions {
  /** Directory holding the markdown tree (this repo's `docs/`). */
  docsDir: string;
  /** Directory to write the site into. Created if absent; existing content is left alone unless `clean`. */
  outDir: string;
  /**
   * `docs/`-relative directory names to skip entirely. Defaults to
   * {@link DEFAULT_EXCLUDED_DIRS}. Matching is on the full relative directory
   * path, so `design` excludes `docs/design/` but not `docs/x/design/`.
   */
  exclude?: string[];
  /** Version label rendered in the page header (`v0.21`). Purely cosmetic; also recorded in the manifest. */
  version?: string | null;
  /** Remove `outDir` before writing. Off by default so a caller can layer builds. */
  clean?: boolean;
  /** Emit a `CNAME` file with this hostname (GitHub Pages custom domain). */
  cname?: string;
}

/**
 * Directories under `docs/` the site never publishes.
 *
 * ONE list, deliberately: "what is public" is a policy question and it should be
 * answerable by reading a single constant rather than by tracing a build script.
 * `scratch/` is the builder's own working area (docs/builder-scratch-dir.md) and
 * has never been intended for readers.
 *
 * Note that this is a DENY list — a new directory under docs/ is published by
 * default. That is the opposite of `.releaseinclude`, which is an allowlist for
 * the public source tarball. See docs/docs-site.md § What gets published.
 */
export const DEFAULT_EXCLUDED_DIRS = ['scratch'];

/** Files under `docs/` that are never published regardless of directory. */
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

  if (options.clean) {
    await rm(outDir, { recursive: true, force: true });
  }

  const { markdown, assets } = await collectTree(docsDir, exclude);

  if (markdown.includes('index.md')) {
    throw new Error(
      `docs/index.md is not supported by the docs site generator: the generator owns ` +
      `index.html (it renders the page listing there). Rename the file, or teach ` +
      `src/docs/site.ts to use it as the site index.`,
    );
  }

  // Everything the site publishes, so link rewriting can tell "points at a page
  // we render" from "points at something that will 404".
  const knownPages = new Set(markdown);
  const knownAssets = new Set(assets);

  const pages: DocsSitePage[] = [];
  const unresolvedLinks: DocsSiteUnresolvedLink[] = [];

  for (const source of markdown) {
    const raw = await readFile(join(docsDir, source), 'utf-8');
    const rendered = renderPage({ source, markdown: raw, knownPages, knownAssets });
    unresolvedLinks.push(...rendered.unresolved.map((href) => ({ source, href })));

    const pagePath = source.replace(/\.md$/, '');
    const file = posix.join(pagePath, 'index.html');
    const html = pageHtml({
      title: rendered.title,
      body: rendered.html,
      version,
      // Depth of the page directory, so the header link back to the index is relative.
      toRoot: relativeToRoot(pagePath),
    });

    await writeOut(outDir, file, html);
    pages.push({ path: pagePath, source, file, title: rendered.title, anchors: rendered.anchors });
  }

  pages.sort((a, b) => a.path.localeCompare(b.path));

  for (const asset of assets) {
    const target = join(outDir, ...asset.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(docsDir, asset), target);
  }

  await writeOut(outDir, 'index.html', indexHtml(pages, version));

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
  };
  await writeOut(outDir, 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');

  return manifest;
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
}

interface RenderedPage {
  html: string;
  title: string;
  anchors: string[];
  unresolved: string[];
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
  const { source, markdown, knownPages, knownAssets } = input;
  const slugger = new GithubSlugger();
  const anchors: string[] = [];
  const unresolved: string[] = [];
  let title = '';

  // Where this page's HTML lands, so rewritten links can be relative to it.
  const pageDir = source.replace(/\.md$/, '');
  const sourceDir = posix.dirname(source) === '.' ? '' : posix.dirname(source);

  const rewrite = (href: string): string => {
    const result = resolveHref({ href, sourceDir, pageDir, knownPages, knownAssets });
    if (result === null) {
      unresolved.push(href);
      return href;
    }
    return result;
  };

  const marked = new Marked({
    renderer: {
      heading(this: { parser: { parseInline(tokens: unknown[]): string } }, token: {
        depth: number;
        tokens: unknown[];
      }) {
        const text = this.parser.parseInline(token.tokens);
        const id = slugger.slug(plainText(token.tokens));
        anchors.push(id);
        if (token.depth === 1 && !title) title = stripTags(text);
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

  return { html, title, anchors, unresolved };
}

interface ResolveHrefInput {
  href: string;
  /** `docs/`-relative directory the markdown file lives in (`''` at the root). */
  sourceDir: string;
  /** Site-relative directory the rendered page lands in. */
  pageDir: string;
  knownPages: Set<string>;
  knownAssets: Set<string>;
}

/**
 * Rewrite one href, or return null when it points at nothing this site publishes.
 *
 * Absolute URLs, `mailto:`, protocol-relative URLs and pure `#fragment` links
 * pass through untouched. Everything else is resolved against the markdown
 * file's directory and then re-expressed relative to the rendered page's
 * directory — which is NOT the same directory, because `docs/a/b.md` renders to
 * `a/b/index.html`. Getting that wrong is the classic pretty-URL bug: every
 * sibling link ends up one level too high.
 *
 * Site-relative (`/foo`) links are left alone: the same HTML is served from both
 * `/v0.21/` and `/`, so an absolute path can only be right in one of them. The
 * generator never emits one, and a doc that hand-writes one is on its own.
 */
function resolveHref(input: ResolveHrefInput): string | null {
  const { href, sourceDir, pageDir, knownPages, knownAssets } = input;

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
    return `${relativeSitePath(pageDir, targetDir)}/${fragment}`;
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

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
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
header.site .wrap { display:flex; gap:.75rem; align-items:baseline; padding-block:1rem; }
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
th,td { border:1px solid var(--line); padding:.4rem .6rem; text-align:left; }
blockquote { margin:1rem 0; padding:.25rem 1rem; border-left:4px solid var(--line); color:var(--muted); }
img { max-width:100%; }
hr { border:0; border-top:1px solid var(--line); margin:2rem 0; }
ul.pages { list-style:none; padding:0; }
ul.pages li { padding:.3rem 0; border-bottom:1px solid var(--line); }
ul.pages .path { color:var(--muted); font-size:.8rem; margin-left:.5rem; }
h2.group { margin-top:2.5rem; }
`.trim();

function pageHtml(input: { title: string; body: string; version: string | null; toRoot: string }): string {
  const version = input.version ? `<span class="version">${escapeHtml(input.version)}</span>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)} — lazy docs</title>
<style>${STYLES}</style>
</head>
<body>
<header class="site"><div class="wrap"><a href="${input.toRoot || '.'}">lazy documentation</a>${version}</div></header>
<main class="wrap">
${input.body}
</main>
</body>
</html>
`;
}

function indexHtml(pages: DocsSitePage[], version: string | null): string {
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
          `<li><a href="./${escapeAttr(page.path)}/">${escapeHtml(page.title)}</a>` +
          `<span class="path">${escapeHtml(page.path)}</span></li>`,
      )
      .join('\n');
    sections.push(`${heading}<ul class="pages">\n${items}\n</ul>`);
  }

  const body = `<h1>lazy documentation</h1>
<p>Everything in this build's <code>docs/</code> tree. ${
    version ? `This is <strong>${escapeHtml(version)}</strong>.` : ''
  }</p>
${sections.join('\n')}`;

  return pageHtml({ title: 'lazy documentation', body, version, toRoot: '' });
}

