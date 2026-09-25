/**
 * Vendored xterm.js assets for the web shell, served offline.
 *
 * Same posture as mermaid (src/server/mermaid.ts): the dist files are imported
 * `with { type: 'text' }` so they compile into the `lazy` binary and are served
 * from `/assets/*` — no CDN at runtime, the dashboard works offline. A
 * from-source process re-reads node_modules so an xterm upgrade is a reload
 * away; the compiled binary serves the copy baked in at build time.
 *
 * Loaded lazily: only a page that opens a shell panel fetches these, so
 * ordinary dashboard pages pay nothing for them.
 */

import { readFile } from 'fs/promises';

// @ts-expect-error xterm.js ships as a UMD bundle without a text-import type
import xtermJs from '@xterm/xterm/lib/xterm.js' with { type: 'text' };
// @ts-expect-error addon-fit ships as a UMD bundle without a text-import type
import xtermFitJs from '@xterm/addon-fit/lib/addon-fit.js' with { type: 'text' };
import xtermCss from '@xterm/xterm/css/xterm.css' with { type: 'text' };

export const XTERM_JS_PATH = '/assets/xterm.js';
export const XTERM_FIT_JS_PATH = '/assets/xterm-fit.js';
export const XTERM_CSS_PATH = '/assets/xterm.css';

export function bundledXtermJs(): string { return xtermJs; }
export function bundledXtermFitJs(): string { return xtermFitJs; }
export function bundledXtermCss(): string { return xtermCss; }

async function fromDisk(specifier: string): Promise<string> {
  const resolved = await import.meta.resolve(specifier);
  const path = resolved.startsWith('file:') ? new URL(resolved).pathname : resolved;
  return readFile(path, 'utf-8');
}

export function xtermJsFromDisk(): Promise<string> { return fromDisk('@xterm/xterm/lib/xterm.js'); }
export function xtermFitJsFromDisk(): Promise<string> { return fromDisk('@xterm/addon-fit/lib/addon-fit.js'); }
export function xtermCssFromDisk(): Promise<string> { return fromDisk('@xterm/xterm/css/xterm.css'); }
