/**
 * The Comments and Journal tabs of the task page.
 *
 * Both surfaces already existed everywhere except the web: comments reach the
 * agent through `buildNotesContext()`, journal entries through
 * `lazy show --sections journal`. This renders them with the task page's own
 * card vocabulary — nothing new is computed here.
 *
 * COMMENTS: chronological (oldest first — a comment thread reads forward), split
 * into what the agent has already been shown and what is still queued. The
 * cutoff is `resolveNotesCutoff()` (`src/task/turn-context.ts`) and nothing else:
 * every surface answering "which comments has the agent not seen" must agree
 * with the prompt that will actually carry them.
 *
 * INVARIANT: the add-comment form POSTs to `/tasks/:id/comments/add`, which
 * persists a comment and NOTHING ELSE. A comment never starts a turn — it rides
 * the next unblock. See CLAUDE.md ("A lazy comment never starts a turn") and
 * `src/cli/commands/comment.ts`, which is deliberately just as inert.
 *
 * JOURNAL: newest first, matching the Turns tab convention. The journal is
 * read-only on the web — appending is `lazy journal` / `lazy_journal`, which is
 * where the out-of-prompt discipline is documented.
 */

import type { Comment, JournalEntry, Session, Turn } from '../storage';
import { buildNotesState } from '../task/show-sections';
import type { RenderMarkdownOptions } from './markdown';
import { commentCardHtml, journalCardHtml, layoutHtml } from './templates';
import { escapeHtml } from './review-diff';
import { isTerminalStatus, type TaskStatus } from '../types';

export interface TaskCommentsTabInput {
  /** The task's URL segment (code or id, already URL-escaped) — see task-urls. */
  taskId: string;
  taskStatus: TaskStatus;
  comments: Comment[];
  session: Session | null;
  turns: Turn[];
  markdown?: RenderMarkdownOptions;
}

/** Comments the agent has not been shown yet — the ones the next unblock carries. */
export function queuedComments(
  comments: Comment[],
  session: Session | null,
  turns: Turn[],
): Comment[] {
  // The same answer `show` sends remote clients, built by the same function —
  // this page and Lazy Teams cannot disagree about which comments are queued.
  const queued = new Set(buildNotesState(session, turns, comments).queued_ids);
  return comments.filter((c) => queued.has(c.id));
}

function byOldestFirst(comments: Comment[]): Comment[] {
  return [...comments].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    return a.id.localeCompare(b.id);
  });
}

const DELIVERED_MARK = ` <span class="tag tag-neutral lz-note-mark">seen by the agent</span>`;
const QUEUED_MARK = ` <span class="tag tag-warning lz-note-mark">queued</span>`;

/**
 * The add-comment composer. A plain form, so it works with scripting off — the
 * POST redirects back to this tab.
 *
 * Rendered in EVERY status, terminal included. Annotating a finished task is
 * the documented main use of `lazy comment` — its own usage text gives
 * "Superseded by task xyz" as the example — and the CLI accepts one whatever
 * the status. Hiding the box on the web would be an undocumented asymmetry on
 * exactly the tasks where the feature earns its keep. Nothing about the
 * never-starts-a-turn invariant depends on status: a comment is inert in all
 * of them.
 */
function commentFormHtml(taskId: string, terminal: boolean): string {
  const hint = terminal
    ? 'Saved and nothing else. This task has ended, so nothing will carry it to an agent unless the task is reopened — an annotation for the humans reading this later.'
    : 'Saved and nothing else — it reaches the agent in the prompt of the next unblock.';
  return `
      <form method="post" action="/tasks/${escapeHtml(taskId)}/comments/add" class="lz-comment-form">
        <label class="visually-hidden" for="lz-comment-body">Comment</label>
        <textarea class="input" id="lz-comment-body" name="content" rows="4" required
          placeholder="Context that does not fit in a turn or a prompt. Markdown renders."></textarea>
        <div class="rv-form-actions">
          <button type="submit" class="btn">Add comment</button>
          <span class="rv-hint">${hint}</span>
        </div>
      </form>`;
}

/**
 * Edit form for a QUEUED comment. Only queued comments get one: once the agent
 * has been shown a comment it may have acted on it, and the daemon refuses the
 * edit (`editUnseenComment`). A `<details>` so the tab stays readable.
 */
function commentEditFormHtml(taskId: string, comment: Comment): string {
  return `
      <details class="lz-comment-edit">
        <summary>Edit — allowed until the agent is shown it</summary>
        <form method="post" action="/tasks/${escapeHtml(taskId)}/comments/${escapeHtml(comment.id)}/edit" class="lz-comment-form">
          <label class="visually-hidden" for="lz-comment-edit-${escapeHtml(comment.id)}">Comment text</label>
          <textarea class="input" id="lz-comment-edit-${escapeHtml(comment.id)}" name="content" rows="4" required>${escapeHtml(comment.content)}</textarea>
          <div class="rv-form-actions">
            <button type="submit" class="btn">Save edit</button>
          </div>
        </form>
      </details>`;
}

/**
 * The Comments tab body. The composer is always here, in every status, so the
 * empty case is a place to act rather than a dead end.
 */
export function taskCommentsTabHtml(input: TaskCommentsTabInput): string {
  const { taskId, comments, session, turns } = input;
  const ordered = byOldestFirst(comments);
  const queued = new Set(queuedComments(ordered, session, turns).map((c) => c.id));
  const delivered = ordered.filter((c) => !queued.has(c.id));
  const pending = ordered.filter((c) => queued.has(c.id));
  const terminal = isTerminalStatus(input.taskStatus);
  const form = commentFormHtml(taskId, terminal);

  const explain = comments.length === 0
    ? `<p class="lz-empty-tab">No comments yet. A comment is a note to the agent — context, a correction, a decision — that is saved now and delivered in the prompt of the next unblock. It never starts a turn on its own.</p>`
    : '';

  const deliveredBlock = delivered.length
    ? `<h3 class="lz-note-group">Seen by the agent (${delivered.length})</h3>
       <p class="rv-hint">Carried into a prompt already — the agent has read these, so they can no longer be edited. Add a new comment to correct one.</p>
       ${delivered.map((c) => commentCardHtml(c, input.markdown, DELIVERED_MARK)).join('')}`
    : '';

  // On a terminal task these are undelivered, NOT undeliverable: this page can
  // reopen or redo the task, and the next unblock then carries them like any
  // other queued comment. Saying "never delivered" would be a false claim on
  // the one surface whose job is telling the truth about delivery.
  const queuedBlock = pending.length
    ? `<h3 class="lz-note-group">Queued for the next turn (${pending.length})</h3>
       <p class="rv-hint">${terminal
         ? 'Not delivered — this task ended before another turn ran. They ride the next turn if it is reopened or redone.'
         : 'The next unblock carries these into the agent’s prompt.'}</p>
       ${pending.map((c) => commentCardHtml(c, input.markdown, QUEUED_MARK) + commentEditFormHtml(taskId, c)).join('')}`
    : '';

  return `
      <div class="detail-section">
        <h2>Comments (${comments.length})</h2>
        ${explain}
        ${form}
        ${deliveredBlock}
        ${queuedBlock}
      </div>
    `;
}

/**
 * The refusal page for a comment that could NOT be written to the store.
 *
 * CLAUDE.md's first invariant is that human feedback is never silently
 * discarded. The browser has already thrown the textarea away by the time this
 * response renders, so the submitted text is echoed back verbatim in a
 * selectable block — the same "your reason was not lost" move `handleTaskAction`
 * makes for a close/reject reason.
 *
 * A `<pre>`, deliberately, not a pre-filled `<textarea>`: a form that just
 * failed invites a second submit against the same broken store, while a block
 * of text reads as "copy this somewhere safe". `lazy comment` is named as the
 * fallback because it is a different write path — direct storage, no web
 * layer — and may work when this one did not.
 */
export function commentSaveFailedHtml(taskId: string, content: string, reason: string): string {
  return layoutHtml('Comment not saved', `
    <h1>Comment not saved</h1>
    <p>The comment could NOT be written to the store, so it was not added to this task:</p>
    <p class="rv-notice rv-notice-err">${escapeHtml(reason)}</p>
    <p>Your text was not lost. Copy it from below and submit it again once the problem is
       fixed, or add it from a terminal with <code>lazy comment ${escapeHtml(taskId)}</code>.</p>
    <pre class="lz-kept-text">${escapeHtml(content)}</pre>
    <p><a href="/tasks/${escapeHtml(taskId)}/comments">Back to the Comments tab</a></p>
  `);
}

/** The Journal tab body. Newest first, like Turns. Read-only on the web. */
export function taskJournalTabHtml(
  journal: JournalEntry[],
  markdown?: RenderMarkdownOptions,
): string {
  const ordered = [...journal].sort((a, b) => {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return b.id.localeCompare(a.id);
  });
  const body = ordered.length
    ? ordered.map((e) => journalCardHtml(e, markdown)).join('')
    : `<p class="lz-empty-tab">No journal entries. The journal is a task’s out-of-prompt record — rationale, things stubbed or deferred, notes to whoever picks this up next. Nothing written here is injected into an agent’s prompt: a later turn is told only how many new entries exist, and reads them if it wants. Append one with <code>lazy journal &lt;task&gt;</code>.</p>`;
  return `
      <div class="detail-section">
        <h2>Journal (${journal.length})</h2>
        ${ordered.length ? `<p class="rv-hint">Newest first. Entries never enter an agent’s prompt — they inform, they do not instruct.</p>` : ''}
        ${body}
      </div>
    `;
}

/**
 * The refusal page for an edit that was NOT applied — most often because the
 * agent has already been shown the comment. The submitted text is echoed back,
 * for the same never-lose-feedback reason as {@link commentSaveFailedHtml}.
 */
export function commentEditRefusedHtml(taskId: string, content: string, reason: string): string {
  return layoutHtml('Comment not edited', `
    <h1>Comment not edited</h1>
    <p class="rv-notice rv-notice-err">${escapeHtml(reason)}</p>
    <p>Your text was not lost. Copy it from below — to post it as a new comment, for instance.</p>
    <pre class="lz-kept-text">${escapeHtml(content)}</pre>
    <p><a href="/tasks/${escapeHtml(taskId)}/comments">Back to the Comments tab</a></p>
  `);
}
