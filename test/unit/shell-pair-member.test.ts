/**
 * Pair over the session-attach route on a SHARED daemon names the attaching
 * member (src/server/shell-pair.ts `member`).
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { pinDaemonBaseDir } from '../helpers/daemon-base-dir';
import { putUserCredential, clearUserCredentialCache } from '../../src/daemon/user-credentials';
import { clearSessionCredentialCache } from '../../src/daemon/session-credentials';
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { planPairOrChatExec, resetWebPairStateForTests } from '../../src/server/shell-pair';
import { getWorktreePath } from '../../src/task/identity';
import type { Storage } from '../../src/storage';
import type { Session, Task, ActorInput } from '../../src/types';

let root: string | null = null;
let base: string | null = null;
let unpin: (() => void) | null = null;
let prevLazyTest: string | undefined;
// A member's terminal on a shared daemon runs on their OWN stored credential
// and is refused without one, so every member here has one stored. LAZY_TEST
// is the daemon-self bypass: there is no live proxy address in a unit test.
beforeEach(async () => {
  prevLazyTest = process.env.LAZY_TEST;
  process.env.LAZY_TEST = '1';
  base = await mkdtemp(join(tmpdir(), 'lzd-pair-member-'));
  unpin = pinDaemonBaseDir(base);
  clearUserCredentialCache();
  clearSessionCredentialCache();
});
afterEach(async () => {
  resetWebPairStateForTests();
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
  unpin?.();
  if (base) await rm(base, { recursive: true, force: true });
  if (prevLazyTest === undefined) delete process.env.LAZY_TEST;
  else process.env.LAZY_TEST = prevLazyTest;
  clearUserCredentialCache();
  clearSessionCredentialCache();
});

async function storeCredentials(projectRoot: string, ...emails: string[]) {
  for (const email of emails) {
    await putUserCredential(projectRoot, { userId: email, kind: 'api-key', token: `sk-ant-api-${email}` } as never);
  }
}

describe('web Pair attribution', () => {
  // INVARIANT: on a shared daemon the pairing's status change names the member
  // whose token opened it, never a bare role nobody can be traced to.
  test("a member's Pair moves the task to pairing under their name", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'pair-member-')));
    const task = { id: 'task-1', code: 'demo', status: 'blocked', agent_id: 'claude-code', metadata: { task_ref: 'demo' } } as unknown as Task;
    await mkdir(getWorktreePath(root, task), { recursive: true });
    await storeCredentials(root, 'alice@example.com');
    const statuses: Array<{ status: string; actor: ActorInput | undefined }> = [];
    const storage = {
      updateTaskStatus: async (_id: string, status: string, actor?: ActorInput) => { statuses.push({ status, actor }); },
      updateTaskMetadata: async () => {},
      getSessionByTaskId: async () => null,
      getProjectSettings: async () => null,
      getTask: async () => task,
    } as unknown as Storage;
    const session = { id: 'sess-1', task_id: 'task-1', runner_type: 'docker' } as unknown as Session;

    const planned = await planPairOrChatExec({
      root, storage, task, session, mode: 'pair',
      member: { email: 'alice@example.com', name: 'Alice' },
    });
    // The attribution half is what this pins; the credential is the member
    // container's own (src/daemon/member-container.ts).
    expect(planned.ok).toBe(true);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ status: 'pairing', actor: { email: 'alice@example.com', name: 'Alice' } });
    if (planned.ok) planned.plan.abort();
    // The release parks the task under the SAME member.
    await new Promise((r) => setTimeout(r, 50));
    expect(statuses.at(-1)?.actor).toMatchObject({ email: 'alice@example.com' });
  });

  // INVARIANT: a reconnect inside the 30s grace resumes only the SAME
  // member's hold — another member taking it over would pair under the first
  // member's name.
  test("another member cannot take over a Pair inside its grace window", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'pair-grace-')));
    const task = { id: 'task-2', code: 'demo2', status: 'blocked', agent_id: 'claude-code', metadata: { task_ref: 'demo2' } } as unknown as Task;
    await mkdir(getWorktreePath(root, task), { recursive: true });
    await storeCredentials(root, 'alice@example.com', 'bob@example.com');
    const storage = {
      updateTaskStatus: async () => {},
      updateTaskMetadata: async () => {},
      getSessionByTaskId: async () => null,
      getProjectSettings: async () => null,
      getTask: async () => task,
    } as unknown as Storage;
    const session = { id: 'sess-2', task_id: 'task-2', runner_type: 'docker' } as unknown as Session;
    const plan = (email: string) => planPairOrChatExec({ root: root!, storage, task, session, mode: 'pair', member: { email } });

    const alice = await plan('alice@example.com');
    expect(alice.ok).toBe(true);
    if (alice.ok) alice.plan.onClose(); // dropped: the 30s grace starts

    const bob = await plan('bob@example.com');
    expect(bob).toMatchObject({ ok: false, status: 409 });

    const back = await plan('alice@example.com');
    expect(back.ok).toBe(true);
  });
});

describe('web Pair on a working task', () => {
  // INVARIANT: the CLI's rule — pairing takes over the agent's session, which
  // a running turn owns — holds for the web Pair too.
  test('is refused while the agent is mid-turn, before anything is locked', async () => {
    const r = await realpath(await mkdtemp(join(tmpdir(), 'pair-working-')));
    try {
      const task = { id: 'task-3', code: 'demo3', status: 'working', agent_id: 'claude-code', metadata: { task_ref: 'demo3' } } as unknown as Task;
      await mkdir(getWorktreePath(r, task), { recursive: true });
      const statuses: string[] = [];
      const storage = {
        updateTaskStatus: async (_id: string, status: string) => { statuses.push(status); },
        updateTaskMetadata: async () => {},
        getSessionByTaskId: async () => null,
        getProjectSettings: async () => null,
        getTask: async () => task,
      } as unknown as Storage;
      const session = { id: 'sess-3', task_id: 'task-3', runner_type: 'docker' } as unknown as Session;
      const planned = await planPairOrChatExec({ root: r, storage, task, session, mode: 'pair' });
      expect(planned).toMatchObject({ ok: false, status: 409 });
      expect(statuses).toEqual([]);
    } finally {
      await rm(r, { recursive: true, force: true });
    }
  });
});

describe('a turn that launched after the member entered', () => {
  // INVARIANT: where the mode lock is taken, Pair and Chat re-check a FRESH
  // read — the task's status and its binding's liveness — so a turn launched
  // between the member's entry and the lock (it binds before it flips to
  // `working`) is never joined by a member's Pair.
  test("a member's Pair is refused when the task's binding went live since entry", async () => {
    const { bindTurnCredential } = await import('../../src/daemon/session-credentials');
    root = await realpath(await mkdtemp(join(tmpdir(), 'pair-live-')));
    const task = { id: 'task-4', code: 'demo4', status: 'blocked', agent_id: 'claude-code', metadata: { task_ref: 'demo4' } } as unknown as Task;
    await mkdir(getWorktreePath(root, task), { recursive: true });
    await storeCredentials(root, 'alice@example.com');
    await bindTurnCredential(root, { taskId: 'task-4', sessionId: 'sess-4', ownerUserId: 'bob@example.com', kind: 'api-key' });
    const statuses: string[] = [];
    const storage = {
      updateTaskStatus: async (_id: string, status: string) => { statuses.push(status); },
      updateTaskMetadata: async () => {},
      getSessionByTaskId: async () => null,
      getProjectSettings: async () => null,
      getTask: async () => task,
    } as unknown as Storage;
    const session = { id: 'sess-4', task_id: 'task-4', runner_type: 'docker' } as unknown as Session;

    const planned = await planPairOrChatExec({ root, storage, task, session, mode: 'pair', member: { email: 'alice@example.com' } });
    expect(planned).toMatchObject({ ok: false, status: 409 });
    expect(statuses).toEqual([]);
  });
});

describe("a member's Pair and Chat in their own container", () => {
  // INVARIANT: a member's Pair runs in their own container, which holds their
  // credential and NO lazy MCP config: the exec adds no credential of any
  // kind, and the agent is started without lazy tools rather than handed a
  // token for somebody else's turn.
  test('run with no lazy tools and add no credential to the exec', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'pair-own-')));
    const task = { id: 'task-5', code: 'demo5', status: 'blocked', agent_id: 'claude-code', metadata: { task_ref: 'demo5' } } as unknown as Task;
    await mkdir(getWorktreePath(root, task), { recursive: true });
    const storage = {
      updateTaskStatus: async () => {},
      updateTaskMetadata: async () => {},
      getSessionByTaskId: async () => null,
      getProjectSettings: async () => null,
      getTask: async () => task,
    } as unknown as Storage;
    const session = { id: 'sess-5', task_id: 'task-5', runner_type: 'docker' } as unknown as Session;
    const planned = await planPairOrChatExec({ root, storage, task, session, mode: 'pair', member: { email: 'alice@example.com' } });
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.plan.cmd).toContain('--member-session');
    expect(planned.plan.env).toEqual(['TERM=xterm-256color']);
    planned.plan.abort();
  });

  // INVARIANT: a member's Pair or Chat spends the member's own Claude
  // account, so it is offered only for a task whose agent is Claude Code on
  // Anthropic's own API. Any other agent would need a credential the member
  // does not have (a Cursor key, a profile's own key) — refused, not spent.
  test('are refused for a task on another agent, before anything is locked', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'pair-other-agent-')));
    const task = { id: 'task-6', code: 'demo6', status: 'blocked', agent_id: 'cursor', metadata: { task_ref: 'demo6' } } as unknown as Task;
    await mkdir(getWorktreePath(root, task), { recursive: true });
    const statuses: string[] = [];
    const storage = {
      updateTaskStatus: async (_id: string, status: string) => { statuses.push(status); },
      updateTaskMetadata: async () => {},
      getSessionByTaskId: async () => null,
      getProjectSettings: async () => null,
      getTask: async () => task,
    } as unknown as Storage;
    const session = { id: 'sess-6', task_id: 'task-6', runner_type: 'docker' } as unknown as Session;
    const planned = await planPairOrChatExec({ root, storage, task, session, mode: 'pair', member: { email: 'alice@example.com' } });
    expect(planned).toMatchObject({ ok: false, status: 409 });
    if (!planned.ok) expect(planned.message).toContain('your own Claude account');
    expect(statuses).toEqual([]);

    const { pairOrChatRefusal } = await import('../../src/server/shell-pair');
    expect(await pairOrChatRefusal(root, task, 'pair', 'alice@example.com')).toContain('your own Claude account');
    // Locally (no member) the agent rules are the CLI's, unchanged.
    expect(await pairOrChatRefusal(root, task, 'pair', null)).toBeNull();
  });
});
