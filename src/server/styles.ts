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
 * WHERE THE LOOK COMES FROM
 * The first part is **Industry**, the design system lazy-teams renders, consumed
 * from `design/industry/styles.css` at the repository root — the Claude Design
 * sync target, and the source of visual truth for both surfaces. There is no
 * copy of it under src/: this file imports the same bytes the Rails app vendors,
 * so a re-sync moves both products at once and neither can quietly fork.
 *
 * `theme.css` is the server UI's own layer on top — semantic roles Industry does
 * not ship, a mono token, the dark-scheme retune — built out of Industry's
 * variables exactly as lazy-teams' `application.css` is. Industry itself is
 * never edited to suit this surface. The procedure is design/README.md.
 *
 * TWO SOURCES, ONE ORDER
 *   - {@link bundledStylesheet} returns the copy compiled INTO the binary via
 *     text imports. This is what the daemon serves: a shipped `lazy` has no
 *     src/server/styles/ directory to read from, and no design/ directory
 *     either — which is exactly why Industry is a text import and not a file
 *     read. A `lazy` running in someone else's project serves the bytes baked
 *     in at build time and never looks for this repository.
 *   - {@link stylesheetFromDisk} re-reads the same files on every call. This is
 *     what a from-source dev process serves, and it is the whole reason a CSS
 *     edit needs no restart of anything.
 * Both compose the parts in {@link STYLESHEET_PARTS} order, so the two can never
 * cascade differently.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

import industryCss from '../../design/industry/styles.css' with { type: 'text' };
import themeCss from './styles/theme.css' with { type: 'text' };
import appCss from './styles/app.css' with { type: 'text' };
import diffCss from './styles/diff.css' with { type: 'text' };
import cardsCss from './styles/cards.css' with { type: 'text' };
import reviewCss from './styles/review.css' with { type: 'text' };
import tasksCss from './styles/tasks.css' with { type: 'text' };
import heatmapCss from './styles/heatmap.css' with { type: 'text' };
import messagesCss from './styles/messages.css' with { type: 'text' };
import conversationsCss from './styles/conversations.css' with { type: 'text' };
import memoryCss from './styles/memory.css' with { type: 'text' };
import settingsCss from './styles/settings.css' with { type: 'text' };
import mermaidCss from './styles/mermaid.css' with { type: 'text' };
import terminalPanelsCss from './styles/terminal-panels.css' with { type: 'text' };
import tabsCss from './styles/tabs.css' with { type: 'text' };
import statsCss from './styles/stats.css' with { type: 'text' };

/** The route every page links to. */
export const STYLESHEET_PATH = '/assets/app.css';

interface StylesheetPart {
  /** Stable name, used by tests and by the disk reader's error messages. */
  readonly name: string;
  /** The bytes compiled into this binary. */
  readonly bundled: string;
  /** Path relative to src/server/, for the from-source reader. */
  readonly path: string;
}

/**
 * Cascade order.
 *
 * `industry.css` MUST come first — it carries the `@import` of the design
 * system's webfonts, and an `@import` is only honoured when it precedes every
 * rule in the sheet. It also declares the `--color-*` / `--font-*` / `--space-*`
 * tokens everything after it reads.
 *
 * `theme.css` MUST come second: it retunes those tokens for dark mode and
 * defines the aliases (`--bg`, `--text`, `--link`, …) the later parts still use.
 */
export const STYLESHEET_PARTS: readonly StylesheetPart[] = [
  { name: 'industry.css', bundled: industryCss, path: '../../design/industry/styles.css' },
  { name: 'theme.css', bundled: themeCss, path: 'styles/theme.css' },
  { name: 'app.css', bundled: appCss, path: 'styles/app.css' },
  { name: 'diff.css', bundled: diffCss, path: 'styles/diff.css' },
  { name: 'cards.css', bundled: cardsCss, path: 'styles/cards.css' },
  { name: 'review.css', bundled: reviewCss, path: 'styles/review.css' },
  { name: 'tasks.css', bundled: tasksCss, path: 'styles/tasks.css' },
  { name: 'heatmap.css', bundled: heatmapCss, path: 'styles/heatmap.css' },
  { name: 'messages.css', bundled: messagesCss, path: 'styles/messages.css' },
  { name: 'conversations.css', bundled: conversationsCss, path: 'styles/conversations.css' },
  { name: 'memory.css', bundled: memoryCss, path: 'styles/memory.css' },
  { name: 'settings.css', bundled: settingsCss, path: 'styles/settings.css' },
  { name: 'mermaid.css', bundled: mermaidCss, path: 'styles/mermaid.css' },
  { name: 'terminal-panels.css', bundled: terminalPanelsCss, path: 'styles/terminal-panels.css' },
  { name: 'tabs.css', bundled: tabsCss, path: 'styles/tabs.css' },
  { name: 'stats.css', bundled: statsCss, path: 'styles/stats.css' },
];

/** The stylesheet as compiled into this binary. */
export function bundledStylesheet(): string {
  return STYLESHEET_PARTS.map((part) => part.bundled).join('\n');
}

/**
 * The stylesheet re-read from disk on every call.
 *
 * Only a process running FROM SOURCE can do this — `import.meta.dir` in a
 * compiled binary is a virtual path with no styles/ directory beside it, and no
 * design/ directory above it. The caller decides which source to use; nothing
 * here guesses.
 */
export async function stylesheetFromDisk(): Promise<string> {
  const parts = await Promise.all(
    STYLESHEET_PARTS.map((part) => readFile(join(import.meta.dir, part.path), 'utf-8')),
  );
  return parts.join('\n');
}
