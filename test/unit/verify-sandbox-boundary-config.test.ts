/**
 * Config plumbing for `[runner] verify_sandbox_boundary`.
 *
 * The key decides whether a host launch verifies the FILE-TOOL deny boundary
 * before running an agent. Its default is load-bearing in both directions: "off"
 * must not silently bill anyone for three headless Claude sessions, and an
 * operator who opts in must actually get a launch refusal on a violation.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, DEFAULT_CONFIG } from '../../src/config/loader';
import { findUnknownConfigKeys } from '../../src/config/schema';
import { VALID_SANDBOX_BOUNDARY_VERIFICATIONS } from '../../src/config/types';

async function writeLazyToml(root: string, body: string): Promise<void> {
  await mkdir(join(root, '.lazy'), { recursive: true });
  await writeFile(join(root, 'lazy.toml'), body, 'utf-8');
}

describe('[runner] verify_sandbox_boundary', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-vsbcfg-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // INVARIANT: off by default. The guard costs three real headless Claude
  // sessions and needs an interactively logged-in `claude` — a cost no user
  // should pay without asking for it. CI is the standing signal instead.
  test('defaults to "off"', () => {
    expect(DEFAULT_CONFIG.runner.verify_sandbox_boundary).toBe('off');
  });

  test('is read from lazy.toml', async () => {
    await writeLazyToml(root, '[runner]\nverify_sandbox_boundary = "once-per-version"\n');
    const config = await loadConfig(root);
    expect(config.runner.verify_sandbox_boundary).toBe('once-per-version');
  });

  test('a typo is rejected loudly, not silently ignored', async () => {
    await writeLazyToml(root, '[runner]\nverify_sandbox_boundary = "always"\n');
    // Silently falling back to "off" would turn a request for verification into
    // no verification at all — the exact false sense of safety the guard exists
    // to prevent.
    await expect(loadConfig(root)).rejects.toThrow(/verify_sandbox_boundary/);
  });

  test('doctor does not report it as an unknown key', () => {
    expect(findUnknownConfigKeys({ runner: { verify_sandbox_boundary: 'off' } })).toEqual([]);
  });

  test('only the two documented values are valid', () => {
    expect([...VALID_SANDBOX_BOUNDARY_VERIFICATIONS]).toEqual(['off', 'once-per-version']);
  });

  test('the lazy.toml template documents the key', async () => {
    // The template is how most users discover a knob exists at all.
    const { readFile } = await import('fs/promises');
    const loader = await readFile(join(import.meta.dir, '../../src/config/loader.ts'), 'utf-8');
    expect(loader).toContain('# verify_sandbox_boundary = "off"');
  });
});
