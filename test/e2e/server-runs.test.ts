/**
 * The dashboard's Run pages (`/runs`, `/runs/:id`, src/server/runs-page.ts):
 * running the product at a commit without a task, from the daemon's own web
 * dashboard, against a real daemon and a real bare `origin`.
 *
 * Same arrangement as test/e2e/run-commit.test.ts, which covers the daemon's
 * RPCs: everything lazy does is real — the remote checks, the checkout, the
 * store, the pages — and only the CONTAINER RUNTIME is pretend (a `docker`
 * script on the daemon's PATH that logs its calls and "starts" a container by
 * creating the file the harness mock reads for "is it running?").
 *
 * The pages only render: what this suite asserts is that each control reaches
 * the daemon's answer and shows it — the default branch preselected, task
 * branches behind a toggle, the daemon's refusal of an unknown commit, the
 * files a Pull or Remove would discard named before anything is discarded —
 * both as a plain form POST (no JS) and through the action dialog's JSON.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { join } from 'path';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { signInToDashboard, dashboardFetch, type DashboardFetch } from '../helpers/dashboard-session';
import { DaemonClient } from '../../src/daemon/client';
import { getDaemonTcpTarget, readToken } from '../../src/daemon/lifecycle';

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

const DIALOG = { 'x-lazy-action-dialog': '1', Accept: 'application/json' };

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe('dashboard Run pages', () => {
  let ctx: TestContext;
  let scratch: string;
  let other: string;
  let stateDir: string;
  let client: DaemonClient;
  let base: string;
  let fetch: DashboardFetch;

  async function rpc<T = any>(command: string, params: Record<string, unknown> = {}): Promise<T> {
    return await client.rpc(command, ctx.root, params) as T;
  }

  function pushCommit(branch: string, file: string, content: string): string {
    git(other, 'fetch', 'origin');
    const exists = Bun.spawnSync(['git', 'rev-parse', '--verify', `origin/${branch}`], { cwd: other }).exitCode === 0;
    git(other, 'checkout', '-B', branch, exists ? `origin/${branch}` : 'origin/main');
    writeFileSync(join(other, file), content);
    git(other, 'add', file);
    git(other, 'commit', '-m', `change ${file} on ${branch}`);
    git(other, 'push', 'origin', `${branch}:${branch}`);
    return git(other, 'rev-parse', 'HEAD');
  }

  /** POST a form without following the redirect, the way a JS-off browser submits it. */
  function post(path: string, fields: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}${path}`, { method: 'POST', body: form(fields), headers, redirect: 'manual' });
  }

  /** Follow an action-dialog run to its end, as the dialog's poll does. */
  async function followAction(started: Response): Promise<any> {
    expect(started.status).toBe(202);
    const body = await started.json() as { runId: string; followBase: string };
    expect(body.followBase).toMatch(/^\/runs\//);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const snap = await (await fetch(`${base}${body.followBase}/action-runs/${body.runId}`)).json() as any;
      if (snap.status !== 'running') return snap;
      if (Date.now() > deadline) throw new Error('action did not settle');
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async function createDefaultRun(): Promise<any> {
    const res = await post('/runs', { target: 'default' });
    expect(res.status).toBe(303);
    const id = res.headers.get('location')!.replace(/^.*\/runs\//, '');
    return rpc('runs.show', { runId: id });
  }

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'lazy-server-runs-'));
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

    const bare = join(scratch, 'origin.git');
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
    ({ base, fetch } = await signInToDashboard(ctx));
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(scratch, { recursive: true, force: true });
  });

  // INVARIANT: the Run page offers the remote's default branch first and
  // preselected, and keeps task branches out of the way behind a toggle.
  test('the Run page preselects the default branch and hides task branches until asked', async () => {
    const head = pushCommit('main', 'app.txt', 'v1\n');
    pushCommit('feature/login', 'login.txt', 'x\n');
    pushCommit('lazy/some-task', 'task.txt', 'y\n');

    const page = await (await fetch(`${base}/runs?refresh=1`)).text();
    expect(page).toContain('<a href="/runs">Runs</a>');
    expect(page).toMatch(/name="target" value="default" checked/);
    expect(page).toContain(head.slice(0, 7));
    expect(page).toContain('value="branch:feature/login"');
    expect(page).not.toContain('value="branch:lazy/some-task"');
    expect(page).toContain('Show task branches (1)');
    expect(page).toContain('id="lz-runs-empty"');

    const withTasks = await (await fetch(`${base}/runs?task_branches=1`)).text();
    expect(withTasks).toContain('value="branch:lazy/some-task"');
    expect(withTasks).toContain('Hide task branches (1)');
  });

  // INVARIANT: an unknown commit is refused with the daemon's own reason, on
  // the page and in the dialog — and nothing is created.
  test('a commit that is not on the remote is refused with the reason', async () => {
    pushCommit('main', 'app.txt', 'v1\n');
    const unknown = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    const res = await post('/runs', { target: 'sha', sha: unknown });
    expect(res.status).toBe(404);
    const page = await res.text();
    expect(page).toContain('lz-run-flash-error');
    expect(page).toContain('deadbeefdead');
    // The typed choice survives the refusal.
    expect(page).toMatch(/value="sha" data-lz-run-sha-choice checked/);

    const snap = await followAction(await post('/runs', { target: 'sha', sha: unknown }, DIALOG));
    expect(snap.status).toBe('failed');
    expect(snap.error).toBeTruthy();
    expect((await rpc('runs.list')).runs).toEqual([]);
  });

  test('running the default branch opens its page, which names the exact commit served', async () => {
    const head = pushCommit('main', 'app.txt', 'v1\n');
    const run = await createDefaultRun();
    expect(run.head_sha).toBe(head);

    const page = await (await fetch(`${base}/runs/${run.id}`)).text();
    expect(page).toContain('id="lz-run-serving"');
    expect(page).toContain(head.slice(0, 12));
    expect(page).toContain('change app.txt on main');
    expect(page).toContain('id="lz-run-pull"');
    expect(page).toContain(`data-lz-shell-base="/runs/${run.id}"`);
    // No Start services command yet: said, with where to set one.
    expect(page).toContain('id="lz-run-no-cmd"');

    const index = await (await fetch(`${base}/runs`)).text();
    expect(index).toContain(`href="/runs/${run.id}"`);
    expect(index).toContain('already running as main');

    // Through the dialog, the same target answers with the same run.
    const snap = await followAction(await post('/runs', { target: 'branch:main' }, DIALOG));
    expect(snap.status).toBe('done');
    expect(snap.redirect).toBe(`/runs/${run.id}`);
  });

  test('a commit run is pinned: its page offers no Pull latest', async () => {
    const first = pushCommit('main', 'app.txt', 'v1\n');
    pushCommit('main', 'app.txt', 'v2\n');
    const res = await post('/runs', { target: 'sha', sha: first.slice(0, 10) });
    expect(res.status).toBe(303);
    const page = await (await fetch(`${base}${res.headers.get('location')!.replace(/^https?:\/\/[^/]+/, '')}`)).text();
    expect(page).toContain(`sha-${first.slice(0, 12)}`);
    expect(page).toContain('nothing to pull');
    expect(page).not.toContain('id="lz-run-pull"');
  });

  // INVARIANT: a Pull that would discard somebody's files names them and
  // discards nothing until confirmed — without JS and in the dialog.
  test('pull latest with a changed checkout names the files, then pulls on confirmation', async () => {
    pushCommit('main', 'app.txt', 'v1\n');
    const run = await createDefaultRun();
    await writeFile(join(run.worktreePath, 'app.txt'), 'edited in the shell\n');
    const next = pushCommit('main', 'app.txt', 'v2\n');

    const refused = await post(`/runs/${run.id}/pull`);
    expect(refused.status).toBe(409);
    const page = await refused.text();
    expect(page).toContain('<code>app.txt</code>');
    expect(page).toContain('name="confirm_discard" value="1"');
    expect(page).toContain('Discard them and pull');
    expect(await readFile(join(run.worktreePath, 'app.txt'), 'utf-8')).toBe('edited in the shell\n');

    const snap = await followAction(await post(`/runs/${run.id}/pull`, {}, DIALOG));
    expect(snap.status).toBe('failed');
    expect(snap.confirm).toMatchObject({ items: ['app.txt'], fields: { confirm_discard: '1' }, action: `/runs/${run.id}/pull` });

    const done = await followAction(await post(`/runs/${run.id}/pull`, { confirm_discard: '1' }, DIALOG));
    expect(done.status).toBe('done');
    expect(done.redirect).toContain(`/runs/${run.id}?action=`);
    expect((await rpc('runs.show', { runId: run.id })).head_sha).toBe(next);
    // The page it lands on keeps what the Pull did.
    const after = await (await fetch(`${base}${done.redirect}`)).text();
    expect(after).toContain('id="lz-run-last-action"');
    expect(after).toContain('Discarded: app.txt');
  });

  test('remove asks about changes first, then removes the run', async () => {
    pushCommit('main', 'app.txt', 'v1\n');
    const run = await createDefaultRun();
    await writeFile(join(run.worktreePath, 'notes.txt'), 'mine\n');

    const refused = await post(`/runs/${run.id}/remove`);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('<code>notes.txt</code>');
    expect(existsSync(run.worktreePath)).toBe(true);

    const removed = await post(`/runs/${run.id}/remove`, { confirm_discard: '1' });
    expect(removed.status).toBe(303);
    expect(removed.headers.get('location')).toContain('/runs');
    expect((await rpc('runs.list')).runs).toEqual([]);
    expect((await fetch(`${base}/runs/${run.id}`)).status).toBe(404);
  });

  test('Run services starts the environment; Stop environment takes it down', async () => {
    const config = join(ctx.root, 'lazy.toml');
    await writeFile(config, `${await readFile(config, 'utf-8')}\n[serve.services]\nweb = 3000\n`);
    pushCommit('main', 'app.txt', 'v1\n');
    await rpc('serve.setStartServicesCmd', { command: 'bin/dev' });
    const run = await createDefaultRun();

    const before = await (await fetch(`${base}/runs/${run.id}`)).text();
    expect(before).toContain('<strong>Services</strong>');
    expect(before).toContain('environment not running');
    // A run's card carries no `lazy url` command: that addresses tasks.
    expect(before).not.toContain('lazy url');
    expect(before).toContain('id="lz-run-services"');

    const snap = await followAction(await post(`/runs/${run.id}/services/run`, {}, DIALOG));
    expect(snap.status).toBe('done');
    const log = await readFile(join(stateDir, 'log'), 'utf-8');
    expect(log).toContain('lazy-services bin/dev');
    expect((await rpc('runs.show', { runId: run.id })).containerRunning).toBe(true);

    const stopped = await post(`/runs/${run.id}/environment/stop`);
    expect(stopped.status).toBe(303);
    expect((await rpc('runs.show', { runId: run.id })).containerRunning).toBe(false);
  });

  // INVARIANT: a dead service's navigation lands on the run's page with a
  // banner composed from the run's own state; rendering it starts nothing.
  test('the page a dead service redirects to explains why, and starts nothing', async () => {
    const config = join(ctx.root, 'lazy.toml');
    await writeFile(config, `${await readFile(config, 'utf-8')}\n[serve.services]\nweb = 3000\n`);
    pushCommit('main', 'app.txt', 'v1\n');
    const run = await createDefaultRun();

    const page = await (await fetch(`${base}/runs/${run.id}?serve=web&serve_reason=not-running`)).text();
    expect(page).toContain('id="lz-run-serve-notice"');
    expect(page).toContain('environment is not running');
    // A made-up reason renders no banner.
    const forged = await (await fetch(`${base}/runs/${run.id}?serve=web&serve_reason=hacked`)).text();
    expect(forged).not.toContain('id="lz-run-serve-notice"');
    expect(existsSync(join(stateDir, 'running'))).toBe(false);

    // The waiting page says nothing will answer while Run services is not running.
    const wait = await (await fetch(`${base}/runs/${run.id}/open/web`)).text();
    expect(wait).toContain('id="lz-run-wait-stopped"');
    expect(existsSync(join(stateDir, 'running'))).toBe(false);
  });

  // INVARIANT: the run's shell route takes the dashboard session like every
  // other terminal route, and resolves only the run named in its path.
  test('the run shell route is behind the dashboard session and knows only runs', async () => {
    pushCommit('main', 'app.txt', 'v1\n');
    const run = await createDefaultRun();
    expect((await dashboardFetch(`${base}/runs/${run.id}/shell/ws`)).status).toBe(401);
    expect((await fetch(`${base}/runs/no-such-run/shell/ws`)).status).toBe(404);
    expect((await fetch(`${base}/runs/${run.id}/shell/ws`, { method: 'POST' })).status).toBe(405);
    // A run is entered with a shell only.
    expect((await fetch(`${base}/runs/${run.id}/shell/ws?mode=pair`)).status).toBe(400);
    // Not running yet: the client ensures it first, and the route says so.
    expect((await fetch(`${base}/runs/${run.id}/shell/ws`)).status).toBe(409);

    // The shell's container start, at the run's own path.
    const ensure = await fetch(`${base}/runs/${run.id}/container/ensure`, { method: 'POST' });
    expect(ensure.status).toBe(200);
    const deadline = Date.now() + 30_000;
    let state: any = await ensure.json();
    while (state.phase === 'starting' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      state = await (await fetch(`${base}/runs/${run.id}/container/state`)).json();
    }
    expect(state.phase).toBe('done');
    expect((await rpc('runs.show', { runId: run.id })).containerRunning).toBe(true);
  });
});
