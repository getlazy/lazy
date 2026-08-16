import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, resetConfigOverrideWarning } from '../../src/config/loader';

/**
 * The "Using lazy.toml from <dir> (not the git root <root>)" warning.
 *
 * INVARIANT: the warning is about DIFFERING SETTINGS, not about location.
 * Task worktrees are a normal, constant part of using lazy and almost always
 * carry a byte-identical lazy.toml, so warning on location alone fires on
 * nearly every command run from a worktree and says nothing — it has already
 * cost real debugging time by being the loudest irrelevant line on screen
 * during an unrelated CLI wedge. Identical content must therefore stay silent.
 *
 * INVARIANT: every failure to compare still warns. A comparison that cannot be
 * made must not swallow a warning that might be real.
 */
describe('config override warning', () => {
  let root: string;
  let worktree: string;
  let warnings: string[];
  const originalWarn = console.warn;

  const ROOT_CONFIG = '[session]\nverbose = false\n';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-cfg-warn-'));
    worktree = join(root, 'worktrees', 'wt');
    await mkdir(worktree, { recursive: true });
    await writeFile(join(root, 'lazy.toml'), ROOT_CONFIG, 'utf-8');

    warnings = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    resetConfigOverrideWarning();
  });

  afterEach(async () => {
    console.warn = originalWarn;
    resetConfigOverrideWarning();
    // The unreadable-config case chmods the root config to 000; restore it so
    // the temp-dir removal cannot fail on it.
    await chmod(join(root, 'lazy.toml'), 0o644).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  function overrideWarnings(): string[] {
    return warnings.filter((w) => w.includes('not the git root'));
  }

  test('stays silent when the worktree config is byte-identical', async () => {
    await writeFile(join(worktree, 'lazy.toml'), ROOT_CONFIG, 'utf-8');

    await loadConfig(root, { cwd: worktree });

    expect(overrideWarnings()).toEqual([]);
  });

  test('still warns when the worktree config differs', async () => {
    await writeFile(join(worktree, 'lazy.toml'), '[session]\nverbose = true\n', 'utf-8');

    await loadConfig(root, { cwd: worktree });

    expect(overrideWarnings()).toHaveLength(1);
    expect(overrideWarnings()[0]).toContain(worktree);
    expect(overrideWarnings()[0]).toContain(root);
  });

  test('still warns when the git root config is unreadable', async () => {
    await writeFile(join(worktree, 'lazy.toml'), ROOT_CONFIG, 'utf-8');
    await chmod(join(root, 'lazy.toml'), 0o000);

    // Running as root defeats permission bits entirely — the comparison would
    // succeed and correctly stay silent, so the case cannot be exercised.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    await loadConfig(root, { cwd: worktree });

    expect(overrideWarnings()).toHaveLength(1);
  });

  test('warns at most once per process', async () => {
    await writeFile(join(worktree, 'lazy.toml'), '[session]\nverbose = true\n', 'utf-8');

    await loadConfig(root, { cwd: worktree });
    await loadConfig(root, { cwd: worktree });

    expect(overrideWarnings()).toHaveLength(1);
  });
});
