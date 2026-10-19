import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runStartServices,
  startServicesScript,
  stopServicesScript,
  servicesStatusScript,
  parseServicesStatus,
  readServicesRunState,
  linkProcessesToServices,
  SERVICES_PID_FILE,
  SERVICES_LOG_FILE,
} from '../../src/daemon/serve-run';
import type { Storage } from '../../src/storage';
import { serveRunPhasePlan, type ProgressEvent, type ProgressPhaseEvent } from '../../src/daemon/progress';
import { RpcError } from '../../src/daemon/rpc-error';

/**
 * Start services run by the daemon in the TASK's container
 * (src/daemon/serve-run.ts). The container half needs docker; what is tested
 * here is everything that does not — which argv reaches the runtime, and what
 * the in-container scripts do, run under a local `sh` against a scratch dir.
 */

const TASK = { id: 'abcdef1234567890', code: 'demo', status: 'blocked' };

function fakeStorage(): Storage {
  return {
    resolveTask: async (ref: string) => (ref === TASK.id || ref === TASK.code ? { task: TASK } : { task: null }),
    getSessionByTaskId: async () => null,
  } as unknown as Storage;
}

describe('runStartServices', () => {
  // INVARIANT: the command runs in the TASK's container (the one servePorts
  // probes and that publishes [serve] ports), at the worktree, with the
  // project's command passed as an ARGUMENT — never spliced into the script,
  // and never with any credential in the argv or environment.
  test('execs the project command in the task container, at its worktree, as an argument', async () => {
    const calls: string[][] = [];
    const result = await runStartServices('/root', { taskId: 'demo' }, {
      getStorage: async () => fakeStorage(),
      resolveCmd: async () => 'bin/dev --port "3000"',
      ensureContainer: async () => ({ containerName: 'lazy-abcdef12', worktreePath: '/wt/demo', runnerType: 'docker', alreadyRunning: true }),
      exec: async (argv) => { calls.push(argv); return { exitCode: 0, stdout: '', stderr: '' }; },
    });
    expect(result).toEqual({ containerName: 'lazy-abcdef12', command: 'bin/dev --port "3000"', containerStarted: false });
    expect(calls).toHaveLength(1);
    const argv = calls[0]!;
    expect(argv.slice(0, 5)).toEqual(['docker', 'exec', '-w', '/wt/demo', 'lazy-abcdef12']);
    expect(argv.slice(-2)).toEqual(['bin/dev --port "3000"', '/wt/demo']);
    expect(argv.join(' ')).not.toMatch(/-e |--env|TOKEN|ANTHROPIC/);
    expect(argv[argv.indexOf('-c') + 1]).not.toContain('bin/dev');
  });

  test('refuses with a 409 when no command is designated, before touching any container', async () => {
    let ensured = false;
    await expect(runStartServices('/root', { taskId: 'demo' }, {
      getStorage: async () => fakeStorage(),
      resolveCmd: async () => '',
      ensureContainer: async () => { ensured = true; throw new Error('unreachable'); },
    })).rejects.toMatchObject({ status: 409 });
    expect(ensured).toBe(false);
  });

  // A finished task's environment is not brought back: that would recreate
  // its worktree.
  test('refuses a finished task with a 409, before touching any container', async () => {
    let ensured = false;
    await expect(runStartServices('/root', { taskId: 'demo' }, {
      getStorage: async () => ({
        resolveTask: async () => ({ task: { ...TASK, status: 'complete' } }),
        getSessionByTaskId: async () => null,
      }) as unknown as Storage,
      resolveCmd: async () => 'bin/dev',
      ensureContainer: async () => { ensured = true; throw new Error('unreachable'); },
    })).rejects.toMatchObject({ status: 409 });
    expect(ensured).toBe(false);
  });

  test('reports when it had to bring the container up', async () => {
    const result = await runStartServices('/root', { taskId: 'demo' }, {
      getStorage: async () => fakeStorage(),
      resolveCmd: async () => 'bin/dev',
      ensureContainer: async () => ({ containerName: 'c', worktreePath: '/w', runnerType: 'podman', alreadyRunning: false }),
      exec: async (argv) => { expect(argv[0]).toBe('podman'); return { exitCode: 0, stdout: '', stderr: '' }; },
    });
    expect(result.containerStarted).toBe(true);
  });

  test('a failed exec is an error naming the container', async () => {
    await expect(runStartServices('/root', { taskId: 'demo' }, {
      getStorage: async () => fakeStorage(),
      resolveCmd: async () => 'bin/dev',
      ensureContainer: async () => ({ containerName: 'lazy-x', worktreePath: '/w', runnerType: 'docker', alreadyRunning: true }),
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'no such container' }),
    })).rejects.toThrow(/lazy-x: no such container/);
  });
});

describe('parseServicesStatus / readServicesRunState', () => {
  test('parses the state line and keeps the log verbatim', () => {
    expect(parseServicesStatus('running\nline 1\nline 2\n')).toEqual({ state: 'running', log: 'line 1\nline 2\n' });
    expect(parseServicesStatus('stopped\n')).toEqual({ state: 'stopped', log: '' });
    expect(parseServicesStatus('never\n')).toEqual({ state: 'never', log: '' });
    expect(parseServicesStatus('garbage')).toEqual({ state: 'never', log: '' });
  });

  // "Could not ask" is not "not running".
  test('a failed read is null, not a state', async () => {
    expect(await readServicesRunState('docker', 'c', async () => ({ exitCode: 1, stdout: '', stderr: 'x' }))).toBeNull();
  });
});

/**
 * The scripts themselves, run by a local `sh` with the container's /tmp paths
 * rewritten to a scratch dir. This is the behaviour a second Start services
 * depends on: it RESTARTS (the previous process group is gone), never stacks a
 * second dev server on the same port.
 */
// `setsid` is util-linux; macOS has none, and the task container (Linux) always does.
const hasSetsid = Bun.which('setsid') !== null;
if (!hasSetsid) console.log('skip: serve-run in-container scripts — setsid is not on PATH (macOS); they run in a Linux container');

describe.skipIf(!hasSetsid)('the in-container scripts', () => {
  let dir: string;
  afterEach(async () => {
    await sh(stopServicesScript());
    await rm(dir, { recursive: true, force: true });
  });

  const local = (script: string) => script.replaceAll(SERVICES_PID_FILE, join(dir, 'pid')).replaceAll(SERVICES_LOG_FILE, join(dir, 'log'));

  async function sh(script: string, ...args: string[]): Promise<string> {
    const proc = Bun.spawn(['sh', '-c', local(script), 'lazy-services', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  }

  async function groupAlive(marker: string): Promise<boolean> {
    const proc = Bun.spawn(['sh', '-c', `ps -eo args | grep -F "${marker}" | grep -v grep`], { stdout: 'pipe' });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim().length > 0;
  }

  test('start, restart, stop', async () => {
    dir = await mkdtemp(join(tmpdir(), 'serve-run-'));
    expect(parseServicesStatus(await sh(servicesStatusScript())).state).toBe('never');

    await sh(startServicesScript(), 'echo first; sleep 101 & sleep 102');
    expect(parseServicesStatus(await sh(servicesStatusScript()))).toMatchObject({ state: 'running', log: 'first\n' });
    expect(await groupAlive('sleep 101')).toBe(true);

    await sh(startServicesScript(), 'echo second; sleep 103');
    const restarted = parseServicesStatus(await sh(servicesStatusScript()));
    expect(restarted).toMatchObject({ state: 'running', log: 'second\n' });
    // The whole previous group went, background children included.
    expect(await groupAlive('sleep 101')).toBe(false);
    expect(await groupAlive('sleep 102')).toBe(false);

    await sh(stopServicesScript());
    expect(parseServicesStatus(await sh(servicesStatusScript()))).toMatchObject({ state: 'stopped', log: 'second\n', phase: 'stopped', processes: [] });
    expect(await groupAlive('sleep 103')).toBe(false);
  }, 20_000);

  // INVARIANT: the project's Stop services command runs first, and the services
  // process group is ended after it EVEN WHEN it fails; its exit code is the script's.
  test('stop with a Stop command: runs it, ends the group anyway, reports its exit code', async () => {
    dir = await mkdtemp(join(tmpdir(), 'serve-run-'));
    await sh(startServicesScript(), 'sleep 107');
    expect(await groupAlive('sleep 107')).toBe(true);
    const proc = Bun.spawn(['sh', '-c', local(stopServicesScript(true)), 'lazy-services-stop', `echo stopping > ${join(dir, 'ran')}; exit 3`],
      { stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).toBe(3);
    expect((await Bun.file(join(dir, 'ran')).text()).trim()).toBe('stopping');
    expect(await groupAlive('sleep 107')).toBe(false);
  }, 20_000);

  // INVARIANT: a command that dies at once is reported by the same exec that
  // started it, with its output. It is the commonest Start services failure
  // and would otherwise read as "started".
  test('with a settle wait, the start script reports a command that died at once', async () => {
    dir = await mkdtemp(join(tmpdir(), 'serve-run-'));
    const died = parseServicesStatus(await sh(startServicesScript(1), 'echo "bin/dev: not found"; exit 127'));
    expect(died).toEqual({ state: 'stopped', log: 'bin/dev: not found\n' });
    const alive = parseServicesStatus(await sh(startServicesScript(1), 'echo up; sleep 104'));
    expect(alive.state).toBe('running');
  }, 20_000);

  // INVARIANT: a command that daemonizes and exits 0 (pm2 start, overmind -D,
  // supervisord) is not a failure — only a non-zero exit is.
  test('with a settle wait, a command that exits 0 by itself reports finished, a non-zero one stopped', async () => {
    dir = await mkdtemp(join(tmpdir(), 'serve-run-'));
    expect((await sh(startServicesScript(1), 'echo daemonized; exit 0')).split('\n')[0]).toBe('finished');
    expect((await sh(startServicesScript(1), 'echo nope; exit 3')).split('\n')[0]).toBe('stopped');
  }, 20_000);

  // INVARIANT: the inventory answers "what is running in this container" from
  // the container itself — every process the command started, the ports each
  // listens on, and how the command ended — not just "is a port open".
  test('the status script inventories the process group, its listening ports and the exit code', async () => {
    dir = await mkdtemp(join(tmpdir(), 'serve-run-'));
    const server = 'const s = Bun.serve({ port: 0, fetch: () => new Response("ok") }); console.log("port=" + s.port)';
    await sh(startServicesScript(), `sleep 105 & ${process.execPath} -e '${server}'`);
    let run = parseServicesStatus(await sh(servicesStatusScript()));
    for (let i = 0; i < 50 && !/port=\d+/.test(run.log); i++) {
      await Bun.sleep(100);
      run = parseServicesStatus(await sh(servicesStatusScript()));
    }
    const port = Number(/port=(\d+)/.exec(run.log)?.[1]);
    expect(run.state).toBe('running');
    expect(run.phase).toBe('running');
    expect(run.command).toContain('sleep 105');
    expect(run.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const procs = run.processes ?? [];
    expect(procs[0].pid).toBe(run.pid!);
    // The leader is lazy's wrapper: shown as the launched command, never its plumbing.
    expect(procs[0].wrapper).toBe(true);
    expect(procs[0].command).toBe(run.command!);
    expect(procs.some(p => p.command.includes(SERVICES_PID_FILE) || p.command.includes('pid'))).toBe(false);
    expect(procs.some(p => p.command.includes('sleep 105'))).toBe(true);
    const listener = procs.find(p => p.listeningPorts.includes(port));
    expect(listener?.command).toContain(process.execPath);
    expect(run.logBytes).toBeGreaterThan(0);

    const linked = linkProcessesToServices(run, [{ name: 'web', port, listening: true }]);
    expect(linked.processes.find(p => p.pid === listener!.pid)?.services).toEqual([{ name: 'web', port, listening: true }]);

    await sh(startServicesScript(1), 'echo bye; exit 4');
    const ended = parseServicesStatus(await sh(servicesStatusScript()));
    expect(ended).toMatchObject({ state: 'stopped', phase: 'exited', exitCode: 4, processes: [], pid: null, command: 'echo bye; exit 4' });
  }, 20_000);

  test('a newline inside an argument stays on its process row', async () => {
    dir = await mkdtemp(join(tmpdir(), 'serve-run-'));
    await sh(startServicesScript(), `${process.execPath} -e 'setTimeout(() => {}, 100000)' 'two\n@@end\nlines'`);
    let run = parseServicesStatus(await sh(servicesStatusScript()));
    const find = () => (run.processes ?? []).find(p => !p.wrapper && p.command.includes('setTimeout'));
    for (let i = 0; i < 30 && !find(); i++) {
      await Bun.sleep(100);
      run = parseServicesStatus(await sh(servicesStatusScript()));
    }
    const row = find();
    expect(row?.command).toContain('two @@end lines');
    expect(run.log).toBe('');
  }, 20_000);

  test('a longer tail is returned on request and the log is marked truncated otherwise', async () => {
    dir = await mkdtemp(join(tmpdir(), 'serve-run-'));
    await sh(startServicesScript(1), 'for i in $(seq 1 2000); do echo "line $i"; done; sleep 106');
    const short = parseServicesStatus(await sh(servicesStatusScript(100)));
    expect(short.logTruncated).toBe(true);
    expect(Buffer.byteLength(short.log)).toBe(100);
    const whole = parseServicesStatus(await sh(servicesStatusScript(1024 * 1024)));
    expect(whole.logTruncated).toBe(false);
    expect(whole.log.startsWith('line 1\n')).toBe(true);
  }, 20_000);
});

describe('parseServicesStatus inventory', () => {
  const out = (head: string, meta: string[], log: string) => `${head}\n${meta.join('\n')}\n@@end\n${log}`;

  test('joins sockets to listening ports, leader first, and calls a young quiet group starting', () => {
    const now = 1_000_000_000_000;
    const started = now / 1000 - 5;
    const run = parseServicesStatus(out('running', [
      '@@pid 10', `@@started ${started}`, '@@cmd bin/dev', '@@logbytes 3',
      '@@proc 12 10 S node server.js', '@@proc 10 1 S sh -c bin/dev',
      '@@sock 12 999', '@@listen 3000 999', '@@listen 5432 0',
    ], 'hi\n'), now);
    expect(run.processes?.map(p => p.pid)).toEqual([10, 12]);
    expect(run.processes?.[1].listeningPorts).toEqual([3000]);
    expect(run.phase).toBe('running');
    expect(run.logTruncated).toBe(false);
    const quiet = parseServicesStatus(out('running', ['@@pid 10', `@@started ${started}`, '@@proc 10 1 S sh'], ''), now);
    expect(quiet.phase).toBe('starting');
    const old = parseServicesStatus(out('running', ['@@pid 10', `@@started ${started - 600}`, '@@proc 10 1 S sh'], ''), now);
    expect(old.phase).toBe('running');
  });

  test('an older shape (no @@end) is the state and the log, nothing invented', () => {
    expect(parseServicesStatus('running\n@@ not meta\n')).toEqual({ state: 'running', log: '@@ not meta\n' });
  });
});

describe('runStartServices narration', () => {
  const ok = { exitCode: 0, stdout: 'running\nlistening on 3000\n', stderr: '' };

  function phases(events: ProgressEvent[]): string[] {
    return events.filter((e): e is ProgressPhaseEvent => e.kind === 'phase').map(e => `${e.id}:${e.state}`);
  }

  // INVARIANT: Start services on a task whose environment is down brings it
  // up and says so phase by phase — restore task files (fed by the restore's
  // own notes), start the environment, start services. A bring-up that is
  // silent for minutes is what this narration exists to stop.
  test('container down: restore, environment and services each narrated in order', async () => {
    const events: ProgressEvent[] = [];
    const result = await runStartServices('/root', { taskId: 'demo' }, {
      getStorage: async () => fakeStorage(),
      resolveCmd: async () => 'bin/dev',
      progress: (e) => events.push(e),
      ensureContainer: async (_root, params) => {
        const p = params;
        p.restoreProgress?.('Restoring task files…');
        p.restoreProgress?.('Downloading large files: 3/28');
        p.onLaunching?.();
        return { containerName: 'lazy-c', worktreePath: '/w', runnerType: 'docker', alreadyRunning: false };
      },
      exec: async () => ok,
    });
    expect(result.containerStarted).toBe(true);
    expect(events[0]).toMatchObject({ kind: 'plan', operation: 'serve.run', phases: serveRunPhasePlan() });
    expect(phases(events)).toEqual([
      'restore-files:start', 'restore-files:progress', 'restore-files:done',
      'environment:start', 'environment:done',
      'services:start', 'services:done',
    ]);
    const restoreNote = events.find(e => e.kind === 'phase' && e.state === 'progress') as ProgressPhaseEvent;
    expect(restoreNote.detail).toBe('Downloading large files: 3/28');
  });

  test('container already up with its files: restore and environment are skipped with a reason', async () => {
    const events: ProgressEvent[] = [];
    await runStartServices('/root', { taskId: 'demo' }, {
      getStorage: async () => fakeStorage(),
      resolveCmd: async () => 'bin/dev',
      progress: (e) => events.push(e),
      ensureContainer: async () => ({ containerName: 'lazy-c', worktreePath: '/w', runnerType: 'docker', alreadyRunning: true }),
      exec: async () => ok,
    });
    expect(phases(events)).toEqual(['restore-files:skipped', 'environment:skipped', 'services:start', 'services:done']);
  });

  // INVARIANT: a failed restore fails ITS phase with a readable reason — the
  // line that says why, never git's progress meter and per-file noise.
  test('a restore failure fails the restore phase with a readable reason', async () => {
    const events: ProgressEvent[] = [];
    const raw = "Cannot restore task files: Failed to recreate worktree: Preparing worktree (checking out 'lazy/x') Filtering content: 7% (2/28)\r"
      + 'Filtering content: 92% (26/28), 69.40 MiB | 5.95 MiB/s\n'
      + 'error: unable to create file datasets/a.sqlite: No such file or directory\n'
      + 'error: unable to create file datasets/b.sqlite: No such file or directory\n'
      + 'error: unable to create file datasets/c.sqlite: No such file or directory\n'
      + "fatal: Could not reset index file to revision 'HEAD'.";
    const err = await runStartServices('/root', { taskId: 'demo' }, {
      getStorage: async () => fakeStorage(),
      resolveCmd: async () => 'bin/dev',
      progress: (e) => events.push(e),
      ensureContainer: async (_root, params) => {
        params.restoreProgress?.('Restoring task files…');
        throw new RpcError(409, raw);
      },
    }).catch(e => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err.status).toBe(409);
    expect(err.message).not.toMatch(/Filtering content|MiB/);
    expect(err.message).toContain("fatal: Could not reset index file to revision 'HEAD'.");
    expect(err.message).toContain('(and 1 more errors)');
    expect(phases(events)).toEqual(['restore-files:start', 'restore-files:failed']);
    expect((events.at(-1) as ProgressPhaseEvent).detail).toBe(err.message);
  });

  test('a command that died at once fails the services phase with its output', async () => {
    const events: ProgressEvent[] = [];
    const err = await runStartServices('/root', { taskId: 'demo' }, {
      getStorage: async () => fakeStorage(),
      resolveCmd: async () => 'bin/dev',
      progress: (e) => events.push(e),
      ensureContainer: async () => ({ containerName: 'lazy-c', worktreePath: '/w', runnerType: 'docker', alreadyRunning: true }),
      exec: async () => ({ exitCode: 0, stdout: 'stopped\n\x1b[31msh: bin/dev: not found\x1b[0m\n', stderr: '' }),
    }).catch(e => e);
    expect(err.status).toBe(500);
    expect(err.message).toContain('sh: bin/dev: not found');
    const last = events.at(-1) as ProgressPhaseEvent;
    expect(last).toMatchObject({ id: 'services', state: 'failed' });
    expect(last.detail).toContain('bin/dev exited straight away');
  });

  test('a launch failure fails the environment phase', async () => {
    const events: ProgressEvent[] = [];
    await runStartServices('/root', { taskId: 'demo' }, {
      getStorage: async () => fakeStorage(),
      resolveCmd: async () => 'bin/dev',
      progress: (e) => events.push(e),
      ensureContainer: async (_root, params) => {
        params.onLaunching?.();
        throw new RpcError(500, 'Failed to launch container for demo: image not found');
      },
    }).catch(() => undefined);
    expect(phases(events)).toEqual(['restore-files:skipped', 'environment:start', 'environment:failed']);
  });

  test('a command that exits 0 by itself closes the services phase as done', async () => {
    const events: ProgressEvent[] = [];
    await runStartServices('/root', { taskId: 'demo' }, {
      getStorage: async () => fakeStorage(),
      resolveCmd: async () => 'pm2 start',
      progress: (e) => events.push(e),
      ensureContainer: async () => ({ containerName: 'lazy-c', worktreePath: '/w', runnerType: 'docker', alreadyRunning: true }),
      exec: async () => ({ exitCode: 0, stdout: 'finished\n[PM2] started\n', stderr: '' }),
    });
    expect(events.at(-1)).toMatchObject({ id: 'services', state: 'done' });
    expect((events.at(-1) as ProgressPhaseEvent).detail).toContain('exit 0');
  });

  // A restore reports a note per percentage step; each becomes a write and a
  // page refresh in Teams, so they are throttled — and the last word before
  // the phase closes is never lost.
  test('restore notes are throttled, and the last one is sent before the phase closes', async () => {
    const events: ProgressEvent[] = [];
    await runStartServices('/root', { taskId: 'demo' }, {
      getStorage: async () => fakeStorage(),
      resolveCmd: async () => 'bin/dev',
      progress: (e) => events.push(e),
      now: () => 1000,
      ensureContainer: async (_root, params) => {
        params.restoreProgress?.('Restoring task files…');
        for (let i = 1; i <= 5; i++) params.restoreProgress?.(`Checking out files: ${i}/5`);
        params.onLaunching?.();
        return { containerName: 'lazy-c', worktreePath: '/w', runnerType: 'docker', alreadyRunning: false };
      },
      exec: async () => ({ exitCode: 0, stdout: 'running\n', stderr: '' }),
    });
    const notes = events.filter((e): e is ProgressPhaseEvent => e.kind === 'phase' && e.id === 'restore-files' && e.state === 'progress').map(e => e.detail);
    expect(notes).toEqual(['Checking out files: 1/5', 'Checking out files: 5/5']);
  });

  test("the restore's own failure message is passed through whole, remedy included", async () => {
    const msg = "Cannot restore task files: Could not check out branch 'lazy/llm-call-streaming' into /home/user/.lazy/projects/fabricate/.lazy/worktrees/llm-call-streaming. "
      + '4 file(s) could not be written (datasets/locations.us.sqlite, datasets/locations.global.sqlite, datasets/places.full.sqlite and 1 more): No such file or directory. '
      + "git said: Could not reset index file to revision 'HEAD'. "
      + "The task branch itself is untouched. Try again; if it fails the same way, check free disk space and that the directory is writable — git's full output is in the daemon log.";
    const err = await runStartServices('/root', { taskId: 'demo' }, {
      getStorage: async () => fakeStorage(),
      resolveCmd: async () => 'bin/dev',
      ensureContainer: async () => { throw new RpcError(409, msg); },
    }).catch(e => e);
    expect(err.status).toBe(409);
    expect(err.message).toBe(msg);
  });
});
