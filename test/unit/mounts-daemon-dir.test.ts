/**
 * INVARIANT: a [[mounts]] entry may never expose the daemon state dir.
 *
 * `~/.lazy/daemon/<slug>/` holds the shared daemon bearer token (which
 * authenticates every `/rpc/*` call) and `mcp-tokens.json`, the registry that
 * binds each per-task MCP token to its identity. An agent that could read it
 * would not need to impersonate anyone over `/mcp` — it could call
 * `/rpc/acceptTask` with the shared token, or lift another task's token out of
 * the registry. test/unit/daemon-dir-never-mounted.test.ts asserts lazy's own
 * launch paths never mount it; user-authored `[[mounts]]` entries flow into the
 * same container argv and were the one remaining way in, so they are refused
 * (src/capture/mounts.ts).
 *
 * The forbidden path is derived from src/daemon/paths.ts, never hardcoded, so
 * it follows LAZY_DAEMON_BASE_DIR and any future relocation.
 *
 * Lives in its own file rather than in mounts.test.ts because this project
 * protects existing test files from modification — the general [[mounts]]
 * behavior tests there are untouched.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { buildMountArgs, validateMounts } from '../../src/capture/mounts';
import { getDaemonDir, getMcpConfigDir, getMcpTokensPath, getTokenPath } from '../../src/daemon/paths';
import type { MountConfigEntry } from '../../src/config/types';

/** Same fixture paths mounts.test.ts uses — nothing here touches the filesystem. */
const PATHS = {
  worktreePath: '/lazy/worktrees/my-task',
  repoRoot: '/lazy/repo',
};

describe('[[mounts]] may not expose the daemon state dir', () => {
  const FAKE_BASE_DIR = '/lazy/daemon-state';
  let previousBaseDir: string | undefined;

  beforeEach(() => {
    previousBaseDir = process.env.LAZY_DAEMON_BASE_DIR;
    process.env.LAZY_DAEMON_BASE_DIR = FAKE_BASE_DIR;
  });

  afterEach(() => {
    if (previousBaseDir === undefined) delete process.env.LAZY_DAEMON_BASE_DIR;
    else process.env.LAZY_DAEMON_BASE_DIR = previousBaseDir;
  });

  /** This project's daemon dir, derived exactly as production derives it. */
  const daemonDir = () => getDaemonDir(PATHS.repoRoot);

  test('the daemon dir itself is refused, at load time and at launch', () => {
    const mounts: MountConfigEntry[] = [{ source: daemonDir(), target: '/work/daemon' }];

    expect(() => validateMounts(mounts)).toThrow(/inside lazy's daemon state directory/);
    expect(() => buildMountArgs(mounts, PATHS)).toThrow(/inside lazy's daemon state directory/);
  });

  // The error must name the offending mount AND say why, or the user has no way
  // to tell a security refusal from a typo.
  test('the refusal names the entry, the source, and the reason', () => {
    const mounts: MountConfigEntry[] = [
      { source: '/host/ok', target: '/work/ok' },
      { source: daemonDir(), target: '/work/daemon' },
    ];

    expect(() => validateMounts(mounts)).toThrow(/entry #2/);
    expect(() => validateMounts(mounts)).toThrow(new RegExp(daemonDir()));
    expect(() => validateMounts(mounts)).toThrow(/shared daemon token/);
    expect(() => validateMounts(mounts)).toThrow(/bypass per-task identity/);
  });

  test('a path nested inside the daemon dir is refused', () => {
    const nested = [
      getMcpConfigDir(PATHS.repoRoot),
      getTokenPath(PATHS.repoRoot),
      getMcpTokensPath(PATHS.repoRoot),
    ];
    for (const source of nested) {
      expect(() => validateMounts([{ source, target: '/work/x' }]))
        .toThrow(/inside lazy's daemon state directory/);
    }
  });

  // Another project's daemon dir is someone else's shared token — no better.
  // The boundary is therefore the base dir, not just this project's slug dir.
  test("another project's daemon dir, and the base dir itself, are refused", () => {
    expect(() => validateMounts([{ source: getDaemonDir('/some/other/project'), target: '/work/x' }]))
      .toThrow(/inside lazy's daemon state directory/);
    expect(() => validateMounts([{ source: FAKE_BASE_DIR, target: '/work/x' }]))
      .toThrow(/inside lazy's daemon state directory/);
  });

  // A mount of an ancestor exposes the daemon dir just as completely as a mount
  // of the dir itself — `~/.lazy` (or $HOME) would hand the container the same
  // token. Caught with its own message so the user knows what the problem is.
  test('a mount that CONTAINS the daemon dir is refused', () => {
    expect(() => validateMounts([{ source: '/lazy', target: '/work/lazy' }]))
      .toThrow(/CONTAINS lazy's daemon state directory/);
  });

  // The whole point is that ordinary mounts keep working — this check must not
  // become a reason to stop using [[mounts]].
  test('a legitimate mount elsewhere still passes', () => {
    const mounts: MountConfigEntry[] = [
      { source: '/host/cache', target: '/work/cache' },
      { source: '/lazy/repo/vendor', target: '/work/vendor', readonly: true },
      { type: 'volume', target: '{worktree}/node_modules' },
    ];

    expect(() => validateMounts(mounts)).not.toThrow();
    expect(buildMountArgs(mounts, PATHS)).toEqual([
      '-v', '/host/cache:/work/cache',
      '-v', '/lazy/repo/vendor:/work/vendor:ro',
      '-v', '/lazy/worktrees/my-task/node_modules',
    ]);
  });

  // Load-time validation sees the source as written; a relative or placeholder
  // source only becomes a host path at launch. buildMountArgs checks the
  // RESOLVED path so neither spelling is a way around the refusal.
  test('a relative or placeholder source that resolves into the daemon dir is refused at launch', () => {
    // '/lazy/repo' + '../daemon-state/x' → '/lazy/daemon-state/x'
    expect(() => buildMountArgs([{ source: '../daemon-state/x', target: '/work/x' }], PATHS))
      .toThrow(/inside lazy's daemon state directory/);
    expect(() => buildMountArgs([{ source: '{repo}/../daemon-state', target: '/work/x' }], PATHS))
      .toThrow(/inside lazy's daemon state directory/);
  });

  // The ONE permitted daemon-dir mount belongs to lazy, not to the user: the
  // launch paths add the container's own MCP config (a single :ro file) directly
  // — it never passes through [[mounts]], so this check cannot reject it, and a
  // user asking for the same file by hand is still refused.
  test("lazy's own MCP config mount is untouched, and cannot be requested by hand", () => {
    const ownConfig = join(getMcpConfigDir(PATHS.repoRoot), 'daemon-mcp-lazy-abc12345.json');

    // Not routed through [[mounts]] — the mount builder never sees it at all.
    expect(buildMountArgs([], PATHS)).toEqual([]);

    expect(() => validateMounts([{ source: ownConfig, target: ownConfig, readonly: true }]))
      .toThrow(/inside lazy's daemon state directory/);
  });
});
