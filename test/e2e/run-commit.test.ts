/**
 * Running the product at a commit WITHOUT a task (src/daemon/commit-run.ts),
 * against a real daemon and a real bare `origin`.
 *
 * Everything lazy does is real here: the remote checks, the detached
 * checkout, the store, the RPCs, Start services' launch path down to the
 * `docker run` argv, the service proxy. What is pretend is the CONTAINER
 * RUNTIME only, exactly as in test/e2e/serve-proxy.test.ts: a `docker` script
 * on the daemon's PATH that logs every call, answers `port` / `network
 * inspect` / `exec` from a state dir and "starts" a container by creating the
 * file `LAZY_MOCK_RUNNING_CONTAINERS` names (the harness mock's
 * `isContainerRunning` reads the same file, so "is it up?" and "what does it
 * publish?" cannot disagree). The image is the harness mock's.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import type { Server } from 'bun';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { DaemonClient, RpcApplicationError } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';
import { checkDaemonHealth } from '../../src/daemon';
import { runContainerName } from '../../src/run/identity';

const FAKE_DOCKER = `#!/usr/bin/env bash
set -uo pipefail
STATE="__STATE_DIR__"
printf '%s\\n' "$*" >> "$STATE/log"
case "\${1:-}" in
  info) exit 0 ;;
  ps) exit 0 ;;
  port) cat "$STATE/ports" 2>/dev/null; exit 0 ;;
  network)
    if [ "\${2:-}" = "inspect" ]; then
      echo '{"Driver":"bridge","Options":{"com.docker.network.bridge.enable_icc":"false","com.docker.network.bridge.name":"lzruns0"},"Labels":{"lazy.run-network":"1"}}'
    fi
    exit 0 ;;
  run) : > "$STATE/running"; echo "c0ffee"; exit 0 ;;
  rm) rm -f "$STATE/running"; exit 0 ;;
  exec) printf 'running\\n'; exit 0 ;;
esac
exit 0
`;

/** Run git in `cwd`, failing the test on a non-zero exit. */
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

describe('running a commit without a task', () => {
  let ctx: TestContext;
  let scratch: string;
  let bare: string;
  let other: string;
  let stateDir: string;
  let client: DaemonClient;

  async function rpc<T = any>(command: string, params: Record<string, unknown> = {}): Promise<T> {
    return await client.rpc(command, ctx.root, params) as T;
  }

  async function refusal(command: string, params: Record<string, unknown>): Promise<RpcApplicationError> {
    try {
      await rpc(command, params);
    } catch (err) {
      if (err instanceof RpcApplicationError) return err;
      throw err;
    }
    throw new Error(`${command} succeeded; a refusal was expected`);
  }

  /** Commit a file on `branch` in a second clone and push it to origin. Returns the new sha. */
  function pushCommit(branch: string, file: string, content: string): string {
    git(other, 'fetch', 'origin');
    const exists = Bun.spawnSync(['git', 'rev-parse', '--verify', `origin/${branch}`], { cwd: other }).exitCode === 0;
    git(other, 'checkout', '-B', branch, exists ? `origin/${branch}` : 'origin/main');
    writeFileSync(join(other, file), content);
    git(other, 'add', file);
    git(other, 'commit', '-m', `change ${file}`);
    git(other, 'push', 'origin', `${branch}:${branch}`);
    return git(other, 'rev-parse', 'HEAD');
  }

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'lazy-run-commit-'));
    stateDir = join(scratch, 'state');
    const binDir = join(scratch, 'bin');
    await mkdir(stateDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, 'docker'), FAKE_DOCKER.replace('__STATE_DIR__', stateDir));
    await chmod(join(binDir, 'docker'), 0o755);

    ctx = await setupTestLazy({
      withDaemon: true,
      daemonEnv: {
        PATH: `${binDir}:${process.env.PATH}`,
        LAZY_MOCK_RUNNING_CONTAINERS: join(stateDir, 'running'),
      },
    });

    // A bare origin with the project's main pushed to it, and a second clone
    // standing in for a colleague who pushes.
    bare = join(scratch, 'origin.git');
    git(scratch, 'init', '--bare', '-b', 'main', bare);
    if (ctx.git('remote', 'get-url', 'origin').exitCode === 0) git(ctx.root, 'remote', 'set-url', 'origin', bare);
    else git(ctx.root, 'remote', 'add', 'origin', bare);
    git(ctx.root, 'push', 'origin', 'HEAD:main');
    other = join(scratch, 'other');
    git(scratch, 'clone', bare, other);
    git(other, 'config', 'user.email', 'colleague@example.com');
    git(other, 'config', 'user.name', 'Colleague');

    const target = getDaemonTcpTarget(ctx.root);
    const token = readToken(ctx.root);
    if (!target || !token) throw new Error('test daemon did not record a TCP target and token');
    client = DaemonClient.fromTarget(target, token);
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(scratch, { recursive: true, force: true });
  });

  // INVARIANT: with no target a run is the REMOTE default branch's HEAD, in a
  // detached checkout — and it is not a task: no task list includes it.
  test('runs the default branch at its remote HEAD, detached, and is never a task', async () => {
    const before = await rpc<any[]>('list', { all: true });
    const head = pushCommit('main', 'app.txt', 'v1\n');

    const branches = await rpc('listBranches', { refresh: true });
    expect(branches.defaultBranch).toBe('main');
    expect(branches.branches[0]).toMatchObject({ name: 'main', sha: head, isDefault: true, isTaskBranch: false });

    const { run, existed } = await rpc('runs.create', {});
    expect(existed).toBe(false);
    expect(run.target).toEqual({ kind: 'branch', branch: 'main' });
    expect(run.slug).toBe('main');
    expect(run.head_sha).toBe(head);
    expect(run.canPull).toBe(true);
    expect(run.commit.subject).toBe('change app.txt');
    expect(run.attachSessionId).toBe(`run:${run.id}`);
    // Attributed to whoever asked: the daemon's git identity on a laptop.
    expect(run.created_by?.email).toBeTruthy();

    expect(existsSync(run.worktreePath)).toBe(true);
    expect(git(run.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
    // Detached: the run owns no branch.
    expect(Bun.spawnSync(['git', 'symbolic-ref', '-q', 'HEAD'], { cwd: run.worktreePath }).exitCode).not.toBe(0);
    expect(await readFile(join(run.worktreePath, 'app.txt'), 'utf-8')).toBe('v1\n');

    // One run per branch, shared: the same target answers with the same run.
    const again = await rpc('runs.create', { target: { kind: 'branch', branch: 'main' } });
    expect(again.existed).toBe(true);
    expect(again.run.id).toBe(run.id);

    expect((await rpc('runs.list')).runs.map((r: any) => r.id)).toEqual([run.id]);
    const after = await rpc<any[]>('list', { all: true });
    expect(after.length).toBe(before.length);
    const listed = await ctx.lazy(['list', '--all']);
    expect(listed.stdout).not.toContain(run.id.slice(0, 8));
  });

  // INVARIANT: a sha must be on the REMOTE. Unknown, malformed, unpushed and
  // local-only names are refused with a reason; a pinned run cannot be pulled.
  test('runs a pushed sha pinned, and refuses what is not on the remote', async () => {
    const first = pushCommit('main', 'app.txt', 'v1\n');
    pushCommit('main', 'app.txt', 'v2\n');

    const resolved = await rpc('resolveCommit', { sha: first.slice(0, 10) });
    expect(resolved.sha).toBe(first);
    expect(resolved.branches).toContain('main');

    const { run } = await rpc('runs.create', { target: { kind: 'sha', sha: first.slice(0, 9) } });
    expect(run.target).toEqual({ kind: 'sha', sha: first });
    expect(run.slug).toBe(`sha-${first.slice(0, 12)}`);
    expect(run.canPull).toBe(false);
    expect(git(run.worktreePath, 'rev-parse', 'HEAD')).toBe(first);
    const pull = await refusal('runs.pull', { runId: run.id });
    expect(pull.status).toBe(409);
    expect(pull.message).toContain('pinned');

    const unknown = await refusal('runs.create', { target: { kind: 'sha', sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } });
    expect(unknown.status).toBe(404);
    const malformed = await refusal('runs.create', { target: { kind: 'sha', sha: 'not-a-sha' } });
    expect(malformed.status).toBe(400);

    // A commit only this clone has.
    await writeFile(join(ctx.root, 'local.txt'), 'unpushed\n');
    git(ctx.root, 'add', 'local.txt');
    git(ctx.root, 'commit', '-m', 'local only');
    const local = git(ctx.root, 'rev-parse', 'HEAD');
    const unpushed = await refusal('runs.create', { target: { kind: 'sha', sha: local } });
    expect(unpushed.status).toBe(404);
    expect(unpushed.message).toContain('not on any branch');

    // A branch only this clone has.
    git(ctx.root, 'branch', 'only-here');
    const localBranch = await refusal('runs.create', { target: { kind: 'branch', branch: 'only-here' } });
    expect(localBranch.status).toBe(404);
    expect(localBranch.message).toContain('not on the project\'s remote');
  });

  test('offline, nothing is resolved — no silent fallback to the local clone', async () => {
    expect((await ctx.lazy(['system', 'offline'])).exitCode).toBe(0);
    const offline = await refusal('runs.create', {});
    expect(offline.status).toBe(409);
    expect(offline.message).toContain('offline');
    expect((await rpc('runs.list')).runs).toEqual([]);
  });

  // INVARIANT: Pull latest never discards a person's changes unasked. A dirty
  // checkout is refused with the files named; with the confirmation, tracked
  // edits go and are named, and unrelated untracked files stay.
  test('pull latest moves a branch run; local changes are refused until confirmed', async () => {
    pushCommit('feature/login', 'login.txt', 'one\n');
    const { run } = await rpc('runs.create', { target: { kind: 'branch', branch: 'feature/login' } });
    expect(run.slug).toBe('feature-login');

    // Nothing new: nothing moves.
    const same = await rpc('runs.pull', { runId: run.id });
    expect(same.moved).toBe(false);

    // A clean pull.
    const second = pushCommit('feature/login', 'login.txt', 'two\n');
    const clean = await rpc('runs.pull', { runId: run.id });
    expect(clean).toMatchObject({ moved: true, to: second, discarded: [], servicesRestarted: false });
    expect(await readFile(join(run.worktreePath, 'login.txt'), 'utf-8')).toBe('two\n');

    // Somebody edits the checkout through the run's shell.
    const third = pushCommit('feature/login', 'login.txt', 'three\n');
    await writeFile(join(run.worktreePath, 'login.txt'), 'edited by hand\n');
    await writeFile(join(run.worktreePath, 'notes.txt'), 'mine\n');
    const dirty = await refusal('runs.pull', { runId: run.id });
    expect(dirty.status).toBe(409);
    expect(dirty.details?.dirtyFiles).toEqual(['login.txt', 'notes.txt']);
    // Refused means untouched.
    expect(await readFile(join(run.worktreePath, 'login.txt'), 'utf-8')).toBe('edited by hand\n');
    expect((await rpc('runs.show', { runId: run.id })).head_sha).toBe(second);

    const confirmed = await rpc('runs.pull', { runId: run.id, confirmDiscard: true });
    expect(confirmed).toMatchObject({ moved: true, from: second, to: third, discarded: ['login.txt'], kept: ['notes.txt'] });
    expect(await readFile(join(run.worktreePath, 'login.txt'), 'utf-8')).toBe('three\n');
    expect(await readFile(join(run.worktreePath, 'notes.txt'), 'utf-8')).toBe('mine\n');
    const shown = await rpc('runs.show', { runId: run.id });
    expect(shown.head_sha).toBe(third);
    expect(shown.last_pulled_by?.email).toBeTruthy();
  });

  // INVARIANT: a run and a task never answer on the same hostname: a run is
  // refused where a live task's label is, and a task code is refused where a
  // run's slug is.
  test('a run and a task cannot share a host label, either way round', async () => {
    pushCommit('feature/x', 'x.txt', 'x\n');
    const created = await ctx.lazy(['create', '--goal', 'Feature x work', '--code', 'feature-x']);
    expect(created.exitCode).toBe(0);
    const clash = await refusal('runs.create', { target: { kind: 'branch', branch: 'feature/x' } });
    expect(clash.status).toBe(409);
    expect(clash.message).toContain('feature-x');

    await rpc('runs.create', {});
    const taken = await ctx.lazy(['create', '--goal', 'Something', '--code', 'main']);
    expect(taken.exitCode).not.toBe(0);
    expect(taken.stdout + taken.stderr).toContain('running commit');
    // A caller's mistake, answered as one — not an internal error.
    const typed = await refusal('createTask', { goal: 'Something', code: 'main' });
    expect(typed.status).toBe(409);
    expect(typed.message).toContain('running commit');
    // A rename onto a run's name is refused BEFORE anything is written.
    const { taskId } = await rpc('createTask', { goal: 'Other work', code: 'other-work' });
    const rename = await refusal('editTask', { taskId, goal: 'Renamed goal', code: 'main' });
    expect(rename.status).toBe(409);
    const shown = await rpc('show', { taskId });
    expect(shown.task?.goal ?? shown.goal).toBe('Other work');
  });

  // INVARIANT: commits somebody made in a run's checkout (its shell can
  // commit) are never discarded unasked: Pull and Remove refuse, naming them,
  // until confirmed, and then say they went.
  test('commits made in the checkout are refused, named and only discarded on confirmation', async () => {
    pushCommit('main', 'app.txt', 'v1\n');
    const { run } = await rpc('runs.create', {});
    await writeFile(join(run.worktreePath, 'local.txt'), 'mine\n');
    git(run.worktreePath, 'add', 'local.txt');
    git(run.worktreePath, '-c', 'user.email=me@example.com', '-c', 'user.name=Me', 'commit', '-m', 'my local fix');
    const local = git(run.worktreePath, 'rev-parse', 'HEAD');

    // The run says where its checkout really is.
    const shown = await rpc('runs.show', { runId: run.id });
    expect(shown.checkout).toMatchObject({ head: local, moved: true });
    expect(shown.checkout.commit.subject).toBe('my local fix');

    pushCommit('main', 'app.txt', 'v2\n');
    const pull = await refusal('runs.pull', { runId: run.id });
    expect(pull.status).toBe(409);
    expect(pull.details?.dirtyFiles).toEqual([]);
    expect((pull.details?.localCommits as string[])[0]).toContain('my local fix');
    expect(git(run.worktreePath, 'rev-parse', 'HEAD')).toBe(local);

    const remove = await refusal('runs.remove', { runId: run.id });
    expect(remove.status).toBe(409);
    expect((remove.details?.localCommits as string[]).length).toBe(1);

    const pulled = await rpc('runs.pull', { runId: run.id, confirmDiscard: true });
    expect(pulled.moved).toBe(true);
    expect(pulled.discardedCommits[0]).toContain('my local fix');
    expect((await rpc('runs.show', { runId: run.id })).checkout.moved).toBe(false);
  });

  // Decision: Pull latest restarts services that were running, on the new commit.
  test('pull latest restarts running services on the new commit', async () => {
    pushCommit('main', 'app.txt', 'v1\n');
    await rpc('serve.setStartServicesCmd', { command: 'bin/dev' });
    const { run } = await rpc('runs.create', {});
    await rpc('serve.run', { runId: run.id });
    const startsBefore = (await readFile(join(stateDir, 'log'), 'utf-8')).split('lazy-services bin/dev').length - 1;
    expect(startsBefore).toBe(1);

    const next = pushCommit('main', 'app.txt', 'v2\n');
    const pulled = await rpc('runs.pull', { runId: run.id });
    expect(pulled).toMatchObject({ moved: true, to: next, servicesRestarted: true });
    const startsAfter = (await readFile(join(stateDir, 'log'), 'utf-8')).split('lazy-services bin/dev').length - 1;
    expect(startsAfter).toBe(2);
  });

  // INVARIANT: Run services on a run launches a container with NO agent
  // credential, on its own network, with the root [serve] ports and the
  // run's own environment — and the service proxy routes the run's slug.
  test('Run services starts a credential-free container, and the proxy routes the slug', async () => {
    const head = pushCommit('main', 'app.txt', 'v1\n');
    const config = join(ctx.root, 'lazy.toml');
    await writeFile(config, `${await readFile(config, 'utf-8')}\n[serve.services]\nweb = 3000\n`);
    await rpc('serve.setStartServicesCmd', { command: 'bin/dev' });
    const { run } = await rpc('runs.create', {});
    await rpc('taskEnv', { runId: run.id, action: 'set', vars: { DATABASE_URL: 'postgres://always' } });

    const started = await rpc('serve.run', { runId: run.id });
    expect(started.command).toBe('bin/dev');
    expect(started.containerName).toBe(runContainerName(ctx.root, 'main'));

    const logText = await readFile(join(stateDir, 'log'), 'utf-8');
    const log = logText.split('\n');
    const dockerRun = log.find((l) => l.startsWith('run '))!;
    expect(dockerRun).toBeTruthy();
    for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'LAZY_DAEMON_CONFIG']) {
      expect(dockerRun).not.toContain(key);
    }
    expect(dockerRun).not.toContain('lazy-agent');
    expect(dockerRun).not.toContain('/lazy-protocol');
    expect(dockerRun).toContain('--network lazy-runs');
    expect(dockerRun).toContain('127.0.0.1:0:3000');
    expect(dockerRun).toContain(`lazy.commit-run=${run.id}`);
    expect(dockerRun).toContain('LAZY_TASK_ENV_KEYS=DATABASE_URL');
    // Start services exec'd into the run's container (the script spans lines).
    expect(logText).toContain(`exec -w ${run.worktreePath} ${runContainerName(ctx.root, 'main')} sh -c`);
    expect(logText).toContain('lazy-services bin/dev');

    // servePorts answers for the run.
    const app = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => new Response(`app at ${new URL(req.url).pathname}`) });
    try {
      await writeFile(join(stateDir, 'ports'), `3000/tcp -> 127.0.0.1:${app.port}\n`);
      const ports = await rpc('servePorts', { runId: run.id });
      expect(ports).toMatchObject({ runId: run.id, slug: 'main', headSha: head, unavailable: null, containerRunning: true });
      expect(ports.services[0]).toMatchObject({ name: 'web', port: 3000, listening: true });

      const health = await checkDaemonHealth(ctx.root);
      const webPort = health.webPort!;
      const proxied = await fetch(`http://127.0.0.1:${webPort}/hello`, { headers: { host: `main.web.lazy.localhost:${webPort}` } });
      expect(proxied.status).toBe(200);
      expect(await proxied.text()).toBe('app at /hello');

      // Stopped: a navigation is sent to the run's page, never a container start.
      await rm(join(stateDir, 'running'), { force: true });
      await Bun.sleep(2_100); // the proxy's 2s target cache
      const down = await fetch(`http://127.0.0.1:${webPort}/`, {
        headers: { host: `main.web.lazy.localhost:${webPort}`, accept: 'text/html' },
        redirect: 'manual',
      });
      expect(down.status).toBe(302);
      expect(down.headers.get('location')).toBe(`http://lazy.localhost:${webPort}/runs/${run.id}?serve=web&serve_reason=not-running`);
    } finally {
      app.stop(true);
    }
  });

  // INVARIANT: Remove asks before discarding changes, and then takes the
  // container, the checkout, the record and the run's environment with it.
  test('remove is refused with changes until confirmed, then leaves nothing behind', async () => {
    pushCommit('main', 'app.txt', 'v1\n');
    const { run } = await rpc('runs.create', {});
    await rpc('taskEnv', { runId: run.id, action: 'set', vars: { SECRET: 'x' } });
    await writeFile(join(run.worktreePath, 'app.txt'), 'edited\n');

    const refused = await refusal('runs.remove', { runId: run.id });
    expect(refused.status).toBe(409);
    expect(refused.details?.dirtyFiles).toEqual(['app.txt']);
    expect(existsSync(run.worktreePath)).toBe(true);

    const removed = await rpc('runs.remove', { runId: run.id, confirmDiscard: true });
    expect(removed).toMatchObject({ removed: true, runId: run.id, discarded: ['app.txt'] });
    expect(existsSync(run.worktreePath)).toBe(false);
    expect((await rpc('runs.list')).runs).toEqual([]);
    expect((await refusal('runs.show', { runId: run.id })).status).toBe(404);
    expect((await refusal('taskEnv', { runId: run.id, action: 'list' })).status).toBe(404);
  });
});
