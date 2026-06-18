import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { handleGetAuthEnv } from '../../src/daemon/rpc-handlers';
import { resolveAuthEnvFromDaemon } from '../../src/daemon/auth-env';
import { assertDaemonCredentials } from '../../src/daemon/credential-gate';
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
  });
});
