/**
 * Config plumbing for `[runner] verify_sandbox_boundary`.
 *
 * A RETIRED key: the host file-tool boundary self-check it selected was removed
 * (2026-10-13). Like the other legacy host-process keys it is still accepted
 * and validated so an existing lazy.toml keeps loading; it has no runtime
 * effect.
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

  // INVARIANT: a retained legacy key keeps its old default, so a config that
  // never set it reads the same as before the self-check was retired.
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
    // Legacy keys are still validated (public-docs/lazy-toml.md): a bad value
    // is a config error to fix, never silently accepted.
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
