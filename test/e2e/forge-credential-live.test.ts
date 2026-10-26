/**
 * A forge token handed to a RUNNING daemon takes effect at once: the push-access
 * check, which goes through the same git the daemon's pushes use, changes its
 * answer with no restart in between — and a withdrawn token is gone the same way.
 *
 * INVARIANT: replacing a project's forge token never requires a daemon restart.
 * Before `putForgeCredential` existed the token arrived only in the daemon's
 * start environment, so a member who connected a fresh GitHub token in Lazy
 * Teams still could not push and nothing told them why (2026-10-20).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { readFile, writeFile, mkdir, mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, isDaemonRunning, readToken } from '../../src/daemon/lifecycle';
import { storageDirFor, setTaskMetadata, setTaskStatus } from '../helpers/storage';
import { getForgeCredentialPath } from '../../src/daemon/paths';
import { tokenFingerprint } from '../../src/daemon/forge-credential';
import { unlink } from 'fs/promises';

describe('forge credential on a running daemon', () => {
  let ctx: TestContext;
  let rpc: (command: string, params?: Record<string, unknown>) => Promise<any>;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(tomlPath, 'utf-8');
    const github = toml.replace('driver = "local"', 'driver = "github"');
    expect(github).not.toBe(toml);
    await writeFile(tomlPath, github);

    const bare = join(ctx.root, '.test-remote.git');
    expect(ctx.git('init', '--bare', bare).exitCode).toBe(0);
    if (ctx.git('remote', 'get-url', 'origin').exitCode === 0) ctx.git('remote', 'set-url', 'origin', bare);
    else ctx.git('remote', 'add', 'origin', bare);

    const target = getDaemonTcpTarget(ctx.root);
    const token = readToken(ctx.root);
    if (!target || !token) throw new Error('test daemon did not record a TCP target and token');
    rpc = (command, params = {}) => DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params);
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test('put, check, revoke — each visible to the next call, no restart', async () => {
    await rpc('revokeForgeCredential');
    expect(await rpc('checkPushAccess')).toMatchObject({ result: 'no_credential', ok: false });

    const summary = await rpc('putForgeCredential', { kind: 'github', token: 'ghp_live_e2e', handle: 'octo', source: 'user' });
    expect(summary).toMatchObject({ kind: 'github', handle: 'octo', source: 'user' });
    expect(JSON.stringify(summary)).not.toContain('ghp_live_e2e');

    expect(await rpc('forgeStatus')).toMatchObject({ driver: 'github', pushes: true, heldFingerprint: summary.fingerprint });
    const ok = await rpc('checkPushAccess');
    expect(ok).toMatchObject({ result: 'ok', ok: true, credential: { handle: 'octo', source: 'user' } });
    // The probe is a dry run: nothing was created on the remote.
    expect(ctx.git('ls-remote', 'origin', 'refs/heads/lazy-push-check-*').stdout.trim()).toBe('');

    expect(await rpc('revokeForgeCredential')).toEqual({ revoked: true });
    expect(await rpc('checkPushAccess')).toMatchObject({ result: 'no_credential' });
  });

  // INVARIANT: an accepted task shows no push-failure banner. Nothing pushes a
  // finished task's branch again, so a failure recorded before the accept
  // would otherwise sit on merged work forever.
  test('show answers the push failure for a live task and none once it is accepted', async () => {
    const { taskId } = await rpc('createTask', { goal: 'Push failure banner', code: 'push-banner' });
    const record = JSON.stringify({ branch: 'lazy/push-banner', error: 'remote: Permission denied', firstFailedAt: 't', lastFailedAt: 't', attempts: 1 });
    setTaskMetadata(ctx.root, taskId, 'push_failure', record);
    setTaskStatus(ctx.root, taskId, 'blocked');
    expect((await rpc('show', { taskId })).pushFailure).toMatchObject({ branch: 'lazy/push-banner', error: 'remote: Permission denied' });

    setTaskStatus(ctx.root, taskId, 'complete');
    expect((await rpc('show', { taskId })).pushFailure).toBeNull();
  });
});

describe('a managed daemon keeps its forge token across a restart Teams did not drive', () => {
  let ctx: TestContext;
  const managedEnv = () => ({ LAZY_TEST_FORCE_MANAGED: '1', LAZY_MANAGED_STORAGE_PATH: storageDirFor(ctx.root) });
  const rpcNow = async (command: string, params: Record<string, unknown> = {}) => {
    const target = getDaemonTcpTarget(ctx.root);
    const token = readToken(ctx.root);
    if (!target || !token) throw new Error('test daemon did not record a TCP target and token');
    return DaemonClient.fromTarget(target, token).rpc(command, ctx.root, params) as Promise<any>;
  };

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const tomlPath = join(ctx.root, 'lazy.toml');
    await writeFile(tomlPath, (await readFile(tomlPath, 'utf-8')).replace('driver = "local"', 'driver = "github"'));
    const bare = join(ctx.root, '.test-remote.git');
    expect(ctx.git('init', '--bare', bare).exitCode).toBe(0);
    if (ctx.git('remote', 'get-url', 'origin').exitCode === 0) ctx.git('remote', 'set-url', 'origin', bare);
    else ctx.git('remote', 'add', 'origin', bare);
    await ctx.restartDaemon(managedEnv());
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // INVARIANT: a managed daemon restarted WITHOUT Teams re-applies the forge
  // token Teams last pushed, and a revoke is not resurrected by a restart. The
  // engineer's `lazy daemon restart` from the machine shell lost the token and
  // every push with it (2026-10-20).
  test('the pushed token survives a restart; a revoked one does not come back', async () => {
    const summary = await rpcNow('putForgeCredential', { kind: 'github', token: 'ghp_kept', handle: 'octo', source: 'user' });
    await ctx.restartDaemon(managedEnv());
    expect(await rpcNow('checkPushAccess')).toMatchObject({
      result: 'ok', heldFingerprint: summary.fingerprint, credential: { handle: 'octo', fingerprint: summary.fingerprint },
    });

    await rpcNow('revokeForgeCredential');
    await ctx.restartDaemon(managedEnv());
    expect(await rpcNow('checkPushAccess')).toMatchObject({ result: 'no_credential', heldFingerprint: null });
  });


  // INVARIANT: the seeded environment is authoritative over the daemon's own
  // copy. Teams deletes that copy whenever it writes the seeded secrets
  // (lazy-teams FleetProjectFiles#write_secrets_env_locked); a boot after that
  // runs on exactly what was seeded — no token after a revoke made while the
  // daemon was stopped, and a newer seeded token over the one pushed earlier.
  test('after Teams reseeds, a boot runs on the seeded token, never a stale or revoked copy', async () => {
    await rpcNow('putForgeCredential', { kind: 'github', token: 'ghp_pushed_before', handle: 'octo', source: 'user' });
    const copy = getForgeCredentialPath(ctx.root);
    expect(await Bun.file(copy).exists()).toBe(true);

    // Revoked while the daemon was down: Teams rewrote the seed without a token
    // and deleted the copy.
    await unlink(copy);
    await ctx.restartDaemon({ ...managedEnv(), GH_TOKEN: '' });
    expect(await rpcNow('checkPushAccess')).toMatchObject({ result: 'no_credential', heldFingerprint: null });

    // A newer token seeded for the next start wins over the earlier push.
    await rpcNow('putForgeCredential', { kind: 'github', token: 'ghp_stale', source: 'user' });
    await unlink(copy);
    await ctx.restartDaemon({ ...managedEnv(), GH_TOKEN: 'ghp_seeded_newer' });
    expect(await rpcNow('checkPushAccess')).toMatchObject({ result: 'ok', heldFingerprint: tokenFingerprint('ghp_seeded_newer') });
  });

  // INVARIANT: a managed `local`-driver project MIRRORS to its origin with the
  // seeded token, so it is never reported as "never pushes", and its token is
  // found from the remote rather than the driver name.
  test('a managed local-driver project pushes, and its held token is reported', async () => {
    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(tomlPath, 'utf-8');
    const local = toml.replace('driver = "github"', 'driver = "local"');
    expect(local).not.toBe(toml);
    await writeFile(tomlPath, local);
    await ctx.restartDaemon(managedEnv());

    const summary = await rpcNow('putForgeCredential', { kind: 'github', token: 'ghp_local_mirror', source: 'integration' });
    expect(await rpcNow('forgeStatus')).toMatchObject({ driver: 'local', pushes: true, heldFingerprint: summary.fingerprint });
    expect(await rpcNow('checkPushAccess')).toMatchObject({ result: 'ok', heldFingerprint: summary.fingerprint });
  });

  // INVARIANT: on a managed project's machine, `lazy daemon restart/start`
  // from a shell without Teams' environment is refused with where to restart
  // it — it would start a daemon that has lost its credentials.
  test('a shell restart without the managed environment is refused', async () => {
    for (const verb of ['restart', 'start']) {
      const result = await ctx.lazy(['daemon', verb]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('This project is managed by Lazy Teams: restart it from its page (god mode → Restart) so it keeps its credentials');
    }
  });

  // INVARIANT: the refusal is at the shared chokepoint, so the AUTO-START any
  // command performs (ensureDaemon) refuses too — not only a typed
  // `lazy daemon start/restart`. Without it, `lazy list` from a shell lacking
  // the managed environment silently brought up an unmanaged daemon with no
  // credentials in the managed daemon's place.
  test('auto-start from a shell without the managed environment is refused', async () => {
    const stop = await ctx.lazy(['daemon', 'stop', '--yes']);
    expect(stop.exitCode).toBe(0);
    const result = await ctx.lazy(['list'], { env: { LAZY_TEST: '' } });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('This project is managed by Lazy Teams: restart it from its page');
    expect(isDaemonRunning(ctx.root)).toBe(false);
  });
});

/**
 * A git remote that REQUIRES the forge credential: `git http-backend` behind
 * HTTPS (self-signed) and Basic auth, answering 401 to anything without the
 * expected `x-access-token:<token>`. A bare file remote needs no auth, so it
 * cannot tell "the token reached git" from "git never needed one".
 */
async function startAuthGitServer(dir: string, token: string) {
  const srv = join(dir, 'srv');
  await mkdir(srv, { recursive: true });
  const bare = join(srv, 'app.git');
  const run = (argv: string[], cwd = dir) => {
    const p = Bun.spawnSync(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (p.exitCode !== 0) throw new Error(`${argv.join(' ')}: ${p.stderr.toString()}`);
    return p.stdout.toString();
  };
  run(['git', 'init', '--bare', '-q', bare]);
  run(['git', '--git-dir', bare, 'config', 'http.receivepack', 'true']);
  run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'),
    '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1']);
  const backend = join(run(['git', '--exec-path']).trim(), 'git-http-backend');
  const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  const seen = { refused: 0, authenticated: 0 };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    tls: { cert: await readFile(join(dir, 'cert.pem'), 'utf-8'), key: await readFile(join(dir, 'key.pem'), 'utf-8') },
    async fetch(req) {
      if (req.headers.get('authorization') !== expected) {
        seen.refused++;
        return new Response('authentication required\n', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="test"' } });
      }
      seen.authenticated++;
      const url = new URL(req.url);
      const proc = Bun.spawn([backend], {
        stdin: new Uint8Array(await req.arrayBuffer()),
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          GIT_PROJECT_ROOT: srv,
          GIT_HTTP_EXPORT_ALL: '1',
          REMOTE_USER: 'x-access-token',
          REMOTE_ADDR: '127.0.0.1',
          REQUEST_METHOD: req.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.replace(/^\?/, ''),
          CONTENT_TYPE: req.headers.get('content-type') ?? '',
          HTTP_CONTENT_ENCODING: req.headers.get('content-encoding') ?? '',
          PATH: process.env.PATH ?? '',
        },
      });
      const out = Buffer.from(await new Response(proc.stdout).arrayBuffer());
      await proc.exited;
      const split = out.indexOf('\r\n\r\n');
      const headers = new Headers();
      let status = 200;
      for (const line of out.subarray(0, split).toString().split('\r\n')) {
        const i = line.indexOf(':');
        const [k, v] = [line.slice(0, i).trim(), line.slice(i + 1).trim()];
        if (k.toLowerCase() === 'status') status = parseInt(v, 10);
        else if (k) headers.set(k, v);
      }
      return new Response(out.subarray(split + 4), { status, headers });
    },
  });
  return { url: `https://127.0.0.1:${server.port}/app.git`, bare, seen, stop: () => server.stop(true) };
}

describe('a token connected to a running project that started without one', () => {
  let ctx: TestContext;
  let rpc: (command: string, params?: Record<string, unknown>) => Promise<any>;
  let server: Awaited<ReturnType<typeof startAuthGitServer>>;
  const token = 'ghp_live_helper_e2e';

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
    const tomlPath = join(ctx.root, 'lazy.toml');
    const toml = await readFile(tomlPath, 'utf-8');
    const github = toml.replace('driver = "local"', 'driver = "github"');
    expect(github).not.toBe(toml);
    await writeFile(tomlPath, github);

    server = await startAuthGitServer(await mkdtemp(join(tmpdir(), 'lazy-auth-git-')), token);
    if (ctx.git('remote', 'get-url', 'origin').exitCode === 0) ctx.git('remote', 'set-url', 'origin', server.url);
    else ctx.git('remote', 'add', 'origin', server.url);
    // The test server's certificate is self-signed; the clone trusts it, nothing else changes.
    expect(ctx.git('config', '--local', 'http.sslVerify', 'false').exitCode).toBe(0);
    // Started with no token: no helper in the clone, exactly as the fleet leaves it.
    ctx.git('config', '--local', '--unset-all', 'credential.helper');

    const target = getDaemonTcpTarget(ctx.root);
    const daemonToken = readToken(ctx.root);
    if (!target || !daemonToken) throw new Error('test daemon did not record a TCP target and token');
    rpc = (command, params = {}) => DaemonClient.fromTarget(target, daemonToken).rpc(command, ctx.root, params);
    await rpc('revokeForgeCredential');
  });

  afterEach(async () => {
    server?.stop();
    await ctx.cleanup();
  });

  // The environment the daemon's git runs with, minus anything of the
  // developer's: no global or system helper (a Mac's osxkeychain) may answer.
  const gitEnv = (extra: Record<string, string>) => ({
    ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extra,
  });
  // Async: the server answers on this process's event loop, which a sync spawn would block.
  const push = async (ref: string, extra: Record<string, string>) => {
    const p = Bun.spawn(['git', 'push', 'origin', `HEAD:refs/heads/${ref}`], { cwd: ctx.root, env: gitEnv(extra), stdout: 'pipe', stderr: 'pipe' });
    const [stderr, exitCode] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    return { exitCode, stderr };
  };

  // INVARIANT: connecting a forge account to a RUNNING project that started
  // with no token makes `git push` work at once, with no restart. git reads the
  // token only through the clone's credential helper, which the fleet installed
  // only for a SEEDED token — so the live push used to reach `gh` and nothing
  // else, and the identity line said "acting as @you" while pushes were refused.
  test('the live push installs the helper, and a real authenticated push then works', async () => {
    // The remote really requires the credential: the token alone, with no helper, is refused.
    const without = await push('before', { GH_TOKEN: token });
    expect(without.exitCode).not.toBe(0);
    expect(server.seen.refused).toBeGreaterThan(0);
    expect(await rpc('checkPushAccess')).toMatchObject({ result: 'no_credential', ok: false });

    const summary = await rpc('putForgeCredential', { kind: 'github', token, handle: 'octo', source: 'user' });
    expect(summary).toMatchObject({ kind: 'github', handle: 'octo', credentialHelper: 'installed' });
    expect(await readFile(join(ctx.root, '.git', 'config'), 'utf-8')).not.toContain(token);

    // The daemon's own git, in its own environment, now authenticates.
    const authenticatedBefore = server.seen.authenticated;
    expect(await rpc('checkPushAccess')).toMatchObject({ result: 'ok', ok: true, credential: { handle: 'octo' } });
    expect(server.seen.authenticated).toBeGreaterThan(authenticatedBefore);

    // A real push through the installed helper lands on the remote.
    const pushed = await push('after', { GH_TOKEN: token });
    expect(pushed.stderr).not.toContain('Authentication failed');
    expect(pushed.exitCode).toBe(0);
    const landed = Bun.spawnSync(['git', '--git-dir', server.bare, 'rev-parse', 'refs/heads/after'], { stdout: 'pipe' });
    expect(landed.stdout.toString().trim()).toBe(ctx.git('rev-parse', 'HEAD').stdout.trim());

    // A second push of the same token leaves the helper as it is.
    expect(await rpc('putForgeCredential', { kind: 'github', token, handle: 'octo', source: 'user' }))
      .toMatchObject({ credentialHelper: 'present' });
  });
});
