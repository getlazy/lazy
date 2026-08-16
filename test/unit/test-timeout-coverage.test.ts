import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..', '..');

/**
 * INVARIANT: the multi-file test scripts pass `--timeout`, and bunfig.toml never
 * pretends to configure one.
 *
 * Bun (1.3.x) offers three ways to set a suite-wide test timeout and only one of
 * them survives contact with a multi-file run:
 *
 *   - bunfig.toml `[test] timeout` — IGNORED. Bun's bunfig parser does not read
 *     the key at all, so it has never had any effect at any point. It reads like
 *     configuration, which is worse than absent: it is why nobody looked further.
 *   - `setDefaultTimeout()` in a preload (test/preload-generate.ts) — applies to
 *     exactly ONE test file per run. The preload is evaluated once and its value
 *     lands in whichever file's scope bun happens to be loading at that moment;
 *     every OTHER file falls back to bun's built-in 5000ms.
 *   - `--timeout` on the command line — actually works for every file, but only
 *     for invocations that pass it.
 *
 * The second point is why this rotted invisibly for so long: a single-file run IS
 * the one file the preload reaches, so every suite passed when run on its own
 * while aggregate sweeps produced hundreds of bare "timed out after 5000ms"
 * failures that looked like hangs and weren't — which made the whole suite look
 * far more rotten than it was.
 *
 * So the multi-file entry points must carry `--timeout` explicitly. A bare
 * `bun test test/e2e/` still does not (see CLAUDE.md); these tests pin the part
 * that can be enforced mechanically.
 */
describe('test timeout configuration', () => {
  test('every multi-file test script passes --timeout', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'));

    // Scripts that run MORE than one test file — exactly the case the preload's
    // setDefaultTimeout cannot cover.
    for (const name of ['test', 'test:e2e', 'test:all']) {
      const script: string = pkg.scripts[name];
      expect(script).toBeDefined();
      expect(script).toContain('--timeout');
    }
  });

  test('bunfig.toml does not claim to configure a timeout', async () => {
    // A `timeout = ...` line here is inert but authoritative-looking. Keeping it
    // out is the whole reason the 5s default went unnoticed for so long.
    const bunfig = await readFile(join(ROOT, 'bunfig.toml'), 'utf-8');
    const active = bunfig
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(active).not.toMatch(/^\s*timeout\s*=/m);
  });
});
