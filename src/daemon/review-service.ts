/**
 * Review service — the daemon-side implementation of the web review loop.
 *
 * The web layer (src/server/) must not import src/daemon/ (the daemon already
 * imports the server, so the reverse edge would be a cycle). Instead the server
 * declares a narrow `ReviewActions` port and the daemon injects this
 * implementation at bind time. That also keeps the invariant that ALL mutations
 * go through the daemon: the web handler never touches git, locks, or storage
 * writes itself.
 *
 * Two reviewer intents, chosen per message (see ReviewCommentIntent):
 *   - 'ask'     dispatches a read-only ask turn as soon as the worktree is free;
 *   - 'comment' accumulates as pending delivery and is carried, batched with
 *               every other undelivered comment, into ONE unblock work turn.
 * A comment never becomes a turn on its own — that is the legacy `Comment`
 * behaviour this model exists to replace.
 *
 * The load-bearing rule here is CLAUDE.md's "never lose human feedback": a
 * review comment is persisted through Storage BEFORE any dispatch is attempted,
 * a failed ask downgrades to a visible error state rather than removing the
 * comment, and comments are marked delivered only once the unblock turn has
 * actually launched.
 */

import { getOrCreateStorage, handleDiff, RpcError } from './rpc-handlers';
import { launchAskTask, launchUnblockTask, acceptTask, approveTask, syncTask } from './task-lifecycle';
import { acceptRefusal } from './accept-refusal';
import { logger } from '../utils/logger';
import { saveRecoveryFileAsync, removeRecoveryFileAsync } from '../utils/recovery';
import type { FileViolation, ReviewComment, ReviewCommentSide, ReviewCommentIntent } from '../types';
import { latestViolationTurn } from '../utils/turns';
import { askUnavailableReason, isPendingDelivery, withdrawRefusalReason } from '../server/review-actions';
import type { ReviewActions, PostReviewCommentInput, ReviewQueueEntry } from '../server/review-actions';
import askPromptTemplate from '../prompts/review-comment-ask.md' with { type: 'text' };
import unblockPromptTemplate from '../prompts/review-comments-unblock.md' with { type: 'text' };

/**
 * Per-task serialization of everything that resumes the agent.
 *
 * `launchAskTask` takes the task's worktree lock and rejects with 409 if the
 * worktree is already busy, so two asks posted in quick succession would race.
 * The unblock work turn is queued on this SAME chain, which is what gives the
 * ordering the review model promises: asks posted before an unblock all run
 * (and answer) before the batched comment turn launches. The map entry is
 * dropped once the chain drains, so it cannot grow unbounded.
 */
const askChains = new Map<string, Promise<void>>();

/** Queue work behind this task's in-flight asks. Resolves when the work does. */
function enqueue<T>(taskId: string, work: () => Promise<T>): Promise<T> {
  const prev = askChains.get(taskId) ?? Promise.resolve();
  // Run regardless of how the previous link settled — one failed ask must not
  // strand every later ask or the unblock behind it.
  const result = prev.then(work, work);
  const next = result
    .then(
      () => undefined,
      (err) => {
        // Callers that await `result` handle their own errors; this arm only
        // keeps the chain itself from becoming an unhandled rejection.
        logger.debug(
          `Review chain link failed for task ${taskId.substring(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    )
    .finally(() => {
      if (askChains.get(taskId) === next) askChains.delete(taskId);
    });
  askChains.set(taskId, next);
  return result;
}

function buildAskPrompt(thread: ReviewComment[], latest: ReviewComment): string {
  const transcript = thread
    .map((c) => `**${c.role === 'agent' ? 'You' : 'Reviewer'}:** ${c.content}`)
    .join('\n\n');

  return askPromptTemplate
    .replace('{{file}}', latest.file)
    .replace('{{line}}', String(latest.line))
    .replace('{{side}}', latest.side === 'old' ? 'removed/original' : 'added/new')
    .replace('{{anchor}}', latest.anchor_snippet ? `The line reads:\n\n\`\`\`\n${latest.anchor_snippet}\n\`\`\`` : '')
    .replace('{{thread}}', transcript);
}

/**
 * True for a human comment that is waiting to ride the next unblock turn.
 *
 * Defined in the shared port (`src/server/review-actions.ts`) so the daemon and
 * the page cannot disagree about what is queued; re-exported here because this
 * is where the rule is used and where callers already look for it.
 */
export { isPendingDelivery };

/**
 * Render undelivered comments as one block for the unblock work turn. Each
 * comment carries its anchor so the agent can go straight to the line, plus any
 * ask conversation that already happened on that thread — the reviewer may well
 * be saying "do what we just agreed", and without the thread that reads as a
 * non-sequitur.
 */
export function buildUnblockPrompt(
  pending: ReviewComment[],
  all: ReviewComment[],
  message: string,
): string {
  const blocks = pending.map((c, i) => {
    const anchor = c.anchor_snippet ? `\n\n\`\`\`\n${c.anchor_snippet}\n\`\`\`` : '';
    // Everything on this thread that came before the comment — the reviewer's
    // earlier questions and the answers you gave.
    const priorThread = all.filter(
      (o) => o.thread_id === c.thread_id && o.id !== c.id && o.created_at <= c.created_at,
    );
    const context = priorThread.length
      ? `\n\nEarlier on this thread:\n${priorThread
          .map((o) => `> **${o.role === 'agent' ? 'You' : 'Reviewer'}:** ${o.content.replace(/\n/g, '\n> ')}`)
          .join('\n>\n')}`
      : '';
    const side = c.side === 'old' ? 'removed/original' : 'added/new';
    return `### ${i + 1}. \`${c.file}\` line ${c.line} (${side} side)${anchor}\n\n${c.content}${context}`;
  });

  return unblockPromptTemplate
    .replace('{{count}}', String(pending.length))
    .replace('{{comments}}', blocks.join('\n\n'))
    .replace('{{message}}', message);
}

export function createReviewActions(projectRoot: string): ReviewActions {
  return {
    async listQueue(): Promise<ReviewQueueEntry[]> {
      const storage = await getOrCreateStorage();
      const tasks = await storage.listTasksWithOptions({ blockedOnly: true });
      const entries: ReviewQueueEntry[] = [];
      for (const task of tasks) {
        const [comments, session] = await Promise.all([
          storage.getTaskReviewComments(task.id),
          storage.getSessionByTaskId(task.id),
        ]);
        const unanswered = comments.filter(
          (c) => c.role === 'human' && c.ask_state === 'pending',
        ).length;
        entries.push({
          id: task.id,
          code: task.code ?? null,
          goal: task.goal,
          status: task.status,
          type: task.type,
          updatedAt: task.completed_at ?? task.created_at,
          hasSession: !!session,
          commentCount: comments.length,
          pendingAsks: unanswered,
          pendingComments: comments.filter(isPendingDelivery).length,
        });
      }
      return entries;
    },

    async getDiff(taskId: string): Promise<string> {
      const result = (await handleDiff(projectRoot, { taskId, full: true })) as { output: string };
      return result.output ?? '';
    },

    async listComments(taskId: string): Promise<ReviewComment[]> {
      const storage = await getOrCreateStorage();
      return storage.getTaskReviewComments(taskId);
    },

    async postComment(taskId: string, input: PostReviewCommentInput): Promise<ReviewComment> {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      const task = resolved.task;
      const intent: ReviewCommentIntent = input.intent === 'comment' ? 'comment' : 'ask';

      // ---- SAVE FIRST ----------------------------------------------------
      // Everything below this write may fail (status gate, worktree lock,
      // runner availability, agent crash, 10-minute ask timeout). The comment
      // exists and is visible regardless. CLAUDE.md: never lose human feedback.
      const comment = await storage.createReviewComment(task.id, {
        threadId: input.threadId,
        file: input.file,
        line: input.line,
        side: input.side as ReviewCommentSide,
        role: 'human',
        content: input.content,
        actor: 'human',
        intent,
        ...(intent === 'ask'
          ? { askState: 'pending' as const }
          : { deliveryState: 'pending_delivery' as const }),
        anchorSnippet: input.anchorSnippet,
      });
      // --------------------------------------------------------------------

      // A 'comment' is a change request, not a question: it is NOT dispatched.
      // It waits here, durable and visible, until an unblock carries it (with
      // every other undelivered comment) into a single work turn. Note there is
      // no status gate — a reviewer may mark up the diff of a task that is busy
      // or not yet askable, and the notes keep until they can be delivered.
      if (intent === 'comment') return comment;

      const unavailable = askUnavailableReason(task.status);
      if (unavailable) {
        // Not askable right now (task is working, submitted, terminal…). The
        // comment stays; it is simply marked as undelivered with a reason the
        // reviewer can act on — and the page offers a one-click retry, so the
        // question never has to be typed twice.
        await storage.updateReviewComment(task.id, comment.id, {
          askState: 'failed',
          askError: unavailable,
        });
        return { ...comment, ask_state: 'failed' };
      }

      // The ask is synchronous with a 10-minute timeout inside the daemon, far
      // too long to hold an HTTP request open. Dispatch in the background; the
      // browser polls the threads endpoint for the reply. Errors are recorded
      // on the comment by dispatchAsk itself, hence the deliberate no-op catch.
      void enqueue(task.id, () => dispatchAsk(projectRoot, task.id, comment)).catch(() => {});

      return comment;
    },

    async retryAsk(taskId: string, commentId: string): Promise<ReviewComment> {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      const task = resolved.task;
      const all = await storage.getTaskReviewComments(task.id);
      const comment = all.find((c) => c.id === commentId);
      if (!comment) {
        throw new RpcError(404, `Review comment not found: ${commentId}`);
      }
      if (comment.role !== 'human' || comment.intent === 'comment') {
        throw new RpcError(400, 'Only a question you asked can be re-sent to the agent.');
      }
      // Already in flight — re-dispatching would take the worktree lock twice
      // and 409 the second attempt. Report the current state instead.
      if (comment.ask_state === 'pending') return comment;

      const unavailable = askUnavailableReason(task.status);
      if (unavailable) {
        // Still not askable. Re-record the (now current) reason so the reviewer
        // sees why this attempt failed too; the question itself is untouched.
        await storage.updateReviewComment(task.id, comment.id, {
          askState: 'failed',
          askError: unavailable,
        });
        return { ...comment, ask_state: 'failed', ask_error: unavailable };
      }

      // Back to pending BEFORE dispatch, so a reload during the ask shows
      // "waiting for the agent…" rather than the stale failure.
      const pending = await storage.updateReviewComment(task.id, comment.id, {
        askState: 'pending',
        askError: null,
      });
      // dispatchAsk never throws — it records askState:'failed' itself — but the
      // chain link can still reject if the queue is torn down, and an unhandled
      // rejection here would take the daemon down over a retry.
      void enqueue(task.id, () => dispatchAsk(projectRoot, task.id, comment)).catch(() => {});
      return pending;
    },

    async withdrawComment(taskId: string, commentId: string): Promise<ReviewComment> {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      const task = resolved.task;
      const all = await storage.getTaskReviewComments(task.id);
      // Scoped to THIS task's comments, so a well-formed id belonging to another
      // task is a 404 here rather than a cross-task write.
      const comment = all.find((c) => c.id === commentId);
      if (!comment) {
        throw new RpcError(404, `Review comment not found: ${commentId}`);
      }
      const refusal = withdrawRefusalReason(comment);
      if (refusal) {
        throw new RpcError(400, refusal);
      }
      // Retracted, not deleted: the record and its thread stay, and the
      // timestamp is what excludes it from the queue and from every future
      // unblock prompt. One-way — there is no un-withdraw.
      return storage.updateReviewComment(task.id, comment.id, { withdrawnAt: Date.now() });
    },

    async unblock(taskId: string, message: string) {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      const fullId = resolved.task.id;

      // Belt and braces: the reviewer's overall message is not a review comment,
      // so Storage has no copy of it until the agent turn is recorded. Write a
      // recovery file first so a failed launch cannot swallow it. (The batched
      // comments need no such backup — they are already durable.)
      const recoveryPath = await saveRecoveryFileAsync(projectRoot, message, 'web-unblock');

      // Queue behind any in-flight asks so the conversation the reviewer
      // started finishes before the work turn that acts on their comments.
      return enqueue(fullId, async () => {
        const all = await storage.getTaskReviewComments(fullId);
        const pending = all.filter(isPendingDelivery);
        const prompt = pending.length ? buildUnblockPrompt(pending, all, message) : message;

        let result;
        try {
          // launchUnblockTask recomputes every violation's status from this
          // list alone — anything absent is rejected and git-reverted. So it
          // must carry the reviewer's stored ✅ decisions, or unblocking would
          // throw away changes they had already approved.
          result = await launchUnblockTask(projectRoot, {
            taskId: fullId,
            message: prompt,
            actor: 'human',
            approvedFiles: await approvedViolationFiles(storage, fullId),
          });
        } catch (err) {
          // The turn never launched, so the comments stay pending_delivery and
          // will ride the next unblock. Nothing is marked delivered here.
          const detail = recoveryPath ? ` Your feedback was saved to ${recoveryPath}.` : '';
          throw new Error(`${err instanceof Error ? err.message : String(err)}${detail}`);
        }

        // Delivered — and only now, because the turn actually launched.
        for (const c of pending) {
          try {
            await storage.updateReviewComment(fullId, c.id, {
              deliveryState: 'delivered',
              deliveredTurn: result.turnNumber,
            });
          } catch (err) {
            // The agent has the comment; we only failed to record that. Log
            // loudly — the symptom would be a comment re-delivered next unblock.
            logger.error(
              `Delivered review comment ${c.id} but could not mark it delivered: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (recoveryPath) await removeRecoveryFileAsync(recoveryPath);
        return result;
      });
    },

    async accept(taskId: string, reason?: string, passphrase?: string) {
      // A supplied passphrase is verified FIRST, through the very same
      // approveTask the CLI's `lazy approve` calls — one verifier, one audit
      // comment, one one-shot approval that the merge below consumes. The
      // passphrase is not stored, not echoed back, and not logged: it exists
      // only as this argument.
      if (passphrase !== undefined) {
        try {
          await approveTask(projectRoot, { taskId, token: passphrase });
        } catch (err) {
          const status = err instanceof RpcError ? err.status : 500;
          // 400 (nothing entered) and 403 (wrong passphrase) are both the
          // reviewer's to retry, so they come back as the SAME refusal that
          // asked for the passphrase — the form is offered again rather than
          // dead-ending on a message.
          if (status === 400 || status === 403) {
            throw acceptRefusal(status, err instanceof Error ? err.message : String(err), {
              reason: 'approval-invalid',
              next: 'Enter the approval passphrase again — nothing you typed on this page is lost.',
              command: `lazy approve ${taskId}`,
              uiAction: 'passphrase',
            });
          }
          throw err;
        }
      }
      // No approvedFiles: a ✅ decision is already stored as `approved`, so the
      // preflight sees no `pending` violation to object to. A file still ⛔ is
      // still `pending`, and the preflight refuses — which is the intent.
      return acceptTask(projectRoot, { taskId, reason });
    },

    async sync(taskId: string) {
      return syncTask(projectRoot, { taskId });
    },

    async setViolationDecision(taskId: string, file: string, approved: boolean) {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      const session = await storage.getSessionByTaskId(resolved.task.id);
      if (!session) {
        throw new RpcError(409, `Task ${taskId} has no session, so it has no protected-file changes to decide on.`);
      }
      const turns = await storage.getSessionTurns(session.id);
      const turn = latestViolationTurn(turns);
      if (!turn?.violations?.length) {
        throw new RpcError(409, `Task ${taskId} has no protected-file violations to decide on.`);
      }
      if (!turn.violations.some((v) => v.file === file)) {
        throw new RpcError(404, `${file} is not a protected file this task violated.`);
      }
      const updated: FileViolation[] = turn.violations.map((v) =>
        v.file === file
          // Back to 'pending', never 'rejected' — see setViolationDecision on
          // the port for why writing 'rejected' here would let a later accept
          // merge the refused change.
          ? { ...v, status: approved ? ('approved' as const) : ('pending' as const) }
          : v,
      );
      await storage.updateTurnViolations(resolved.task.id, turn.id, updated);
      return updated;
    },
  };
}

/**
 * The files the reviewer has marked ✅ on this task's violation turn.
 *
 * Read fresh at unblock time rather than carried through the request, so the
 * decision that gets applied is the one currently on record.
 */
async function approvedViolationFiles(
  storage: Awaited<ReturnType<typeof getOrCreateStorage>>,
  taskId: string,
): Promise<string[]> {
  const session = await storage.getSessionByTaskId(taskId);
  if (!session) return [];
  const turns = await storage.getSessionTurns(session.id);
  const violations = latestViolationTurn(turns)?.violations ?? [];
  return violations.filter((v) => v.status === 'approved').map((v) => v.file);
}

/**
 * Run one ask turn for a review comment and persist the agent's reply into the
 * same thread. Never throws — a failure is recorded on the comment.
 */
async function dispatchAsk(
  projectRoot: string,
  taskId: string,
  comment: ReviewComment,
): Promise<void> {
  const storage = await getOrCreateStorage();
  try {
    const all = await storage.getTaskReviewComments(taskId);
    const thread = all.filter((c) => c.thread_id === comment.thread_id);
    const prompt = buildAskPrompt(thread, comment);

    const result = await launchAskTask(projectRoot, {
      taskId,
      message: prompt,
      actor: 'human',
    });

    // The agent's answer joins the thread at the same anchor, so a page reload
    // renders the full back-and-forth in place on the diff.
    await storage.createReviewComment(taskId, {
      threadId: comment.thread_id,
      file: comment.file,
      line: comment.line,
      side: comment.side,
      role: 'agent',
      content: result.answer,
      turnNumber: result.turnNumber,
      anchorSnippet: comment.anchor_snippet,
    });
    await storage.updateReviewComment(taskId, comment.id, {
      askState: 'answered',
      askError: null,
      turnNumber: result.turnNumber,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Review ask failed for task ${taskId.substring(0, 8)}: ${message}`);
    try {
      await storage.updateReviewComment(taskId, comment.id, {
        askState: 'failed',
        askError: message,
      });
    } catch (updateErr) {
      // The comment itself is already durable; we only failed to annotate it.
      // Log loudly rather than silently — the reviewer will see a stuck
      // "pending" state and this line explains why.
      logger.error(
        `Could not mark review comment ${comment.id} as failed: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
      );
    }
  }
}
