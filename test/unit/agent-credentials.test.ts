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
import { mkdtemp, rm, stat, readFile, writeFile, mkdir, access, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  locateProfileCredential,
  resolveAgentApiKey,
  resolveProfileCredential,
  writeAgentApiKey,
  clearAgentApiKey,
  agentSupportsApiKey,
  alternativeCredentialHint,
  credentialsPath,
} from '../../src/agent/credentials';
import { setCredential } from '../../src/credentials/store';
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

  // Atomic write: temp is created at 0600, then renamed — overwriting a file
  // that already existed with loose permissions must not leave a secret world-
  // readable even briefly at the final path.
  test('overwriting an existing credentials file ends at mode 0600', async () => {
    await mkdir(getDaemonDir(root), { recursive: true });
    await writeFile(credentialsPath(root), '{"cursor":{"api_key":"old"}}\n', { mode: 0o644 });
    await writeAgentApiKey(root, 'cursor', 'new-key');
    expect((await stat(credentialsPath(root))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credentialsPath(root), 'utf-8')).cursor.api_key).toBe('new-key');
  });

  test('written credentials are complete, parseable JSON', async () => {
    await writeAgentApiKey(root, 'cursor', 'key_with_"quotes"_and_\\slashes');
    const parsed = JSON.parse(await readFile(credentialsPath(root), 'utf-8'));
    expect(parsed.cursor.api_key).toBe('key_with_"quotes"_and_\\slashes');
  });

  // INVARIANT: a failed write must not truncate the previous file — torn JSON
  // hard-fails every subsequent launch (parseCredentials throws).
  test('a failed write leaves the previous credentials file intact', async () => {
    // chmod 0555 on the daemon dir does not block writes when running as root.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      console.log(
        'skipped: a failed write leaves the previous credentials file intact — ' +
        'chmod 0555 on the daemon dir does not block writes when running as root',
      );
      return;
    }

    await writeAgentApiKey(root, 'cursor', 'original-key');
    const path = credentialsPath(root);
    const before = await readFile(path, 'utf-8');

    const dir = getDaemonDir(root);
    await chmod(dir, 0o555);
    try {
      await expect(writeAgentApiKey(root, 'cursor', 'replacement-key')).rejects.toThrow();
      expect(await readFile(path, 'utf-8')).toBe(before);
      expect(JSON.parse(before).cursor.api_key).toBe('original-key');
    } finally {
      await chmod(dir, 0o700);
    }
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

  /**
   * The launch check asks about the PROFILE's credential slot, because that is
   * the slot the proxy bills per request. Keyed by harness instead, a launch
   * would pass on a key the turn is never sent with — and then 401 mid-turn.
   */
  describe('resolveProfileCredential (the slot the proxy bills)', () => {
    const codex = { name: 'codex', harness: 'codex', credential: 'openai' };
    const workCodex = { name: 'work-codex', harness: 'codex', credential: 'work-openai' };

    afterEach(() => {
      delete process.env.LAZY_CREDENTIAL_WORK_OPENAI;
      delete process.env.OPENAI_API_KEY;
    });

    test('`none` resolves to null — that upstream authenticates nobody', async () => {
      await writeAgentApiKey(root, 'codex', 'file_key');
      expect(await resolveProfileCredential(root, { ...codex, credential: 'none' })).toBeNull();
    });

    test('a named credential resolves from the store', async () => {
      await setCredential(root, { provider: 'work-openai', kind: 'api-key', secret: 'sk-work' }, 'file');
      expect(await resolveProfileCredential(root, workCodex)).toEqual({ value: 'sk-work', source: 'store' });
    });

    // INVARIANT: two profiles on ONE harness bill DIFFERENT keys. A named
    // credential must never inherit the harness's own key — that silent
    // inheritance is precisely the divergence this function exists to close.
    test('a named credential does NOT fall back to the harness key file', async () => {
      await writeAgentApiKey(root, 'codex', 'file_key');
      expect(await resolveProfileCredential(root, workCodex)).toBeNull();
      // The built-in profile, whose slot that file IS about, still resolves it.
      expect(await resolveProfileCredential(root, codex)).toEqual({ value: 'file_key', source: 'file' });
    });

    test('the named credential env var wins over the store', async () => {
      await setCredential(root, { provider: 'work-openai', kind: 'api-key', secret: 'sk-stored' }, 'file');
      process.env.LAZY_CREDENTIAL_WORK_OPENAI = 'sk-from-env';
      expect(await resolveProfileCredential(root, workCodex)).toEqual({ value: 'sk-from-env', source: 'env' });
    });
  });

  describe('alternativeCredentialHint', () => {
    // A codex task refused for a missing API key is exactly the moment to
    // mention the subscription — and the two commands it names must be ones
    // that work as written: the import resolves through the AGENT name, and the
    // task has to be pointed at that agent or the key it stored is never billed.
    test('a keyless codex launch is offered the subscription, by agent name', () => {
      const hint = alternativeCredentialHint('codex', 'openai');
      expect(hint).toContain('codex login');
      expect(hint).toContain('lazy auth import codex-subscription');
      expect(hint).toContain('--agent codex-subscription');
    });

    test('nothing is suggested when the task IS on the subscription, or is not codex', () => {
      expect(alternativeCredentialHint('codex', 'chatgpt')).toBe('');
      expect(alternativeCredentialHint('cursor', 'cursor')).toBe('');
    });
  });

  /**
   * The presence twin of resolveProfileCredential, for `lazy doctor` and the
   * daemon's credential-state RPC: same env → store → key-file order, never a
   * secret in the answer, and never a store backend opened (index read only).
   */
  describe('locateProfileCredential (presence, never the secret)', () => {
    const codex = { name: 'codex', harness: 'codex', credential: 'openai' };
    let savedOpenai: string | undefined;

    beforeEach(() => {
      savedOpenai = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.LAZY_CREDENTIAL_WORK_OPENAI;
    });

    afterEach(() => {
      if (savedOpenai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenai;
      delete process.env.LAZY_CREDENTIAL_WORK_OPENAI;
    });

    test('`none` is never present — nothing can be', async () => {
      await writeAgentApiKey(root, 'codex', 'file_key');
      expect(await locateProfileCredential(root, 'none', ['codex']))
        .toEqual({ present: false, source: null, via: null, kind: null });
    });

    test('the environment wins and is named by variable, never by value', async () => {
      process.env.OPENAI_API_KEY = 'sk-env-secret';
      await setCredential(root, { provider: 'openai', kind: 'api-key', secret: 'sk-stored' }, 'file');
      const located = await locateProfileCredential(root, 'openai', ['codex']);
      expect(located).toEqual({ present: true, source: 'env', via: 'OPENAI_API_KEY', kind: null });
      expect(JSON.stringify(located)).not.toContain('sk-');
    });

    test('the store is second and is named by backend', async () => {
      await setCredential(root, { provider: 'work-openai', kind: 'api-key', secret: 'sk-work' }, 'file');
      expect(await locateProfileCredential(root, 'work-openai', ['codex']))
        .toEqual({ present: true, source: 'store', via: 'file', kind: 'api-key' });
    });

    // INVARIANT: the agent key file counts only under the resolver's own rule —
    // for a harness whose key that file IS about. A named credential must not
    // read as present because the harness happens to have a key of its own,
    // and a harness without a key of its own never reaches the file.
    test('the agent key file is third, and only for the harness it belongs to', async () => {
      await writeAgentApiKey(root, 'codex', 'file_key');
      expect(await locateProfileCredential(root, 'openai', ['codex']))
        .toEqual({ present: true, source: 'file', via: credentialsPath(root), kind: 'api-key' });
      expect(await locateProfileCredential(root, 'work-openai', ['codex']))
        .toEqual({ present: false, source: null, via: null, kind: null });
      expect(await locateProfileCredential(root, 'openai', ['pi']))
        .toEqual({ present: false, source: null, via: null, kind: null });
    });

    // The whole point of a twin: what doctor reports present, a launch can use.
    test('agrees with the resolver on every source', async () => {
      const agree = async () =>
        expect((await locateProfileCredential(root, 'openai', ['codex'])).source)
          .toBe((await resolveProfileCredential(root, codex))?.source ?? null);
      await agree();
      await writeAgentApiKey(root, 'codex', 'file_key');
      await agree();
      await setCredential(root, { provider: 'openai', kind: 'api-key', secret: 'sk-stored' }, 'file');
      await agree();
      process.env.OPENAI_API_KEY = 'sk-env';
      await agree();
    });

    // Found-but-broken is this credential's finding, not a silent "absent".
    test('a broken key file fails loudly rather than reading as absent', async () => {
      await mkdir(getDaemonDir(root), { recursive: true });
      await writeFile(credentialsPath(root), '{not json');
      await expect(locateProfileCredential(root, 'openai', ['codex'])).rejects.toThrow(/agent-credentials\.json/);
    });
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
