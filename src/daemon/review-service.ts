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

import { getOrCreateStorage, handleDiff, handleFileLines, RpcError } from './rpc-handlers';
import { launchAskTaskAwaited, launchUnblockTask, acceptTask, syncTask } from './task-lifecycle';
import type { ProgressEmitter } from './progress';
import { logger } from '../utils/logger';
import { saveRecoveryFileAsync, removeRecoveryFileAsync } from '../utils/recovery';
import type { ActorInput, FileViolation, ReviewComment, ReviewCommentSide, ReviewCommentIntent, RaisedItemResolution, RaisedItemResolveAction, ReviewDraftState, ReviewDraftPatch } from '../types';
import { isBlockedStatus } from '../types';
import { descendantCounts } from '../task-target';
import { emptyReviewDraft } from '../review-draft';
import { resolveOneRaisedItem } from './raised-items';
import { latestViolationTurn } from '../utils/turns';
import { resolveOutstandingViolations } from '../protection/outstanding-resolver';
import { mergedViolationRecords } from '../protection/outstanding';
import { askUnavailableReason, isPendingDelivery, withdrawRefusalReason } from '../server/review-actions';
import { buildAskContext } from '../task/ask-context';
import type { ReviewActions, PostReviewCommentInput, PromoteDiscussionResult, ReviewQueueEntry, FileLinesQuery, FileLinesResult } from '../server/review-actions';
import { createPromotedTask } from '../raised/promote-task';
import { buildDiscussionTaskPrompt, defaultDiscussionGoal, discussionPromoteSeed, type DiscussionPromoteSeed } from '../review/promote-discussion';
import { validateCode } from '../task/identity';
import askPromptTemplate from '../prompts/review-comment-ask.md' with { type: 'text' };
import taskAskPromptTemplate from '../prompts/review-task-ask.md' with { type: 'text' };
import proseAskPromptTemplate from '../prompts/review-prose-ask.md' with { type: 'text' };
import { isTaskLevelReviewAnchor } from '../review/task-level-anchor';
import { isProseReviewAnchor, proseAnchorAgentWhere } from '../review/prose-anchor';
import { quotedProse, buildUnblockPrompt } from '../review/unblock-prompt';

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

/**

/**
 * Who decided, when the caller did not say.
 *
 * The review surface is a person either way; what a caller can add is WHICH
 * person, which only a per-user token knows. The daemon's own dashboard has no
 * user identity at all, so it passes nothing and the record reads exactly as it
 * did before per-user attribution existed.
 */
const HUMAN_DECIDER: ActorInput = 'human';

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

export function buildAskPrompt(thread: ReviewComment[], latest: ReviewComment): string {
  const transcript = thread
    .map((c) => `**${c.role === 'agent' ? 'You' : 'Reviewer'}:** ${c.content}`)
    .join('\n\n');

  if (isTaskLevelReviewAnchor(latest.file, latest.line)) {
    return taskAskPromptTemplate.replace('{{thread}}', transcript);
  }

  // A prose anchor points at the agent's own words, not at code: the agent
  // gets the quote and where it came from — never the pseudo-file or the
  // content-hash line, which would read as a fake file/line.
  if (isProseReviewAnchor(latest.file)) {
    // A reply may not re-carry the snippet; the thread's first message has it.
    const snippet = latest.anchor_snippet ?? thread.find((c) => c.anchor_snippet)?.anchor_snippet;
    return proseAskPromptTemplate
      .replace('{{where}}', proseAnchorAgentWhere(latest.file))
      .replace('{{quote}}', quotedProse(snippet))
      .replace('{{thread}}', transcript);
  }

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
 * Re-exported from src/review/unblock-prompt.ts, where the batching block
 * moved so that `launchUnblockTask` (which the review service imports) can
 * build it too — CLI, MCP and web unblocks all carry queued comments through
 * literally the same code.
 */
export { buildUnblockPrompt };

export function createReviewActions(projectRoot: string): ReviewActions {
  return {
    async listQueue(): Promise<ReviewQueueEntry[]> {
      const storage = await getOrCreateStorage();
      // The FULL task set, then filter in memory: a queue entry's subtask count
      // covers descendants of EVERY status (a release hub's children are mostly
      // complete), and descent walks parent links, so counting from the blocked
      // subset would truncate every subtree to nothing.
      //
      // On FileStorage this is free — listTasksWithOptions reads and sweeps
      // every task before applying any filter, so `{}` does the same work
      // `{ blockedOnly: true }` would. On RemoteStorage the filter is evaluated
      // on the far side, so the unfiltered call genuinely moves every task over
      // the wire. That is the price of a real descendant count; if it ever
      // shows up, the fix is a storage-level count, not a smaller walk here.
      const allTasks = await storage.listTasksWithOptions({});
      const descendants = descendantCounts(allTasks);
      const tasks = allTasks.filter((task) => isBlockedStatus(task.status));
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
          lastActiveAt: session?.last_interaction_at ?? null,
          descendantCount: descendants.get(task.id) ?? 0,
        });
      }
      return entries;
    },

    async getDiff(taskId: string, opts?: { region?: string }): Promise<string> {
      // includeComments: false — the review page PARSES this as a unified
      // diff, and the synthetic `diff --lazy a/comments b/comments` section is
      // not a git patch. The page renders comments as threads anyway; sending
      // them as diff text once produced a phantom "comments" file.
      const result = (await handleDiff(projectRoot, {
        taskId, full: true, includeComments: false, region: opts?.region,
      })) as { output: string };
      return result.output ?? '';
    },

    async listRegions(taskId: string) {
      // A read that cannot be answered must not take the Changes tab with
      // it: the diff above is the thing the reviewer came for, and regions
      // are a navigation aid on top of it.
      //
      // §6.3: this reads the task's PRESENTED regions — the walkthrough a
      // human-facing park declared. A HUB with no walkthrough falls through to
      // its children, derived from the carve; a leaf with none gets the empty
      // cover whose note says so, which is the different and honest answer.
      try {
        const { loadPresentedRegions } = await import('./regions-presentation');
        const { regionSummary } = await import('../regions');
        const storage = await getOrCreateStorage();
        const { cover, hashes } = await loadPresentedRegions(storage, projectRoot, taskId, {
          // Navigation on top of the diff: a hub's first carve must not hold
          // the Changes tab, and a stale map scopes exactly as correctly.
          lenientHubCarve: true,
        });
        return {
          regions: cover.regions.map((r) =>
            // Staleness is answered by the region's OWN content hash, not the
            // head: a sign-off survives a commit that touched another region.
            regionSummary(r, { headSha: hashes.get(r.id) ?? cover.head_sha })),
          notes: cover.notes,
        };
      } catch (err) {
        logger.debug(
          `regions unavailable for ${taskId}: ${err instanceof Error ? err.message : err}`,
        );
        return { regions: [], notes: [] };
      }
    },

    async lineAttribution(taskId: string, paths: readonly string[]) {
      // Same posture as listRegions: the gutter is a reading aid on top of the
      // diff, so a cover that cannot be read costs the annotation and never
      // the Changes tab.
      try {
        const { fileLineAttribution } = await import('./regions-service');
        const storage = await getOrCreateStorage();
        return await fileLineAttribution(storage, projectRoot, taskId, paths);
      } catch (err) {
        logger.debug(
          `line attribution unavailable for ${taskId}: ${err instanceof Error ? err.message : err}`,
        );
        return new Map();
      }
    },

    async getFileLines(taskId: string, input: FileLinesQuery): Promise<FileLinesResult> {
      return (await handleFileLines(projectRoot, {
        taskId,
        path: input.path,
        side: input.side,
        start: input.start,
        end: input.end,
      })) as FileLinesResult;
    },

    async listComments(taskId: string): Promise<ReviewComment[]> {
      const storage = await getOrCreateStorage();
      return storage.getTaskReviewComments(taskId);
    },

    async postComment(
      taskId: string,
      input: PostReviewCommentInput,
      options?: { waitForAsk?: boolean; onProgress?: ProgressEmitter },
    ): Promise<ReviewComment> {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      const task = resolved.task;
      const intent: ReviewCommentIntent = input.intent === 'comment' ? 'comment' : 'ask';

      // A comment normally anchors to something the agent can go and look at:
      // a diff line, or a prose anchor on one of the agent's own report,
      // follow-up or raised lines. The (task) sentinel anchors none of those —
      // it is the conversation about the work as a whole — so a comment may use
      // it ONLY as a reply on an existing task-level thread: after reading the
      // agent's answer, "alright, do that" is a plain comment that rides the
      // next unblock, and making the reviewer hunt for a code line to hang it on
      // is the bug this exception exists to fix. A FRESH task-level comment is
      // refused, because that is exactly what the Unblock tab's message box
      // already is. Guard here so both the RPC adapter and the web route share
      // the same protection.
      if (intent === 'comment' && isTaskLevelReviewAnchor(input.file, input.line)) {
        const replyingTo = input.threadId
          ? (await storage.getTaskReviewComments(task.id)).filter(
              (c) => c.thread_id === input.threadId,
            )
          : [];
        const onTaskLevelThread =
          replyingTo.length > 0 &&
          replyingTo.every((c) => isTaskLevelReviewAnchor(c.file, c.line));
        if (!onTaskLevelThread) {
          throw new RpcError(
            400,
            "Comments must anchor to a diff line, to a line of the agent's own report, follow-up or raised item, or reply on an existing task-level conversation. For a general note to the agent, write it in the Unblock message; to start a task-level question, use the Ask tab or POST /review/:id/ask.",
          );
        }
      }

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

      const unavailable = askUnavailableReason(await buildAskContext(storage, task, { projectRoot }));
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
      //
      // The action dialog waits: it needs the same phase events `lazy ask`
      // prints, and it stays open until the ask settles (close on success,
      // stay on failure). Line-anchored asks keep the fire-and-forget path.
      const dispatched = enqueue(task.id, () =>
        dispatchAsk(projectRoot, task.id, comment, options?.onProgress),
      );
      if (options?.waitForAsk) {
        await dispatched;
        const latest = (await storage.getTaskReviewComments(task.id)).find((c) => c.id === comment.id);
        return latest ?? comment;
      }
      void dispatched.catch(() => {});

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

      const unavailable = askUnavailableReason(await buildAskContext(storage, task, { projectRoot }));
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

    async unblock(
      taskId: string,
      message: string,
      raisedResolutions?: RaisedItemResolution[],
      onProgress?: ProgressEmitter,
      options?: { keepFeedbackDraft?: boolean },
    ) {
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
        let result;
        try {
          // launchUnblockTask batches every pending_delivery review comment
          // into the turn prompt and marks them delivered once the turn has
          // launched — the same code the CLI and MCP unblocks run, so the web
          // path cannot drift from them.
          //
          // No protected-file decision travels with an unblock any more
          // (move-file-approval-to-accept): a pending violation stays pending,
          // the file keeps the agent's content, and the ✅/⛔ the reviewer sets
          // on this page is read at ACCEPT.
          result = await launchUnblockTask(projectRoot, {
            taskId: fullId,
            message,
            actor: 'human',
            // The dashboard's signed-in person: may use the one-shot usage-pause override.
            usagePauseOverrideEligible: true,
            // The reviewer pressed Unblock on their own review: it carries
            // their queued comments, so it files their asks too.
            filesReview: true,
            // Optional partial raise resolutions from the review page — never
            // inferred from the feedback textarea.
            ...(raisedResolutions && raisedResolutions.length > 0
              ? { raisedResolutions }
              : {}),
            ...(options?.keepFeedbackDraft ? { keepFeedbackDraft: true } : {}),
            onProgress,
          });
        } catch (err) {
          // The turn never launched, so the comments stay pending_delivery and
          // will ride the next unblock. Nothing is marked delivered.
          const detail = recoveryPath ? ` Your feedback was saved to ${recoveryPath}.` : '';
          throw new Error(`${err instanceof Error ? err.message : String(err)}${detail}`);
        }

        if (recoveryPath) await removeRecoveryFileAsync(recoveryPath);
        return result;
      });
    },

    async accept(
      taskId: string,
      reason?: string,
      passphrase?: string,
      raisedResolutions?: RaisedItemResolution[],
      onProgress?: ProgressEmitter,
      approvedFiles?: string[],
      options?: { allowQueuedComments?: boolean },
    ) {
      // A supplied passphrase rides INTO the accept as its inline token — the
      // same argument `lazy accept` fills from its TTY prompt, verified by the
      // one edge gate inside the merge it authorizes. It is not stored, not
      // echoed back, and not logged: it exists only as this argument. A wrong
      // one comes back as the same `uiAction: 'passphrase'` refusal that asked
      // for it, so the form is offered again rather than dead-ending.
      //
      // approvedFiles is the same list the first submit carried. A ✅ on the
      // page is already stored as `approved`, so omitting the list still
      // works — but the passphrase retry must submit exactly what the first
      // accept submitted, or a conflict task's approved file can vanish.
      return acceptTask(projectRoot, {
        taskId,
        reason,
        token: passphrase,
        actor: 'human',
        ...(raisedResolutions && raisedResolutions.length > 0
          ? { raisedResolutions }
          : {}),
        ...(approvedFiles && approvedFiles.length > 0
          ? { approvedFiles }
          : {}),
        ...(options?.allowQueuedComments ? { allowQueuedComments: true } : {}),
        onProgress,
      });
    },

    async sync(taskId: string, onProgress?: ProgressEmitter) {
      return syncTask(projectRoot, { taskId, onProgress, liftPin: true });
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
      // WHAT IS DECIDABLE IS THE WHOLE-BRANCH SET, not one turn's record
      // (move-file-approval-to-accept). A conflict task runs many turns now, so
      // a file violated on an earlier turn can be outstanding — and listed on
      // the page, and refused at accept — while the newest violation turn has
      // no record of it at all. Gating this write on that turn made the ✅ the
      // page offers 404, leaving the reviewer no way to clear a file accept
      // would keep refusing.
      const state = await resolveOutstandingViolations(projectRoot, resolved.task, session, turns, storage);
      const decidable = new Set([...state.outstanding.map((v) => v.file), ...state.approved]);
      if (decidable.size === 0) {
        throw new RpcError(409, `Task ${taskId} has no protected-file violations to decide on.`);
      }
      if (!decidable.has(file)) {
        throw new RpcError(404, `${file} is not a protected file this task violated.`);
      }
      // Written as the complete ledger onto ONE turn: the merged record set, so
      // the decision survives however many turns run after it.
      const ledgerTurn = latestViolationTurn(turns) ?? [...turns].reverse().find((t) => t.role === 'agent');
      if (!ledgerTurn) {
        throw new RpcError(409, `Task ${taskId} has no agent turn to record the decision on.`);
      }
      const merged = mergedViolationRecords(turns, state.detected, approved ? [file] : []);
      const updated: FileViolation[] = merged.map((v) =>
        v.file === file
          // Back to 'pending', never 'rejected' — see setViolationDecision on
          // the port for why writing 'rejected' here would let a later accept
          // merge the refused change.
          ? { ...v, status: approved ? ('approved' as const) : ('pending' as const) }
          : v,
      );
      await storage.updateTurnViolations(resolved.task.id, ledgerTurn.id, updated);
      return updated;
    },

    async resolveRaisedItem(
      taskId: string,
      itemId: string,
      resolution: { action: RaisedItemResolveAction; response?: string | null },
      actor?: ActorInput,
    ) {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      return resolveOneRaisedItem(storage, resolved.task.id, itemId, {
        action: resolution.action,
        actor: actor ?? HUMAN_DECIDER,
        response: resolution.response ?? null,
      });
    },

    async unresolveRaisedItem(taskId: string, itemId: string, actor?: ActorInput) {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      return storage.unresolveRaisedItem(resolved.task.id, itemId, actor ?? HUMAN_DECIDER);
    },

    async setRaisedItemBlocking(taskId: string, itemId: string, blocking: boolean, actor?: ActorInput) {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      return storage.setRaisedItemBlocking(resolved.task.id, itemId, blocking, actor ?? HUMAN_DECIDER);
    },

    async promoteRaisedItem(
      taskId: string,
      itemId: string,
      options: { goal?: string; code?: string; relation?: 'peer' | 'subtask'; actor?: ActorInput },
    ) {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      const code = options.code?.trim() || undefined;
      if (code) {
        const codeError = validateCode(code);
        if (codeError) {
          throw new RpcError(400, `Invalid code '${code}': ${codeError}`);
        }
      }
      return storage.promoteRaisedItem(resolved.task.id, itemId, {
        goal: options.goal?.trim() || undefined,
        code,
        relation: options.relation ?? 'peer',
        actor: options.actor ?? HUMAN_DECIDER,
      });
    },

    async promoteDiscussion(
      taskId: string,
      threadId: string,
      options: { goal?: string; prompt?: string; code?: string; relation?: 'peer' | 'subtask' },
    ): Promise<PromoteDiscussionResult> {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      const task = resolved.task;

      const all = await storage.getTaskReviewComments(task.id);
      const messages = all.filter(c => c.thread_id === threadId);
      if (messages.length === 0) {
        throw new RpcError(404, `No discussion found on task ${taskId} with thread id ${threadId}`);
      }
      // The root comment carries the thread's promotion link — it is the one
      // message guaranteed to exist for the life of the thread.
      const root = messages.find(c => c.id === threadId) ?? messages[0];
      if (root.promoted_task_id) {
        throw new RpcError(
          409,
          `This discussion was already promoted to task ` +
          `${root.promoted_task_code ?? root.promoted_task_id.slice(0, 8)}.`,
        );
      }

      const code = options.code?.trim() || undefined;
      if (code) {
        const codeError = validateCode(code);
        if (codeError) {
          throw new RpcError(400, `Invalid code '${code}': ${codeError}`);
        }
      }

      const goal = options.goal?.trim() || defaultDiscussionGoal(messages, task);
      const prompt = options.prompt?.trim() || buildDiscussionTaskPrompt(messages, task);

      // Shared seeding path — the same one raised-item promotion uses. Creates
      // a BACKLOG task and nothing else: no start, no turn, no status change on
      // the task the discussion happened on.
      const created = await createPromotedTask(storage, {
        originatingTask: task,
        relation: options.relation ?? 'subtask',
        goal,
        prompt,
        code,
        actor: 'human',
      });

      const rootComment = await storage.updateReviewComment(task.id, root.id, {
        promotedTaskId: created.id,
        ...(created.code ? { promotedTaskCode: created.code } : {}),
      });

      return { task: created, rootComment };
    },

    async promoteConversation(
      sessionId: string,
      options: { from?: number; to?: number; goal?: string; prompt?: string; code?: string; parent?: string },
    ) {
      const storage = await getOrCreateStorage();
      const code = options.code?.trim() || undefined;
      if (code) {
        const codeError = validateCode(code);
        if (codeError) {
          throw new RpcError(400, `Invalid code '${code}': ${codeError}`);
        }
      }
      // Everything else — resolving the session id, validating the range,
      // refusing an exact re-promote, seeding the task — is Storage's, the
      // same as raised-item promotion. This layer only turns the human's
      // typed code into a 400 before any of it runs.
      return storage.promoteConversation(sessionId, {
        ...(options.from != null ? { from: options.from } : {}),
        ...(options.to != null ? { to: options.to } : {}),
        ...(options.goal?.trim() ? { goal: options.goal.trim() } : {}),
        ...(options.prompt?.trim() ? { prompt: options.prompt.trim() } : {}),
        ...(code ? { code } : {}),
        ...(options.parent?.trim() ? { parent: options.parent.trim() } : {}),
        actor: 'human',
      });
    },

    async getDraft(taskId: string, reviewer: string): Promise<ReviewDraftState> {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      // An empty draft rather than null: "nobody has typed anything yet" is a
      // first visit, not an error, and every surface renders the same shape.
      return (
        (await storage.getReviewDraft(resolved.task.id, reviewer)) ??
        emptyReviewDraft(resolved.task.id, reviewer)
      );
    },

    async saveDraft(
      taskId: string,
      reviewer: string,
      patch: ReviewDraftPatch,
    ): Promise<ReviewDraftState> {
      const storage = await getOrCreateStorage();
      const resolved = await storage.resolveTask(taskId);
      if (!resolved.task) {
        throw new RpcError(404, `Task not found: ${taskId}`);
      }
      return storage.saveReviewDraft(resolved.task.id, reviewer, patch);
    },
  };
}

/**
 * Run one ask turn for a review comment and persist the agent's reply into the
 * same thread. Never throws — a failure is recorded on the comment.
 */
async function dispatchAsk(
  projectRoot: string,
  taskId: string,
  comment: ReviewComment,
  onProgress?: ProgressEmitter,
): Promise<void> {
  const storage = await getOrCreateStorage();
  try {
    const all = await storage.getTaskReviewComments(taskId);
    const thread = all.filter((c) => c.thread_id === comment.thread_id);
    const prompt = buildAskPrompt(thread, comment);

    const result = await launchAskTaskAwaited(projectRoot, {
      taskId,
      message: prompt,
      actor: 'human',
      // The dashboard's signed-in person: may use the one-shot usage-pause override.
      usagePauseOverrideEligible: true,
      onProgress,
    });

    // The agent's answer joins the thread at the same anchor, so a page reload
    // renders the full back-and-forth in place on the diff.
    //
    // Provenance is written INTO the stored message, not just rendered beside
    // it: a reply read off the task's stored record must not read as the live
    // agent looking at a live worktree — including to whoever reads the thread
    // (or a promoted task seeded from it) months later.
    // Plain prose, deliberately — no markdown emphasis. A thread message is not
    // guaranteed to be rendered as markdown on every surface, and a provenance
    // line that shows up as literal `_underscores_` reads worse than the
    // sentence it is trying to soften.
    const content = result.provenance
      ? `${result.provenance}\n\n${result.answer}`
      : result.answer;
    await storage.createReviewComment(taskId, {
      threadId: comment.thread_id,
      file: comment.file,
      line: comment.line,
      side: comment.side,
      role: 'agent',
      content,
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
    throw err;
  }
}

/**
 * The "Promote to a task" answer for every task-level discussion, keyed by
 * thread id: the seeded goal/code/prompt, or the task it was already promoted
 * to. A thread with nothing to promote yet (no answer) is absent. Sent as the
 * ANSWER so a remote client (Lazy Teams) never re-derives the seed rule.
 */
export async function discussionPromotions(
  taskId: string,
  comments: ReviewComment[],
): Promise<Record<string, DiscussionPromoteSeed>> {
  const promotions: Record<string, DiscussionPromoteSeed> = {};
  const taskLevel = comments.filter((c) => isTaskLevelReviewAnchor(c.file, c.line));
  if (taskLevel.length === 0) return promotions;
  const task = (await (await getOrCreateStorage()).resolveTask(taskId)).task;
  if (!task) return promotions;
  const byThread = new Map<string, ReviewComment[]>();
  for (const c of taskLevel) {
    const list = byThread.get(c.thread_id) ?? [];
    list.push(c);
    byThread.set(c.thread_id, list);
  }
  for (const [threadId, messages] of byThread) {
    const seed = discussionPromoteSeed(task, threadId, messages);
    if (seed) promotions[threadId] = seed;
  }
  return promotions;
}
