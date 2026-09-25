import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, resolveConfigPath } from '../../src/config/loader';

/**
 * INVARIANT: a lazy.toml inside a task worktree has no authority. The config
 * lazy runs on is ALWAYS the project root's, whatever the loading process's cwd
 * happens to be.
 *
 * loadConfig used to walk UP from cwd and take the nearest lazy.toml. A task
 * worktree lives at `<root>/.lazy/worktrees/<name>` — inside the root — so its
 * own copy shadowed the repository's, on a branch the agent can write. A turn
 * could therefore choose the config its NEXT turn ran under: blank
 * `[permissions] protected` so no violation is ever recorded, blank
 * `[checks] post_turn`, zero the watchdog, drop `[[maintain]]` groups, or pick
 * its own model and effort. Same governance rule as the container image ("Task
 * worktrees never auto-govern container images" in CLAUDE.md), generalised from
 * `[docker] run_args` to the whole file.
 *
 * This file guards the mechanism. The end-to-end proof that the SUPERVISOR
 * COMMAND carries the root's values is test/e2e/worktree-config-authority.test.ts.
 */
describe('lazy.toml is root-anchored', () => {
  let root: string;
  let worktree: string;
  let originalCwd: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-cfg-anchor-'));
    worktree = join(root, '.lazy', 'worktrees', 'some-task');
    await mkdir(worktree, { recursive: true });
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });

  test('a worktree lazy.toml is ignored even when the process runs from inside it', async () => {
    await writeFile(join(root, 'lazy.toml'), '[session]\nverbose = false\n', 'utf-8');
    await writeFile(join(worktree, 'lazy.toml'), '[session]\nverbose = true\n', 'utf-8');

    process.chdir(worktree);

    const config = await loadConfig(root);
    expect(config.session.verbose).toBe(false);
  });

  test('a worktree lazy.toml that would not even parse cannot break a load', async () => {
    // The operational half of the bug: a branch carrying a config shape the
    // daemon rejects made `unblock` AND `sync` throw — and sync is the command
    // that would have brought the fix in. The root's file is the only one read,
    // so the branch cannot wedge its own turns.
    await writeFile(join(root, 'lazy.toml'), '[session]\nverbose = false\n', 'utf-8');
    await writeFile(join(worktree, 'lazy.toml'), 'this is not = = valid toml [\n', 'utf-8');

    process.chdir(worktree);

    const config = await loadConfig(root);
    expect(config.session.verbose).toBe(false);
  });

  test('resolveConfigPath names the root copy, from any cwd', async () => {
    await writeFile(join(root, 'lazy.toml'), '[session]\n', 'utf-8');
    await writeFile(join(worktree, 'lazy.toml'), '[session]\n', 'utf-8');

    process.chdir(worktree);

    expect(resolveConfigPath(root)).toBe(join(root, 'lazy.toml'));
  });

  test('an ordinary subdirectory still resolves the root config — humans lose nothing', async () => {
    await writeFile(join(root, 'lazy.toml'), '[session]\nverbose = true\n', 'utf-8');
    const sub = join(root, 'src', 'deep');
    await mkdir(sub, { recursive: true });

    process.chdir(sub);

    expect((await loadConfig(root)).session.verbose).toBe(true);
  });
});
