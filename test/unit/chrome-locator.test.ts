/**
 * Unit coverage for the one resolver that decides where a headless browser is.
 *
 * The case worth locking down is the Playwright one: lazy's agent container has
 * its browser under `$PLAYWRIGHT_BROWSERS_PATH` at a path containing a revision
 * number and an arch-specific directory, and neither is stable across Playwright
 * versions. `lazy report --pdf` used to miss it entirely and report "no browser"
 * inside the one environment guaranteed to have one.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { findChromeBinary, findChromeInPlaywrightRoot } from '../../src/utils/chrome';

let root: string;
const savedChromeBin = process.env.CHROME_BIN;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lazy-chrome-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  if (savedChromeBin === undefined) delete process.env.CHROME_BIN;
  else process.env.CHROME_BIN = savedChromeBin;
});

/** Create an executable stub at `path`. */
async function stubBinary(path: string): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
  return path;
}

describe('findChromeInPlaywrightRoot', () => {
  test('walks the revision and platform directories to the binary', async () => {
    const expected = await stubBinary(
      join(root, 'chromium-1243', 'chrome-linux-arm64', 'chrome'),
    );
    expect(await findChromeInPlaywrightRoot(root)).toBe(expected);
  });

  // The headless shell is the binary built for exactly this job; on an image
  // carrying both, the extra ~130 MB of the full bundle buys a UI nothing here
  // will ever show.
  test('prefers the headless shell over the full chromium bundle', async () => {
    await stubBinary(join(root, 'chromium-1243', 'chrome-linux-arm64', 'chrome'));
    const shell = await stubBinary(
      join(root, 'chromium_headless_shell-1243', 'chrome-headless-shell-linux-arm64', 'chrome-headless-shell'),
    );
    expect(await findChromeInPlaywrightRoot(root)).toBe(shell);
  });

  test('picks the newest revision when several are installed', async () => {
    await stubBinary(join(root, 'chromium-1100', 'chrome-linux-arm64', 'chrome'));
    const newer = await stubBinary(join(root, 'chromium-1243', 'chrome-linux-arm64', 'chrome'));
    expect(await findChromeInPlaywrightRoot(root)).toBe(newer);
  });

  test('a missing root is a normal miss, not an error', async () => {
    expect(await findChromeInPlaywrightRoot(join(root, 'never-created'))).toBeNull();
  });

  test('a non-executable file is not a candidate', async () => {
    const path = join(root, 'chromium-1243', 'chrome-linux-arm64', 'chrome');
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'not a binary');
    await chmod(path, 0o644);
    expect(await findChromeInPlaywrightRoot(root)).toBeNull();
  });
});

describe('findChromeBinary', () => {
  test('an explicit $CHROME_BIN wins over any search', async () => {
    const explicit = await stubBinary(join(root, 'my-browser'));
    process.env.CHROME_BIN = explicit;
    expect(await findChromeBinary()).toBe(explicit);
  });

  // A stale CHROME_BIN pointing at a browser that has since been uninstalled
  // must not turn into "no browser here" when one is a PATH lookup away.
  test('a $CHROME_BIN that is not executable falls through to the search', async () => {
    process.env.CHROME_BIN = join(root, 'gone');
    const found = await findChromeBinary();
    if (found !== null) expect(found).not.toBe(join(root, 'gone'));
  });
});
