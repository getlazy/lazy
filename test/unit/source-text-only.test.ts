/**
 * Every tracked source file is TEXT, and carries no invisible character that
 * source syntax depends on.
 *
 * ## Why this is worth a test
 *
 * A single NUL byte makes git classify a file as BINARY, and from that moment
 * the file is effectively unreviewable: `git diff` says only "Binary files …
 * differ" on every surface (`lazy diff`, the web review page, a PR), ripgrep
 * skips it so no content search ever finds what it defines, `git blame` is
 * unavailable, and the review-regions partition cannot attribute its lines.
 * Nothing fails — the code compiles and the tests pass — so it ships, and the
 * reviewer's only signal is a diffstat that reads `Bin 0 -> 9552 bytes` among
 * dozens of ordinary line counts.
 *
 * It has happened twice: once in add-review-regions, and once in
 * move-file-approval-to-accept, where the file in question was the new
 * protected-file gate — the single module that change most needed read.
 *
 * The zero-width half is the same family. A zero-width space inserted so a glob
 * like the one this project protects would not close the block comment it sits
 * in is load-bearing punctuation nobody can see: delete it and the file stops
 * compiling, for a reason invisible in any editor. Spell the glob so it does not
 * need one.
 *
 * Deliberately a byte-level scan of what git TRACKS, not of the working tree:
 * build output, node_modules and any untracked scratch are not the repo's
 * problem, and legitimately-binary tracked assets are listed below rather than
 * guessed at by extension.
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * Tracked paths that are genuinely binary. Extensions, not paths, so adding
 * another screenshot needs no edit here — but a NEW extension is a deliberate
 * decision someone has to make in this file.
 */
const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tgz', '.wasm', '.node',
];

/** Invisible characters that must never be load-bearing for syntax. */
const ZERO_WIDTH = /[\u200b-\u200f\u2060\ufeff]/;

function trackedFiles(): string[] {
  const result = spawnSyncUnsupervised(['git', 'ls-files', '-z'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr?.toString() ?? ''}`);
  }
  return (result.stdout?.toString() ?? '').split('\0').filter(Boolean);
}

/** The files this guard covers: tracked, source-ish, not a known binary asset. */
function textFiles(): string[] {
  return trackedFiles().filter((path) => {
    if (BINARY_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))) return false;
    // Scoped to the trees a reviewer reads. Vendored assets bring their own
    // conventions and are not this project's to police.
    return /^(src|test|docs|public-docs|scripts)\//.test(path) || /^[^/]+\.(ts|md|json|toml)$/.test(path);
  });
}

describe('tracked source is text', () => {
  // The scan must prove it scanned something: a rename of any convention above
  // would otherwise turn this test green by finding nothing.
  test('the scan covers the source tree', () => {
    const files = textFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('src/protection/outstanding-resolver.ts');
    expect(files).toContain('CLAUDE.md');
  });

  // INVARIANT: no NUL byte in a tracked source file. One makes git call the file
  // binary, and a binary file cannot be reviewed, searched or blamed.
  test('no source file contains a NUL byte', async () => {
    const offenders: string[] = [];
    for (const path of textFiles()) {
      const bytes = await readFile(join(REPO_ROOT, path));
      const at = bytes.indexOf(0);
      if (at !== -1) offenders.push(`${path} (offset ${at})`);
    }

    expect(offenders).toEqual([]);
  });

  // INVARIANT: no zero-width character in a tracked source file. The one use
  // anybody has had for these is hiding a `*` `/` sequence inside a block
  // comment, which makes an invisible character load-bearing for whether the
  // file parses.
  test('no source file contains a zero-width character', async () => {
    const offenders: string[] = [];
    for (const path of textFiles()) {
      const text = await readFile(join(REPO_ROOT, path), 'utf-8');
      if (!ZERO_WIDTH.test(text)) continue;
      const line = text.split('\n').findIndex((l) => ZERO_WIDTH.test(l)) + 1;
      offenders.push(`${path}:${line}`);
    }

    expect(offenders).toEqual([]);
  });
});
