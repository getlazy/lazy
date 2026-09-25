/**
 * Storage event tap — turns storage writes into daemon feed events.
 *
 * WHY A DECORATOR AND NOT CALL-SITE EMISSION: sixty-odd call sites across the
 * daemon, the RPC handlers and the reconciler write task status, turns,
 * comments and sessions. Sprinkling `publishDaemonEvent` across them would
 * guarantee that some path — usually the interesting one, like a reconciler
 * timeout transition — silently emits nothing, and a feed that is quietly
 * incomplete is worse than no feed: the subscriber's cache goes stale and
 * nothing says so.
 *
 * The daemon holds the one and only writable Storage instance in the system.
 * Every other process (CLI, MCP, supervisor) reaches it through RemoteStorage →
 * `POST /rpc/storage` → this same object. So wrapping it once, where it is
 * created, covers every writer that exists, including the ones written after
 * this task.
 *
 * The wrapper is a Proxy rather than a subclass because the concrete backend is
 * chosen at runtime (FileStorage) and callers reach past the
 * Storage interface for `.lock` and `.close`. Non-wrapped properties are
 * forwarded untouched, and methods are bound to the target so backend private
 * fields keep working.
 *
 * Emission never throws and never changes a write's result: a broken feed must
 * not be able to break the store.
 */

import type { Storage } from '../storage/interface';
import type { Actor, ActorInput, SessionOutcome, TaskStatus } from '../types';
import type { CreateTurnOptions } from '../storage/interface';
import { publishDaemonEvent } from './event-feed';
import { logger } from '../utils/logger';

function safeEmit(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    // The write already succeeded. A failure to describe it is a feed bug, not
    // a storage bug — log and move on rather than failing the caller.
    logger.debug(`event tap: emit failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Report the resulting status of a task-status write, emitting only when it
 * actually changed. Several storage methods short-circuit when the status is
 * already what was asked for, and a feed that reports non-transitions trains
 * its subscriber to ignore it.
 */
async function emitStatusChange(
  target: Storage,
  taskId: string,
  before: TaskStatus | null,
  actor?: ActorInput,
): Promise<void> {
  const after = (await target.getTask(taskId))?.status ?? null;
  if (after === null || after === before) return;
  publishDaemonEvent('task.status_changed', {
    taskId,
    data: {
      status: after,
      ...(before ? { from: before } : {}),
      ...(actor ? { actor } : {}),
    },
  });
}

async function statusBefore(target: Storage, taskId: string): Promise<TaskStatus | null> {
  try {
    return (await target.getTask(taskId))?.status ?? null;
  } catch {
    // A pre-read failure only costs us the `from` field; the write itself is
    // the caller's concern and must proceed either way.
    return null;
  }
}

export function tapStorageEvents(storage: Storage): Storage {
  const target = storage;

  const overrides: Record<string, (...args: any[]) => any> = {
    async updateTaskStatus(taskId: string, status: TaskStatus, actor?: ActorInput) {
      const before = await statusBefore(target, taskId);
      const result = await target.updateTaskStatus(taskId, status, actor);
      await emitStatusChange(target, taskId, before, actor).catch((err) =>
        logger.debug(`event tap: status emit failed: ${err instanceof Error ? err.message : err}`),
      );
      return result;
    },

    async abandonTask(taskId: string, reason: string, actor?: ActorInput) {
      const before = await statusBefore(target, taskId);
      const result = await target.abandonTask(taskId, reason, actor);
      await emitStatusChange(target, taskId, before, actor).catch((err) =>
        logger.debug(`event tap: status emit failed: ${err instanceof Error ? err.message : err}`),
      );
      return result;
    },

    async reopenTask(taskId: string, actor?: ActorInput) {
      const before = await statusBefore(target, taskId);
      const result = await target.reopenTask(taskId, actor);
      await emitStatusChange(target, taskId, before, actor).catch((err) =>
        logger.debug(`event tap: status emit failed: ${err instanceof Error ? err.message : err}`),
      );
      return result;
    },

    async createTurn(options: CreateTurnOptions) {
      const turn = await target.createTurn(options);
      // A Turn carries only its session id; the subscriber indexes by task, so
      // resolve it here rather than making every client do the extra read.
      const session = await target.getSession(turn.session_id).catch(() => null);
      safeEmit(() => {
        publishDaemonEvent('turn.added', {
          taskId: session?.task_id,
          data: {
            turnId: turn.id,
            sessionId: turn.session_id,
            sequence: turn.sequence,
            role: turn.role,
            ...(options.actor ? { actor: options.actor } : {}),
          },
        });
      });
      return turn;
    },

    // Forwards EVERY argument: a fixed parameter list here once silently dropped
    // createComment's `options` (forge identity), for every daemon-side import.
    async createComment(...args: Parameters<Storage['createComment']>) {
      const [taskId] = args;
      const comment = await target.createComment(...args);
      safeEmit(() => {
        // Deliberately not the content: the feed is an invalidation hint, and
        // comment bodies can be large. The subscriber reads it back.
        publishDaemonEvent('comment.added', {
          taskId,
          data: {
            commentId: comment.id,
            ...(comment.actor ? { actor: comment.actor } : {}),
            ...(comment.source ? { source: comment.source } : {}),
          },
        });
      });
      return comment;
    },

    async updateComment(...args: Parameters<Storage['updateComment']>) {
      const [taskId] = args;
      const comment = await target.updateComment(...args);
      safeEmit(() => {
        publishDaemonEvent('comment.updated', { taskId, data: { commentId: comment.id } });
      });
      return comment;
    },

    async createTaskArtifact(taskId: string, input: any, actor?: Actor) {
      const artifact = await target.createTaskArtifact(taskId, input, actor);
      safeEmit(() => {
        // Metadata only — the same rule as comments, and it matters more here:
        // artifact content is up to a megabyte and can be binary.
        publishDaemonEvent('artifact.added', {
          taskId,
          data: {
            artifactId: artifact.id,
            name: artifact.name,
            size: artifact.size,
            origin: artifact.origin,
            mimeType: artifact.mime_type,
            createdBy: artifact.created_by,
          },
        });
      });
      return artifact;
    },

    async deleteTaskArtifact(taskId: string, name: string) {
      const removed = await target.deleteTaskArtifact(taskId, name);
      if (removed) {
        safeEmit(() => {
          publishDaemonEvent('artifact.removed', { taskId, data: { name } });
        });
      }
      return removed;
    },

    async createSession(
      taskId: string,
      agentId: string,
      gitBranch: string,
      gitStartSha: string,
      claudeSessionId?: string,
    ) {
      const session = await target.createSession(taskId, agentId, gitBranch, gitStartSha, claudeSessionId);
      safeEmit(() => {
        publishDaemonEvent('session.started', {
          taskId,
          data: { sessionId: session.id, agentId, gitBranch },
        });
      });
      return session;
    },

    async endSession(sessionId: string, outcome: SessionOutcome) {
      const session = await target.getSession(sessionId).catch(() => null);
      const result = await target.endSession(sessionId, outcome);
      safeEmit(() => {
        publishDaemonEvent('session.ended', {
          taskId: session?.task_id,
          data: { sessionId, outcome },
        });
      });
      return result;
    },

    async resetSession(sessionId: string) {
      const result = await target.resetSession(sessionId);
      const session = await target.getSession(sessionId).catch(() => null);
      safeEmit(() => {
        // A reset un-ends a session: for a subscriber tracking "is this task's
        // session live", that is a start. `resumed` distinguishes it from a
        // genuinely new session.
        publishDaemonEvent('session.started', {
          taskId: session?.task_id,
          data: { sessionId, resumed: true },
        });
      });
      return result;
    },

    async updateSessionContainerName(
      sessionId: string,
      containerName: string | null,
      containerAgentId?: string | null,
    ) {
      const result = await target.updateSessionContainerName(sessionId, containerName, containerAgentId);
      const session = await target.getSession(sessionId).catch(() => null);
      safeEmit(() => {
        // The container behind a task changed, so its published ports may have
        // too. The event carries no port list on purpose — ports are a live
        // runtime read (`docker port`), never persisted, so the subscriber asks
        // the daemon for them rather than trusting a snapshot in a hint.
        publishDaemonEvent('ports.changed', {
          taskId: session?.task_id,
          data: { sessionId, containerName },
        });
      });
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
