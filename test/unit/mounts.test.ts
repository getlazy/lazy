import { describe, test, expect } from 'bun:test';
import { buildMountArgs, validateMounts, validateMount } from '../../src/capture/mounts';
import type { MountConfigEntry } from '../../src/config/types';

const PATHS = {
  worktreePath: '/lazy/worktrees/my-task',
  repoRoot: '/lazy/repo',
};

describe('buildMountArgs', () => {
  // INVARIANT: No [[mounts]] configured → no extra `-v` args. Default behavior
  // must be completely unchanged when the user has not opted in.
  test('empty config produces no args', () => {
    expect(buildMountArgs([], PATHS)).toEqual([]);
  });

  test('bind mount: source:target', () => {
    const mounts: MountConfigEntry[] = [{ source: '/host/cache', target: '/work/cache' }];
    expect(buildMountArgs(mounts, PATHS)).toEqual(['-v', '/host/cache:/work/cache']);
  });

  test('readonly bind mount appends :ro', () => {
    const mounts: MountConfigEntry[] = [
      { source: '/host/data', target: '/work/data', readonly: true },
    ];
    expect(buildMountArgs(mounts, PATHS)).toEqual(['-v', '/host/data:/work/data:ro']);
  });

  test('project-relative bind source resolves against repoRoot', () => {
    const mounts: MountConfigEntry[] = [{ source: 'cache', target: '/work/cache' }];
    expect(buildMountArgs(mounts, PATHS)).toEqual(['-v', '/lazy/repo/cache:/work/cache']);
  });

  test('anonymous volume: just the target', () => {
    const mounts: MountConfigEntry[] = [
      { type: 'volume', target: '{worktree}/node_modules' },
    ];
    expect(buildMountArgs(mounts, PATHS)).toEqual([
      '-v',
      '/lazy/worktrees/my-task/node_modules',
    ]);
  });

  test('named volume: name:target', () => {
    const mounts: MountConfigEntry[] = [
      { type: 'volume', name: 'myproj-node-modules', target: '{worktree}/node_modules' },
    ];
    expect(buildMountArgs(mounts, PATHS)).toEqual([
      '-v',
      'myproj-node-modules:/lazy/worktrees/my-task/node_modules',
    ]);
  });

  test('readonly named volume appends :ro', () => {
    const mounts: MountConfigEntry[] = [
      { type: 'volume', name: 'cache-vol', target: '/work/cache', readonly: true },
    ];
    expect(buildMountArgs(mounts, PATHS)).toEqual(['-v', 'cache-vol:/work/cache:ro']);
  });

  test('expands {worktree} and {repo} placeholders in source and target', () => {
    const mounts: MountConfigEntry[] = [
      { source: '{repo}/shared', target: '{worktree}/shared' },
    ];
    expect(buildMountArgs(mounts, PATHS)).toEqual([
      '-v',
      '/lazy/repo/shared:/lazy/worktrees/my-task/shared',
    ]);
  });

  test('multiple entries produce one -v pair each, in order', () => {
    const mounts: MountConfigEntry[] = [
      { source: '/host/a', target: '/work/a' },
      { type: 'volume', target: '{worktree}/node_modules' },
      { type: 'volume', name: 'named', target: '/work/c' },
    ];
    expect(buildMountArgs(mounts, PATHS)).toEqual([
      '-v', '/host/a:/work/a',
      '-v', '/lazy/worktrees/my-task/node_modules',
      '-v', 'named:/work/c',
    ]);
  });
});

describe('validateMounts', () => {
  test('valid entries pass', () => {
    expect(() => validateMounts([
      { source: '/host/a', target: '/work/a' },
      { type: 'volume', target: '{worktree}/node_modules' },
      { type: 'volume', name: 'n', target: '/work/c', readonly: true },
    ])).not.toThrow();
  });

  test('missing target fails loudly, naming the entry', () => {
    expect(() => validateMount({ source: '/host/a' } as MountConfigEntry, 0))
      .toThrow(/entry #1.*missing required "target"/);
  });

  test('unknown type fails loudly', () => {
    expect(() => validateMount({ type: 'tmpfs', target: '/work/a' } as unknown as MountConfigEntry, 1))
      .toThrow(/entry #2.*unknown type "tmpfs"/);
  });

  test('bind without source fails loudly', () => {
    expect(() => validateMount({ target: '/work/a' }, 0))
      .toThrow(/bind mount requires "source"/);
  });

  test('volume with source fails loudly', () => {
    expect(() => validateMount({ type: 'volume', source: '/host/a', target: '/work/a' }, 0))
      .toThrow(/volume mount must not set "source"/);
  });

  test('bind with name fails loudly', () => {
    expect(() => validateMount({ source: '/host/a', name: 'n', target: '/work/a' }, 0))
      .toThrow(/"name" is only valid for type = "volume"/);
  });

  test('relative target without placeholder fails loudly', () => {
    expect(() => validateMount({ source: '/host/a', target: 'relative/path' }, 0))
      .toThrow(/must be an absolute container path/);
  });
});
