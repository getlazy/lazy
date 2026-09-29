/**
 * Parsers behind the foreign-daemon scan. Covered here rather than only in the
 * Linux-only e2e so the macOS (`ps`) parsing is exercised from any platform.
 */
import { describe, test, expect } from 'bun:test';
import {
  daemonProjectFromArgv,
  parsePsListing,
  parsePsEnvironment,
  parseProcEnviron,
  baseDirFromEnv,
} from '../../src/daemon/foreign-daemon';

describe('foreign-daemon parsers', () => {
  // INVARIANT: only `daemon start … --project <root>` is a daemon for <root>;
  // other lazy commands naming --project are not.
  test('daemonProjectFromArgv', () => {
    expect(daemonProjectFromArgv(['bun', '/opt/lazy/src/index.ts', 'daemon', 'start', '--foreground', '--project', '/p/repo'])).toBe('/p/repo');
    expect(daemonProjectFromArgv(['lazy', 'daemon', 'status', '--project', '/p/repo'])).toBeNull();
    expect(daemonProjectFromArgv(['lazy', 'daemon', 'start', '--foreground'])).toBeNull();
  });

  test('parsePsListing', () => {
    const m = parsePsListing('  222 /usr/local/bin/bun index.ts daemon start --project /p\n 1 /sbin/launchd\n');
    expect(m.get(222)).toEqual(['/usr/local/bin/bun', 'index.ts', 'daemon', 'start', '--project', '/p']);
    expect(m.get(1)).toEqual(['/sbin/launchd']);
  });

  test('environment parsers and base dir resolution', () => {
    expect(baseDirFromEnv(parseProcEnviron('HOME=/root\0LAZY_DAEMON_BASE_DIR=/lazy/d\0'))).toBe('/lazy/d');
    expect(baseDirFromEnv(parseProcEnviron('HOME=/root\0'))).toBe('/root/.lazy/daemon');
    expect(baseDirFromEnv(parsePsEnvironment('bun x daemon start --project /p PATH=/bin HOME=/Users/a LAZY_DAEMON_BASE_DIR=/tmp/b'))).toBe('/tmp/b');
    expect(baseDirFromEnv(parsePsEnvironment('bun x daemon start HOME=/Users/a'))).toBe('/Users/a/.lazy/daemon');
    expect(baseDirFromEnv(parsePsEnvironment('bun x daemon start'))).toBeNull();
  });
});
