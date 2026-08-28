/**
 * LAZY_DOCKERFILE_LAZY is gone (Part 3 of the worktree-image flow).
 *
 * THE INCIDENT it existed to paper over: a daemon inherited
 * LAZY_DOCKERFILE_LAZY pointing at a deleted worktree and wedged every
 * supervisor launch. The variable was first scoped to `lazy upgrade` only
 * (fix-daemon-ignores-dockerfile-override), then replaced entirely by the
 * interactive worktree-image flows (per-task pin + upgrade adoption).
 *
 * INVARIANT: no production code may read or mention the variable as a live
 * control surface. Historical CHANGELOG / design-note mentions are fine;
 * `src/` and live docs must not resurrect it.
 */
import { describe, test, expect } from 'bun:test';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..', '..');

async function collectTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules / build artifacts if they ever appear under src.
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...await collectTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('LAZY_DOCKERFILE_LAZY is deleted', () => {
  // INVARIANT: production code must not resurrect the env var or its latch.
  test('no production source reads or exports the deleted latch / env var', async () => {
    const srcFiles = await collectTsFiles(join(REPO_ROOT, 'src'));
    for (const file of srcFiles) {
      const source = await readFile(file, 'utf-8');
      expect(source).not.toContain('LAZY_DOCKERFILE_LAZY');
      expect(source).not.toContain('enableDockerfileEnvOverride');
      expect(source).not.toContain('resetDockerfileEnvOverride');
      expect(source).not.toContain('dockerfileEnvOverride');
      expect(source).not.toContain('checkDockerfileEnvOverride');
    }

    // The preload mock aliases the whole chokepoint — it must not keep the
    // deleted API either, or mocked upgrade e2e would quietly diverge.
    const mock = await readFile(join(REPO_ROOT, 'test/mocks/claude.ts'), 'utf-8');
    expect(mock).not.toContain('LAZY_DOCKERFILE_LAZY');
    expect(mock).not.toContain('enableDockerfileEnvOverride');
    expect(mock).not.toContain('dockerfileEnvOverride');
  });

  test('the upgrade-build latch is the only remaining process-wide image seam', async () => {
    const chokepoint = await readFile(join(REPO_ROOT, 'src/capture/claude.ts'), 'utf-8');
    expect(chokepoint).toContain('enableUpgradeImageBuild');
    expect(chokepoint).toContain('upgradeImageBuildEnabled');
    // Soft-pin when latch is off; path resolve when on.
    expect(chokepoint).toContain('if (!upgradeImageBuildEnabled)');
    expect(chokepoint).toContain('if (upgradeImageBuildEnabled)');

    const upgrade = await readFile(join(REPO_ROOT, 'src/cli/commands/upgrade.ts'), 'utf-8');
    expect(upgrade).toContain('enableUpgradeImageBuild()');
    // Only upgrade opts in — daemon / supervise never call it.
    for (const rel of [
      'src/daemon/server.ts',
      'src/daemon/auto-start.ts',
      'src/supervisor/index.ts',
      'src/utils/reconcile.ts',
    ]) {
      const source = await readFile(join(REPO_ROOT, rel), 'utf-8').catch(() => null);
      if (source === null) continue;
      expect(source).not.toContain('enableUpgradeImageBuild(');
    }
  });
});
