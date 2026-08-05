/**
 * Unit tests for parsing and validating the [proxy] section — in particular the
 * smart-routing failover chain (`[[proxy.fallback]]`) and retry_after_threshold.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader';

describe('proxy config: failover chain', () => {
  let dir: string;
  const prevConfig = process.env.LAZY_CONFIG;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-proxy-config-'));
    delete process.env.LAZY_CONFIG;
  });

  afterEach(async () => {
    if (prevConfig !== undefined) process.env.LAZY_CONFIG = prevConfig;
    else delete process.env.LAZY_CONFIG;
    await rm(dir, { recursive: true, force: true });
  });

  // INVARIANT: failover is opt-in. A [proxy] section with no [[proxy.fallback]]
  // entries resolves to an EMPTY chain — the proxy fails hard, never invents a
  // fallback. This encodes the no-silent-fallback rule at the config layer.
  test('no [[proxy.fallback]] → empty chain, default threshold', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[proxy]\nport = 8766\n`,
    );
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.proxy).not.toBeNull();
    expect(config.proxy?.fallbacks).toEqual([]);
    expect(config.proxy?.retryAfterThreshold).toBe(5);
  });

  test('parses an ordered fallback chain with optional model overrides', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[proxy]
port = 8766
retry_after_threshold = 2

[[proxy.fallback]]
upstream = "http://host.docker.internal:11434/"
model = "qwen3.5:35b"

[[proxy.fallback]]
upstream = "https://api.anthropic.com"
`,
    );
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.proxy?.retryAfterThreshold).toBe(2);
    expect(config.proxy?.fallbacks).toEqual([
      // Trailing slash is normalized away so path joins stay clean.
      { upstream: 'http://host.docker.internal:11434', model: 'qwen3.5:35b' },
      { upstream: 'https://api.anthropic.com' },
    ]);
  });

  // INVARIANT: a malformed fallback is a config bug the user must see — never a
  // silently-dropped target that would degrade failover coverage without notice.
  test('a fallback entry missing "upstream" fails config load with an actionable error', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[proxy]
port = 8766

[[proxy.fallback]]
model = "qwen3.5:35b"
`,
    );
    await expect(loadConfig(dir, { cwd: dir })).rejects.toThrow(/proxy\.fallback.*upstream/is);
  });

  test('a negative retry_after_threshold fails config load', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[proxy]\nport = 8766\nretry_after_threshold = -1\n`,
    );
    await expect(loadConfig(dir, { cwd: dir })).rejects.toThrow(/retry_after_threshold/i);
  });

  // INVARIANT: port is OPTIONAL — omitting it resolves to 0, meaning the daemon
  // lets the OS assign a free port at bind time (avoids per-project conflicts).
  test('a [proxy] section with no port resolves to port 0 (OS-assigned)', async () => {
    await writeFile(join(dir, 'lazy.toml'), `[proxy]\nupstream = "https://api.anthropic.com"\n`);
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.proxy).not.toBeNull();
    expect(config.proxy?.port).toBe(0);
  });

  // The engineer's existing static-port config must keep working unchanged.
  test('an explicit port is preserved as an override', async () => {
    await writeFile(join(dir, 'lazy.toml'), `[proxy]\nport = 8766\n`);
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.proxy?.port).toBe(8766);
  });

  test('an out-of-range explicit port fails config load', async () => {
    await writeFile(join(dir, 'lazy.toml'), `[proxy]\nport = 70000\n`);
    await expect(loadConfig(dir, { cwd: dir })).rejects.toThrow(/port.*1.*65535/is);
  });

  // INVARIANT: a proxy role may omit `endpoint` — the daemon injects its live
  // proxy URL at launch — but ONLY when a [proxy] section exists to inject from.
  test('a proxy role with no endpoint is allowed when [proxy] is configured', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[proxy]\n\n[models.roles.agent]\nbackend = "proxy"\nmodel = "claude-sonnet-4-6"\n`,
    );
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.models.roles.agent.backend).toBe('proxy');
    expect(config.models.roles.agent.endpoint).toBe('');
  });

  // Default-on inverts this: with no [proxy] section the proxy now EXISTS, so an
  // endpoint-less proxy role is fine — the daemon injects the live address.
  test('a proxy role with no endpoint and no [proxy] section is fine (proxy is default-on)', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[models.roles.agent]\nbackend = "proxy"\nmodel = "claude-sonnet-4-6"\n`,
    );
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.proxy).not.toBeNull();
    expect(config.models.roles.agent.endpoint).toBe('');
  });

  // INVARIANT: the one remaining hard failure — routing a role at a proxy that is
  // switched off. Fail at load rather than silently launching with an empty
  // ANTHROPIC_BASE_URL (which would quietly bypass the audit/policy plane).
  test('a proxy role with no endpoint AND [proxy] enabled = false fails config load', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[proxy]\nenabled = false\n\n[models.roles.agent]\nbackend = "proxy"\nmodel = "claude-sonnet-4-6"\n`,
    );
    await expect(loadConfig(dir, { cwd: dir })).rejects.toThrow(/proxy is disabled|enabled = false/i);
  });

  test('a proxy role with an explicit endpoint still works with no [proxy] section', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[models.roles.agent]\nbackend = "proxy"\nmodel = "claude-sonnet-4-6"\nendpoint = "http://127.0.0.1:9999"\n`,
    );
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.models.roles.agent.endpoint).toBe('http://127.0.0.1:9999');
  });
});
