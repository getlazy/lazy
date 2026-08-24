/**
 * Documentation links: "Check documentation at <url>" pointers for CLI errors,
 * warnings and help text.
 *
 * THE ONE PLACE A DOCS URL IS BUILT. Call sites name a PAGE, never a URL —
 * `docsSuffix('protected-branches')`, not `'https://docs.getlazy.dev/…'`. That
 * keeps the domain substitutable (a fork or an enterprise mirror sets
 * `[docs] url` in lazy.toml) and keeps the slug convention enforceable in one
 * test instead of scattered across dozens of string literals.
 *
 * URL CONVENTION: `<base>/<path-of-the-docs/-file-without-.md>`. The docs site
 * renders this repo's `public-docs/` tree, so `public-docs/protected-branches.md` is
 * `<base>/protected-branches`. Every entry in {@link DOCS_PAGES} therefore
 * names the repo file it is rendered from, and `test/unit/docs-links.test.ts`
 * fails if that file does not exist, if the site generator does not emit a page
 * for it, or if a `#fragment` is not among the anchors that page actually
 * renders — a link that 404s is worse than no link at all.
 *
 * VERSION PINNING: the DEFAULT base carries a `/v<major.minor>/` segment —
 * `https://docs.getlazy.dev/v0.21/protected-branches`. A pointer printed by a
 * given build lands on the docs THAT build shipped with, forever, instead of
 * drifting onto whatever the site says a year later. The segment is derived
 * from {@link VERSION} through the same {@link majorMinor} helper the runner
 * image tag uses, so "the minor this build belongs to" is decided once.
 * docs.getlazy.dev publishes one such directory per minor and never rewrites an
 * old one (docs/docs-site.md).
 *
 * A CONFIGURED `[docs] url` IS USED VERBATIM — no version segment is appended.
 * A mirror owns its own layout; guessing that it mirrors ours would produce
 * 404s nobody can fix from their side. Mirror operators who want pinning put
 * the version in the URL they configure.
 *
 * DEGRADES GRACEFULLY: the hosted site may not exist yet, and a user may point
 * `[docs] url` at nothing. Pointers are always a SUPPLEMENT — every message
 * that carries one is still fully actionable with the pointer removed
 * (CLAUDE.md: "errors are actionable"). When docs are disabled (`url = ""`)
 * every helper here returns an empty string and the message reads normally.
 */

import { VERSION } from '../version';
import { isNumericMajorMinor, majorMinor } from '../utils/version-parts';

/**
 * The default documentation domain, without any version segment. Prefer
 * {@link DEFAULT_DOCS_URL} for composing links; this is the value to show a
 * user in "set it to something like this" guidance.
 */
export const DOCS_DOMAIN = 'https://docs.getlazy.dev';

/**
 * The site directory this build's pointers resolve into (`v0.21`), or null when
 * VERSION has no usable numeric `major.minor` prefix.
 *
 * Null is not an error: a hand-edited package.json version, or a checkout with
 * no git, yields a version string that is not a numeric pair, and emitting
 * `/vgarbage/` into every error message would be strictly worse than pointing
 * at the site root. The root serves a copy of the newest version, so an
 * unversioned pointer still resolves.
 */
export function docsVersionSegment(version: string): string | null {
  const prefix = majorMinor(version);
  return isNumericMajorMinor(prefix) ? `v${prefix}` : null;
}

/** The version segment THIS build pins to (`v0.21`), or null. */
export const DOCS_VERSION_SEGMENT = docsVersionSegment(VERSION);

/**
 * The default documentation base URL for this build — the domain plus this
 * build's version segment. Overridable per project with `[docs] url` in
 * lazy.toml, which is then used verbatim (see the module comment).
 */
export const DEFAULT_DOCS_URL = DOCS_VERSION_SEGMENT
  ? `${DOCS_DOMAIN}/${DOCS_VERSION_SEGMENT}`
  : DOCS_DOMAIN;

/**
 * Every page a pointer may reference, and the repo file it is rendered from.
 *
 * `path` is the URL path (no leading slash); it may carry a `#fragment`.
 * `source` is the docs/-relative markdown file — asserted to exist by
 * test/unit/docs-links.test.ts.
 *
 * Add an entry here before referencing a new page anywhere else.
 */
export const DOCS_PAGES = {
  'protected-branches': { path: 'protected-branches', source: 'protected-branches.md' },
  'resurrection-guard': { path: 'resurrection-guard', source: 'resurrection-guard.md' },
  'lfs-guard': { path: 'lfs-guard', source: 'lfs-guard.md' },
  'lazy-toml': { path: 'lazy-toml', source: 'lazy-toml.md' },
  'search': { path: 'search', source: 'search.md' },
  'memory': { path: 'memory', source: 'memory.md' },
  'conversation-import': { path: 'conversation-import', source: 'conversation-import.md' },
  'agent-container': { path: 'agent-container', source: 'agent-container.md' },
  'state-machine': { path: 'state-machine', source: 'state-machine.md' },
  'troubleshooting': { path: 'troubleshooting', source: 'troubleshooting.md' },
  'troubleshooting-daemon': { path: 'troubleshooting#the-daemon-wont-start', source: 'troubleshooting.md' },
  'troubleshooting-config': { path: 'troubleshooting#lazytoml-wont-parse', source: 'troubleshooting.md' },
  'troubleshooting-credential': { path: 'troubleshooting#no-model-credential', source: 'troubleshooting.md' },
  'troubleshooting-storage-lock': {
    path: 'troubleshooting#every-command-fails-to-acquire-the-storage-lock',
    source: 'troubleshooting.md',
  },
} as const;

export type DocsPage = keyof typeof DOCS_PAGES;

/**
 * Resolved base URL, or null when doc pointers are disabled.
 *
 * Module state, deliberately — the same reason the logger has it. Doc pointers
 * are attached to messages built deep inside guards, drivers and thrown errors
 * that have no config in hand, and threading a ResolvedConfig through those
 * paths to decorate a string would be a far larger change than the feature is
 * worth. It is INSTALLED, never inferred: `loadConfig()` calls
 * {@link setDocsBaseUrl} with the validated value on every load, and
 * src/index.ts installs a best-effort value early so `--help` (which never
 * loads a full config) honours a configured mirror too.
 */
let docsBaseUrl: string | null = DEFAULT_DOCS_URL;

/**
 * Validate and normalize a configured docs URL.
 *
 * Returns the trimmed base (no trailing slash), or null when doc pointers are
 * disabled. Throws on anything that is neither — an unusable value in
 * lazy.toml is the user's bug and they need to hear about it at load time,
 * not by wondering why no links ever appear.
 *
 * An absent key yields {@link DEFAULT_DOCS_URL}, which IS version-pinned. A
 * configured value is returned verbatim (trailing slashes aside) and never
 * gains a version segment — see the module comment.
 */
export function normalizeDocsUrl(raw: unknown): string | null {
  if (raw === undefined || raw === null) return DEFAULT_DOCS_URL;

  // `false` is the documented "turn doc pointers off" spelling alongside "".
  // `true` is not a URL and is not accepted as one.
  if (raw === false) return null;

  if (typeof raw !== 'string') {
    throw new Error(
      `Invalid url = ${JSON.stringify(raw)} in lazy.toml [docs] section: must be a string ` +
      `(an http(s) base URL such as "${DOCS_DOMAIN}", or "" to disable documentation links).`,
    );
  }

  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `Invalid url = "${raw}" in lazy.toml [docs] section: not a valid URL. ` +
      `Use an http(s) base URL such as "${DOCS_DOMAIN}", or "" to disable documentation links.`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid url = "${raw}" in lazy.toml [docs] section: scheme "${parsed.protocol.replace(':', '')}" ` +
      `is not supported — use http:// or https://, or "" to disable documentation links.`,
    );
  }
  return trimmed;
}

/**
 * Install the docs base URL for this process. Pass null (or "") to disable
 * doc pointers entirely. Idempotent — the last install wins.
 */
export function setDocsBaseUrl(url: string | null): void {
  docsBaseUrl = url === null || url === '' ? null : url.replace(/\/+$/, '');
}

/** The installed base URL, or null when doc pointers are disabled. */
export function getDocsBaseUrl(): string | null {
  return docsBaseUrl;
}

/** Restore the built-in default. For tests and for daemon re-init. */
export function resetDocsBaseUrl(): void {
  docsBaseUrl = DEFAULT_DOCS_URL;
}

/**
 * The full URL for a documentation page, or null when doc pointers are
 * disabled.
 */
export function docsUrl(page: DocsPage): string | null {
  if (docsBaseUrl === null) return null;
  return `${docsBaseUrl}/${DOCS_PAGES[page].path}`;
}

/**
 * A sentence to append to an error or warning:
 * `"Check documentation at https://docs.getlazy.dev/protected-branches."`
 *
 * Returns '' when docs are disabled, so call sites can interpolate it
 * unconditionally. `separator` is what goes BETWEEN the message and the
 * pointer (default: a single space) — pass '\n\n' for multi-paragraph errors.
 */
export function docsSuffix(page: DocsPage, separator = ' '): string {
  const url = docsUrl(page);
  if (!url) return '';
  return `${separator}Check documentation at ${url}`;
}

/**
 * A footer line for command help text:
 * `"\n\nDocumentation: https://docs.getlazy.dev/search"`
 *
 * Returns '' when docs are disabled. Omit `page` for the docs home.
 */
export function docsFooter(page?: DocsPage): string {
  const url = page ? docsUrl(page) : docsBaseUrl;
  if (!url) return '';
  return `\n\nDocumentation: ${url}`;
}
