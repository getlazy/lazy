import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, realpath, readFile, mkdir, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import {
  putForgeCredential,
  revokeForgeCredential,
  checkPushAccess,
  classifyPushFailure,
  defaultRunCommand,
  type RunCommand,
  type FetchJson,
  tokenFingerprint,
  forgeForRemote,
  ensureForgeCredentialHelper,
  forgeCredentialHelper,
  persistForgeCredential,
} from '../../src/daemon/forge-credential';
import { spawn } from '../../src/utils/spawn';
import { getForgeCredentialPath } from '../../src/daemon/paths';

async function sh(argv: string[], cwd: string): Promise<void> {
  const p = Bun.spawn(argv, { cwd, stdout: 'ignore', stderr: 'pipe' });
  if ((await p.exited) !== 0) throw new Error(`${argv.join(' ')}: ${await new Response(p.stderr).text()}`);
}

describe('forge credential on a running daemon', () => {
  // INVARIANT: a token pushed at runtime reaches the NEXT child the daemon
  // spawns. Bun.spawn's own default env is the startup snapshot, so without the
  // wrapper passing the live environment a replaced forge token reached no git
  // until a restart — the 2026-10-20 "new token, still can't push" report.
  test('a replaced token reaches the next spawned child without a restart', async () => {
    const env = process.env;
    const before = { GH_TOKEN: env.GH_TOKEN, GITLAB_TOKEN: env.GITLAB_TOKEN };
    try {
      putForgeCredential({ kind: 'github', token: 'first-token', handle: 'alice', source: 'user' });
      putForgeCredential({ kind: 'github', token: 'second-token', handle: 'alice', source: 'user' });
      const proc = spawn(['sh', '-c', 'printf %s "$GH_TOKEN"'], { stdout: 'pipe' });
      expect(await new Response(proc.stdout).text()).toBe('second-token');

      revokeForgeCredential();
      const after = spawn(['sh', '-c', 'printf %s "${GH_TOKEN-unset}"'], { stdout: 'pipe' });
      expect(await new Response(after.stdout).text()).toBe('unset');
    } finally {
      for (const [k, v] of Object.entries(before)) { if (v === undefined) delete env[k]; else env[k] = v; }
    }
  });

  // INVARIANT: the live environment never carries the daemon's own
  // LAZY_IS_DAEMON marker into a child — a lazy subprocess inheriting it would
  // switch off its daemon RPC. Bun's startup-snapshot default never passed it.
  test('the daemon-only marker is not inherited by children', async () => {
    const before = process.env.LAZY_IS_DAEMON;
    try {
      process.env.LAZY_IS_DAEMON = '1';
      const proc = spawn(['sh', '-c', 'printf %s "${LAZY_IS_DAEMON-unset}"'], { stdout: 'pipe' });
      expect(await new Response(proc.stdout).text()).toBe('unset');
    } finally {
      if (before === undefined) delete process.env.LAZY_IS_DAEMON; else process.env.LAZY_IS_DAEMON = before;
    }
  });

  test('switching forge clears the other forge variable', () => {
    const env: NodeJS.ProcessEnv = { GITLAB_TOKEN: 'old' };
    const summary = putForgeCredential({ kind: 'github', token: 't', source: 'integration' }, env);
    expect(env).toEqual({ GH_TOKEN: 't' });
    expect(summary).toMatchObject({ kind: 'github', source: 'integration' });
    expect(JSON.stringify(summary)).not.toContain('"t"');
  });
});

const noApi: FetchJson = async () => { throw new Error('no network in unit tests'); };

describe('push access check', () => {
  let dir: string;
  let repo: string;

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-push-check-')));
    const bare = join(dir, 'remote.git');
    repo = join(dir, 'clone');
    await sh(['git', 'init', '--bare', '-q', bare], dir);
    await sh(['git', 'init', '-q', repo], dir);
    await sh(['git', 'remote', 'add', 'origin', bare], repo);
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  test('a writable remote is OK, and the probe creates no ref', async () => {
    const access = await checkPushAccess(repo, { remote: 'origin', forge: 'github', env: { GH_TOKEN: 'x' } });
    expect(access).toMatchObject({ ok: true, result: 'ok' });
    const refs = await defaultRunCommand(['git', 'ls-remote', 'origin'], repo);
    expect(refs.stdout.trim()).toBe('');
  });

  test('no token is named, with the connect remedy', async () => {
    const access = await checkPushAccess(repo, { remote: 'origin', forge: 'github', env: {} });
    expect(access.result).toBe('no_credential');
    expect(access.remedy).toContain('Connect your GitHub account');
  });

  test('a 403 carries the forge message and the scope remedy', async () => {
    const run: RunCommand = async (argv, cwd) => argv[1] === 'push'
      ? { exitCode: 128, stdout: '', stderr: 'remote: Permission to acme/app.git denied to alice.\nfatal: unable to access \'https://github.com/acme/app.git/\': The requested URL returned error: 403\n' }
      : argv[1] === 'remote' ? { exitCode: 0, stdout: 'https://github.com/acme/app.git\n', stderr: '' } : defaultRunCommand(argv, cwd);
    const access = await checkPushAccess(repo, { remote: 'origin', forge: 'github', run, env: { GH_TOKEN: 'x' }, fetchJson: noApi });
    expect(access.result).toBe('forbidden');
    expect(access.forgeMessage).toContain('Permission to acme/app.git denied to alice');
    expect(access.remedy).toContain('Contents: Read and write');
  });

  // INVARIANT: a token is set but git had no credential to offer (the helper
  // handed it nothing) — the push check answers no_credential with the connect
  // remedy, never "the token was refused".
  test('git with no credential to offer reads as no credential, with the connect remedy', async () => {
    const stderr = await readFile(join(import.meta.dir, '../fixtures/forge-refusals/no-credential-prompts-disabled.txt'), 'utf-8');
    const run: RunCommand = async (argv, cwd) => argv[1] === 'push'
      ? { exitCode: 128, stdout: '', stderr }
      : argv[1] === 'remote' ? { exitCode: 0, stdout: 'https://github.com/acme/app.git\n', stderr: '' } : defaultRunCommand(argv, cwd);
    const access = await checkPushAccess(repo, { remote: 'origin', forge: 'github', run, env: { GH_TOKEN: 'x' }, fetchJson: noApi });
    expect(access.result).toBe('no_credential');
    expect(access.remedy).toContain('Connect your GitHub account');
    expect(access.forgeMessage).toContain('terminal prompts disabled');
  });

  test('an SSH remote is named, since the token cannot authenticate it', async () => {
    const run: RunCommand = async () => ({ exitCode: 0, stdout: 'git@github.com:acme/app.git\n', stderr: '' });
    const access = await checkPushAccess(repo, { remote: 'origin', forge: 'github', run, env: { GH_TOKEN: 'x' }, fetchJson: noApi });
    expect(access.result).toBe('ssh_remote');
  });

  test('classification', () => {
    expect(classifyPushFailure('remote: Invalid username or password.\nfatal: Authentication failed for')).toBe('unauthorized');
    expect(classifyPushFailure('remote: Repository not found.\nfatal: repository not found')).toBe('not_found');
    expect(classifyPushFailure('fatal: unable to access: Could not resolve host: github.com')).toBe('unreachable');
  });
});

describe('push access check — GitHub API refinements', () => {
  const githubRemote: RunCommand = async (argv) => argv[1] === 'remote'
    ? { exitCode: 0, stdout: 'https://github.com/acme/app.git\n', stderr: '' }
    : { exitCode: 128, stdout: '', stderr: "remote: Repository not found.\nfatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 403\n" };

  // INVARIANT: an org's SAML SSO is named as such, with GitHub's own
  // authorization URL — the engineer's first new token was refused for exactly
  // this and nothing said so (2026-10-20).
  test('an X-GitHub-SSO header names SSO and carries the URL', async () => {
    const fetchJson: FetchJson = async () => ({
      status: 403,
      headers: { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso?authorization_request=XYZ' },
      body: { message: 'Resource protected by organization SAML enforcement.' },
    });
    const access = await checkPushAccess('/tmp', { remote: 'origin', forge: 'github', run: githubRemote, env: { GH_TOKEN: 'tok' }, fetchJson });
    expect(access).toMatchObject({ result: 'sso_required', ssoUrl: 'https://github.com/orgs/acme/sso?authorization_request=XYZ' });
    expect(access.remedy).toContain("acme organization's SSO");
    expect(access.remedy).toContain('https://github.com/orgs/acme/sso?authorization_request=XYZ');
    expect(access.heldFingerprint).toBe(tokenFingerprint('tok'));
  });

  test('a handshake that passes but no push permission is a read-only token', async () => {
    const run: RunCommand = async (argv) => argv[1] === 'remote'
      ? { exitCode: 0, stdout: 'https://github.com/acme/app.git\n', stderr: '' }
      : { exitCode: 0, stdout: '', stderr: '' };
    const fetchJson: FetchJson = async () => ({ status: 200, headers: {}, body: { permissions: { push: false, pull: true } } });
    const access = await checkPushAccess('/tmp', { remote: 'origin', forge: 'github', run, env: { GH_TOKEN: 'tok' }, fetchJson });
    expect(access.result).toBe('forbidden');
  });
});

describe('forgeForRemote', () => {
  // INVARIANT: the forge whose token a project pushes with is decided from the
  // REMOTE, with Teams' own host rules — never from the `[remote] driver`
  // name, which is `local` on a managed project that still pushes to origin.
  test('host rules match Teams', () => {
    expect(forgeForRemote('https://github.com/acme/app.git', {})).toBe('github');
    expect(forgeForRemote('git@github.com:acme/app.git', {})).toBe('github');
    expect(forgeForRemote('https://gitlab.com/acme/app.git', {})).toBe('gitlab');
    expect(forgeForRemote('https://gitlab.example.org/acme/app.git', {})).toBe('gitlab');
  });

  test('any other host: the token actually seeded decides', () => {
    revokeForgeCredential({});
    expect(forgeForRemote('https://git.example.org/acme/app.git', { GH_TOKEN: 'x' })).toBe('github');
    expect(forgeForRemote('/srv/repos/app.git', { GITLAB_TOKEN: 'x' })).toBe('gitlab');
    expect(forgeForRemote('/srv/repos/app.git', {})).toBeUndefined();
  });
});

describe('push access summaries', () => {
  // INVARIANT: a summary never contains the remote URL — every member reads
  // it, and a URL can carry credentials or a host they need not see. Admins
  // get `remoteUrl` beside it.
  const url = 'https://x-access-token:ghp_SECRET@github.com/acme/private-thing.git';
  const results: Array<[string, RunCommand]> = [
    ['ok', async (argv) => argv[1] === 'remote' ? { exitCode: 0, stdout: `${url}\n`, stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }],
    ['ssh', async () => ({ exitCode: 0, stdout: 'git@github.com:acme/private-thing.git\n', stderr: '' })],
    ['forbidden', async (argv) => argv[1] === 'remote' ? { exitCode: 0, stdout: `${url}\n`, stderr: '' }
      : { exitCode: 128, stdout: '', stderr: 'remote: Permission to acme/private-thing.git denied. The requested URL returned error: 403' }],
  ];
  for (const [name, run] of results) {
    test(`${name}: no URL in the summary`, async () => {
      const access = await checkPushAccess('/tmp', { remote: 'origin', forge: 'github', run, env: { GH_TOKEN: 't' }, fetchJson: noApi });
      expect(access.summary).not.toContain('private-thing');
      expect(access.summary).not.toContain('ghp_SECRET');
      expect(access.summary).not.toMatch(/https?:\/\/|git@/);
    });
  }
});

describe('the clone credential helper a live token needs', () => {
  let dir: string;
  beforeAll(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'lazy-cred-helper-'))); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  async function repoWithOrigin(name: string, url: string): Promise<string> {
    const repo = join(dir, name);
    await sh(['git', 'init', '-q', repo], dir);
    await sh(['git', 'remote', 'add', 'origin', url], repo);
    return repo;
  }
  const helpers = async (repo: string) =>
    (await defaultRunCommand(['git', 'config', '--local', '--get-all', 'credential.helper'], repo)).stdout;

  // INVARIANT: a token pushed to a running daemon must reach `git push`, which
  // reads it only through the clone's credential helper. A project started with
  // no token had no helper, so a newly connected account fixed `gh` and nothing
  // else (turn-71 review). Only the variable's NAME is written, never a token.
  test('installs the helper for an https remote, once, naming only the variable', async () => {
    const repo = await repoWithOrigin('https', 'https://github.com/acme/app.git');
    expect(await ensureForgeCredentialHelper(repo, 'github', { remote: 'origin' })).toEqual({ outcome: 'installed' });
    expect(await helpers(repo)).toBe(`\n${forgeCredentialHelper('github')}\n`);
    expect(forgeCredentialHelper('github')).toContain('$GH_TOKEN');
    expect(await ensureForgeCredentialHelper(repo, 'github', { remote: 'origin' })).toEqual({ outcome: 'present' });
    expect(await helpers(repo)).toBe(`\n${forgeCredentialHelper('github')}\n`);

    // Switching forge replaces it rather than stacking a second identity.
    expect(await ensureForgeCredentialHelper(repo, 'gitlab', { remote: 'origin' })).toEqual({ outcome: 'installed' });
    expect(await helpers(repo)).toBe(`\n${forgeCredentialHelper('gitlab')}\n`);
    expect(await readFile(join(repo, '.git', 'config'), 'utf-8')).not.toMatch(/ghp_|glpat-/);
  });

  // INVARIANT: a forge token never travels in the clear — no helper for an
  // http:// or SSH remote, matching the fleet's own rule.
  test('an http or ssh remote gets no helper', async () => {
    for (const [name, url] of [['http', 'http://git.example.com/acme/app.git'], ['ssh', 'git@github.com:acme/app.git']]) {
      const repo = await repoWithOrigin(name, url);
      const result = await ensureForgeCredentialHelper(repo, 'github', { remote: 'origin' });
      expect(result.outcome).toBe('skipped');
      expect(await helpers(repo)).toBe('');
    }
  });
});

describe('storing the pushed token', () => {
  // INVARIANT: a failed write never leaves a stray copy of the token on disk:
  // the per-call temp file is removed before the push is refused.
  test('a failed write removes its temp file and refuses', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'lazy-forge-persist-')));
    const saved = { base: process.env.LAZY_DAEMON_BASE_DIR, managed: process.env.LAZY_TEST_FORCE_MANAGED };
    process.env.LAZY_DAEMON_BASE_DIR = base;
    process.env.LAZY_TEST_FORCE_MANAGED = '1';
    try {
      const root = join(base, 'project');
      const target = getForgeCredentialPath(root);
      // A non-empty directory where the file belongs: the final rename fails.
      await mkdir(join(target, 'occupied'), { recursive: true });
      await expect(persistForgeCredential(root, { kind: 'github', token: 'ghp_secret_value', source: 'user' }))
        .rejects.toThrow(/could not store the forge credential/);
      const left = await readdir(dirname(target));
      expect(left.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    } finally {
      if (saved.base === undefined) delete process.env.LAZY_DAEMON_BASE_DIR; else process.env.LAZY_DAEMON_BASE_DIR = saved.base;
      if (saved.managed === undefined) delete process.env.LAZY_TEST_FORCE_MANAGED; else process.env.LAZY_TEST_FORCE_MANAGED = saved.managed;
      await rm(base, { recursive: true, force: true });
    }
  });
});
