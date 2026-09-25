/**
 * INVARIANT: a fake-binary (host-process) suite leaves no live `lazy supervise`
 * process behind.
 *
 * The daemon spawns supervisors detached and unref'd, so killing the daemon does
 * not kill them, and their pidfiles live under the SUPERVISOR's `$HOME/.lazy/run`
 * — not anywhere the harness used to look. Three such processes once outlived
 * their suite, kept rewriting the single `mcpServers.lazy` entry in the shared
 * `$HOME/.claude.json`, and answered a REAL agent's `lazy_commit` against a
 * /tmp worktree that had already been deleted. Teardown hygiene here is an
 * isolation property, not tidiness.
 *
 * This drives the whole path end to end: a real supervisor, a real cleanup().
 * The matcher and the sweep are unit-covered in daemon-registry.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { setupTestLazy } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { goSilentScenario } from '../helpers/fake-claude';
import { readTaskStatus } from '../helpers/storage';
import { findSupervisorsForRoot } from '../helpers/daemon-registry';
import { isProcessRunning } from '../helpers/dead-pid';

/** Running, not merely present — cleanup kills the agent's parent. See the helper. */
function isAlive(pid: number): boolean {
  return isProcessRunning(pid);
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, budgetMs: number): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    last = await read();
  }
  return last;
}

describe('host-process supervisors do not outlive their test context', () => {
  test('cleanup() reaps a supervisor that is still mid-turn', async () => {
    const ctx = await setupTestLazy({ fakeClaude: true });
    const root = ctx.root;
    try {
      const taskId = await createTask(ctx, 'Leaks a supervisor', 'Work slowly');
      // The agent stays alive and silent — the state a suite ending early leaves
      // behind, and the one where the supervisor is certainly still running.
      await ctx.setClaudeScenario(goSilentScenario({ sessionId: 'leaky', silentMs: 120_000 }));
      expectSuccess(await ctx.lazy(['start', taskId, '--yes']));

      const status = await until(async () => readTaskStatus(root, taskId), s => s === 'working', 20_000);
      expect(status).toBe('working');

      // Precondition: there really is a supervisor to leak. Without this the
      // assertion below would pass on an empty world and prove nothing.
      const running = await until(async () => findSupervisorsForRoot(root), pids => pids.length > 0, 20_000);
      expect(running.length).toBeGreaterThan(0);
    } finally {
      await ctx.cleanup();
    }

    expect(findSupervisorsForRoot(root)).toEqual([]);
  }, 120_000);

  /**
   * INVARIANT: the same cleanup leaves no live AGENT behind either.
   *
   * Reaping the supervisor by pid only reparents its agent to init, and that
   * agent goes on holding a worktree cleanup is about to delete — the same leak
   * `lazy stop` had, arriving through the harness's own sweep instead. The
   * supervisor assertion above cannot see it: the supervisor really is gone.
   */
  test('cleanup() reaps the agent the supervisor spawned, not just the supervisor', async () => {
    const ctx = await setupTestLazy({ fakeClaude: true });
    const root = ctx.root;
    let agentPid: number | undefined;
    try {
      const taskId = await createTask(ctx, 'Leaks an agent', 'Work slowly');
      await ctx.setClaudeScenario(goSilentScenario({ sessionId: 'leaky-agent', silentMs: 600_000 }));
      expectSuccess(await ctx.lazy(['start', taskId, '--yes']));

      const status = await until(async () => readTaskStatus(root, taskId), s => s === 'working', 20_000);
      expect(status).toBe('working');

      // Precondition: a real agent process, named by the fake from inside itself.
      const invocations = await until(async () => ctx.claudeInvocations(), i => i.length > 0, 20_000);
      agentPid = invocations[0].pid;
      expect(isAlive(agentPid)).toBe(true);
    } finally {
      await ctx.cleanup();
    }

    expect(findSupervisorsForRoot(root)).toEqual([]);
    expect(isAlive(agentPid!)).toBe(false);
  }, 120_000);
});
