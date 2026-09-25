/**
 * The port through which the web layer performs mutations.
 *
 * INVARIANT: all mutations go through the daemon. The web handler runs
 * in-process with the daemon and calls these methods, which are implemented in
 * src/daemon/review-service.ts — it never touches git, locks, or Storage writes
 * directly. This file lives in src/server/ (not src/daemon/) because
 * src/daemon/server.ts already imports src/server; the reverse import would be
 * a module cycle.
 *
 * When no implementation is injected (a Storage-only web handler, as in unit
 * tests), the mutating routes answer 503 rather than half-working.
 */

import type { ActorInput, FileViolation, ReviewComment, ReviewCommentIntent, RaisedItem, RaisedItemResolution, RaisedItemResolveAction, PromoteRaisedItemResult, ReviewDraftState, ReviewDraftPatch, Task, TaskStatus, TaskType } from '../types';
import type { ProgressEmitter } from '../daemon/progress';
import type { FileLineAttribution, RegionSummary } from '../regions';

/**
 * Statuses in which the agent's LIVE session can be resumed for a read-only ask.
 *
 * A live ask resumes the agent where it is paused, so it is only safe while the
 * task is paused: `working` may be mid-turn, and a terminal task has no agent
 * left to resume. It is NOT the set of tasks that can be asked a question — see
 * {@link resolveAskAvailability}, which routes everything else to the stored
 * record instead of refusing.
 */
export const LIVE_ASK_STATUSES: ReadonlySet<string> = new Set(['blocked', 'conflict']);

/** How an ask will be answered. */
export type AskRoute =
  /** Resume the agent's live session in its worktree. */
  | 'live'
  /** Read the task's stored record (turns, raised items, commits, diff). */
  | 'record';

/**
 * What a surface knows about a task when deciding how an ask would be answered.
 *
 * `worktreeExists` is the one field a browser cannot cheaply establish, so the
 * web surfaces pass `true`. That is deliberate and harmless: getting it wrong
 * can only change which ROUTE the page predicts, never whether the question is
 * answerable — the daemon, which checks for real, would route a worktree-less
 * task to the record and still answer.
 */
export interface AskContext {
  status: string;
  /** A session row exists and has not ended. */
  liveSession: boolean;
  /** That session carries an agent session id to resume. */
  resumableAgentSession: boolean;
  /** The task's worktree still exists on disk. */
  worktreeExists: boolean;
  /** The task has something stored to answer FROM — at least one turn. */
  hasRecord: boolean;
}

export interface AskAvailability {
  /** How the question will be answered; null when it cannot be answered at all. */
  route: AskRoute | null;
  /** Why no answer is possible, in the reviewer's words; null when one is. */
  unavailable: string | null;
  /**
   * Where the answer comes from, when that is not the live agent. Shown to the
   * reviewer and stored alongside the answer — an answer derived from the
   * record must never read as the live agent looking at a live worktree.
   */
  provenance: string | null;
}

/**
 * Why the agent's live session cannot be resumed for this task, or null when it
 * can. Phrased to slot into a sentence: "…because <reason>".
 */
function liveAskBlockedBecause(ctx: AskContext): string | null {
  if (!LIVE_ASK_STATUSES.has(ctx.status)) {
    return `the task is ${ctx.status}, so no agent is paused at a prompt`;
  }
  if (!ctx.liveSession) return "the task's agent session has ended";
  if (!ctx.resumableAgentSession) return 'the task has no agent session to resume';
  if (!ctx.worktreeExists) return "the task's worktree has been removed";
  return null;
}

/**
 * How a question about this task will be answered — and, if it cannot be, why.
 *
 * ONE rule, in the shared port, because both sides need it and neither may
 * import the other: the daemon routes dispatch on it, and the web page tells the
 * reviewer what will happen *before* they type. Two copies of this would drift
 * into a UI that promises what the daemon then refuses — which is precisely the
 * bug this function replaced. The old rule was a bare status set, so a finished
 * task was told "re-send it once the task is blocked", advice it can never
 * satisfy. A task that ran can always be asked; only a task that never ran has
 * nothing to answer from.
 */
export function resolveAskAvailability(ctx: AskContext): AskAvailability {
  const blocked = liveAskBlockedBecause(ctx);
  if (!blocked) return { route: 'live', unavailable: null, provenance: null };

  if (!ctx.hasRecord) {
    return {
      route: null,
      unavailable:
        `Task is ${ctx.status} and has nothing recorded yet — no turns, so there is nothing to answer from. ` +
        `Your question is saved; start the task (lazy start) and ask again — there is no session and no turn to read.`,
      provenance: null,
    };
  }

  return {
    route: 'record',
    unavailable: null,
    provenance:
      // One plain line (engineer, 2026-09-23): where the answer comes from and
      // why, without the inventory of what the record holds.
      `Answered from the task's stored record, not the original agent — ${blocked}.`,
  };
}

/**
 * Why an ask cannot be dispatched at all, or null when it can.
 *
 * The wording is shown to the reviewer verbatim (the ask box and the failed
 * comment's own state line) and stored as `ask_error`, so it must name the
 * current status and say plainly that the words are kept.
 */
export function askUnavailableReason(ctx: AskContext): string | null {
  return resolveAskAvailability(ctx).unavailable;
}

/**
 * Why an Unblock would be refused right now, or null when it would be taken.
 *
 * Offered beside Ask and Add comment in every review text box, so the page
 * can DISABLE the button with this sentence as its hover rather than let the
 * reviewer press it into a refusal. PRESENTATION, NOT A GATE: launchUnblockTask
 * stays the enforcer, and the web route saves the words as a queued comment
 * before it asks for the turn, so a refusal that slips past this never costs
 * the reviewer their text.
 */
export function unblockUnavailableReason(status: string): string | null {
  if (status === 'working' || status === 'pairing') {
    return `Task is ${status} — wait for it to finish before unblocking.`;
  }
  if (status === 'complete' || status === 'abandoned') {
    return `Task is ${status} — there is no agent to resume.`;
  }
  if (status === 'backlog') {
    return 'Task has not started yet — start it instead of unblocking.';
  }
  return null;
}

/**
 * Why this task cannot be accepted given the reviewer's recorded decisions, or
 * null when it can.
 *
 * PRESENTATION, NOT A GATE. acceptTaskPreflight remains the only enforcer, and
 * its own message stays as it is because it is right for the CLI ("use
 * --approve-file"). That advice is useless in a browser, so the web layer
 * renders the same rule in its own terms before relaying a 409 the reviewer
 * cannot act on. If the two ever disagree the daemon wins — it is the one that
 * refuses the merge.
 */
export function acceptBlockedByViolations(violations: readonly FileViolation[]): string | null {
  const rejected = violations.filter((v) => v.status !== 'approved').map((v) => v.file);
  if (rejected.length === 0) return null;
  return (
    `Task cannot be accepted with outstanding violations of protected files: ${rejected.join(', ')}. ` +
    `Mark every one ✅ to accept, or unblock with feedback asking the agent to revert them — ` +
    `unblocking changes nothing about these files by itself.`
  );
}

/**
 * INVARIANT (approval-happens-at-accept — move-file-approval-to-accept): there
 * is deliberately no unblock-time protected-file machinery here. Unblock never
 * reverts a file, so the page asks nothing before resuming the agent; the ✅/⛔
 * controls write a stored decision that {@link acceptBlockedByViolations} and
 * the daemon's accept preflight read at MERGE time. The Keep/Revert radios that
 * used to gate this POST are gone with the revert they drove.
 */

/** Has the reviewer retracted this message? */
export function isWithdrawn(c: ReviewComment): boolean {
  return c.withdrawn_at != null;
}

/**
 * A change request that is durable, not withdrawn, and still waiting to ride
 * the next unblock work turn.
 *
 * Lives in the shared port because both sides need exactly this predicate and
 * neither may import the other: the daemon decides what an unblock carries and
 * what the queue counts, and the page renders the reviewer's queued list from
 * it. Two copies drifted apart is precisely how a withdrawn comment would show
 * up in one place and not the other.
 */
export function isPendingDelivery(c: ReviewComment): boolean {
  return (
    c.role === 'human' &&
    c.intent === 'comment' &&
    c.delivery_state === 'pending_delivery' &&
    !isWithdrawn(c)
  );
}

/**
 * A reviewer's own question — the messages "Asks" is about.
 *
 * Messages written before intents existed carry none, and those were asks;
 * `intent === undefined` is read as 'ask' here exactly as `ReviewComment`
 * documents.
 */
export function isHumanAsk(c: ReviewComment): boolean {
  return c.role === 'human' && (c.intent ?? 'ask') === 'ask';
}

/**
 * Has this review ever had a comment queued / an ask sent at all?
 *
 * The sticky bar hides a counter that has never counted anything (see
 * `statusBarHtml`), and the poll that rewrites the bar has to apply the same
 * rule — so the rule is these two predicates, not an inline `.some()` at each
 * of the two call sites.
 */
export function hasAnyQueuedComment(comments: ReviewComment[]): boolean {
  return comments.some((c) => c.role === 'human' && c.intent === 'comment');
}

export function hasAnyAsk(comments: ReviewComment[]): boolean {
  return comments.some(isHumanAsk);
}

/**
 * An ask the agent has NOT consumed: still in flight, or it never reached the
 * agent at all.
 *
 * Filing must never move one of these out of sight. A failed ask still carries
 * the reviewer's words and the Re-send button that is the only way to deliver
 * them, and a pending one has an answer still coming.
 */
export function askAwaitsAgent(c: ReviewComment): boolean {
  if (!isHumanAsk(c) || isWithdrawn(c)) return false;
  return c.ask_state === 'pending' || c.ask_state === 'failed';
}

/**
 * Has this ask been carried out of the reviewer's in-progress review by the
 * unblock or accept that filed it?
 *
 * ONE definition, three surfaces (the daemon that files, the Current review
 * page that stops listing it, and any test that asserts either), for the same
 * reason `isPendingDelivery` is here: two copies is exactly how a message shows
 * as filed on one surface and still-open on another.
 */
export function isFiledAsk(c: ReviewComment): boolean {
  return isHumanAsk(c) && c.filed_at != null && !askAwaitsAgent(c);
}

/**
 * Is this thread part of the review the human is writing NOW?
 *
 * THE RULE, in one sentence: a thread is current while it still holds
 * something the agent has not taken — an undelivered comment, or a question
 * that has not been filed. Nothing else is current.
 *
 * The two halves, and why each is the reviewer's open business:
 *
 * - An UNDELIVERED comment. Reply on a task-level thread offers both intents,
 *   so "alright, do that" is a queued comment on a thread whose questions are
 *   long answered. Filing it would bury words the agent has not read.
 * - An UNFILED question — one no unblock or accept has submitted yet, and (by
 *   `isFiledAsk`) one still in flight or one whose dispatch failed, however
 *   many reviews have been filed since. The reviewer has not had their answer,
 *   and the Re-send control lives on that thread.
 *
 * Everything else is filed, INCLUDING a thread that holds no question at all.
 * Such a thread — a task-level conversation the reviewer only ever commented
 * on, or one carrying agent messages alone — has nothing that can ever become
 * unfiled, so a rule written as "current until every question is filed" left it
 * in the Asks list permanently: the same shape of bug as an undelivered comment
 * being archived, in the other direction. Asks lists open business; a thread
 * that can never BE open business does not belong there.
 *
 * Withdrawal is handled by the predicates this calls, not here: a withdrawn
 * comment is neither pending delivery nor an ask awaiting the agent, so a
 * thread holding only withdrawn messages files like any other settled thread.
 *
 * Here rather than on the page, because the live poll's JSON and the
 * server-rendered list must split the same threads the same way.
 */
export function askThreadIsCurrent(t: { messages: ReviewComment[] }): boolean {
  if (t.messages.some(isPendingDelivery)) return true;
  return t.messages.filter(isHumanAsk).some((c) => !isFiledAsk(c));
}

/**
 * Why this message cannot be withdrawn, or null when it can.
 *
 * ONE definition, three surfaces: the daemon refuses with it, the page renders
 * it in place of the Withdraw button, and the route relays it. The rule is
 * "nothing that has reached the agent" — a reviewer must never be told a
 * message was taken back when the agent has already read it.
 *
 * A question already in flight is refused rather than allowed-and-marked:
 * the ask turn is running, the answer will land, and a UI that said "withdrawn"
 * over a conversation still happening would be a lie the reviewer acts on.
 */
export function withdrawRefusalReason(c: ReviewComment): string | null {
  if (c.role !== 'human') return 'Only your own messages can be withdrawn.';
  if (isWithdrawn(c)) return 'This message is already withdrawn.';
  if (c.intent === 'comment') {
    if (c.delivery_state === 'delivered') {
      return (
        'This comment was already delivered to the agent' +
        (c.delivered_turn ? ` in turn ${c.delivered_turn}` : '') +
        ' — it cannot be withdrawn. Say so in your next unblock message instead.'
      );
    }
    return null;
  }
  // Ask intent (including legacy messages written before intents existed,
  // which were asks).
  if (c.ask_state === 'pending') {
    return (
      'This question has already been sent to the agent and may be answered at any moment — ' +
      'it cannot be withdrawn. Wait for the answer, then say so in the thread.'
    );
  }
  // Only a FAILED ask can be withdrawn — it is the one ask state that means the
  // question never reached the agent. Anything else (answered, or a message old
  // enough to predate ask states) is treated as already read: the conversation
  // happened, and withdrawal is not the tool for taking back something said.
  if (c.ask_state !== 'failed') {
    return 'The agent has already answered this question — the conversation happened, so it cannot be withdrawn.';
  }
  return null;
}

export interface ReviewQueueEntry {
  id: string;
  code: string | null;
  goal: string;
  status: TaskStatus;
  type: TaskType;
  updatedAt: number;
  hasSession: boolean;
  commentCount: number;
  /** Questions awaiting an agent answer. */
  pendingAsks: number;
  /** Change requests waiting to ride the next unblock turn. */
  pendingComments: number;
  /**
   * When the task's agent last did anything, or null when it has no session.
   * Same source the task list's "Last Active" column reads.
   */
  lastActiveAt: number | null;
  /**
   * Every descendant of the task, whatever its status — children,
   * grandchildren, and further down. The number that tells a release hub
   * (dozens) apart from an ordinary task (none) at a glance.
   */
  descendantCount: number;
}

export interface PostReviewCommentInput {
  /** Omitted for a new thread; set to the root comment's id for a reply. */
  threadId?: string;
  file: string;
  line: number;
  side: 'old' | 'new';
  content: string;
  /**
   * 'ask' dispatches a read-only question now; 'comment' accumulates for the
   * next unblock. Defaults to 'ask' when absent.
   */
  intent?: ReviewCommentIntent;
  /** The diff line's text, captured so the thread still reads sensibly if the diff moves. */
  anchorSnippet?: string;
}

/**
 * Deliberately loose: the web layer only ever surfaces warnings and redirects,
 * and must not depend on the daemon's lifecycle result shapes (that would pull
 * src/daemon types into src/server and reintroduce the coupling this port
 * exists to avoid).
 */
export interface UnblockResult {
  warnings?: string[];
}

export interface AcceptResult {
  status?: string;
  prUrl?: string;
  warnings?: string[];
}

/** Deliberately loose, for the same reason as {@link UnblockResult}. */
export interface SyncResult {
  status?: string;
  message?: string;
  warnings?: string[];
}

/** One "show me more of this file" request from the diff's expand controls. */
export interface FileLinesQuery {
  /** Path as it appears in the diff — post-image for `new`, pre-image for `old`. */
  path: string;
  side: 'old' | 'new';
  /** 1-based, inclusive. The daemon bounds the range; the caller need not. */
  start: number;
  end: number;
}

export interface FileLinesResult {
  path: string;
  side: 'old' | 'new';
  /** The range actually returned, clamped to the file and to the daemon's cap. */
  start: number;
  end: number;
  lines: string[];
  totalLines: number;
  /** The range reached the end of the file — nothing further to expand. */
  atEof: boolean;
}

export interface ReviewActions {
  /** Blocked tasks awaiting review, newest activity first is the caller's job. */
  listQueue(): Promise<ReviewQueueEntry[]>;
  /**
   * Full unified diff of the task's branch.
   *
   * `region` scopes it to one review region's files — the Changes tab's
   * `?region=<id>` filter. Omitted, the diff is exactly what it was before
   * regions existed.
   */
  getDiff(taskId: string, opts?: { region?: string }): Promise<string>;

  /**
   * The task's region cover, as summary rows (no file lists).
   *
   * Never throws for a task that simply has no regions — it returns an empty
   * list. The Changes tab renders the strip only when there is more than one,
   * so a one-commit task looks exactly as it did before.
   */
  listRegions(taskId: string): Promise<{
    regions: RegionSummary[];
    notes: string[];
  }>;
  /**
   * Per-line unit attribution for the files a Changes view is rendering — the
   * subtask-blame gutter.
   *
   * Takes the paths rather than answering for the whole cover: the gutter is a
   * reading aid on the diff in front of someone, and a release cover's per-line
   * map would be proportional to lines rather than files.
   */
  lineAttribution(
    taskId: string,
    paths: readonly string[],
  ): Promise<Map<string, FileLineAttribution>>;
  /**
   * Unchanged lines of one file the diff touches, for the expand-context
   * controls — the browser must not read git, so it asks for a line range and
   * gets text back from the same worktree and refs the diff was rendered from.
   *
   * Refuses a path that is not part of this diff: the review page is a view of
   * ONE change, not a file browser pointed at the worktree.
   */
  getFileLines(taskId: string, input: FileLinesQuery): Promise<FileLinesResult>;
  /** All anchored review comments for a task, oldest first. */
  listComments(taskId: string): Promise<ReviewComment[]>;
  /**
   * Persist an anchored comment. An 'ask' is then dispatched to the agent as a
   * read-only ask (the reply lands in the same thread); a 'comment' is not
   * dispatched at all and waits for the next unblock. Either way this returns
   * as soon as the comment is durable — unless `waitForAsk` is set, in which
   * case an ask waits for `launchAskTask` to finish so the web dialog can
   * narrate the same phases the CLI prints.
   */
  postComment(
    taskId: string,
    input: PostReviewCommentInput,
    options?: { waitForAsk?: boolean; onProgress?: ProgressEmitter },
  ): Promise<ReviewComment>;
  /**
   * Re-dispatch a question whose ask failed (most often: it was asked while the
   * task was working, so there was no session to resume).
   *
   * The reviewer's words are never re-entered — the comment already exists and
   * is reused as-is. Returns as soon as the retry is queued; a retry that is
   * still impossible records the reason on the comment again rather than
   * throwing it away.
   */
  retryAsk(taskId: string, commentId: string): Promise<ReviewComment>;
  /**
   * Retract one of the reviewer's own messages before it reaches the agent.
   *
   * Allowed only where nothing has been read by anyone: a queued comment still
   * in `pending_delivery`, or a question whose ask failed (by definition never
   * delivered). Refused — with a reason the reviewer sees — for a delivered
   * comment, a question already in flight, an answered question, and anything
   * the agent wrote. See {@link withdrawRefusalReason}.
   *
   * The record survives; it is retracted, not deleted.
   */
  withdrawComment(taskId: string, commentId: string): Promise<ReviewComment>;
  /**
   * Resume the agent with feedback, carrying every undelivered comment into the
   * same work turn. Queued behind any in-flight asks, so the conversation
   * finishes before the work starts.
   *
   * Carries no protected-file decision: unblock never reverts, whatever a
   * violation's recorded status is.
   *
   * `raisedResolutions` optionally resolves named open raised items before the
   * turn launches (partial OK on unblock — unlike accept). Never inferred from
   * the feedback prose.
   */
  unblock(
    taskId: string,
    message: string,
    raisedResolutions?: RaisedItemResolution[],
    onProgress?: ProgressEmitter,
    /** keepFeedbackDraft: the text came from an ask box, not the feedback box. */
    options?: { keepFeedbackDraft?: boolean },
  ): Promise<UnblockResult>;
  /**
   * Accept the task's work and merge it into the parent.
   *
   * `passphrase` satisfies a protection gate in place, exactly as `lazy approve`
   * does at a terminal: it is verified by the daemon, records the one-shot
   * approval the merge then consumes, and is never stored or logged anywhere.
   * The "gated merges are human-only" asymmetry is about AGENTS; a person
   * sitting in the review page is the human it was written for.
   *
   * `raisedResolutions` must name every open raised item when any exist
   * (all-or-nothing), same posture as protected-file approvals. Decisions made
   * earlier via {@link resolveRaisedItem} are already stored, so only still-open
   * items need to travel with this call.
   *
   * A refused accept throws an error carrying a structured remedy — see
   * src/types/accept-remedy.ts — so the caller can offer the fix rather than
   * printing "accept failed".
   */
  accept(
    taskId: string,
    reason?: string,
    passphrase?: string,
    raisedResolutions?: RaisedItemResolution[],
    onProgress?: ProgressEmitter,
    approvedFiles?: string[],
    /** The Accept dialog's "merge without delivering the queued comments" box. */
    options?: { allowQueuedComments?: boolean },
  ): Promise<AcceptResult>;
  /**
   * Merge the parent branch into the task's worktree — the remedy for the
   * refusals that say "sync first", performed in-page instead of sending the
   * reviewer to a terminal.
   */
  sync(taskId: string, onProgress?: ProgressEmitter): Promise<SyncResult>;
  /**
   * Record the reviewer's ⛔/✅ decision on one protected file the agent changed
   * without permission, and return the task's violations as they now stand.
   *
   * The decision is DURABLE the moment it is made, which is what lets a single
   * control drive it: there is one ⛔/✅ per file on the page because there is
   * one stored answer per file, not because copies are kept in sync.
   *
   * `approved: false` restores the file to `pending` rather than writing
   * `rejected`. Only unblock writes `rejected`, at the moment it actually
   * reverts the file — and every gate in the daemon keys off `pending`, so
   * storing `rejected` early would make `lazy accept` see nothing outstanding
   * and merge the very changes the reviewer had refused.
   */
  setViolationDecision(taskId: string, file: string, approved: boolean): Promise<FileViolation[]>;
  /**
   * Resolve one open raised item (respond / promote_subtask / promote_peer /
   * dismiss). Durable immediately — same posture as {@link setViolationDecision}.
   * Accept refuses while any remain open; resolving here clears that gate
   * without merging. The comment stays pending until the next unblock/accept.
   *
   * `actor` is WHO decided — a `{ role, email, name }` ref when the daemon knew the
   * person behind the call, so the record names a team member rather than an
   * anonymous "human". Omitted falls back to the bare `human` role, which is
   * what every single-user surface passes.
   */
  resolveRaisedItem(
    taskId: string,
    itemId: string,
    resolution: { action: RaisedItemResolveAction; response?: string | null },
    actor?: ActorInput,
  ): Promise<RaisedItem>;
  /**
   * Undo a resolution whose comment has not been delivered yet. `actor` is
   * recorded as who reopened the item.
   */
  unresolveRaisedItem(taskId: string, itemId: string, actor?: ActorInput): Promise<RaisedItem>;
  /**
   * Move one raised item between blocking and non-blocking. The agent chose the
   * flag; the reviewer has the last word — a scope question filed as an FYI can
   * be promoted to gate accept, and an orthogonal idea filed as blocking can be
   * demoted without answering it. Idempotent, and allowed on resolved items
   * (the flag is a classification, not a state).
   */
  setRaisedItemBlocking(
    taskId: string,
    itemId: string,
    blocking: boolean,
    actor?: ActorInput,
  ): Promise<RaisedItem>;
  /**
   * The review this person has in progress on this task: unsent feedback and
   * accept-reason text, the review-session composer, and which files they have
   * ticked as viewed. Always resolves — a task nobody has started reviewing
   * answers with an empty draft rather than null, so every surface renders the
   * same shape on a first visit.
   */
  getDraft(taskId: string, reviewer: string): Promise<ReviewDraftState>;
  /**
   * Save part of a review in progress. PATCH semantics: an absent key is left
   * as it was, an empty string is the reviewer having cleared that box.
   *
   * This is how "never lose human feedback" reaches text that has not been
   * submitted yet — it is autosaved as it is typed, so navigating away, a
   * second tab, or another browser on this daemon all see the same words. A
   * PASSIVE write: it never starts a turn, never reaches the agent, and never
   * enters the comment delivery queue.
   */
  saveDraft(taskId: string, reviewer: string, patch: ReviewDraftPatch): Promise<ReviewDraftState>;
  /**
   * Promote one raised item into a real task — a peer of the originating task
   * or a subtask of it. Works on blocking and non-blocking items alike; on a
   * blocking one it also clears the accept gate, because dispatching the work
   * IS the decision. Re-promote is refused.
   */
  promoteRaisedItem(
    taskId: string,
    itemId: string,
    options: { goal?: string; code?: string; relation?: 'peer' | 'subtask'; actor?: ActorInput },
  ): Promise<PromoteRaisedItemResult>;
  /**
   * Promote a review DISCUSSION — a question and the answer it got — into a
   * real task, a peer of this one or a subtask of it.
   *
   * Same act as promoting a raised item, and the same seeding path underneath;
   * what differs is where the words come from. The reviewer edits the seeded
   * goal and prompt before this is called, so `goal` and `prompt` arrive
   * explicit. NEVER started: the web UI does not auto-start work.
   *
   * One promotion per thread, recorded on its root comment — a second press
   * is refused naming the task the first one made.
   */
  promoteDiscussion(
    taskId: string,
    threadId: string,
    options: { goal?: string; prompt?: string; code?: string; relation?: 'peer' | 'subtask' },
  ): Promise<PromoteDiscussionResult>;

  /**
   * Promote a range of a stored builder CONVERSATION into a real task.
   *
   * The third promotion, and the only one with no originating task: a builder
   * conversation is project-scoped, so `parent` (a task id or code, absent =
   * top level) is the only placement there is. The human edits the seeded goal
   * and prompt in the browser before this is called. NEVER started.
   *
   * On the port for the same reason the other two are: the web layer performs
   * no mutation of its own, so this surface renders identically whether it runs
   * inside the daemon or talks to one.
   */
  promoteConversation(
    sessionId: string,
    options: { from?: number; to?: number; goal?: string; prompt?: string; code?: string; parent?: string },
  ): Promise<PromoteConversationResult>;
}

/** What a conversation promotion produced — the shape the daemon returns. */
export type PromoteConversationResult = import('../types').PromoteConversationResult;

/** What a discussion promotion produced. */
export interface PromoteDiscussionResult {
  /** The created task — always unstarted. */
  task: Task;
  /** The thread's root comment, now carrying the promotion link. */
  rootComment: ReviewComment;
}
