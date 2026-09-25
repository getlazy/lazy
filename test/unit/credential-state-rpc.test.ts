/**
 * `handleGetCredentialState` — the daemon's answer to `lazy doctor`'s
 * credential check.
 *
 * INVARIANTS:
 *  - PER CREDENTIAL, over every configured profile: one entry per credential
 *    the profiles bill, each naming the profiles that need it, with presence
 *    and a non-secret handle for where it was found.
 *  - ONE BAD READ DEGRADES ONE ENTRY. An unreadable credential index lands as
 *    `error` on the entries it could not answer (verbatim, so the line doctor
 *    prints says what to fix); the entries answered from the environment are
 *    unaffected, and the RPC still resolves. Throwing would turn one corrupt
 *    file into "doctor cannot say anything about credentials".
 *  - NO SECRET, EVER. `via` is an env var NAME, a backend id or a file path;
 *    no field carries a credential value or anything derived from one.
 *  - The legacy Anthropic-only fields (`present`, `source`, `anthropicRequired`)
 *    keep answering, for a client older than `providers`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { handleGetCredentialState } from '../../src/daemon/rpc-handlers';
import { getCredentialIndexPath } from '../../src/daemon/paths';
import { setCredential } from '../../src/credentials/store';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

const ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
  'LAZY_CREDENTIAL_WORK_OPENAI', 'LAZY_CONFIG',
] as const;

const OPENROUTER_CODEX =
  '[agents.openrouter-codex]\nharness = "codex"\nmodel = "gpt-5-codex"\nendpoint = "https://openrouter.ai/api/v1"\n';

describe('handleGetCredentialState', () => {
  let projectRoot: string;
  let daemonBase: string;
  let unpinDaemonBase: () => void;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  /** Write the project's lazy.toml and point loadConfig at it. */
  async function writeConfig(toml: string): Promise<void> {
    const configPath = join(projectRoot, 'lazy.toml');
    await writeFile(configPath, toml);
    process.env.LAZY_CONFIG = configPath;
  }

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'lazy-cred-state-'));
    daemonBase = await makeDaemonBaseDir();
    unpinDaemonBase = pinDaemonBaseDir(daemonBase);
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.ANTHROPIC_API_KEY = 'sk-ant-daemon-secret-value-0001';
    await writeConfig('');
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    unpinDaemonBase();
    await removeDaemonBaseDir(daemonBase);
    await rm(projectRoot, { recursive: true, force: true });
  });

  test('a plain project: one anthropic entry from the daemon env, legacy fields intact', async () => {
    const state = await handleGetCredentialState(projectRoot, {});
    expect(state.providers).toEqual([
      { name: 'anthropic', label: 'Anthropic', requiredBy: ['claude-code'], present: true, source: 'env', via: 'ANTHROPIC_API_KEY', kind: null },
    ]);
    expect(state.present).toBe(true);
    expect(state.source).toBe('ANTHROPIC_API_KEY');
    expect(state.anthropicRequired).toBe(true);
  });

  test('a declared profile gets its own entry, absent when the daemon holds nothing for it', async () => {
    await writeConfig(OPENROUTER_CODEX);
    const state = await handleGetCredentialState(projectRoot, {});
    expect(state.providers).toEqual([
      { name: 'anthropic', label: 'Anthropic', requiredBy: ['claude-code'], present: true, source: 'env', via: 'ANTHROPIC_API_KEY', kind: null },
      { name: 'openrouter', label: 'OpenRouter', requiredBy: ['openrouter-codex'], present: false, source: null, via: null, kind: null },
    ]);
    // The gate's scope is the role defaults, and it is still answered as such.
    expect(state.anthropicRequired).toBe(true);
  });

  test('a stored credential is reported from the store, naming the backend', async () => {
    await writeConfig(OPENROUTER_CODEX);
    await setCredential(projectRoot, { provider: 'openrouter', kind: 'api-key', secret: 'sk-or-stored-secret-value' }, 'file');
    const state = await handleGetCredentialState(projectRoot, {});
    expect(state.providers?.find((p) => p.name === 'openrouter')).toEqual({
      name: 'openrouter', label: 'OpenRouter', requiredBy: ['openrouter-codex'], present: true, source: 'store', via: 'file', kind: 'api-key',
    });
  });

  test('a broken credential index degrades only the entries it could not answer', async () => {
    await writeConfig(OPENROUTER_CODEX);
    const indexPath = getCredentialIndexPath(projectRoot);
    await mkdir(dirname(indexPath), { recursive: true });
    await writeFile(indexPath, '{ this is not json');

    const state = await handleGetCredentialState(projectRoot, {});

    // Anthropic came from the environment, which is consulted before the store.
    expect(state.providers?.[0]).toMatchObject({ name: 'anthropic', present: true, source: 'env', via: 'ANTHROPIC_API_KEY', kind: null });
    expect(state.providers?.[0]?.error).toBeUndefined();
    // OpenRouter needed the store, and the store could not answer — verbatim.
    const openrouter = state.providers?.[1];
    expect(openrouter).toMatchObject({ name: 'openrouter', present: false, source: null, via: null, kind: null });
    expect(openrouter?.error).toContain('Failed to parse the credential index');
    expect(openrouter?.error).toContain(indexPath);
  });

  test('an all-local project reports no credentials and no Anthropic requirement', async () => {
    await writeConfig(
      '[agents.claude-code]\nharness = "claude-code"\nmodel = "qwen3.8:latest"\nendpoint = "http://localhost:11434"\n',
    );
    const state = await handleGetCredentialState(projectRoot, {});
    expect(state.providers).toEqual([]);
    expect(state.anthropicRequired).toBe(false);
  });

  // SECURITY INVARIANT: this RPC describes credentials and never moves one.
  test('no field carries a secret or anything derived from one', async () => {
    await writeConfig(
      OPENROUTER_CODEX +
      '[agents.work-codex]\nharness = "codex"\nmodel = "gpt-5-codex"\ncredential = "work-openai"\n',
    );
    process.env.LAZY_CREDENTIAL_WORK_OPENAI = 'sk-work-secret-value-0002';
    await setCredential(projectRoot, { provider: 'openrouter', kind: 'api-key', secret: 'sk-or-stored-secret-value-0003' }, 'file');

    const wire = JSON.stringify(await handleGetCredentialState(projectRoot, {}));

    for (const secret of ['sk-ant-daemon-secret-value-0001', 'sk-work-secret-value-0002', 'sk-or-stored-secret-value-0003']) {
      expect(wire).not.toContain(secret);
      // Not even the last-four hint the store index keeps for `lazy auth list`.
      expect(wire).not.toContain(secret.slice(-4));
    }
    expect(wire).toContain('LAZY_CREDENTIAL_WORK_OPENAI');
    expect(wire).toContain('"via":"file"');
  });
});
