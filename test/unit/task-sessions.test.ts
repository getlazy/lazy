/**
 * The daemon's reads of a task's tmux sessions (src/daemon/task-sessions.ts):
 * the list and one session's output, run here by a local `sh` against a real
 * tmux with the container's /tmp/lazy-tmux rewritten to a scratch dir — the
 * same stand-in serve-run.test.ts uses for the in-container scripts.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { listTaskSessions, readTaskSession, parseLastOutput, type TaskSessionsDeps } from '../../src/daemon/task-sessions';
import { startServicesScript } from '../../src/daemon/serve-run';
import { SESSIONS_DIR } from '../../src/sessions/tmux';
import type { Storage } from '../../src/storage';
import type { Task } from '../../src/types';

const hasTmux = Bun.which('tmux') !== null;
if (!hasTmux) console.log('skip: task-sessions reads against tmux — tmux is not on PATH; the task container (lazy\'s runner image) always has it');

const task = { id: 'abcdef1234567890', code: 'svc', status: 'blocked' } as unknown as Task;
const storage = {
  resolveTask: async (ref: string) => ({ task: ref === 'svc' ? task : null }),
  getSessionByTaskId: async () => ({ id: 'sess-1', task_id: task.id }),
  getSessionTurns: async () => [{ sequence: 0 }, { sequence: 1 }, { sequence: 2 }, { sequence: 3 }],
  getStatusHistory: async () => [
    { status: 'working', timestamp: Date.parse('2026-10-21T10:00:00Z') },
    { status: 'blocked', timestamp: Date.parse('2026-10-21T10:30:00Z') },
  ],
} as unknown as Storage;
const parkedAgent = { status: 'blocked', working: false, turn: 3, since: '2026-10-21T10:30:00.000Z' };

let dir = '';
afterEach(async () => {
  if (!dir) return;
  await Bun.spawn(['tmux', '-S', join(dir, 'default'), 'kill-server'], { stdout: 'ignore', stderr: 'ignore' }).exited;
  await rm(dir, { recursive: true, force: true });
  dir = '';
});

/** `docker exec <name> sh -c <script> …args` → the same `sh -c` run locally. */
function localDeps(running = true): TaskSessionsDeps {
  return {
    getStorage: async () => storage,
    memberEnvironments: async () => [],
    containerTarget: async () => (running ? { binary: 'docker', name: 'lazy-svc' } : null),
    exec: async (argv) => {
      expect(argv.slice(0, 3)).toEqual(['docker', 'exec', 'lazy-svc']);
      const [, , , ...rest] = argv;
      const proc = Bun.spawn(rest.map(a => a.replaceAll(SESSIONS_DIR, dir)), { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { exitCode, stdout, stderr };
    },
  };
}

async function startServices(command: string): Promise<void> {
  const proc = Bun.spawn(['sh', '-c', startServicesScript().replaceAll(SESSIONS_DIR, dir), 'lazy-services', command, dir], { stdout: 'pipe', stderr: 'pipe' });
  expect(await proc.exited).toBe(0);
}

describe('last output time', () => {
  test('parses name and epoch lines, ignoring anything else', () => {
    const parsed = parseLastOutput('services 1760000000\nnoise\nworker 1760000060\n');
    expect([...parsed]).toEqual([
      ['services', new Date(1760000000 * 1000).toISOString()],
      ['worker', new Date(1760000060 * 1000).toISOString()],
    ]);
  });

  test('a failure to read the times leaves them unknown and keeps the list', async () => {
    const deps: TaskSessionsDeps = {
      getStorage: async () => storage,
      memberEnvironments: async () => [],
      containerTarget: async () => ({ binary: 'docker', name: 'lazy-svc' }),
      exec: async (argv) => argv.some(a => a.startsWith('for n in'))
        ? { exitCode: 1, stdout: '', stderr: 'boom' }
        : { exitCode: 0, stdout: '@@sessions\nservices\t42\t0\t\t1760000000\t0\n@@end\n', stderr: '' },
    };
    const list = await listTaskSessions('/project', { taskId: 'svc' }, deps);
    expect(list.sessions.map(s => [s.name, s.lastOutputAt])).toEqual([['services', null]]);
  });
});

describe('task sessions', () => {
  // INVARIANT: a person's shell session and the services session share ONE tmux
  // server (one socket), so both are listed; a shell command that ends closes
  // its session instead of leaving a dead pane (remain-on-exit is not global).
  test.skipIf(!hasTmux)('shell and services sessions share one server; an exited shell session closes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'task-sessions-'));
    await startServices('sleep 300');
    const sock = join(dir, 'default');
    Bun.spawnSync(['tmux', '-S', sock, 'new-session', '-d', '-s', 'shell', 'sleep 300']);
    Bun.spawnSync(['tmux', '-S', sock, 'new-session', '-d', '-s', 'brief', 'true']);
    await Bun.sleep(500);
    const list = await listTaskSessions('/project', { taskId: 'svc' }, localDeps());
    expect(list.sessions.map(s => s.name).sort()).toEqual(['services', 'shell']);
  }, 20_000);

  test.skipIf(!hasTmux)('lists the services session and reads its live screen and log', async () => {
    dir = await mkdtemp(join(tmpdir(), 'task-sessions-'));
    await startServices('echo hello-from-services; sleep 300');
    const deps = localDeps();

    let list = await listTaskSessions('/project', { taskId: 'svc' }, deps);
    expect(list).toMatchObject({ task: 'svc', sessionId: 'sess-1', container: 'lazy-svc', running: true, tmux: true });
    expect(list.sessions.map(s => [s.name, s.alive])).toEqual([['services', true]]);
    // When it last printed comes from its log, which the start just created.
    for (let i = 0; i < 40 && list.sessions[0]!.lastOutputAt === null; i++) {
      await Bun.sleep(100);
      list = await listTaskSessions('/project', { taskId: 'svc' }, deps);
    }
    expect(Math.abs(Date.parse(list.sessions[0]!.lastOutputAt!) - Date.now())).toBeLessThan(60_000);

    let read = await readTaskSession('/project', { taskId: 'svc', name: 'services' }, deps);
    for (let i = 0; i < 40 && !read.output?.log.includes('hello-from-services'); i++) {
      await Bun.sleep(100);
      read = await readTaskSession('/project', { taskId: 'svc', name: 'services' }, deps);
    }
    expect(read.output?.exists).toBe(true);
    expect(read.output?.screen).toContain('hello-from-services');
    expect(read.output?.log).toContain('hello-from-services');
  }, 30_000);

  test.skipIf(!hasTmux)('a session that is not there reads as absent, not as an error', async () => {
    dir = await mkdtemp(join(tmpdir(), 'task-sessions-'));
    const read = await readTaskSession('/project', { taskId: 'svc', name: 'worker' }, localDeps());
    expect(read.output).toMatchObject({ name: 'worker', exists: false, screen: '', log: '' });
    expect((await listTaskSessions('/project', { taskId: 'svc' }, localDeps())).sessions).toEqual([]);
  });

  // INVARIANT: a read never starts the task's container — "not running" is
  // the answer, with nothing in it — and a container that could not be asked
  // is an error, never an empty list ("not known" is not "not running").
  test('a stopped container answers running: false; a failed read is an error', async () => {
    expect(await listTaskSessions('/project', { taskId: 'svc' }, localDeps(false))).toEqual({
      task: 'svc', sessionId: 'sess-1', container: null, running: false, tmux: null, sessions: [],
      members: [], agent: parkedAgent,
    });
    const failing: TaskSessionsDeps = {
      ...localDeps(),
      exec: async () => ({ exitCode: 1, stdout: '', stderr: 'Error: No such container: lazy-svc' }),
    };
    await expect(listTaskSessions('/project', { taskId: 'svc' }, failing)).rejects.toThrow(/No such container/);
  });

  test('rejects a bad name, bad sizes and an unknown task', async () => {
    const deps = localDeps(false);
    await expect(readTaskSession('/project', { taskId: 'svc', name: '../etc' }, deps)).rejects.toThrow(/session name/);
    await expect(readTaskSession('/project', { taskId: 'svc', name: 'services', lines: 0 }, deps)).rejects.toThrow(/lines/);
    await expect(readTaskSession('/project', { taskId: 'svc', name: 'services', logBytes: 'x' }, deps)).rejects.toThrow(/logBytes/);
    await expect(listTaskSessions('/project', { taskId: 'nope' }, deps)).rejects.toThrow(/Task not found/);
  });
});

describe('who else is in the task', () => {
  // INVARIANT: the session list names the members inside the task with their
  // session NAMES, attached state and times — read from their own containers
  // — and the agent's state from the task status. Never anything a member's
  // sessions printed: the member read asks only for names and states.
  test('members come with session names and states; a member container that cannot be asked is not an error', async () => {
    const deps: TaskSessionsDeps = {
      ...localDeps(false),
      memberEnvironments: async () => [
        { email: 'ada@example.com', openTerminals: 1, container: { name: 'm1', binary: 'docker', remove: async () => {}, activity: async () => ({ sessions: 2, attached: true, lastActivityMs: 1_760_000_000_000, named: [
          { name: 'shell', attachedClients: 1, lastActivityMs: 1_760_000_000_000 },
          { name: 'vscode-server', attachedClients: 0, lastActivityMs: 1_759_999_000_000 },
        ] }) } },
        { email: 'bo@example.com', openTerminals: 0, container: { name: 'm2', binary: 'docker', remove: async () => {}, activity: async () => { throw new Error('gone'); } } },
      ],
    };
    const list = await listTaskSessions('/project', { taskId: 'svc' }, deps);
    expect(list.members).toEqual([
      { member: 'ada@example.com', openTerminals: 1, sessions: [
        { name: 'shell', attached: true, lastActivityAt: new Date(1_760_000_000_000).toISOString() },
        { name: 'vscode-server', attached: false, lastActivityAt: new Date(1_759_999_000_000).toISOString() },
      ] },
      { member: 'bo@example.com', openTerminals: 0, sessions: null },
    ]);
    expect(list.agent).toEqual(parkedAgent);
  });
});

describe('who else is in the task: bounded and without the viewer', () => {
  const held = (email: string, activity: () => Promise<never> | Promise<{ sessions: number; attached: boolean; lastActivityMs: number | null; named: { name: string; attachedClients: number; lastActivityMs: number }[] }>) =>
    ({ email, openTerminals: 1, container: { name: `m-${email}`, binary: 'docker', remove: async () => {}, activity } });

  // INVARIANT: a member container that hangs leaves THAT member's sessions
  // unknown and answers anyway — the list sits before a terminal opens and
  // beside a page, and one wedged container must not hold everyone up.
  test('a member container that never answers is reported unknown, within the limit', async () => {
    const started = Date.now();
    const list = await listTaskSessions('/project', { taskId: 'svc' }, {
      ...localDeps(false),
      memberReadTimeoutMs: 200,
      memberEnvironments: async () => [held('stuck@example.com', () => new Promise<never>(() => {}))],
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(list.members).toEqual([{ member: 'stuck@example.com', openTerminals: 1, sessions: null }]);
  });

  // INVARIANT: the entry notice names everyone else and never the person
  // entering, decided from who the daemon authenticated; and a notice that
  // cannot be built in time is none, never a terminal that does not open.
  test('the entry notice leaves the viewer out, and gives up in time', async () => {
    const { presenceEntryNotice } = await import('../../src/server/session-attach-ws');
    const sessions = async () => ({ sessions: 1, attached: true, lastActivityMs: Date.now(), named: [{ name: 'shell', attachedClients: 1, lastActivityMs: Date.now() }] });
    const notice = await presenceEntryNotice('/project', storage, 'svc', 'alice@example.com', {
      deps: { ...localDeps(false), memberEnvironments: async () => [held('alice@example.com', sessions), held('bob@example.com', sessions)] },
    });
    expect(notice).toContain('bob@example.com');
    expect(notice).not.toContain('alice@example.com');

    const started = Date.now();
    const hung = await presenceEntryNotice('/project', storage, 'svc', null, {
      timeoutMs: 200,
      deps: { ...localDeps(false), memberEnvironments: () => new Promise<never>(() => {}) },
    });
    expect(hung).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
