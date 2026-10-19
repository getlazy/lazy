import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  locateProfileCredential,
  resolveAgentApiKey,
  resolveProfileCredential,
  deleteLegacyAgentCredentials,
  agentSupportsApiKey,
  alternativeCredentialHint,
} from '../../src/agent/credentials';
import { setCredential } from '../../src/credentials/store';
import { getDaemonDir } from '../../src/daemon/paths';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

describe('agent credentials', () => {
  let root: string;
  let daemonBase: string;
  let unpinDaemonBase: () => void;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-agent-creds-'));
    daemonBase = await makeDaemonBaseDir();
    unpinDaemonBase = pinDaemonBaseDir(daemonBase);
    delete process.env.CURSOR_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.LAZY_CREDENTIAL_WORK_OPENAI;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    unpinDaemonBase();
    await removeDaemonBaseDir(daemonBase);
    await rm(root, { recursive: true, force: true });
  });

  const profile = { name: 'cursor', harness: 'cursor', credential: 'cursor' };

  test('capability map', () => {
    expect(agentSupportsApiKey('cursor')).toBe(true);
    expect(agentSupportsApiKey('codex')).toBe(true);
    expect(agentSupportsApiKey('claude-code')).toBe(false);
  });

  test('a key written to the store mid-process is picked up without restarting', async () => {
    expect(await resolveAgentApiKey(root, 'cursor')).toBeNull();
    await setCredential(root, { provider: 'cursor', kind: 'api-key', secret: 'stored-key' }, 'file');
    expect(await resolveAgentApiKey(root, 'cursor')).toEqual({ value: 'stored-key', source: 'store' });
    expect(await resolveProfileCredential(root, profile)).toEqual({ value: 'stored-key', source: 'store' });
    expect(await locateProfileCredential(root, 'cursor', ['cursor']))
      .toEqual({ present: true, source: 'store', via: 'file', kind: 'api-key' });
    process.env.CURSOR_API_KEY = 'env-key';
    expect(await resolveProfileCredential(root, profile)).toEqual({ value: 'env-key', source: 'env' });
    expect(await resolveAgentApiKey(root, 'cursor')).toEqual({ value: 'env-key', source: 'env' });
    expect(await locateProfileCredential(root, 'cursor', ['cursor']))
      .toEqual({ present: true, source: 'env', via: 'CURSOR_API_KEY', kind: null });
  });

  // INVARIANT: engineer-approved October 3 reversal: legacy keys are never read or migrated.
  test.each(['daemon', 'project'])('ignores valid and malformed legacy files in the %s directory', async location => {
    const directory = location === 'daemon' ? getDaemonDir(root) : join(root, '.lazy');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'agent-credentials.json');
    for (const contents of [JSON.stringify({ cursor: { api_key: 'legacy-secret' } }), '{broken json']) {
      await writeFile(path, contents);
      expect(await resolveAgentApiKey(root, 'cursor')).toBeNull();
      expect(await resolveProfileCredential(root, profile)).toBeNull();
      expect(await locateProfileCredential(root, 'cursor', ['cursor']))
        .toEqual({ present: false, source: null, via: null, kind: null });
      await access(path);
    }
  });

  test('startup cleanup deletes both obsolete files without parsing or migrating them', async () => {
    const paths = [getDaemonDir(root), join(root, '.lazy')].map(directory => join(directory, 'agent-credentials.json'));
    for (const path of paths) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, '{malformed secret');
    }
    await deleteLegacyAgentCredentials(root);
    for (const path of paths) await expect(access(path)).rejects.toThrow();
    await deleteLegacyAgentCredentials(root);
    expect(await resolveProfileCredential(root, profile)).toBeNull();
  });

  test('named credentials do not borrow harness keys', async () => {
    await setCredential(root, { provider: 'openai', kind: 'api-key', secret: 'harness-key' }, 'file');
    const named = { name: 'work-codex', harness: 'codex', credential: 'work-openai' };
    expect(await resolveProfileCredential(root, named)).toBeNull();
    await setCredential(root, { provider: 'work-openai', kind: 'api-key', secret: 'work-key' }, 'file');
    expect(await resolveProfileCredential(root, named)).toEqual({ value: 'work-key', source: 'store' });
    process.env.LAZY_CREDENTIAL_WORK_OPENAI = 'env-work';
    expect(await resolveProfileCredential(root, named)).toEqual({ value: 'env-work', source: 'env' });
    expect(await resolveProfileCredential(root, { ...named, credential: 'none' })).toBeNull();
    expect(await locateProfileCredential(root, 'none', ['codex'])).toEqual({ present: false, source: null, via: null, kind: null });
  });

  test('keyless codex offers the subscription alternative only when appropriate', () => {
    expect(alternativeCredentialHint('codex', 'openai')).toContain('codex-subscription');
    expect(alternativeCredentialHint('codex', 'chatgpt')).toBe('');
    expect(alternativeCredentialHint('cursor', 'cursor')).toBe('');
  });
});
