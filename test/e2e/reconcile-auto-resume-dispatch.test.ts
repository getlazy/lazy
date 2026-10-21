import { describe, test, beforeEach, afterEach, afterAll, expect } from 'bun:test';
import { join, resolve } from 'path';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { setupTestLazy, type TestContext } from '../helpers/setup';
import { createTask, MOCK_CLAUDE_SUCCESS } from '../helpers/fixtures';
import { readTaskStatus } from '../helpers/storage';
import { enableInProcessTestMode } from '../helpers/in-process-test-mode';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { withLaunchInFlight } from '../../src/runner/launch-in-flight';
import type { Runner } from '../../src/runner';

// In-process and daemonless, like test/e2e/reconcile.test.ts.
enableInProcessTestMode();

// autoResumeTask is lazy's own launch function, replaced here because this
// daemonless in-process harness has no runner to launch into. The stand-in
// mirrors the real one's shape: it flips the task to `working` first (the
// real one does so under the lifecycle lock, BEFORE the upstream fetch and the
// image build), runs a nested runner-style launch registration to completion,
// then blocks — a launch stuck in a minutes-long image build. Everything the
// reconciler does around it is real.
const releases = new Map<string, () => void>();
const launched: string[] = [];
const autoResumePath = resolve(import.meta.dir, '../../src/utils/auto-resume.ts');
const realAutoResume = { ...(await import(autoResumePath)) };
await mockModule(autoResumePath, () => ({
  ...realAutoResume,
  autoResumeTask: async (
    storage: { updateTaskStatus: (id: string, status: string, actor: string) => Promise<unknown> },
    task: { id: string },
  ) => {
    launched.push(task.id);
    await storage.updateTaskStatus(task.id, 'working', 'system');
    await withLaunchInFlight(`lazy-inner-${task.id}`, task.id, async () => {});
    await new Promise<void>(res => releases.set(task.id, res));
    return false;
  },
}));
afterAll(() => restoreMockedModules());

const { reconcileTasks, settleAutoResumes } = await import('../../src/utils/reconcile');
const { launchInFlight } = await import('../../src/runner/launch-in-flight');
const { openProjectStorage } = await import('../../src/daemon/rpc-handlers');
const { recordProjectAutoResume } = await import('../../src/daemon/auto-resume-queue');
const { computeTaskWorkingSubstate } = await import('../../src/utils/working-run');
const { loadConfig } = await import('../../src/config/loader');

// Reads as "no run" — the launch has not started a container yet.
const noRunRunner = {
  type: 'docker',
  runNameForTask: (ref: string) => `lazy-${ref}`,
  isRunning: async () => false,
} as unknown as Runner;

function tasksDirFor(root: string): string {
  const toml = readFileSync(join(root, 'lazy.toml'), 'utf-8');
  const m = toml.match(/^external_path\s*=\s*"(.+)"/m);
  if (m && m[1]) return join(m[1], 'tasks');
  return join(root, '.lazy', 'tasks');
}

function fullId(root: string, short: string): string {
  const match = readdirSync(tasksDirFor(root)).find(e => e.startsWith(short));
  if (!match) throw new Error(`no task ${short}`);
  return match;
}

/** A dead run: working, past the grace period, no container, no response. */
function makeDead(root: string, id: string): void {
  const dir = join(tasksDirFor(root), id);
  const task = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf-8'));
  task.status = 'working';
  writeFileSync(join(dir, 'task.json'), JSON.stringify(task, null, 2));
  const session = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf-8'));
  session.last_interaction_at = new Date(Date.now() - 3600000).toISOString();
  writeFileSync(join(dir, 'session.json'), JSON.stringify(session, null, 2));
}

function backdate(root: string, id: string): void {
  const p = join(tasksDirFor(root), id, 'session.json');
  const session = JSON.parse(readFileSync(p, 'utf-8'));
  session.last_interaction_at = new Date(Date.now() - 3600000).toISOString();
  writeFileSync(p, JSON.stringify(session, null, 2));
}

function crashTurns(root: string, id: string): number {
  const p = join(tasksDirFor(root), id, 'turns.json');
  if (!existsSync(p)) return 0;
  const turns = (JSON.parse(readFileSync(p, 'utf-8')) as { turns: Array<Record<string, unknown>> }).turns;
  return turns.filter(t => String(t.content).includes('[Agent crashed]')).length;
}

describe('reconciler: auto-resume launches run off the sweep', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestLazy();
  });

  afterEach(async () => {
    for (const r of releases.values()) r();
    await settleAutoResumes();
    releases.clear();
    launched.length = 0;
    await ctx.cleanup();
  });

  // INVARIANT: one slow auto-resume launch never holds up crash recovery for
  // any other task. The launch (sandbox, upstream-ref fetch, image build with
  // no timeout, container start) used to be awaited inside the working sweep,
  // so every other dead run stayed working(not-alive) until it finished — and
  // after five minutes the tick timeout force-started an overlapping tick.
  test('a blocked launch does not stop a second dead task being recorded as crashed in the same tick', async () => {
    const a = await createTask(ctx, 'Slow launch', 'Do work');
    const b = await createTask(ctx, 'Also dead', 'Do work');
    await ctx.lazyMocked(['start', a, '--yes'], MOCK_CLAUDE_SUCCESS);
    await ctx.lazyMocked(['start', b, '--yes'], MOCK_CLAUDE_SUCCESS);
    const idA = fullId(ctx.root, a);
    const idB = fullId(ctx.root, b);

    const storage = await openProjectStorage(ctx.root);
    try {
      // Settle the start responses first.
      await reconcileTasks(storage, ctx.root);
      await settleAutoResumes();

      makeDead(ctx.root, idA);
      makeDead(ctx.root, idB);

      // One tick. It must RETURN while the first launch is still blocked.
      await reconcileTasks(storage, ctx.root);

      // Both deaths are recorded, whichever task the sweep reached first.
      for (const id of [idA, idB]) {
        expect(crashTurns(ctx.root, id)).toBe(1);
      }
      // The project-wide auto_resume_gap_minutes let exactly one resume go; it
      // is blocked mid-launch, already flipped to working, and the other task
      // waits interrupted behind the gap.
      expect(launched.length).toBe(1);
      const slow = launched[0]!;
      const other = slow === idA ? idB : idA;
      expect(readTaskStatus(ctx.root, slow)).toBe('working');
      expect(readTaskStatus(ctx.root, other)).toBe('interrupted');
      // Still registered although the nested runner-style registration
      // finished: the outer registration is reference-counted.
      expect(launchInFlight('unknown-run', slow)).toBe(true);

      // Rewind the gap and backdate the launching task past the grace period.
      const config = await loadConfig(ctx.root);
      await recordProjectAutoResume(join(ctx.root, config.data.path), 0);
      backdate(ctx.root, slow);

      await reconcileTasks(storage, ctx.root);

      // Single-flight: the blocked task is not launched again, and — being
      // working with a launch in flight — is not recorded as crashed either.
      // The other task, now past the gap, launches.
      expect([...launched].sort()).toEqual([idA, idB].sort());
      expect(crashTurns(ctx.root, slow)).toBe(1);
      expect(readTaskStatus(ctx.root, slow)).toBe('working');
      const slowTask = await storage.getTask(slow);
      const slowSession = await storage.getSessionByTaskId(slow);
      expect(await computeTaskWorkingSubstate(ctx.root, slowTask!, slowSession!, noRunRunner))
        .toEqual({ kind: 'launching' });

      for (const r of releases.values()) r();
      await settleAutoResumes();
      expect(launchInFlight('unknown-run', slow)).toBe(false);
      expect(launchInFlight('unknown-run', other)).toBe(false);
    } finally {
      await storage.close();
    }
  });
});
