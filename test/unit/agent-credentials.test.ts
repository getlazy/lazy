/**
 * Per-project agent API keys (src/agent/credentials.ts).
 *
 * INVARIANT (cursor-first-class-agent §3): keys are resolved at LAUNCH time —
 * env var override first, then the per-project credentials file. A key written
 * while a daemon is running is picked up by the very next resolution in the
 * SAME process, which is exactly the no-restart property: launchTask re-resolves
 * per launch, so "set the key, run the task" works against a live daemon.
 *
 * SECURITY INVARIANT (fix-cursor-security-musts §1): that file lives in the
 * per-project DAEMON dir, never under the project root. Task containers mount
 * the repo read-only (`-v <repoRoot>:<repoRoot>:ro`), so an in-repo key is
 * readable by every agent of every task on the project — 0600 stops other host
 * users, not the container.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, stat, readFile, writeFile, mkdir, access } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveAgentApiKey,
  writeAgentApiKey,
  clearAgentApiKey,
  agentSupportsApiKey,
  credentialsPath,
} from '../../src/agent/credentials';
import { getDaemonDir } from '../../src/daemon/paths';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';

describe('agent credentials', () => {
  let root: string;
  let daemonBase: string;
  let unpinDaemonBase: () => void;
  const originalEnv = process.env.CURSOR_API_KEY;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-agent-creds-'));
    daemonBase = await makeDaemonBaseDir();
    unpinDaemonBase = pinDaemonBaseDir(daemonBase);
    delete process.env.CURSOR_API_KEY;
  });

  afterEach(async () => {
    if (originalEnv !== undefined) process.env.CURSOR_API_KEY = originalEnv;
    else delete process.env.CURSOR_API_KEY;
    unpinDaemonBase();
    await removeDaemonBaseDir(daemonBase);
    await rm(root, { recursive: true, force: true });
  });

  const legacyPath = () => join(root, '.lazy', 'agent-credentials.json');

  test('capability map: cursor yes, claude-code/qa-agent no', () => {
    expect(agentSupportsApiKey('cursor')).toBe(true);
    expect(agentSupportsApiKey('claude-code')).toBe(false);
    expect(agentSupportsApiKey('qa-agent')).toBe(false);
  });

  test('no source → null', async () => {
    expect(await resolveAgentApiKey(root, 'cursor')).toBeNull();
  });

  // The no-restart property: write, then resolve in the SAME process.
  test('a key written mid-process is resolved by the next launch-time lookup', async () => {
    expect(await resolveAgentApiKey(root, 'cursor')).toBeNull();
    const path = await writeAgentApiKey(root, 'cursor', 'key_abc123');
    const resolved = await resolveAgentApiKey(root, 'cursor');
    expect(resolved).toEqual({ value: 'key_abc123', source: 'file' });
    expect(path).toBe(join(getDaemonDir(root), 'agent-credentials.json'));
  });

  // SECURITY INVARIANT: the key must not live anywhere under the project root —
  // that whole tree is bind-mounted into every task container.
  test('the credentials file lives in the daemon dir, never under the project root', async () => {
    const path = await writeAgentApiKey(root, 'cursor', 'key_abc123');
    expect(path.startsWith(daemonBase)).toBe(true);
    expect(path.startsWith(root)).toBe(false);
    expect(credentialsPath(root)).toBe(path);
    // Nothing was created under <project>/.lazy either.
    await expect(access(legacyPath())).rejects.toThrow();
  });

  test('the env var overrides the stored key', async () => {
    await writeAgentApiKey(root, 'cursor', 'file_key');
    process.env.CURSOR_API_KEY = 'env_key';
    expect(await resolveAgentApiKey(root, 'cursor')).toEqual({ value: 'env_key', source: 'env' });
  });

  test('the credentials file is written mode 0600', async () => {
    const path = await writeAgentApiKey(root, 'cursor', 'secret');
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('keys are trimmed and empty keys are refused', async () => {
    await expect(writeAgentApiKey(root, 'cursor', '   ')).rejects.toThrow('empty API key');
    await writeAgentApiKey(root, 'cursor', '  padded  \n');
    expect((await resolveAgentApiKey(root, 'cursor'))?.value).toBe('padded');
  });

  test('unknown agents are refused a stored key', async () => {
    await expect(writeAgentApiKey(root, 'qa-agent', 'k')).rejects.toThrow('does not use an API key');
  });

  // Found-but-broken must be an error the human sees, not a silent "no key" —
  // otherwise they chase auth when the problem is bad JSON.
  test('a malformed credentials file fails loudly with the path', async () => {
    await mkdir(getDaemonDir(root), { recursive: true });
    await writeFile(credentialsPath(root), '{not json');
    await expect(resolveAgentApiKey(root, 'cursor')).rejects.toThrow(/agent-credentials\.json/);
  });

  test('clearAgentApiKey removes the key and reports presence', async () => {
    expect(await clearAgentApiKey(root, 'cursor')).toBe(false);
    await writeAgentApiKey(root, 'cursor', 'k1');
    expect(await clearAgentApiKey(root, 'cursor')).toBe(true);
    expect(await resolveAgentApiKey(root, 'cursor')).toBeNull();
    // Other agents' entries survive a clear.
    const raw = await readFile(credentialsPath(root), 'utf-8');
    expect(JSON.parse(raw)).toEqual({});
  });

  describe('migration from the pre-move in-repo location', () => {
    async function writeLegacy(content: string): Promise<void> {
      await mkdir(join(root, '.lazy'), { recursive: true });
      await writeFile(legacyPath(), content);
    }

    // The old file must not survive as a live secret inside the mounted repo.
    test('an in-repo key is migrated to the daemon dir and the original deleted', async () => {
      await writeLegacy(JSON.stringify({ cursor: { api_key: 'old_key' } }));

      expect(await resolveAgentApiKey(root, 'cursor')).toEqual({ value: 'old_key', source: 'file' });
      await expect(access(legacyPath())).rejects.toThrow();

      const migrated = JSON.parse(await readFile(credentialsPath(root), 'utf-8'));
      expect(migrated.cursor.api_key).toBe('old_key');
      expect((await stat(credentialsPath(root))).mode & 0o777).toBe(0o600);
    });

    test('a key set since the move wins over the stale in-repo one', async () => {
      await writeAgentApiKey(root, 'cursor', 'new_key');
      await writeLegacy(JSON.stringify({ cursor: { api_key: 'old_key' } }));

      expect((await resolveAgentApiKey(root, 'cursor'))?.value).toBe('new_key');
      await expect(access(legacyPath())).rejects.toThrow();
    });

    test('a malformed in-repo file fails loudly rather than being silently dropped', async () => {
      await writeLegacy('{not json');
      await expect(resolveAgentApiKey(root, 'cursor')).rejects.toThrow(/agent-credentials\.json/);
    });
  });
});
