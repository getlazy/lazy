/**
 * The positive half of being a bound clone (design doc §4.5, §4.7, §7.2 task
 * 9's own proof list): `lazy list` in a clone bound to Teams reaches the
 * stub proxy carrying the CLI's ApiToken, rather than trying to reach a local
 * daemon that was never started for this project.
 *
 * `teams-bound-clone-refusals.test.ts` covers the OTHER half — the
 * local-machine commands that must refuse. Neither suite proves the other's
 * claim, which is why both exist.
 *
 * `LAZY_TEST` is overridden to empty for these specific `ctx.lazy()` calls:
 * the ordinary e2e default (`LAZY_TEST=1`) makes `tryRemoteStorage` bypass the
 * daemon/proxy resolution entirely (see `src/preconditions.ts`), which is
 * right for a suite that does not care where storage lives and wrong here,
 * where the whole point is proving the CLI actually reaches the remote proxy.
 * This does not need `setupTestLazy({ withDaemon: true })` — no real local
 * daemon needs to run at all for a bound clone, and starting one would be
 * exactly the hidden side effect the dispatcher fix in `src/index.ts` exists
 * to prevent.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { writeTeamsLogin } from '../../src/teams/login';

describe('a bound clone reaches its project through the Teams proxy', () => {
  let ctx: TestContext;
  let tmpHome: string;
  let daemonBase: string;
  let unpin: () => void;
  let stub: ReturnType<typeof Bun.serve> | undefined;
  let requests: Array<{ pathname: string; authorization: string | null }>;

  beforeEach(async () => {
    ctx = await setupTestLazy();
    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-bound-proxy-home-'));
    daemonBase = await mkdtemp(join(tmpdir(), 'lzd-bound-proxy-'));
    unpin = pinDaemonBaseDir(daemonBase);
    requests = [];
  });

  afterEach(async () => {
    stub?.stop(true);
    await ctx.cleanup();
    unpin();
    await rm(tmpHome, { recursive: true, force: true });
    await rm(daemonBase, { recursive: true, force: true });
  });

  function startStubProxy(): ReturnType<typeof Bun.serve> {
    return Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        requests.push({ pathname: url.pathname, authorization: req.headers.get('authorization') });
        await req.text();

        if (url.pathname === '/api/projects/acme/lazy-toy/rpc/list') {
          return Response.json({ tree: [] });
        }
        return Response.json({ error: `unexpected path ${url.pathname}` }, { status: 404 });
      },
    });
  }

  const env = () => ({ HOME: tmpHome, LAZY_DAEMON_BASE_DIR: daemonBase, LAZY_TEST: '', LAZY_IS_DAEMON: '' });

  test('`lazy list` reaches the stub proxy carrying the ApiToken', async () => {
    stub = startStubProxy();
    await writeTeamsLogin(ctx.root, {
      teamsUrl: `http://127.0.0.1:${stub.port}`,
      token: 'lz_cli_token_abc',
      project: 'acme/lazy-toy',
      projectId: '42',
    });

    const result = await ctx.lazy(['list'], { env: env() });

    expect(result.exitCode).toBe(0);
    const listRequest = requests.find((r) => r.pathname === '/api/projects/acme/lazy-toy/rpc/list');
    expect(listRequest).toBeDefined();
    expect(listRequest?.authorization).toBe('Bearer lz_cli_token_abc');
  });

  test('the dispatcher does not try to start a local daemon for a bound clone', async () => {
    stub = startStubProxy();
    await writeTeamsLogin(ctx.root, {
      teamsUrl: `http://127.0.0.1:${stub.port}`,
      token: 'lz_cli_token_abc',
      project: 'acme/lazy-toy',
      projectId: '42',
    });

    const result = await ctx.lazy(['list'], { env: env() });

    // A local auto-start failure (no Anthropic credential in this temp HOME)
    // would have printed exactly this — the bug item 3 in the review names.
    // Its absence is the proof: the dispatcher recognized the binding and
    // skipped `ensureDaemon` for this project entirely.
    expect(result.stderr).not.toContain('could not be auto-started');
    expect(result.stderr).not.toContain('Daemon is not running');
    expect(result.exitCode).toBe(0);
  });

  // INVARIANT: when Teams cannot be reached or refuses the login, a bound
  // clone names the install and project and points at `lazy login` /
  // `lazy logout` — never at `lazy daemon …`, which refuses in a bound clone,
  // so that advice would leave the person looping between two dead ends.
  async function bindToStoppedProxy(): Promise<void> {
    const dead = startStubProxy();
    const port = dead.port;
    dead.stop(true);
    await writeTeamsLogin(ctx.root, {
      teamsUrl: `http://127.0.0.1:${port}`,
      token: 'lz_cli_token_abc',
      project: 'acme/lazy-toy',
      projectId: '42',
    });
  }

  function expectTeamsRemedy(output: string): void {
    expect(output).toContain('acme/lazy-toy');
    expect(output).toContain('lazy login');
    expect(output).toContain('lazy logout');
    expect(output).not.toContain('lazy daemon');
  }

  test('Teams unreachable: `lazy list` names the install and never suggests `lazy daemon`', async () => {
    await bindToStoppedProxy();

    const result = await ctx.lazy(['list'], { env: env() });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Could not reach Lazy Teams');
    expectTeamsRemedy(result.stderr);
  });

  test('Teams unreachable: a store-backed command names the install and never suggests `lazy daemon`', async () => {
    await bindToStoppedProxy();

    const result = await ctx.lazy(['comment', 'some-task', '-m', 'hello'], { env: env() });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Could not reach Lazy Teams');
    expectTeamsRemedy(result.stderr);
  });

  test('a login Teams refuses (final 401) points at `lazy login`, not `lazy daemon`', async () => {
    stub = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        await req.text();
        return Response.json({ error: 'Invalid or revoked token.' }, { status: 401 });
      },
    });
    await writeTeamsLogin(ctx.root, {
      teamsUrl: `http://127.0.0.1:${stub.port}`,
      token: 'lz_cli_token_revoked',
      project: 'acme/lazy-toy',
      projectId: '42',
    });

    const result = await ctx.lazy(['list'], { env: env() });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('refused this clone\'s login');
    expectTeamsRemedy(result.stderr);
  });
});
