import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleGetAuthEnv } from '../../src/daemon/rpc-handlers';
import {
  resolveAuthEnvFromDaemon,
  resolveLiveProxyUrl,
  withLiveProxyTarget,
  ProxyUnavailableError,
} from '../../src/daemon/auth-env';
import { assertDaemonCredentials, credentialFromEnv } from '../../src/daemon/credential-gate';
import type { RoleTarget } from '../../src/config/types';

/**
 * These tests pin the daemon-centric auth design (see credential-gate.ts):
 * the daemon owns the credential, and client launch paths source it from the
 * daemon rather than from their own process.env. The bug being guarded against:
 * `lazy builder` read the CLIENT's env (which legitimately has no credential in
 * a daemon-only-env deployment) and failed with "Authentication required" even
 * though the daemon held a valid token.
 */
describe('daemon auth env', () => {
  let projectRoot: string;

  // Save/restore the auth + mode env vars so tests don't leak into each other.
  const SAVED = {
    oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    apiKey: process.env.ANTHROPIC_API_KEY,
    lazyTest: process.env.LAZY_TEST,
    lazyConfig: process.env.LAZY_CONFIG,
  };

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'lazy-auth-env-'));
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    // Point loadConfig at a hermetic, minimal config (ollama disabled) so these
    // tests don't pick up the repo's lazy.toml via cwd-walking.
    const configPath = join(projectRoot, 'lazy.toml');
    await writeFile(configPath, '');
    process.env.LAZY_CONFIG = configPath;
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    for (const [k, v] of [
      ['CLAUDE_CODE_OAUTH_TOKEN', SAVED.oauth],
      ['ANTHROPIC_API_KEY', SAVED.apiKey],
      ['LAZY_TEST', SAVED.lazyTest],
      ['LAZY_CONFIG', SAVED.lazyConfig],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('handleGetAuthEnv', () => {
    test('returns the daemon env OAuth token', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'daemon-oauth-token';
      const result = await handleGetAuthEnv(projectRoot, {});
      expect(result).toEqual({
        authEnvVars: [{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'daemon-oauth-token' }],
      });
    });

    test('falls back to ANTHROPIC_API_KEY when no OAuth token', async () => {
      process.env.ANTHROPIC_API_KEY = 'daemon-api-key';
      const result = await handleGetAuthEnv(projectRoot, {});
      expect(result).toEqual({
        authEnvVars: [{ key: 'ANTHROPIC_API_KEY', value: 'daemon-api-key' }],
      });
    });

    // INVARIANT: even though the credential gate makes a credential-less running
    // daemon practically unreachable, this RPC must still fail hard (never return
    // an empty credential) if the daemon env somehow lacks one.
    test('throws an actionable error when the daemon env has no credential', async () => {
      await expect(handleGetAuthEnv(projectRoot, {})).rejects.toThrow('Authentication required');
    });
  });

  describe('resolveAuthEnvFromDaemon', () => {
    // INVARIANT: Ollama-backed setups need no Anthropic token — the daemon is
    // never consulted, the dummy local credentials are returned directly.
    test('returns Ollama dummy credentials without consulting the daemon', async () => {
      // No CLAUDE/ANTHROPIC creds set; if this consulted real auth it would throw.
      const ollamaTarget: RoleTarget = {
        backend: 'ollama',
        model: 'qwen',
        endpoint: 'http://localhost:11434',
      };
      const result = await resolveAuthEnvFromDaemon(ollamaTarget);
      const keys = result.map(v => v.key);
      expect(keys).toContain('ANTHROPIC_BASE_URL');
      expect(keys).toContain('ANTHROPIC_AUTH_TOKEN');
      // Never throws "Authentication required" for Ollama.
    });

    // In test mode (LAZY_TEST=1) the daemon is bypassed (tryRpc returns null),
    // so the resolver falls back to the in-process credential — which is exactly
    // how the daemon process itself would resolve it.
    test('falls back to the local env when the daemon is bypassed (test mode)', async () => {
      process.env.LAZY_TEST = '1';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'local-token';
      const result = await resolveAuthEnvFromDaemon();
      expect(result).toEqual([{ key: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'local-token' }]);
    });

    // INVARIANT: the surface is carried all the way down to the env layer. The
    // daemon reports its addresses in the form the CONFIGURED RUNNER would use,
    // so a docker-runner project reports `host.docker.internal` — correct for a
    // container, a guaranteed ENOTFOUND for a host process. A caller launching
    // on the host says so and gets the host-reachable address.
    test('propagates the launch surface to the injected endpoint', async () => {
      const dockerInternal: RoleTarget = {
        backend: 'ollama',
        model: 'qwen',
        endpoint: 'http://host.docker.internal:11434',
      };
      const hostEnv = await resolveAuthEnvFromDaemon(dockerInternal, undefined, 'host');
      expect(hostEnv.find(v => v.key === 'ANTHROPIC_BASE_URL')?.value).toBe('http://localhost:11434');

      const containerEnv = await resolveAuthEnvFromDaemon(dockerInternal, undefined, 'container');
      expect(containerEnv.find(v => v.key === 'ANTHROPIC_BASE_URL')?.value)
        .toBe('http://host.docker.internal:11434');
    });
  });

  /**
   * INVARIANT (the audit plane must not silently degrade): with `[proxy]`
   * enabled — the DEFAULT — a launch that cannot resolve the live proxy address
   * FAILS. It must never fall through to a direct api.anthropic.com connection:
   * that traffic would be unaudited and unenforced while the trail recorded
   * nothing, and being silent it would rot unnoticed (daemon RPC blips are
   * real). `[proxy] enabled = false` is the only opt-out.
   *
   * The gate is armed off an EXPLICIT signal, never off "the RPC returned
   * null": under LAZY_TEST the harness deliberately runs without a daemon, so
   * treating null as failure would break every test. `LAZY_FORCE_PROXY_GATE=1`
   * (test-only) re-arms it, which is what these tests use.
   */
  describe('resolveLiveProxyUrl / withLiveProxyTarget (proxy fail-loud gate)', () => {
    const anthropicRole: RoleTarget = { backend: 'anthropic', model: '', endpoint: '' };

    beforeEach(() => {
      // Deterministic: tryRpc must not reach out to any real daemon from a unit test.
      process.env.LAZY_TEST = '1';
    });

    afterEach(() => {
      delete process.env.LAZY_FORCE_PROXY_GATE;
    });

    async function configWith(toml: string) {
      const configPath = join(projectRoot, 'lazy.toml');
      await writeFile(configPath, toml);
      process.env.LAZY_CONFIG = configPath;
      const { loadConfig } = await import('../../src/config/loader');
      return loadConfig(projectRoot, { cwd: projectRoot });
    }

    test('fails with an actionable error when the proxy is on and no address resolves', async () => {
      process.env.LAZY_FORCE_PROXY_GATE = '1';
      const config = await configWith('');       // no [proxy] section = proxy ON (default)
      await expect(resolveLiveProxyUrl(config)).rejects.toThrow(ProxyUnavailableError);
      await expect(resolveLiveProxyUrl(config)).rejects.toThrow('lazy daemon status');
      await expect(resolveLiveProxyUrl(config)).rejects.toThrow('enabled = false');
    });

    // The explicit opt-out — NOT a fallback. Direct connection stays exactly as-is.
    test('returns undefined and leaves targets alone when [proxy] enabled = false', async () => {
      process.env.LAZY_FORCE_PROXY_GATE = '1';
      const config = await configWith('[proxy]\nenabled = false\n');
      expect(await resolveLiveProxyUrl(config)).toBeUndefined();
      expect(await withLiveProxyTarget(anthropicRole, config)).toEqual(anthropicRole);
    });

    // The test harness (and the daemon talking to itself) must keep working
    // without a daemon — that is why the gate keys off an explicit signal.
    test('does not fire under the explicit daemon-RPC bypass (LAZY_TEST)', async () => {
      const config = await configWith('');
      expect(await resolveLiveProxyUrl(config)).toBeUndefined();
      expect(await withLiveProxyTarget(anthropicRole, config)).toEqual(anthropicRole);
    });

    // ollama roles are never proxied (the proxy has one Anthropic-native
    // upstream), so an unreachable proxy must not block a local-model launch.
    test('does not fire for an ollama role', async () => {
      process.env.LAZY_FORCE_PROXY_GATE = '1';
      const config = await configWith('');
      const ollama: RoleTarget = { backend: 'ollama', model: 'qwen', endpoint: 'http://localhost:11434' };
      expect(await withLiveProxyTarget(ollama, config)).toEqual(ollama);
    });

    // An explicitly-pointed role needs nothing from the daemon.
    test('does not fire for a proxy role with an explicit endpoint', async () => {
      process.env.LAZY_FORCE_PROXY_GATE = '1';
      const config = await configWith('');
      const explicit: RoleTarget = { backend: 'proxy', model: 'm', endpoint: 'http://127.0.0.1:9999' };
      expect(await withLiveProxyTarget(explicit, config)).toEqual(explicit);
    });
  });

  describe('assertDaemonCredentials (the single enforcement point)', () => {
    test('passes when the daemon env holds an OAuth token', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'daemon-oauth-token';
      await expect(assertDaemonCredentials(projectRoot)).resolves.toBeUndefined();
    });

    // INVARIANT: the gate is the single enforcement point — a daemon started
    // without a credential must refuse with an actionable error, never silently.
    test('throws an actionable refusal when the daemon env has no credential', async () => {
      await expect(assertDaemonCredentials(projectRoot)).rejects.toThrow(
        'Daemon refuses to start',
      );
    });

    // INVARIANT: a set-but-blank credential counts as ABSENT. `export
    // CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token)` leaves exactly this behind
    // when the inner command fails, and a presence-only check let it through —
    // producing the failure this gate exists to prevent: a daemon that runs,
    // answers RPC, and hands every container a credential the API rejects.
    test('throws when the credential is set but blank', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = '   ';
      await expect(assertDaemonCredentials(projectRoot)).rejects.toThrow(
        'Daemon refuses to start',
      );
    });

    // A blank OAuth token must not mask a real API key — the gate looks for ANY
    // usable credential, not just the first one that happens to be set.
    test('passes when a blank OAuth token is accompanied by a real API key', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = '';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
      await expect(assertDaemonCredentials(projectRoot)).resolves.toBeUndefined();
    });

    // INVARIANT: Ollama-backed setups talk to a local model with dummy
    // credentials, so the gate must not demand an Anthropic token — mirroring
    // runner.checkAvailability().
    test('is skipped when [ollama] is enabled', async () => {
      await writeFile(
        join(projectRoot, 'lazy.toml'),
        '[ollama]\nenabled = true\nmodel = "qwen3:8b"\n',
      );
      await expect(assertDaemonCredentials(projectRoot)).resolves.toBeUndefined();
    });
  });

  describe('credentialFromEnv', () => {
    test('names the var holding the credential, OAuth first', () => {
      expect(credentialFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'a', ANTHROPIC_API_KEY: 'b' }))
        .toBe('CLAUDE_CODE_OAUTH_TOKEN');
      expect(credentialFromEnv({ ANTHROPIC_API_KEY: 'b' })).toBe('ANTHROPIC_API_KEY');
    });

    test('treats missing, empty, and whitespace-only values as absent', () => {
      expect(credentialFromEnv({})).toBeNull();
      expect(credentialFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: '' })).toBeNull();
      expect(credentialFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: '  \n\t ' })).toBeNull();
    });
  });
});
