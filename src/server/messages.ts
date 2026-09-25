/**
 * The system-messages inbox — the web half of `lazy messages`.
 *
 * System messages are proactive system-to-human reports: scheduled analyses,
 * daemon notices, anything the system wrote FOR the human. They were designed
 * from the start as something "any UI can always display"; this is that UI.
 *
 * ONE VOCABULARY: every state word, every state's meaning and every kind's
 * meaning comes from src/messages/index.ts — the same module the CLI listing and
 * the builder-launch injection read. This file renders that vocabulary and never
 * coins a synonym for it, so the inbox and `lazy messages list` can never
 * describe the same message differently.
 *
 * NO-JS BY CONSTRUCTION: the two actions are plain form POSTs followed by a
 * redirect, like the review surface's retry/withdraw controls. The inbox is
 * where the human finds out something needs their attention; it must not depend
 * on scripting to work.
 */

import type { SystemMessage } from '../types';
import { scratchMentionsHtml } from './scratch';
import {
  shortMessageId,
  systemMessageState,
  SYSTEM_MESSAGE_STATE_MEANING,
  SYSTEM_MESSAGE_KIND_MEANING,
  type SystemMessageState,
} from '../messages';
import { layoutHtml } from './templates';
import { escapeHtml } from './review-diff';
import { renderMarkdown } from './markdown';

function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * Kind tones, in the design system's tag vocabulary: an alert is the one kind
 * that says "soon", so it takes the warning tone; a notice is neutral; a report
 * is content the human asked the system to produce.
 */
function kindBadge(message: SystemMessage): string {
  const tones: Record<string, string> = {
    report: 'tag-accent',
    notice: 'tag-neutral',
    alert: 'tag-warning',
  };
  const tone = tones[message.kind] ?? 'tag-neutral';
  const meaning = SYSTEM_MESSAGE_KIND_MEANING[message.kind] ?? '';
  return `<span class="tag ${tone}" title="${escapeHtml(meaning)}">${escapeHtml(message.kind)}</span>`;
}

/** The lifecycle state, with the shared one-sentence meaning as its tooltip. */
function stateBadge(state: SystemMessageState): string {
  const tones: Record<SystemMessageState, string> = {
    unread: 'tag-warning',
    read: 'tag-neutral',
    dismissed: 'tag-neutral',
  };
  return `<span class="tag ${tones[state]} msg-state-${state}" title="${escapeHtml(SYSTEM_MESSAGE_STATE_MEANING[state])}">${escapeHtml(state)}</span>`;
}

/**
 * The two actions, as forms.
 *
 * "Mark read" is offered only while the message is still unread — it is
 * idempotent in the store, but an affordance that provably changes nothing is
 * noise. Dismiss disappears once dismissed for the same reason, and is replaced
 * by a line saying the record is still here, because the one thing this UI must
 * never imply is that dismissing deleted anything.
 */
function actionsHtml(message: SystemMessage, allView: boolean): string {
  const state = systemMessageState(message);
  const back = allView ? '<input type="hidden" name="all" value="1">' : '';
  const id = escapeHtml(encodeURIComponent(message.id));
  if (state === 'dismissed') {
    return `<span class="msg-note">dismissed ${escapeHtml(formatDate(message.dismissed_at!))}${message.dismissed_by ? ` by ${escapeHtml(message.dismissed_by)}` : ''} — kept on record</span>`;
  }
  const markRead = state === 'unread'
    ? `<form class="msg-action" method="post" action="/messages/${id}/read">${back}<button class="btn btn-sm" type="submit">Mark read</button></form>`
    : '';
  const dismiss = `<form class="msg-action" method="post" action="/messages/${id}/dismiss">${back}<button class="btn btn-sm btn-primary" type="submit">Dismiss</button></form>`;
  return `${markRead}${dismiss}`;
}

function noticeHtml(notice?: { text: string; error?: boolean }): string {
  if (!notice) return '';
  return `<div class="msg-notice${notice.error ? ' msg-notice-error' : ''}">${escapeHtml(notice.text)}</div>`;
}

/** How many of these messages the human has not seen yet. */
export function unreadCount(messages: SystemMessage[]): number {
  return messages.filter((m) => systemMessageState(m) === 'unread').length;
}

/**
 * The inbox: newest first, undismissed by default.
 *
 * The legend is not decoration — read and dismissed are easy to confuse, and the
 * difference (what still reaches the builder's launch context, what is merely
 * filed) is exactly what the human is deciding between here. It is spelled out
 * in the shared wording rather than left to the badge colours.
 */
export function messagesInboxHtml(
  messages: SystemMessage[],
  allView: boolean,
  notice?: { text: string; error?: boolean },
): string {
  const sorted = [...messages].sort((a, b) => b.created_at - a.created_at);

  const filterBar = `<div class="filter-bar">
    <a href="/messages" class="btn btn-sm${allView ? '' : ' active'}">Inbox</a>
    <a href="/messages?all=1" class="btn btn-sm${allView ? ' active' : ''}">All (incl. dismissed)</a>
  </div>`;

  const legend = `<div class="msg-legend">
    ${(['unread', 'read', 'dismissed'] as SystemMessageState[]).map((s) =>
      `<div><strong>${escapeHtml(s)}</strong> — ${escapeHtml(SYSTEM_MESSAGE_STATE_MEANING[s])}</div>`
    ).join('')}
  </div>`;

  if (sorted.length === 0) {
    return layoutHtml('Inbox', `
      <h1>Inbox</h1>
      ${filterBar}
      ${noticeHtml(notice)}
      <div class="empty-state">${allView
        ? 'No system messages.'
        : 'No system messages — dismissed ones are hidden, try the All view.'}</div>
      ${legend}
    `);
  }

  const rows = sorted.map((m) => {
    const state = systemMessageState(m);
    return `<tr class="msg-row msg-row-${state}">
      <td class="msg-id">${escapeHtml(shortMessageId(m.id))}</td>
      <td>${kindBadge(m)}</td>
      <td>${stateBadge(state)}</td>
      <td>${escapeHtml(formatDate(m.created_at))}</td>
      <td>${escapeHtml(m.source)}</td>
      <td class="wrap msg-title"><a href="/messages/${escapeHtml(encodeURIComponent(m.id))}">${escapeHtml(m.title)}</a></td>
      <td class="msg-actions">${actionsHtml(m, allView)}</td>
    </tr>`;
  }).join('\n');

  const unread = unreadCount(sorted);
  const summary = unread > 0
    ? `<p class="text-muted">${unread} unread — unread messages are in the builder's launch context until you read or dismiss them.</p>`
    : `<p class="text-muted">Nothing unread.</p>`;

  return layoutHtml('Inbox', `
    <h1>Inbox</h1>
    ${filterBar}
    ${noticeHtml(notice)}
    ${summary}
    <table class="table msg-table">
      <thead><tr><th>ID</th><th>Kind</th><th>State</th><th>Created</th><th>Source</th><th>Title</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${legend}
  `);
}

/**
 * One message in full.
 *
 * Reaching this page marks the message read — the same rule `lazy messages read`
 * follows, and the same reason: `read_at` records that the human has SEEN it,
 * and there is no more direct evidence of that than the body being on screen.
 * The route does the marking; this renderer shows the resulting state.
 */
export function messageDetailHtml(
  message: SystemMessage,
  notice?: { text: string; error?: boolean },
  scratchPaths: string[] = [],
): string {
  const state = systemMessageState(message);
  const meta = [
    escapeHtml(shortMessageId(message.id)),
    kindBadge(message),
    `from ${escapeHtml(message.source)}`,
    escapeHtml(formatDate(message.created_at)),
    stateBadge(state),
  ].join(' · ');

  return layoutHtml(message.title, `
    <div class="breadcrumb"><a href="/messages">Inbox</a> &rsaquo; Message</div>
    <h1>${escapeHtml(message.title)}</h1>
    <div class="msg-meta">${meta}</div>
    ${noticeHtml(notice)}
    <div class="action-links msg-detail-actions">${actionsHtml(message, false)}</div>
    <div class="detail-section">
      <div class="turn-content">${renderMarkdown(message.body)}</div>
    </div>
    ${scratchMentionsHtml(scratchPaths)}
  `);
}
