import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { resolve } from 'path';
import { mockModule, restoreMockedModules } from '../helpers/mock-module';
import { AcceptRefusedError } from '../../src/daemon/accept-refusal';

/**
 * The daemon-side halves of "a dead accept is resumed" and "follow-through is
 * retried": what a resume passes, how failures are counted, and when a system
 * message is filed.
 */

let acceptCalls: any[] = [];
let acceptImpl: (p: any) => Promise<any> = async () => ({});
let followImpl: () => Promise<any> = async () => ({ pending: [] });

await mockModule(resolve(import.meta.dir, '../../src/daemon/task-lifecycle.ts'), () => ({
  acceptTask: async (_root: string, p: any) => { acceptCalls.push(p); return acceptImpl(p); },
  runAcceptFollowThrough: async () => followImpl(),
}));

const { resumeDeadAccept, retryFollowThrough } = await import('../../src/daemon/stranded-merge');

let task: any;
let messages: any[] = [];
let comments: string[] = [];
const storage: any = {
  getTask: async () => task,
  updateTaskMetadata: async (_id: string, k: string, v: string) => {
    task.metadata = { ...task.metadata };
    if (v === '') delete task.metadata[k]; else task.metadata[k] = v;
  },
  createComment: async (_id: string, c: string) => { comments.push(c); },
  createSystemMessage: async (m: any) => { messages.push(m); return m; },
};

beforeEach(() => {
  acceptCalls = [];
  messages = [];
  comments = [];
  acceptImpl = async () => ({});
  followImpl = async () => ({ pending: [] });
  task = {
    id: 'task-1', code: 'child', status: 'merging',
    metadata: {
      accept_in_flight_from: 'blocked',
      accept_intent: JSON.stringify({ reason: 'ship it', actor: 'agent', callerTaskId: 'parent-1', recordedAt: 'x' }),
    },
  };
});

describe('resumeDeadAccept', () => {
  // INVARIANT: a resume never claims the caller-is-parent exemption. It lets an
  // agent merge into its own `working` worktree only while it is parked inside
  // its lazy_accept call; a daemon resume happens later, when that agent may be
  // editing the worktree again.
  test('never passes the original callerTaskId', async () => {
    await resumeDeadAccept(storage, '/tmp/x', task);
    expect(acceptCalls).toHaveLength(1);
    expect(acceptCalls[0].callerTaskId).toBeUndefined();
    expect(acceptCalls[0].reason).toBe('ship it');
    expect(acceptCalls[0].actor).toBe('agent');
  });

  // INVARIANT: a busy parent is "not yet", not a failure — it must not burn the
  // attempts that decide when the daemon gives up.
  test('a parent-active refusal reschedules without spending an attempt', async () => {
    acceptImpl = async () => { throw new AcceptRefusedError(409, 'parent busy', { reason: 'parent-active', next: 'wait' }); };
    await resumeDeadAccept(storage, '/tmp/x', task);
    expect(task.metadata.accept_resume_attempts).toBe('0');
    expect(Number(task.metadata.accept_resume_next_at)).toBeGreaterThan(Date.now());
    expect(messages).toHaveLength(0);
  });

  // INVARIANT: an accept finished elsewhere while the resume waited for the lock
  // (a human re-accept, remote-sync) is success — no attempt spent, no
  // "[Accept resume failed]" comment claiming the task was returned somewhere.
  test('an already-accepted refusal counts as success', async () => {
    acceptImpl = async () => {
      task.status = 'complete';
      task.metadata = {};
      throw new AcceptRefusedError(409, 'already accepted', { reason: 'already-accepted', next: 'nothing' });
    };
    await resumeDeadAccept(storage, '/tmp/x', task);
    expect(comments).toHaveLength(0);
    expect(messages).toHaveLength(0);
  });

  test('the last failed attempt files a system message; earlier ones only comment and back off', async () => {
    acceptImpl = async () => { throw new Error('boom'); };
    await resumeDeadAccept(storage, '/tmp/x', task);
    expect(messages).toHaveLength(0);
    expect(comments.at(-1)).toContain('Attempt 1/3');
    expect(Number(task.metadata.accept_resume_next_at)).toBeGreaterThan(Date.now());
    await resumeDeadAccept(storage, '/tmp/x', task);
    await resumeDeadAccept(storage, '/tmp/x', task);
    expect(task.metadata.accept_resume_attempts).toBe('3');
    expect(messages).toHaveLength(1);
    expect(messages[0].kind).toBe('alert');
  });
});

describe('retryFollowThrough', () => {
  // INVARIANT: a persistent follow-through failure files ONE system message.
  test('files one system message once attempts reach the threshold', async () => {
    task = { id: 'task-1', code: 'child', status: 'complete', metadata: {} };
    let attempts = 0;
    followImpl = async () => {
      attempts += 1;
      const rec = JSON.parse(task.metadata.accept_followthrough ?? '{"targetBranch":"main","done":[],"attempts":0}');
      task.metadata.accept_followthrough = JSON.stringify({ ...rec, attempts, lastError: 'push-parent: denied' });
      return { pending: ['push-parent'], error: 'push-parent: denied' };
    };
    for (let i = 0; i < 5; i++) await retryFollowThrough(storage, '/tmp/x', task);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toContain('push-parent');
  });
});

afterAll(() => {
  restoreMockedModules();
});
