/**
 * Current review tab — the human's in-progress review state, and the one
 * place a turn ends.
 *
 * Does NOT parse the branch diff. Viewed progress comes from the review
 * draft; the accept checklist is disclosure (daemon still refuses).
 */

import type { Task, RaisedItem, Comment } from '../storage';
import type { FileViolation, ReviewComment, AcceptRemedy } from '../types';
import { isProseReviewAnchor, proseAnchorReviewerWhere } from '../review/prose-anchor';
import { isTaskLevelReviewAnchor } from '../review/task-level-anchor';
import { escapeHtml, anchorDomId, fileSectionId } from './review-diff';
import {
  actionsHtml,
  groupThreads,
  pendingDeliveryComments,
  proseThreadsFallbackHtml,
  taskLevelThreads,
  threadHtml,
  remedyPanelHtml,
  type ReviewDraft,
  type ReviewLiveState,
} from './review';
import { askThreadIsCurrent, withdrawRefusalReason } from './review-actions';
import { busyGateAttributes, busyUnblockAcceptReason } from './review';
import { isHumanFeedbackComment } from '../task/queued-feedback';
import {
  reviewEndVerbUnavailableReason,
  taskVerbUnavailableReason,
} from './task-verbs';
import { taskPathSegment } from './task-urls';
import type { ReviewTurnLike } from '../review/success';
import { buildAcceptGate, type AcceptGate } from '../review/accept-gate';
import type { TaskSubmitPreflight, TaskUpstreamStatusView } from './task-actions';
import { submitActionHtml, taskCanOfferSubmit } from './submit-action';
import { actionDialogButtonHtml, actionDialogTemplateHtml } from './action-dialog';
import type { ShowFinal } from '../task/show-sections';
import { attributionLabel } from '../actor-ref';

export interface CurrentReviewInput {
  task: Task;
  comments: ReviewComment[];
  /**
   * Task comments the agent has not been shown yet, oldest first — resolved by
   * `queuedComments` (the Comments tab's resolver). They ride the next
   * Unblock exactly like queued review comments, so this page counts and
   * lists both; omitting them told a reviewer "0 comments queued" while the
   * Comments tab said otherwise.
   */
  queuedNotes?: Comment[];
  raisedItems: RaisedItem[];
  fileViolations: FileViolation[];
  viewedFiles: Record<string, string>;
  draft: ReviewDraft;
  live: ReviewLiveState;
  notice?: { text: string; error?: boolean };
  remedy?: AcceptRemedy;
  submitPreflight?: TaskSubmitPreflight | null;
  upstream?: TaskUpstreamStatusView | null;
  hasOpenSession: boolean;
  hasCommits: boolean;
  /** Current-turn verified ticks vs current-turn steps. */
  verifyProgress?: { verified: number; total: number };
  /** Session turns — used to decide whether Accept should offer a formal review. */
  turns?: ReviewTurnLike[];
  /** Codes shared by more than one task — this page's task links fall back to the id. */
  duplicatedCodes?: ReadonlySet<string>;
  /**
   * Pencils down, resolved by `resolveFinalState` in the daemon. `null` means
   * nobody declared this work done — which this page SAYS, rather than leaving
   * the reviewer to infer it from a `blocked` status that reads the same way
   * whether the agent finished or merely stopped.
   */
  final?: ShowFinal | null;
}

/**
 * "Has anyone said this is done?" — the first thing a reviewer needs and the
 * one thing the task status cannot tell them.
 *
 * Disclosure only in this slice: nothing here gates accept (that is slice 2).
 * The "head has since moved" line comes pre-composed from the resolver, so this
 * page cannot word it differently from the CLI.
 */
function finalBannerHtml(final: ShowFinal | null | undefined): string {
  if (!final) {
    return `<div class="lz-review-final" data-final="0">
      <h2>Not declared done</h2>
      <p class="rv-hint">The agent has not declared its work final.</p>
    </div>`;
  }
  const who = attributionLabel(final.claim.actor, final.claim.actor_user_id);
  const when = new Date(final.claim.at).toISOString();
  const moved = final.head_moved_label
    ? `<p class="rv-hint lz-final-moved">${escapeHtml(final.head_moved_label)}</p>`
    : '';
  const note = final.claim.note
    ? `<p class="lz-final-note">${escapeHtml(final.claim.note)}</p>`
    : '';
  return `<div class="lz-review-final" data-final="1">
    <h2>Declared done</h2>
    <p class="rv-hint">by ${escapeHtml(who)} at <code>${escapeHtml(final.claim.sha.slice(0, 8))}</code>
    · <time datetime="${escapeHtml(when)}">${escapeHtml(when)}</time></p>
    ${note}
    ${moved}
  </div>`;
}

function viewedProgress(
  viewedFiles: Record<string, string>,
  verify?: { verified: number; total: number },
): { files: number; steps: number; stepTotal: number } {
  let files = 0;
  for (const key of Object.keys(viewedFiles)) {
    if (key.startsWith('verify:') || key.startsWith('card:')) continue;
    files += 1;
  }
  return {
    files,
    steps: verify?.verified ?? 0,
    stepTotal: verify?.total ?? 0,
  };
}

function raisedIdFromProseFile(file: string): string | null {
  const m = file.match(/^\((?:raised|followup):([^)]+)\)$/);
  return m ? m[1] : null;
}

/** Where a queued comment's `→` goes, per docs/design/task-page-tabs.md §6. */
export function commentAnchorHref(taskId: string, c: ReviewComment): string {
  if (isTaskLevelReviewAnchor(c.file, c.line)) {
    return `/tasks/${taskId}/review#thread-${encodeURIComponent(c.thread_id)}`;
  }
  if (isProseReviewAnchor(c.file)) {
    const raised = raisedIdFromProseFile(c.file);
    if (raised) return `/raised/${raised}`;
    return `/tasks/${taskId}#prose-${c.line}`;
  }
  return `/tasks/${taskId}/changes#${anchorDomId({ file: c.file, side: c.side, line: c.line })}`;
}

function queuedCommentWhere(taskId: string, c: ReviewComment): string {
  const href = commentAnchorHref(taskId, c);
  if (isTaskLevelReviewAnchor(c.file, c.line)) {
    return `<a class="rv-queued-where" href="${escapeHtml(href)}">on the task-level conversation</a>`;
  }
  if (isProseReviewAnchor(c.file)) {
    const quote = (c.anchor_snippet ?? '').replace(/\s+/g, ' ').trim();
    const clipped = quote.length > 120 ? `${quote.slice(0, 117)}…` : quote;
    return `<a class="rv-queued-where" href="${escapeHtml(href)}">${escapeHtml(proseAnchorReviewerWhere(c.file))}${clipped ? `: <q>${escapeHtml(clipped)}</q>` : ''}</a>`;
  }
  return `<a class="rv-queued-where" href="${escapeHtml(href)}"><code>${escapeHtml(c.file)}</code>:${c.line}</a>`;
}

function withdrawQueuedHtml(taskId: string, c: ReviewComment): string {
  const refusal = withdrawRefusalReason(c);
  if (refusal) return '';
  return (
    `<form class="rv-withdraw" method="post" action="/tasks/${escapeHtml(taskId)}/review/comment/${encodeURIComponent(c.id)}/withdraw">` +
    `<button type="submit" title="Withdraw this comment">Withdraw</button></form>`
  );
}

/**
 * Disclosure only — the rows come from {@link buildAcceptGate}, the same
 * builder the `show` RPC serves to Lazy Teams; this only decides where each
 * row links.
 */
function acceptChecklistHtml(
  /** URL path segment (code or id, already escaped) — for the hrefs below. */
  taskId: string,
  gate: AcceptGate,
): string {
  const t = escapeHtml(taskId);
  const rows = gate.rows.map((row) => {
    switch (row.kind) {
      case 'review':
        // ESCAPED: the label can quote a reviewer's own verdict string — text
        // an AGENT wrote, which nothing sanitises on the way in.
        return `<li class="lz-gate-item">${escapeHtml(row.label)}` +
          ` <a class="rv-hint" href="/tasks/${t}/reviews">→ Reviews</a>` +
          (row.unblockable
            ? ` · <a class="rv-hint" href="/tasks/${t}/raised">Unblock to address</a>`
            : '') +
          `</li>`;
      case 'raised':
        return `<li class="lz-gate-item"><a href="/raised/${escapeHtml(row.raisedId)}">${escapeHtml(row.label)}</a>` +
          ` <a class="rv-hint" href="/tasks/${t}/raised">→ Raised</a></li>`;
      case 'comments':
        return `<li class="lz-gate-item">${escapeHtml(row.label)}` +
          ` <a class="rv-hint" href="#lz-review-queued">→ Queued comments</a></li>`;
      case 'file':
        // Land on the file's Changes card, not the top of the tab.
        return `<li class="lz-gate-item"><code>${escapeHtml(row.file)}</code> has no decision` +
          ` <a class="rv-hint" href="/tasks/${t}/changes#${escapeHtml(fileSectionId(row.file))}">→ Changes</a></li>`;
    }
  });
  if (rows.length === 0) {
    return `<div class="lz-review-gate" data-resolved="1">
      <h2>Before you can accept</h2>
      <p class="rv-hint">Nothing is blocking accept from this tab. The daemon still has the final word.</p>
    </div>`;
  }
  return `<div class="lz-review-gate">
    <h2>Before you can accept</h2>
    <ul class="lz-gate-list">${rows.join('')}</ul>
    <p class="rv-hint">Accept refuses while any of these is open.</p>
  </div>`;
}

/**
 * A review-end verb is either offered or explained — never a greyed-out
 * button, which cannot say why it is off. `busy` is passed only for a verb
 * the busy state itself refuses (Sync): it is mounted HIDDEN behind the same
 * live gate as Unblock / Accept, whose visible line already says why, so the
 * page offers it again the moment the task pauses. Any other refusal is one
 * line of text naming the reason.
 */
function terminalVerbHtml(
  verb: 'sync' | 'reject',
  label: string,
  reason: string | null,
  busy: boolean,
  template: string,
): string {
  if (reason && !busy) {
    return `<p class="rv-hint lz-verb-unavailable" data-verb="${verb}"><strong>${escapeHtml(label)}</strong> — ${escapeHtml(reason)}</p>`;
  }
  return actionDialogButtonHtml({
    verb,
    label,
    reenableable: true,
    extraAttrs: busyGateAttributes(busy ? 'busy' : null),
  }) + template;
}

function syncFormHtml(taskId: string, reason: string | null, busy: boolean): string {
  return terminalVerbHtml('sync', 'Sync', reason, busy, actionDialogTemplateHtml('sync', `
    <form method="post" action="/tasks/${escapeHtml(taskId)}/actions/sync" class="lz-action-form" data-lz-action-form>
      <p>Merge the parent branch into this task. The agent resolves conflicts.</p>
      <div class="rv-form-actions"><button type="submit" class="btn">Sync</button></div>
    </form>`, { noscript: !busy }));
}

/**
 * Reject is NOT behind the busy gate: the daemon rejects a working task (it
 * stops the runner first), so hiding it while working would take away a verb
 * that works. Only its own refusals — terminal, pairing, no open session —
 * turn it into a line of text.
 */
function rejectFormHtml(taskId: string, reason: string | null): string {
  return terminalVerbHtml('reject', 'Reject', reason, false, actionDialogTemplateHtml('reject', `
    <form method="post" action="/tasks/${escapeHtml(taskId)}/actions/reject" class="lz-action-form" data-lz-action-form>
      <p>Reject this task's work and send it back with feedback.</p>
      <input class="input" type="text" name="reason" required placeholder="Feedback for the agent">
      <div class="rv-form-actions"><button type="submit" class="btn">Reject task</button></div>
    </form>`));
}


/**
 * The count accept refuses on (src/task/queued-feedback.ts): queued web-review
 * comments plus queued task comments a human wrote. The page's own header
 * lists every queued comment; this is the subset that gates.
 */
function queuedFeedbackCount(input: CurrentReviewInput): number {
  return pendingDeliveryComments(input.comments).length +
    (input.queuedNotes ?? []).filter(isHumanFeedbackComment).length;
}

function reviewEndActionsHtml(input: CurrentReviewInput): string {
  const { task, draft, live } = input;
  const queued = pendingDeliveryComments(input.comments);
  // Busy (working / pairing) is one condition with one visible line, owned by
  // the actions box below; Sync hides behind it like Unblock and Accept rather
  // than repeating "task is working" in its own words. Reject does not — see
  // rejectFormHtml.
  const busy = busyUnblockAcceptReason(task.status) !== null;
  const syncReason = reviewEndVerbUnavailableReason('sync', task.status);
  const rejectReason = taskVerbUnavailableReason('reject', task.status, input.hasOpenSession);
  const approvedFiles = input.fileViolations
    .filter((v) => v.status === 'approved')
    .map((v) => v.file);
  const seg = taskPathSegment(task, input.duplicatedCodes);

  // Unblock / Ask / Accept / Submit as dialogs (not in-card tabs). extras:false
  // because queued comments and ask threads already list above (withdraw, §6
  // links, delivery state). Reject / Sync sit beside them, same dialog chrome.
  return `<div class="lz-review-actions">
    ${actionsHtml(task, queued, input.comments, live, draft, {
      extras: false,
      approvedFiles,
      fileViolations: input.fileViolations,
      showSubmit: taskCanOfferSubmit(task.status),
      submitPreflight: input.submitPreflight,
      duplicatedCodes: input.duplicatedCodes,
      queuedCount: queued.length + (input.queuedNotes?.length ?? 0),
      queuedFeedback: queuedFeedbackCount(input),
    })}
    <div class="lz-review-terminals">
      ${rejectFormHtml(seg, rejectReason)}
      ${syncFormHtml(seg, syncReason, busy)}
    </div>
    <p class="rv-hint">Comment on a line in Changes, or on the report from Summary.</p>
  </div>`;
}

export function currentReviewHtml(input: CurrentReviewInput): string {
  const { task, comments, viewedFiles } = input;
  // Task links read the task's code (id when the code is duplicated) so this
  // page's URLs read like every other task URL.
  const seg = taskPathSegment(task, input.duplicatedCodes);
  const queued = pendingDeliveryComments(comments);
  const queuedNotes = input.queuedNotes ?? [];
  const queuedTotal = queued.length + queuedNotes.length;
  const asks = taskLevelThreads(comments);
  const progress = viewedProgress(viewedFiles, input.verifyProgress);
  const notice = input.notice
    ? `<div class="rv-notice${input.notice.error ? ' rv-notice-err' : ''}">${escapeHtml(input.notice.text)}</div>`
    : '';
  const stepBit = progress.stepTotal > 0
    ? `${progress.steps} of ${progress.stepTotal} steps verified`
    : progress.steps > 0
      ? `${progress.steps} step${progress.steps === 1 ? '' : 's'} verified`
      : null;
  const progressBits = [
    `${queuedTotal} comment${queuedTotal === 1 ? '' : 's'} queued`,
    `${progress.files} file${progress.files === 1 ? '' : 's'} viewed`,
    stepBit,
  ].filter(Boolean);

  const noteItems = queuedNotes.map((c) => `<li class="rv-queued-item" id="note-${escapeHtml(c.id)}">
          <a class="rv-queued-where" href="/tasks/${escapeHtml(seg)}/comments">task comment</a>
          <div class="rv-msg-body">${escapeHtml(c.content)}</div>
        </li>`);
  const queuedBlock = queuedTotal === 0
    ? `<div class="lz-review-queued" id="lz-review-queued">
        <h2>Queued comments</h2>
        <p class="rv-hint">None yet. Comment on a line in Changes, on the report from Summary, or in Comments — they land here and ride the next Unblock.</p>
      </div>`
    : `<div class="lz-review-queued" id="lz-review-queued">
        <h2>Queued comments (${queuedTotal}) — delivered on your next Unblock</h2>
        <ul class="rv-queued-list">${noteItems.join('\n')}${queued.map((c) => `<li class="rv-queued-item" id="thread-${escapeHtml(c.thread_id)}">
          ${queuedCommentWhere(seg, c)}
          <div class="rv-msg-body">${escapeHtml(c.content)}</div>
          ${withdrawQueuedHtml(seg, c)}
        </li>`).join('\n')}</ul>
      </div>`;

  // Asks from reviews the human already filed drop out of the live list —
  // they were answered and submitted, and a page that keeps listing them as
  // open business is the reason none of them ever seemed to clear. They are
  // moved, never lost: the filed ones are one click away, in full, below.
  const currentAsks = asks.filter(askThreadIsCurrent);
  const filedAsks = asks.filter((t) => !askThreadIsCurrent(t));
  const filedBlock = filedAsks.length === 0
    ? ''
    : `<details class="lz-review-asks-filed">
        <summary>Filed asks (${filedAsks.length}) — answered and submitted with an earlier review</summary>
        ${filedAsks.map((t) => `<div id="thread-${escapeHtml(t.threadId)}">${threadHtml(seg, t, { taskLevel: true, promoteFor: task, duplicatedCodes: input.duplicatedCodes })}</div>`).join('\n')}
      </details>`;
  // The filed block lives INSIDE `data-rv-task-threads`, with the open list and
  // the heading count driven from the same render: the poll island replaces
  // that container wholesale, so anything the island also emits must sit inside
  // it or the page grows a second copy seconds after load — an archive that
  // duplicates itself is the opposite of "moved, not lost". `taskLevelConversationHtml`
  // on the task page is built the same way for the same reason.
  const askBlock = `<div class="lz-review-asks">
    <h2 data-rv-asks-count>Asks (${currentAsks.length})</h2>
    <div data-rv-task-threads>${currentAsks.length === 0
      ? '<p class="rv-hint">No open questions — ask about the task below.</p>'
      : currentAsks.map((t) => `<div id="thread-${escapeHtml(t.threadId)}">${threadHtml(seg, t, { taskLevel: true, promoteFor: task, duplicatedCodes: input.duplicatedCodes })}</div>`).join('\n')}${filedBlock}</div>
  </div>`;

  return `<section class="lz-current-review">
    ${notice}
    <header class="lz-review-head">
      <h1>Your review of ${escapeHtml(task.code ?? task.id.slice(0, 8))}</h1>
      <p class="lz-review-progress">${progressBits.join(' · ')}</p>
      ${input.upstream ? `<p class="lz-upstream rv-hint">${escapeHtml(input.upstream.htmlLine)}</p>` : ''}
    </header>
    ${input.remedy ? remedyPanelHtml(seg, input.remedy, input.draft) : ''}
    ${finalBannerHtml(input.final)}
    ${acceptChecklistHtml(seg, buildAcceptGate({ turns: input.turns ?? [], raisedItems: input.raisedItems, fileViolations: input.fileViolations, taskMetadata: task.metadata, queuedComments: queuedFeedbackCount(input) }))}
    ${queuedBlock}
    ${askBlock}
    ${proseThreadsFallbackHtml(seg, groupThreads(comments))}
    ${reviewEndActionsHtml(input)}
  </section>`;
}
