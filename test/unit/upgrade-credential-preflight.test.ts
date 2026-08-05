/**
 * Unit tests: `lazy upgrade` credential preflight.
 *
 * Observed live on the first real upgrade to v0.20: the upgrade stopped every
 * container, rebuilt the image and binary, and only THEN did the daemon's
 * credential gate fire — leaving the project with no daemon, no builders, and a
 * wasted rebuild, over a condition that was knowable before anything was
 * touched. The preflight moves that decision to the front of the command.
 *
 * These tests drive the decision seam (`upgradeCredentialPreflight`) and the
 * non-throwing gate it is built on (`checkDaemonCredentials`) directly, since
 * the surrounding command stops containers and rebuilds images.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkDaemonCredentials, assertDaemonCredentials } from '../../src/daemon/credential-gate';
import { upgradeCredentialPreflight } from '../../src/cli/commands/upgrade';

describe('upgrade credential preflight', () => {
  let projectRoot: string;

  const SAVED = {
    oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    apiKey: process.env.ANTHROPIC_API_KEY,
    lazyTest: process.env.LAZY_TEST,
    forcePreflight: process.env.LAZY_FORCE_CRED_PREFLIGHT,
    lazyConfig: process.env.LAZY_CONFIG,
  };

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'lazy-upgrade-preflight-'));
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LAZY_TEST;
    delete process.env.LAZY_FORCE_CRED_PREFLIGHT;
    // Hermetic, minimal config (ollama disabled) so loadConfig doesn't pick up
    // the repo's own lazy.toml by walking up from cwd.
    const configPath = join(projectRoot, 'lazy.toml');
    await writeFile(configPath, '');
    process.env.LAZY_CONFIG = configPath;
  });

  afterEach(async () => {
    for (const [key, value] of [
      ['CLAUDE_CODE_OAUTH_TOKEN', SAVED.oauth],
      ['ANTHROPIC_API_KEY', SAVED.apiKey],
      ['LAZY_TEST', SAVED.lazyTest],
      ['LAZY_FORCE_CRED_PREFLIGHT', SAVED.forcePreflight],
      ['LAZY_CONFIG', SAVED.lazyConfig],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(projectRoot, { recursive: true, force: true });
  });

  describe('checkDaemonCredentials (non-throwing form of the gate)', () => {
    test('returns null when an OAuth token is present', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
      expect(await checkDaemonCredentials(projectRoot)).toBeNull();
    });

    test('returns null when an API key is present', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      expect(await checkDaemonCredentials(projectRoot)).toBeNull();
    });

    test('returns the actionable refusal when no credential is present', async () => {
      const message = await checkDaemonCredentials(projectRoot);
      expect(message).toContain('Daemon refuses to start');
      expect(message).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(message).toContain('ANTHROPIC_API_KEY');
    });

    // INVARIANT: the throwing gate and the preflight must never disagree — they
    // are the same decision, so assert they share one implementation.
    test('assertDaemonCredentials throws exactly the message check returns', async () => {
      const message = await checkDaemonCredentials(projectRoot);
      await expect(assertDaemonCredentials(projectRoot)).rejects.toThrow(message as string);
    });
  });

  describe('upgradeCredentialPreflight', () => {
    test('returns null when the environment has a credential', async () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
      expect(await upgradeCredentialPreflight(projectRoot)).toBeNull();
    });

    // The headline fix: the message must make clear that NOTHING was touched,
    // and must carry the gate's own actionable remedy.
    test('aborts with a message that says nothing was changed, plus the remedy', async () => {
      const message = await upgradeCredentialPreflight(projectRoot);
      expect(message).not.toBeNull();
      expect(message).toContain('Upgrade aborted before any changes');
      expect(message).toContain('Nothing was stopped, rebuilt, or changed');
      // Same actionable text the daemon gate would have printed — after the
      // damage — so the human sees one consistent remedy.
      expect(message).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(message).toContain('claude setup-token');
    });

    // Test mode never starts a daemon (ensureDaemon bails on LAZY_TEST=1), so
    // there is no gate to preflight and e2e suites must not need a credential.
    test('is a no-op under LAZY_TEST', async () => {
      process.env.LAZY_TEST = '1';
      expect(await upgradeCredentialPreflight(projectRoot)).toBeNull();
    });

    // ...unless the test-only hatch asks for the real decision, which is how the
    // e2e suite exercises the abort.
    test('LAZY_FORCE_CRED_PREFLIGHT re-enables the real check under LAZY_TEST', async () => {
      process.env.LAZY_TEST = '1';
      process.env.LAZY_FORCE_CRED_PREFLIGHT = '1';
      expect(await upgradeCredentialPreflight(projectRoot)).toContain('Upgrade aborted');
    });

    // Ollama setups authenticate against a local model with dummy credentials —
    // requiring an Anthropic token there would block upgrades for no reason.
    test('passes for an ollama-backed project with no Anthropic credential', async () => {
      const configPath = join(projectRoot, 'lazy.toml');
      await writeFile(configPath, '[ollama]\nenabled = true\nmodel = "qwen"\n');
      process.env.LAZY_CONFIG = configPath;
      expect(await upgradeCredentialPreflight(projectRoot)).toBeNull();
    });
  });
});
