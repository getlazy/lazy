/**
 * Unit tests for the daemon running-code SHA — the staleness signal.
 *
 * A long-lived daemon serves whatever code it started with; it does not
 * hot-reload. getRunningCodeSha() captures the SHA of the source the process is
 * running, so `lazy daemon status` can detect a daemon serving code older than
 * the working tree and tell the operator to restart.
 */

import { describe, test, expect } from 'bun:test';
import { getRunningCodeSha, resetRunningCodeShaCache } from '../../src/daemon/code-version';
import { spawnSync } from '../../src/utils/spawn';

describe('getRunningCodeSha', () => {
  // INVARIANT: in a git checkout (dev / test), the helper returns the current
  // short HEAD SHA — the value the daemon reports and the CLI compares against.
  test('returns the git short HEAD in a source checkout', () => {
    resetRunningCodeShaCache();
    const sha = getRunningCodeSha();

    const expected = spawnSync(['git', 'rev-parse', '--short', 'HEAD'], {
      cwd: import.meta.dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(sha).toBe(expected.stdout.toString().trim());
  });

  // INVARIANT: the result is cached — a live process cannot change the code it
  // executes, so repeated lookups are stable (and cheap: no per-call subprocess).
  test('is cached across calls', () => {
    resetRunningCodeShaCache();
    const a = getRunningCodeSha();
    const b = getRunningCodeSha();
    expect(a).toBe(b);
  });
});
