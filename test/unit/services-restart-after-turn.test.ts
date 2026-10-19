/**
 * A task's services are restarted after every WORK turn, before it parks.
 *
 * Driven through the reconciler's real end-of-turn path
 * (`handleCompletedResponses`) with a real store and worktree. Only the task
 * container is a stand-in: services run in a task CONTAINER, and the
 * fake-agent-binary seam runs the host-process runner, which has none — so the
 * container exec is injected through `servicesRestartDefaults`, the restart's
 * in-process deps.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { FileStorage } from '../../src/storage';
import { handleCompletedResponses } from '../../src/utils/reconcile';
import { protocolDir as getProtocolDir, writeStatus } from '../../src/protocol';
import type { CommandType, CompletedResponse } from '../../src/protocol';
import { getWorktreePathForRef, taskRef } from '../../src/task/identity';
import { spawnSyncUnsupervised } from '../../src/utils/spawn';
import {
  servicesRestartDefaults, servicesRestartOf, servicesRestartInFlight, servicesRestartsSettled,
  SERVICES_RESTART_KEY, SERVICES_RESTART_TURN_KEY,
} from '../../src/daemon/services-restart';
import { setStopServicesCmd } from '../../src/serve/start-cmd';
import { markReadOnlyTurn } from '../../src/task/read-only-turn';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSyncUnsupervised(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return result.stdout?.toString().trim() ?? '';
}

let lazyRoot: string;
let basePath: string;
let storage: FileStorage;
let baseSha: string;
/** What the fake container saw, in order, with the task's status at that moment. */
let calls: Array<{ step: 'stop' | 'start'; status: string; argv: string[]; taskId: string }>;
/** Per task id, a promise a start waits on before answering (a slow Start). */
let startGates: Map<string, Promise<void>>;
let startOutput: string;
let stopExit: number;

beforeEach(async () => {
  process.env.LAZY_TEST = '1';
  lazyRoot = await mkdtemp(join(tmpdir(), 'lazy-svc-restart-root-'));
  basePath = await mkdtemp(join(tmpdir(), 'lazy-svc-restart-store-'));
  git(lazyRoot, 'init', '-q', '-b', 'main');
  git(lazyRoot, 'config', 'user.email', 'test@lazy.test');
  git(lazyRoot, 'config', 'user.name', 'Lazy Test');
  await writeFile(join(lazyRoot, 'README.md'), '# base\n');
  git(lazyRoot, 'add', '.');
  git(lazyRoot, 'commit', '-qm', 'base');
  baseSha = git(lazyRoot, 'rev-parse', 'HEAD');
  storage = new FileStorage(lazyRoot, { basePath });
  await storage.initialize();

  calls = [];
  startGates = new Map();
  startOutput = 'running\n';
  stopExit = 0;
  servicesRestartDefaults.resolveCmd = async () => 'bin/dev';
  // One container per task, named after it, so the exec knows whose services it runs.
  servicesRestartDefaults.containerTarget = async (_root, task) => ({ binary: 'docker', name: `c-${task.id}` });
  servicesRestartDefaults.ensureContainer = async (_root, params) => ({
    containerName: `c-${params.taskId}`, worktreePath: '/wt', runnerType: 'docker', alreadyRunning: true,
  });
  servicesRestartDefaults.exec = async (argv) => {
    const isStart = argv.includes('lazy-services');
    const taskId = argv.find(a => a.startsWith('c-'))!.slice(2);
    const task = (await storage.getTask(taskId))!;
    calls.push({ step: isStart ? 'start' : 'stop', status: task.status, argv, taskId });
    if (isStart) {
      await startGates.get(taskId);
      return { exitCode: 0, stdout: startOutput, stderr: '' };
    }
    return { exitCode: stopExit, stdout: stopExit ? 'stop.sh: no such file\n' : '', stderr: '' };
  };
});

afterEach(async () => {
  await servicesRestartsSettled();
  for (const key of Object.keys(servicesRestartDefaults)) delete (servicesRestartDefaults as Record<string, unknown>)[key];
  await storage.close();
  await rm(lazyRoot, { recursive: true, force: true });
  await rm(basePath, { recursive: true, force: true });
});

/** A task whose work turn has just ended; `pass()` is one reconciler pass over its response. */
async function prepareTurn(commandType: CommandType, response: Partial<CompletedResponse> = {}, opts: { readOnly?: boolean; followUps?: CompletedResponse[] } = {}) {
  const task = await storage.createTask('services restart', undefined, baseSha);
  const ref = taskRef(task);
  const branch = `lazy/${ref}`;
  const session = await storage.createSession(task.id, 'claude-code', branch, baseSha);
  await storage.updateTaskStatus(task.id, 'working', 'system');
  git(lazyRoot, 'branch', branch, baseSha);
  const worktreePath = getWorktreePathForRef(lazyRoot, ref);
  await mkdir(dirname(worktreePath), { recursive: true });
  git(lazyRoot, 'worktree', 'add', '-q', worktreePath, branch);
  const protoDir = getProtocolDir(task.id);
  await mkdir(protoDir, { recursive: true });
  const now = new Date().toISOString();
  writeStatus(protoDir, { phase: 'done', task_id: task.id, command_type: commandType, started_at: now, updated_at: now } as never);
  if (opts.readOnly) {
    // A reflective unblock: its human turn, and the marker naming it.
    const human = await storage.createTurn({
      sessionId: session.id, sequence: await storage.getNextTurnSequence(session.id), role: 'human', content: 'Think about it.',
    });
    await markReadOnlyTurn(storage, task.id, { command_id: 'cmd-ro' as never, session_id: session.id, human_turn_sequence: human.sequence });
  }
  const responses: CompletedResponse[] = [
    { status: 'completed', result: 'Turn done.', session_id: 'sess-1', usage: { input_tokens: 1, output_tokens: 1 }, ...response } as CompletedResponse,
    ...(opts.followUps ?? []),
  ];
  const pass = () => handleCompletedResponses(storage, task.id, {
    id: session.id, agent_session_id: null, git_start_sha: session.git_start_sha, container_name: null,
  }, responses, worktreePath, protoDir, lazyRoot, opts.readOnly ? ('cmd-ro' as never) : undefined);
  /** Put the turn's response back, as if a pass died before consuming it. */
  const rewind = async () => {
    writeStatus(protoDir, { phase: 'done', task_id: task.id, command_type: commandType, started_at: now, updated_at: now } as never);
    await storage.updateTaskStatus(task.id, 'working', 'system');
  };
  const read = async () => (await storage.getTask(task.id))!;
  return { taskId: task.id, pass, rewind, read };
}

/**
 * End a work turn the way the reconciler does: a pass (which starts the restart
 * in the background and leaves the task working), the restart finishing, and the
 * next pass, which parks it. `twice` re-runs the end of the same turn afterwards.
 */
async function endTurn(commandType: CommandType, response: Partial<CompletedResponse> = {}, opts: { readOnly?: boolean; twice?: boolean } = {}) {
  const t = await prepareTurn(commandType, response, opts);
  await t.pass();
  await servicesRestartsSettled();
  await t.pass();
  if (opts.twice) {
    await t.rewind();
    await t.pass();
    await servicesRestartsSettled();
    await t.pass();
  }
  return t.read();
}

describe('services restart after a work turn', () => {
  // INVARIANT: after a WORK turn, Stop then Start ran — both while the task was
  // still `working` (the supervisor had handed back, the park had not
  // happened) — and then the task parked. Fresh services when a person looks.
  test('stops, then starts, then parks', async () => {
    const task = await endTurn('unblock');
    expect(calls.map(c => c.step)).toEqual(['stop', 'start']);
    expect(calls.every(c => c.status === 'working')).toBe(true);
    expect(task.status).toBe('blocked');
    const record = servicesRestartOf(task)!;
    expect(record.stop.ok).toBe(true);
    expect(record.start.ok).toBe(true);
    expect(record.warning).toBeNull();
    expect(record.command).toBe('bin/dev');
  });

  // INVARIANT: a failing start is a WARNING naming the step and the output
  // tail; the task still parks normally, never in an error state.
  test('a failing start records a warning and the task still parks', async () => {
    startOutput = 'stopped\nError: listen EADDRINUSE :3000\n';
    const task = await endTurn('start');
    expect(task.status).toBe('blocked');
    const record = servicesRestartOf(task)!;
    expect(record.start.ok).toBe(false);
    expect(record.warning).toContain('Start services failed');
    expect(record.warning).toContain('EADDRINUSE');
  });

  // INVARIANT: the post-turn start never launches a container. The restart
  // resolved the turn's own container once; if it vanished since, the start step
  // must refuse rather than bring up one nobody asked for for a parked task.
  test('the start step is told never to launch a container', async () => {
    const seen: Array<boolean | undefined> = [];
    servicesRestartDefaults.ensureContainer = async (_root, params) => {
      seen.push(params.neverLaunch);
      throw new Error('refused');
    };
    const task = await endTurn('unblock');
    expect(seen).toEqual([true]);
    expect(task.status).toBe('blocked');
    expect(servicesRestartOf(task)!.start.ok).toBe(false);
  });

  // INVARIANT: a failing stop is logged and the start still runs.
  test('a failing Stop services command does not prevent the start', async () => {
    await setStopServicesCmd(storage, 'bin/stop');
    stopExit = 1;
    const task = await endTurn('unblock');
    expect(calls.map(c => c.step)).toEqual(['stop', 'start']);
    expect(calls[0].argv).toContain('bin/stop');
    const record = servicesRestartOf(task)!;
    expect(record.stop.ok).toBe(false);
    expect(record.stop.error).toContain('bin/stop');
    expect(record.start.ok).toBe(true);
    expect(record.warning).toBeNull();
  });

  // INVARIANT: only WORK turns restart services — never an ask or a review.
  test.each(['ask', 'review'] as const)('a %s turn restarts nothing', async (type) => {
    const task = await endTurn(type);
    expect(calls).toEqual([]);
    expect(task.metadata?.[SERVICES_RESTART_KEY]).toBeUndefined();
  });

  // INVARIANT: a reflective (read-only) unblock changed nothing, so it restarts nothing.
  test('a reflective unblock restarts nothing', async () => {
    const task = await endTurn('unblock', {}, { readOnly: true });
    expect(calls).toEqual([]);
    expect(task.status).toBe('blocked');
  });

  // INVARIANT: a reconciler re-run over a turn already recorded never restarts twice.
  test('re-running the end of the same turn restarts once', async () => {
    await endTurn('unblock', {}, { twice: true });
    expect(calls.map(c => c.step)).toEqual(['stop', 'start']);
  });

  // INVARIANT: the restart never holds the reconciler. Its passes handle tasks one
  // after another, so a restart run inline let one task's slow Start delay every
  // other task's park and resume (reconciler starvation is a past incident).
  test('two tasks end together: the slow Start holds back only its own task', async () => {
    const slow = await prepareTurn('unblock');
    const fast = await prepareTurn('unblock');
    let releaseSlow!: () => void;
    startGates.set(slow.taskId, new Promise<void>((r) => { releaseSlow = r; }));

    // One reconciler pass over both: neither awaits a restart.
    await slow.pass();
    await fast.pass();
    expect(servicesRestartInFlight(slow.taskId)).toBe(true);
    expect((await slow.read()).status).toBe('working');

    // The fast task's restart finishes; its next pass parks it while the slow
    // Start is still running.
    while (servicesRestartInFlight(fast.taskId)) await Bun.sleep(5);
    await fast.pass();
    expect((await fast.read()).status).toBe('blocked');
    expect(servicesRestartInFlight(slow.taskId)).toBe(true);
    expect((await slow.read()).status).toBe('working');

    // A pass while the slow restart runs leaves it working (the reconciler also
    // skips it outright); the pass after it finishes parks it.
    await slow.pass();
    expect((await slow.read()).status).toBe('working');
    releaseSlow();
    await servicesRestartsSettled();
    await slow.pass();
    expect((await slow.read()).status).toBe('blocked');
    expect(calls.filter(c => c.taskId === slow.taskId).map(c => c.step)).toEqual(['stop', 'start']);
    expect(calls.filter(c => c.taskId === fast.taskId).map(c => c.step)).toEqual(['stop', 'start']);
  });

  // INVARIANT: a restart is claimed before it starts, so a daemon that died
  // mid-restart never restarts the same turn's services again: the next daemon
  // finds the claim, sees nothing running, and parks.
  test('a turn whose restart a previous daemon claimed parks without restarting', async () => {
    const t = await prepareTurn('unblock');
    await t.pass(); // claims and starts the restart
    await servicesRestartsSettled();
    calls = [];
    // A new daemon: the claim is in the store, nothing is in flight here.
    expect((await t.read()).metadata?.[SERVICES_RESTART_TURN_KEY]).toBeTruthy();
    await t.pass();
    expect(calls).toEqual([]);
    expect((await t.read()).status).toBe('blocked');
  });

  // INVARIANT: EVERY work turn restarts, whoever started it. A manual start, an
  // unblock, a manual resume, the reconciler's auto-resume and auto-deliver's
  // unblock (cluster restart, auto-react) all launch a `start` or `unblock`
  // command, which is what the supervisor reports as the ending turn's type.
  test.each(['start', 'unblock'] as const)('a %s turn restarts, as every work launch is one of these', async (type) => {
    await endTurn(type);
    expect(calls.map(c => c.step)).toEqual(['stop', 'start']);
  });

  // INVARIANT: every command type a work launch writes is one the restart covers.
  // Any `type: '…'` in the launch modules that is not a known non-work command
  // must be a work type — so a new work-launch type fails here, not silently.
  test('every work-turn launch writes a command type the restart covers', async () => {
    const { isWorkTurnCommand } = await import('../../src/task/services-restart-record');
    // Not work turns: read-only visits, merges, the accept gate — and
    // auto-deliver's `upstream_change`, a SIGNAL type, not a command.
    const NOT_WORK = new Set(['ask', 'review', 'sync', 'accept_gate', 'upstream_change']);
    const sites = [
      'src/daemon/task-launcher.ts',   // lazy start
      'src/daemon/task-lifecycle.ts',  // unblock, manual resume
      'src/utils/auto-resume.ts',      // the reconciler's auto-resume
      'src/daemon/auto-deliver.ts',    // autoUnblockTask: auto-deliver, cluster restart, auto-react
    ];
    for (const site of sites) {
      const src = await Bun.file(join(import.meta.dir, '../..', site)).text();
      const types = [...src.matchAll(/^\s+type: '(\w+)',$/gm)].map(m => m[1]);
      const work = types.filter(t => !NOT_WORK.has(t));
      expect(work.length).toBeGreaterThan(0); // each site launches at least one work turn
      for (const type of work) expect([site, type, isWorkTurnCommand(type)]).toEqual([site, type, true]);
    }
    for (const notWork of NOT_WORK) expect(isWorkTurnCommand(notWork)).toBe(false);
  });

  // INVARIANT: a restart is claimed under a key that does not change between
  // passes. After the wrap-up recorded follow-ups (push-back, the low-high
  // self-review), the last agent-role turn is not the work turn, and a key built
  // from it restarted the services a second time on the parking pass.
  test.each(['permission_pushback', 'low_high_review'] as const)('a bundle with a %s follow-up restarts once', async (kind) => {
    const t = await prepareTurn('unblock', {}, {
      followUps: [{ status: 'completed', result: 'LOW_HIGH_LOOP_APPROVED', session_id: 'sess-1', supervised: { kind, prompt: 'check' } } as never],
    });
    await t.pass();
    await servicesRestartsSettled();
    await t.pass();
    await servicesRestartsSettled();
    await t.pass();
    expect(calls.map(c => c.step)).toEqual(['stop', 'start']);
    expect((await t.read()).status).toBe('blocked');
  });

  // INVARIANT: the restart can never keep a turn from parking — a failed
  // lookup or claim write parks it without a restart.
  test('a failing command lookup still parks the task', async () => {
    servicesRestartDefaults.resolveCmd = async () => { throw new Error('store unreadable'); };
    const t = await prepareTurn('unblock');
    await t.pass();
    expect(calls).toEqual([]);
    expect((await t.read()).status).toBe('blocked');
  });

  // INVARIANT: a daemon stop or restart while a finished turn waits for its
  // services restart does not mark that turn interrupted (whose auto-resume
  // would launch a work turn nobody asked for); a later pass parks it.
  test('a daemon restart in the restart window leaves the finished turn to be parked', async () => {
    const { interruptForDaemonRestart } = await import('../../src/utils/reconcile');
    const { writeResponse } = await import('../../src/protocol');
    const t = await prepareTurn('unblock');
    await t.pass(); // restart claimed and running; response still on disk
    writeResponse(getProtocolDir(t.taskId), { status: 'completed', result: 'Turn done.', session_id: 'sess-1' } as never);
    await servicesRestartsSettled();
    expect(await interruptForDaemonRestart(storage, t.taskId, lazyRoot)).toBe(false);
    expect((await t.read()).status).toBe('working');
    await t.pass();
    expect((await t.read()).status).toBe('blocked');
    expect(calls.map(c => c.step)).toEqual(['stop', 'start']);
  });

  // INVARIANT: no Start services command, no restart.
  test('nothing runs without a Start services command', async () => {
    servicesRestartDefaults.resolveCmd = async () => '';
    const task = await endTurn('unblock');
    expect(calls).toEqual([]);
    expect(task.status).toBe('blocked');
  });
});
