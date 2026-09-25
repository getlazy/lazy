import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { join } from 'path';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { expectSuccess } from '../helpers/assertions';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskStatus, readTurns, readSessionJson, writeSessionJson, setTaskStatus, writeTurns } from '../helpers/storage';
import { randomUUID } from 'crypto';

/**
 * A `lazy start` that fails after the base is resolved must never wedge the
 * task. Before the fix, the supervisor's upstream-merge ref was resolved (a
 * forge fetch, run from inside the new worktree) AFTER the task had been
 * flipped to `working` and its first turn recorded; a fetch failure there
 * answered 500 and left `working` + a turn + no supervisor, which
 * `lazy unblock` refuses (409).
 */
describe('lazy start — late failures', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy({ withDaemon: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  /**
   * GitHub driver backed by a local bare remote whose upload-pack refuses to
   * serve a fetch issued from inside a task worktree. The base resolution runs
   * from the project root (succeeds); the supervisor's upstream-ref resolution
   * runs from the worktree (fails) — the late failure, reproduced exactly.
   */
  function githubRemoteFailingFromWorktrees(): string {
    const tomlPath = join(ctx.root, 'lazy.toml');
    const before = readFileSync(tomlPath, 'utf-8');
    const toml = before.replace('driver = "local"', 'driver = "github"');
    expect(toml).not.toBe(before);
    writeFileSync(tomlPath, toml);

    const bare = join(ctx.root, '.test-remote.git');
    expect(ctx.git('init', '--bare', bare).exitCode).toBe(0);
    if (ctx.git('remote', 'get-url', 'origin').exitCode === 0) {
      expect(ctx.git('remote', 'set-url', 'origin', bare).exitCode).toBe(0);
    } else {
      expect(ctx.git('remote', 'add', 'origin', bare).exitCode).toBe(0);
    }
    expect(ctx.git('push', '-u', 'origin', 'main').exitCode).toBe(0);

    const faultFlag = join(ctx.root, '.test-fetch-fault');
    writeFileSync(faultFlag, '1');
    const script = join(ctx.root, '.test-upload-pack.sh');
    writeFileSync(script, [
      '#!/bin/sh',
      `if [ -f '${faultFlag}' ]; then case "$PWD" in */worktrees/*) echo "simulated forge outage" >&2; exit 1;; esac; fi`,
      'exec git-upload-pack "$@"',
      '',
    ].join('\n'));
    chmodSync(script, 0o755);
    expect(ctx.git('config', 'remote.origin.uploadpack', script).exitCode).toBe(0);
    return faultFlag;
  }

  // INVARIANT: a start that fails resolving the supervisor's upstream-merge
  // ref leaves the task in its PRE-START status with no recorded turn, and a
  // retried start succeeds. Every fallible launch step runs before the task is
  // marked `working`; a failure after the flip wedged the task (working, a turn,
  // no supervisor — `lazy unblock` answers 409, a retried start "already has an
  // active session").
  test('upstream-ref failure without --force-local does not wedge the task', async () => {
    const faultFlag = githubRemoteFailingFromWorktrees();
    const taskId = await createTask(ctx, 'Late start failure', 'Do the thing');
    const before = readTaskStatus(ctx.root, taskId);

    const failed = await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS);
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stdout + failed.stderr).toContain('Failed to resolve upstream ref');

    expect(readTaskStatus(ctx.root, taskId)).toBe(before);
    expect(readTurns(ctx.root, taskId)).toEqual([]);

    // The outage clears; the same start now goes through.
    rmSync(faultFlag);
    expectSuccess(await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS));
    expect((await ctx.lazy(['wait', taskId])).exitCode).toBe(0);
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
  }, 60000);

  // INVARIANT: a task already wedged by the old late-failure shape — `working`,
  // only the human's turn 1 recorded (feedback still pending), no agent session,
  // no run and no response — is taken out of `working` by the reconciler
  // (`interrupted`), and where auto-resume may run it is relaunched with the
  // task prompt re-delivered verbatim. Auto-resume is budgeted, skipped for a
  // user-stopped session, and skipped on a per-user-credential project with no
  // service credential; there the task waits in `interrupted` for
  // `lazy resume`, which — unlike the old `working` wedge — accepts it.
  test('a task wedged by the old behaviour is relaunched by the daemon', async () => {
    const faultFlag = githubRemoteFailingFromWorktrees();
    const taskId = await createTask(ctx, 'Already wedged', 'Do the wedged thing');

    // A failed start (the new code) leaves exactly what the old code left
    // BEFORE its flip: a worktree and a turnless session. Add what the old
    // code wrote next — turn 1 carrying the prompt, and `working`.
    expect((await ctx.lazyMocked(['start', taskId, '--yes'], MOCK_CLAUDE_SUCCESS)).exitCode).not.toBe(0);
    rmSync(faultFlag);
    const session = readSessionJson(ctx.root, taskId)!;
    expect(session).not.toBeNull();
    writeTurns(ctx.root, taskId, [{
      id: randomUUID(),
      session_id: session.id,
      sequence: 1,
      role: 'human',
      content: 'Do the wedged thing',
      timestamp: Date.now() - 3600_000,
      actor: 'human',
      feedback_delivery: 'pending',
    }]);
    writeSessionJson(ctx.root, taskId, {
      ...session,
      container_name: null,
      agent_session_id: null,
      last_interaction_at: new Date(Date.now() - 3600_000).toISOString(),
    });
    setTaskStatus(ctx.root, taskId, 'working');

    // Poll the store rather than `lazy wait`, which returns on the first
    // non-working status — the recovery passes through `interrupted`.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const turns = readTurns(ctx.root, taskId);
      if (readTaskStatus(ctx.root, taskId) === 'blocked' && turns.some(t => t.role === 'agent')) break;
      await new Promise(r => setTimeout(r, 250));
    }
    expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
    const turns = readTurns(ctx.root, taskId);
    expect(turns.some(t => /disappeared/i.test(t.content))).toBe(true);
    expect(turns.some(t => /unconsumed feedback re-delivered/.test(t.content))).toBe(true);
    expect(turns.some(t => t.role === 'agent')).toBe(true);
  }, 60000);
});
