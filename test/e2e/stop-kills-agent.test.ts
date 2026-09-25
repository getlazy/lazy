/**
 * INVARIANT: stopping a host-process run stops the AGENT it started, not just
 * the supervisor — and stops nothing else.
 *
 * `stopRun` used to signal the supervisor's pid alone. The supervisor installs
 * no SIGTERM handler, so it died and the agent it had spawned was reparented to
 * init and kept running: holding the worktree, holding the agent bundle it
 * launched with, and free to finish its turn and commit into a worktree a later
 * run was already using. Under Docker the same stop kills a container and
 * everything in it, which is why this only ever showed up on the test-only host
 * runner — and why no suite there could assert the container half of what
 * `lazy upgrade` and a fleet roll rely on.
 *
 * The fix puts each supervisor in a process group of its own and signals the
 * GROUP. The second assertion is as load-bearing as the first: supervisors used
 * to inherit the DAEMON's process group, so a group signal aimed at the
 * inherited group would take the daemon and every other supervisor with it.
 *
 * Both halves need real processes, so this runs on the fake-binary seam — a real
 * daemon, a real `lazy supervise`, a real agent process, only the agent binary
 * faked.
 */

import { describe, test, expect } from 'bun:test';
import { readFile } from 'fs/promises';
import { setupTestLazy } from '../helpers/setup';
import { createTask } from '../helpers/fixtures';
import { expectSuccess } from '../helpers/assertions';
import { goSilentScenario } from '../helpers/fake-claude';
import { readSessionJson, readTaskStatus } from '../helpers/storage';
import { findSupervisorsForRoot } from '../helpers/daemon-registry';
import { getPidPath } from '../../src/daemon/paths';
import { isProcessRunning } from '../helpers/dead-pid';

/**
 * Running, not merely present. Every case below kills the agent's PARENT, so the
 * agent is reparented to PID 1 and is a zombie until reaped — and whether that
 * is prompt is a property of the environment. See `isProcessRunning`.
 */
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

/** Poll rather than sleep: the stop returns once, the processes exit on their own clock. */
async function untilDead(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

describe('lazy stop on the host-process runner', () => {
  test('kills the agent process, and leaves the daemon running', async () => {
    const ctx = await setupTestLazy({ fakeClaude: true });
    try {
      const taskId = await createTask(ctx, 'Holds a turn open', 'Work slowly');
      // The agent reports a tool call (so the supervisor sees a live, progressing
      // turn) and then waits — well past this test's own budget, so nothing here
      // can pass because the agent happened to finish on its own.
      await ctx.setClaudeScenario(goSilentScenario({ sessionId: 'stop-me', silentMs: 600_000 }));
      expectSuccess(await ctx.lazy(['start', taskId, '--yes']));

      expect(await until(async () => readTaskStatus(ctx.root, taskId), s => s === 'working', 30_000)).toBe('working');

      // Preconditions, each read from the OS rather than from lazy's records:
      // there is an agent process and a supervisor process to lose, and a daemon
      // that must survive. Without these the assertions below would pass on an
      // empty world.
      const invocations = await until(async () => ctx.claudeInvocations(), i => i.length > 0, 30_000);
      expect(invocations.length).toBeGreaterThan(0);
      const agentPid = invocations[0].pid;
      expect(typeof agentPid).toBe('number');
      expect(isAlive(agentPid)).toBe(true);

      const supervisors = await until(async () => findSupervisorsForRoot(ctx.root), pids => pids.length > 0, 30_000);
      expect(supervisors.length).toBeGreaterThan(0);

      const daemonPid = parseInt((await readFile(getPidPath(ctx.root), 'utf-8')).trim(), 10);
      expect(isAlive(daemonPid)).toBe(true);

      const stopped = await ctx.lazy(['stop', taskId, '--reason', 'change of direction']);
      expectSuccess(stopped);

      // INVARIANT: stopping a WORK turn still reports the work-turn ending —
      // blocked, auto-resume off, an unblock owed. `lazy stop` now has a second
      // ending for an in-flight review or ask (status restored, no gate), and
      // the two must not be confused: the one printed here is the one that
      // leaves a task nobody will resume.
      expect(stopped.stdout).toContain('will not auto-resume');
      expect(stopped.stdout).toContain('lazy unblock');

      // THE BUG: this is what used to be left running.
      expect(await untilDead(agentPid, 30_000)).toBe(true);
      // And the supervisor with it, which is the part that always worked.
      expect(await until(async () => findSupervisorsForRoot(ctx.root), pids => pids.length === 0, 30_000)).toEqual([]);

      // THE BLAST RADIUS: a group signal sent at the group the supervisor used to
      // INHERIT would have killed the daemon here.
      expect(isAlive(daemonPid)).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  }, 180_000);

  /**
   * INVARIANT: an agent whose supervisor died FIRST is still reachable.
   *
   * This is the same leak arriving by the route the group mechanism could not
   * originally see. `pgid` is read off the supervisor's own `/proc` entry, which
   * is gone once it dies, so the stop fell back to signalling a dead pid; and
   * `removeRun` was gated on the SUPERVISOR being alive, so it skipped the kill
   * outright, deleted the run record, and left `src/task/cleanup.ts` to delete
   * the worktree the agent was still writing in.
   *
   * The supervisor is SIGKILLed rather than asked to stop: the point is a
   * supervisor that had no chance to take its agent with it, which is what a
   * crash, an OOM kill or a force-kill actually looks like.
   */
  test('stops an agent whose supervisor died first', async () => {
    const ctx = await setupTestLazy({ fakeClaude: true });
    try {
      const taskId = await createTask(ctx, 'Outlives its supervisor', 'Work slowly');
      await ctx.setClaudeScenario(goSilentScenario({ sessionId: 'orphaned', silentMs: 600_000 }));
      expectSuccess(await ctx.lazy(['start', taskId, '--yes']));

      expect(await until(async () => readTaskStatus(ctx.root, taskId), s => s === 'working', 30_000)).toBe('working');

      const invocations = await until(async () => ctx.claudeInvocations(), i => i.length > 0, 30_000);
      const agentPid = invocations[0].pid;
      const supervisors = await until(async () => findSupervisorsForRoot(ctx.root), pids => pids.length > 0, 30_000);
      expect(supervisors.length).toBeGreaterThan(0);

      // The supervisor dies with no chance to clean up. Its agent is reparented
      // and keeps running — the precondition, asserted so this cannot pass on an
      // agent that simply exited with its parent.
      for (const pid of supervisors) process.kill(pid, 'SIGKILL');
      expect(await untilDead(supervisors[0], 30_000)).toBe(true);
      expect(isAlive(agentPid)).toBe(true);

      expectSuccess(await ctx.lazy(['stop', taskId, '--reason', 'orphaned agent']));

      expect(await untilDead(agentPid, 30_000)).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  }, 180_000);

  /**
   * INVARIANT: the daemon's own shutdown sweep reaches an orphaned agent too.
   *
   * The per-task route above is not enough, and proving only that one hid this:
   * `discoverRunningRuns` skipped any record whose SUPERVISOR pid was dead, and
   * the shutdown sweep, the restart reaper and `lazy upgrade` all act on what it
   * returns. So an agent whose supervisor died first survived daemon shutdown,
   * daemon restart and an upgrade, and could only be reached by a human naming
   * the task — while daemon shutdown is the exact scenario this work exists for
   * ("the run was stopped, and the agent was still alive ninety seconds later").
   */
  test('the daemon shutdown sweep stops an agent whose supervisor died first', async () => {
    const ctx = await setupTestLazy({ fakeClaude: true });
    try {
      const taskId = await createTask(ctx, 'Orphan across shutdown', 'Work slowly');
      await ctx.setClaudeScenario(goSilentScenario({ sessionId: 'orphan-sweep', silentMs: 600_000 }));
      expectSuccess(await ctx.lazy(['start', taskId, '--yes']));

      expect(await until(async () => readTaskStatus(ctx.root, taskId), s => s === 'working', 30_000)).toBe('working');

      const invocations = await until(async () => ctx.claudeInvocations(), i => i.length > 0, 30_000);
      const agentPid = invocations[0].pid;
      const supervisors = await until(async () => findSupervisorsForRoot(ctx.root), pids => pids.length > 0, 30_000);
      expect(supervisors.length).toBeGreaterThan(0);

      const daemonPid = parseInt((await readFile(getPidPath(ctx.root), 'utf-8')).trim(), 10);

      // Orphan the agent, and confirm it really is orphaned before going on.
      for (const pid of supervisors) process.kill(pid, 'SIGKILL');
      expect(await untilDead(supervisors[0], 30_000)).toBe(true);
      expect(isAlive(agentPid)).toBe(true);

      // Nobody names the task: the daemon is simply told to stop, and its sweep
      // has to find the orphan on its own.
      process.kill(daemonPid, 'SIGTERM');

      expect(await untilDead(daemonPid, 30_000)).toBe(true);
      expect(await untilDead(agentPid, 30_000)).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  }, 180_000);

  /**
   * Drive one signal at a daemon holding a live turn open, and assert that the
   * supervisor and its agent die with it.
   *
   * The daemon is signalled directly rather than through `ctx.cleanup()`, which
   * sweeps supervisors itself and would answer for the daemon.
   *
   * `repeat` sends the SAME signal again, in a tight burst, and additionally
   * requires the shutdown to have RUN TO COMPLETION — the task recorded
   * `interrupted`, which `stop()` only reaches after the whole supervisor sweep.
   *
   * Completion is the assertion rather than the leak, and deliberately so. The
   * window in which a pre-empting repeat strands a supervisor is the gap between
   * the signal arriving and the sweep signalling anything, measured at ~4ms on a
   * warm daemon: a test aimed at it would pass or fail on scheduler luck, which
   * is worse than no test. The records and the storage close sit ~100ms further
   * on, so a repeat that exits early misses those every time — and they are the
   * half that cannot be reconstructed afterwards. A kill landing inside a
   * storage write leaves a `.storage-lock` naming a pid that will one day be
   * recycled, at which point it looks held forever.
   */
  async function expectSignalStopsEverything(
    signal: NodeJS.Signals,
    opts: { sessionId: string; repeat?: boolean } = { sessionId: 'daemon-signal' },
  ) {
    const ctx = await setupTestLazy({ fakeClaude: true });
    try {
      const taskId = await createTask(ctx, 'Holds a turn open', 'Work slowly');
      await ctx.setClaudeScenario(goSilentScenario({ sessionId: opts.sessionId, silentMs: 600_000 }));
      expectSuccess(await ctx.lazy(['start', taskId, '--yes']));

      expect(await until(async () => readTaskStatus(ctx.root, taskId), s => s === 'working', 30_000)).toBe('working');

      const invocations = await until(async () => ctx.claudeInvocations(), i => i.length > 0, 30_000);
      const agentPid = invocations[0].pid;
      expect(isAlive(agentPid)).toBe(true);
      const supervisors = await until(async () => findSupervisorsForRoot(ctx.root), pids => pids.length > 0, 30_000);
      expect(supervisors.length).toBeGreaterThan(0);

      const daemonPid = parseInt((await readFile(getPidPath(ctx.root), 'utf-8')).trim(), 10);
      process.kill(daemonPid, signal);

      if (opts.repeat) {
        // A burst rather than one repeat: the exact moment `stop()` reaches its
        // first await is not ours to schedule, and every one of these must be
        // absorbed rather than shortcut the sweep.
        for (let i = 0; i < 5; i++) {
          await new Promise(r => setTimeout(r, 20));
          try { process.kill(daemonPid, signal); } catch { /* already exited — fine */ }
        }
      }

      expect(await untilDead(daemonPid, 30_000)).toBe(true);
      expect(findSupervisorsForRoot(ctx.root)).toEqual([]);
      expect(isAlive(agentPid)).toBe(false);

      if (opts.repeat) {
        // Written by `interruptForDaemonStop`, on the far side of the whole
        // sweep — so this is false the moment a repeat signal cuts the shutdown
        // short, and with it go the storage close and the lock release.
        expect(await readTaskStatus(ctx.root, taskId)).toBe('interrupted');
      }
    } finally {
      await ctx.cleanup();
    }
  }

  /**
   * INVARIANT: a SIGTERM'd daemon takes its supervisors — and their agents —
   * with it.
   *
   * `stop()` says "Terminate active supervisors before shutting down. Without
   * this, supervisors become orphans", and on the signal path it did not: the
   * handler called `stop()` fire-and-forget and then `process.exit(0)`, which
   * never reached the sweep's first `await`. From a terminal that was invisible,
   * because Ctrl-C went to the daemon's whole foreground process group and the
   * supervisors were in it. They are not any more — they lead groups of their
   * own so a stop can reach their agents — so the sweep is now the only thing
   * that stops them, and it has to actually run.
   */
  test('a SIGTERM to the daemon stops its supervisors and their agents', async () => {
    await expectSignalStopsEverything('SIGTERM', { sessionId: 'daemon-term' });
  }, 180_000);

  /**
   * INVARIANT: SIGHUP is a shutdown, not a process the OS may simply end.
   *
   * Closing the terminal on a foreground daemon sends SIGHUP, and SIGHUP had no
   * handler — only SIGTERM and SIGINT were registered — so the default
   * disposition killed the daemon outright and `stop()` never ran. That was
   * survivable by accident while supervisors shared the daemon's process group,
   * because the same hangup reached them too. They lead their own groups now, so
   * without this the terminal closing would strand every one of them.
   */
  test('a SIGHUP to the daemon stops its supervisors and their agents', async () => {
    await expectSignalStopsEverything('SIGHUP', { sessionId: 'daemon-hup' });
  }, 180_000);

  /**
   * INVARIANT: a repeat signal joins the shutdown in flight instead of
   * pre-empting it.
   *
   * `stop()` is idempotent, so a second call returns at once — which meant a
   * second Ctrl-C landed on `process.exit(0)` while the first was still
   * discovering what to stop, and leaked exactly what the first would have
   * killed. The impatient caller still gets its exit; the shutdown budget caps
   * the wait either way.
   */
  test('a second signal during shutdown does not cut the shutdown short', async () => {
    await expectSignalStopsEverything('SIGINT', { sessionId: 'daemon-int-twice', repeat: true });
  }, 180_000);
});

describe('a stopped task stays parked where the stop put it', () => {
  /**
   * INVARIANT: a stopped work turn stays `blocked` across reconcile ticks — it
   * is never relabelled `interrupted` afterwards.
   *
   * `lazy stop` writes a "Stopped by user" error response so any in-flight
   * waiter wakes (see stopTask). The paused-response sweep, a net for turns a
   * supervisor finished after their task was parked, read that response on the
   * now-`blocked` task and pushed it through the ordinary error path — which
   * parks `interrupted`. The stop gate still held auto-resume off, but the task
   * no longer looked stopped: surfaces offered "restart" for a crash instead of
   * "resume" for a stop, and `lazy list` lost the distinction the stop exists
   * to draw.
   */
  test('a stopped task is still blocked, and still stopped, three ticks later', async () => {
    const ctx = await setupTestLazy({ fakeClaude: true });
    try {
      const taskId = await createTask(ctx, 'Stopped and left alone', 'Work slowly');
      await ctx.setClaudeScenario(goSilentScenario({ sessionId: 'stay-stopped', silentMs: 600_000 }));
      expectSuccess(await ctx.lazy(['start', taskId, '--yes']));
      expect(await until(async () => readTaskStatus(ctx.root, taskId), s => s === 'working', 30_000)).toBe('working');
      await until(async () => ctx.claudeInvocations(), i => i.length > 0, 30_000);

      expectSuccess(await ctx.lazy(['stop', taskId, '--reason', 'leave it here']));
      expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');

      // The daemon reconciles every 5s; watch three ticks.
      const deadline = Date.now() + 16_000;
      while (Date.now() < deadline) {
        expect(readTaskStatus(ctx.root, taskId)).toBe('blocked');
        await new Promise(r => setTimeout(r, 500));
      }
      expect(readSessionJson(ctx.root, taskId)?.user_stopped).toBe(true);

      // INVARIANT: `lazy list` marks a stopped task [STOPPED]. A stop parks the
      // task `blocked` — the same status as a task that finished its turn — so
      // the marker is the only thing on that line telling the two apart. It was
      // keyed on `interrupted`, a status a stop no longer produces.
      const listed = await ctx.lazy(['list']);
      expectSuccess(listed);
      const line = listed.stdout.split('\n').find(l => l.includes(taskId)) ?? '';
      expect(line).toContain('[STOPPED]');
    } finally {
      await ctx.cleanup();
    }
  }, 180_000);
});
