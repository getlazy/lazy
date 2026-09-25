/**
 * `[checks]` → `[automation]` migration.
 *
 * INVARIANT: the deprecated spelling is NEVER silently ignored. A project that
 * configured `[checks] post_turn` has exactly one per-turn gate; dropping it
 * because the key moved would remove that gate without a word.
 *
 * INVARIANT: when both spellings are set to DIFFERENT values, loading FAILS.
 * There is no defensible way to guess which one the author meant, and picking
 * one silently would run a command they did not ask for.
 *
 * INVARIANT: `[automation]` is the single source of truth on the resolved
 * config. `deepMerge` copies keys it does not recognize, so the deprecated
 * table would otherwise ride along as a stray second source.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadConfig,
  resetChecksDeprecationWarning,
  usesDeprecatedChecksSection,
} from '../../src/config/loader';

describe('[checks] deprecation', () => {
  let root: string;
  let warnings: string[];
  const originalWarn = console.warn;

  async function writeConfig(toml: string): Promise<void> {
    await writeFile(join(root, 'lazy.toml'), toml, 'utf-8');
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-checks-dep-'));
    warnings = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    resetChecksDeprecationWarning();
  });

  afterEach(async () => {
    console.warn = originalWarn;
    resetChecksDeprecationWarning();
    await rm(root, { recursive: true, force: true });
  });

  test('a [checks] value is honored as the [automation] value', async () => {
    await writeConfig('[checks]\npost_turn = "bun test --bail"\npost_turn_timeout = 42\n');
    const config = await loadConfig(root);
    expect(config.automation.post_turn).toBe('bun test --bail');
    expect(config.automation.post_turn_timeout).toBe(42);
  });

  test('the deprecated table does not survive onto the resolved config', async () => {
    await writeConfig('[checks]\npost_turn = "bun test"\n');
    const config = await loadConfig(root);
    expect((config as unknown as Record<string, unknown>).checks).toBeUndefined();
  });

  test('[automation] wins when [checks] does not set the key', async () => {
    await writeConfig('[automation]\npost_turn = "new"\n\n[checks]\npost_turn_timeout = 11\n');
    const config = await loadConfig(root);
    expect(config.automation.post_turn).toBe('new');
    expect(config.automation.post_turn_timeout).toBe(11);
  });

  test('identical values in both sections load fine', async () => {
    await writeConfig('[automation]\npost_turn = "same"\n\n[checks]\npost_turn = "same"\n');
    const config = await loadConfig(root);
    expect(config.automation.post_turn).toBe('same');
  });

  test('conflicting values in both sections are a hard error', async () => {
    await writeConfig('[automation]\npost_turn = "new"\n\n[checks]\npost_turn = "old"\n');
    let err: Error | null = null;
    try {
      await loadConfig(root);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('post_turn');
    expect(err!.message).toContain('[checks]');
    expect(err!.message).toContain('[automation]');
  });

  // Convention: ONE generic line at the point of occurrence, full remedy in
  // `lazy doctor`. Repeating it on every config load would drown the surface
  // it points at.
  test('warns once, generically, pointing at lazy doctor', async () => {
    await writeConfig('[checks]\npost_turn = "bun test"\n');
    await loadConfig(root);
    await loadConfig(root);
    const hits = warnings.filter(w => w.includes('[checks]'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('lazy doctor');
  });

  test('no warning when [checks] is absent', async () => {
    await writeConfig('[automation]\npost_turn = "bun test"\n');
    await loadConfig(root);
    expect(warnings.filter(w => w.includes('[checks]'))).toHaveLength(0);
  });

  test('usesDeprecatedChecksSection detects only real deprecated keys', () => {
    expect(usesDeprecatedChecksSection({})).toBe(false);
    expect(usesDeprecatedChecksSection({ checks: {} })).toBe(false);
    expect(usesDeprecatedChecksSection({ checks: { post_turn: 'x' } })).toBe(true);
    expect(usesDeprecatedChecksSection({ checks: { post_turn_timeout: 5 } })).toBe(true);
  });
});
