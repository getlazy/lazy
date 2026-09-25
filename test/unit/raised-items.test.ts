/**
 * Unit tests for raised-item resolution helpers (accept / unblock gate).
 *
 * INVARIANT: accept requires an all-or-nothing resolution set; unblock may
 * resolve a subset. `--yes` does NOT skip that gate. See
 * docs/design/structural-agent-questions.md.
 */

import { describe, test, expect } from 'bun:test';
import {
  openRaisedItems,
  allOpenRaisedItems,
  validateRaisedResolutions,
  buildPendingRaisedComment,
  raisedCommentIsPending,
  resolveOneRaisedItem,
  materializePendingRaisedComments,
} from '../../src/daemon/raised-items';
import { optionalRaisedResolutions } from '../../src/daemon/rpc-params';
import type { RaisedItem, Task } from '../../src/types';
import type { Storage } from '../../src/storage/interface';
import { AcceptRefusedError } from '../../src/daemon/accept-refusal';
import { RpcError } from '../../src/daemon/rpc-error';

function openItem(id: string, content: string, blocking = true): RaisedItem {
  return {
    id,
    task_id: 'task-1',
    content,
    created_at: Date.now(),
    status: 'open',
    blocking,
  };
}

describe('raised-items helpers', () => {
  test('openRaisedItems filters to status open only (legacy acknowledged is not open)', () => {
    const items: RaisedItem[] = [
      openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Q1'),
      {
        ...openItem('bbbbbbbb-2222-2222-2222-222222222222', 'Q2'),
        status: 'acknowledged',
        resolved_at: 1,
        resolved_by: 'human',
      },
      {
        ...openItem('cccccccc-3333-3333-3333-333333333333', 'Q3'),
        status: 'answered',
        resolved_at: 1,
        resolved_by: 'human',
      },
    ];
    expect(openRaisedItems(items).map(i => i.id.slice(0, 8))).toEqual(['aaaaaaaa']);
  });

  // INVARIANT: only BLOCKING items gate accept. A non-blocking raised item is
  // what used to be a follow-up — a passive note — and any number of them may
  // be open when a task is accepted. See docs/design/raised-items-unified.md.
  test('openRaisedItems excludes open non-blocking items', () => {
    const items: RaisedItem[] = [
      openItem('aaaaaaaa-1111-1111-1111-111111111111', 'scope question', true),
      openItem('bbbbbbbb-2222-2222-2222-222222222222', 'orthogonal idea', false),
    ];
    expect(openRaisedItems(items).map(i => i.id.slice(0, 8))).toEqual(['aaaaaaaa']);
  });

  test('allOpenRaisedItems includes both flags (review listing, resolvable set)', () => {
    const items: RaisedItem[] = [
      openItem('aaaaaaaa-1111-1111-1111-111111111111', 'scope question', true),
      openItem('bbbbbbbb-2222-2222-2222-222222222222', 'orthogonal idea', false),
    ];
    expect(allOpenRaisedItems(items).map(i => i.id.slice(0, 8))).toEqual([
      'aaaaaaaa',
      'bbbbbbbb',
    ]);
  });

  test('a task with only non-blocking items has nothing gating accept', () => {
    const items: RaisedItem[] = [
      openItem('bbbbbbbb-2222-2222-2222-222222222222', 'orthogonal idea', false),
      openItem('cccccccc-3333-3333-3333-333333333333', 'another FYI', false),
    ];
    expect(openRaisedItems(items)).toEqual([]);
  });

  test('raisedCommentIsPending is true only before delivery', () => {
    const pending: RaisedItem = {
      ...openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Q'),
      status: 'responded',
      pending_comment: 'hello',
    };
    expect(raisedCommentIsPending(pending)).toBe(true);
    expect(raisedCommentIsPending({ ...pending, comment_delivered_at: 1 })).toBe(false);
    expect(raisedCommentIsPending({
      ...openItem('bbbbbbbb-2222-2222-2222-222222222222', 'legacy'),
      status: 'acknowledged',
    })).toBe(false);
  });

  // INVARIANT: accept refuses when open items exist and no resolutions were provided.
  test('validateRaisedResolutions refuses when resolutions are undefined and items are open', () => {
    const open = [openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Ship feature X?')];
    try {
      validateRaisedResolutions(open, undefined, 'abc12345');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AcceptRefusedError);
      const refused = err as AcceptRefusedError;
      expect(refused.remedy.reason).toBe('open-raised-items');
      expect(refused.remedy.command).toContain('--respond-raised');
    }
  });

  // INVARIANT: resolution is all-or-nothing — naming a subset refuses.
  test('validateRaisedResolutions refuses a partial set', () => {
    const open = [
      openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Q1'),
      openItem('bbbbbbbb-2222-2222-2222-222222222222', 'Q2'),
    ];
    try {
      validateRaisedResolutions(
        open,
        [{ id: 'aaaaaaaa', action: 'respond', response: 'yes' }],
        'abc12345',
      );
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AcceptRefusedError);
      expect((err as AcceptRefusedError).remedy.reason).toBe('open-raised-items');
      expect((err as AcceptRefusedError).message).toContain('bbbbbbbb');
    }
  });

  test('validateRaisedResolutions accepts a complete respond / promote / dismiss set', () => {
    const open = [
      openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Q1'),
      openItem('bbbbbbbb-2222-2222-2222-222222222222', 'Q2'),
    ];
    const normalized = validateRaisedResolutions(
      open,
      [
        { id: 'aaaaaaaa', action: 'respond', response: 'use option 2' },
        { id: 'bbbbbbbb', action: 'promote_subtask' },
      ],
      'abc12345',
    );
    expect(normalized).toHaveLength(2);
    expect(normalized[0]!.action).toBe('respond');
    expect(normalized[0]!.response).toBe('use option 2');
    expect(normalized[0]!.pending_comment).toContain('Q1');
    expect(normalized[0]!.pending_comment).toContain('use option 2');
    expect(normalized[1]!.action).toBe('promote_subtask');
    expect(normalized[1]!.pending_comment).toContain('will be promoted to a subtask');
  });

  // INVARIANT: every verb applies to every item. Acknowledge and dismiss are the
  // same act — "I saw it and I will take no action on this" — differing only in
  // valence: dismiss is "I very likely won't do anything about this",
  // acknowledge is "maybe I'll do something about it later". Both close a
  // blocking item's accept gate; the record keeps which was used. `blocking`
  // decides whether accept REQUIRES a resolution, never which are legal.
  test('acknowledge resolves a blocking item; the legacy "answer" action is gone', () => {
    const open = [openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Q1')];
    const normalized = validateRaisedResolutions(
      open,
      [{ id: 'aaaaaaaa', action: 'acknowledge' }],
      'abc12345',
    );
    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.action).toBe('acknowledge');

    expect(() =>
      validateRaisedResolutions(open, [{ id: 'aaaaaaaa', action: 'answer', response: 'x' }], 'abc12345'),
    ).toThrow(/no longer valid/);
  });

  // INVARIANT: the RPC boundary decides whether a VERB EXISTS; whether a
  // PARTICULAR item takes it is decided one layer down, where the blocking flag
  // is known. The boundary kept its own hand-written verb list once and fell a
  // verb behind the domain, so `acknowledge` was unreachable through
  // raised_resolutions while `lazy raised acknowledge` worked. The two must
  // stay one vocabulary.
  test('acknowledge passes the RPC boundary and closes a blocking item', () => {
    const parsed = optionalRaisedResolutions({
      raisedResolutions: [{ id: 'aaaaaaaa', action: 'acknowledge' }],
    });
    expect(parsed).toEqual([{ id: 'aaaaaaaa', action: 'acknowledge' }]);

    const blocking = [openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Q1', true)];
    const normalized = validateRaisedResolutions(blocking, parsed, 'abc12345');
    expect(normalized.map(n => n.action)).toEqual(['acknowledge']);
  });

  // A reviewer resolving the gate may name an open NON-blocking item in the
  // same call — accept requires only the blocking ones, but it must not refuse
  // the extra id as unknown.
  test('accept resolves a non-blocking item named alongside the blocking set', () => {
    const gate = openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Ship A or B?', true);
    const note = openItem('bbbbbbbb-2222-2222-2222-222222222222', 'retry path swallows errors', false);

    const normalized = validateRaisedResolutions(
      [gate],
      [
        { id: 'aaaaaaaa', action: 'respond', response: 'ship A' },
        { id: 'bbbbbbbb', action: 'acknowledge' },
      ],
      'abc12345',
      [gate, note],
    );
    expect(normalized.map(n => [n.item.id.slice(0, 8), n.action])).toEqual([
      ['aaaaaaaa', 'respond'],
      ['bbbbbbbb', 'acknowledge'],
    ]);

    // Still all-or-nothing over the BLOCKING set: naming only the note refuses.
    expect(() =>
      validateRaisedResolutions([gate], [{ id: 'bbbbbbbb', action: 'acknowledge' }], 'abc12345', [gate, note]),
    ).toThrow(AcceptRefusedError);
  });

  test('respond and dismiss require a response; promote does not', () => {
    const open = [openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Q1')];
    expect(() =>
      validateRaisedResolutions(open, [{ id: 'aaaaaaaa', action: 'respond' }], 'abc12345'),
    ).toThrow(RpcError);
    expect(() =>
      validateRaisedResolutions(open, [{ id: 'aaaaaaaa', action: 'dismiss' }], 'abc12345'),
    ).toThrow(RpcError);
    expect(
      validateRaisedResolutions(open, [{ id: 'aaaaaaaa', action: 'promote_peer' }], 'abc12345'),
    ).toHaveLength(1);
  });

  test('no open items is a no-op (including stale resolutions after they were already stored)', () => {
    expect(validateRaisedResolutions([], undefined, 'abc12345')).toEqual([]);
    expect(validateRaisedResolutions([], [], 'abc12345')).toEqual([]);
    // Review-page Apply or a previous accept persist already closed the gate.
    // Re-passing the same flags must not refuse once nothing is open.
    expect(
      validateRaisedResolutions(
        [],
        [{ id: 'aaaaaaaa', action: 'respond', response: 'ok' }],
        'abc12345',
      ),
    ).toEqual([]);
  });

  test('buildPendingRaisedComment always quotes the item content', () => {
    const item = openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Ship option A?');
    const respond = buildPendingRaisedComment(item, 'respond', 'use A');
    expect(respond).toContain('> Ship option A?');
    expect(respond).toContain('use A');
    expect(buildPendingRaisedComment(item, 'dismiss', 'noise')).toContain('Dismissed: noise');
    expect(buildPendingRaisedComment(item, 'promote_subtask')).toContain('subtask');
    // INVARIANT: promote_subtask's comment is INFORMATIONAL, never an
    // instruction to the agent to create the subtask itself — on an accept
    // there is no next turn to carry such an instruction out, which is exactly
    // how the original comment-only design silently did nothing.
    expect(buildPendingRaisedComment(item, 'promote_subtask', undefined, { promotedTaskRef: 'sub-1 (cafebabe)' }))
      .toContain('sub-1 (cafebabe)');
    expect(buildPendingRaisedComment(item, 'promote_peer', undefined, { promotedTaskRef: 'peer-1 (deadbeef)' }))
      .toContain('peer-1 (deadbeef)');
    expect(buildPendingRaisedComment(item, 'acknowledge')).toContain('Acknowledged.');
  });

  test('resolveOneRaisedItem stores a pending comment and does not create a comment', async () => {
    const created: string[] = [];
    const stored: Array<{ action: string; pending_comment?: string | null }> = [];
    const item = openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Ship option A?');
    const storage = {
      getTaskRaisedItems: async () => [item],
      resolveRaisedItem: async (
        _taskId: string,
        _itemId: string,
        resolution: { action: string; pending_comment?: string | null },
      ) => {
        stored.push(resolution);
        return {
          ...item,
          status: 'responded',
          pending_comment: resolution.pending_comment,
        };
      },
      createComment: async (_taskId: string, body: string) => {
        created.push(body);
      },
    } as unknown as Storage;

    await resolveOneRaisedItem(storage, 'task-1', item.id, {
      action: 'respond',
      actor: 'human',
      response: 'use A',
    });

    expect(created).toEqual([]);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.action).toBe('respond');
    expect(stored[0]!.pending_comment).toContain('Ship option A?');
    expect(stored[0]!.pending_comment).toContain('use A');
  });

  test('resolveOneRaisedItem allows acknowledge on a non-blocking item', async () => {
    const item = openItem('bbbbbbbb-2222-2222-2222-222222222222', 'Extract retry helper', false);
    const stored: Array<{ action: string }> = [];
    const storage = {
      getTaskRaisedItems: async () => [item],
      resolveRaisedItem: async (_t: string, _i: string, resolution: { action: string }) => {
        stored.push(resolution);
        return { ...item, status: 'acknowledged' };
      },
      createComment: async () => {},
    } as unknown as Storage;

    await resolveOneRaisedItem(storage, 'task-1', item.id, {
      action: 'acknowledge',
      actor: 'human',
    });
    expect(stored[0]!.action).toBe('acknowledge');
  });

  // INVARIANT: `lazy raised acknowledge` works on a blocking item too —
  // acknowledge and dismiss are the same act with a different valence ("maybe
  // later" vs "will not act"), and either closes the accept gate.
  test('resolveOneRaisedItem allows acknowledge on a blocking item', async () => {
    const item = openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Ship option A?', true);
    const stored: Array<{ action: string }> = [];
    const storage = {
      getTaskRaisedItems: async () => [item],
      resolveRaisedItem: async (_t: string, _i: string, resolution: { action: string }) => {
        stored.push(resolution);
        return { ...item, status: 'acknowledged' };
      },
      createComment: async () => {},
    } as unknown as Storage;

    await resolveOneRaisedItem(storage, 'task-1', item.id, {
      action: 'acknowledge',
      actor: 'human',
    });
    expect(stored[0]!.action).toBe('acknowledge');
  });

  test('resolveOneRaisedItem refuses a comment that was already delivered', async () => {
    const item: RaisedItem = {
      ...openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Ship option A?'),
      status: 'responded',
      pending_comment: 'already sent',
      comment_delivered_at: 1,
    };
    const storage = {
      getTaskRaisedItems: async () => [item],
      resolveRaisedItem: async () => {
        throw new Error('should not re-resolve a delivered item');
      },
    } as unknown as Storage;

    await expect(
      resolveOneRaisedItem(storage, 'task-1', item.id, {
        action: 'respond',
        actor: 'human',
        response: 'changed my mind',
      }),
    ).rejects.toThrow(/already delivered/);
  });

  // INVARIANT: comments stay pending until unblock/accept materialize. Resolve
  // never writes a Comment; materialize is the only writer, and it is the
  // point of no undo.
  test('materializePendingRaisedComments writes the pending comment and stamps delivered', async () => {
    const item: RaisedItem = {
      ...openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Ship option A?'),
      status: 'responded',
      pending_comment: 'Regarding raised item aaaaaaaa:\n> Ship option A?\n\nuse A',
    };
    const comments: string[] = [];
    const delivered: Array<{ extras?: { pending_comment?: string | null } }> = [];
    const originating = {
      id: 'task-1',
      code: 'origin-task',
      goal: 'Do the thing',
      agent_id: 'claude-code',
      target: { kind: 'branch', branch: 'main' },
    } as unknown as Task;
    const storage = {
      getTask: async () => originating,
      listTasks: async () => [],
      getTaskRaisedItems: async () => [item],
      createComment: async (_taskId: string, body: string) => {
        comments.push(body);
      },
      markRaisedItemCommentDelivered: async (
        _taskId: string,
        _itemId: string,
        extras?: { pending_comment?: string | null },
      ) => {
        delivered.push({ extras });
        return { ...item, comment_delivered_at: Date.now() };
      },
      createTask: async () => {
        throw new Error('respond should not create a peer task');
      },
    } as unknown as Storage;

    const result = await materializePendingRaisedComments(storage, 'task-1', 'human');
    expect(result.comments).toBe(1);
    expect(result.peerTasks).toEqual([]);
    expect(comments).toEqual([item.pending_comment as string]);
    expect(delivered).toHaveLength(1);
  });

  test('materializePendingRaisedComments skips legacy acknowledge records with no pending comment', async () => {
    const item: RaisedItem = {
      ...openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Already decided'),
      status: 'acknowledged',
      resolved_at: 1,
      resolved_by: 'human',
    };
    const comments: string[] = [];
    const originating = {
      id: 'task-1',
      code: 'origin-task',
      goal: 'Do the thing',
      agent_id: 'claude-code',
      target: { kind: 'branch', branch: 'main' },
    } as unknown as Task;
    const storage = {
      getTask: async () => originating,
      listTasks: async () => [],
      getTaskRaisedItems: async () => [item],
      createComment: async (_taskId: string, body: string) => {
        comments.push(body);
      },
      markRaisedItemCommentDelivered: async () => item,
    } as unknown as Storage;

    const result = await materializePendingRaisedComments(storage, 'task-1', 'human');
    expect(result.comments).toBe(0);
    expect(comments).toEqual([]);
  });

  test('materializePendingRaisedComments creates a sibling peer task and quotes it in the comment', async () => {
    const item: RaisedItem = {
      ...openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Track this separately'),
      status: 'promoted_peer',
      pending_comment: 'placeholder — rebuilt at materialize',
    };
    const comments: string[] = [];
    let createdParent: string | undefined;
    const originating = {
      id: 'task-1',
      code: 'origin-task',
      goal: 'Do the thing',
      agent_id: 'claude-code',
      target: { kind: 'task', parentTaskId: 'parent-hub' },
    } as unknown as Task;
    const storage = {
      getTask: async () => originating,
      listTasks: async () => [],
      getTaskRaisedItems: async () => [item],
      createTask: async (
        goal: string,
        parentTaskId?: string,
      ) => {
        createdParent = parentTaskId;
        expect(goal).toContain('Track this separately');
        return {
          id: 'peer-task-id-0001',
          code: 'peer-task',
          goal,
          agent_id: 'claude-code',
        };
      },
      updateTaskPrompt: async () => originating,
      createComment: async (_taskId: string, body: string) => {
        comments.push(body);
      },
      markRaisedItemCommentDelivered: async (
        _taskId: string,
        _itemId: string,
        extras?: { promoted_task_id?: string | null },
      ) => {
        expect(extras?.promoted_task_id).toBe('peer-task-id-0001');
        return { ...item, promoted_task_id: extras?.promoted_task_id, comment_delivered_at: Date.now() };
      },
    } as unknown as Storage;

    const result = await materializePendingRaisedComments(storage, 'task-1', 'human');
    expect(result.comments).toBe(1);
    expect(result.peerTasks).toEqual(['peer-task-id-0001']);
    expect(createdParent).toBe('parent-hub');
    expect(comments[0]).toContain('peer-task');
    expect(comments[0]).toContain('Do not re-raise');
    expect(comments[0]).toContain('> Track this separately');
  });

  // INVARIANT: a promotion made at unblock/accept records the created task's CODE
  // on the raise, not only its id. Recording just the id left every task page's
  // promoted badge reading "→ task".
  test('materializePendingRaisedComments records the promoted task code', async () => {
    const item: RaisedItem = {
      ...openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Track this separately'),
      status: 'promoted_peer',
      pending_comment: 'placeholder',
    };
    let recorded: { promoted_task_id?: string | null; promoted_task_code?: string | null } | undefined;
    const originating = {
      id: 'task-1', code: 'origin-task', goal: 'Do the thing', agent_id: 'claude-code',
      target: { kind: 'task', parentTaskId: 'parent-hub' },
    } as unknown as Task;
    const storage = {
      getTask: async () => originating,
      listTasks: async () => [],
      getTaskRaisedItems: async () => [item],
      createTask: async (goal: string) => ({ id: 'peer-task-id-0001', code: 'peer-task', goal, agent_id: 'claude-code' }),
      updateTaskPrompt: async () => originating,
      createComment: async () => undefined,
      markRaisedItemCommentDelivered: async (_t: string, _i: string, extras?: typeof recorded) => {
        recorded = extras;
        return { ...item, ...extras };
      },
    } as unknown as Storage;

    await materializePendingRaisedComments(storage, 'task-1', 'human');
    expect(recorded?.promoted_task_id).toBe('peer-task-id-0001');
    expect(recorded?.promoted_task_code).toBe('peer-task');
  });

  // INVARIANT: promote_subtask is STRUCTURAL, exactly like promote_peer — the
  // resolver creates the child task itself. It was originally a comment ONLY
  // ("promote this into its own subtask and work it there"), which is a no-op
  // when the resolution is materialized by an accept: the comment lands on a
  // task that is completing, no turn ever runs, and the subtask never exists.
  // Peer and subtask now differ only in the parent pointer.
  test('materializePendingRaisedComments creates a CHILD task for promote_subtask, inheriting agent/model/effort', async () => {
    const item: RaisedItem = {
      ...openItem('aaaaaaaa-1111-1111-1111-111111111111', 'Handle the empty-input case'),
      status: 'promoted_subtask',
      pending_comment: 'placeholder — rebuilt at materialize',
    };
    const comments: string[] = [];
    let createdParent: string | undefined;
    let createdAgent: string | undefined;
    let createdModel: string | undefined;
    let createdPrompt: string | undefined;
    const metadataWrites: Array<{ key: string; value: unknown }> = [];
    const originating = {
      id: 'task-1',
      code: 'origin-task',
      goal: 'Do the thing',
      agent_id: 'cursor',
      model: 'claude-opus-5',
      metadata: { effort: 'xhigh' },
      target: { kind: 'task', parentTaskId: 'parent-hub' },
    } as unknown as Task;
    const storage = {
      getTask: async () => originating,
      listTasks: async () => [],
      getTaskRaisedItems: async () => [item],
      createTask: async (
        goal: string,
        parentTaskId?: string,
        _sha?: string,
        _code?: string,
        _type?: string,
        agentId?: string,
      ) => {
        createdParent = parentTaskId;
        createdAgent = agentId;
        return { id: 'sub-task-id-0001', code: 'sub-task', goal, agent_id: agentId };
      },
      updateTaskPrompt: async (_id: string, content: string) => {
        createdPrompt = content;
        return originating;
      },
      updateTaskModel: async (_id: string, model: string) => {
        createdModel = model;
      },
      updateTaskMetadata: async (_id: string, key: string, value: unknown) => {
        metadataWrites.push({ key, value });
      },
      createComment: async (_taskId: string, body: string) => {
        comments.push(body);
      },
      markRaisedItemCommentDelivered: async (
        _taskId: string,
        _itemId: string,
        extras?: { promoted_task_id?: string | null },
      ) => ({ ...item, promoted_task_id: extras?.promoted_task_id, comment_delivered_at: Date.now() }),
    } as unknown as Storage;

    const result = await materializePendingRaisedComments(storage, 'task-1', 'human');

    expect(result.subtasks).toEqual(['sub-task-id-0001']);
    expect(result.peerTasks).toEqual([]);
    // The one difference from promote_peer: parent is the ORIGINATING task,
    // not its parent.
    expect(createdParent).toBe('task-1');
    expect(createdAgent).toBe('cursor');
    expect(createdModel).toBe('claude-opus-5');
    expect(metadataWrites).toEqual([{ key: 'effort', value: 'xhigh' }]);
    expect(createdPrompt).toContain('Handle the empty-input case');
    expect(createdPrompt).toContain('as a subtask of task origin-task');
    // Informational comment naming the created task — not an instruction.
    expect(comments[0]).toContain('sub-task');
    expect(comments[0]).toContain('Do not re-raise');
    expect(comments[0]).not.toContain('Promote this into its own subtask');
  });
});
