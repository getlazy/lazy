/**
 * The config lines of `lazy daemon status`: which file the daemon runs on, a
 * hash of it and — for a control plane's file — the version it was applied from.
 */

import { describe, test, expect } from 'bun:test';
import { formatConfigStatus } from '../../src/cli/commands/daemon-reload';
import type { ConfigStatus } from '../../src/daemon/config-status';

const base: ConfigStatus = {
  path: '/fleet/p/project-config/lazy.toml', rule: 'managed',
  lastKnownGood: null, loadError: null, pending: [],
};

describe('lazy daemon status config lines', () => {
  // INVARIANT: the version is REPORTED for the bytes in force, and its absence
  // is said, never left for the reader to infer.
  test('a managed file shows its hash and applied version', () => {
    const out = formatConfigStatus({ ...base, sha256: 'abc123', appliedVersion: 4, appliedAt: '2026-10-06T10:00:00Z' }).join('\n');
    expect(out).toContain('/fleet/p/project-config/lazy.toml');
    expect(out).toContain('sha256 abc123');
    expect(out).toContain('configuration version 4 (applied 2026-10-06T10:00:00Z)');
  });

  test('a managed file with no record says so', () => {
    const out = formatConfigStatus({ ...base, sha256: 'abc123', appliedVersion: null, appliedAt: null }).join('\n');
    expect(out).toContain('no configuration version is recorded for these bytes');
  });

  test('a missing file says the defaults apply', () => {
    const out = formatConfigStatus({ ...base, rule: 'project-root', sha256: null }).join('\n');
    expect(out).toContain("not present — lazy's defaults apply");
    expect(out).not.toContain('configuration version');
  });

  test('a daemon too old to report the fields prints no hash or version lines', () => {
    const out = formatConfigStatus(base).join('\n');
    expect(out).not.toContain('sha256');
    expect(out).not.toContain('configuration version');
  });
});
