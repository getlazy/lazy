/**
 * Read-only view of a stored builder review session.
 *
 * Review with builder is gone: the dashboard must not start or continue those
 * chats. Existing `review-session.json` records stay readable — this page is
 * that cheap archive, with no start form, compose box, retry, or poll loop.
 */

import { layoutHtml } from './templates';
import { escapeHtml } from './review-diff';
import { renderMarkdown } from './markdown';
import { taskPath } from './task-urls';
import { REVIEW_SESSION_FIRST_TURN_CLOSER } from './review-session-actions';
import type { ReviewSession, ReviewSessionMessage, ReviewSessionStatus } from '../types';
import type { Task } from '../storage';

export const REVIEW_WITH_BUILDER_GONE_MESSAGE =
  'Review with builder was removed. Use Review on the task page to run a formal agent review.';

/** Entry point removed — agent Review is the only review action on the task page. */
export function reviewSessionEntryHtml(_taskId: string, _status: string): string {
  return '';
}

/** @deprecated Entry point removed; kept so old imports compile. */
export function reviewSessionStartButtonHtml(taskId: string, status: string): string {
  return reviewSessionEntryHtml(taskId, status);
}

/** @deprecated Start is gone; kept so old imports compile. */
export function reviewSessionStartFormHtml(_taskId: string): string {
  return '';
}

/** Auto-injected preamble — not user compose; hide misleading delivery banners. */
export function isReviewSessionPreambleMessage(content: string): boolean {
  return content.includes(REVIEW_SESSION_FIRST_TURN_CLOSER);
}

function messageRoleLabel(role: ReviewSessionMessage['role']): string {
  if (role === 'assistant') return 'builder';
  if (role === 'system') return 'system';
  return 'you';
}

function messageDeliveryHtml(_taskId: string, m: ReviewSessionMessage): string {
  if (m.role !== 'human') return '';
  if (!m.content.trim()) return '';
  if (isReviewSessionPreambleMessage(m.content)) {
    if (m.delivery === 'pending') {
      return '<div class="rv-state rv-state-pending">Builder is reading task context…</div>';
    }
    return '';
  }
  if (m.delivery === 'pending') {
    return '<div class="rv-state rv-state-pending">waiting for the builder…</div>';
  }
  if (m.delivery === 'failed') {
    // Archive only — retry would re-open the send loop this page exists to close.
    return '<div class="rv-state rv-state-failed">not sent</div>';
  }
  return '';
}

function messageBodyHtml(m: ReviewSessionMessage): string {
  if (m.role === 'assistant' || m.role === 'system') {
    return `<div class="rv-msg-body turn-content">${renderMarkdown(m.content)}</div>`;
  }
  // Human messages: plain pre-wrap (compose box text, not markdown authored by user).
  return `<div class="rv-msg-body">${escapeHtml(m.content)}</div>`;
}

function messageHtml(taskId: string, m: ReviewSessionMessage): string {
  const roleClass = m.role === 'assistant' ? ' rv-msg-agent' : '';
  return (
    `<div class="rv-msg${roleClass}">` +
    `<div class="rv-msg-head">${escapeHtml(messageRoleLabel(m.role))}</div>` +
    `${messageBodyHtml(m)}` +
    `${messageDeliveryHtml(taskId, m)}` +
    `</div>`
  );
}

function transcriptHtml(taskId: string, messages: ReviewSessionMessage[]): string {
  if (messages.length === 0) {
    return '<p class="rs-empty">No messages in this archived session.</p>';
  }
  const sorted = [...messages].sort((a, b) => a.created_at - b.created_at);
  return `<div class="rs-transcript" id="rs-transcript">${sorted.map((m) => messageHtml(taskId, m)).join('')}</div>`;
}

function statusLineHtml(status: ReviewSessionStatus): string {
  const thinking = status === 'turn_in_flight';
  return (
    `<p class="rs-status${thinking ? ' rs-status-active' : ''}" id="rs-status"` +
    `${thinking ? '' : ' hidden'}>${thinking ? 'thinking…' : ''}</p>`
  );
}

/** JSON shape for a stored transcript — archive read, not a live poll loop. */
export function reviewSessionPollJson(
  session: ReviewSession | null,
  messages: ReviewSessionMessage[],
) {
  const sorted = [...messages].sort((a, b) => a.created_at - b.created_at);
  return {
    status: session?.status ?? 'idle',
    turn_in_flight: session?.status === 'turn_in_flight',
    messages: sorted.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      content_html: m.role === 'assistant' || m.role === 'system'
        ? renderMarkdown(m.content)
        : escapeHtml(m.content),
      created_at: m.created_at,
      delivery: m.delivery,
      is_preamble: m.role === 'human' && isReviewSessionPreambleMessage(m.content),
    })),
  };
}

export function reviewSessionPageHtml(
  task: Task,
  session: ReviewSession | null,
  messages: ReviewSessionMessage[],
  notice?: { text: string; error?: boolean },
): string {
  const label = task.code ?? task.id.substring(0, 8);
  const noticeHtml = notice
    ? `<div class="rv-notice${notice.error ? ' rv-notice-err' : ''}">${escapeHtml(notice.text)}</div>`
    : '';

  const body = `
    <h1>Builder review session (archived) — ${escapeHtml(label)}</h1>
    <p>${escapeHtml(task.goal)}</p>
    <p class="rs-hint">${escapeHtml(REVIEW_WITH_BUILDER_GONE_MESSAGE)}</p>
    <p><a href="${taskPath(task)}/review">← back to Current review</a> · <a href="${taskPath(task)}">task detail</a></p>
    ${noticeHtml}
    <div id="rs-root">
      ${statusLineHtml(session?.status ?? 'idle')}
      ${transcriptHtml(task.id, messages)}
    </div>
  `;

  return layoutHtml(`Review session ${label}`, body);
}
