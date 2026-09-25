/**
 * The version index on the docs site's landing page.
 *
 * The site root is a copy of the NEWEST version's build, so nothing in it knows
 * which other `/vMAJOR.MINOR/` directories exist. This module lists them — from
 * the publish branch's own tree at publish time, never from a second record —
 * and writes that list into the root `index.html`.
 *
 * It runs on EVERY publish, including a re-publish of an old version, which is
 * exactly when the root copy is deliberately left alone: the list still has to
 * be rewritten, because the old version's directory may be new to the branch.
 *
 * The root page may have been rendered by a build that predates this module (a
 * release tag cut before it existed has no marker in its index), so a missing
 * marker block is inserted before `</main>`. A page with neither is not a page
 * this generator produced, and that is an error rather than a silent skip.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const VERSION_INDEX_START = '<!-- lazy-docs-versions:start -->';
export const VERSION_INDEX_END = '<!-- lazy-docs-versions:end -->';

const VERSION_DIR = /^v(\d+)\.(\d+)$/;

/** Version directory names (`v0.22`), newest first. */
export function sortVersionsNewestFirst(names: string[]): string[] {
  return names
    .filter((name) => VERSION_DIR.test(name))
    .sort((a, b) => {
      const [, aMajor, aMinor] = a.match(VERSION_DIR)!;
      const [, bMajor, bMinor] = b.match(VERSION_DIR)!;
      return Number(bMajor) - Number(aMajor) || Number(bMinor) - Number(aMinor);
    });
}

/** Every `vMAJOR.MINOR` directory at the top of a publish tree, newest first. */
export async function listPublishedVersions(pagesDir: string): Promise<string[]> {
  const entries = await readdir(pagesDir, { withFileTypes: true });
  return sortVersionsNewestFirst(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
}

/** The marker-delimited block itself. Links are relative to the site root. */
export function renderVersionIndex(versions: string[]): string {
  const items = versions.map((version) => `<li><a href="./${version}/">${version}</a></li>`).join('\n');
  return `${VERSION_INDEX_START}
<h2 class="group">Published versions</h2>
<p>Every lazy release links to the documentation for its own version.</p>
<ul class="pages">
${items}
</ul>
${VERSION_INDEX_END}`;
}

/** Replace the block in a root page, or insert it before `</main>`. */
export function injectVersionIndex(html: string, versions: string[]): string {
  const block = renderVersionIndex(versions);
  const start = html.indexOf(VERSION_INDEX_START);
  const end = html.indexOf(VERSION_INDEX_END);
  if (start !== -1 && end > start) {
    return html.slice(0, start) + block + html.slice(end + VERSION_INDEX_END.length);
  }
  const mainClose = html.lastIndexOf('</main>');
  if (mainClose === -1) {
    throw new Error(
      'the root index.html has neither a version-index marker nor a </main> to insert one before — ' +
      'it was not rendered by the docs site generator, so the version list cannot be written into it.',
    );
  }
  return `${html.slice(0, mainClose)}${block}\n${html.slice(mainClose)}`;
}

/** Rewrite `<pagesDir>/index.html` with the versions currently in `pagesDir`. */
export async function writeVersionIndex(pagesDir: string): Promise<string[]> {
  const versions = await listPublishedVersions(pagesDir);
  if (versions.length === 0) {
    throw new Error(`no vMAJOR.MINOR directories in ${pagesDir} — nothing to list, and a publish always writes one.`);
  }
  const indexPath = join(pagesDir, 'index.html');
  let html: string;
  try {
    html = await readFile(indexPath, 'utf-8');
  } catch (error) {
    throw new Error(
      `cannot read the site root page ${indexPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await writeFile(indexPath, injectVersionIndex(html, versions));
  return versions;
}
