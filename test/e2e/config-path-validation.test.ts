/**
 * E2E tests for lazy.toml path validation.
 *
 * Sits alongside the filesystem preflight (preflight.test.ts) but covers a
 * different failure mode: a configured path in lazy.toml that points at a
 * stale or wrong location. Without this validation, the user gets an opaque
 * ENOENT or EACCES deep in storage/runner code; with it, they get an
 * actionable error naming the config key, the value, and the fix.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { writeFile, mkdir, chmod } from 'fs/promises';
import { userInfo } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';

async function setConfig(root: string, body: string): Promise<void> {
  await writeFile(join(root, 'lazy.toml'), body);
}

describe('config path validation', () => {
  let ctx: TestContext;
  const restoreDirs: string[] = [];

  /**
   * Run a command with the config-path validator ACTIVE.
   *
   * src/index.ts gates the validator (and the filesystem preflight) on
   * `LAZY_TEST !== '1'`, and a daemonless suite's ctx.lazy sets LAZY_TEST=1 —
   * so every test here was running with the very check it asserts on switched
   * off, and saw the raw ENOENT/EEXIST/EACCES the validator exists to replace.
   * Clearing the var restores the real startup path. Nothing leaks: validation
   * exits before the daemon auto-start, and cleanup() stops an auto-started
   * daemon anyway.
   */
  async function runWithValidation() {
    return ctx.lazy(['list'], { env: { LAZY_TEST: '' } });
  }

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    for (const d of restoreDirs) {
      try {
        await chmod(d, 0o755);
      } catch {
        // already gone — fine
      }
    }
    restoreDirs.length = 0;
    await ctx.cleanup();
  });

  // INVARIANT: a misconfigured path in lazy.toml fails with an error that
  // names the config key and path value, not an opaque ENOENT/EACCES.
  test('missing storage.external_path fails with named key and value', async () => {
    // Must live under the (fresh, auto-removed) test root. A hardcoded
    // /tmp/<fixed-name> is self-poisoning: the first run that reaches storage
    // creates the directory, and every later run then finds it existing and
    // sees no validation error.
    const stalePath = join(ctx.root, 'lazy-nonexistent-path');
    await setConfig(ctx.root, `
[storage]
backend = "external"
external_path = "${stalePath}"
`);

    const result = await runWithValidation();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('storage.external_path');
    expect(result.stderr).toContain(stalePath);
    expect(result.stderr).toContain('does not exist');
    expect(result.stderr).toContain('lazy.toml');
  });

  // INVARIANT: a misconfigured path in lazy.toml fails with an error that
  // names the config key and path value, not an opaque ENOENT/EACCES.
  test('missing docker.dockerfile (file kind) fails with named key', async () => {
    await setConfig(ctx.root, `
[docker]
dockerfile = "./missing.Dockerfile"
`);

    const result = await runWithValidation();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('docker.dockerfile');
    expect(result.stderr).toContain('./missing.Dockerfile');
    expect(result.stderr).toContain('does not exist');
  });

  // A file masquerading as a directory is just as broken as a missing one —
  // surface the type mismatch instead of letting readdir(file) fail later.
  test('directory key pointing at a file fails with type mismatch', async () => {
    const filePath = join(ctx.root, 'not-a-dir');
    await writeFile(filePath, '');
    await setConfig(ctx.root, `
[storage]
backend = "external"
external_path = "${filePath}"
`);

    const result = await runWithValidation();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('storage.external_path');
    expect(result.stderr).toContain('not a directory');
  });

  // Unwritable but readable dir still fails for keys lazy needs to write to.
  test('unwritable external_path dir fails citing write access', async () => {
    const readOnly = join(ctx.root, 'readonly-store');
    await mkdir(readOnly);
    await chmod(readOnly, 0o555);
    restoreDirs.push(readOnly);
    await setConfig(ctx.root, `
[storage]
backend = "external"
external_path = "${readOnly}"
`);

    const result = await runWithValidation();

    // Process running as root bypasses unix DAC, so the W_OK access() call
    // succeeds and the validator reports nothing. Skip that environment.
    if (userInfo().uid === 0) return;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('storage.external_path');
    expect(result.stderr).toContain('not writable');
  });

  // INVARIANT: stale-user-home heuristic triggers only when the path's user
  // component differs from the current user.
  test('path under another user\'s home prints the moved-machines hint', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return;
    const otherUser = userInfo().username === 'definitely-not-this' ? 'someone-else' : 'definitely-not-this';
    const prefix = process.platform === 'darwin' ? '/Users/' : '/home/';
    const stalePath = `${prefix}${otherUser}/lazy-store-that-does-not-exist`;
    await setConfig(ctx.root, `
[storage]
backend = "external"
external_path = "${stalePath}"
`);

    const result = await runWithValidation();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(stalePath);
    expect(result.stderr).toContain(otherUser);
    expect(result.stderr).toContain(userInfo().username);
  });

  // INVARIANT: stale-user-home heuristic triggers only when the path's user
  // component differs from the current user. Same-user paths must NOT carry
  // the misleading "did your home dir move?" hint.
  test('missing path under the current user\'s home does NOT print the moved-machines hint', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return;
    const me = userInfo().username;
    const prefix = process.platform === 'darwin' ? '/Users/' : '/home/';
    const stalePath = `${prefix}${me}/lazy-store-that-does-not-exist-uniqueAAA`;
    await setConfig(ctx.root, `
[storage]
backend = "external"
external_path = "${stalePath}"
`);

    const result = await runWithValidation();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('storage.external_path');
    expect(result.stderr).not.toContain('did your home');
    expect(result.stderr).not.toMatch(/copied this config from another machine/i);
  });

  // Sanity: with no path keys set in lazy.toml, the validator is silent and
  // commands run normally.
  test('happy path: no configured paths produces no validation error', async () => {
    // setupTestLazy already wrote a default lazy.toml. Don't overwrite.
    const result = await runWithValidation();
    expect(result.stderr).not.toContain('points at a path that cannot be used');
    expect(result.stderr).not.toContain('storage.external_path');
  });
});
