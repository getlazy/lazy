/**
 * The task page's Chat tab: the person's words and the agent's answers.
 *
 * WHAT IS CHAT CONTENT IS NOT DECIDED HERE. The messages come from
 * `buildChat` (src/task/chat.ts), the same projection `show` sends to Lazy
 * Teams as `chat`; this module only renders them. No template stripping, no
 * turn picking.
 *
 * Sending a message is an ask about the task as a whole, posted exactly as
 * Current review's Ask posts one (`/tasks/:id/review/ask`): a read-only turn in
 * the task agent's own session, which changes nothing and starts no work. The
 * box offers no "send as feedback" button on purpose — feedback that makes the
 * agent act goes through Current review, where every queued comment rides the
 * same Unblock.
 */

import type { ChatMessage } from '../task/chat';
import { escapeHtml } from './escape';
import { renderMarkdown, type RenderMarkdownOptions } from './markdown';

export interface ChatTabInput {
  /** Task URL segment, already escaped for a path. */
  taskId: string;
  messages: ChatMessage[];
  /** True while the task is over: answers then come from its stored record. */
  ended: boolean;
  markdown?: RenderMarkdownOptions;
}

function whenHtml(at: number): string {
  const iso = new Date(at).toISOString();
  return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}">${escapeHtml(iso.replace('T', ' ').slice(0, 16))} UTC</time>`;
}

function messageHtml(m: ChatMessage, markdown?: RenderMarkdownOptions): string {
  const id = `chat-${escapeHtml(m.id.replace(':', '-'))}`;
  if (m.from === 'person') {
    const who = m.asked_by === 'builder' ? 'Builder'
      : m.asked_by === 'agent' ? 'An agent'
      : m.actor_name ?? m.actor_email ?? 'You';
    const about = m.about ? ` <span class="lz-chat-about">${escapeHtml(m.about)}</span>` : '';
    const state = m.state === 'pending'
      ? '<p class="lz-chat-state" data-chat-pending>Waiting for the agent’s answer…</p>'
      : m.state === 'queued'
        ? '<p class="lz-chat-state" data-chat-queued>Waiting for the agent to finish its turn — sent as soon as it does.</p>'
      : m.state === 'failed'
        ? `<p class="lz-chat-state lz-chat-failed">Not answered${m.error ? `: ${escapeHtml(m.error)}` : ''}</p>`
        : '';
    return `<div class="lz-chat-msg lz-chat-person" id="${id}">
      <div class="lz-chat-meta">${escapeHtml(who)} · ${whenHtml(m.at)}${about}</div>
      <div class="lz-chat-body">${escapeHtml(m.text)}</div>
      ${state}
    </div>`;
  }
  const record = m.from_record
    ? '<p class="lz-chat-state">Answered from what lazy stored about this task — its agent’s session could not be resumed.</p>'
    : '';
  return `<div class="lz-chat-msg lz-chat-agent" id="${id}">
    <div class="lz-chat-meta">Agent · ${whenHtml(m.at)}</div>
    <div class="lz-chat-body turn-content">${renderMarkdown(m.text, markdown)}</div>
    ${record}
  </div>`;
}

export function chatTabHtml(input: ChatTabInput): string {
  const list = input.messages.length
    ? input.messages.map((m) => messageHtml(m, input.markdown)).join('\n')
    : '<p class="lz-empty-tab">No messages yet. Ask the agent anything about this task — it answers from the same session that did the work.</p>';
  return `<div class="detail-section lz-chat" data-lz-chat>
    <h2>Chat</h2>
    <div class="lz-chat-log" data-lz-chat-log>${list}</div>
    <form class="lz-chat-form" method="post" action="/tasks/${escapeHtml(input.taskId)}/review/ask">
      <input type="hidden" name="return" value="chat">
      <label class="lz-chat-label" for="lz-chat-content">Message the agent</label>
      <textarea id="lz-chat-content" name="content" rows="3" required placeholder="Ask about the work — approach, scope, trade-offs…"></textarea>
      <div class="lz-chat-actions">
        <button type="submit" class="btn btn-primary">Send</button>
        <span class="rv-hint">Read-only: the agent answers in text and changes nothing${input.ended ? '' : ' — to have it act, send feedback from Current review'}.</span>
      </div>
    </form>
  </div>`;
}
