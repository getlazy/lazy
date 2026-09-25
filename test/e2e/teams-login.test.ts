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
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { getCredentialIndexPath, getCredentialsPath } from '../../src/daemon/paths';

const APPROVED_TOKEN = 'lz_cli_token_for_the_clone_wxyz';

interface Stub {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  /** Flip to make the next poll answer "approved". */
  approve: () => void;
  /** Make the project list fail, to reach an ending past approval. */
  failProjects: () => void;
  /** Every path the CLI actually asked for, in order. */
  requests: string[];
  projects: Array<{ id: string; slug: string; name: string; team: string }>;
}

function startStub(): Stub {
  let approved = false;
  let projectsFail = false;
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

      if (url.pathname === '/api/cli/device/code') {
        await req.text();
        return Response.json({
          user_code: 'KTPX-9QFD',
          device_code: 'device-code-0123456789',
          verification_uri: `${url.origin}/device`,
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
        });
      }

      if (url.pathname === '/api/cli/projects') {
        if (projectsFail) return new Response('boom', { status: 500 });
        if (req.headers.get('authorization') !== `Bearer ${APPROVED_TOKEN}`) {
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
    approve: () => { approved = true; },
    failProjects: () => { projectsFail = true; },
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
    expect(index[0].provider).toBe(`teams:127.0.0.1:${stub.server.port}`);
    expect(index[0].binding).toEqual({
      teams_url: stub.url,
      project: 'acme/api-server',
      project_id: '11',
      bound_at: expect.any(String),
    });
    // The index is the NON-SECRET half. The secret is not in it.
    expect(JSON.stringify(index)).not.toContain(APPROVED_TOKEN);

    const secrets = JSON.parse(await readFile(getCredentialsPath(ctx.root), 'utf-8'));
    expect(secrets[`teams:127.0.0.1:${stub.server.port}`]).toBe(APPROVED_TOKEN);
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
      expect(Object.keys(secrets)).toEqual([`teams:127.0.0.1:${other.server.port}`]);
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

  test('an unreachable address says so rather than hanging', async () => {
    // Port 1 on loopback: nothing listens there, and connecting fails at once.
    const result = await ctx.lazy(['login', 'http://127.0.0.1:1', '--project', 'acme/web'], {
      env: env(),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Could not reach http://127.0.0.1:1');
  });
});
