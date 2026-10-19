/**
 * e2e: machine-level `lazy login <install>` outside any repository, plain
 * `git clone` afterwards, and `lazy clone <install> <team>/<project>`.
 *
 * The install is a stand-in: the device-login endpoints, the project list, and
 * a hosted repository served by real `git http-backend` behind a check for the
 * Bearer token — so a clone succeeding is proof git sent the token, and a clone
 * failing after logout is proof the config entry is gone. The user-level git
 * config is a temp file (`GIT_CONFIG_GLOBAL`), never the real ~/.gitconfig.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { getCredentialIndexPath } from '../../src/daemon/paths';
import { readCredentialIndex, setCredential } from '../../src/credentials/store';
import { isInstallCloneArgs } from '../../src/cli/commands/login';
import { fakeTeamsJwt } from '../helpers/teams-jwt';

// A JWT naming the stub install as its issuer, as the browser login behind a
// proxy hands out — set when the install starts, since its origin has a random port.
let TOKEN = '';

interface Install {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  requests: string[];
  /** Make the install ask for the device-code login (no proxy) instead of the browser one. */
  useDeviceLogin: () => void;
  /** Make it an install too old to send token scopes (its device tokens are CLI-only). */
  useOldInstall: () => void;
  /** Authorization headers on git requests, in order. */
  gitAuth: Array<string | null>;
}

/** Run one smart-HTTP request through `git http-backend` (CGI). */
async function httpBackend(req: Request, reposDir: string, pathInfo: string): Promise<Response> {
  const url = new URL(req.url);
  const body = new Uint8Array(await req.arrayBuffer());
  const proc = Bun.spawn(['git', 'http-backend'], {
    stdin: body,
    stdout: 'pipe',
    stderr: 'ignore',
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: reposDir,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: pathInfo,
      QUERY_STRING: url.search.replace(/^\?/, ''),
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers.get('content-type') ?? '',
      CONTENT_LENGTH: String(body.length),
    },
  });
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  // CGI: headers, a blank line, then the body.
  let split = -1;
  for (let i = 0; i < out.length - 3; i++) {
    if (out[i] === 13 && out[i + 1] === 10 && out[i + 2] === 13 && out[i + 3] === 10) { split = i; break; }
  }
  const head = new TextDecoder().decode(out.slice(0, split));
  const headers = new Headers();
  let status = 200;
  for (const line of head.split('\r\n')) {
    const [k, ...v] = line.split(':');
    if (k.toLowerCase() === 'status') status = Number.parseInt(v.join(':').trim(), 10);
    else if (k) headers.set(k, v.join(':').trim());
  }
  return new Response(out.slice(split + 4), { status, headers });
}

function startInstall(reposDir: string): Install {
  const requests: string[] = [];
  const gitAuth: Array<string | null> = [];
  let deviceLogin = false;
  let oldInstall = false;

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname);
      if (url.pathname === '/.well-known/lazy-teams') {
        return deviceLogin ? new Response('not found', { status: 404 }) : Response.json({ login: 'loopback' });
      }
      if (url.pathname === '/api/cli/device/code') {
        await req.text();
        return Response.json({
          user_code: 'KTPX-9QFD', device_code: 'device-code-0123456789',
          verification_uri: `${url.origin}/device`, interval: 1, expires_in: 900,
        }, { status: 201 });
      }
      if (url.pathname === '/api/cli/device/token') {
        await req.text();
        // An install from before code-approved logins carried git sends no scopes.
        return Response.json({ status: 'approved', token: TOKEN, user: { email: 'ada@example.com' }, ...(oldInstall ? {} : { scopes: ['cli', 'git'] }) });
      }
      if (url.pathname === '/api/cli/projects') {
        if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        return Response.json({ projects: [
        // Hosted at its STORED path (a rename leaves it behind the slug) on a DIFFERENT host than the one typed: only the path is used.
          { id: '11', slug: 'acme/api', name: 'API', team: 'Acme', hosted_repo_url: "http://r.example.test/git/acme/api-server.git" },
          { id: '12', slug: 'acme/on-forge', name: 'Forge', team: 'Acme', hosted_repo_url: null },
        ] });
      }
      if (url.pathname.startsWith('/git/')) {
        const auth = req.headers.get('authorization');
        gitAuth.push(auth);
        // Like the install: no credentials gets a challenge, and only the
        // install's token gets in.
        if (auth !== `Bearer ${TOKEN}`) {
          return new Response('auth required\n', {
            status: 401,
            headers: { 'www-authenticate': 'Basic realm="Lazy Teams"' },
          });
        }
        return httpBackend(req, reposDir, url.pathname.slice('/git'.length));
      }
      return new Response('not found', { status: 404 });
    },
  });
  TOKEN = fakeTeamsJwt(`http://127.0.0.1:${server.port}`);
  return {
    server, url: `http://127.0.0.1:${server.port}`, requests, gitAuth,
    useDeviceLogin: () => { deviceLogin = true; },
    useOldInstall: () => { oldInstall = true; },
  };
}

describe('machine-level login and lazy clone', () => {
  let ctx: TestContext;
  let home: string;
  let daemonBase: string;
  let outside: string;
  let unpin: () => void;
  let install: Install;
  let binDir: string;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    home = await realpath(await mkdtemp(join(tmpdir(), 'lazy-clone-home-')));
    daemonBase = await mkdtemp(join(tmpdir(), 'lzd-clone-'));
    unpin = pinDaemonBaseDir(daemonBase);
    // A directory that is in no repository at all.
    outside = await realpath(await mkdtemp(join(tmpdir(), 'lazy-clone-outside-')));
    await writeFile(join(home, 'gitconfig'), '[user]\n\tname = Ada\n\temail = ada@example.com\n');
    // Machine and clone stores both use the file backend, on every host.
    await mkdir(join(home, '.lazy', 'teams-machine-login'), { recursive: true });
    await writeFile(join(home, '.lazy', 'teams-machine-login', 'lazy.toml'), '[credentials]\nbackend = "file"\n');

    // The hosted repository: a bare repo with one commit, and its own lazy.toml
    // so the bound clone's store also uses the file backend.
    const reposDir = join(home, 'repos');
    const seed = join(home, 'seed');
    await mkdir(join(reposDir, 'acme'), { recursive: true });
    await mkdir(seed);
    const git = (cwd: string, ...args: string[]) =>
      Bun.spawn(['git', ...args], { cwd, env: { ...process.env, ...gitEnv() }, stdout: 'ignore', stderr: 'ignore' }).exited;
    await git(seed, 'init', '-q', '-b', 'main');
    await writeFile(join(seed, 'lazy.toml'), '[credentials]\nbackend = "file"\n');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-q', '-m', 'seed');
    await git(home, 'clone', '-q', '--bare', seed, join(reposDir, 'acme', 'api-server.git'));

    install = startInstall(reposDir);

    // The browser: the platform opener is a stand-in that plays a person who
    // passes the proxy sign-in and approves — it posts the token to the
    // listener the URL names, exactly as the approval page does.
    binDir = join(home, 'bin');
    await mkdir(binDir);
    const browser = join(binDir, 'browser.ts');
    await writeFile(browser, `
      const u = new URL(process.argv[2]);
      await fetch('http://127.0.0.1:' + u.searchParams.get('loopback_port') + '/callback', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ state: u.searchParams.get('state'), token: '${TOKEN}', email: 'ada@example.com' }),
      });
    `);
    for (const name of ['open', 'xdg-open']) {
      await writeFile(join(binDir, name), `#!/bin/sh\nexec "${process.execPath}" "${browser}" "$1"\n`);
      await chmod(join(binDir, name), 0o755);
    }
  });

  afterEach(async () => {
    install.server.stop(true);
    await ctx.cleanup();
    unpin();
    for (const d of [home, daemonBase, outside]) await rm(d, { recursive: true, force: true });
  });

  const gitEnv = () => ({
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  });
  const env = () => ({
    ...gitEnv(),
    LAZY_DAEMON_BASE_DIR: daemonBase,
    LAZY_FORCE_TTY: '1',
    DISPLAY: ':0',
    PATH: `${binDir}:${process.env.PATH}`,
  });

  async function plainGitClone(dest: string): Promise<number> {
    return Bun.spawn(['git', 'clone', '-q', `${install.url}/git/acme/api-server.git`, dest], {
      cwd: outside, env: { ...process.env, ...gitEnv() }, stdout: 'ignore', stderr: 'ignore',
    }).exited;
  }

  // INVARIANT: after one `lazy login <install>` — run outside any repository —
  // a plain `git clone` of a hosted project works with no further step, and
  // `lazy logout` takes that away again. That is the whole of "just works".
  test('login outside a repo makes plain git clone work; logout undoes it', async () => {
    expect(await plainGitClone(join(outside, 'before'))).not.toBe(0);

    const login = await ctx.lazy(['login', install.url], { env: env(), cwd: outside });
    expect(login.exitCode).toBe(0);
    expect(login.stdout).toContain('Approved as ada@example.com');
    expect(login.stdout).toContain(join(home, 'gitconfig'));
    expect(login.stdout).not.toContain(TOKEN);
    // No project was bound and none was asked for.
    expect(login.stdout).not.toContain('Which project');

    const userConfig = await readFile(join(home, 'gitconfig'), 'utf-8');
    expect(userConfig).not.toContain(TOKEN);

    expect(await plainGitClone(join(outside, 'after'))).toBe(0);
    await stat(join(outside, 'after', 'lazy.toml'));

    const status = await ctx.lazy(['login'], { env: env(), cwd: outside });
    expect(status.stdout).toContain(`127.0.0.1:${install.server.port}`);

    const logout = await ctx.lazy(['logout'], { env: env(), cwd: outside });
    expect(logout.exitCode).toBe(0);
    expect(logout.stdout).toContain(join(home, 'gitconfig'));
    expect(await readFile(join(home, 'gitconfig'), 'utf-8')).not.toContain('teams-git');
    expect(await plainGitClone(join(outside, 'after-logout'))).not.toBe(0);
  });

  // INVARIANT: a code-approved login (an install with no sign-in proxy) sets
  // git up exactly like the browser login: its token carries git access too,
  // so plain `git clone` works after it.
  test('a code-approved login (no proxy) also makes plain git clone work', async () => {
    install.useDeviceLogin();
    const login = await ctx.lazy(['login', install.url], { env: env(), cwd: outside });
    expect(login.exitCode).toBe(0);
    expect(install.requests).toContain('/api/cli/device/code');
    expect(login.stdout).toContain('Git over HTTPS to');
    expect(await plainGitClone(join(outside, 'via-device'))).toBe(0);
  });

  // INVARIANT: against an install too old to say its device tokens cover git,
  // the login leaves git alone. A header the install refuses would count as a
  // failed git sign-in on every fetch and block falling back to a Git token.
  test('a code-approved login from an older install (no scopes) leaves git alone and says so', async () => {
    install.useDeviceLogin();
    install.useOldInstall();
    const login = await ctx.lazy(['login', install.url], { env: env(), cwd: outside });
    expect(login.exitCode).toBe(0);
    expect(login.stdout).toContain('does not grant git access yet');
    expect(await readFile(join(home, 'gitconfig'), 'utf-8')).not.toContain('teams-git');
    expect(install.gitAuth).toHaveLength(0);
  });

  test('--project outside a repo is refused, pointing at lazy clone, before any login starts', async () => {
    const result = await ctx.lazy(['login', install.url, '--project', 'acme/api-server'], { env: env(), cwd: outside });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('lazy clone');
    expect(install.requests).not.toContain('/api/cli/device/code');
  });

  test('lazy clone logs in, clones and binds in one step', async () => {
    const result = await ctx.lazy(['clone', `${install.url}/git/acme/api.git`], { env: env(), cwd: outside });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Bound to acme/api');
    // Not logged in yet, so it logged in first — through the browser, as behind a proxy.
    expect(result.stdout).toContain('Approved as ada@example.com');
    expect(result.stdout).toContain('Git over HTTPS to');

    const clone = join(outside, 'api');
    await stat(join(clone, 'lazy.toml'));
    const index = JSON.parse(await readFile(getCredentialIndexPath(clone), 'utf-8')).credentials;
    expect(index[0].binding.project).toBe('acme/api');
    // The clone's own config never holds the token or an include.
    const cloneConfig = await readFile(join(clone, '.git', 'config'), 'utf-8');
    expect(cloneConfig).not.toContain(TOKEN);
    expect(cloneConfig).not.toContain('include');

    // A second clone reuses the machine's login: no new approval.
    install.requests.length = 0;
    const second = await ctx.lazy(['clone', `${install.url}/git/acme/api.git`, 'second'], { env: env(), cwd: outside });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).not.toContain('Approved as');
    expect(install.requests).not.toContain('/.well-known/lazy-teams');
    await stat(join(outside, 'second', 'lazy.toml'));
  });

  test('lazy clone accepts one full clone URL, with or without .git, and a dir', async () => {
    const first = await ctx.lazy(['clone', `${install.url}/git/acme/api.git`], { env: env(), cwd: outside });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('Bound to acme/api');
    await stat(join(outside, 'api', 'lazy.toml'));
    const second = await ctx.lazy(['clone', `${install.url}/git/acme/api`, 'viaurl'], { env: env(), cwd: outside });
    expect(second.exitCode).toBe(0);
    await stat(join(outside, 'viaurl', 'lazy.toml'));
  });

  // INVARIANT: a URL-looking argument never reaches the task-duplicate form (its "run lazy init" error is misleading),
  // and the retired `<install> <team>/<project>` pair gets the same usage error.
  test('bad URLs and the retired two-argument pair get the usage error', async () => {
    for (const args of [['https://r.example.dev/nope'], ['https://r.example.dev/nope', 'somedir']]) {
      const bad = await ctx.lazy(['clone', ...args], { env: env(), cwd: outside });
      expect(bad.exitCode).not.toBe(0);
      expect(bad.stderr + bad.stdout).toContain('lazy clone https://<install>/git/');
      expect(bad.stderr + bad.stdout).not.toContain('lazy init');
    }
    const pair = await ctx.lazy(['clone', install.url, 'acme/api'], { env: env(), cwd: outside });
    expect(pair.exitCode).not.toBe(0);
    expect(pair.stderr + pair.stdout).toContain('lazy clone https://<install>/git/');
    expect(pair.stderr + pair.stdout).not.toContain('lazy init');
  });

  // INVARIANT: lazy uses the address exactly as typed — an http:// address is never upgraded to https://, no probe,
  // no rewrite — so plain-http installs on a private network or tailnet work like git clone does.
  test('http:// is kept as typed, end to end', async () => {
    // The stub install is plain http (no https listener exists), so success proves nothing was upgraded.
    const out = await ctx.lazy(['clone', `${install.url}/git/acme/api.git`, 'plainhttp'], { env: env(), cwd: outside });
    expect(out.exitCode).toBe(0);
    expect(out.stdout + out.stderr).not.toContain('https://');
    expect(install.requests).toContain('/.well-known/lazy-teams');
    await stat(join(outside, 'plainhttp', 'lazy.toml'));
  });

  // INVARIANT: a login is only ever sent over the scheme it was issued on. A machine logged in
  // over https never sends that token to the http:// address of the same host (an install's
  // own link with the wrong scheme, or a downgrade): `lazy clone http://…` refuses BEFORE any
  // request carries it and names the explicit way to log in over http. A login stored before
  // logins were keyed by origin (host only) counts as https, the only scheme it is safe on.
  for (const [label, name] of [
    ['an https login', (port: number) => `teams:https://127.0.0.1:${port}`],
    ['a host-keyed login from an older lazy', (port: number) => `teams:127.0.0.1:${port}`],
  ] as const) {
    test(`${label} is never sent to the http:// address of the same host`, async () => {
      const machineRoot = join(home, '.lazy', 'teams-machine-login');
      await setCredential(machineRoot, { provider: name(install.server.port!), kind: 'api-key', secret: TOKEN });

      const result = await ctx.lazy(['clone', `${install.url}/git/acme/api.git`], { env: env(), cwd: outside });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`logged in to https://127.0.0.1:${install.server.port}, not ${install.url}`);
      expect(result.stderr).toContain(`lazy login ${install.url}`);
      // Nothing was asked of the install at all — least of all with the token.
      expect(install.requests).toEqual([]);
      await expect(stat(join(outside, 'api'))).rejects.toThrow();
      // The stored login is untouched.
      expect((await readCredentialIndex(machineRoot)).map((e) => e.provider)).toEqual([name(install.server.port!)]);
    });
  }

  /** A git include as an older lazy wrote it (`<host>.inc`), wired into the user-level config. */
  async function seedLegacyInclude(section: string, token: string): Promise<string> {
    const dir = join(daemonBase, 'teams-git');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `127.0.0.1_${install.server.port}.inc`);
    await writeFile(file, `[http "${section}/"]\n\textraHeader =\n\textraHeader = Authorization: Bearer ${token}\n`, { mode: 0o600 });
    await Bun.spawn(['git', 'config', '--global', '--add', 'include.path', file], { env: { ...process.env, ...gitEnv() } }).exited;
    return file;
  }

  // INVARIANT: an include an older `lazy clone http://…` left — sending a token issued over https to
  // the http address — is removed by the next lazy login/logout/clone, which says to revoke the token.
  test('a git include sending an https-issued token to an http address is retired', async () => {
    const https = `https://127.0.0.1:${install.server.port}`;
    const file = await seedLegacyInclude(install.url, fakeTeamsJwt(https));
    const result = await ctx.lazy(['login'], { env: env(), cwd: outside });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Git to ${install.url} was sending a login issued by a different address`);
    await expect(stat(file)).rejects.toThrow();
    expect(await readFile(join(home, 'gitconfig'), 'utf-8')).not.toContain(file);
  });

  // INVARIANT: a bare logout removes the git setup an older lazy wrote for a host-keyed login,
  // whatever scheme that file names — nothing token-bearing survives a logout.
  test('a bare logout removes an older host-keyed login and its git include', async () => {
    const machineRoot = join(home, '.lazy', 'teams-machine-login');
    await setCredential(machineRoot, { provider: `teams:127.0.0.1:${install.server.port}`, kind: 'api-key', secret: 'lz_plain_token' });
    const file = await seedLegacyInclude(install.url, 'lz_plain_token');
    const result = await ctx.lazy(['logout'], { env: env(), cwd: outside });
    expect(result.exitCode).toBe(0);
    await expect(stat(file)).rejects.toThrow();
    expect(await readFile(join(home, 'gitconfig'), 'utf-8')).not.toContain(file);
    expect(await readCredentialIndex(machineRoot)).toEqual([]);
  });

  // The refusal is for the downgrade only: an https address with an http login on file is a new https login.
  test('an http login on file does not stop an https clone', async () => {
    const machineRoot = join(home, '.lazy', 'teams-machine-login');
    await setCredential(machineRoot, { provider: `teams:${install.url}`, kind: 'api-key', secret: TOKEN });
    const result = await ctx.lazy(['clone', `https://127.0.0.1:${install.server.port}/git/acme/api.git`], { env: env(), cwd: outside });
    // The stub has no https listener, so the fresh login fails to connect — but it was attempted.
    expect(result.stderr).not.toContain('a login is only ever sent over the scheme');
    expect(result.stderr).toContain('Could not reach');
  });

  test('lazy clone of a project you are not in is refused before anything is cloned', async () => {
    await ctx.lazy(['login', install.url], { env: env(), cwd: outside });
    const result = await ctx.lazy(['clone', `${install.url}/git/acme/nope.git`], { env: env(), cwd: outside });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no project 'acme/nope'");
    await expect(stat(join(outside, 'nope'))).rejects.toThrow();
  });

  test('lazy clone of a project that lives on a forge says so instead of guessing an address', async () => {
    await ctx.lazy(['login', install.url], { env: env(), cwd: outside });
    const result = await ctx.lazy(['clone', `${install.url}/git/acme/on-forge.git`], { env: env(), cwd: outside });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('lives on a forge');
    await expect(stat(join(outside, 'on-forge'))).rejects.toThrow();
  });

  // INVARIANT: `lazy clone <task_id>` keeps meaning the task form. The
  // repository form is chosen only by a leading address.
  // (An address followed by <team>/<project> is the retired pair: recognised as the repository form only so it
  // gets the usage error instead of reaching the task form.)
  test('the repository form of lazy clone is recognised by shape only', () => {
    expect(isInstallCloneArgs(['https://teams.example.com', 'acme/api'])).toBe(true);
    expect(isInstallCloneArgs(['teams.example.com', 'acme/api.git', 'dir'])).toBe(true);
    expect(isInstallCloneArgs(['localhost:3000', 'acme/api'])).toBe(true);
    expect(isInstallCloneArgs(['--device-name', 'laptop', 'teams.example.com', 'acme/api'])).toBe(true);
    expect(isInstallCloneArgs(['fix-login'])).toBe(false);
    expect(isInstallCloneArgs(['fix-login', '--parent', 'other'])).toBe(false);
    expect(isInstallCloneArgs(['fix-login', '--code', 'x/y'])).toBe(false);
    expect(isInstallCloneArgs(['teams.example.com', 'api'])).toBe(false);
  });
});
