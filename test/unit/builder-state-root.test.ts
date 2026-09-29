import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { BUILDER_STATE_DIR_ENV, builderStateRoot, migrateBuilderStateRoot } from '../../src/builder/state-root';
import { resolveBuilderSessionHomeDir } from '../../src/builder/claude-home';
import { builderScratchDir } from '../../src/builder/scratch';
import { isBuilderStateDir } from '../../src/builder/state-root';
import { memberHomesDir } from '../../src/daemon/member-container';
import { enumerateDaemons } from '../../src/daemon/registry';

describe('builder state root', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const keys = ['LAZY_DAEMON_BASE_DIR', BUILDER_STATE_DIR_ENV, 'LAZY_BUILDER_HOMES_BASE_DIR', 'LAZY_SCRATCH_BASE_DIR'];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'builder-state-'));
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(async () => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await rm(dir, { recursive: true, force: true });
  });

  // INVARIANT: builder homes and scratch resolve from ONE root, which
  // LAZY_BUILDER_STATE_DIR relocates. Teams points it at a host-mounted disk so
  // destroying a machine never destroys members' .claude trees.
  test('LAZY_BUILDER_STATE_DIR moves homes and scratch together', () => {
    process.env[BUILDER_STATE_DIR_ENV] = dir;
    expect(builderStateRoot()).toBe(dir);
    expect(resolveBuilderSessionHomeDir('/p/repo', 'a@b.c').startsWith(join(dir, 'builder-homes') + '/')).toBe(true);
    expect(builderScratchDir('/p/repo').startsWith(join(dir, 'scratch') + '/')).toBe(true);
  });

  test('moves old content once when the new root is empty', async () => {
    const from = join(dir, 'old'), to = join(dir, 'new');
    await mkdir(join(from, 'builder-homes', 'proj', 'k', '.claude'), { recursive: true });
    await writeFile(join(from, 'builder-homes', 'proj', 'k', '.claude', 'settings.json'), '{"x":1}');
    const moved = await migrateBuilderStateRoot({ fromRoot: from, toRoot: to });
    expect(moved.map((m) => m.subdir)).toEqual(['builder-homes']);
    expect(await readFile(join(to, 'builder-homes', 'proj', 'k', '.claude', 'settings.json'), 'utf8')).toBe('{"x":1}');
    expect(await readdir(from)).toEqual([]);
    expect(await migrateBuilderStateRoot({ fromRoot: from, toRoot: to })).toEqual([]);
  });

  // INVARIANT: never merge two roots — when both have content, the old one is
  // left untouched and the new one wins.
  test('leaves old content alone when the new root already has content', async () => {
    const from = join(dir, 'old'), to = join(dir, 'new');
    await mkdir(join(from, 'scratch', 'a'), { recursive: true });
    await mkdir(join(to, 'scratch', 'b'), { recursive: true });
    expect(await migrateBuilderStateRoot({ fromRoot: from, toRoot: to })).toEqual([]);
    expect(await readdir(join(from, 'scratch'))).toEqual(['a']);
    expect(await readdir(join(to, 'scratch'))).toEqual(['b']);
  });

  test('no relocation configured → nothing moves', async () => {
    expect(await migrateBuilderStateRoot()).toEqual([]);
  });

  test('member homes move with the state root', () => {
    process.env[BUILDER_STATE_DIR_ENV] = dir;
    expect(memberHomesDir('/p/repo').startsWith(join(dir, 'member-homes') + '/')).toBe(true);
  });

  // INVARIANT: the builder state root is never listed (or pruned) as a daemon
  // dir. Under Teams it sits inside LAZY_DAEMON_BASE_DIR, and `lazy daemon
  // kill-stray --prune-dirs` rm -rf's every "orphaned" dir the registry lists.
  test('the daemon registry skips a builder state root inside the daemon base dir', async () => {
    const state = join(dir, 'builder-state');
    await mkdir(join(state, 'builder-homes'), { recursive: true });
    await mkdir(join(dir, 'repo-abc12345'), { recursive: true });
    process.env.LAZY_DAEMON_BASE_DIR = dir;
    process.env[BUILDER_STATE_DIR_ENV] = state;
    expect(isBuilderStateDir(state)).toBe(true);
    expect(isBuilderStateDir(join(dir, 'repo-abc12345'))).toBe(false);
    const slugs = (await enumerateDaemons()).map((r) => r.slug);
    expect(slugs).toEqual(['repo-abc12345']);
  });
});
