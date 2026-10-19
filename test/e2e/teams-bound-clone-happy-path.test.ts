/**
 * The actual thing a person does with a bound clone: clone a repository,
 * `lazy login`, and then run the ordinary commands — `lazy list`, `lazy
 * show`, `lazy create`, `lazy comment` — against a REAL lazy CLI subprocess
 * and a stub standing in for Teams' proxy route.
 *
 * Four rounds of review found a blocking gap in this path every single time,
 * each one a different symptom of the same root cause: nobody had ever
 * actually driven a bound clone end to end. This suite is that drive. It
 * deliberately uses a FRESH clone — `git init` and one commit, no `lazy
 * init` — because that is the state `lazy login` itself promises to work
 * from (`src/teams/login.ts`'s own doc comment: "the anchor is the git root,
 * not resolveLazyRoot() ... requiring lazy init to have run first would
 * contradict the model this command exists to set up"), and it is exactly
 * the state every prior round's fix was never checked against.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { loadRailsPolicyTables } from '../helpers/rails-policy-tables';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { writeTeamsLogin } from '../../src/teams/login';
import { runGit } from '../../src/utils/git';

describe('a bound clone, driven end to end like a person would', () => {
  let ctx: TestContext;
  let freshDir: string;
  let tmpHome: string;
  let daemonBase: string;
  let unpin: () => void;
  let stub: ReturnType<typeof Bun.serve> | undefined;
  let requests: Array<{ pathname: string; authorization: string | null; body: unknown }>;
  let showSession: Record<string, unknown> | null;

  beforeEach(async () => {
    // `ctx` is used ONLY for its `.lazy()` runner — `ctx.root` is a red
    // herring here on purpose. The clone under test is `freshDir`, created
    // from nothing: `git init` and one commit, no `lazy init` at all.
    ctx = await setupTestLazy();
    freshDir = await mkdtemp(join(tmpdir(), 'lazy-bound-happy-'));
    await runGit(['init'], { cwd: freshDir });
    await runGit(['config', 'user.email', 'ada@example.com'], { cwd: freshDir });
    await runGit(['config', 'user.name', 'Ada'], { cwd: freshDir });
    await writeFile(join(freshDir, 'README.md'), '# lazy-toy\n');
    await runGit(['add', '.'], { cwd: freshDir });
    await runGit(['commit', '-m', 'Initial commit'], { cwd: freshDir });

    tmpHome = await mkdtemp(join(tmpdir(), 'lazy-bound-happy-home-'));
    daemonBase = await mkdtemp(join(tmpdir(), 'lzd-bound-happy-'));
    unpin = pinDaemonBaseDir(daemonBase);
    requests = [];
    showSession = null;
  });

  afterEach(async () => {
    stub?.stop(true);
    await ctx.cleanup();
    unpin();
    await rm(freshDir, { recursive: true, force: true });
    await rm(tmpHome, { recursive: true, force: true });
    await rm(daemonBase, { recursive: true, force: true });
  });

  const PROJECT_PATH = '/api/projects/acme/lazy-toy/rpc';

  // A minimally complete `Task` (src/types/index.ts) — every field the type
  // requires, filled with the simplest legal value. `list`/`show` walk this
  // shape recursively (`buildTaskTree`, `src/task/tree.ts`) and crash on a
  // partial object, which a real daemon never sends.
  function fakeTask(overrides: Record<string, unknown> = {}) {
    return {
      id: 'task-1', code: 'demo-task', goal: 'Demo the happy path', prompt: 'Do the thing.',
      type: 'task', status: 'blocked', created_at: Date.now(), completed_at: null,
      target: { kind: 'branch', branch: 'main' }, branched_from_sha: null, close_reason: null,
      model: null, agent_id: 'claude-code', runner_type: null, metadata: null, tags: [],
      pending_sync: 0, in_flight_turn: null,
      ...overrides,
    };
  }

  function fakeTreeNode(overrides: Record<string, unknown> = {}) {
    return { task: fakeTask(overrides), session: null, turnCount: 0, children: [] };
  }

  function startStubProxy(): ReturnType<typeof Bun.serve> {
    // The stub authorizes EXACTLY what the real route authorizes, by reading
    // the same Ruby tables the route's controller reads. Before this, a
    // hand-written `if method === 'getStoragePath'` answered every boot read
    // without consulting any policy — which is why `getStoragePath` could go
    // missing from StorageMethodPolicy's allow-lists (a 404 on every
    // store-backed CLI command) and this suite still passed: the two halves
    // had no way to disagree. Admitted-but-unserved methods return a DISTINCT
    // 501 so a missing canned answer can never be mistaken for a refusal.
    const tables = loadRailsPolicyTables();
    return Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (req) => {
        const url = new URL(req.url);
        const bodyText = await req.text();
        const body = bodyText ? JSON.parse(bodyText) : {};
        requests.push({ pathname: url.pathname, authorization: req.headers.get('authorization'), body });

        const command = url.pathname.startsWith(`${PROJECT_PATH}/`)
          ? url.pathname.slice(PROJECT_PATH.length + 1)
          : null;
        if (command !== null && command !== 'storage' && !tables.cliCommands.has(command)) {
          // CliRpcCommand.mapping_for returns nil → render_command_refusal.
          return Response.json({ error: `Unknown or unsupported command '${command}'.` }, { status: 404 });
        }

        if (url.pathname === `${PROJECT_PATH}/identity`) {
          return Response.json({ email: 'ada@example.com', name: 'Ada', configured: true });
        }
        if (url.pathname === `${PROJECT_PATH}/createTask`) {
          return Response.json({ taskId: 'task-2', displayId: 'new-task', derivedCode: false, warnings: [] });
        }
        if (url.pathname === `${PROJECT_PATH}/list`) {
          return Response.json({ tree: [fakeTreeNode()] });
        }
        if (url.pathname === `${PROJECT_PATH}/show`) {
          // Every field `handleShow` (src/daemon/rpc-handlers.ts) returns —
          // `lazy show`'s renderer destructures deep into this shape and
          // crashes on a partial object, which a real daemon never sends.
          return Response.json({
            task: fakeTask(), session: showSession, turns: [], commits: [], comments: [], journal: [],
            notes: { queued_ids: [], delivered_through: null }, chunks: [], reviews: [],
            sectionsServed: null,
            counts: { turns: 0, chunks: 0, commits: 0, comments: 0, journal: 0, children: 0, 'status-history': 0, 'tag-history': 0, reviews: 0 },
            loopProgress: null, raisedItems: [], turnReport: null, fileDecisions: [], artifacts: [],
            statusHistory: [], tagHistory: [], children: [], childSessions: {}, parent: null,
            retryStatus: null, orphanStatus: null, autoReactStatus: null, supervisorStatus: null,
            workingSubstate: null, mergeState: null, protection: null, serveState: null,
            paths: { worktreePath: null }, fileViolations: [], autoResumeQueue: null,
            upstreamLine: null,
          });
        }
        if (url.pathname === `${PROJECT_PATH}/storage`) {
          const method = (body as { method?: string }).method;
          const args = (body as { args?: Record<string, unknown> }).args ?? {};
          if (typeof method !== 'string' || !tables.storageMethods.has(method)) {
            // StorageMethodPolicy.lookup returns nil → storage_mapping nil →
            // render_command_refusal names the COMMAND, never the method —
            // mirror that exactly, refusal text included.
            return Response.json({ error: "Unknown or unsupported command 'storage'." }, { status: 404 });
          }
          if (method === 'getStoragePath') {
            return Response.json('/fake/storage/path');
          }
          if (method === 'createTask') {
            return Response.json(fakeTask({ id: 'task-2', code: 'new-task', status: 'backlog', goal: args.goal }));
          }
          if (method === 'updateTaskPrompt') {
            return Response.json({ id: 1, content: args.content ?? '', created_at: Date.now() });
          }
          if (method === 'getProjectSettings') {
            return Response.json(null);
          }
          if (method === 'getTask') {
            return Response.json(fakeTask({ id: 'task-2', code: 'new-task', status: 'backlog', goal: 'created' }));
          }
          if (method === 'resolveTask') {
            return Response.json({ task: fakeTask() });
          }
          if (method === 'createComment') {
            return Response.json({ id: 'comment-1', task_id: args.taskId, content: args.content, created_at: Date.now() });
          }
          return Response.json(
            { error: `stub has no canned answer for storage method '${method}' (admitted by the Rails table, not served here)` },
            { status: 501 },
          );
        }
        return Response.json({ error: `unexpected path ${url.pathname}` }, { status: 404 });
      },
    });
  }

  const env = () => ({ HOME: tmpHome, LAZY_DAEMON_BASE_DIR: daemonBase, LAZY_TEST: '', LAZY_IS_DAEMON: '' });

  async function bind() {
    stub = startStubProxy();
    await writeTeamsLogin(freshDir, {
      teamsUrl: `http://127.0.0.1:${stub.port}`,
      token: 'lz_cli_token_abc',
      project: 'acme/lazy-toy',
      projectId: '42',
    });
  }

  test('lazy list works on a freshly bound, never-locally-initialized clone', async () => {
    await bind();

    const result = await ctx.lazy(['list'], { cwd: freshDir, env: env() });

    expect(result.exitCode).toBe(0);
    expect(requests.some((r) => r.pathname === `${PROJECT_PATH}/list`)).toBe(true);
  });

  test('lazy show works on the same clone', async () => {
    await bind();

    const result = await ctx.lazy(['show', 'task-1'], { cwd: freshDir, env: env() });

    expect(result.exitCode).toBe(0);
  });

  // INVARIANT: a bound clone creates through the ONE `createTask` RPC, never a
  // storage create followed by separate writes Teams authorizes one by one —
  // that left promptless tasks behind when one was refused.
  test('lazy create works and reaches the proxy with the goal', async () => {
    await bind();

    const result = await ctx.lazy(['create', '--goal', 'Fix the thing'], {
      cwd: freshDir, env: env(),
    });

    expect(result.exitCode).toBe(0);
    const createRequest = requests.find((r) => r.pathname === `${PROJECT_PATH}/createTask`);
    expect(createRequest).toBeDefined();
    expect((createRequest?.body as any).goal).toBe('Fix the thing');
    expect(requests.some((r) => r.pathname === `${PROJECT_PATH}/storage` && (r.body as any).method === 'createTask')).toBe(false);
  });

  test('lazy comment works and reaches the proxy with the words', async () => {
    await bind();

    const result = await ctx.lazy(['comment', 'task-1', '-m', 'A paragraph of feedback.'], {
      cwd: freshDir, env: env(),
    });

    expect(result.exitCode).toBe(0);
    const commentRequest = requests.find(
      (r) => r.pathname === `${PROJECT_PATH}/storage` && (r.body as any).method === 'createComment',
    );
    expect(commentRequest).toBeDefined();
    expect((commentRequest?.body as any).args.content).toBe('A paragraph of feedback.');
  });

  test('a CLI command asking for a storage method the Rails table omits is refused naming the binding', async () => {
    await bind();

    // `lazy artifact rm` asks storage for `deleteTaskArtifact` — proxied by
    // RemoteStorage, refused by StorageMethodPolicy. This is one entry of the
    // refused-by-design register `test/unit/cli-storage-policy-parity.test.ts`
    // keeps; here it pins the CLI's END of the bargain: the refusal crosses
    // the real proxy shape and the CLI fails loudly with a refusal that names the binding, the refused method (the
    // route's own text names only 'storage') and the way forward.
    const result = await ctx.lazy(['artifact', 'rm', 'abc12345', 'note.txt'], { cwd: freshDir, env: env() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bound to Lazy Teams (acme/lazy-toy');
    expect(result.stderr).toContain("'storage.deleteTaskArtifact'");
    expect(result.stderr).toContain('lazy builder');
  });

  // INVARIANT: no per-command `<install> — <project>` banner. Which install a
  // clone is bound to changes rarely — like a git remote, which git push does
  // not announce every time (engineer, 2026-10-08). A bare `lazy login`
  // reports the binding when asked.
  test('remote-routed commands print no install/project banner', async () => {
    await bind();

    // Both routes: `list` goes through rpc-fallback's typed wrappers and
    // `create` through the `createTask` RPC.
    const listed = await ctx.lazy(['list'], { cwd: freshDir, env: env() });
    const created = await ctx.lazy(['create', '--goal', 'Another goal'], { cwd: freshDir, env: env() });

    for (const result of [listed, created]) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('— acme/lazy-toy');
    }
  });

  describe('lazy shell <task> --local', () => {
    let hosted: string;
    let agentClone: string;

    async function git(cwd: string, ...args: string[]): Promise<string> {
      const r = await runGit(args, { cwd });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr}`);
      return r.stdout.trim();
    }

    // The install's hosted repository with `main` and the task's branch on it
    // — what the Teams daemon's after-turn push leaves behind — and this clone
    // pointed at it the way `lazy clone` leaves it.
    beforeEach(async () => {
      hosted = join(freshDir, '..', `${freshDir.split('/').pop()}-hosted.git`);
      agentClone = `${hosted}-agent`;
      await runGit(['init', '-q', '--bare', '-b', 'main', hosted], { cwd: freshDir });
      await git(freshDir, 'branch', '-M', 'main');
      await git(freshDir, 'remote', 'add', 'origin', hosted);
      await git(freshDir, 'push', '-q', 'origin', 'main');
      await runGit(['clone', '-q', hosted, agentClone], { cwd: freshDir });
      await git(agentClone, 'config', 'user.email', 'agent@example.com');
      await git(agentClone, 'config', 'user.name', 'Agent');
      await git(agentClone, 'checkout', '-q', '-b', 'lazy/demo-task');
      await writeFile(join(agentClone, 'agent.txt'), 'agent work\n');
      await git(agentClone, 'add', '.');
      await git(agentClone, 'commit', '-q', '-m', 'agent work');
      await git(agentClone, 'push', '-q', 'origin', 'lazy/demo-task');
      await git(freshDir, 'fetch', '-q', 'origin');
      showSession = { id: 'sess-1', task_id: 'task-1', git_branch: 'lazy/demo-task', status: 'active' };
    });

    afterEach(async () => {
      await rm(hosted, { recursive: true, force: true });
      await rm(agentClone, { recursive: true, force: true });
      await rm(`${freshDir}-demo-task`, { recursive: true, force: true });
    });

    // INVARIANT: --local creates a plain-git checkout of the task branch that
    // TRACKS origin/lazy/<task>, so a plain `git push` lands on the task's
    // branch on the install. Lazy itself never pushes.
    test('creates a tracking checkout; a plain git push from it lands on the task branch', async () => {
      await bind();
      const checkout = `${freshDir}-demo-task`;

      const result = await ctx.lazy(['shell', 'demo-task', '--local', '--', 'git', 'rev-parse', '--abbrev-ref', '@{u}'], {
        cwd: freshDir, env: env(),
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('origin/lazy/demo-task');
      expect(result.stderr).toContain(checkout);
      expect(result.stderr).toContain('git push');
      expect(await git(checkout, 'log', '-1', '--format=%s')).toBe('agent work');

      await writeFile(join(checkout, 'mac.txt'), 'built on the mac\n');
      await git(checkout, 'add', '.');
      await git(checkout, 'commit', '-q', '-m', 'tested on the mac');
      // Nothing was pushed for the person.
      expect(await git(hosted, 'log', '-1', '--format=%s', 'lazy/demo-task')).toBe('agent work');
      await git(checkout, 'push', '-q');
      expect(await git(hosted, 'log', '-1', '--format=%s', 'lazy/demo-task')).toBe('tested on the mac');
    });

    // INVARIANT: a re-run never discards unpushed commits or uncommitted
    // changes; it fast-forwards only a clean checkout and otherwise leaves it.
    test('a re-run keeps unpushed and uncommitted work, and fast-forwards a clean checkout', async () => {
      await bind();
      const checkout = `${freshDir}-demo-task`;
      const run = () => ctx.lazy(['shell', 'demo-task', '--local', '--', 'true'], { cwd: freshDir, env: env() });
      expect((await run()).exitCode).toBe(0);

      // The agent moves on; the clean checkout fast-forwards.
      await writeFile(join(agentClone, 'agent.txt'), 'second turn\n');
      await git(agentClone, 'commit', '-q', '-am', 'second turn');
      await git(agentClone, 'push', '-q', 'origin', 'lazy/demo-task');
      const ff = await run();
      expect(ff.exitCode).toBe(0);
      expect(ff.stderr).toContain('Fast-forwarded');
      expect(await git(checkout, 'log', '-1', '--format=%s')).toBe('second turn');

      // Unpushed commit + uncommitted file, while the agent moves on again.
      await writeFile(join(checkout, 'mac.txt'), 'local\n');
      await git(checkout, 'add', '.');
      await git(checkout, 'commit', '-q', '-m', 'unpushed');
      await writeFile(join(checkout, 'wip.txt'), 'uncommitted\n');
      await writeFile(join(agentClone, 'agent.txt'), 'third turn\n');
      await git(agentClone, 'commit', '-q', '-am', 'third turn');
      await git(agentClone, 'push', '-q', 'origin', 'lazy/demo-task');

      const kept = await run();
      expect(kept.exitCode).toBe(0);
      expect(kept.stderr).toContain('Left as is');
      expect(await git(checkout, 'log', '-1', '--format=%s')).toBe('unpushed');
      expect(await git(checkout, 'status', '--porcelain')).toContain('wip.txt');
    });

    // INVARIANT: --host in a bound clone points at --local instead of a
    // generic refusal — the task's worktree is on the server.
    test('--host in a bound clone says to use --local', async () => {
      await bind();
      const result = await ctx.lazy(['shell', 'demo-task', '--host'], { cwd: freshDir, env: env() });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--local');
    });
  });
});
