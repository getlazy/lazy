/**
 * Teams core flow 6, end to end: `lazy clone <url>` from an install, the clone
 * binds, `lazy shell <task> --local` opens a checkout of the task's branch, the
 * person commits and pushes with plain git, the task's agent picks the push up
 * on `lazy sync`, and after a member's Accept in Teams the work is on `main` in the install's hosted
 * git — which the person's clone then fetches.
 *
 * NOTE: the stand-in git server lets any bearer push. The real Teams git server
 * decides per pushed ref: any member may push a task branch (`lazy/*`) unless
 * the project explicitly protects it, and other branches follow the project's
 * [protection] config (HostedGit::PushAuthorization; covered by
 * lazy-teams/test/integration/hosted_git_http_test.rb).
 *
 * Real: the lazy CLI (clone side), a real managed daemon on the local driver,
 * and git over HTTP via `git http-backend` behind a Bearer check. Stubbed: the
 * install's login/project-list endpoints and its project rpc route, which
 * forwards to the real daemon.
 */
import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { chmod, mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { storageDirFor } from '../helpers/storage';
import { createTask, withPresentedToken, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { seedFinal } from '../helpers/final';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { relayTeamsRpc } from '../helpers/teams-rpc-proxy-stub';
import { runGit } from '../../src/utils/git';
import { fakeTeamsJwt } from '../helpers/teams-jwt';

// A login token naming the stub install as issuer; set once the install has its port.
let TOKEN = '';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function httpBackend(req: Request, reposDir: string, pathInfo: string): Promise<Response> {
  const url = new URL(req.url);
  const body = new Uint8Array(await req.arrayBuffer());
  const proc = Bun.spawn(['git', 'http-backend'], {
    stdin: body, stdout: 'pipe', stderr: 'ignore',
    env: {
      ...process.env, GIT_PROJECT_ROOT: reposDir, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: pathInfo,
      QUERY_STRING: url.search.replace(/^\?/, ''), REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers.get('content-type') ?? '', CONTENT_LENGTH: String(body.length),
    },
  });
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  let split = -1;
  for (let i = 0; i < out.length - 3; i++) {
    if (out[i] === 13 && out[i + 1] === 10 && out[i + 2] === 13 && out[i + 3] === 10) { split = i; break; }
  }
  const headers = new Headers();
  let status = 200;
  for (const line of new TextDecoder().decode(out.slice(0, split)).split('\r\n')) {
    const [k, ...v] = line.split(':');
    if (k.toLowerCase() === 'status') status = Number.parseInt(v.join(':').trim(), 10);
    else if (k) headers.set(k, v.join(':').trim());
  }
  return new Response(out.slice(split + 4), { status, headers });
}

describe('Teams core flow 6: lazy clone + lazy shell --local', () => {
  let ctx: TestContext;
  let side: string;
  let home: string;
  let daemonBase: string;
  let outside: string;
  let hosted: string;
  let unpin: () => void;
  let install: ReturnType<typeof Bun.serve> | undefined;
  let alice: string;
  let control: DaemonClient;
  let target: string;
  const proxied: string[] = [];

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    side = await realpath(await mkdtemp(join(tmpdir(), 'lazy-flow6-')));
    home = join(side, 'home');
    outside = join(side, 'outside');
    daemonBase = await mkdtemp(join(tmpdir(), 'lzd-flow6-'));
    unpin = pinDaemonBaseDir(daemonBase);
    await mkdir(join(home, '.lazy', 'teams-machine-login'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(home, '.lazy', 'teams-machine-login', 'lazy.toml'), '[credentials]\nbackend = "file"\n');
    await writeFile(join(home, 'gitconfig'), '[user]\n\tname = Ada\n\temail = ada@example.com\n');

    // The install's hosted repository is the daemon's origin.
    const reposDir = join(side, 'repos');
    hosted = join(reposDir, 'acme', 'lazy-toy.git');
    await mkdir(join(reposDir, 'acme'), { recursive: true });
    await runGit(['init', '-q', '--bare', '-b', 'main', hosted], { cwd: side });
    // http-backend only serves pushes when the repository opts in (the install's git server does).
    await git(hosted, 'config', 'http.receivepack', 'true');
    const branch = await git(ctx.root, 'rev-parse', '--abbrev-ref', 'HEAD');
    await git(ctx.root, 'remote', 'add', 'origin', hosted);
    await git(ctx.root, 'push', '-q', 'origin', `${branch}:main`);
    const controlConfig = join(side, 'lazy.toml');
    await writeFile(controlConfig, await readFile(join(ctx.root, 'lazy.toml'), 'utf8'));
    await ctx.restartDaemon({
      LAZY_TEST_FORCE_MANAGED: '1',
      LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root),
      LAZY_MANAGED_CONFIG_PATH: controlConfig,
    });
    const tcp = getDaemonTcpTarget(ctx.root), token = readToken(ctx.root);
    if (!tcp || !token) throw new Error('test daemon did not record a TCP target and token');
    control = DaemonClient.fromTarget(tcp, token);
    await control.rpc('putUserCredential', ctx.root, { userId: 'ada@example.com', kind: 'oauth', token: 'sk-ant-oat01-test' });
    target = tcp;
    alice = ((await control.rpc('mintActorToken', ctx.root, { kind: 'user', email: 'ada@example.com', name: 'Ada' })) as { token: string }).token;

    install = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(req) {
        const relayed = await relayTeamsRpc(req, {
          project: 'acme/lazy-toy', cliToken: TOKEN, projectRoot: ctx.root,
          daemonTarget: () => target, memberToken: () => alice, proxied,
        });
        if (relayed) return relayed;
        const url = new URL(req.url);
        const authed = req.headers.get('authorization') === `Bearer ${TOKEN}`;
        if (url.pathname === '/.well-known/lazy-teams') return Response.json({ login: 'loopback' });
        if (url.pathname === '/api/cli/projects') {
          if (!authed) return Response.json({ error: 'unauthorized' }, { status: 401 });
          return Response.json({ projects: [{ id: '11', slug: 'acme/lazy-toy', name: 'Toy', team: 'Acme', hosted_repo_url: `${url.origin}/git/acme/lazy-toy.git` }] });
        }
        if (url.pathname.startsWith('/git/')) {
          if (!authed) return new Response('auth required\n', { status: 401, headers: { 'www-authenticate': 'Basic realm="Lazy Teams"' } });
          return httpBackend(req, reposDir, url.pathname.slice('/git'.length));
        }
        return new Response('not found', { status: 404 });
      },
    });

    TOKEN = fakeTeamsJwt(`http://127.0.0.1:${install.port}`);

    // The browser: plays a person who approves the login.
    const binDir = join(home, 'bin');
    await mkdir(binDir);
    const browser = join(binDir, 'browser.ts');
    await writeFile(browser, `
      const u = new URL(process.argv[2]);
      await fetch('http://127.0.0.1:' + u.searchParams.get('loopback_port') + '/callback', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ state: u.searchParams.get('state'), token: '${TOKEN}', email: 'ada@example.com' }),
      });
    `);
    for (const name of ['open', 'xdg-open']) {
      await writeFile(join(binDir, name), `#!/bin/sh\nexec "${process.execPath}" "${browser}" "$1"\n`);
      await chmod(join(binDir, name), 0o755);
    }
  });

  afterEach(async () => {
    install?.stop(true);
    await ctx.cleanup();
    unpin();
    await rm(side, { recursive: true, force: true });
    await rm(daemonBase, { recursive: true, force: true });
  });

  const gitEnv = () => ({ HOME: home, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  const personEnv = () => ({
    ...gitEnv(), LAZY_DAEMON_BASE_DIR: daemonBase, LAZY_TEST: '', LAZY_IS_DAEMON: '',
    LAZY_FORCE_TTY: '1', DISPLAY: ':0', PATH: `${join(home, 'bin')}:${process.env.PATH}`,
  });
  const gitAsPerson = async (cwd: string, ...args: string[]) => {
    const p = Bun.spawn(['git', ...args], { cwd, env: { ...process.env, ...gitEnv() }, stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    if ((await p.exited) !== 0) throw new Error(`git ${args.join(' ')} failed: ${err}`);
    return out.trim();
  };

  // INVARIANT: the whole local-testing loop works through a Teams install: clone
  // binds, the task branch is visible, `shell --local` checks it out tracking the
  // install's branch, a plain `git push` reaches the task via `lazy sync`, and a
  // task accepted by a member in Teams (the protected default branch refuses a
  // plain accept from the clone) has its work on `main`, fetchable by the clone.
  test('clone, shell --local, push back, sync, accept, fetch main', async () => {
    const taskId = await createTask(ctx, 'Flow six', 'Some work', { token: alice });
    const start = await withPresentedToken(ctx, alice, () => ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expect(start.exitCode).toBe(0);
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);
    const branch = (JSON.parse((await ctx.lazy(['show', taskId, '--json'])).stdout) as { session: { git_branch: string } }).session.git_branch;
    let onOrigin = '';
    for (let i = 0; i < 60 && !onOrigin; i++) {
      onOrigin = (await runGit(['ls-remote', hosted, `refs/heads/${branch}`], { cwd: side })).stdout.trim();
      if (!onOrigin) await Bun.sleep(500);
    }
    expect(onOrigin).toContain(branch);

    // 1. lazy clone <url>: logs in, clones, binds.
    const url = `http://127.0.0.1:${install!.port}/git/acme/lazy-toy.git`;
    const cloned = await ctx.lazy(['clone', url], { env: personEnv(), cwd: outside });
    if (cloned.exitCode !== 0) throw new Error(cloned.stderr + cloned.stdout);
    expect(cloned.stdout).toContain('Bound to acme/lazy-toy');
    const clone = join(outside, 'lazy-toy');
    // The task branch is on the install and fetchable from the clone.
    expect(await gitAsPerson(clone, 'ls-remote', 'origin', `refs/heads/${branch}`)).toContain(branch);

    // 2. lazy shell <task> --local (non-interactive command in place of a shell).
    const shell = await ctx.lazy(['shell', taskId, '--local', '--', 'git', 'rev-parse', '--abbrev-ref', '@{u}'], { env: personEnv(), cwd: clone });
    if (shell.exitCode !== 0) throw new Error(shell.stderr + shell.stdout);
    expect(shell.stdout.trim()).toBe(`origin/${branch}`);
    const checkout = (await readdir(outside)).map((d) => join(outside, d)).find((d) => d.startsWith(`${clone}-`));
    if (!checkout) throw new Error('shell --local made no <clone>-<task-code> checkout beside the clone');
    expect(shell.stderr).toContain(checkout);

    // 3. Test locally, commit, push back with plain git.
    await writeFile(join(checkout, 'mac.txt'), 'built on the mac\n');
    await gitAsPerson(checkout, 'add', '.');
    await gitAsPerson(checkout, 'commit', '-q', '-m', 'tested on the mac');
    const pushed = await gitAsPerson(checkout, 'rev-parse', 'HEAD');
    await gitAsPerson(checkout, 'push', '-q');

    // 3b. Accept before the sync must refuse: the push is on origin only. The
    // default branch is also protected (managed default), and the sync pointer
    // answers first because it is the one the clone can act on.
    await seedFinal(ctx, taskId);
    const early = await ctx.lazy(['accept', taskId, '--yes'], { env: personEnv(), cwd: clone });
    expect(early.exitCode).not.toBe(0);
    expect(early.stderr + early.stdout).toContain('lazy sync');
    expect(proxied).toContain('acceptTask'); // the clone's accept reached the daemon through the install

    // 4. The agent picks it up on sync.
    const sync = await ctx.lazyMocked(['sync', taskId], MOCK_CLAUDE_SUCCESS, { env: personEnv(), cwd: clone });
    if (sync.exitCode !== 0) throw new Error(sync.stderr + sync.stdout);
    expect(proxied).toContain('syncTask'); // it went through the install's rpc route, not a local daemon
    await ctx.lazy(['wait', taskId]);
    expect((await runGit(['merge-base', '--is-ancestor', pushed, branch], { cwd: ctx.root })).exitCode).toBe(0);

    // 5a. A plain `lazy accept` from the bound clone is refused on the protected default branch, pointing at Teams.
    await seedFinal(ctx, taskId);
    const fromClone = await ctx.lazy(['accept', taskId, '--yes'], { env: personEnv(), cwd: clone });
    expect(fromClone.exitCode).not.toBe(0);
    expect(fromClone.stderr + fromClone.stdout).toContain('press Accept on this task in Lazy Teams');

    // 5b. Accept the way Teams' Accept does it: the member's own token with
    // the browser marker. The work lands on the install's main, and the
    // clone fetches it.
    const accepted = await DaemonClient.fromTarget(target, alice).rpc('acceptTask', ctx.root, { taskId, actor: 'human', memberAccept: true }) as { status: string };
    expect(accepted.status).toBe('merged');
    await gitAsPerson(clone, 'pull', '-q', 'origin', 'main');
    expect(await readFile(join(clone, 'mac.txt'), 'utf8')).toBe('built on the mac\n');
  }, 240_000);

  // INVARIANT: a clone made into a SYMLINKED absolute directory is bound at the
  // real path, because every command inside the clone resolves its cwd. The temp
  // dir is deliberately not realpath'd here; that would hide the bug.
  test('clone into a symlinked absolute dir binds the real path', async () => {
    const real = join(side, 'real-parent');
    const link = join(side, 'link-parent');
    await mkdir(real, { recursive: true });
    await Bun.spawn(['ln', '-s', real, link]).exited;
    const url = `http://127.0.0.1:${install!.port}/git/acme/lazy-toy.git`;
    const cloned = await ctx.lazy(['clone', url, join(link, 'c')], { env: personEnv(), cwd: outside });
    if (cloned.exitCode !== 0) throw new Error(cloned.stderr + cloned.stdout);
    const status = await ctx.lazy(['login'], { env: personEnv(), cwd: join(real, 'c') });
    expect(status.stdout).toContain('This clone is bound to');
  }, 120_000);
});
