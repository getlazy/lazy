/**
 * Pair over the session-attach route on a SHARED daemon names the attaching
 * member (src/server/shell-pair.ts `member`).
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { setDaemonContext, clearDaemonContext } from '../../src/daemon/context';
import { claimMemberTerminal, markMemberTerminalEntered, memberTerminalContainer, resetMemberTerminalsForTests } from '../../src/server/member-terminals';
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
  setDaemonContext({ webPort: 26025, token: 'unit-control' });
  base = await mkdtemp(join(tmpdir(), 'lzd-pair-member-'));
  unpin = pinDaemonBaseDir(base);
  clearUserCredentialCache();
  clearSessionCredentialCache();
});
afterEach(async () => {
  resetWebPairStateForTests();
  resetMemberTerminalsForTests();
  clearDaemonContext();
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

async function memberDirectory(projectRoot: string, taskId: string, email: string) {
  const directory = join(projectRoot, `mcp-${email}`);
  await mkdir(directory, { recursive: true });
  claimMemberTerminal(taskId, email);
  markMemberTerminalEntered(taskId, email);
  await memberTerminalContainer(taskId, email, async () => ({ name: 'member', binary: 'docker', remove: async () => {} }), async () => true);
  return directory;
}

describe('web Pair attribution', () => {
  // INVARIANT: members have separate sessions; pairing never claims the task's agent state.
  test("a member's Pair leaves the task's status alone", async () => {
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
      memberMcpDirectory: await memberDirectory(root, task.id, 'alice@example.com'),
    });
    // The attribution half is what this pins; the credential is the member
    // container's own (src/daemon/member-container.ts).
    expect(planned.ok).toBe(true);
    expect(statuses).toHaveLength(0);
    if (planned.ok) planned.plan.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(statuses).toHaveLength(0);
  });

  // INVARIANT: each member's authority is independent, including during a reconnect.
  test("another member can pair while the first member reconnects", async () => {
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
    const plan = async (email: string) => planPairOrChatExec({ root: root!, storage, task, session, mode: 'pair', member: { email }, memberMcpDirectory: await memberDirectory(root!, task.id, email) });

    const alice = await plan('alice@example.com');
    expect(alice.ok).toBe(true);
    if (alice.ok) alice.plan.onClose(); // dropped: the 30s grace starts

    const bob = await plan('bob@example.com');
    expect(bob.ok).toBe(true);
    if (bob.ok) bob.plan.abort();

    const back = await plan('alice@example.com');
    expect(back.ok).toBe(true);
    if (back.ok) back.plan.abort();
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
  // INVARIANT: a member's independent conversation can run beside an agent turn.
  test("a member's Pair can open when the task's binding went live since entry", async () => {
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

    const planned = await planPairOrChatExec({ root, storage, task, session, mode: 'pair', member: { email: 'alice@example.com' }, memberMcpDirectory: await memberDirectory(root, task.id, 'alice@example.com') });
    expect(planned.ok).toBe(true);
    if (planned.ok) planned.plan.abort();
    expect(statuses).toEqual([]);
  });
});

describe("a member's Pair and Chat in their own container", () => {
  // INVARIANT: a member gets only their own tools; no task token or credential rides in the exec env.
  test('runs with its own lazy tools and adds no credential to the exec', async () => {
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
    const planned = await planPairOrChatExec({ root, storage, task, session, mode: 'pair', member: { email: 'alice@example.com' }, memberMcpDirectory: await memberDirectory(root, task.id, 'alice@example.com') });
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.plan.cmd).toContain('--member-session');
    expect(planned.plan.cmd).toContain('--member-mcp-config');
    expect(planned.plan.env).toEqual(['TERM=xterm-256color']);
    planned.plan.abort();
  });

  // INVARIANT (engineer, 2026-10-24, superseding "Claude Code only"): a
  // member's Pair or Chat runs whichever of Claude Code, Codex, Cursor or Pi
  // the task runs, on that profile's credential for the member — exactly what a
  // turn the member launches spends. Cursor, which has no transcript lazy can
  // carry, starts a new conversation instead of naming a session its home lacks.
  test('run a Cursor task in the member\'s own container, without resuming a session it cannot carry', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'pair-cursor-member-')));
    const task = { id: 'task-7', code: 'demo7', status: 'blocked', agent_id: 'cursor', metadata: { task_ref: 'demo7' } } as unknown as Task;
    await mkdir(getWorktreePath(root, task), { recursive: true });
    const storage = {
      updateTaskStatus: async () => {},
      updateTaskMetadata: async () => {},
      getSessionByTaskId: async () => null,
      getProjectSettings: async () => null,
      getTask: async () => task,
    } as unknown as Storage;
    const session = { id: 'sess-7', task_id: 'task-7', runner_type: 'docker', agent_session_id: 'cursor-chat-1' } as unknown as Session;
    const planned = await planPairOrChatExec({ root, storage, task, session, mode: 'pair', member: { email: 'alice@example.com' }, memberMcpDirectory: await memberDirectory(root, task.id, 'alice@example.com') });
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.plan.cmd).toContain('--member-session');
    expect(planned.plan.cmd[planned.plan.cmd.indexOf('--agent') + 1]).toBe('cursor');
    expect(planned.plan.cmd).not.toContain('--resume');
    planned.plan.abort();
  });

  // INVARIANT: a harness with no member-session isolation is refused before
  // anything is locked — its session would run with nobody having decided
  // what of the worktree it loads next to the member's credential.
  test('are refused for a task on an agent with no member session, before anything is locked', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'pair-other-agent-')));
    const task = { id: 'task-6', code: 'demo6', status: 'blocked', agent_id: 'qa-agent', metadata: { task_ref: 'demo6' } } as unknown as Task;
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
    const planned = await planPairOrChatExec({ root, storage, task, session, mode: 'pair', member: { email: 'alice@example.com' }, memberMcpDirectory: await memberDirectory(root, task.id, 'alice@example.com') });
    expect(planned).toMatchObject({ ok: false, status: 409 });
    expect(statuses).toEqual([]);

    const { pairOrChatRefusal } = await import('../../src/server/shell-pair');
    expect(await pairOrChatRefusal(root, task, 'pair', 'alice@example.com')).toContain('does not support pairing');
    // Locally (no member) the agent rules are the CLI's: same refusal.
    expect(await pairOrChatRefusal(root, task, 'pair', null)).toContain('does not support pairing');
  });
});
