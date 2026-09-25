/**
 * One resolver decides where a headless Chrome/Chromium lives.
 *
 * Two things in lazy rasterise HTML with a browser — `lazy report --pdf` and
 * the test-side page screenshot helper (`test/helpers/page-screenshot.ts`) that
 * agents use to SHOW their UI work in a turn report. Both used to answer "where
 * is the browser" themselves, and `lazy report --pdf`'s answer was wrong inside
 * an agent container: it looked only at macOS `.app` bundles and four names on
 * PATH, while the container's browser is a Playwright download under
 * `$PLAYWRIGHT_BROWSERS_PATH` that is on nobody's PATH. So the one environment
 * that is guaranteed to have a browser was the one that reported having none.
 *
 * Search order, most-specific first:
 *
 *  1. `$CHROME_BIN` — the widely-used convention, and what lazy's own container
 *     images set. An explicit answer always wins over a search.
 *  2. macOS `.app` bundles, then plain names on PATH — a developer's machine.
 *  3. Playwright's browser downloads under `$PLAYWRIGHT_BROWSERS_PATH`
 *     (default `~/.cache/ms-playwright`), preferring the headless shell, which
 *     is the smaller binary and the one built for exactly this job.
 *
 * Nothing here launches anything: the caller decides the flags, because a PDF
 * render and a screenshot want different ones.
 */

import { access, readdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from './spawn';

/** What to tell a human when no browser turned up. */
export const CHROME_NOT_FOUND_HINT =
  'No headless Chrome/Chromium found. Install one (macOS: Google Chrome or ' +
  '`brew install chromium`; Debian/Ubuntu: `sudo apt-get install -y chromium`), ' +
  'or point $CHROME_BIN at an existing browser binary.';

/** True when `path` exists and can be executed. */
async function isExecutable(path: string): Promise<boolean> {
  try {
    // X_OK is 1; importing the constant would drag in `fs` alongside fs/promises.
    await access(path, 1);
    return true;
  } catch {
    // Missing, or present but not executable — either way, not a candidate.
    return false;
  }
}

/** macOS ships browsers inside `.app` bundles, which are on nobody's PATH. */
const MAC_APP_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

/** Plain executable names to try on PATH. */
const PATH_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'chrome'];

/** Resolve `name` on PATH, or null. */
async function onPath(name: string): Promise<string | null> {
  const proc = spawn(['sh', '-c', `command -v ${name}`], { stdout: 'pipe', stderr: 'ignore' });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const path = stdout.trim();
  return exitCode === 0 && path ? path : null;
}

/**
 * Find a browser inside a Playwright browsers directory. Exported so the walk
 * can be tested against a fixture root — the full {@link findChromeBinary} would
 * find the test machine's own browser long before reaching this step.
 *
 * The layout is `<root>/<package>-<revision>/<platform-dir>/<binary>`, where
 * both the revision and the platform dir vary with the Playwright version and
 * the machine's architecture — so this walks rather than composing a path.
 * `chromium_headless_shell-*` is preferred over `chromium-*`: it is purpose-built
 * for this, and on a full `chromium-*` bundle the extra megabytes buy a UI
 * nothing here will ever show.
 */
export async function findChromeInPlaywrightRoot(root: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    // No Playwright downloads on this machine — an ordinary miss, not an error.
    return null;
  }

  const shells = entries.filter(e => e.startsWith('chromium_headless_shell-')).sort().reverse();
  const fulls = entries.filter(e => e.startsWith('chromium-')).sort().reverse();

  for (const entry of [...shells, ...fulls]) {
    let platformDirs: string[];
    try {
      platformDirs = await readdir(join(root, entry));
    } catch {
      continue;
    }
    for (const platformDir of platformDirs) {
      for (const binary of ['chrome-headless-shell', 'chrome', 'headless_shell']) {
        const candidate = join(root, entry, platformDir, binary);
        if (await isExecutable(candidate)) return candidate;
      }
    }
  }
  return null;
}

/**
 * Locate a Chrome/Chromium binary usable in headless mode, or null.
 *
 * Never throws and never installs anything — a null answer is a normal outcome
 * on a machine with no browser, and the caller decides whether that is fatal
 * ({@link CHROME_NOT_FOUND_HINT} says what to do about it).
 */
export async function findChromeBinary(): Promise<string | null> {
  const explicit = process.env.CHROME_BIN?.trim();
  if (explicit && (await isExecutable(explicit))) return explicit;

  for (const path of MAC_APP_PATHS) {
    if (await isExecutable(path)) return path;
  }

  for (const name of PATH_NAMES) {
    const found = await onPath(name);
    if (found) return found;
  }

  const playwrightRoot = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim()
    || join(homedir(), '.cache', 'ms-playwright');
  return await findChromeInPlaywrightRoot(playwrightRoot);
}
