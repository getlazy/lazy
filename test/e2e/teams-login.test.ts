/**
 * e2e: `lazy login` / `lazy logout` against a stub Teams install.
 *
 * The real CLI, the real credential store, the real file backend — the only
 * thing played by a stand-in is the install itself, because the thing under test
 * is what this machine does with what an install says, not what Rails says. The
 * Rails half is proven on its own side (`test/system/device_approval_test.rb`
 * and the two controller suites).
 *
 * What it pins:
 *   - the device-authorization round trip, ending with a record in the store —
 *     credential in the backend, binding in the non-secret index;
 *   - `--project` skipping the prompt, and matching EXACTLY;
 *   - a login with no terminal and no `--project` being an ERROR rather than a
 *     guess, and refusing BEFORE it asks the install for anything;
 *   - a bare `lazy login` printing the binding and starting nothing;
 *   - `lazy logout` removing the record, and being honest when there is none.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { getCredentialIndexPath, getCredentialsPath, getDaemonDir } from '../../src/daemon/paths';
import { fakeTeamsJwt } from '../helpers/teams-jwt';
import { setCredential } from '../../src/credentials/store';
import { writePid, writeWebPort, generateToken } from '../../src/daemon/lifecycle';
import { startForeignProcess } from '../helpers/foreign-process';

const APPROVED_TOKEN = 'lz_cli_token_for_the_clone_wxyz';

interface Stub {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  /** Make the install say it wants the loopback (browser) login. */
  useLoopback: () => void;
  /** Flip to make the next poll answer "approved". */
  approve: () => void;
  /** Make the project list fail, to reach an ending past approval. */
  failProjects: () => void;
  /** Play a look-alike: hand out ANOTHER install's approval page with the code. */
  useForeignVerificationUri: () => void;
  /** Every path the CLI actually asked for, in order. */
  requests: string[];
  projects: Array<{ id: string; slug: string; name: string; team: string }>;
}

/** The two device endpoints, approved at once — for a proxy stand-in that lets them through. */
async function stubDeviceFlow(req: Request): Promise<Response> {
  const url = new URL(req.url);
  await req.text();
  if (url.pathname === '/api/cli/device/code') {
    return Response.json({
      user_code: 'KTPX-9QFD', device_code: 'device-code-0123456789',
      verification_uri: `${url.origin}/device`, interval: 1, expires_in: 900,
    }, { status: 201 });
  }
  if (url.pathname === '/api/cli/device/token') {
    return Response.json({ status: 'approved', token: APPROVED_TOKEN, user: { email: 'ada@example.com' }, scopes: ['cli', 'git'] });
  }
  return new Response('not found', { status: 404 });
}

function startStub(): Stub {
  let approved = false;
  let projectsFail = false;
  let loopback = false;
  let foreignVerification = false;
  const requests: string[] = [];
  const projects = [
    { id: '11', slug: 'acme/api-server', name: 'API server', team: 'Acme' },
    { id: '12', slug: 'acme/web', name: 'Web', team: 'Acme' },
  ];

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname);

      if (url.pathname === '/.well-known/lazy-teams') {
        return loopback ? Response.json({ login: 'loopback' }) : new Response('not found', { status: 404 });
      }

      if (url.pathname === '/api/cli/device/code') {
        await req.text();
        return Response.json({
          user_code: 'KTPX-9QFD',
          device_code: 'device-code-0123456789',
          verification_uri: foreignVerification ? 'https://real-install.example.com/device' : `${url.origin}/device`,
          verification_uri_complete: `${url.origin}/device?code=KTPX-9QFD`,
          // One second, so the suite does not spend a real polling interval
          // waiting for a stand-in to change its mind.
          interval: 1,
          expires_in: 900,
        }, { status: 201 });
      }

      if (url.pathname === '/api/cli/device/token') {
        await req.text();
        if (!approved) return Response.json({ status: 'pending' });
        return Response.json({
          status: 'approved',
          token: APPROVED_TOKEN,
          user: { email: 'ada@example.com' },
          // What a current install says its code-approved tokens may do.
          scopes: ['cli', 'git'],
        });
      }

      if (url.pathname === '/api/cli/projects') {
        if (projectsFail) return new Response('boom', { status: 500 });
        if (!['Bearer ' + APPROVED_TOKEN, 'Bearer ' + fakeTeamsJwt(url.origin)].includes(req.headers.get('authorization') ?? '')) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        return Response.json({ projects });
      }

      return new Response('not found', { status: 404 });
    },
  });

  return {
    server,
    url: `http://127.0.0.1:${server.port}`,
    useLoopback: () => { loopback = true; },
    approve: () => { approved = true; },
    failProjects: () => { projectsFail = true; },
    useForeignVerificationUri: () => { foreignVerification = true; },
    requests,
    projects,
  };
}

describe('lazy login', () => {
  let ctx: TestContext;
  let tmpHome: string;
  let daemonBase: string;
  let unpin: () => void;
  let stub: Stub;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-login-home-'));
    // The credential store lives under the daemon base dir. Pin it in BOTH the
    // CLI's environment and this process, or the test reads a different file
    // from the one the command wrote — and passes or fails for the wrong reason.
    daemonBase = await mkdtemp(join(tmpdir(), 'lzd-login-'));
    unpin = pinDaemonBaseDir(daemonBase);
    // The `file` backend, explicitly: this suite must behave identically on a
    // Mac with a Keychain and in a container with no secret service at all.
    const configPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(configPath, 'utf-8');
    await writeFile(configPath, `${toml}\n[credentials]\nbackend = "file"\n`);

    // The machine-level login store (keyed by a fixed per-user path) uses the
    // file backend too.
    await mkdir(join(tmpHome, '.lazy', 'teams-machine-login'), { recursive: true });
    await writeFile(join(tmpHome, '.lazy', 'teams-machine-login', 'lazy.toml'), `[credentials]\nbackend = "file"\n`);

    stub = startStub();
    // A human is at the browser the moment the code is printed, so the stub says
    // yes from the first poll onwards.
    stub.approve();
  });

  afterEach(async () => {
    stub.server.stop(true);
    await ctx.cleanup();
    // Unpin AFTER cleanup, never before — see the harness rules.
    unpin();
    await rm(tmpHome, { recursive: true, force: true });
    await rm(daemonBase, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}) => ({
    HOME: tmpHome,
    LAZY_DAEMON_BASE_DIR: daemonBase,
    // Never the real ~/.gitconfig: machine-level login writes the user-level one.
    GIT_CONFIG_GLOBAL: join(tmpHome, 'gitconfig'),
    ...extra,
  });

  /** With a TTY forced, so the pick-list path is reachable. */
  const interactiveEnv = () => env({ LAZY_FORCE_TTY: '1', LAZY_PROMPT_DEFAULTS: 'accept' });

  async function readIndex(): Promise<Array<Record<string, unknown>>> {
    const raw = await readFile(getCredentialIndexPath(ctx.root), 'utf-8');
    return JSON.parse(raw).credentials;
  }

  test('a login stores the token in the backend and the binding in the index', async () => {
    const result = await ctx.lazy(['login', stub.url, '--project', 'acme/api-server'], { env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('KTPX-9QFD');
    expect(result.stdout).toContain('Approved as ada@example.com');

    // The PLAIN address and the typed code are the instruction; the prefilled
    // link is offered after it (RFC 8628 §5.3). A completed URL is the phishing
    // shape of this flow, so it must not be the thing the person is told to open.
    const instruction = result.stdout.split('\n').find((line) => line.includes('Open '))!;
    expect(instruction).toContain(`${stub.url}/device`);
    expect(instruction).not.toContain('code=KTPX-9QFD');
    expect(result.stdout).toContain('or, with the code already in it');
    expect(result.stdout).toContain('Bound to acme/api-server');

    // SECURITY: the token comes from the install to this machine and is never
    // printed on the way through.
    expect(result.stdout).not.toContain(APPROVED_TOKEN);

    const index = await readIndex();
    expect(index).toHaveLength(1);
    expect(index[0].provider).toBe(`teams:http://127.0.0.1:${stub.server.port}`);
    expect(index[0].binding).toEqual({
      teams_url: stub.url,
      project: 'acme/api-server',
      project_id: '11',
      bound_at: expect.any(String),
    });
    // The index is the NON-SECRET half. The secret is not in it.
    expect(JSON.stringify(index)).not.toContain(APPROVED_TOKEN);

    const secrets = JSON.parse(await readFile(getCredentialsPath(ctx.root), 'utf-8'));
    expect(secrets[`teams:http://127.0.0.1:${stub.server.port}`]).toBe(APPROVED_TOKEN);
  });

  // INVARIANT: a clone with a live local daemon is never bound — that daemon
  // would keep running against the local store, unseen in a bound clone and
  // unreachable after logout. Refused BEFORE the install is asked for a token.
  test('a login is refused while a local daemon is running, before any token is minted', async () => {
    // A live daemon as the lock-less fallback sees one: token, port marker and
    // a live PID — a stand-in process, never this test runner, which the
    // harness's daemon reaper would otherwise kill.
    const holder = await startForeignProcess(tmpHome, 'lazy-daemon-stand-in');
    let result;
    try {
      generateToken(ctx.root);
      writeWebPort(ctx.root, 45678);
      writePid(ctx.root, holder.pid);
      result = await ctx.lazy(['login', stub.url, '--project', 'acme/api-server'], { env: env() });
    } finally {
      holder.kill();
    }

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('lazy daemon stop');
    expect(stub.requests).not.toContain('/api/cli/device/code');
  });

  test('--project skips the prompt and is matched exactly', async () => {
    // With no TTY there is no prompt to skip past, so this also proves the flag
    // alone is enough to complete a login.
    const result = await ctx.lazy(['login', stub.url, '-p', 'acme/web'], { env: env() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Bound to acme/web');
    expect(result.stdout).not.toContain('Which project');

    const index = await readIndex();
    expect((index[0].binding as Record<string, unknown>).project_id).toBe('12');
  });

  test('a --project nobody is a member of is refused, listing what there is', async () => {
    const result = await ctx.lazy(['login', stub.url, '--project', 'globex/thing'], { env: env() });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no project 'globex/thing'");
    expect(result.stderr).toContain('acme/api-server');
    // INVARIANT: an ending past approval says a token was created. Approval mints
    // a real CLI-scoped token, so a login that stops after it and stays silent
    // leaves a live credential nobody holds and nobody was told about.
    expect(result.stderr).toContain('Settings → API tokens');
    expect(result.stderr).toContain('had already been approved');
  });

  // The same invariant from the other side: the failure is the install's, not
  // the person's, and the token it already minted is still live.
  test('a failure after approval still names the token it left behind', async () => {
    stub.failProjects();

    const result = await ctx.lazy(['login', stub.url, '--project', 'acme/web'], { env: env() });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('had already been approved');
    expect(result.stderr).toContain('Settings → API tokens');

    // And nothing was written, so the clone is unbound rather than half-bound.
    const where = await ctx.lazy(['login'], { env: env() });
    expect(where.stdout).toContain('not logged in');
  });

  // INVARIANT: the project is chosen explicitly, never inferred. Two clones of
  // one repository can belong to different projects, so a non-interactive login
  // without --project must be an ERROR — and must refuse before creating
  // anything on the install, or it would leave a live token nobody holds.
  test('a non-interactive login without --project errors instead of guessing', async () => {
    const result = await ctx.lazy(['login', stub.url], { env: env() });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--project');
    expect(result.stderr).toContain('never inferred from the git remote');
    expect(stub.requests).toEqual([]);
  });

  test('with a terminal, the project is chosen from a pick-list', async () => {
    const result = await ctx.lazy(['login', stub.url], { env: interactiveEnv() });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Which project is this clone?');
    expect(result.stdout).toContain('acme/api-server');
    expect(result.stdout).toContain('acme/web');
    // LAZY_PROMPT_DEFAULTS takes the first option.
    expect(result.stdout).toContain('Bound to acme/api-server');
  });

  test('a bare `lazy login` prints the binding and starts nothing', async () => {
    const unbound = await ctx.lazy(['login'], { env: env() });
    expect(unbound.exitCode).toBe(0);
    expect(unbound.stdout).toContain('not logged in');
    expect(stub.requests).toEqual([]);

    await ctx.lazy(['login', stub.url, '--project', 'acme/api-server'], { env: env() });
    const asked = stub.requests.length;

    const bound = await ctx.lazy(['login'], { env: env() });
    expect(bound.exitCode).toBe(0);
    expect(bound.stdout).toContain('acme/api-server');
    expect(bound.stdout).toContain(stub.url);
    // Reporting is not logging in: no second round trip, and no second record.
    expect(stub.requests).toHaveLength(asked);
    expect(await readIndex()).toHaveLength(1);
  });

  // INVARIANT: one clone, one project. A second login REBINDS; it never leaves
  // the clone holding two logins, which lazy would then refuse to act on at all.
  //
  // Deliberately against a SECOND install: two logins to the same host share one
  // credential name, so the store would overwrite the first for free and this
  // would pass without the rebind ever being implemented.
  test('logging in to another install replaces the binding rather than adding a second', async () => {
    const other = startStub();
    other.approve();

    try {
      await ctx.lazy(['login', stub.url, '--project', 'acme/api-server'], { env: env() });
      const again = await ctx.lazy(['login', other.url, '--project', 'acme/web'], { env: env() });

      expect(again.exitCode).toBe(0);
      expect(again.stdout).toContain('already bound to acme/api-server');

      const index = await readIndex();
      expect(index).toHaveLength(1);
      expect((index[0].binding as Record<string, unknown>).project).toBe('acme/web');
      expect((index[0].binding as Record<string, unknown>).teams_url).toBe(other.url);

      // And the first install's token is gone from the backend with it — a
      // logout that left a live secret behind would be a credential nothing
      // mentions.
      const secrets = JSON.parse(await readFile(getCredentialsPath(ctx.root), 'utf-8'));
      expect(Object.keys(secrets)).toEqual([`teams:http://127.0.0.1:${other.server.port}`]);
    } finally {
      other.server.stop(true);
    }
  });

  test('logout removes the record and is honest when there is none', async () => {
    await ctx.lazy(['login', stub.url, '--project', 'acme/api-server'], { env: env() });

    const out = await ctx.lazy(['logout'], { env: env() });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('unbound from acme/api-server');
    // Deleting the record is not revoking the token, and the CLI says which of
    // the two just happened.
    expect(out.stdout).toContain('revoke it at Settings');

    const secrets = JSON.parse(await readFile(getCredentialsPath(ctx.root), 'utf-8'));
    expect(JSON.stringify(secrets)).not.toContain(APPROVED_TOKEN);

    const again = await ctx.lazy(['logout'], { env: env() });
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain('not logged in');
  });

  // INVARIANT: login, logout and a bound clone's commands never refuse over a
  // missing local store path. After a store is handed to Lazy Teams the runbook
  // has the operator move it away FIRST, then log in; refusing here would push
  // them to put the store back — a second writer on a store Teams now owns.
  test('login, logout and a bound clone work after the local store was moved away', async () => {
    const configPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(configPath, 'utf-8');
    const moved = toml.replace(/external_path = "[^"]*"/, `external_path = "${join(tmpHome, 'moved-away')}"`);
    expect(moved).not.toBe(toml);
    await writeFile(configPath, moved);
    const preflightEnv = () => env({ LAZY_FORCE_PREFLIGHT: '1' });

    const login = await ctx.lazy(['login', stub.url, '--project', 'acme/api-server'], { env: preflightEnv() });
    expect(login.stderr).not.toContain('storage.external_path');
    expect(login.exitCode).toBe(0);
    expect(JSON.stringify(await readIndex())).toContain('acme/api-server');

    // A bound clone's ordinary command goes to Teams (the stub has no RPC, so
    // it may fail) — but never on the local path check.
    const list = await ctx.lazy(['list'], { env: preflightEnv() });
    expect(list.stderr).not.toContain('storage.external_path');

    const logout = await ctx.lazy(['logout'], { env: preflightEnv() });
    expect(logout.stderr).not.toContain('storage.external_path');
    expect(logout.exitCode).toBe(0);
  });

  // An address that is A web server but not a Teams install is the likeliest
  // typo — a company homepage, a proxy's error page. The failure must name the
  // address and what was expected, not surface a JSON parse error from five
  // frames down.
  test('an address that answers HTML is refused naming the address', async () => {
    const notTeams = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('<html><body>Hello</body></html>', {
        headers: { 'content-type': 'text/html' },
      }),
    });

    try {
      const result = await ctx.lazy(
        ['login', `http://127.0.0.1:${notTeams.port}`, '--project', 'acme/web'],
        { env: env() },
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`127.0.0.1:${notTeams.port}`);
      expect(result.stderr).toContain('not JSON');
      expect(result.stderr).toContain('Lazy Teams install');
    } finally {
      notTeams.stop(true);
    }
  });

  // INVARIANT: behind an authenticating proxy the CLI makes NO request the proxy
  // could refuse before it holds a token: no device code, no polling. The browser
  // delivers the token to a loopback listener, state-checked, and it is never printed.
  describe('loopback login (install behind an authenticating proxy)', () => {
    let binDir: string;
    let openedFile: string;

    beforeEach(async () => {
      stub.useLoopback();
      binDir = await mkdtemp(join(tmpdir(), 'lazy-login-bin-'));
      openedFile = join(binDir, 'opened-url');
      // A stand-in for the platform's browser opener: it records the URL it was
      // given, and this test then plays the browser.
      for (const name of ['open', 'xdg-open']) {
        await writeFile(join(binDir, name), `#!/bin/sh\nprintf '%s' "$1" > "${openedFile}"\n`);
        await chmod(join(binDir, name), 0o755);
      }
    });

    afterEach(async () => {
      await rm(binDir, { recursive: true, force: true });
    });

    // The browser half: a form POST to the loopback listener, token in the BODY.
    const post = (port: string | null, fields: Record<string, string>, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}/callback`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(fields),
      });

    async function waitForOpenedUrl(): Promise<URL> {
      for (let i = 0; i < 200; i++) {
        try {
          const text = await readFile(openedFile, 'utf-8');
          if (text) return new URL(text);
        } catch {
          // Not written yet: the CLI has not opened the browser.
        }
        await Bun.sleep(100);
      }
      throw new Error('the CLI never opened the approval URL');
    }

    const loopbackEnv = () => env({
      LAZY_FORCE_TTY: '1',
      DISPLAY: ':0',
      PATH: `${binDir}:${process.env.PATH}`,
    });

    test('a denial in the browser ends the login at once, with no token stored', async () => {
      const login = ctx.lazy(['login', stub.url, '--project', 'acme/api-server'], { env: loopbackEnv() });
      const approval = await waitForOpenedUrl();
      const port = approval.searchParams.get('loopback_port');
      const state = approval.searchParams.get('state')!;
      await post(port, { state, error: 'denied' });

      const result = await login;
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('denied');
      expect(JSON.stringify(await readIndex().catch(() => []))).not.toContain('acme/api-server');
    });

    test('--device uses the device flow even when the install asks for the loopback one', async () => {
      const result = await ctx.lazy(['login', stub.url, '--device', '--project', 'acme/api-server'], { env: env() });
      expect(result.exitCode).toBe(0);
      expect(stub.requests).toContain('/api/cli/device/code');
    });

    test('a login in a clone retires the clone-level Bearer include an older login left', async () => {
      // What a login from before machine-level git auth wrote into this clone.
      const legacyPath = join(getDaemonDir(ctx.root), 'teams-git-auth.inc');
      await mkdir(join(legacyPath, '..'), { recursive: true });
      await writeFile(legacyPath, '[http "http://127.0.0.1/"]\n\textraHeader = Authorization: Bearer old\n');
      await ctx.git('config', '--local', '--add', 'include.path', legacyPath);

      const again = await ctx.lazy(['login', stub.url, '--device', '--project', 'acme/api-server'], { env: env() });
      expect(again.exitCode).toBe(0);
      expect((await ctx.git('config', '--local', '--get-all', 'include.path')).stdout.trim()).toBe('');
      await expect(stat(legacyPath)).rejects.toThrow();
      // Git auth is machine-level now, for a code-approved login too.
      expect(await readFile(join(tmpHome, 'gitconfig'), 'utf-8')).toContain('teams-git');
    });

    // INVARIANT: a login is kept only when the token's `iss` is the origin typed. A look-alike
    // install can relay the state to the real install's approval page, whose genuine token then
    // arrives here; storing it under the look-alike's address would send it there at once.
    test('a token issued by another install is refused, never stored and never sent', async () => {
      const login = ctx.lazy(['login', stub.url, '--project', 'acme/api-server'], { env: loopbackEnv() });
      const approval = await waitForOpenedUrl();
      const realToken = fakeTeamsJwt('https://real-install.example.com');
      await post(approval.searchParams.get('loopback_port'), {
        state: approval.searchParams.get('state')!, token: realToken, email: 'ada@example.com',
      }, { origin: 'null' });

      const result = await login;
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('approved by https://real-install.example.com');
      expect(result.stderr).toContain(`not by ${stub.url}`);
      expect(result.stdout + result.stderr).not.toContain(realToken);
      expect(stub.requests).not.toContain('/api/cli/projects');
      expect(JSON.stringify(await readIndex().catch(() => []))).not.toContain('acme/api-server');
      expect(await readFile(join(tmpHome, 'gitconfig'), 'utf-8').catch(() => '')).not.toContain('teams-git');
    });

    test('a loopback answer that is not a signed token is refused', async () => {
      const login = ctx.lazy(['login', stub.url, '--project', 'acme/api-server'], { env: loopbackEnv() });
      const approval = await waitForOpenedUrl();
      await post(approval.searchParams.get('loopback_port'), {
        state: approval.searchParams.get('state')!, token: 'lz_not_a_jwt', email: 'ada@example.com',
      });
      const result = await login;
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('not a token it signed');
      expect(stub.requests).not.toContain('/api/cli/projects');
    });

    test('the browser hands the token to the listener; wrong state is refused; nothing is printed', async () => {
      const LOOPBACK_TOKEN = fakeTeamsJwt(stub.url);
      const login = ctx.lazy(['login', stub.url, '--project', 'acme/api-server'], { env: loopbackEnv() });
      const approval = await waitForOpenedUrl();

      expect(approval.pathname).toBe('/cli/authorize');
      const port = approval.searchParams.get('loopback_port');
      const state = approval.searchParams.get('state')!;
      expect(approval.searchParams.get('device_name')).toBeTruthy();
      expect(state.length).toBeGreaterThanOrEqual(32);

      const fields = (s: string) => ({ state: s, token: LOOPBACK_TOKEN, email: 'ada@example.com' });

      // INVARIANT: the token never travels in a URL. A GET carrying it is refused outright.
      expect((await fetch(`http://127.0.0.1:${port}/callback?${new URLSearchParams(fields(state))}`)).status).toBe(404);
      // A post from some other origin is refused; a wrong state is refused; neither ends the wait.
      expect((await post(port, fields(state), { origin: 'https://evil.example.com' })).status).toBe(403);
      expect((await post(port, fields('not-the-state'))).status).toBe(400);
      expect((await post(port, fields(state), { origin: stub.url })).status).toBe(200);

      const result = await login;
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain(LOOPBACK_TOKEN);
      expect(result.stderr).not.toContain(LOOPBACK_TOKEN);
      expect(JSON.stringify(await readIndex())).toContain('acme/api-server');

      // INVARIANT: git to the install carries the token machine-wide through a
      // 0600 include — never in .git/config, never in the user-level config itself.
      const userConfigPath = join(tmpHome, 'gitconfig');
      const gitConfig = await readFile(join(ctx.root, '.git', 'config'), 'utf-8');
      expect(gitConfig).not.toContain(LOOPBACK_TOKEN);
      expect(gitConfig).not.toContain('include');
      const userConfig = await readFile(userConfigPath, 'utf-8');
      expect(userConfig).not.toContain(LOOPBACK_TOKEN);
      const includeFile = userConfig.match(/path = (.+)/)![1].trim();
      expect((await stat(includeFile)).mode & 0o777).toBe(0o600);
      expect(await readFile(includeFile, 'utf-8')).toContain(`extraHeader = Authorization: Bearer ${LOOPBACK_TOKEN}`);
      // Login says out loud which user-level config it changed.
      expect(result.stdout).toContain(userConfigPath);

      // A bare logout in the clone unbinds it and leaves the machine logged in…
      const unbind = await ctx.lazy(['logout'], { env: env() });
      expect(unbind.exitCode).toBe(0);
      expect(unbind.stdout).toContain(`lazy logout ${stub.url}`);
      await stat(includeFile);

      // …and `lazy logout <url>` takes the include entry and its file away.
      const logout = await ctx.lazy(['logout', stub.url], { env: env() });
      expect(logout.exitCode).toBe(0);
      expect(logout.stdout).toContain(userConfigPath);
      expect(await readFile(userConfigPath, 'utf-8')).not.toContain(includeFile);
      await expect(stat(includeFile)).rejects.toThrow();

      // Only the description and the Bearer-authenticated call: never a device code or a poll.
      expect(stub.requests).not.toContain('/api/cli/device/code');
      expect(stub.requests).not.toContain('/api/cli/device/token');
    });
  });

  // INVARIANT: a device login only ever sends the person to the address they typed. A look-alike
  // install can hand out the REAL install's approval page and a code it got there, then poll for
  // the token itself; refusing the foreign address before printing it ends that before approval.
  test('a device approval address on another origin is refused before it is shown', async () => {
    stub.useForeignVerificationUri();
    const result = await ctx.lazy(['login', stub.url, '--project', 'acme/api-server'], { env: env() });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('https://real-install.example.com/device');
    expect(result.stderr).toContain('different address');
    expect(result.stdout).not.toContain('KTPX-9QFD');
    expect(stub.requests).not.toContain('/api/cli/device/token');
  });

  // INVARIANT: a clone an older lazy bound at an http:// address while holding a token issued over
  // https never sends it: every command refuses before any request, naming the fix.
  test('a clone holding a token issued by another origin refuses to use it', async () => {
    const https = `https://127.0.0.1:${stub.server.port}`;
    await setCredential(ctx.root, {
      provider: `teams:127.0.0.1:${stub.server.port}`, kind: 'api-key', secret: fakeTeamsJwt(https),
      binding: { teams_url: stub.url, project: 'acme/api-server', project_id: '11', bound_at: new Date().toISOString() },
    });
    stub.requests.length = 0;
    // LAZY_TEST bypasses the bound-clone path; unset it so `list` really resolves the login.
    const result = await ctx.lazy(["list"], { env: env({ LAZY_TEST: "", LAZY_IS_DAEMON: "" }) });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(`issued by ${https} but the clone is bound to ${stub.url}`);
    expect(stub.requests).toEqual([]);
  });

  test('an install that does not serve the login description (older) uses the device flow', async () => {
    const result = await ctx.lazy(['login', stub.url, '--project', 'acme/api-server'], { env: env() });
    expect(result.exitCode).toBe(0);
    expect(stub.requests).toContain('/.well-known/lazy-teams');
    expect(stub.requests).toContain('/api/cli/device/code');
  });

  // INVARIANT: a sign-in proxy in front of Teams is NAMED, never blamed on the
  // address. The address is right; the proxy answered the CLI's anonymous POST
  // with its own HTML page (200, or a redirect to a sign-in page), and "check the
  // address" sends the operator hunting for a typo that does not exist.
  describe('behind an authenticating proxy', () => {
    const signIn = '<html><title>Sign in</title><body>Authenticating with ngrok OAuth… Continue with Google</body></html>';

    async function loginAgainst(handler: (req: Request) => Response) {
      const proxy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
      try {
        return await ctx.lazy(
          ['login', `http://127.0.0.1:${proxy.port}`, '--project', 'acme/web'],
          { env: env() },
        );
      } finally {
        proxy.stop(true);
      }
    }

    test('an HTML sign-in page answered 200 names the proxy and the docs', async () => {
      const result = await loginAgainst(() => new Response(signIn, { headers: { 'content-type': 'text/html' } }));
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('authenticating proxy');
      expect(result.stderr).toContain("login description");
      expect(result.stderr).toContain('docs.getlazy.dev/self-hosting-lazy-teams');
      expect(result.stderr).not.toContain('Check the address');
    });

    test('a redirect to a sign-in page names the proxy', async () => {
      const result = await loginAgainst((req) => {
        const url = new URL(req.url);
        if (url.pathname === '/signin') {
          return new Response('<html>please log in</html>', { headers: { 'content-type': 'text/html' } });
        }
        return new Response(null, { status: 302, headers: { location: '/signin' } });
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('authenticating proxy');
      expect(result.stderr).not.toContain('Check the address');
    });

    test('a proxy 401 challenge on the project list names the proxy', async () => {
      stub.server.stop(true);
      const proxy = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === '/api/cli/projects') {
            return new Response(signIn, { status: 401, headers: { 'content-type': 'text/html', 'ngrok-error-code': 'ERR_NGROK_302' } });
          }
          return stubDeviceFlow(req);
        },
      });
      try {
        const result = await ctx.lazy(
          ['login', `http://127.0.0.1:${proxy.port}`, '--project', 'acme/web'],
          { env: env() },
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('authenticating proxy');
      } finally {
        proxy.stop(true);
      }
    });
  });

  test('an unreachable address says so rather than hanging', async () => {
    // Port 1 on loopback: nothing listens there, and connecting fails at once.
    const result = await ctx.lazy(['login', 'http://127.0.0.1:1', '--project', 'acme/web'], {
      env: env(),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Could not reach http://127.0.0.1:1');
  });
});
