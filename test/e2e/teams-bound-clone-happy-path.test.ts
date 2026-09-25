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
        if (url.pathname === `${PROJECT_PATH}/list`) {
          return Response.json({ tree: [fakeTreeNode()] });
        }
        if (url.pathname === `${PROJECT_PATH}/show`) {
          // Every field `handleShow` (src/daemon/rpc-handlers.ts) returns —
          // `lazy show`'s renderer destructures deep into this shape and
          // crashes on a partial object, which a real daemon never sends.
          return Response.json({
            task: fakeTask(), session: null, turns: [], commits: [], comments: [], journal: [],
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

  test('lazy create works and reaches the proxy with the goal', async () => {
    await bind();

    const result = await ctx.lazy(['create', '--goal', 'Fix the thing'], {
      cwd: freshDir, env: env(),
    });

    expect(result.exitCode).toBe(0);
    const createRequest = requests.find(
      (r) => r.pathname === `${PROJECT_PATH}/storage` && (r.body as any).method === 'createTask',
    );
    expect(createRequest).toBeDefined();
    expect((createRequest?.body as any).args.goal).toBe('Fix the thing');
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

    // `lazy scratch list` asks storage for `listScratchFiles` — proxied by
    // RemoteStorage, refused by StorageMethodPolicy. This is one entry of the
    // refused-by-design register `test/unit/cli-storage-policy-parity.test.ts`
    // keeps; here it pins the CLI's END of the bargain: the refusal crosses
    // the real proxy shape and the CLI fails loudly with a refusal that names the binding, the refused method (the
    // route's own text names only 'storage') and the way forward.
    const result = await ctx.lazy(['scratch', 'list'], { cwd: freshDir, env: env() });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bound to Lazy Teams (acme/lazy-toy');
    expect(result.stderr).toContain("'storage.listScratchFiles'");
    expect(result.stderr).toContain('lazy builder');
  });

  test('every remote-routed command names the install and project on its first line', async () => {
    await bind();

    // Both routes, not just one: `list` goes through `rpc-fallback.ts`'s typed
    // wrappers and `create` through the `storage` proxy. The banner lived in
    // `requireStorage()` before, which only the second of those passes
    // through — so a test covering one route alone could not see the gap the
    // move to the dispatcher fixed.
    const listed = await ctx.lazy(['list'], { cwd: freshDir, env: env() });
    const created = await ctx.lazy(['create', '--goal', 'Another goal'], { cwd: freshDir, env: env() });

    for (const result of [listed, created]) {
      expect(result.exitCode).toBe(0);
      const line = result.stderr.split('\n')[0];
      expect(line).toContain('127.0.0.1');
      expect(line).toContain('acme/lazy-toy');
    }

    const result = listed;
    // The banner is printed to STDERR, synchronously, before dispatch() runs
    // the command — in a real terminal (where stdout/stderr interleave by
    // write order) it is the actual first line printed. `WorkResult` captures
    // the two streams separately, so this checks the guarantee where it is
    // actually made rather than re-deriving a combined ordering the test
    // harness does not preserve.
    const firstStderrLine = result.stderr.split('\n')[0];
    expect(firstStderrLine).toContain('127.0.0.1');
    expect(firstStderrLine).toContain('acme/lazy-toy');
  });
});
