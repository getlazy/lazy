import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { keychainService, libsecretAttributes } from '../../src/credentials/backends';
import { bindCredentialSet, listCredentialSets, projectsUsingCredentialSet, readCredentialSetBinding } from '../../src/credentials/set-binding';
import { credentialAvailable, credentialPresence, deleteCredential, effectiveCredentialIndex, credentialOverrideReport, getStoredCredential, locateCredential, readCredentialIndex, resolveCredential, setCredential } from '../../src/credentials/store';
import { credentialSetDir, validateSetName } from '../../src/credentials/scope';
import { forgetHydratedEnvValues, markHydratedEnvValue } from '../../src/credentials/hydrated-env';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { parseChatGptTokens, serializeChatGptTokens } from '../../src/credentials/chatgpt-tokens';
import { hydrateCredentialEnv } from '../../src/credentials/hydrate';
import { handleGetCredentialState } from '../../src/daemon/rpc-handlers';

describe('credential sets', () => {
  let temp: string;
  let root: string;
  let other: string;
  let unpin: () => void;
  const savedEnv = { ...process.env };

  function git(cwd: string, ...args: string[]): void {
    const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }

  beforeEach(async () => {
    for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) savedEnv[key] = process.env[key];
    temp = await mkdtemp(join(tmpdir(), 'lazy-sets-'));
    unpin = pinDaemonBaseDir(join(temp, 'daemon'));
    root = join(temp, 'project');
    other = join(temp, 'other');
    for (const path of [root, other]) {
      await mkdir(path);
      git(path, 'init');
      await writeFile(join(path, '.gitignore'), '.lazy/\n');
      await writeFile(join(path, 'lazy.toml'), '[credentials]\nbackend = "file"\n');
    }
    delete process.env.LAZY_MCP_EXPECTED_TASK_ID;
    delete process.env.LAZY_MCP_EXPECTED_WORKTREE;
    delete process.env.LAZY_TASK;
    await setCredential({ set: 'personal' }, { provider: 'openai', kind: 'api-key', secret: 'shared-key-123456789' }, 'file');
  });

  afterEach(async () => {
    forgetHydratedEnvValues();
    unpin();
    for (const key of ['LAZY_MCP_EXPECTED_TASK_ID', 'LAZY_MCP_EXPECTED_WORKTREE', 'LAZY_TASK', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await rm(temp, { recursive: true, force: true });
  });

  test('set identities are stable and separate from project identities in every backend', () => {
    expect(keychainService({ set: 'personal' })).toBe('lazy:set:personal');
    expect(keychainService(root)).not.toBe(keychainService({ set: 'personal' }));
    expect(libsecretAttributes({ set: 'personal' }, 'openai')).toEqual(['application', 'lazy', 'set', 'personal', 'provider', 'openai']);
    for (const name of ['../escape', '', 'UPPER', 'a/b', 'a\ncommand']) expect(() => validateSetName(name)).toThrow();
  });

  test('two projects resolve the same item; project entries override it per provider', async () => {
    await bindCredentialSet(root, 'personal');
    await bindCredentialSet(other, 'personal');
    expect((await resolveCredential(root, 'openai', {}))?.value).toBe('shared-key-123456789');
    expect((await resolveCredential(other, 'openai', {}))?.value).toBe('shared-key-123456789');
    expect(await locateCredential(root, 'openai', {})).toEqual({ source: 'store', via: 'file', setName: 'personal' });
    expect(await credentialAvailable(root, 'openai', {})).toBe('store');
    await setCredential(root, { provider: 'openai', kind: 'api-key', secret: 'project-key' }, 'file');
    expect((await resolveCredential(root, 'openai', {}))?.value).toBe('project-key');
    expect((await resolveCredential(other, 'openai', {}))?.value).toBe('shared-key-123456789');
    expect(await locateCredential(root, 'openai', {})).toEqual({ source: 'store', via: 'file' });
    expect(await readCredentialIndex(root)).toHaveLength(1);
    await deleteCredential(root, 'openai');
    expect((await getStoredCredential(root, 'openai'))?.setName).toBe('personal');
  });

  test('unbind retains its timestamp and uses the environment fallback', async () => {
    const before = await readFile(join(root, 'lazy.toml'), 'utf8');
    await bindCredentialSet(root, 'personal');
    expect(await projectsUsingCredentialSet('personal')).toEqual([root]);
    const unbound = await bindCredentialSet(root, null);
    expect(await readCredentialSetBinding(root)).toEqual(unbound);
    expect(unbound.set).toBeNull();
    expect(Date.parse(unbound.updatedAt)).toBeGreaterThan(0);
    expect(await projectsUsingCredentialSet('personal')).toEqual([]);
    expect(await resolveCredential(root, 'openai', {})).toBeNull();
    expect((await resolveCredential(root, 'openai', { OPENAI_API_KEY: 'environment-key' }))?.value).toBe('environment-key');
    expect(await readFile(join(root, 'lazy.toml'), 'utf8')).toBe(before);
  });

  // INVARIANT: a set binding is never read from a file on a branch. An agent
  // cannot select a person's spendable account through config or accepted files.
  test('config bindings, tracked binding files, and worktree binding files have no authority', async () => {
    await writeFile(join(root, 'lazy.toml'), '[credentials]\nbackend = "file"\nset = "personal"\n');
    expect(await getStoredCredential(root, 'openai')).toBeNull();
    await bindCredentialSet(root, 'personal');
    git(root, 'add', '-f', '.lazy/credential-set.json');
    await expect(readCredentialSetBinding(root)).rejects.toThrow('tracked credential binding');
    const worktree = join(temp, 'worktree');
    await mkdir(join(worktree, '.lazy'), { recursive: true });
    await writeFile(join(worktree, '.git'), `gitdir: ${root}/.git/worktrees/task\n`);
    await writeFile(join(worktree, '.lazy/credential-set.json'), JSON.stringify({ set: 'personal', updatedAt: new Date().toISOString() }));
    await expect(readCredentialSetBinding(worktree)).rejects.toThrow('project root');
  });

  test('a moved project keeps its binding and set credential', async () => {
    await bindCredentialSet(root, 'personal');
    const { rename } = await import('fs/promises');
    const moved = join(temp, 'moved');
    await rename(root, moved);
    expect((await getStoredCredential(moved, 'openai'))?.value).toBe('shared-key-123456789');
  });

  test('unknown sets name the existing choices and never change a binding', async () => {
    await bindCredentialSet(root, 'personal');
    await expect(bindCredentialSet(root, 'unknown')).rejects.toThrow('Existing sets: personal');
    expect((await readCredentialSetBinding(root))?.set).toBe('personal');
    expect(await listCredentialSets()).toEqual(['personal']);
  });

  test('agent turn markers refuse binding changes, including unbinding', async () => {
    for (const key of ['LAZY_MCP_EXPECTED_TASK_ID', 'LAZY_MCP_EXPECTED_WORKTREE', 'LAZY_TASK']) {
      process.env[key] = 'task';
      await expect(bindCredentialSet(root, 'personal')).rejects.toThrow('A person must run');
      await expect(bindCredentialSet(root, null)).rejects.toThrow('A person must run');
      delete process.env[key];
    }
  });

  test('symlinks and malformed bindings fail loudly', async () => {
    await mkdir(join(root, '.lazy'));
    const path = join(root, '.lazy/credential-set.json');
    await symlink(join(other, 'lazy.toml'), path);
    await expect(readCredentialSetBinding(root)).rejects.toThrow('regular local file');
    await rm(path);
    await writeFile(path, '{broken');
    await expect(readCredentialSetBinding(root)).rejects.toThrow('Cannot read credential binding');
  });

  test('hydrated provenance does not confuse two sets with identical index metadata', async () => {
    const first = (await readCredentialIndex({ set: 'personal' }))[0]!;
    await setCredential({ set: 'work' }, { provider: 'openai', kind: 'api-key', secret: 'different-key-123456789' }, 'file');
    await writeFile(join(credentialSetDir('work'), 'credential-index.json'), JSON.stringify({ version: 1, credentials: [first] }));
    await bindCredentialSet(root, 'personal');
    const env = { OPENAI_API_KEY: 'shared-key-123456789' };
    markHydratedEnvValue('openai', 'OPENAI_API_KEY', env.OPENAI_API_KEY, { ...first, setName: 'personal' });
    await bindCredentialSet(root, 'work');
    expect((await resolveCredential(root, 'openai', env))?.value).toBe('different-key-123456789');
    expect((await effectiveCredentialIndex(root))[0]?.setName).toBe('work');
  });

  test('a changed source never falls back to another set when its backend fails', async () => {
    const first = (await readCredentialIndex({ set: 'personal' }))[0]!;
    await bindCredentialSet(root, 'personal');
    const env = { OPENAI_API_KEY: 'shared-key-123456789' };
    markHydratedEnvValue('openai', 'OPENAI_API_KEY', env.OPENAI_API_KEY, { ...first, setName: 'personal' });
    await setCredential({ set: 'work' }, { provider: 'openai', kind: 'api-key', secret: 'other-secret' }, 'file');
    await bindCredentialSet(root, 'work');
    await rm(join(credentialSetDir('work'), 'credentials.json'));
    await expect(resolveCredential(root, 'openai', env)).rejects.toThrow('backend did not return one');
  });

  // INVARIANT: the daemon's credential report names the set and form actually
  // loaded, even after rebinding. Anthropic spends that startup copy until restart.
  test('Anthropic reports its hydrated set through the daemon after rebinding or unbinding', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    await setCredential({ set: 'personal' }, { provider: 'anthropic', kind: 'api-key', secret: 'personal-api-key' }, 'file');
    await setCredential({ set: 'work' }, { provider: 'anthropic', kind: 'oauth', secret: 'work-oauth-token' }, 'file');
    await bindCredentialSet(root, 'personal');
    await hydrateCredentialEnv(root);
    const loaded = { name: 'anthropic', present: true, source: 'env', via: 'ANTHROPIC_API_KEY', setName: 'personal', kind: 'api-key' };
    const report = async () => (await handleGetCredentialState(root, {})).providers.find(entry => entry.name === 'anthropic');
    expect(await report()).toMatchObject(loaded);
    await bindCredentialSet(root, 'work');
    expect(await report()).toMatchObject(loaded);
    expect((await resolveCredential(root, 'anthropic'))?.value).toBe('personal-api-key');
    await bindCredentialSet(root, null);
    expect(await report()).toMatchObject(loaded);
    await setCredential(root, { provider: 'anthropic', kind: 'oauth', secret: 'project-oauth-token' }, 'file');
    expect(await report()).toMatchObject(loaded);

    // Replacing the actual environment value invalidates its hydration mark.
    process.env.ANTHROPIC_API_KEY = 'explicit-export';
    expect(await report()).toMatchObject({ source: 'env', via: 'ANTHROPIC_API_KEY', kind: null });
    expect((await report())?.setName).toBeUndefined();
  });

  // INVARIANT: an export overrides both stored scopes; a hydrated startup copy
  // is not an export and must never be reported as shadowing its own source.
  test('override reporting names the stored scope without confusing hydration with an export', async () => {
    await bindCredentialSet(root, 'personal');
    const env = { OPENAI_API_KEY: 'explicit-export' };
    expect(await credentialOverrideReport(root, 'openai', env)).toEqual({ shadowed: 'set personal' });
    await setCredential(root, { provider: 'openai', kind: 'api-key', secret: 'project-key' }, 'file');
    expect(await credentialOverrideReport(root, 'openai', env)).toEqual({ shadowed: 'project credential store' });
    const stored = (await readCredentialIndex(root))[0]!;
    markHydratedEnvValue('openai', 'OPENAI_API_KEY', 'project-key', stored);
    expect(await credentialOverrideReport(root, 'openai', { OPENAI_API_KEY: 'project-key' })).toEqual({});
    expect(await credentialOverrideReport(root, 'openai', {})).toEqual({});
  });

  test('renewal writes cannot overwrite a credential replaced by a person', async () => {
    await expect(setCredential({ set: 'personal' }, {
      provider: 'openai', kind: 'api-key', secret: 'renewed-value', expectedValue: 'obsolete-value',
    }, 'file')).rejects.toThrow('newer credential was preserved');
    expect((await getStoredCredential({ set: 'personal' }, 'openai'))?.value).toBe('shared-key-123456789');
  });

  // INVARIANT: separate project daemons share ONE renewable set item. Renewal
  // must serialize across processes and persist to that set, never a project.
  test('two processes renew a shared session once and keep the rotation in the set', async () => {
    function token(expiresIn: number): string {
      const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      return `${b64({ alg: 'RS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + expiresIn })}.sig`;
    }
    await setCredential({ set: 'personal' }, { provider: 'chatgpt', kind: 'oauth', secret: serializeChatGptTokens({
      accessToken: token(-10), refreshToken: 'original-session', accountId: 'fake-account', idToken: null,
    }) }, 'file');
    await bindCredentialSet(root, 'personal');
    await bindCredentialSet(other, 'personal');
    let calls = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      calls++;
      expect(new URLSearchParams(await request.text()).get('refresh_token')).toBe('original-session');
      await Bun.sleep(100);
      return Response.json({ access_token: token(3600), refresh_token: 'rotated-session' });
    } });
    try {
      const fixture = join(import.meta.dir, '../fixtures/shared-session-renewal.ts');
      const children = [root, other].map(project => Bun.spawn([process.execPath, fixture, project, `http://127.0.0.1:${server.port}`], {
        env: { ...process.env, CHATGPT_AUTH: '' }, stdout: 'pipe', stderr: 'pipe',
      }));
      const results = await Promise.all(children.map(async child => ({
        code: await child.exited, error: await new Response(child.stderr).text(),
      })));
      expect(results).toEqual([{ code: 0, error: '' }, { code: 0, error: '' }]);
      expect(calls).toBe(1);
      const stored = await getStoredCredential({ set: 'personal' }, 'chatgpt');
      expect(parseChatGptTokens(stored!.value, 'test set').refreshToken).toBe('rotated-session');
      expect((await readCredentialIndex(root)).find(entry => entry.provider === 'chatgpt')).toBeUndefined();
      expect((await readCredentialIndex(other)).find(entry => entry.provider === 'chatgpt')).toBeUndefined();
    } finally {
      server.stop(true);
    }
  }, 15_000);
});
