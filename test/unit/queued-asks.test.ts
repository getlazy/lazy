import { describe, test, expect } from 'bun:test';
import { mayDispatchQueuedAsks, queuedAskOwner, shouldQueueAsk, waitingQueuedAsks } from '../../src/daemon/queued-asks';
import { buildChat } from '../../src/task/chat';
import type { ReviewComment, Session, Task } from '../../src/types';

const task = (status: string, extra: Partial<Task> = {}) => ({ id: 't', status, ...extra }) as unknown as Task;
const session = (extra: Partial<Session> = {}) => ({ id: 's', agent_session_id: 'a', ended_at: null, ...extra }) as unknown as Session;
const comment = (over: Partial<ReviewComment>) => ({
  id: 'c', task_id: 't', thread_id: 'c', file: '(task)', line: 0, side: 'new', role: 'human',
  content: 'Hi?', created_at: 1, intent: 'ask', ...over,
}) as ReviewComment;

describe('queued chat asks', () => {
  // INVARIANT: a question waits only for a turn that will end on its own, in a
  // session that can be resumed — anything else is answered at once.
  test('queues only while a resumable session is mid-turn', () => {
    expect(shouldQueueAsk(task('working'), session())).toBe(true);
    expect(shouldQueueAsk(task('pairing'), session())).toBe(true);
    expect(shouldQueueAsk(task('blocked'), session())).toBe(false);
    expect(shouldQueueAsk(task('working'), session({ ended_at: 5 } as Partial<Session>))).toBe(false);
    expect(shouldQueueAsk(task('working'), session({ agent_session_id: null } as Partial<Session>))).toBe(false);
    expect(shouldQueueAsk(task('working'), null)).toBe(false);
  });

  // INVARIANT: the queue never wakes a stopped task, never races another
  // turn's slot, and waits out an interrupted task's auto-resume.
  test('dispatches only once the task parked, unclaimed and not stopped', () => {
    expect(mayDispatchQueuedAsks(task('blocked'), session())).toBe(true);
    expect(mayDispatchQueuedAsks(task('working'), session())).toBe(false);
    expect(mayDispatchQueuedAsks(task('interrupted'), session())).toBe(false);
    expect(mayDispatchQueuedAsks(task('blocked'), session({ user_stopped: true } as Partial<Session>))).toBe(false);
    expect(mayDispatchQueuedAsks(task('blocked', { in_flight_turn: {} } as Partial<Task>), session())).toBe(false);
  });

  test('runs as the person who asked, and skips withdrawn questions', () => {
    const asked = comment({ ask_state: 'queued', ask_owner_email: 'ivan@example.com', ask_owner_name: 'Ivan', ask_owner_spendable: true });
    expect(queuedAskOwner(asked)).toEqual({ email: 'ivan@example.com', name: 'Ivan', spendable: true });
    expect(queuedAskOwner(comment({ ask_state: 'queued' }))).toBeNull();
    expect(waitingQueuedAsks([asked, comment({ id: 'w', ask_state: 'queued', withdrawn_at: 3 })]).map((c) => c.id)).toEqual(['c']);
  });

  // INVARIANT: Chat shows a queued question as waiting, never as a failure.
  test('Chat shows a queued question as queued', () => {
    expect(buildChat([], [comment({ ask_state: 'queued' })])[0]!.state).toBe('queued');
  });
});
