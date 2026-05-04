/**
 * E2E tests for the filesystem preflight check.
 *
 * The preflight probes read/write access to directories lazy persists state
 * to. On macOS TCC, restrictive Unix perms, or read-only mounts, it must
 * fail fast with an actionable error instead of an opaque EACCES deep inside
 * storage code.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { chmod, mkdir } from 'fs/promises';
import { setupTestLazy, type TestContext } from '../helpers/setup';

describe('preflight', () => {
  let ctx: TestContext;
  // Dirs we chmod 000/555 during a test — need to restore perms before
  // cleanup, otherwise rm -rf can't traverse them.
  const restoreDirs: string[] = [];

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    for (const d of restoreDirs) {
      try {
        await chmod(d, 0o755);
      } catch {
        // Already gone or never created — fine.
      }
    }
    restoreDirs.length = 0;
    await ctx.cleanup();
  });

  // INVARIANT: When all probed paths are accessible, preflight is silent —
  // downstream errors (e.g. "daemon not running") must not be masked by
  // false-positive preflight output.
  // Also covers the missing-but-creatable `.lazy/` case: setupTestLazy runs
  // `lazy init` which itself goes through preflight before `.lazy/` is
  // created; if preflight treated a missing-but-creatable project dir as a
  // failure, setupTestLazy would never succeed.
  test('happy path: accessible dirs produce no preflight error', async () => {
    const result = await ctx.lazy(['list']);

    expect(result.stderr).not.toContain('On macOS');
    expect(result.stderr).not.toContain('EACCES');
    expect(result.stderr).not.toContain('EPERM');
  });

  // INVARIANT: When the project's .lazy/ dir exists but is unreadable,
  // preflight must surface the specific path, operation, and error code —
  // not let a downstream opaque error propagate.
  test('permission denied on project .lazy/ fails with actionable error', async () => {
    const lazyDir = join(ctx.root, '.lazy');
    await chmod(lazyDir, 0o000);
    restoreDirs.push(lazyDir);

    const result = await ctx.lazy(['list']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(lazyDir);
    expect(result.stderr).toMatch(/EACCES|EPERM/);
    expect(result.stderr).toMatch(/cannot (read|write)/);
  });

  // INVARIANT: When ~/.lazy cannot be created because an ancestor is not
  // writable, preflight must name the inaccessible ancestor — not a phantom
  // child path that doesn't exist yet.
  test('unwritable HOME fails with actionable error naming the parent', async () => {
    const fakeHome = join(ctx.root, 'fake-home');
    await mkdir(fakeHome);
    await chmod(fakeHome, 0o555); // r-xr-xr-x: readable, not writable
    restoreDirs.push(fakeHome);

    const result = await ctx.lazy(['list'], { env: { HOME: fakeHome } });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(fakeHome);
    expect(result.stderr).toMatch(/EACCES|EPERM/);
    expect(result.stderr).toContain('cannot write');
  });

  // INVARIANT: On darwin, the error must name the terminal (from TERM_PROGRAM)
  // and point users at System Settings. Non-darwin platforms must not carry
  // the macOS-specific hint — that would be misleading noise.
  test('darwin-specific hint appears only on darwin', async () => {
    const lazyDir = join(ctx.root, '.lazy');
    await chmod(lazyDir, 0o000);
    restoreDirs.push(lazyDir);

    const result = await ctx.lazy(['list'], {
      env: { TERM_PROGRAM: 'Apple_Terminal' },
    });

    expect(result.exitCode).toBe(1);
    if (process.platform === 'darwin') {
      expect(result.stderr).toContain('Privacy & Security');
      expect(result.stderr).toContain('Terminal'); // mapped from Apple_Terminal
    } else {
      expect(result.stderr).not.toContain('Privacy & Security');
      expect(result.stderr).toContain('readable by the current user');
    }
  });
});
