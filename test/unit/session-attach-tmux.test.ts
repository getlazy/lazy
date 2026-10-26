/**
 * `?tmux=<name>` on the session attach route: a terminal attached to one of
 * the task container's named tmux sessions (src/sessions/tmux.ts).
 */

import { describe, test, expect } from 'bun:test';
import type { Server } from 'bun';
import { createSessionAttachUpgrader } from '../../src/server/session-attach-ws';
import { attachSessionArgv } from '../../src/sessions/tmux';
import type { Storage } from '../../src/storage';
import type { Session, Task } from '../../src/types';

const ROOT = '/projects/demo';
const TASK = { id: 'task-1', status: 'working', runner_type: 'docker', metadata: { task_ref: 'some-task' } } as unknown as Task;
const SESSION = { id: 'sess-1', task_id: 'task-1', container_name: null, runner_type: 'docker' } as unknown as Session;

const storage = {
  getBuilderSession: async () => null,
  getSession: async (id: string) => (id === SESSION.id ? SESSION : null),
  getSessionByTaskId: async () => SESSION,
  getTask: async () => TASK,
  getSessionTurns: async () => [{ sequence: 1 }],
  getCommitRun: async () => null,
} as unknown as Storage;

function upgrader(opts: { multiMember: boolean; caller: string | null; running?: boolean; bindingLive?: boolean }) {
  return createSessionAttachUpgrader({
    getStorage: async () => storage,
    root: ROOT,
    authenticate: async () => ({
      ok: true,
      actor: opts.caller ? { kind: 'user', email: opts.caller } as never : { kind: 'control' },
      legacyShared: !opts.caller,
    }),
    multiMember: async () => opts.multiMember,
    confirmRunning: async () => (opts.running === false ? { ok: false, status: 409, message: 'Container for this task is not running.' } : { ok: true }),
    runnerFor: async () => ({ type: 'docker' as const, usesSandbox: () => true, runNameForTask: (ref: string) => `lazy-${ref}` }),
    enterAsMember: async () => { throw new Error('a tmux attach must never enter the task as a member'); },
  });
}

function capture() {
  const upgrades: Array<Record<string, unknown>> = [];
  const server = { upgrade: (_r: Request, o?: { data?: unknown }) => { upgrades.push(o?.data as Record<string, unknown>); return true; } } as unknown as Server<unknown>;
  return { server, upgrades };
}

const req = (query: string) => new Request(`http://daemon/rpc/sessions/${SESSION.id}/attach/ws?${query}`, {
  headers: { Authorization: 'Bearer t', 'X-Lazy-Project': ROOT },
});

describe('attaching to a task container\'s tmux session', () => {
  // INVARIANT: a tmux attach runs `tmux attach` — and nothing else — in the
  // TASK's own container, on a shared daemon too, and neither waits for a
  // turn nor holds one off: sessions and turns never block each other
  // (docs/design/task-sessions-and-ssh.md §1). A viewer is `attach -r`.
  test('a member attaches to the services session while a turn runs, without entering the task', async () => {
    const { server, upgrades } = capture();
    const outcome = await upgrader({ multiMember: true, caller: 'bob@example.com' })
      .tryUpgrade(req('tmux=services&container=evil&cmd=sh'), server);
    expect(outcome).toBe('upgraded');
    expect(upgrades[0]).toMatchObject({ container: 'lazy-some-task', attach: false, cmd: attachSessionArgv('services') });
    expect(upgrades[0]!.limits).toBeUndefined();
  });

  test('readonly=1 attaches a viewer that cannot type', async () => {
    const { server, upgrades } = capture();
    expect(await upgrader({ multiMember: false, caller: null }).tryUpgrade(req('tmux=services&readonly=1'), server)).toBe('upgraded');
    expect(upgrades[0]!.cmd).toEqual(attachSessionArgv('services', { readOnly: true }));
    expect(upgrades[0]!.cmd).toContain('-r');
  });

  test('refuses a bad name, a mode alongside, a stopped container, and a nameless caller on a shared daemon', async () => {
    const status = async (u: ReturnType<typeof upgrader>, q: string) => {
      const { server, upgrades } = capture();
      const outcome = await u.tryUpgrade(req(q), server);
      expect(upgrades).toHaveLength(0);
      return (outcome as Response).status;
    };
    expect(await status(upgrader({ multiMember: false, caller: null }), 'tmux=..%2Fx')).toBe(400);
    expect(await status(upgrader({ multiMember: false, caller: null }), 'tmux=services&mode=shell')).toBe(400);
    expect(await status(upgrader({ multiMember: false, caller: null, running: false }), 'tmux=services')).toBe(409);
    expect(await status(upgrader({ multiMember: true, caller: null }), 'tmux=services')).toBe(403);
  });
});
