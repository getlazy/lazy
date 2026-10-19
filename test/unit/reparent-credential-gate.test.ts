/**
 * INVARIANT: reparent refuses for want of a turn credential BEFORE it repoints
 * the task. Whether the merge onto the new parent is clean is unknown until it
 * runs, and a conflict needs an agent to resolve it; so a member who cannot pay
 * for a turn is refused up front, mirroring the browser's reparent. Refusing
 * after the repoint left the task moved onto a parent it was never synced with. A task with no live session runs no turn, so it is moved
 * regardless and never asked for a credential.
 */

import { describe, test, expect, spyOn } from 'bun:test';
import * as rpcHandlers from '../../src/daemon/rpc-handlers';
import * as turnCredentials from '../../src/daemon/turn-credentials';
import { reparentTask } from '../../src/daemon/task-lifecycle';

const base = { id: 'cred-task-0000-uuid', code: 'cred', goal: 'Cred', type: 'task', agent_id: 'claude-code', created_at: 1, metadata: {}, target: { kind: 'branch', branch: 'main' } };
const PARENT = { id: 'new-parent-0000-uuid', code: 'np', goal: 'New parent', status: 'blocked', type: 'task', agent_id: 'claude-code', created_at: 1, metadata: {}, target: { kind: 'branch', branch: 'main' } };

const WRITES = /^(create|update|delete|set|add|end|increment|mark|close|resolve[A-Z]|record|append|put|remove)/;
function storageFor(task: Record<string, unknown>, session: Record<string, unknown> | null, writes: string[]) {
  const byId = (id: string) => (id === task.id || id === 'cred' ? task : id === PARENT.id || id === 'np' ? PARENT : null);
  return new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') return undefined;
      return async (...args: unknown[]) => {
        if (prop === 'resolveTask') return { task: byId(String(args[0])), ambiguousMatches: [] };
        if (prop === 'getTask') return byId(String(args[0]));
        if (prop === 'getTaskAncestry') return [];
        if (prop === 'getSessionByTaskId') return session;
        if (prop === 'getSessionTurns' || prop === 'getChildTasks') return [];
        if (prop === 'getProjectSettings') return {};
        if (WRITES.test(prop)) { writes.push(prop); return undefined; }
        return null;
      };
    },
  });
}

describe('reparent and the turn credential', () => {
  test('a task with a live session is refused up front and nothing is written', async () => {
    const writes: string[] = [];
    const storage = spyOn(rpcHandlers, 'getOrCreateStorage').mockResolvedValue(
      storageFor({ ...base, status: 'blocked' }, { id: 's', task_id: base.id, ended_at: null }, writes) as never,
    );
    const gate = spyOn(turnCredentials, 'assertTurnCredentialAvailable').mockRejectedValue(
      new rpcHandlers.RpcError(400, 'No Claude credential for alice@example.com'),
    );
    try {
      const err = await reparentTask('/nonexistent-project', { taskId: 'cred', parent: 'np' } as never).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(rpcHandlers.RpcError);
      expect((err as Error).message).toContain('No Claude credential');
      expect(writes).toEqual([]);
    } finally {
      storage.mockRestore();
      gate.mockRestore();
    }
  });

  test('a backlog task runs no turn, so it is never asked for a credential', async () => {
    const writes: string[] = [];
    const storage = spyOn(rpcHandlers, 'getOrCreateStorage').mockResolvedValue(
      storageFor({ ...base, status: 'backlog' }, null, writes) as never,
    );
    const gate = spyOn(turnCredentials, 'assertTurnCredentialAvailable').mockRejectedValue(new Error('must not be asked'));
    try {
      await reparentTask('/nonexistent-project', { taskId: 'cred', parent: 'np' } as never).catch(() => undefined);
      expect(gate).not.toHaveBeenCalled();
    } finally {
      storage.mockRestore();
      gate.mockRestore();
    }
  });
});
