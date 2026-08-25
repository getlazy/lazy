import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

/**
 * INVARIANT: the `lazy-agent` placeholder contract is self-healing.
 *
 * src/capture/claude.ts embeds `../../lazy-agent` via `import ... with { type:
 * 'file' }`, so a `lazy-agent` file must exist at the project root for ANY bun
 * build/run of src/ to resolve — including `scripts/release.sh`'s sanity build,
 * which runs `bun build ./src/index.ts` directly in the project root.
 *
 * That file is gitignored. `package.json`'s `prepare` hook creates it via the
 * `ensure:agent-placeholder` script, but `install:local` used to `mv` it away
 * to ~/.lazy/bin with nothing recreating it — leaving a freshly-installed dev
 * checkout unbuildable ("Could not resolve: ../../lazy-agent") until the next
 * `bun install`. release.sh's archive-typecheck step already guarded its own
 * copy of the placeholder (a different directory) but the sanity build had no
 * equivalent guard, which is exactly how `scripts/release.sh` died on its
 * first step. These tests pin both guards so neither regresses silently.
 */

const ROOT = join(import.meta.dir, '..', '..');

async function readRepoFile(rel: string): Promise<string> {
  return readFile(join(ROOT, rel), 'utf-8');
}

describe('lazy-agent placeholder self-healing', () => {
  test('release.sh recreates the root placeholder before the sanity build', async () => {
    const script = await readRepoFile('scripts/release.sh');

    const sanityBuildIndex = script.indexOf('bun build ./src/index.ts --outdir /tmp/lazy-build-check');
    expect(sanityBuildIndex).toBeGreaterThan(-1);

    // The guard must exist and must run BEFORE the build that needs it.
    const guardIndex = script.indexOf('bun run ensure:agent-placeholder');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(sanityBuildIndex);
  });

  test('release.sh archive typecheck reuses the same ensure:agent-placeholder script, not a hand-rolled copy', async () => {
    const script = await readRepoFile('scripts/release.sh');

    // A second open-coded `echo placeholder > lazy-agent` would be a second
    // copy of the same contract — assert it now runs the shared npm script
    // instead, in the assembled archive's own directory.
    expect(script).not.toContain('echo placeholder >');
    expect(script).toMatch(/cd "\$TYPECHECK_DIR" && bun run ensure:agent-placeholder/);
  });

  test('install:local re-runs ensure:agent-placeholder after moving the binary out', async () => {
    const pkg = JSON.parse(await readRepoFile('package.json'));
    const installLocal: string = pkg.scripts['install:local'];

    // The mv to ~/.lazy/bin/lazy-agent must happen, and ensure:agent-placeholder
    // must run afterward so the repo root is left buildable.
    const mvIndex = installLocal.indexOf('mv lazy-agent');
    const guardIndex = installLocal.indexOf('bun run ensure:agent-placeholder');
    expect(mvIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(mvIndex);
  });

  test('ensure:agent-placeholder script exists and only creates the file when absent', async () => {
    const pkg = JSON.parse(await readRepoFile('package.json'));
    expect(pkg.scripts['ensure:agent-placeholder']).toBe('test -f lazy-agent || echo placeholder > lazy-agent');
  });
});
