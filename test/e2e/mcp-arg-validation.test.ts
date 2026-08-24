/**
 * INVARIANT: POST /mcp/:taskId/:toolName validates its body against the tool's
 * declared inputSchema BEFORE dispatch. A body that violates it produces a 400
 * naming the field — and NO WRITE.
 *
 * Regression (promoted from a follow-up on fix-watchdog-30min, where this bit
 * for real): the route did `body.arguments ?? {}` and dispatched. An agent
 * hand-rolling the documented HTTP fallback posted `{"message": "..."}` without
 * the `{"arguments": {...}}` envelope, so `args.message` arrived undefined and
 * lazy_commit ran `git commit -m undefined` — producing commit e0d731a whose
 * message was the literal string "undefined". lazy_journal wrote an empty entry
 * the same way.
 *
 * The "no commit was created" assertions are the point of this file. A 400 that
 * still wrote something would be the same corruption with better manners.
 *
 * The daemon is the REAL one (startDaemonServer on a unix socket) because the
 * validation lives in that route.
 */

import { describe, test, beforeEach, afterEach, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { startDaemonServer, type RunningDaemon } from '../../src/daemon/server';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { pinConfig } from '../helpers/pin-config';
import { makeDaemonBaseDir, pinDaemonBaseDir, removeDaemonBaseDir } from '../helpers/daemon-base-dir';
import { findFullTaskId, worktreePathFor } from '../helpers/storage';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { mintMcpToken, clearMcpTokenCache } from '../../src/daemon/mcp-tokens';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import { isolateInProcessDaemonEnv } from '../helpers/in-process-daemon';

const SHARED_TOKEN = 'shared-daemon-token-arg-validation';

// This suite runs a daemon IN-PROCESS; keep the LAZY_IS_DAEMON flag that
// startDaemonServer() sets process-wide from leaking into later test files.
isolateInProcessDaemonEnv();

describe('MCP route validates tool arguments', () => {
  let ctx: TestContext;
  let tmpDir: string;
  let socketPath: string;
  let daemon: RunningDaemon | undefined;
  let restoreConfig: (() => void) | undefined;
  let daemonBaseDir: string;
  let restoreDaemonBaseDir: (() => void) | undefined;

  let taskShort: string;
  let taskId: string;
  let taskToken: string;
  let builderToken: string;
  let worktree: string;

  beforeEach(async () => {
    process.env.LAZY_TEST = '1';
    // Set BEFORE setupTestLazy so CLI subprocesses inherit it — the MCP token
    // registry lives in the daemon state dir, never the developer's real one.
    daemonBaseDir = await makeDaemonBaseDir();
    restoreDaemonBaseDir = pinDaemonBaseDir(daemonBaseDir);
    clearMcpTokenCache();

    ctx = await setupTestLazy();
    // In-process daemon: without this, loadConfig walks up from `bun test`'s cwd
    // (lazy's own worktree) and adopts lazy's real storage path.
    restoreConfig = pinConfig(ctx.root);

    taskShort = await createTask(ctx, 'Task under validation', 'Exercise MCP argument validation.');
    // `start` is what creates the worktree and branch this test commits into.
    expectSuccess(await ctx.lazyMocked(['start', taskShort, '--yes'], MOCK_CLAUDE_SUCCESS));
    taskId = findFullTaskId(ctx.root, taskShort);
    worktree = worktreePathFor(ctx.root, taskShort);

    taskToken = await mintMcpToken(ctx.root, { kind: 'task', taskId }, 'lazy-validate');
    builderToken = await mintMcpToken(ctx.root, { kind: 'builder' }, 'builder-validate');

    tmpDir = await mkdtemp(join(tmpdir(), 'lazy-mcp-argval-'));
    socketPath = join(tmpDir, 'test.sock');
    daemon = await startDaemonServer({ socketPath, token: SHARED_TOKEN, projectRoot: ctx.root });
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    restoreConfig?.();
    restoreConfig = undefined;
    clearMcpTokenCache();
    // Reap the daemon FIRST: cleanup resolves its pidfile through
    // LAZY_DAEMON_BASE_DIR, so unpinning before this looks under the default
    // base dir and leaves the daemon running.
    await ctx?.cleanup();
    restoreDaemonBaseDir?.();
    restoreDaemonBaseDir = undefined;
    if (daemonBaseDir) await removeDaemonBaseDir(daemonBaseDir);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  /** POST a RAW body (no envelope assumptions) to the MCP route. */
  function post(token: string, segment: string, tool: string, body: string): Promise<Response> {
    return fetch(`http://localhost/mcp/${encodeURIComponent(segment)}/${encodeURIComponent(tool)}`, {
      unix: socketPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Lazy-Project': ctx.root,
      },
      body,
    } as any);
  }

  /** Every commit subject on the task branch, newest first. */
  function commitSubjects(): string[] {
    const result = spawnSyncUnsupervised(['git', 'log', '--format=%s'], { cwd: worktree, stdout: 'pipe', stderr: 'pipe' });
    return result.stdout.toString().trim().split('\n').filter(Boolean);
  }

  async function dirtyTheWorktree(marker: string): Promise<void> {
    await writeFile(join(worktree, 'validation-fixture.txt'), `${marker}\n`, 'utf-8');
  }

  // INVARIANT — THE REGRESSION. The exact body that produced the "undefined"
  // commit must be rejected, and must leave git untouched.
  test('a lazy_commit body without the arguments envelope is a 400 and creates NO commit', async () => {
    await dirtyTheWorktree('no-envelope');
    const before = commitSubjects();

    const resp = await post(taskToken, taskShort, 'lazy_commit', JSON.stringify({ message: 'should never land' }));

    expect(resp.status).toBe(400);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('arguments envelope');
    expect(body.error).toContain("'message'");
    // The fix is shown, not just the complaint.
    expect(body.error).toContain('"arguments"');

    // INVARIANT: nothing was written. A 400 that still committed would be the
    // same corruption with better manners.
    expect(commitSubjects()).toEqual(before);
    expect(commitSubjects().some(s => s === 'undefined' || s === 'should never land')).toBe(false);
  });

  // The other half of the same bug: with the envelope present but the required
  // field empty, `git commit -m ''` must not run either.
  test('a lazy_commit with an empty message is a 400 and creates NO commit', async () => {
    await dirtyTheWorktree('empty-message');
    const before = commitSubjects();

    const resp = await post(taskToken, taskShort, 'lazy_commit', JSON.stringify({ arguments: { message: '' } }));

    expect(resp.status).toBe(400);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain("'message' must not be empty");
    expect(commitSubjects()).toEqual(before);
  });

  test('a lazy_commit with a non-string message is a 400 naming the expected type', async () => {
    await dirtyTheWorktree('wrong-type');
    const before = commitSubjects();

    const resp = await post(taskToken, taskShort, 'lazy_commit', JSON.stringify({ arguments: { message: 42 } }));

    expect(resp.status).toBe(400);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain("'message' must be string, got number");
    expect(commitSubjects()).toEqual(before);
  });

  // INVARIANT: validation must not break the calls that were always correct.
  // A test file that only proves rejection could be satisfied by a route that
  // rejects everything.
  test('a well-formed lazy_commit still works', async () => {
    await dirtyTheWorktree('valid');

    const resp = await post(
      taskToken,
      taskShort,
      'lazy_commit',
      JSON.stringify({ arguments: { message: 'a real commit message' } }),
    );

    expect(resp.status).toBe(200);
    const body = await resp.json() as { result?: { committed?: boolean } };
    expect(body.result?.committed).toBe(true);
    expect(commitSubjects()[0]).toBe('a real commit message');
  });

  test('an unknown parameter is a 400 that suggests the intended one', async () => {
    const resp = await post(
      taskToken,
      taskShort,
      'lazy_commit',
      JSON.stringify({ arguments: { mesage: 'typo' } }),
    );

    expect(resp.status).toBe(400);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('Unknown parameter(s)');
    expect(body.error).toContain('did you mean: message');
  });

  // A malformed body used to be swallowed by `.catch(() => ({}))` and dispatched
  // as an empty call — a truncated payload silently became a different request.
  test('a body that is not valid JSON is a 400, not a silently empty call', async () => {
    const resp = await post(builderToken, '_', 'lazy_status', '{"arguments": {');

    expect(resp.status).toBe(400);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('not valid JSON');
  });

  test('a body that is a JSON array is a 400', async () => {
    const resp = await post(builderToken, '_', 'lazy_status', '[1,2,3]');

    expect(resp.status).toBe(400);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('must be a JSON object');
  });

  // A no-argument tool legitimately serializes to `{}` — that must keep working,
  // or the envelope rule would break every parameterless call.
  test('an empty body still works for a tool that needs no arguments', async () => {
    const resp = await post(builderToken, '_', 'lazy_status', JSON.stringify({}));
    expect(resp.status).toBe(200);
  });

  // lazy_journal was corrupted the same way — an empty entry from an
  // envelope-less body. Same rule, second tool, so the fix is proven to live in
  // the route rather than in one handler.
  test('a lazy_journal body without the envelope is a 400', async () => {
    const resp = await post(taskToken, taskShort, 'lazy_journal', JSON.stringify({ message: 'stray' }));

    expect(resp.status).toBe(400);
    const body = await resp.json() as { error?: string };
    expect(body.error).toContain('arguments envelope');
  });
});
