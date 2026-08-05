/**
 * Loader tests for the `[proxy.policy]` section (§6.3 layer 1).
 *
 * Verify the resolved mechanistic policy that the proxy server consumes, and
 * pin the decided default posture at the config layer.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/loader';

describe('[proxy.policy] resolution', () => {
  let dir: string;
  const prevConfig = process.env.LAZY_CONFIG;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lazy-proxypolicy-'));
    delete process.env.LAZY_CONFIG;
  });

  afterEach(async () => {
    if (prevConfig !== undefined) process.env.LAZY_CONFIG = prevConfig;
    else delete process.env.LAZY_CONFIG;
    await rm(dir, { recursive: true, force: true });
  });

  // INVARIANT: the proxy is ON BY DEFAULT — it is how lazy runs, like the daemon.
  // A project with NO [proxy] section still gets a fully-defaulted proxy (audit
  // + policy on). This is the load-bearing default-on posture; inverting it back
  // to opt-in needs human approval.
  test('no [proxy] section → proxy resolves with defaults (on by default)', async () => {
    await writeFile(join(dir, 'lazy.toml'), `[models]\ndefault = "claude-opus-4-8"\n`);
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.proxy).not.toBeNull();
    expect(config.proxy?.upstream).toBe('https://api.anthropic.com');
    expect(config.proxy?.port).toBe(0);            // OS-assigned
    expect(config.proxy?.bind).toBe('127.0.0.1');
    expect(config.proxy?.policy.enforce).toBe(true);
    expect(config.proxy?.policy.connectorAllowlist).toEqual([]); // deny-by-default
  });

  // INVARIANT: `enabled = false` is the ONLY way to get null — the documented
  // escape hatch back to direct connections (no server, no env injection).
  test('[proxy] enabled = false → proxy is null (direct connections)', async () => {
    await writeFile(join(dir, 'lazy.toml'), `[proxy]\nenabled = false\n`);
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.proxy).toBeNull();
  });

  test('[proxy] enabled = true is the same as omitting it', async () => {
    await writeFile(join(dir, 'lazy.toml'), `[proxy]\nenabled = true\n`);
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.proxy).not.toBeNull();
    expect(config.proxy?.upstream).toBe('https://api.anthropic.com');
  });

  // INVARIANT: when the proxy is enabled but no [proxy.policy] is given, the
  // DECIDED default posture is closed — enforcement on and inherited claude.ai
  // connectors deny-by-default (empty allowlist). See proxy-policy.test.ts for
  // why this must not be weakened without human approval.
  test('[proxy] with no policy → closed default posture (enforce on, connectors deny-by-default)', async () => {
    await writeFile(join(dir, 'lazy.toml'), `[proxy]\nport = 8766\n`);
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.proxy).not.toBeNull();
    expect(config.proxy!.policy).toEqual({
      enforce: true,
      connectorAllowlist: [],
      denySecretPathReads: true,
      denyPathGlobs: [],
      egressAllowlist: null,
    });
  });

  test('parses an explicit [proxy.policy]', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      [
        `[proxy]`,
        `port = 8766`,
        `[proxy.policy]`,
        `enforce = true`,
        `connector_allowlist = ["mcp__claude_ai_gmail_search_threads"]`,
        `deny_secret_path_reads = false`,
        `deny_path_globs = ["/etc/**"]`,
        `egress_allowlist = ["api.github.com"]`,
        ``,
      ].join('\n'),
    );
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.proxy!.policy).toEqual({
      enforce: true,
      connectorAllowlist: ['mcp__claude_ai_gmail_search_threads'],
      denySecretPathReads: false,
      denyPathGlobs: ['/etc/**'],
      egressAllowlist: ['api.github.com'],
    });
  });

  test('an empty egress_allowlist resolves to null (egress unrestricted, no footgun)', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[proxy]\nport = 8766\n[proxy.policy]\negress_allowlist = []\n`,
    );
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.proxy!.policy.egressAllowlist).toBeNull();
  });

  test('enforce = false disables enforcement (pure passthrough/audit)', async () => {
    await writeFile(
      join(dir, 'lazy.toml'),
      `[proxy]\nport = 8766\n[proxy.policy]\nenforce = false\n`,
    );
    const config = await loadConfig(dir, { cwd: dir });
    expect(config.proxy!.policy.enforce).toBe(false);
  });
});
