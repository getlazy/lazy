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
      // `credential: 'none'` is the default: a fallback forwards NO credential
      // unless the config opts it in, so a reroute cannot leak the user's
      // Anthropic token to an unrelated upstream.
      { upstream: 'http://host.docker.internal:11434', model: 'qwen3.5:35b', credential: 'none' },
      { upstream: 'https://api.anthropic.com', credential: 'none' },
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

  // INVARIANT: the REMOVED `[proxy] enabled` key is never silently ignored — a
  // user who wrote it believes it is doing something. `false` asks for something
  // lazy no longer does, so it is REJECTED with a message naming the option and
  // saying the proxy is always on.
  test('[proxy] enabled = false is rejected with an actionable message', async () => {
    await writeFile(join(dir, 'lazy.toml'), `[proxy]\nenabled = false\n`);
    await expect(loadConfig(dir, { cwd: dir })).rejects.toThrow(/`enabled` option has been removed/);
    await expect(loadConfig(dir, { cwd: dir })).rejects.toThrow(/always on/);
  });

  // INVARIANT: `enabled = true` asks for exactly what lazy already does, so the
  // line is merely dead — WARN and continue rather than refusing to start. A
  // config whose only sin is a stale line must not take the command down.
  test('[proxy] enabled = true warns about the removed option and still loads', async () => {
    await writeFile(join(dir, 'lazy.toml'), `[proxy]\nenabled = true\n`);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const config = await loadConfig(dir, { cwd: dir });
      expect(config.proxy).not.toBeNull();
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => /`enabled` option has been removed/.test(w))).toBe(true);
    expect(warnings.some((w) => /always on/.test(w))).toBe(true);
  });

  // INVARIANT: cursor traffic rides the SAME proxy as Anthropic traffic, so its
  // upstream resolves with no configuration at all. There is no opt-out key here
  // for the same reason `[proxy] enabled` was removed — a config that quietly
  // sent cursor traffic direct would leave the user believing it was audited.
  test('cursor_upstream defaults to Cursor even with no [proxy] section', async () => {
    await writeFile(join(dir, 'lazy.toml'), `[models.roles.agent]\nbackend = "proxy"\nmodel = "claude-sonnet-4-6"\n`);
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.proxy?.cursorUpstream).toBe('https://api2.cursor.sh');
  });

  test('an explicit cursor_upstream is honored, with the trailing slash normalized away', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[proxy]\ncursor_upstream = "http://127.0.0.1:9911/"\n`,
    );
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.proxy?.cursorUpstream).toBe('http://127.0.0.1:9911');
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
