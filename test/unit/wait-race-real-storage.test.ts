/**
 * The wait race against a REAL FileStorage, with the ordering under test driven
 * by the test rather than by timing.
 *
 * The reconciler records a turn's agent row BEFORE it parks the task
 * (src/utils/reconcile.ts: createAgentTurn, then parkTaskPaused). The old race
 * also settled on "a new agent turn exists", so a poll landing in that gap
 * returned `working` — printed by the CLI as "Task … is now working" (exit 1)
 * (src/cli/commands/wait.ts, the `Task ${winnerRef(result)} is now ${result.status}` line).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { FileStorage } from '../../src/storage';
import { raceWait } from '../../src/daemon/wait-race';

const POLL = { timeoutSecs: 10, pollIntervalMs: 10 };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('raceWait against real storage', () => {
  let root: string, base: string, storage: FileStorage, sha: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-wait-root-'));
    base = await mkdtemp(join(tmpdir(), 'lazy-wait-store-'));
    git(root, 'init'); git(root, 'config', 'user.email', 't@l.test'); git(root, 'config', 'user.name', 'T');
    git(root, 'checkout', '-b', 'main');
    await writeFile(join(root, 'README.md'), 'x\n');
    git(root, 'add', '.'); git(root, 'commit', '-m', 'base');
    sha = git(root, 'rev-parse', 'HEAD');
    storage = new FileStorage(root, { basePath: base });
    await storage.initialize();
  });
  afterEach(async () => {
    await storage.close();
    await Promise.all([rm(root, { recursive: true, force: true }), rm(base, { recursive: true, force: true })]);
  });

  async function startedTask() {
    const task = await storage.createTask('wait me', undefined, sha);
    const session = await storage.createSession(task.id, 'claude-code', 'lazy/x', sha);
    await storage.updateTaskStatus(task.id, 'working');
    return { task, session };
  }

  // INVARIANT: only a status change settles a wait. An agent turn recorded while
  // the task still reads `working` (the reconciler writes it before it parks)
  // is not evidence the turn finished.
  test('an agent turn recorded before the park does not settle the wait', async () => {
    const { task, session } = await startedTask();
    let settled: { status: string } | null = null;
    const race = raceWait(storage, [task.id], POLL).then(r => (settled = r));
    await sleep(50);

    await storage.createTurn({ sessionId: session.id, sequence: 1, role: 'agent', content: 'done' });
    await sleep(150); // many polls with the turn present and status still working
    expect(settled).toBeNull();

    await storage.updateTaskStatus(task.id, 'blocked');
    const result = await race;
    expect(result.status).toBe('blocked');
    expect(result.timed_out).toBe(false);
  });

  // INVARIANT: a start observed mid-launch (status `working`, session created,
  // the launch's own human turn recorded, no agent turn yet) keeps waiting.
  // NOTE: launchInFlight (src/runner/launch-in-flight.ts) is process-local and
  // never consulted by the wait race, which reads storage only; it is not modelled.
  test('a start observed mid-launch keeps waiting until the park', async () => {
    const { task, session } = await startedTask();
    let settled: { status: string } | null = null;
    const race = raceWait(storage, [task.id], POLL).then(r => (settled = r));
    await sleep(30);
    await storage.createTurn({ sessionId: session.id, sequence: 1, role: 'human', content: 'prompt' });
    await sleep(100);
    expect(settled).toBeNull();
    await storage.createTurn({ sessionId: session.id, sequence: 2, role: 'agent', content: 'done' });
    await sleep(100);
    expect(settled).toBeNull();
    await storage.updateTaskStatus(task.id, 'blocked');
    expect((await race).status).toBe('blocked');
  });

  // INVARIANT: a sync's conflict-resolution reply is a `role: 'agent'` turn
  // (turnType 'sync') the reconciler records while the task is still `working`,
  // with the park after it — the "short sync turn" that made `lazy wait` return
  // `working` in submit-intermediate-reparent. It must not settle the wait.
  test('a sync conflict-resolution agent turn does not settle the wait', async () => {
    const { task, session } = await startedTask();
    let settled: { status: string } | null = null;
    const race = raceWait(storage, [task.id], POLL).then(r => (settled = r));
    await sleep(30);
    await storage.createTurn({ sessionId: session.id, sequence: 1, role: 'agent', content: 'resolved', turnType: 'sync' });
    await sleep(100);
    expect(settled).toBeNull();
    await storage.updateTaskStatus(task.id, 'blocked');
    expect((await race).status).toBe('blocked');
  });

  // A start with no session yet is refused up front (400), never reported as
  // "now working" — so it is not a second route to that message.
  test('a task with no session is refused, not reported as working', async () => {
    const task = await storage.createTask('never started', undefined, sha);
    await expect(raceWait(storage, [task.id], POLL)).rejects.toThrow(/has no session/);
  });
});
