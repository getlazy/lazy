/**
 * Config plumbing for the wind-down guard.
 *
 * `[agent] graceful_exit_timeout_ms` was renamed to `wind_down_timeout_ms`
 * when end-of-turn stopped being inferred from `lazy_commit`. The old name
 * described a fuse armed by a commit; the new one describes a window that only
 * opens after the agent's final result. The rename had to happen because the
 * old meaning no longer exists — but an existing lazy.toml must not silently
 * lose its configured value, and `lazy doctor` must not start calling the old
 * key unknown.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, DEFAULT_CONFIG } from '../../src/config/loader';
import { findUnknownConfigKeys } from '../../src/config/schema';
import { commonCommandFields } from '../../src/protocol/io';

async function writeLazyToml(root: string, body: string): Promise<void> {
  await mkdir(join(root, '.lazy'), { recursive: true });
  await writeFile(join(root, 'lazy.toml'), body, 'utf-8');
}

describe('[agent] wind_down_timeout_ms', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-wdcfg-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('defaults to 60s', async () => {
    expect(DEFAULT_CONFIG.agent.wind_down_timeout_ms).toBe(60000);
  });

  test('is read from lazy.toml', async () => {
    await writeLazyToml(root, '[agent]\nwind_down_timeout_ms = 15000\n');
    const config = await loadConfig(root, { cwd: root });
    expect(config.agent.wind_down_timeout_ms).toBe(15000);
  });

  // An existing config must keep working across the rename.
  test('the pre-rename graceful_exit_timeout_ms still applies', async () => {
    await writeLazyToml(root, '[agent]\ngraceful_exit_timeout_ms = 12345\n');
    const config = await loadConfig(root, { cwd: root });
    expect(config.agent.wind_down_timeout_ms).toBe(12345);
  });

  test('the new name wins when both are present', async () => {
    await writeLazyToml(root, '[agent]\ngraceful_exit_timeout_ms = 12345\nwind_down_timeout_ms = 999\n');
    const config = await loadConfig(root, { cwd: root });
    expect(config.agent.wind_down_timeout_ms).toBe(999);
  });

  test('0 (wait indefinitely) survives the load — it is not treated as unset', async () => {
    await writeLazyToml(root, '[agent]\nwind_down_timeout_ms = 0\n');
    const config = await loadConfig(root, { cwd: root });
    expect(config.agent.wind_down_timeout_ms).toBe(0);
  });

  // doctor must not nag about a key we still honour.
  test('neither spelling is reported as an unknown key', () => {
    const warnings = findUnknownConfigKeys({
      agent: { wind_down_timeout_ms: 60000, graceful_exit_timeout_ms: 60000 },
    });
    expect(warnings).toEqual([]);
  });

  // INVARIANT: the supervisor must see an explicit 0 rather than falling back
  // to a default, so "wait indefinitely" is actually honoured over the wire.
  test('is sent to the supervisor even when 0 (explicit opt-out)', () => {
    const fields = commonCommandFields({
      ...DEFAULT_CONFIG,
      agent: { ...DEFAULT_CONFIG.agent, wind_down_timeout_ms: 0 },
    });
    expect(fields).toHaveProperty('wind_down_timeout_ms');
    expect(fields.wind_down_timeout_ms).toBe(0);
  });

  test('is sent to the supervisor with its configured value', () => {
    const fields = commonCommandFields({
      ...DEFAULT_CONFIG,
      agent: { ...DEFAULT_CONFIG.agent, wind_down_timeout_ms: 30000 },
    });
    expect(fields.wind_down_timeout_ms).toBe(30000);
  });
});
