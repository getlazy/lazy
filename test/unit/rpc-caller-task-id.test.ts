/**
 * `callerTaskId` on a person's token is refused at the daemon's RPC boundary.
 *
 * The handlers read `callerTaskId` as proof that the caller is a task's own
 * running agent: it lets a `working` task sync itself and lets a child be
 * accepted into a parent whose agent is mid-turn. Only the MCP boundary sets
 * it, from its authenticated per-task context, and MCP never reaches the
 * handlers on a USER token. The Teams CLI proxy relays a member's request on
 * exactly such a token — so this is the daemon's half of the defence in depth
 * behind the proxy's own body-key allowlist, and it must REFUSE rather than
 * strip, so a regression in the proxy shows up.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleRpc } from '../../src/daemon/rpc-handlers';
import { RpcError } from '../../src/daemon/rpc-error';

const MEMBER = { kind: 'user', email: 'ada@example.com', name: 'Ada' } as const;

describe('callerTaskId from a user-kind caller', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lazy-caller-task-id-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function refusal(command: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      await handleRpc(command, root, params, undefined, MEMBER);
    } catch (err) {
      return err;
    }
    return null;
  }

  // INVARIANT: a user-kind caller can never present callerTaskId. It is the
  // "I am this task's own agent" proof, and a person's token is never that —
  // honouring it let a member self-sync a WORKING task and accept into a
  // parent whose agent was still running, neither of which the browser allows.
  for (const command of [ 'syncTask', 'acceptTask', 'acceptTaskPreflight' ]) {
    test(`${command} carrying callerTaskId is refused with 403`, async () => {
      const err = await refusal(command, { taskId: 'task-1', callerTaskId: 'task-1' });

      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).status).toBe(403);
      expect((err as RpcError).message).toContain('callerTaskId');
    });
  }

  test('callerTaskId nested in a storage call\'s args is refused too', async () => {
    const err = await refusal('storage', { method: 'getTask', args: { taskId: 'task-1', callerTaskId: 'task-1' } });

    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).status).toBe(403);
  });

  test('the same body without callerTaskId is not refused for that reason', async () => {
    // It fails further in (no project here), but NOT on callerTaskId — so the
    // refusal above is the key, not the command.
    const err = await refusal('syncTask', { taskId: 'task-1' });

    expect(String((err as Error | null)?.message ?? '')).not.toContain('callerTaskId');
  });
});
