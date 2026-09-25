/**
 * Daemon-side implementation of {@link ReviewSessionActions}.
 *
 * Serializes headless builder turns per task (same idea as askChains in
 * review-service.ts). Human compose-box text is durable BEFORE launch; launch
 * failure marks delivery failed and never drops content.
 */

import { getOrCreateStorage, RpcError } from './rpc-handlers';
import { logger } from '../utils/logger';
import { saveRecoveryFileAsync, removeRecoveryFileAsync } from '../utils/recovery';
import { withActorPerson } from '../actor-ref';
import { getActor } from '../constants';
import type { ActorInput, ReviewSession, Task } from '../types';
import {
  reviewSessionEntryBlockedReason,
  type ReviewSessionActions,
} from '../server/review-session-actions';
import {
  assembleReviewSessionFirstMessage,
  assertReviewSessionActorCredential,
  launchReviewSessionBuilderTurn,
  type ReviewSessionTurnLauncher,
} from './review-session-builder-turn';
import { TurnCredentialUnavailableError } from './turn-credentials';
import { assertBesideLaunchAllowed } from './usage-pause';
import { loadConfig } from '../config/loader';
import { displayId } from '../task/identity';

/**
 * [usage_pause]: a review conversation's builder turn spends the builder
 * role's credential, and a person is waiting on it — so a paused credential
 * REFUSES it, before the message is saved or a session row created, exactly
 * like the credential check beside it. Judged as the human the turn launches
 * as, so their one-shot override can let it through.
 */
async function assertReviewSessionUsageClear(
  projectRoot: string,
  task: Task,
  actor: ActorInput,
): Promise<void> {
  await assertBesideLaunchAllowed(projectRoot, {
    config: await loadConfig(projectRoot),
    actor: withActorPerson('human', actor),
    what: `the review conversation turn on ${displayId(task)}`,
  });
}

/** Per-task serialization of review-session builder turns. */
const sessionTurnChains = new Map<string, Promise<void>>();

function enqueueSessionTurn<T>(taskId: string, work: () => Promise<T>): Promise<T> {
  const prev = sessionTurnChains.get(taskId) ?? Promise.resolve();
  const result = prev.then(work, work);
  const next = result
    .then(
      () => undefined,
      (err) => {
        logger.debug(
          `Review-session chain link failed for task ${taskId.substring(0, 8)}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      },
    )
    .finally(() => {
      if (sessionTurnChains.get(taskId) === next) sessionTurnChains.delete(taskId);
    });
  sessionTurnChains.set(taskId, next);
  return result;
}

export interface ReviewSessionActionsDeps {
  launchTurn?: ReviewSessionTurnLauncher;
  assembleFirstMessage?: (projectRoot: string, taskId: string) => Promise<string>;
}

export function createReviewSessionActions(
  projectRoot: string,
  deps: ReviewSessionActionsDeps = {},
): ReviewSessionActions {
  const launchTurn = deps.launchTurn ?? launchReviewSessionBuilderTurn;
  const assembleFirstMessage = deps.assembleFirstMessage ?? assembleReviewSessionFirstMessage;

  return {
    async get(taskId: string): Promise<ReviewSession | null> {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      return storage.getReviewSessionByTaskId(resolved.task.id);
    },

    async start(taskId: string, opts?: { actor?: ActorInput }): Promise<ReviewSession> {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      const task = resolved.task;
      const actor = opts?.actor ?? getActor();

      const blocked = reviewSessionEntryBlockedReason(task.status);
      if (blocked) {
        throw new RpcError(409, blocked);
      }

      let session = await storage.getReviewSessionByTaskId(task.id);

      // Idle existing session: return without re-injecting preamble or launching.
      if (session) {
        return session;
      }

      // Brand-new path: refuse before creating a session row — otherwise a failed
      // credential check would leave an empty idle session that blocks preamble forever.
      await assertReviewSessionActorCredential(projectRoot, actor);
      await assertReviewSessionUsageClear(projectRoot, task, actor);

      session = await storage.createReviewSession(task.id);

      const preambleText = await assembleFirstMessage(projectRoot, task.id);
      const humanMessage = await storage.appendReviewSessionMessage(session.id, {
        role: 'human',
        content: preambleText,
        delivery: 'pending',
      });

      const recoveryPath = await saveRecoveryFileAsync(projectRoot, preambleText, 'web-review-session');

      void enqueueSessionTurn(task.id, () =>
        dispatchReviewSessionTurn({
          projectRoot,
          taskId: task.id,
          sessionId: session!.id,
          messageId: humanMessage.id,
          prompt: preambleText,
          resumeSessionId: null,
          actor,
          recoveryPath,
          launchTurn,
        }),
      ).catch(() => {});

      const reloaded = await storage.getReviewSessionByTaskId(task.id);
      return reloaded ?? session;
    },

    async send(taskId: string, message: string, opts?: { actor?: ActorInput }): Promise<void> {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      const task = resolved.task;
      const actor = opts?.actor ?? getActor();
      const trimmed = message.trim();
      if (!trimmed) {
        throw new RpcError(400, 'Message cannot be empty.');
      }

      let session = await storage.getReviewSessionByTaskId(task.id);
      if (!session) {
        throw new RpcError(409, 'No review session for this task — call start first.');
      }

      await assertReviewSessionActorCredential(projectRoot, actor);
      await assertReviewSessionUsageClear(projectRoot, task, actor);

      // ---- SAVE FIRST ----------------------------------------------------
      const humanMessage = await storage.appendReviewSessionMessage(session.id, {
        role: 'human',
        content: trimmed,
        delivery: 'pending',
      });
      // --------------------------------------------------------------------

      const recoveryPath = await saveRecoveryFileAsync(projectRoot, trimmed, 'web-review-session');

      // turn_in_flight: queue behind the in-flight turn; do not start a second launch now.
      void enqueueSessionTurn(task.id, () =>
        dispatchReviewSessionTurn({
          projectRoot,
          taskId: task.id,
          sessionId: session!.id,
          messageId: humanMessage.id,
          prompt: trimmed,
          resumeSessionId: session!.resume_session_id,
          actor,
          recoveryPath,
          launchTurn,
        }),
      ).catch(() => {});
    },

    async getTranscript(taskId: string) {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      const session = await storage.getReviewSessionByTaskId(resolved.task.id);
      if (!session) return [];
      // Poll reads use task-scoped storage only — never scan by session id, which
      // could match a staging tmp dir mid-atomicWriteTask (see file-storage).
      return [...(session.messages ?? [])].sort((a, b) => a.created_at - b.created_at);
    },
  };
}

interface DispatchReviewSessionTurnInput {
  projectRoot: string;
  taskId: string;
  sessionId: string;
  messageId: string;
  prompt: string;
  resumeSessionId: string | null;
  actor: ActorInput;
  recoveryPath: string | null;
  launchTurn: ReviewSessionTurnLauncher;
}

/**
 * Launch one headless builder turn for a durable human message. Never throws to
 * the caller — failures are recorded on the message and session returns idle.
 */
async function dispatchReviewSessionTurn(input: DispatchReviewSessionTurnInput): Promise<void> {
  const storage = await getOrCreateStorage();
  const {
    projectRoot, taskId, sessionId, messageId, prompt, resumeSessionId,
    actor, recoveryPath, launchTurn,
  } = input;

  await storage.updateReviewSession(sessionId, { status: 'turn_in_flight' });

  try {
    const result = await launchTurn({
      projectRoot,
      taskId,
      reviewSessionId: sessionId,
      prompt,
      resumeSessionId,
      actor: withActorPerson('human', actor),
    });

    await storage.appendReviewSessionMessage(sessionId, {
      role: 'assistant',
      content: result.answer,
      delivery: 'launched',
    });

    await storage.updateReviewSessionMessage(sessionId, messageId, { delivery: 'launched' });

    if (result.sessionId) {
      await storage.updateReviewSession(sessionId, {
        resumeSessionId: result.sessionId,
        status: 'idle',
      });
    } else {
      await storage.updateReviewSession(sessionId, { status: 'idle' });
    }

    if (recoveryPath) await removeRecoveryFileAsync(recoveryPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Review-session turn failed for task ${taskId.substring(0, 8)}: ${message}`);

    try {
      await storage.updateReviewSessionMessage(sessionId, messageId, { delivery: 'failed' });
      await storage.updateReviewSession(sessionId, { status: 'idle' });
    } catch (updateErr) {
      logger.error(
        `Could not mark review-session message ${messageId} failed: ` +
        `${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
      );
    }

    if (err instanceof TurnCredentialUnavailableError) {
      // Surface credential refusals on the message — same UX pattern as review asks.
      try {
        const session = await storage.getReviewSessionByTaskId(taskId);
        if (session) {
          const messages = await storage.listReviewSessionMessages(session.id);
          const failed = messages.find(m => m.id === messageId);
          if (failed) {
            // Content is immutable; delivery=failed is the visible signal. Log the reason.
            logger.warn(`Review-session credential refusal: ${message}`);
          }
        }
      } catch {
        // Best effort narration only.
      }
    }

    if (recoveryPath) {
      logger.warn(`Review-session compose text preserved at ${recoveryPath}`);
    }
  }
}
