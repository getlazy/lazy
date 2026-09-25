/**
 * Scripts that are meant to be run are tracked as executable — in GIT, not
 * merely on this machine's disk.
 *
 * INVARIANT: every file under `lazy-teams/bin/`, the daemon image's two guest
 * scripts, and every shell script under `scripts/` is committed with mode
 * 100755. A tool that rewrites a file by write-to-temp-and-rename drops the
 * mode, git records 100644, and the next person to run the script gets
 * `zsh: permission denied` — which is exactly how `bin/smolvm-hardware-probe`
 * shipped on 2026-09-20. The mode is read from the index (`git ls-files -s`),
 * because the committed state is what the next checkout gets; a chmod that was
 * never staged would pass a filesystem check and fail the operator anyway.
 *
 * Scope is deliberately "things run directly": the `#!/usr/bin/env bun`
 * scripts under `scripts/*.ts` are invoked as `bun run scripts/x.ts` and are
 * not covered, nor are libraries that are sourced rather than executed.
 */

import { describe, test, expect } from 'bun:test';
import { resolve } from 'node:path';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';

const repoRoot = resolve(import.meta.dir, '..', '..');

const MUST_BE_EXECUTABLE = [
  'lazy-teams/bin',
  'lazy-teams/deploy/daemon-image/lazy-guest-init',
  'lazy-teams/deploy/daemon-image/lazy-wrapper',
  // `:(glob)` keeps `*` to one directory level: scripts/verify-host-sandbox-linux/lib.sh
  // is sourced, not run, and must not be pulled in by a recursive match.
  ':(glob)scripts/*.sh',
  ':(glob)scripts/smolvm-probes/*.sh',
];

/** `path → mode` for every tracked file matching the patterns, from the index. */
function trackedModes(): Map<string, string> {
  const result = spawnSyncUnsupervised(['git', 'ls-files', '-s', '--', ...MUST_BE_EXECUTABLE], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  });
  expect(result.exitCode).toBe(0);
  const modes = new Map<string, string>();
  for (const line of result.stdout.toString().split('\n')) {
    // "100755 <sha> <stage>\t<path>"
    const m = line.match(/^(\d{6}) \S+ \d\t(.+)$/);
    if (m) modes.set(m[2]!, m[1]!);
  }
  return modes;
}

describe('scripts meant to be run are executable in git', () => {
  test('the scan finds the scripts it is meant to guard', () => {
    const modes = trackedModes();
    expect(modes.has('lazy-teams/bin/smolvm-hardware-probe')).toBe(true);
    expect(modes.has('lazy-teams/bin/vendor-smolvm')).toBe(true);
    expect(modes.has('lazy-teams/deploy/daemon-image/lazy-guest-init')).toBe(true);
    expect(modes.has('scripts/publish-lazy-daemon-image.sh')).toBe(true);
    expect(modes.has('scripts/smolvm-probes/run.sh')).toBe(true);
  });

  test('every one of them is tracked as 100755', () => {
    const wrong = [...trackedModes()]
      .filter(([, mode]) => mode !== '100755')
      .map(([path, mode]) => `${path} is ${mode} — chmod 0755 it and commit the mode change`);
    expect(wrong).toEqual([]);
  });
});
