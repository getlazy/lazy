/**
 * The dashboard stylesheet, served as a file rather than inlined in every page.
 *
 * WHY IT IS A ROUTE AND NOT A `<style>` BLOCK
 * The CSS used to live in template literals inside templates.ts, diff.ts and
 * review.ts. That made a stylesheet edit a CODE edit: the only way to see it was
 * to restart whatever process was rendering the page. For the daemon that means
 * a rebuild and a restart; even under `bun --watch` it means a process restart.
 * Served from its own route, the same edit needs nothing but a reload of the
 * page — the browser re-fetches the route and the route re-reads the file.
 *
 * TWO SOURCES, ONE ORDER
 *   - {@link bundledStylesheet} returns the copy compiled INTO the binary via
 *     text imports. This is what the daemon serves: a shipped `lazy` has no
 *     src/server/styles/ directory to read from.
 *   - {@link stylesheetFromDisk} re-reads the same files on every call. This is
 *     what a from-source dev process serves, and it is the whole reason a CSS
 *     edit needs no restart of anything.
 * Both compose the parts in {@link STYLESHEET_PARTS} order, so the two can never
 * cascade differently.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

import appCss from './styles/app.css' with { type: 'text' };
import diffCss from './styles/diff.css' with { type: 'text' };
import reviewCss from './styles/review.css' with { type: 'text' };
import tasksCss from './styles/tasks.css' with { type: 'text' };
import heatmapCss from './styles/heatmap.css' with { type: 'text' };

/** The route every page links to. */
export const STYLESHEET_PATH = '/assets/app.css';

/**
 * Cascade order. `app.css` MUST come first: it declares the `:root` custom
 * properties (`--bg`, `--link`, …) that every later part reads.
 */
export const STYLESHEET_PARTS = ['app.css', 'diff.css', 'review.css', 'tasks.css', 'heatmap.css'] as const;

const BUNDLED: Record<(typeof STYLESHEET_PARTS)[number], string> = {
  'app.css': appCss,
  'diff.css': diffCss,
  'review.css': reviewCss,
  'tasks.css': tasksCss,
  'heatmap.css': heatmapCss,
};

/** The stylesheet as compiled into this binary. */
export function bundledStylesheet(): string {
  return STYLESHEET_PARTS.map((part) => BUNDLED[part]).join('\n');
}

/**
 * The stylesheet re-read from src/server/styles/ on every call.
 *
 * Only a process running FROM SOURCE can do this — `import.meta.dir` in a
 * compiled binary is a virtual path with no styles/ directory beside it. The
 * caller decides which source to use; nothing here guesses.
 */
export async function stylesheetFromDisk(): Promise<string> {
  const dir = join(import.meta.dir, 'styles');
  const parts = await Promise.all(
    STYLESHEET_PARTS.map((part) => readFile(join(dir, part), 'utf-8')),
  );
  return parts.join('\n');
}
