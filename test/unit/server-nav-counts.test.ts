/**
 * `/api/nav-counts` when something is missing or lying.
 *
 * The happy path — every count agreeing with the page it points at — is covered
 * end-to-end against a real daemon in test/e2e/server-messages.test.ts. What a
 * daemon-backed suite CANNOT reach is the degraded half: a store whose reads
 * fail, a handler wired with no review action port, and a browser sending back a
 * mark this server could not have produced. Those are exactly the cases where a
 * count badge would start lying, so they get a stub-storage unit test.
 */

import { describe, test, expect } from 'bun:test';
import { createWebRequestHandler } from '../../src/server/index';
import type { Storage } from '../../src/storage';
import type { ReviewActions } from '../../src/server/review-actions';

interface StubOptions {
  unread?: number;
  /** Open BLOCKING raised items — the half that holds up an accept. */
  raisedBlocking?: number;
  /** Open non-blocking raised items — the former follow-ups. */
  raisedNonBlocking?: number;
  /** `importedAt` values, one per conversation. */
  conversations?: number[];
  /** Live (non-terminal) tasks, as `[type, status]` pairs — the Loops badge's input. */
  liveTasks?: Array<[string, string]>;
  /** Reads that should reject, by name. */
  fail?: Array<'messages' | 'raised' | 'conversations' | 'tasks'>;
}

function stubStorage(options: StubOptions = {}): Storage {
  const fail = new Set(options.fail ?? []);
  const boom = (what: string) => Promise.reject(new Error(`stub failure: ${what}`));
  const blocking = options.raisedBlocking ?? 0;
  const nonBlocking = options.raisedNonBlocking ?? 0;
  return {
    listSystemMessages: async () =>
      fail.has('messages')
        ? boom('messages')
        : Array.from({ length: options.unread ?? 0 }, (_, i) => ({
            id: `m${i}`, title: 't', body: 'b', kind: 'report',
            source: { kind: 'builder' }, created_at: 1, read_at: null,
            dismissed_at: null, dismissed_by: null,
          })),
    listRaisedItems: async () =>
      fail.has('raised')
        ? boom('raised')
        : {
            items: [], clusters: [],
            total: blocking + nonBlocking,
            total_open_blocking: blocking,
            total_open_non_blocking: nonBlocking,
          },
    listConversationSummaries: async () =>
      fail.has('conversations')
        ? boom('conversations')
        : (options.conversations ?? []).map((importedAt, i) => ({
            sessionId: `s${i}`, startedAt: null, endedAt: null, importedAt,
            summary: null, gitBranch: null, stats: null,
          })),
    listTasksWithOptions: async () =>
      fail.has('tasks')
        ? boom('tasks')
        : (options.liveTasks ?? []).map(([type, status], i) => ({
            id: `t${i}`, code: `t${i}`, goal: 'g', type, status, created_at: i,
          })),
  } as unknown as Storage;
}

/** A review port answering with `count` queued tasks. */
function stubActions(count: number): ReviewActions {
  return {
    listQueue: async () => Array.from({ length: count }, (_, i) => ({ id: `t${i}` })),
  } as unknown as ReviewActions;
}

async function counts(storage: Storage, actions?: ReviewActions, query = '') {
  const handler = createWebRequestHandler(storage, actions);
  const res = await handler(new Request(`http://lazy.localhost/api/nav-counts${query}`));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, number | null>;
}

describe('/api/nav-counts degraded cases', () => {
  // INVARIANT: one failing store read costs ONE badge, not the nav.
  // Promise.all here would reject the whole handler, the script would see a 500,
  // and Review/Inbox/Raised would all go dark because a conversation file is
  // unreadable. Do not "simplify" the allSettled back.
  test('a failing read blanks its own count and leaves the others', async () => {
    const body = await counts(
      stubStorage({ unread: 3, raisedBlocking: 2, raisedNonBlocking: 3, fail: ['conversations'] }),
      stubActions(2),
    );
    expect(body.conversations).toBeNull();
    expect(body.conversationsLatestAt).toBe(0);
    expect(body.unread).toBe(3);
    expect(body.raisedBlocking).toBe(2);
    expect(body.raisedNonBlocking).toBe(3);
    expect(body.review).toBe(2);
  });

  // INVARIANT: the raised badge reports the two halves SEPARATELY. Blocking
  // items refuse an accept and non-blocking ones never do, so one summed number
  // would hide the only half that is urgent behind a pile of orthogonal notes.
  test('blocking and non-blocking are counted apart, not summed', async () => {
    const body = await counts(stubStorage({ raisedBlocking: 1, raisedNonBlocking: 40 }));
    expect(body.raisedBlocking).toBe(1);
    expect(body.raisedNonBlocking).toBe(40);
  });

  // The pre-unification key stays for one release: a cached nav script or a
  // Teams client reading this endpoint still renders a number rather than a gap.
  test('the legacy followups key still answers, as the combined open total', async () => {
    const body = await counts(stubStorage({ raisedBlocking: 2, raisedNonBlocking: 3 }));
    expect(body.followups).toBe(5);
  });

  test('every read failing is empty badges, not a 500', async () => {
    const body = await counts(stubStorage({ fail: ['messages', 'raised', 'conversations', 'tasks'] }));
    expect(body).toEqual({
      unread: null, review: null, clusters: null, raisedBlocking: null, raisedNonBlocking: null,
      followups: null, conversations: null, conversationsLatestAt: 0,
    });
  });

  // INVARIANT: the Loops badge counts LOOP TASKS that are still live. Counting
  // every task type would make it a second Tasks badge; counting terminal clusters
  // would make a finished project read as permanently busy.
  test('the clusters badge counts live cluster tasks only', async () => {
    const body = await counts(stubStorage({
      liveTasks: [['cluster', 'working'], ['task', 'working'], ['cluster', 'blocked'], ['fix', 'backlog']],
    }));
    expect(body.clusters).toBe(2);
  });

  test('no loop tasks is 0, and a failed task read is null', async () => {
    expect((await counts(stubStorage({ liveTasks: [['task', 'working']] }))).clusters).toBe(0);
    expect((await counts(stubStorage({ fail: ['tasks'] }))).clusters).toBeNull();
  });

  // INVARIANT: null is not zero. With no action port the review routes answer
  // 503, so the count is unknown — reporting 0 would tell the human nothing is
  // waiting for review while the queue is full and merely unreachable.
  test('no review action port reports null, never 0', async () => {
    const body = await counts(stubStorage({ unread: 1 }));
    expect(body.review).toBeNull();
    expect(body.unread).toBe(1);
  });

  test('an empty review queue is 0, which is a different answer from null', async () => {
    const body = await counts(stubStorage(), stubActions(0));
    expect(body.review).toBe(0);
  });

  describe('the conversations mark', () => {
    const three = { conversations: [100, 200, 300] };

    test('counts what arrived after the mark', async () => {
      expect((await counts(stubStorage(three), undefined, '?conversationsSince=100')).conversations).toBe(2);
      expect((await counts(stubStorage(three), undefined, '?conversationsSince=300')).conversations).toBe(0);
    });

    test('reports the newest importedAt as the next mark', async () => {
      expect((await counts(stubStorage(three))).conversationsLatestAt).toBe(300);
    });

    // Over-count visibly rather than under-count silently: anything that is not
    // a positive finite number means "this browser has not looked".
    test.each([
      ['absent', ''],
      ['empty', '?conversationsSince='],
      ['not a number', '?conversationsSince=yesterday'],
      ['negative', '?conversationsSince=-5'],
      ['infinite', '?conversationsSince=1e999'],
    ])('an unusable mark (%s) counts everything', async (_label, query) => {
      expect((await counts(stubStorage(three), undefined, query)).conversations).toBe(3);
    });

    // INVARIANT: a mark ahead of everything the store holds cannot have come
    // from this server. Trusting it leaves the badge dark forever, and the only
    // thing that would repair the mark is a visit to the page the badge exists
    // to send you to — so the human would never be told to make it.
    test('a mark from the future is not a mark', async () => {
      const body = await counts(stubStorage(three), undefined, '?conversationsSince=99999999999999');
      expect(body.conversations).toBe(3);
      expect(body.conversationsLatestAt).toBe(300);
    });
  });

  test('only GET is answered', async () => {
    const handler = createWebRequestHandler(stubStorage());
    const res = await handler(new Request('http://lazy.localhost/api/nav-counts', { method: 'POST' }));
    expect(res.status).toBe(405);
  });
});
