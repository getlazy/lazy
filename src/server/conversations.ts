/**
 * Builder conversations — the web half of `lazy conversations`.
 *
 * Past dialogues with this project's builder: a listing, keyword search across
 * their message bodies, and a paged read of one conversation's transcript. This
 * is the daemon web UI's counterpart to the pages Lazy Teams already serves at
 * project scope (`BuilderConversationsController`), so the two surfaces describe
 * the same records the same way.
 *
 * ONE VOCABULARY: every derived value on these pages comes from the modules the
 * CLI already reads — `searchConversations`/`conversationSearchRegex`
 * (src/conversation/search.ts) for the excerpt window and per-conversation match
 * cap, `formatConversationTimestamp`/`elideConversationSummary`
 * (src/conversation/list.ts) for the table cells. Nothing here re-derives a
 * timestamp format or an excerpt window, so `lazy conversations list`, the MCP
 * search tool, Teams and this page can never disagree about the same record.
 *
 * ONE MUTATION, and it does not write here: promoting part of a transcript into
 * a backlog task. The conversation record itself is still never written — the
 * promotion creates a TASK and the link back lives on that task (see
 * src/conversation/promote.ts). Everything else on this surface is a read.
 *
 * NO-JS BY CONSTRUCTION: search is a GET form, paging is a pair of links, and
 * selecting the message range to promote is two more links plus a plain POST
 * form — the whole surface works with scripting off, same posture as the inbox.
 */

import type { ConversationSummary, StoredConversation, StoredMessage } from '../storage/types';
import {
  searchConversations,
  type ConversationSearchHit,
} from '../conversation/search';
import {
  formatConversationTimestamp,
  elideConversationSummary,
} from '../conversation/list';
import {
  formatMessageRange,
  rangesOverlap,
  type ConversationPromotion,
  type MessageRange,
} from '../conversation/promote';
import { layoutHtml } from './templates';
import { escapeHtml } from './review-diff';
import { taskPath } from './task-urls';
import { renderMarkdown } from './markdown';

/**
 * Messages rendered per transcript page.
 *
 * A builder conversation runs to hundreds of messages and each one is
 * markdown-rendered, so the whole transcript in one response is both a slow
 * render and an unreadable page. 40 matches what Teams pages at, so the same
 * conversation breaks in the same places on both surfaces.
 */
export const MESSAGES_PER_PAGE = 40;

/** How a conversation is titled wherever it is listed or headed. */
function conversationTitle(conv: Pick<ConversationSummary, 'summary'>): string {
  const collapsed = conv.summary.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '(no summary)';
  return elideConversationSummary(collapsed, 120);
}

/** First eight characters of the session UUID — what every lazy surface shows. */
function shortSessionId(sessionId: string): string {
  return sessionId.substring(0, 8);
}

/**
 * Role labels, in the human's terms rather than the transcript's.
 *
 * The stored roles are `user`/`assistant`; on this page the user IS the human
 * reading it and the assistant IS the builder, so those are the words used —
 * the same substitution Teams' ConversationMessagePresenter makes.
 */
const ROLE_LABELS: Record<string, string> = { user: 'You', assistant: 'Builder' };
const ROLE_TONES: Record<string, string> = { user: 'tag-accent', assistant: 'tag-neutral' };

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role ?? 'message';
}

function roleBadge(role: string): string {
  const tone = ROLE_TONES[role] ?? 'tag-neutral';
  return `<span class="tag ${tone} conv-role conv-role-${escapeHtml(role)}">${escapeHtml(roleLabel(role))}</span>`;
}

/** "12 from you · 34 from builder" — the shape of a conversation at a glance. */
function turnCounts(conv: Pick<ConversationSummary, 'stats'>): string {
  return `${conv.stats.userMessageCount} from you · ${conv.stats.assistantMessageCount} from builder`;
}

/** The search box. A GET form so a search is a linkable URL and needs no JS. */
function searchFormHtml(query: string): string {
  return `<form class="conv-search" method="get" action="/conversations">
    <input class="input" type="text" name="q" value="${escapeHtml(query)}"
           placeholder="Keyword or pattern" aria-label="Search conversations">
    <button class="btn btn-sm btn-primary" type="submit">Search</button>
    ${query ? '<a class="btn btn-sm" href="/conversations">Clear</a>' : ''}
  </form>`;
}

function errorBannerHtml(text: string): string {
  return `<div class="msg-notice msg-notice-error" id="conversations-error">${escapeHtml(text)}</div>`;
}

const INTRO =
  'Past dialogues with this project&rsquo;s builder, captured as they happen. ' +
  'Open one to read it in full; search finds matching passages across all of them.';

/**
 * The listing: newest first, metadata only.
 *
 * Columns mirror `lazy conversations list` — session, started, ended, turn
 * counts, summary — because the two listings are the same listing, and a human
 * moving between the terminal and the browser should not have to re-learn it.
 */
export function conversationsIndexHtml(conversations: ConversationSummary[]): string {
  const body = conversations.length === 0
    ? `<div class="empty-state">No builder conversations yet. Dialogues with the builder appear here once they are captured.</div>`
    : `<p class="text-muted">${conversations.length} conversation${conversations.length === 1 ? '' : 's'}.</p>
       <table class="table conv-table">
         <thead><tr><th>Session</th><th>Started</th><th>Ended</th><th>Turns</th><th>Summary</th></tr></thead>
         <tbody>${conversations.map(conversationRowHtml).join('\n')}</tbody>
       </table>`;

  return layoutHtml('Builder conversations', `
    <h1>Builder conversations</h1>
    <p class="text-muted conv-intro">${INTRO}</p>
    ${searchFormHtml('')}
    ${body}
  `);
}

function conversationRowHtml(conv: ConversationSummary): string {
  const href = `/conversations/${escapeHtml(encodeURIComponent(conv.sessionId))}`;
  return `<tr class="conv-row">
    <td class="conv-id"><a href="${href}">${escapeHtml(shortSessionId(conv.sessionId))}</a></td>
    <td>${escapeHtml(formatConversationTimestamp(conv.startedAt))}</td>
    <td>${escapeHtml(formatConversationTimestamp(conv.endedAt))}</td>
    <td class="conv-turns">${conv.stats.userMessageCount}h/${conv.stats.assistantMessageCount}a</td>
    <td class="wrap conv-summary"><a href="${href}">${escapeHtml(conversationTitle(conv))}</a></td>
  </tr>`;
}

/**
 * Search results: the matching conversations, each with its own excerpts.
 *
 * Both caps are the shared module's (10 conversations, 5 excerpts each), and
 * the page says so — a result list that silently stops at ten looks like an
 * answer when it is a page.
 */
export function conversationsSearchHtml(
  query: string,
  hits: ConversationSearchHit[],
  byId: Map<string, StoredConversation>,
  error?: string,
): string {
  let results: string;
  if (error) {
    results = '';
  } else if (hits.length === 0) {
    results = `<div class="empty-state">No conversation mentions &ldquo;${escapeHtml(query)}&rdquo;. Try a different keyword, or clear the search to see the full list.</div>`;
  } else {
    results = `<p class="text-muted" id="conversations-search-summary">${hits.length} conversation${hits.length === 1 ? '' : 's'} matched &ldquo;${escapeHtml(query)}&rdquo; (at most 10 conversations, 5 passages each).</p>
      <div class="conv-hits" id="conversations-search-hits">${hits.map((hit) => hitHtml(hit, byId.get(hit.sessionId))).join('\n')}</div>`;
  }

  return layoutHtml(`Search: ${query}`, `
    <div class="breadcrumb"><a href="/conversations">Builder conversations</a> &rsaquo; Search</div>
    <h1>Builder conversations</h1>
    ${searchFormHtml(query)}
    ${error ? errorBannerHtml(error) : ''}
    ${results}
  `);
}

function hitHtml(hit: ConversationSearchHit, conv: StoredConversation | undefined): string {
  const href = `/conversations/${escapeHtml(encodeURIComponent(hit.sessionId))}`;
  const title = conv ? conversationTitle(conv) : elideConversationSummary(hit.summary, 120);
  const meta = [
    shortSessionId(hit.sessionId),
    formatConversationTimestamp(hit.startedAt),
    `${hit.matches.length} passage${hit.matches.length === 1 ? '' : 's'}`,
  ].join(' · ');

  const excerpts = hit.matches.map((m) =>
    `<div class="conv-excerpt"><span class="conv-excerpt-role">${escapeHtml(roleLabel(m.role))}</span><span class="conv-excerpt-text">${escapeHtml(m.excerpt)}</span></div>`
  ).join('\n');

  return `<div class="conv-hit">
    <div class="conv-hit-title"><a href="${href}">${escapeHtml(title)}</a></div>
    <div class="conv-hit-meta">${escapeHtml(meta)}</div>
    ${excerpts}
  </div>`;
}

/** What the detail page knows about promoting part of this transcript. */
export interface ConversationPromoteView {
  /** The range the human has picked with the Start/End links, if any. */
  selection: MessageRange | null;
  /** Seed text for the form — computed server-side so the page and the created task agree. */
  seed: { goal: string; code: string; prompt: string } | null;
  /** Tasks already promoted out of this conversation. */
  promotions: ConversationPromotion[];
  /** A task just created, for the success banner. `id` is the task's URL
   *  segment (code when unique, id otherwise) — the promote redirect passes it
   *  through the query so the banner's link reads like every other task URL. */
  created?: { id: string; label: string } | null;
  /** A refusal from the last attempt, shown above the form. */
  error?: string | null;
  /** Codes shared by more than one task — promotion links fall back to the id. */
  duplicatedCodes?: ReadonlySet<string>;
}

/**
 * One conversation, one page of its transcript.
 *
 * `offset` is the caller's (already clamped to the transcript); this renderer
 * shows the slice it is handed and derives the Earlier/Later links from it.
 */
export function conversationDetailHtml(
  conv: StoredConversation,
  messages: StoredMessage[],
  offset: number,
  promote?: ConversationPromoteView,
  duplicatedCodes?: ReadonlySet<string>,
): string {
  const total = conv.messages.length;
  const title = conversationTitle(conv);
  const idHtml = escapeHtml(encodeURIComponent(conv.sessionId));

  const metaRows: Array<[string, string]> = [
    ['Session', shortSessionId(conv.sessionId)],
    ['Started', formatConversationTimestamp(conv.startedAt)],
    ['Ended', formatConversationTimestamp(conv.endedAt)],
    ['Messages', `${total} total · ${turnCounts(conv)}`],
  ];
  if (conv.gitBranch) metaRows.push(['Branch', conv.gitBranch]);

  const meta = `<dl class="conv-meta">${metaRows.map(
    ([term, value]) => `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`
  ).join('')}</dl>`;

  const pageNote = total > MESSAGES_PER_PAGE
    ? `<p class="text-muted" id="conversation-page-meta">Showing ${offset + 1}&ndash;${offset + messages.length} of ${total}.</p>`
    : '';

  const selection = promote?.selection ?? null;
  const body = total === 0
    ? `<div class="empty-state">Nothing was captured for this conversation.</div>`
    : `${pageNote}
       <div class="conv-messages" id="conversation-messages">${messages.map(
         (msg, i) => messageHtml(msg, offset + i + 1, idHtml, offset, selection),
       ).join('\n')}</div>
       ${paginationHtml(idHtml, offset, messages.length, total)}`;

  return layoutHtml(title, `
    <div class="breadcrumb"><a href="/conversations">Builder conversations</a> &rsaquo; Conversation</div>
    <h1>${escapeHtml(title)}</h1>
    ${meta}
    ${promote ? promoteSectionHtml(conv, idHtml, offset, promote, duplicatedCodes) : ''}
    ${body}
  `);
}

/**
 * The Promote panel: what has already been promoted out of this conversation,
 * and the form for promoting the currently selected range.
 *
 * Rendered ABOVE the transcript so the "already promoted" list is the first
 * thing a second promoter sees — the whole point of the durable link is that
 * the same passage is not turned into a task twice without anybody noticing.
 */
function promoteSectionHtml(
  conv: StoredConversation,
  idHtml: string,
  offset: number,
  view: ConversationPromoteView,
  duplicatedCodes?: ReadonlySet<string>,
): string {
  const parts: string[] = [];

  if (view.created) {
    parts.push(
      `<div class="msg-notice" id="conversation-promoted">Created backlog task ` +
      `<a href="/tasks/${escapeHtml(view.created.id)}">${escapeHtml(view.created.label)}</a>. ` +
      `It is not started — start it when you want the work to begin.</div>`,
    );
  }
  if (view.error) parts.push(errorBannerHtml(view.error));

  if (view.promotions.length > 0) {
    const items = view.promotions.map((p) => {
      const label = p.task.code ?? p.task.id.slice(0, 8);
      return `<li>Message${p.range.from === p.range.to ? '' : 's'} ${escapeHtml(formatMessageRange(p.range))} ` +
        `&rarr; <a href="${escapeHtml(taskPath(p.task, duplicatedCodes))}">${escapeHtml(label)}</a> ` +
        `<span class="text-muted">(${escapeHtml(p.task.status)})</span></li>`;
    }).join('');
    parts.push(`<div class="conv-promotions" id="conversation-promotions">
      <h2>Already promoted</h2>
      <ul>${items}</ul>
    </div>`);
  }

  parts.push(promoteFormHtml(conv, idHtml, offset, view, duplicatedCodes));
  return `<section class="conv-promote">${parts.join('\n')}</section>`;
}

/**
 * The form itself, or the instruction to pick a range.
 *
 * The seed is computed server-side (src/conversation/promote.ts) and shown in
 * editable fields: WHAT a promoted task says is a rule, and a browser must not
 * hold a second opinion about it. Nothing is created until this is submitted,
 * so every default here is still the human's to change.
 */
function promoteFormHtml(
  conv: StoredConversation,
  idHtml: string,
  offset: number,
  view: ConversationPromoteView,
  duplicatedCodes?: ReadonlySet<string>,
): string {
  const selection = view.selection;
  if (!selection || !view.seed) {
    return `<details class="conv-promote-form" id="conversation-promote">
      <summary>Promote part of this conversation into a task</summary>
      <p class="text-muted">Pick the exchange the task should come from: use
      <strong>Start here</strong> on its first message and <strong>End here</strong> on its last.
      The whole transcript is almost never the brief.</p>
    </details>`;
  }

  const total = conv.messages.length;
  const overlapping = view.promotions.filter((p) => rangesOverlap(p.range, selection));
  const overlapNote = overlapping.length === 0 ? '' :
    `<p class="msg-notice msg-notice-warning" id="conversation-promote-overlap">These messages overlap ` +
    `${overlapping.map((p) => {
      const label = p.task.code ?? p.task.id.slice(0, 8);
      return `<a href="${escapeHtml(taskPath(p.task, duplicatedCodes))}">${escapeHtml(label)}</a> (${escapeHtml(formatMessageRange(p.range))})`;
    }).join(', ')} — promote again only if this is a different piece of work.</p>`;

  return `<details class="conv-promote-form" id="conversation-promote" open>
    <summary>Promote messages ${escapeHtml(formatMessageRange(selection))} of ${total} into a task</summary>
    ${overlapNote}
    <form method="post" action="/conversations/${idHtml}/promote">
      <input type="hidden" name="from" value="${selection.from}">
      <input type="hidden" name="to" value="${selection.to}">
      <input type="hidden" name="offset" value="${offset}">
      <label>Goal
        <input class="input" type="text" name="goal" value="${escapeHtml(view.seed.goal)}" required>
      </label>
      <label>Code
        <input class="input" type="text" name="code" value="${escapeHtml(view.seed.code)}"
               placeholder="kebab-case-code">
      </label>
      <label>Parent task
        <input class="input" type="text" name="parent" value=""
               placeholder="task id or code — leave empty for a top-level task">
      </label>
      <label>Prompt
        <textarea class="input" name="prompt" rows="14">${escapeHtml(view.seed.prompt)}</textarea>
      </label>
      <div class="conv-promote-actions">
        <button class="btn btn-sm btn-primary" type="submit">Create backlog task</button>
        <a class="btn btn-sm" href="/conversations/${idHtml}?offset=${offset}">Clear selection</a>
      </div>
    </form>
  </details>`;
}

/**
 * A message body is builder or human prose, so it is rendered as markdown —
 * the same treatment turn content and system-message bodies get. An empty
 * message says so rather than rendering as a blank card: capture stores
 * tool-only assistant turns with no text, and a silent gap in a transcript
 * reads like data loss.
 */
function messageHtml(
  msg: StoredMessage,
  number: number,
  idHtml: string,
  offset: number,
  selection: MessageRange | null,
): string {
  const stamp = msg.timestamp ? formatConversationTimestamp(msg.timestamp) : '';
  const model = msg.model ? `<span class="conv-model">${escapeHtml(msg.model)}</span>` : '';
  const content = msg.text.trim()
    ? `<div class="turn-content">${renderMarkdown(msg.text)}</div>`
    : `<div class="conv-empty-message">This message recorded no text.</div>`;

  const selected = selection && number >= selection.from && number <= selection.to;
  const classes = `conv-message conv-message-${escapeHtml(msg.role)}${selected ? ' conv-message-selected' : ''}`;

  return `<article class="${classes}" id="m${number}">
    <div class="conv-message-head">
      <span><span class="conv-number">#${number}</span>${roleBadge(msg.role)}${model}</span>
      <span class="conv-time">${escapeHtml(stamp)}</span>
      <span class="conv-select">${selectionLinksHtml(idHtml, offset, number, selection)}</span>
    </div>
    ${content}
  </article>`;
}

/**
 * "Start here" / "End here" — range selection with scripting off.
 *
 * A bound that would invert the range carries the other one with it (starting
 * after the current end moves the end too), so no click can produce a range the
 * server then has to refuse. The page offset rides along, and the anchor keeps
 * the browser where the human clicked instead of jumping to the top.
 */
function selectionLinksHtml(
  idHtml: string,
  offset: number,
  number: number,
  selection: MessageRange | null,
): string {
  const href = (from: number, to: number) =>
    `/conversations/${idHtml}?offset=${offset}&amp;from=${from}&amp;to=${to}#m${number}`;
  const start = href(number, selection && selection.to > number ? selection.to : number);
  const end = href(selection && selection.from < number ? selection.from : number, number);
  return `<a class="conv-select-link" href="${start}">Start here</a>` +
    `<a class="conv-select-link" href="${end}">End here</a>`;
}

function paginationHtml(idHtml: string, offset: number, shown: number, total: number): string {
  const links: string[] = [];
  if (offset > 0) {
    const earlier = Math.max(0, offset - MESSAGES_PER_PAGE);
    links.push(`<a class="btn btn-sm" href="/conversations/${idHtml}?offset=${earlier}">&laquo; Earlier</a>`);
  }
  if (offset + shown < total) {
    links.push(`<a class="btn btn-sm" href="/conversations/${idHtml}?offset=${offset + shown}">Later &raquo;</a>`);
  }
  if (links.length === 0) return '';
  return `<div class="action-links conv-pagination" id="conversation-pagination">${links.join('')}</div>`;
}

export function resolveConversationSessionId(
  conversations: Array<{ sessionId: string }>,
  sessionId: string,
): string | null {
  const exact = conversations.find((c) => c.sessionId === sessionId);
  if (exact) return exact.sessionId;
  const matches = conversations.filter((c) => c.sessionId.startsWith(sessionId));
  return matches.length === 1 ? matches[0].sessionId : null;
}

/**
 * Resolve a conversation by full session id, or by a unique prefix of one.
 *
 * The listing shows eight characters, so a human copying an id off this page —
 * or off `lazy conversations list` — has a prefix, not a UUID. An ambiguous
 * prefix resolves to nothing rather than to a guess. Same convenience the MCP
 * read tool offers, and the same refusal.
 */
export function findConversation(
  conversations: StoredConversation[],
  sessionId: string,
): StoredConversation | null {
  const id = resolveConversationSessionId(conversations, sessionId);
  if (!id) return null;
  return conversations.find((c) => c.sessionId === id) ?? null;
}

/** Run the shared search, mapping an unusable pattern to a message for the page. */
export async function runConversationSearch(
  conversations: StoredConversation[],
  query: string,
): Promise<{ hits: ConversationSearchHit[]; error?: string }> {
  try {
    return { hits: await searchConversations(conversations, query) };
  } catch (err) {
    // conversationSearchRegex throws for a pattern the engine rejects, and
    // the Worker deadline throws the same `Invalid search pattern` shape
    // when matching takes too long. Both are the human's query, not a
    // server fault: the page says so and keeps the box filled in rather
    // than 500-ing.
    return { hits: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** The listing as JSON: metadata only, never transcripts. */
export function conversationsApiPayload(conversations: ConversationSummary[]) {
  return {
    total: conversations.length,
    conversations: conversations.map((c) => ({
      session_id: c.sessionId,
      short_id: shortSessionId(c.sessionId),
      title: conversationTitle(c),
      started_at: c.startedAt,
      ended_at: c.endedAt,
      git_branch: c.gitBranch,
      message_count: c.stats.messageCount,
      user_message_count: c.stats.userMessageCount,
      assistant_message_count: c.stats.assistantMessageCount,
    })),
  };
}
