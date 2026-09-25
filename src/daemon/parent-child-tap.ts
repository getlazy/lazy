/**
 * Storage decorator that tells a parent task when a subtask is added or removed.
 *
 * WHY A DECORATOR AND NOT CALL-SITE NOTIFICATION — the same reasoning as
 * {@link ./event-tap}, which this sits next to. "A task gains or loses a
 * subtask" is written from a dozen places today: `lazy create --parent`,
 * `lazy_create`, the web New-task form, `lazy clone` / `lazy redo`,
 * raised-item promotion, `lazy link`, `lazy reparent`, `lazy edit --parent`,
 * `lazy_edit`, `lazy doctor --fix`, accept's and close's re-parenting of
 * orphaned children, the launch-time parent fallbacks, `lazy close`,
 * `lazy reject`, `lazy reopen`. Four storage methods carry all of them:
 *
 * - `createTask(goal, parentTaskId, …)`  → the parent gained a subtask
 * - `updateTaskTarget(taskId, target)`   → one parent lost it, another gained it
 * - `abandonTask` / `updateTaskStatus → 'abandoned'` → the parent lost it
 * - `reopenTask(taskId)`                 → the parent gained it BACK
 *
 * The signal is about the parent's LIVE child set, which is why reopen belongs
 * here and not in a follow-up: a child restored from terminal is that set
 * changing. Leaving it out did not just miss one notice — because the skip is
 * last-state-wins, the parent's newest note about that child stayed `removed`,
 * so a later close of the same child was silent too.
 *
 * The daemon holds the one and only writable Storage instance, and every other
 * process reaches it through RemoteStorage → `POST /rpc/storage` → this same
 * object. Wrapping it once covers every writer that exists, including the ones
 * written after this task — which is the point: a new create or reparent
 * surface cannot forget to notify.
 *
 * Accepted children are NOT reported here. Accept posts its own
 * `[Subtask accepted]` comment (see {@link ../task/notify-parent-accepted}) and
 * its path never reaches these hooks: the accepted task is already terminal
 * when its children are re-parented off it, so the removal side skips it.
 *
 * Notification never throws and never changes a write's result — the create /
 * reparent / close already landed, so a notify miss is queued on the child and
 * retried by the reconciler sweep.
 */

import type { Storage } from '../storage/interface';
import type { ActorInput, Task, TaskStatus, TaskTarget } from '../types';
import { isTerminalStatus } from '../types';
import {
  notifyParentOfAddedSubtask,
  notifyParentOfRemovedSubtask,
  notifyTargetChange,
} from '../task/notify-parent-children';
import { logger } from '../utils/logger';
import { shortId } from '../task/identity';

async function safeNotify(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    // The write already succeeded. Failing to describe it to the parent must
    // not fail the operation that caused it.
    logger.warn(
      `parent-child tap: ${what} notify failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

async function taskOrNull(target: Storage, taskId: string): Promise<Task | null> {
  try {
    return await target.getTask(taskId);
  } catch {
    // A pre-read failure costs us the old target (so the reparent goes
    // unannounced); the write itself is the caller's concern.
    return null;
  }
}

export function tapParentChildChanges(storage: Storage): Storage {
  const target = storage;

  const overrides: Record<string, (...args: any[]) => any> = {
    async createTask(...args: any[]) {
      const created: Task = await (target.createTask as any)(...args);
      await safeNotify(`added ${shortId(created.id)}`, () =>
        notifyParentOfAddedSubtask(target, created),
      );
      return created;
    },

    async updateTaskTarget(taskId: string, newTarget: TaskTarget) {
      const before = await taskOrNull(target, taskId);
      const result = await target.updateTaskTarget(taskId, newTarget);
      if (before) {
        await safeNotify(`retarget ${shortId(taskId)}`, () =>
          notifyTargetChange(target, taskId, before.target, newTarget),
        );
      }
      return result;
    },

    async abandonTask(taskId: string, reason: string, actor?: ActorInput) {
      const before = await taskOrNull(target, taskId);
      const result = await target.abandonTask(taskId, reason, actor);
      // Only a real transition into terminal is a removal: abandoning an
      // already-abandoned task must not re-announce it.
      if (before && before.status !== 'abandoned') {
        const after = (await taskOrNull(target, taskId)) ?? before;
        await safeNotify(`removed ${shortId(taskId)}`, () =>
          notifyParentOfRemovedSubtask(target, after, reason?.trim() || 'closed'),
        );
      }
      return result;
    },

    async updateTaskStatus(taskId: string, status: TaskStatus, actor?: ActorInput) {
      const before = status === 'abandoned' ? await taskOrNull(target, taskId) : null;
      const result = await target.updateTaskStatus(taskId, status, actor);
      if (before && before.status !== 'abandoned') {
        const after = (await taskOrNull(target, taskId)) ?? before;
        // `lazy reject` notifies with its own reason just before this flip, so
        // the last-state-wins skip keeps that wording; this is the backstop for
        // any other route into `abandoned`.
        await safeNotify(`removed ${shortId(taskId)}`, () =>
          notifyParentOfRemovedSubtask(target, after, after.close_reason?.trim() || 'abandoned'),
        );
      }
      return result;
    },

    async reopenTask(taskId: string, actor?: ActorInput) {
      const before = await taskOrNull(target, taskId);
      const result = await target.reopenTask(taskId, actor);
      // Only a real transition OUT of terminal is a re-add. A reopen of a task
      // that was already live is not a change to the parent's child set (the
      // state machine refuses the transition anyway), so it stays quiet.
      if (before && isTerminalStatus(before.status)) {
        const after = (await taskOrNull(target, taskId)) ?? before;
        await safeNotify(`re-added ${shortId(taskId)}`, () =>
          notifyParentOfAddedSubtask(target, after),
        );
      }
      return result;
    },
  };

  return new Proxy(target, {
    get(t, prop, _receiver) {
      const override = typeof prop === 'string' ? overrides[prop] : undefined;
      if (override) return override;
      const value = Reflect.get(t, prop, t);
      // Bind to the real target: called through the proxy, `this` would be the
      // proxy and any backend private-field access would throw.
      return typeof value === 'function' ? value.bind(t) : value;
    },
  }) as Storage;
}
