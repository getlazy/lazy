/**
 * HTML templates for the lazy server
 *
 * Server-rendered HTML with inline CSS. No frontend build step needed.
 */

import { REVIEW_GATE_INPUTS, REVIEW_MODE_INPUTS, REVIEW_TOGGLE_INPUTS } from '../review/mode';
import type { Task, Session, Turn, Commit, Comment, JournalEntry, RaisedItem, SearchResult, TaskPromptVersion } from '../storage';
import { escapeHtml, scriptJson } from './escape';
import type { SystemMessage, TokenUsage } from '../types';
import { isTerminalStatus } from '../types';
import { shortMessageId, SYSTEM_MESSAGE_KIND_MEANING } from '../messages';
import { renderMarkdown, type RenderMarkdownOptions } from './markdown';
import { raisedDisplayBody } from '../raised/content';
import { raisedDecisionBadgeHtml, raisedGateBadgeHtml } from './raised-badges';
import { attributionLabel } from '../actor-ref';
import {
  parseUnifiedDiff,
  renderReviewDiff,
  diffViewOptionsHtml,
  diffViewScript,
} from './review-diff';
import { viewedCardHtml, viewedStateScript } from './viewed-cards';
import { timestampHtml, relativeTimeScript } from './timestamps';
import { reviewNavControlsHtml, reviewNavigationScript } from './review-navigation';
import {
  servicesCardHtml,
  toProbedState,
  type ProbedServeState,
  type ServicesCardControls,
} from './services-card';
import { serveNoticeHtml, type ServeNotice } from './serve-notice';
import {
  dashboardAuthority,
  displayUrlFor,
  serviceSubdomainUrl,
  taskHostLabel,
} from '../serve/subdomain';
import { STYLESHEET_PATH } from './styles';
import { duplicateTaskCodes, taskPath, taskPathSegment } from './task-urls';
import { docsUrl } from '../docs/links';
import { GRAMMAR_SECTIONS, GRAMMAR_NOTES, GRAMMAR_EXAMPLES } from '../search/grammar';
import { sortHeadersHtml, type SortColumn, type SortDirection } from './sort';
import { mermaidEnhanceScript } from './mermaid';
import { parentTaskIdOf } from '../task-target';
import type { TaskEditability } from '../task-edit-rules';
import { deriveCode } from '../task/identity';
import type { TaskCreateDraft } from './task-create-form';
import type { TaskReparentTargets } from './task-actions';
import { actionDialogChromeHtml, actionDialogScript } from './action-dialog';
import { MODIFIER_KEY_FALLBACK, modifierKeyScript } from './modifier-key';
import {
  commandPaletteChromeHtml,
  commandPaletteScript,
  searchResultHref,
} from './command-palette';
import { foldRecordIntoChunks, type FoldedItem, type TurnFoldExtras } from './turn-fold';
import { isChunkBoundary, type TurnChunk } from '../utils/turn-chunks';
import { attributeCommitsToTurns, isAgentWorkTurn } from './turn-commits';
import { turnText } from '../utils/turn-content';
import { formatTurnLaunchLabels, formatTurnModelWarning, formatTurnTypeSuffix, turnRanNoAgent, NO_LAUNCH_LABEL } from '../utils/turn-labels';
import { formatUnparsedReviewSuffix } from '../review/parse-report';
import {
  protectionMarkers,
  protectionHeadline,
  protectionSummary,
  protectionAdvice,
  PROTECTION_MARKER_LEGEND,
  type TaskProtectionStatus,
} from '../protection/status';
import type { TaskServeState } from '../serve/discovery';
import { shellPanelHtml, shellClientScript, type ShellAvailability } from './shell-ui';
import { watchPanelHtml, watchClientScript } from './watch-ui';
import { reviewActivityCardHtml, type ReviewActivity } from './review-activity';
import { unmeasured, type RenderTimings } from './render-timings';
import { availableTaskVerbs, type TaskLifecycleVerb } from './task-verbs';
import { stoppableClaimOf } from '../daemon/in-flight-turn';
import { actionDialogButtonHtml, actionDialogTemplateHtml } from './action-dialog';
import { resolveTaskForgeLink, taskForgeIconHtml } from '../task-forge-link';
import { isLinkedTask, formatLinkedMarker } from '../task/linked';
import type { TaskLinkDraft } from './task-link-form';
import { reviewReportHtml } from './review-findings';

function linkedBadgeHtml(task: Task): string {
  const marker = formatLinkedMarker(task);
  return marker ? `<span class="lz-linked">${escapeHtml(marker)}</span> ` : '';
}

/** Narrow first column: forge icon when the task has a PR/MR, empty otherwise. */
function forgeColumnHeader(): string {
  return `<th class="lz-forge-col" title="Pull or merge request"></th>`;
}

function forgeColumnCell(task: Task): string {
  const forge = resolveTaskForgeLink(task);
  return `<td class="lz-forge-col">${forge ? taskForgeIconHtml(forge) : ''}</td>`;
}

export interface TaskWithSession {
  task: Task;
  session: Session | null;
  turnCount?: number;
  /**
   * Read-only protection status, present only when the project protects
   * something. Computed by src/protection/status.ts — the dashboard renders
   * the shared vocabulary rather than re-deriving gates from config.
   */
  protection?: TaskProtectionStatus;
}

/**
 * The protection badge for a table row: the shared `[P]` marker, with the
 * shared phrasing as the tooltip. Empty string when nothing is gated.
 */
function protectionBadge(protection: TaskProtectionStatus | null | undefined): string {
  if (!protection) return '';
  const markers = protectionMarkers(protection);
  if (!markers) return '';
  const title = protectionHeadline(protection) ?? '';
  return `<span class="protection-badge" title="${escapeHtml(title)}">${escapeHtml(markers)}</span> `;
}

function shortId(id: string): string {
  return id.substring(0, 8);
}

export function displayId(task: Task): string {
  return task.code ?? shortId(task.id);
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    return `${seconds}s`;
  }
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function totalInputTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
}

function formatTokenUsage(usage: TokenUsage | null): string {
  if (!usage) return '-';
  return `${formatTokenCount(totalInputTokens(usage))} in / ${formatTokenCount(usage.outputTokens)} out`;
}

/**
 * A status pill, in the design system's tag vocabulary.
 *
 * The tones are the ones lazy-teams uses for the same statuses, so the two
 * surfaces agree on what "blocked" looks like: accent for in-flight, warning
 * for anything waiting on the human, success for a good ending, danger for a
 * bad one, neutral for a session that merely stopped.
 */
export function statusBadge(status: string): string {
  const tones: Record<string, string> = {
    working: 'tag-accent',
    blocked: 'tag-warning',
    conflict: 'tag-warning',
    interrupted: 'tag-violet',
    complete: 'tag-success',
    abandoned: 'tag-danger',
    accepted: 'tag-success',
    rejected: 'tag-danger',
    ended: 'tag-neutral',
    // Waiting on a forge PR — indigo so it is not the same warning tone as blocked.
    submitted: 'tag-indigo',
  };
  const tone = tones[status] ?? 'tag-neutral';
  return `<span class="tag ${tone}">${escapeHtml(status)}</span>`;
}

/**
 * One row of the dashboard's Active States rail: a count under an uppercase
 * label, with the state's own colour on the left edge. Rendered only when the
 * count is non-zero — the rail lists what IS happening, not every state that
 * could.
 */
function stateRow(state: keyof ActiveStates, label: string, count: number): string {
  if (count <= 0) return '';
  return `<div class="state-row state-${state}">
    <div class="state-row-label">${escapeHtml(label)}</div>
    <div class="state-row-value">${count}</div>
  </div>`;
}

export function getTaskStatus(task: Task, session: Session | null): string {
  if (session) {
    return session.outcome ?? (session.ended_at ? 'ended' : task.status);
  }
  return task.status;
}

/**
 * Where the browser remembers the newest conversation it has been shown.
 *
 * Per-browser on purpose: "since you last looked" is a property of a person at
 * a screen, not of the project, and the store has no read state for
 * conversations to put it in. Exported so the e2e suite asserts the same key
 * the script writes.
 */
export const CONVERSATIONS_SEEN_KEY = 'lazy.conversationsSeenAt';

/**
 * The nav's count badges, filled in from `/api/nav-counts`.
 *
 * A count in the nav is the only thing that makes a filed alert, a task waiting
 * for review, or an untriaged follow-up discoverable without navigating there on
 * purpose, and it has to be on EVERY page — threading four counts through every
 * handler and template to get there would touch every page for numbers none of
 * them otherwise care about, so the badges ask for them themselves. ONE fetch
 * fills all four: four endpoints would mean four requests per page load for four
 * numbers in the chrome. The endpoint answers with counts only — no message
 * bodies, no queue rows, no transcripts.
 *
 * The no-script path is not this: every page these badges point at is
 * server-rendered and reachable from the same nav, and the dashboard carries its
 * own unread panel. So a browser with scripting off loses the badges, not the
 * signal — which is why a failed fetch here is left silent (an error banner in
 * the nav of every page would be worse than a missing number).
 *
 * The conversations mark is written HERE rather than by the conversations page,
 * for two reasons: this is the only script the dashboard loads on every page, so
 * a mark written here cannot drift from the count that reads it; and
 * ./conversations.ts stays no-JS by construction. Visiting the LISTING is what
 * counts as looking — the search view is a filtered subset, so it never marks
 * conversations it did not show.
 */
function navBadgeScript(): string {
  return `<script>
    (function() {
      var badges = {
        unread: document.getElementById('nav-unread'),
        review: document.getElementById('nav-review'),
        clusters: document.getElementById('nav-clusters'),
        conversations: document.getElementById('nav-conversations')
      };
      var raised = document.getElementById('nav-raised');
      var key = ${scriptJson(CONVERSATIONS_SEEN_KEY)};
      var seen = null;
      try {
        seen = window.localStorage.getItem(key);
      } catch (e) { /* storage blocked: no mark, so every conversation reads as new */ }
      var since = seen && /^[0-9]+$/.test(seen) ? seen : '';
      var onListing = window.location.pathname === '/conversations'
        && !new URLSearchParams(window.location.search).get('q');
      fetch('/api/nav-counts' + (since ? '?conversationsSince=' + since : ''))
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(d) {
          if (!d) return;
          for (var name in badges) {
            if (badges[name] && d[name] > 0) badges[name].textContent = String(d[name]);
          }
          // Raised items are ONE badge carrying TWO numbers, blocking first:
          // "2/11" reads as two facts about one destination, where two badges
          // on one link would read as two destinations. A zero blocking count
          // is left out entirely — "0/11" spends a number saying nothing.
          if (raised) {
            var b = d.raisedBlocking > 0 ? d.raisedBlocking : 0;
            var n = d.raisedNonBlocking > 0 ? d.raisedNonBlocking : 0;
            if (b > 0) {
              raised.textContent = b + '/' + n;
              raised.title = b + ' open blocking, ' + n + ' open non-blocking';
              raised.className = 'nav-badge nav-badge-blocking';
            } else if (n > 0) {
              raised.textContent = String(n);
              raised.title = n + ' open non-blocking raised item(s)';
            }
          }
          if (!onListing) return;
          // Reading the listing IS seeing what it lists, so the badge clears
          // here rather than on the next page load — the same rule the inbox
          // follows when it renders a message body.
          if (badges.conversations) badges.conversations.textContent = '';
          if (d.conversationsLatestAt > 0) {
            try {
              window.localStorage.setItem(key, String(d.conversationsLatestAt));
            } catch (e) { /* nothing to remember it with; the count stays honest at "all" */ }
          }
        })
        .catch(function() { /* no badges; every page they point at still works */ });
    })();
  </script>`;
}

/**
 * `window.lzOnce(key, fn)` — a page-lifetime once-guard, defined as the very
 * first thing in <body>, before any other markup or script on the page.
 *
 * A tab-local island (one whose <script> ships inside a tab fragment) is
 * re-run every time its body is freshly fetched — first load, and every
 * `data-lz-stale` refetch after (task-tabs.ts's activateScripts). Its own
 * elements and closures over them are fresh every run, which is fine; but a
 * `document`/`window`-level registration is not scoped to the body at all,
 * so re-running it on every refetch would add one more permanent listener
 * each time. `lzOnce` is how such an island registers exactly once for the
 * whole page.
 *
 * This must be defined BEFORE the tab body that might call it, on every kind
 * of page that can contain such an island — not just emitted alongside
 * `taskTabSwitchScript()`, which sits in the task page's page-level
 * `scripts` block AFTER the tab body in render order. Inline classic
 * scripts run in parse order, so an island's `if (window.lzOnce)` guard on a
 * full page load of a body it ships inside would silently never fire were
 * this defined any later — and the commit detail page (templates.ts) emits
 * `diffViewScript` without `taskTabSwitchScript` at all.
 */
function lzOnceScriptHtml(): string {
  return `<script>
  window.lzOnce = window.lzOnce || (function () {
    var done = {};
    return function (key, fn) {
      if (done[key]) return;
      done[key] = true;
      fn();
    };
  })();
  </script>`;
}

/**
 * Everything up to and including the nav. Split out so a long-running POST
 * (memory compact) can stream this immediately, before the work finishes —
 * a full `layoutHtml` would hold the first byte until the LLM returned.
 */
export function layoutOpenHtml(title: string, options?: { headExtraHtml?: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - Lazy</title>${options?.headExtraHtml ? `\n  ${options.headExtraHtml}` : ''}
  <link rel="stylesheet" href="${STYLESHEET_PATH}">
</head>
<body>${lzOnceScriptHtml()}
  <div class="lz-nav-progress" hidden data-lz-nav-progress role="progressbar" aria-hidden="true" aria-label="Loading page"></div>
  <nav class="nav">
    <span class="nav-brand"><a href="/">lazy</a></span>
    <a href="/">Dashboard</a>
    <a href="/clusters">Clusters<span class="nav-badge" id="nav-clusters"></span></a>
    <a href="/tasks">Tasks</a>
    <a href="/review">Review<span class="nav-badge" id="nav-review"></span></a>
    <a href="/raised">Raised<span class="nav-badge" id="nav-raised"></span></a>
    <a href="/conversations">Conversations<span class="nav-badge" id="nav-conversations"></span></a>
    <a href="/scratch">Scratch</a>
    <a href="/settings">Settings</a>
    <form class="search-form" action="/search" method="get">
      <input class="input" type="text" name="q" placeholder="search… (${MODIFIER_KEY_FALLBACK})" title="Open the command palette with ${MODIFIER_KEY_FALLBACK}"
        data-lz-modkey-placeholder="search… (%s)" data-lz-modkey-title="Open the command palette with %s" />
    </form>
    <a href="/messages">Inbox<span class="nav-badge" id="nav-unread"></span></a>
  </nav>
`;
}

function navProgressScript(): string {
  // Server-rendered pages give no feedback between click and the next
  // document (or tab fragment). This bar is that feedback — not a
  // performance fix. Tab clicks mark the pressed tab pending as well.
  return `<script>
    (function () {
      var bar = null;
      function progressEl() {
        if (!bar) bar = document.querySelector('[data-lz-nav-progress]');
        return bar;
      }
      function clearPendingTabs() {
        var pending = document.querySelectorAll('.lz-tab-pending');
        for (var i = 0; i < pending.length; i++) {
          pending[i].classList.remove('lz-tab-pending');
          pending[i].removeAttribute('aria-busy');
        }
      }
      function start(tab) {
        document.documentElement.classList.add('lz-nav-pending');
        var b = progressEl();
        if (b) {
          b.hidden = false;
          b.setAttribute('aria-busy', 'true');
          b.setAttribute('aria-hidden', 'false');
        }
        clearPendingTabs();
        if (tab) {
          tab.classList.add('lz-tab-pending');
          tab.setAttribute('aria-busy', 'true');
        }
      }
      function stop() {
        document.documentElement.classList.remove('lz-nav-pending');
        var b = progressEl();
        if (b) {
          b.hidden = true;
          b.removeAttribute('aria-busy');
          b.setAttribute('aria-hidden', 'true');
        }
        clearPendingTabs();
      }
      window.lzNavProgress = { start: start, stop: stop };
      document.addEventListener('click', function (ev) {
        // Tab-strip clicks preventDefault and drive the in-place island,
        // which starts the bar itself. Skip those so we do not double-start
        // then immediately lose the pending mark when this handler races.
        if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        if (ev.button !== 0) return;
        var a = ev.target.closest ? ev.target.closest('a[href]') : null;
        if (!a) return;
        var href = a.getAttribute('href');
        if (!href || href.charAt(0) === '#' || href.indexOf('javascript:') === 0) return;
        if (a.getAttribute('target') === '_blank' || a.hasAttribute('download')) return;
        var url;
        try { url = new URL(href, location.origin); } catch (e) { return; }
        if (url.origin !== location.origin) return;
        if (url.pathname === location.pathname && url.search === location.search) return;
        start(a.hasAttribute('data-lz-tab') ? a : null);
      });
      document.addEventListener('submit', function (ev) {
        if (ev.defaultPrevented) return;
        var form = ev.target;
        if (!form || (form.method && String(form.method).toLowerCase() === 'dialog')) return;
        start(null);
      });
      window.addEventListener('pageshow', stop);
    })();
  </script>`;
}

/** Scripts and close tags. Compact streaming uses this after the result. */
export function layoutCloseHtml(options?: { mermaid?: boolean }): string {
  // Palette chrome is global — every page must be able to open Cmd/Ctrl+K
  // without a round trip. Same placement as the nav-badge script.
  // Relative times are rendered once, on the server, and these pages stay open
  // for hours — so every page frame carries the island that keeps them honest.
  // Global for the same reason the palette is: no page should have to remember.
  return `  ${commandPaletteChromeHtml()}
  ${navBadgeScript()}
  ${navProgressScript()}
  ${modifierKeyScript()}
  ${commandPaletteScript()}
  ${relativeTimeScript()}
  ${options?.mermaid ? mermaidEnhanceScript() : ''}
</body>
</html>`;
}

export function layoutHtml(title: string, content: string, options?: { headExtraHtml?: string }): string {
  // Unconditional, not gated on whether THIS render's content contains a
  // diagram: a diagram can arrive later than this render, in a tab fragment
  // an in-place switch brings in — exactly like verifyRunScript, this
  // script has to be on the page before the content that needs it exists.
  // Cheap when there is truly nothing to enhance (mermaidEnhanceScript's own
  // run() no-ops on zero blocks); the mermaid LIBRARY itself is still
  // lazy-loaded on demand, never here.
  return `${layoutOpenHtml(title, options)}${content}${layoutCloseHtml({ mermaid: true })}`;
}

/**
 * The task list's sortable columns, in render order — and, with `created`
 * (the default order, which has no column of its own), the complete set of
 * fields `?sort=` accepts on `/tasks`. One definition drives the headers and
 * the parser; see {@link parseSortParam}.
 */
export const TASK_LIST_COLUMNS = [
  { field: 'status', label: 'Status' },
  { field: 'agent', label: 'Agent' },
  { field: 'model', label: 'Model' },
  { field: 'turns', label: 'Turns' },
  { field: 'last_active', label: 'Last Active' },
  { field: 'duration', label: 'Duration' },
  { field: 'tokens', label: 'Tokens' },
  { field: 'goal', label: 'Goal' },
] as const satisfies readonly SortColumn[];

export type TaskListSortField = (typeof TASK_LIST_COLUMNS)[number]['field'] | 'created';

export const TASK_LIST_SORT_FIELDS: readonly TaskListSortField[] = [
  ...TASK_LIST_COLUMNS.map(c => c.field),
  'created',
];

export function taskListHtml(
  tasksWithSessions: TaskWithSession[],
  filter: string,
  sortField: TaskListSortField = 'created',
  sortDirection: SortDirection = 'desc',
  /** Codes shared by more than one task — those links fall back to the id. */
  duplicatedCodes?: ReadonlySet<string>,
): string {
  const filters = [
    { key: '', label: 'All Active' },
    { key: 'all', label: 'All' },
    { key: 'working', label: 'Working' },
    { key: 'interrupted', label: 'Interrupted' },
    { key: 'blocked', label: 'Blocked' },
    { key: 'submitted', label: 'Submitted' },
  ];

  // Preserve sort param in filter links
  const sortParam = sortField !== 'created' || sortDirection !== 'desc'
    ? `&sort=${sortDirection === 'desc' ? '-' : ''}${sortField}`
    : '';

  const filterBar = `<div class="filter-bar">${filters.map(f =>
    `<a href="/tasks?filter=${encodeURIComponent(f.key)}${sortParam}" class="btn btn-sm${filter === f.key ? ' active' : ''}">${escapeHtml(f.label)}</a>`
  ).join('')}</div>`;

  const listHead = `
      <div class="page-head">
        <h1>Tasks</h1>
        <div class="page-head-actions">
          <a href="/tasks/link" class="btn">Link…</a>
          <a href="/tasks/new" class="btn btn-primary">New task</a>
        </div>
      </div>`;

  if (tasksWithSessions.length === 0) {
    return layoutHtml('Tasks', `
      ${listHead}
      ${filterBar}
      <div class="empty-state">No tasks found.</div>
    `);
  }

  const columnHeaders = sortHeadersHtml<TaskListSortField>(
    TASK_LIST_COLUMNS,
    { field: sortField, direction: sortDirection },
    param => `/tasks?filter=${encodeURIComponent(filter)}&sort=${param}`,
  );

  const rows = tasksWithSessions.map(({ task, session, turnCount, protection }) => {
    const status = getTaskStatus(task, session);
    const lastActive = session?.last_interaction_at ? formatDate(session.last_interaction_at) : '-';
    const duration = session ? formatDuration(session.total_duration_ms) : '-';
    const tokens = formatTokenUsage(session?.total_usage ?? null);
    const turns = turnCount !== undefined && turnCount > 0 ? String(turnCount) : '-';

    // A task the human has to act on gets a direct link to the review page —
    // that page IS the pull request here, and hunting for it via task detail
    // was the slowest step in the whole loop.
    const reviewLink = (status === 'blocked' || status === 'conflict' || status === 'submitted')
      ? ` <a class="review-link" href="${taskPath(task, duplicatedCodes)}" title="Open this task">review →</a>`
      : '';
    return `<tr>
      ${forgeColumnCell(task)}
      <td><a href="${taskPath(task, duplicatedCodes)}">${escapeHtml(displayId(task))}</a></td>
      <td>${statusBadge(status)}${reviewLink}</td>
      <td>${escapeHtml(task.agent_id)}</td>
      <td>${escapeHtml(task.model ?? '-')}</td>
      <td>${escapeHtml(turns)}</td>
      <td>${escapeHtml(lastActive)}</td>
      <td>${escapeHtml(duration)}</td>
      <td>${escapeHtml(tokens)}</td>
      <td class="goal">${protectionBadge(protection)}${linkedBadgeHtml(task)}${escapeHtml(task.goal)}</td>
    </tr>`;
  }).join('\n');

  const anyProtected = tasksWithSessions.some(t => t.protection && protectionMarkers(t.protection));
  const legend = anyProtected
    ? `<div class="protection-legend">${escapeHtml(PROTECTION_MARKER_LEGEND)}</div>`
    : '';


  return layoutHtml('Tasks', `
    ${listHead}
    ${filterBar}
    <table class="table">
      <thead>
        <tr>
          ${forgeColumnHeader()}
          <th>Code</th>
          ${columnHeaders}
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    ${legend}
  `);
}

/**
 * The "Protected" detail row, or empty string when there is nothing to say.
 * Word-for-word the same summary and advice `lazy show` prints.
 */
export function protectionDetailRow(
  protection: TaskProtectionStatus | null | undefined,
  taskDisplayId: string,
): string {
  if (!protection) return '';
  const summary = protectionSummary(protection);
  if (!summary) return '';
  const advice = protectionAdvice(protection, taskDisplayId)
    .map(line => `<div class="protection-note">${escapeHtml(line)}</div>`)
    .join('');
  return `<div class="detail-row"><span class="detail-label">Protected</span><span>${escapeHtml(summary)}${advice}</span></div>`;
}

/**
 * The "you opened this and nothing answered" banner, when the human arrived
 * from a dead task-service subdomain.
 *
 * The "try again" link is composed HERE, from the task's own host label and the
 * dashboard's own authority — never from the query string, which is
 * attacker-supplied and would put a link of someone else's choosing on a page
 * the human trusts. No authority means no daemon is serving the proxy, so there
 * is nothing to retry against and the link is simply absent.
 *
 * INVARIANT: this renders a banner and nothing else. Reaching it is a GET, and
 * a GET must never start a container (see src/server/serve-notice.ts) — every
 * button it draws is a POST or a shell-panel command the human clicks.
 */
export function serveNoticeBannerHtml(
  task: Task,
  notice: ServeNotice | null | undefined,
  serve: ProbedServeState | null,
  controls?: ServicesCardControls,
): string {
  if (!notice) return '';
  const authority = dashboardAuthority();
  const retryUrl = authority
    ? serviceSubdomainUrl(notice.service, taskHostLabel(task), authority)
    : null;
  return serveNoticeHtml(task, notice, serve, controls, retryUrl);
}

/**
 * The task's `[serve]` services, as the dashboard shows them.
 *
 * Same shape and same wording as `lazy show` (src/cli/commands/show.ts) so the
 * two surfaces never disagree about what a task is serving. Renders nothing at
 * all when the project declares no ports — there is nothing useful to say about
 * a project that serves nothing.
 */
export function serveDetailRow(serve?: TaskServeState | null): string {
  if (!serve || serve.declared.length === 0) return '';

  let body: string;
  if (serve.unavailable === 'not-running') {
    body = serve.declared
      .map((s) => `<div>${escapeHtml(s.name)} → <span class="text-muted">(container not running)</span></div>`)
      .join('');
  } else if (serve.unavailable === 'no-container-runner') {
    body = `<span class="text-muted">${escapeHtml(serve.runnerType)} runner — services are on this machine's own ports</span>`;
  } else {
    body = serve.services
      .map((s) => {
        const shown = displayUrlFor(s);
        const target = shown
          // Loopback-only by construction, so this link is only ever clickable
          // from the machine the task runs on — which is the machine serving
          // this page.
          ? `<a href="${escapeHtml(shown)}">${escapeHtml(shown)}</a>`
          : '<span class="text-muted">(not published — restart to pick up [serve])</span>';
        return `<div>${escapeHtml(s.name)} → ${target}</div>`;
      })
      .join('');
  }
  return `<div class="detail-row"><span class="detail-label">Serving</span><span>${body}</span></div>`;
}

/**
 * Chunk display order on the task page. Default is newest-first: the reviewer
 * has already seen earlier chunks. Turns *within* a chunk always stay ascending
 * (a chunk reads as a story in time order). `oldest` is the pre-signal order,
 * reachable via `?chunks=oldest` — a cheap toggle, not a setting.
 */
export type TaskChunkOrder = 'newest' | 'oldest';

/**
 * The lifecycle action row on /tasks/:id.
 *
 * WHICH verbs appear comes from the shared predicate in ./task-verbs.ts — the
 * same one the POST route enforces — so the page can never draw a button the
 * route would refuse (the daemon still has the final word either way).
 *
 * Each verb is a button that opens the shared action dialog (see
 * ./action-dialog.ts). The form lives in a `<template>` so opening it never
 * reflows the page — the old `<details>` expander jerked the layout, which is
 * the complaint this exists to fix. Without JS the POST URLs still work.
 */
export function taskActionRowHtml(
  task: Task,
  hasOpenSession: boolean,
  /** Codes shared by more than one task — the action form's POST target falls back to the id. */
  duplicatedCodes?: ReadonlySet<string>,
): string {
  // The claim, not just the status: a review still claimed on a parked task is
  // stoppable, and the button has to be drawn or the operator has no way out.
  const verbs = new Set<TaskLifecycleVerb>(
    availableTaskVerbs(task.status, hasOpenSession, stoppableClaimOf(task) !== null),
  );
  const action = (verb: TaskLifecycleVerb) => `${taskPath(task, duplicatedCodes)}/actions/${verb}`;

  const parts: string[] = [];
  if (verbs.has('start')) {
    parts.push(actionDialogButtonHtml({ verb: 'start', label: 'Start', primary: true }));
    parts.push(actionDialogTemplateHtml('start', `
      <form method="post" action="${action('start')}" class="lz-action-form" data-lz-action-form>
        <p>Start this task? The agent will take a first turn.</p>
        <div class="rv-form-actions"><button type="submit" class="btn btn-primary">Start</button></div>
      </form>`));
  }
  if (verbs.has('resume')) {
    parts.push(actionDialogButtonHtml({ verb: 'resume', label: 'Resume' }));
    parts.push(actionDialogTemplateHtml('resume', `
      <form method="post" action="${action('resume')}" class="lz-action-form" data-lz-action-form>
        <p>Resume the agent with no new feedback.</p>
        <div class="rv-form-actions"><button type="submit" class="btn">Resume</button></div>
      </form>`));
  }
  // Reopening a closed (abandoned) task needs no reason — one button. A
  // completed task requires one, so it renders as a reason dialog below.
  if (verbs.has('reopen') && task.status === 'abandoned') {
    parts.push(actionDialogButtonHtml({ verb: 'reopen', label: 'Reopen' }));
    parts.push(actionDialogTemplateHtml('reopen', `
      <form method="post" action="${action('reopen')}" class="lz-action-form" data-lz-action-form>
        <p>Reopen this closed task to backlog.</p>
        <div class="rv-form-actions"><button type="submit" class="btn">Reopen</button></div>
      </form>`));
  }
  // Watch is NOT a lifecycle verb and no longer lives here: it opens the live
  // output panel next to the Shell button (see watchPanelHtml), which is the
  // same stream `lazy watch` prints on the CLI.

  const reasonForm = (
    verb: TaskLifecycleVerb,
    button: string,
    placeholder: string,
    lead: string,
  ) => actionDialogTemplateHtml(verb, `
      <form method="post" action="${action(verb)}" class="lz-action-form" data-lz-action-form>
        <p>${escapeHtml(lead)}</p>
        <input class="input" type="text" name="reason" required placeholder="${escapeHtml(placeholder)}">
        <div class="rv-form-actions"><button type="submit" class="btn">${escapeHtml(button)}</button></div>
      </form>`);

  if (verbs.has('stop')) {
    parts.push(actionDialogButtonHtml({ verb: 'stop', label: 'Stop' }));
    parts.push(reasonForm('stop', 'Stop task', 'Why are you stopping it?', 'Halt the running agent. It will not auto-resume.'));
  }
  if (verbs.has('close')) {
    parts.push(actionDialogButtonHtml({ verb: 'close', label: 'Close' }));
    parts.push(reasonForm('close', 'Close task', 'Why is this task being closed?', 'Close this task without merging.'));
  }
  // Reject lives on Current review with Accept — same decision, opposite
  // sign. The verb and POST /actions/reject stay; only the button moved.
  if (verbs.has('reopen') && task.status === 'complete') {
    parts.push(actionDialogButtonHtml({ verb: 'reopen', label: 'Reopen' }));
    parts.push(reasonForm('reopen', 'Reopen task', 'Why reopen this accepted task?', 'Reopen this accepted task. A reason is recorded as a comment.'));
  }

  return `<div class="lz-action-buttons">${parts.join('')}</div>`;
}

function emptyTabHtml(message: string): string {
  return `<p class="lz-empty-tab">${escapeHtml(message)}</p>`;
}

function formatUnparsedReviewHtml(turn: Turn): string {
  const suffix = formatUnparsedReviewSuffix(turn);
  if (!suffix) return '';
  return ` <span class="turn-unparsed">${escapeHtml(suffix.trim())}</span>`;
}

/**
 * Where a turn sits in the task, and which turn owns its `#turn-<n>` anchor.
 *
 * Both are properties of the WHOLE turn list, so they are computed once per
 * render and handed down rather than re-derived per card.
 */
interface TurnIndex {
  /** `turn.id`s that own the `#turn-<sequence>` anchor — one per sequence. */
  anchored: Set<string>;
  /** sequence → "3 of 9". */
  ordinals: Map<number, string>;
}

/**
 * The anchor owner and the ordinal for every turn.
 *
 * ANCHORS: a human and an agent turn share a sequence, and two elements with
 * one id make a deep link land wherever the browser feels like — so exactly
 * one of them owns it.
 *
 * THE AGENT HALF WINS. Every inbound "Turn #N" link is built from a report or
 * an agent turn — the Summary's report header, "Since you last looked",
 * Reviews, the command palette — so the reader clicking one is going to the
 * ANSWER, not to the prompt that asked for it. Chunks render newest-first, so
 * giving the anchor to the human half put the thing they clicked off-screen
 * ABOVE where they landed: they arrive at the ask and have to scroll back up
 * to find the work. The human half is still reachable, one line away and
 * inside the same chunk, which is the context the chunk view exists to give.
 *
 * Falls back to the first turn at that sequence when there is no agent half
 * (a human ask still awaiting its answer).
 *
 * ORDINALS: counted over DISTINCT sequences, ascending, because that is what
 * "turn 3 of 9" means to a reader. Positions are read off the real sorted list
 * and never computed as `sequence ± 1`: `reserveTurnSequences` hands out
 * numbers that may never be written, so the range has gaps and the arithmetic
 * version would name turns that do not exist.
 */
function turnIndexOf(turns: Turn[]): TurnIndex {
  const owner = new Map<number, Turn>();
  for (const turn of turns) {
    const held = owner.get(turn.sequence);
    if (held === undefined) {
      owner.set(turn.sequence, turn);
      continue;
    }
    // Upgrade to the agent half; never downgrade off it.
    if (held.role !== 'agent' && turn.role === 'agent') owner.set(turn.sequence, turn);
  }
  const sequences = [...owner.keys()].sort((a, b) => a - b);
  const ordinals = new Map<number, string>();
  sequences.forEach((sequence, i) => {
    ordinals.set(sequence, `${i + 1} of ${sequences.length}`);
  });
  return {
    anchored: new Set([...owner.values()].map((t) => t.id)),
    ordinals,
  };
}

/** The head line of one turn: which turn, who, when, what it cost. */
function turnHeadHtml(
  task: Task,
  session: Session | null,
  turn: Turn,
  index: TurnIndex,
  expectedLatest?: string,
): string {
  // WE ARE ALREADY ON THE TURNS TAB, so this link is an in-page anchor, not
  // `/tasks/:id/turns/:n`. That absolute form 302s back to this same tab — a
  // full navigation to reach an element already in the document, and a full
  // navigation fires `beforeunload`, which closes every open web shell. Not
  // tearing the page down for an in-document move is the whole reason the tab
  // island exists; a self-link must not undo it.
  //
  // The absolute form stays on every surface that links in from ELSEWHERE
  // (Summary, "Since you last looked", Reviews, the command palette), where
  // the redirect is doing real work: resolving the turn, 404ing an unknown
  // sequence, and landing on the right tab.
  const turnRef = session
    ? `<a href="#turn-${turn.sequence}" title="Go to turn #${turn.sequence} in its chunk">Turn #${turn.sequence}</a>`
    : `Turn #${turn.sequence}`;
  // "…of how many" — a turn number in a pasted link or a report is only
  // locatable if the page says where it sits in the task. The turn page said
  // "Turn 3 of 9"; the chunk view says which sequence AND where it sits,
  // because here the sequence is the thing links are written against.
  const ordinal = index.ordinals.get(turn.sequence);
  // Parenthesised: the sequence and the position often coincide, and
  // "Turn #8 8 of 8" reads as a typo where "Turn #8 (8 of 8)" reads as two
  // facts. They diverge whenever a sequence was reserved and never written.
  const ordinalInfo = ordinal
    ? ` <span class="turn-ordinal" title="Turn ${escapeHtml(ordinal)} in this task">(${escapeHtml(ordinal)})</span>`
    : '';
  const usageInfo = turn.usage
    ? ` <span class="turn-tokens" title="${escapeHtml(turnUsageTitle(turn.usage))}">${escapeHtml(formatTokenCount(totalInputTokens(turn.usage)))} in, ${escapeHtml(formatTokenCount(turn.usage.outputTokens))} out</span>`
    : '';
  const authorLabel = turn.role === 'human' && turn.actor && turn.actor !== 'human'
    ? turn.actor
    : turn.role;
  const autoBadge = turn.auto_triggered ? ` <span class="turn-auto">auto</span>` : '';
  // On the HEAD, for the same reason the model warning is: a reviewer scanning
  // collapsed turns has to be able to see that one of them ended with work
  // that is in no diff on this page. The paths ride in the tooltip rather than
  // the label — the count is the alarm, the names are the follow-up.
  const uncommittedBadge = turn.uncommitted?.length
    ? ` <span class="turn-uncommitted" title="Not committed, so not in this task's diff: ` +
      `${escapeHtml(turn.uncommitted.join(', '))}">${turn.uncommitted.length} uncommitted</span>`
    : '';
  // The model warning stays on the HEAD, not in the Ran As row below: it is a
  // warning, so it has to survive a glance at a collapsed turn. The launch
  // labels themselves live in the row and only there — one home each.
  const warning = formatTurnModelWarning(turn, expectedLatest);
  const warningInfo = warning
    ? ` <span class="turn-model-warning">${escapeHtml(warning)}</span>`
    : '';
  return `${turnRef}${ordinalInfo} [${escapeHtml(authorLabel)}]${escapeHtml(formatTurnTypeSuffix(turn))}` +
    `${formatUnparsedReviewHtml(turn)}${autoBadge}${uncommittedBadge} ` +
    `${timestampHtml(turn.timestamp)}${usageInfo}${warningInfo}`;
}

/**
 * "Ran As" — which agent, model and effort this turn was launched with.
 *
 * The row exists so a reader never has to INTERPRET a slot. Three cases, and
 * the third is why this is not simply "always render":
 *
 *  - **An agent turn.** The labels, or `unknown` for a field it did not record.
 *    Never filled in from the task's current settings.
 *  - **A turn lazy wrote itself** — a supervisor nudge, a `[system]` notice.
 *    {@link NO_LAUNCH_LABEL} says "no agent ran" in words rather than leaving
 *    a blank to infer from. This is the case the row was asked for.
 *  - **A turn the human or builder typed.** NO ROW. `agent: unknown · model:
 *    unknown · effort: unknown` here is worse than the blank it replaced: on a
 *    turn someone typed themselves, those three fields are not unknown, they
 *    are inapplicable, and printing `unknown` asserts something false on every
 *    chunk boundary. Absence is unambiguous here in a way it is not for the
 *    other two — this is your own message.
 *
 * The predicate is {@link isChunkBoundary}, the project's one definition of "a
 * genuine human/builder review intervention" (`src/utils/turn-chunks.ts`) —
 * reused rather than restated, since a third spelling of that rule is exactly
 * how the supervisor/system cases would drift apart from the chunk grouping.
 *
 * Deliberately NOT fixed in `turnLaunchLabels` / `turnRanNoAgent`: those are
 * shared with `lazy show`, the review TUI and the report header, and changing
 * what they say is a wider decision than this surface.
 */
function turnLaunchRow(turn: Turn): string {
  if (isChunkBoundary(turn)) return '';
  const ranNothing = turnRanNoAgent(turn);
  const segment = formatTurnLaunchLabels(turn) || NO_LAUNCH_LABEL;
  return `<div class="turn-ran-as${ranNothing ? ' turn-ran-as-none' : ''}">` +
    `<span class="turn-ran-as-label">Ran as</span> ` +
    `<span class="turn-ran-as-value">${escapeHtml(segment)}</span></div>`;
}

/** Cache split for the tooltip — the detail the old turn page had a row for. */
function turnUsageTitle(usage: TokenUsage): string {
  const parts = [
    `${formatTokenCount(totalInputTokens(usage))} input`,
    `${formatTokenCount(usage.outputTokens)} output`,
  ];
  if (usage.cacheCreationTokens > 0) parts.push(`${formatTokenCount(usage.cacheCreationTokens)} cache write`);
  if (usage.cacheReadTokens > 0) parts.push(`${formatTokenCount(usage.cacheReadTokens)} cache read`);
  return parts.join(' · ');
}

/**
 * One turn INSIDE its chunk.
 *
 * Deliberately not an `rv-viewable` card: the chunk is the unit of review now,
 * so it owns the Viewed tick and the j/k/n/p stop. A turn is still individually
 * collapsible (a plain `<details>`, which needs no script) and still carries
 * `id="turn-<sequence>"` so `/tasks/<id>/turns/<n>` can land on it.
 */
function chunkTurnHtml(
  task: Task,
  session: Session | null,
  turn: Turn,
  index: TurnIndex,
  markdown?: RenderMarkdownOptions,
  turnCommits?: Commit[],
  duplicatedCodes?: ReadonlySet<string>,
): string {
  const preview = renderMarkdown(turnText(turn), markdown);
  // `reviewReportHtml` composes `/tasks/${taskId}/...` itself, so it takes the
  // BARE segment — a full path here doubles into /tasks//tasks/...
  const body = turn.review
    ? `${reviewReportHtml(taskPathSegment(task, duplicatedCodes), turn.review)}
        <details class="lz-findings-raw">
          <summary>Raw review text</summary>
          <div class="turn-content">${preview}</div>
        </details>`
    : preview;
  // A sequence carries at most one anchor even though a human and an agent
  // turn can share it — duplicate ids make the deep link ambiguous.
  const anchor = index.anchored.has(turn.id)
    ? ` id="turn-${turn.sequence}"`
    : ` id="turn-x-${escapeHtml(turn.id)}"`;
  const card =
    `<details class="chunk-turn" open${anchor}>` +
    `<summary class="chunk-turn-head">${turnHeadHtml(task, session, turn, index)}</summary>` +
    `${turnLaunchRow(turn)}` +
    `<div class="turn-content">${body}</div>` +
    `</details>`;
  // Nest this turn's commits under agent/work cards only — empty = no chrome.
  if (!turnCommits || turnCommits.length === 0 || !isAgentWorkTurn(turn)) {
    return card;
  }
  return `${card}\n      <div class="turn-commits">${turnCommits.map((c) => commitRowHtml(task, c, duplicatedCodes)).join('')}</div>`;
}

/**
 * A comment or journal entry inside a chunk. Same reasoning as
 * {@link chunkTurnHtml}: keeps its `#` anchor, gives up its own Viewed tick to
 * the chunk. The Comments and Journal TABS still render full viewable cards —
 * there the note IS the unit of review.
 */
function chunkNoteHtml(
  id: string,
  headHtml: string,
  bodyHtml: string,
): string {
  return `<details class="chunk-note" open id="${escapeHtml(id)}">` +
    `<summary class="chunk-note-head">${headHtml}</summary>` +
    `<div class="note-content turn-content">${bodyHtml}</div>` +
    `</details>`;
}

/** Commit row. The `#commit-<id>` id is the in-tab anchor; the href is the leaf page. */
export function commitRowHtml(task: Task, c: Commit, duplicatedCodes?: ReadonlySet<string>): string {
  return `
      <div class="commit-row" id="commit-${escapeHtml(c.id)}">
        <a href="${taskPath(task, duplicatedCodes)}/commits/${encodeURIComponent(c.id)}" class="commit-sha">${escapeHtml(c.sha.substring(0, 8))}</a>
        ${statusBadge(c.status)}
        <span class="commit-message">${escapeHtml(c.message)}</span>
      </div>
    `;
}

/**
 * One comment card. Shared by the Turns fold and the Comments tab, so a
 * comment reads the same wherever it is seen.
 *
 * `extraHeadHtml` is where the Comments tab hangs its delivered/queued marker —
 * that state is resolved by the caller through `resolveNotesCutoff`, never here.
 */
export function commentCardHtml(
  comment: Comment,
  markdown?: RenderMarkdownOptions,
  extraHeadHtml = '',
): string {
  return viewedCardHtml({
    key: `comment:${comment.id}`,
    content: comment.content,
    id: `comment-${comment.id}`,
    headHtml: `<span class="note-date">${commentNoteHead(comment)}</span>${extraHeadHtml}`,
    bodyHtml: renderMarkdown(comment.content, markdown),
    sectionClass: 'note',
    bodyClass: 'note-content turn-content',
  });
}

/**
 * A comment's head line — when, who, and whether it came from the forge.
 *
 * EVERYTHING a comment's head says lives here, the provenance badge included.
 * The Comments tab and the Turns tab's chunk fold both render this; when the
 * badge was composed separately at each call site, the next change to how a
 * forge comment is labelled would have landed on one surface and not the
 * other. The Comments tab adds ONLY its delivered/queued marker on top, which
 * is state this function cannot resolve.
 */
function commentNoteHead(comment: Comment): string {
  // A comment with no actor predates actor attribution; it came from the CLI,
  // which is `human`. Say nothing rather than guess.
  const who = comment.actor ? ` · ${escapeHtml(comment.actor)}` : '';
  const from = comment.source === 'remote'
    ? ` · <span class="lz-note-src">from the pull request</span>`
    : '';
  const editedBy = comment.edited_by_name ?? comment.edited_by_email ?? comment.edited_by;
  const edited = comment.edited_at
    ? ` · <span class="lz-note-src">edited ${timestampHtml(comment.edited_at)}${editedBy ? ` by ${escapeHtml(editedBy)}` : ''}</span>`
    : '';
  const revises = comment.revises_comment_id
    ? ` · <span class="lz-note-src">edited on the forge — revises <a href="#comment-${escapeHtml(comment.revises_comment_id)}">an earlier comment</a></span>`
    : '';
  return `Comment ${timestampHtml(comment.created_at)}${who}${from}${edited}${revises}`;
}

function journalNoteHead(entry: JournalEntry): string {
  const who = entry.actor ? ` · ${escapeHtml(entry.actor)}` : '';
  // WHICH person, when the write knew one — the same `name <email>` rendering
  // every other attributed surface uses.
  const person = attributionLabel(null, entry.actor_email, entry.actor_name);
  const byPerson = person ? ` · ${escapeHtml(person)}` : '';
  return `Journal ${timestampHtml(entry.created_at)}${who}${byPerson}`;
}

export function journalCardHtml(entry: JournalEntry, markdown?: RenderMarkdownOptions): string {
  return viewedCardHtml({
    key: `journal:${entry.id}`,
    content: entry.content,
    id: `journal-${entry.id}`,
    headHtml: `<span class="note-date">${journalNoteHead(entry)}</span>`,
    bodyHtml: renderMarkdown(entry.content, markdown),
    sectionClass: 'note',
    bodyClass: 'note-content turn-content',
  });
}

function foldedItemHtml(
  task: Task,
  session: Session | null,
  item: FoldedItem,
  index: TurnIndex,
  markdown?: RenderMarkdownOptions,
  commitsByTurn?: Map<string, Commit[]>,
  duplicatedCodes?: ReadonlySet<string>,
): string {
  switch (item.kind) {
    case 'turn':
      return chunkTurnHtml(
        task,
        session,
        item.turn,
        index,
        markdown,
        commitsByTurn?.get(item.turn.id),
        duplicatedCodes,
      );
    case 'comment':
      return chunkNoteHtml(
        `comment-${item.comment.id}`,
        `<span class="note-date">${commentNoteHead(item.comment)}</span>`,
        renderMarkdown(item.comment.content, markdown),
      );
    case 'journal':
      return chunkNoteHtml(
        `journal-${item.journal.id}`,
        `<span class="note-date">${journalNoteHead(item.journal)}</span>`,
        renderMarkdown(item.journal.content, markdown),
      );
  }
}

/** First meaningful line of a turn, for the chunk heading's intent. */
export function chunkIntentLine(turn: Turn, limit = 140): string {
  const raw = turnText(turn);
  const line = raw
    .split('\n')
    .map((l) => l.replace(/^[\s>#*\-`]+/, '').trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * The chunk's number, as the anchor, the viewed key and the reader all use it.
 * 1-based, because it is a label a human reads and pastes — `TurnChunk.index`
 * stays 0-based as an array position. One function so the three can never
 * disagree.
 */
export function chunkNumber(chunk: TurnChunk): number {
  return chunk.index + 1;
}

/** "4 turns · 1 note", with the pieces that are actually there. */
function chunkCountsLabel(turnCount: number, noteCount: number): string {
  const parts = [`${turnCount} turn${turnCount === 1 ? '' : 's'}`];
  if (noteCount > 0) parts.push(`${noteCount} note${noteCount === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * The Turns tab body: review chunks, with comments / journal folded into the
 * chunk their timestamp belongs to, and each agent/work turn's commits nested
 * under that turn. Every folded note keeps a stable `#` id so *Since you last
 * looked* can link here.
 *
 * THE CHUNK IS THE UNIT OF REVIEW. One `rv-viewable` card per chunk, so the
 * Viewed tick, the collapse, and every j/k/n/p stop move a whole chunk at a
 * time; the turns inside are plain `<details>`, individually collapsible but
 * not separate stops. Reviewing turn by turn split apart exactly the turns we
 * group for a reason — a nudge, an auto-resume and the agent work they caused
 * were three unrelated cards, and the reader had to reassemble them.
 *
 * A turn stays deep-linkable: `#turn-<sequence>` is on the turn inside its
 * chunk, and `/tasks/<id>/turns/<n>` redirects there.
 */
export function taskTurnsSectionHtml(
  task: Task,
  session: Session | null,
  turns: Turn[],
  chunkOrder: TaskChunkOrder = 'newest',
  extras?: TurnFoldExtras & {
    commits?: Commit[];
    /** Codes shared by more than one task — this tab's task links fall back to the id for those. */
    duplicatedCodes?: ReadonlySet<string>;
  },
  markdown?: RenderMarkdownOptions,
): string {
  const dups = extras?.duplicatedCodes;
  const commits = extras?.commits ?? [];
  const folded = foldRecordIntoChunks(turns, {
    comments: extras?.comments,
    journal: extras?.journal,
  });
  if (folded.length === 0) return '';

  const commitsByTurn = attributeCommitsToTurns(turns, commits);

  // One direction for the whole tab: newest-first (default) puts the latest
  // chunk at the top AND the latest turn at the top of that chunk. The
  // mixed order (chunks descending, turns inside ascending) read as two
  // timelines at once. Oldest-first is the same rule the other way.
  const newest = chunkOrder !== 'oldest';
  const display = newest ? [...folded].reverse() : folded;
  const turnIndex = turnIndexOf(turns);
  const chunkItems = display.map((group) => {
    const chunk = group.chunk;
    const items = newest ? [...group.items].reverse() : group.items;
    const body = items
      .map((item) => foldedItemHtml(task, session, item, turnIndex, markdown, commitsByTurn, dups))
      .join('');
    // The tick is taken over everything the chunk says: change any turn or note
    // in it and the chunk comes back unviewed, which is the point of ticking.
    const content = group.items
      .map((item) => (item.kind === 'turn'
        ? turnText(item.turn)
        : item.kind === 'comment' ? item.comment.content : item.journal.content))
      .join('\n---\n');
    if (!chunk) {
      // Extras with no turns — still a home for the anchors.
      return viewedCardHtml({
        key: 'chunk:pre',
        content,
        id: 'chunk-pre',
        headHtml: `<span class="turn-chunk-header">Before any turn · ${group.items.length} note${group.items.length === 1 ? '' : 's'}</span>`,
        bodyHtml: body,
        sectionClass: 'turn-chunk',
        bodyClass: 'turn-chunk-body',
      });
    }
    const b = chunk.boundary;
    const boundaryLabel = b
      ? `#${b.sequence} [${escapeHtml(b.role === 'human' && b.actor && b.actor !== 'human' ? b.actor : b.role)}]`
      : '(no boundary — leading automation turns)';
    const noteCount = group.items.length - chunk.turns.length;
    // The heading IS the chunk's intent: who opened it, when, and the first
    // line of what they asked for. Newest-first puts the opening turn at the
    // BOTTOM of its own chunk, so without this the reader would have to
    // scroll past the answer to find the question.
    const intent = b ? chunkIntentLine(b) : '';
    const intentHtml = intent
      ? `<span class="turn-chunk-intent">${escapeHtml(intent)}</span>`
      : '';
    const startedAt = chunk.turns[0]!.timestamp;
    // ONE number for the anchor, the viewed key and the label a human reads.
    // `#chunk-3` meaning `card:chunk:2` under a heading saying "Chunk 3" is
    // three numberings for one thing; the next surface that links a chunk
    // would have picked the wrong one. Same rule the turn anchors already
    // follow: `#turn-7` is the thing labelled "Turn #7".
    const n = chunkNumber(chunk);
    return viewedCardHtml({
      key: `chunk:${n}`,
      content,
      id: `chunk-${n}`,
      headHtml:
        `<span class="turn-chunk-header">Chunk ${n} · ${boundaryLabel} · ` +
        `${timestampHtml(startedAt)} · ${chunkCountsLabel(chunk.turns.length, noteCount)}</span>` +
        intentHtml,
      bodyHtml: body,
      sectionClass: 'turn-chunk',
      bodyClass: 'turn-chunk-body',
    });
  }).join('');

  const orderToggle = chunkOrder === 'oldest'
    ? `<a class="chunk-order-toggle" href="${taskPath(task, dups)}/turns">Newest first</a>`
    : `<a class="chunk-order-toggle" href="${taskPath(task, dups)}/turns?chunks=oldest">Oldest first</a>`;

  const realChunks = folded.filter((g) => g.chunk !== null).length;
  const heading = turns.length === 0
    ? `<h2>Turns</h2>`
    : `<h2>Turns (${turns.length} in ${realChunks} chunk${realChunks === 1 ? '' : 's'})</h2>`;
  // The grouping rule is not visible from the headers ("Chunk 2 · #6 [human]").
  // One line, in the page, so a reader knows why turns are bunched this way.
  const chunkExplain = turns.length > 0
    ? `<p class="turns-chunk-explain">A chunk is what happened since you last acted — your turn and every agent turn that followed, until you acted again. Review one chunk at a time: the tick, and <kbd>j</kbd>/<kbd>k</kbd>, move by chunk.</p>`
    : '';

  return `
      <div class="detail-section">
        <div class="turns-heading">
          ${heading}
          ${turns.length > 0 ? orderToggle : ''}
        </div>
        ${chunkExplain}
        ${chunkItems}
      </div>
    `;
}

/** Commits tab / section. Newest-first. Empty string when there are none. */
export function taskCommitsSectionHtml(task: Task, commits: Commit[], duplicatedCodes?: ReadonlySet<string>): string {
  if (commits.length === 0) return '';
  // Storage returns oldest-first; the tab matches Turns (newest first).
  const ordered = [...commits].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
    return b.id.localeCompare(a.id);
  });
  const commitItems = ordered.map((c) => commitRowHtml(task, c, duplicatedCodes)).join('');
  return `
      <div class="detail-section">
        <h2>Commits (${commits.length})</h2>
        ${commitItems}
      </div>
    `;
}

export function taskCommentsSectionHtml(comments: Comment[]): string {
  if (comments.length === 0) return '';
  const commentItems = comments.map((c) => commentCardHtml(c)).join('');
  return `
      <div class="detail-section">
        <h2>Comments (${comments.length})</h2>
        ${commentItems}
      </div>
    `;
}

export function taskJournalSectionHtml(journal: JournalEntry[]): string {
  if (journal.length === 0) return '';
  const journalItems = journal.map((e) => journalCardHtml(e)).join('');
  return `
      <div class="detail-section">
        <h2>Journal (${journal.length})</h2>
        ${journalItems}
      </div>
    `;
}

export function taskRaisedSectionHtml(
  raisedItems: RaisedItem[],
  markdown?: RenderMarkdownOptions,
  /** Codes shared by more than one task — promoted-task links fall back to the id for those. */
  options?: { duplicatedCodes?: ReadonlySet<string> },
): string {
  if (raisedItems.length === 0) return '';
  const raisedCards = raisedItems.map(item => viewedCardHtml({
    key: `raised:${item.id}`,
    content: item.content,
    headHtml:
      // Same badges as every other raised surface — this card used to spell its
      // own `blocking` / `non-blocking` tags, and showed no decision at all, so
      // a dismissed item looked exactly like one nobody had touched.
      `${raisedGateBadgeHtml(item.blocking)} ` +
      `${item.status === 'open' ? '' : `${raisedDecisionBadgeHtml(item.status, {
        promotedTaskId: item.promoted_task_id,
        promotedTaskCode: item.promoted_task_code ?? null,
        duplicatedCodes: options?.duplicatedCodes,
      })} `}` +
      // "open" read as a STATE next to the badges, which is what it is not.
      `<a href="/raised/${escapeHtml(item.id)}">View item</a> ` +
      `<span class="note-date">${escapeHtml(formatDate(item.created_at))}</span>` +
      // Who decided, next to what was decided — a badge saying "dismissed"
      // with nobody's name on it is half the record on a team.
      (item.status === 'open'
        ? ''
        : (() => {
          const who = attributionLabel(item.resolved_by, item.resolved_by_email, item.resolved_by_name);
          return who ? ` <span class="text-muted">decided by ${escapeHtml(who)}</span>` : '';
        })()) +
      (item.comments && item.comments.length > 0
        ? ` <span class="text-muted">${item.comments.length} agent comment${item.comments.length === 1 ? '' : 's'}</span>`
        : ''),
    bodyHtml: renderMarkdown(raisedDisplayBody(item), markdown),
    sectionClass: 'note',
    bodyClass: 'note-content turn-content',
  })).join('');
  return `
      <div class="detail-section">
        <h2>Raised items (${raisedItems.length})</h2>
        ${raisedCards}
      </div>
    `;
}

export function taskChildrenSectionHtml(children: Task[], duplicatedCodes?: ReadonlySet<string>): string {
  if (children.length === 0) return '';
  // Derived from the rows rendered here when the caller has no set, the way
  // `subtasksSectionHtml` does: a code two children share must name neither of
  // them in a URL, or the row links to whichever one the resolver prefers.
  const duplicated = duplicatedCodes
    ?? duplicateTaskCodes(children.map((c) => ({ id: c.id, code: c.code })));
  const childRows = children.map(child => `
      <tr>
        ${forgeColumnCell(child)}
        <td><a href="${taskPath(child, duplicated)}">${escapeHtml(displayId(child))}</a></td>
        <td>${statusBadge(child.status)}</td>
        <td class="goal">${escapeHtml(child.goal)}</td>
      </tr>
    `).join('');
  return `
      <div class="detail-section">
        <h2>Child Tasks (${children.length})</h2>
        <table class="table">
          <thead><tr>${forgeColumnHeader()}<th>Code</th><th>Status</th><th>Goal</th></tr></thead>
          <tbody>${childRows}</tbody>
        </table>
      </div>
    `;
}

export function taskPromptSectionHtml(
  task: Task,
  promptVersions: TaskPromptVersion[],
  /** Codes shared by more than one task — the prompt links fall back to the id for those. */
  duplicatedCodes?: ReadonlySet<string>,
): string {
  if (promptVersions.length > 0) {
    const versionLinks = promptVersions.map(v =>
      `<a href="${taskPath(task, duplicatedCodes)}/prompts/${v.version}" class="btn btn-sm prompt-link">v${v.version} (${escapeHtml(formatDate(v.created_at))})</a>`
    ).join('');
    return `
      <div class="detail-section">
        <h2>Prompt History (${promptVersions.length} version${promptVersions.length === 1 ? '' : 's'})</h2>
        <div>${versionLinks}</div>
      </div>
    `;
  }
  if (task.prompt) {
    return `
      <div class="detail-section">
        <h2>Prompt</h2>
        <a href="${taskPath(task, duplicatedCodes)}/prompts/current" class="btn btn-sm prompt-link">View current prompt</a>
      </div>
    `;
  }
  return '';
}

export function taskDetailHtml(
  task: Task,
  session: Session | null,
  turns: Turn[],
  commits: Commit[],
  comments: Comment[],
  journal: JournalEntry[],
  raisedItems: RaisedItem[],
  children: Task[],
  promptVersions: TaskPromptVersion[],
  parentTask?: Task | null,
  protection?: TaskProtectionStatus | null,
  baseBranch?: string,
  serve?: TaskServeState | null,
  chunkOrder: TaskChunkOrder = 'newest',
  shell?: ShellAvailability | null,
  /**
   * Start container / Start services buttons. Optional: a caller with no daemon
   * action port renders the same page without them.
   */
  controls?: ServicesCardControls,
  activity?: ReviewActivity | null,
  /**
   * Set when the human got here by opening a task service's subdomain URL and
   * nothing answered — the proxy redirected them to this page. Renders a banner
   * above the Services card saying what they opened and why it did not answer.
   */
  serveNotice?: ServeNotice | null,
  /**
   * The request's timing collector, so each section below is measured as its
   * own phase (`render.turns`, `render.children`, …). Absent — every direct
   * caller outside the route, i.e. the unit tests — the render is simply not
   * measured and produces byte-identical HTML.
   */
  timings?: RenderTimings,
): string {
  const clock = timings ?? unmeasured();
  const status = getTaskStatus(task, session);
  const taskDisplayId = displayId(task);
  const parentId = parentTaskIdOf(task);
  const hasOpenSession = session !== null && !session.ended_at;
  const probedServe = serve ? toProbedState(serve) : null;

  // Signal first: goal / status / parent. The task code is already in the h1 —
  // do not repeat it as a labeled row. Everything else (ids, agent, model,
  // tokens, branch, session) is demoted into a collapsed metadata panel so the
  // page leads with what a reviewer actually needs.
  const parentHtml = parentId
    ? `<span class="task-parent">Parent <a href="${taskPath({ id: parentId, code: parentTask?.code ?? null })}">${escapeHtml(parentTask ? displayId(parentTask) : shortId(parentId))}</a></span>`
    : '';

  // Metadata rows that used to live under a front-and-center Details / Session
  // pair. Kept verbatim so protection/serve/etc. tests still find their labels.
  const taskMetaRows = `
      <div class="detail-row"><span class="detail-label">ID</span><span>${escapeHtml(task.id)}</span></div>
      <div class="detail-row"><span class="detail-label">Agent</span><span>${escapeHtml(task.agent_id)}</span></div>
      ${task.model ? `<div class="detail-row"><span class="detail-label">Model</span><span>${escapeHtml(task.model)}</span></div>` : ''}
      <div class="detail-row"><span class="detail-label">Created</span><span>${escapeHtml(formatDate(task.created_at))}</span></div>
      ${task.completed_at ? `<div class="detail-row"><span class="detail-label">Completed</span><span>${escapeHtml(formatDate(task.completed_at))}</span></div>` : ''}
      ${task.close_reason ? `<div class="detail-row"><span class="detail-label">Reason</span><span>${escapeHtml(task.close_reason)}</span></div>` : ''}
      ${task.branched_from_sha ? `<div class="detail-row"><span class="detail-label">Branched From</span><span>${escapeHtml(task.branched_from_sha.substring(0, 8))}</span></div>` : ''}
      ${protectionDetailRow(protection, taskDisplayId)}
      ${serveDetailRow(serve)}
  `;

  let sessionMetaRows: string;
  if (session) {
    const sessionStatus = session.outcome ?? (session.ended_at ? 'ended' : task.status);
    sessionMetaRows = `
      <h3 class="task-metadata-subhead">Session (${escapeHtml(session.agent_id)})</h3>
      <div class="detail-row"><span class="detail-label">Status</span><span>${statusBadge(sessionStatus)}</span></div>
      <div class="detail-row"><span class="detail-label">Branch</span><span>${escapeHtml(session.git_branch)}</span></div>
      ${baseBranch ? `<div class="detail-row"><span class="detail-label">Base</span><span>${escapeHtml(baseBranch)}</span></div>` : ''}
      <div class="detail-row"><span class="detail-label">Started</span><span>${escapeHtml(formatDate(session.started_at))}</span></div>
      ${session.last_interaction_at ? `<div class="detail-row"><span class="detail-label">Last Interaction</span><span>${escapeHtml(formatDate(session.last_interaction_at))}</span></div>` : ''}
      <div class="detail-row"><span class="detail-label">Duration</span><span>${escapeHtml(formatDuration(session.total_duration_ms))}</span></div>
      ${session.total_usage ? `
      <div class="detail-row"><span class="detail-label">Token Usage</span><span>${escapeHtml(formatTokenCount(totalInputTokens(session.total_usage)))} in, ${escapeHtml(formatTokenCount(session.total_usage.outputTokens))} out</span></div>
      ` : ''}
      <div class="detail-row"><span class="detail-label">Start SHA</span><span>${escapeHtml(session.git_start_sha.substring(0, 8))}</span></div>
    `;
  } else {
    sessionMetaRows = `
      <h3 class="task-metadata-subhead">Session</h3>
      <p class="text-muted">Not started</p>
    `;
  }

  // A blocked/conflict task is waiting on the human: the review page is the
  // way to answer, so its link leads the row and keeps the primary style. For
  // any other state with a session the link stays, demoted to an ordinary
  // button — the primary act is whatever the action row offers (Start on a
  // backlog task, and so on).
  const reviewIsPrimary = task.status === 'blocked' || task.status === 'conflict';
  let content = `
    <h1>Task ${escapeHtml(taskDisplayId)}</h1>
    <div class="action-links">
      ${session ? `<a href="${taskPath(task)}/review" class="btn${reviewIsPrimary ? ' btn-primary' : ''}">Current review</a>` : ''}
      ${taskActionRowHtml(task, hasOpenSession)}
      ${isTerminalStatus(task.status) ? '' : `<a href="${taskPath(task)}/edit" class="btn">Edit task</a>`}
      <!-- shellPanelHtml/watchPanelHtml compose /tasks/<segment>/... themselves, so they take the BARE segment -->
      ${shell ? shellPanelHtml(taskPathSegment(task), shell) : ''}
      ${watchPanelHtml(taskPathSegment(task), !isTerminalStatus(task.status))}
      ${reviewNavControlsHtml()}
    </div>
    <div class="task-signal">
      <p class="task-goal">${escapeHtml(task.goal)}</p>
      <div class="task-signal-meta">
        ${statusBadge(status)}
        ${parentHtml}
      </div>
    </div>
    ${activity ? reviewActivityCardHtml(activity, taskPathSegment(task)) : ''}
    ${serveNoticeBannerHtml(task, serveNotice, probedServe, controls)}
    ${servicesCardHtml(task, probedServe, controls)}
    <details class="detail-section task-metadata">
      <summary>Metadata</summary>
      ${taskMetaRows}
      ${sessionMetaRows}
    </details>
  `;

  // Each section below is bracketed by a timing phase. The brackets are purely
  // additive — no section moved and nothing was restructured to accommodate
  // them — so a measured render emits byte-identical HTML to an unmeasured one.

  // Turns section - grouped into review chunks (one human/builder boundary plus
  // its following agent/supervisor/system turns) using the single source of
  // truth, so intermediate auto-resume/supervisor turns are never visually lost.
  // The whole tab reads in one direction: newest-first by default (latest
  // chunk AND latest turn at the top); ?chunks=oldest reverses both.
  // Rendered as Markdown with links to turn detail pages.
  const turnsPhase = clock.begin('turns');
  // Commits nest under the agent/work turn that produced them; comments /
  // journal fold into the chunk. Pass them here so a journal entry still
  // has a `#journal-<id>` when there are no turns yet.
  content += taskTurnsSectionHtml(task, session, turns, chunkOrder, { commits, comments, journal });
  turnsPhase.end();

  const raisedPhase = clock.begin('raised');
  content += taskRaisedSectionHtml(raisedItems);
  raisedPhase.end();

  const childrenPhase = clock.begin('children');
  content += taskChildrenSectionHtml(children);
  childrenPhase.end();

  const promptsPhase = clock.begin('prompts');
  content += taskPromptSectionHtml(task, promptVersions);
  promptsPhase.end();

  const scriptsPhase = clock.begin('scripts');
  // Every card on this page — turns, comments, journal entries, follow-ups —
  // is a viewable section; this drives the chevron and the "Viewed" tick.
  content += viewedStateScript(task.id);
  // ...and the same navigation island the review page runs, so j/k/v work
  // identically on a page made of the very same cards. Approve/reject have no
  // control here and simply do nothing.
  content += reviewNavigationScript();

  // The shell client script wires any shell panel on the page; emitted only
  // when a shell block was rendered (available or not — a disabled button needs
  // no script, but keeping the condition on `shell` keeps ordinary pages clean).
  if (shell?.available) content += shellClientScript();

  // Watch is a live output panel now, not a page-refresh loop: the button opens
  // a read-only terminal fed by the same stream `lazy watch` prints on the CLI.
  // The old <meta http-equiv="refresh"> mode is gone — a reload told the
  // reviewer nothing about what the agent was doing between reloads, and two
  // "Watch" affordances (one that reloads, one that streams) would be a riddle.
  // Without JS the honest fallback is simply reloading the page.
  if (!isTerminalStatus(task.status)) content += watchClientScript();
  scriptsPhase.end();

  return clock.measureSync('layout', () => layoutHtml(`Task ${taskDisplayId}`, content));
}

export function promptVersionHtml(
  task: Task,
  version: TaskPromptVersion | null,
  versionNum: string,
  allVersions: TaskPromptVersion[],
  /** Codes shared by more than one task — this page's links fall back to the id for those. */
  duplicatedCodes?: ReadonlySet<string>,
): string {
  const taskDisplayId = displayId(task);
  const breadcrumb = `<div class="breadcrumb"><a href="${taskPath(task, duplicatedCodes)}">Task ${escapeHtml(taskDisplayId)}</a> &rsaquo; Prompt</div>`;

  const promptContent = version?.content ?? task.prompt ?? '(no prompt)';
  const title = version ? `v${version.version}` : 'Current';

  const versionLinks = allVersions.map(v =>
    `<a href="${taskPath(task, duplicatedCodes)}/prompts/${v.version}" class="btn btn-sm${v.version === version?.version ? ' btn-primary' : ''} prompt-link">v${v.version}</a>`
  ).join('');

  return layoutHtml(`Prompt ${title}`, `
    ${breadcrumb}
    <h1>Prompt ${escapeHtml(title)}</h1>
    ${allVersions.length > 0 ? `<div style="margin-bottom:16px">${versionLinks}</div>` : ''}
    ${version ? `<p class="text-muted" style="margin-bottom:12px">Created: ${escapeHtml(formatDate(version.created_at))}</p>` : ''}
    <div class="detail-section">
      ${viewedCardHtml({
        key: `prompt:${version ? `v${version.version}` : 'current'}`,
        content: promptContent,
        headHtml: `Prompt ${escapeHtml(title)}`,
        bodyHtml: renderMarkdown(promptContent),
        bodyClass: 'turn-content',
      })}
    </div>
    ${viewedStateScript(task.id)}
  `);
}

/**
 * What the human typed, echoed straight back into the form.
 *
 * CLAUDE.md's "never lose human feedback" applies to a rewritten prompt as much
 * as to review feedback: when the save fails, the page re-renders from THIS,
 * not from storage, so a paragraph someone just wrote is never replaced by the
 * old text they were replacing.
 */
export interface TaskEditDraft {
  goal: string;
  prompt: string;
  model: string;
  effort: string;
  agent: string;
}

/**
 * One option in an agent picker: an agent PROFILE, not a harness.
 *
 * `summary` is what the profile actually runs (harness, model, endpoint,
 * credential) so a human picking `company-tokens-cursor` can see it is cursor
 * against their own key; `group` says where the name came from.
 */
export interface AgentChoice {
  name: string;
  summary: string;
  group: AgentChoiceGroup;
}

/**
 * Where an offered agent name came from. The picker's whole job is to answer
 * that, so it is an explicit provenance rather than a `builtin` boolean — three
 * of these four cases are not "configured or not":
 *
 *  - `configured` — an `[agents.<name>]` block in this project's lazy.toml.
 *  - `builtin`    — the implicit per-harness profile.
 *  - `pinned`     — the task's own stored agent, which the offered set does not
 *                   contain (lazy.toml no longer defines it, or it is one lazy
 *                   hides, like the internal qa-agent). Kept selectable so
 *                   saving the form cannot silently switch it.
 *  - `degraded`   — config could not be read at all; these are lazy's built-in
 *                   AGENTS with no profile information behind them, and the
 *                   form shows a notice saying so.
 */
export type AgentChoiceGroup = 'configured' | 'builtin' | 'pinned' | 'degraded';

/**
 * Agent profiles as labelled groups — the project's own `[agents.<name>]`
 * blocks first, the implicit per-harness built-ins beneath them, and anything
 * pinned-but-unoffered in its own group at the end.
 *
 * `<optgroup>` rather than a flat list because the whole point is that these
 * names are configured combos: a flat list of names reads as a list of
 * harnesses, which is what made a human pick an "agent" their lazy.toml never
 * defined. A group with no members is omitted rather than rendered empty, and
 * no option is ever placed in a group that misdescribes where it came from.
 */
const AGENT_GROUP_LABELS: Record<AgentChoiceGroup, string> = {
  configured: 'Configured profiles (lazy.toml)',
  builtin: 'Built-in profiles',
  degraded: 'Built-in agents (lazy.toml unread)',
  pinned: 'Pinned on this task',
};

const AGENT_GROUP_ORDER: readonly AgentChoiceGroup[] = ['configured', 'builtin', 'degraded', 'pinned'];

function agentChoiceOptions(choices: readonly AgentChoice[], selected: string): string {
  const option = (choice: AgentChoice) => {
    const label = choice.summary ? `${choice.name} — ${choice.summary}` : choice.name;
    const sel = choice.name === selected ? ' selected' : '';
    return `<option value="${escapeHtml(choice.name)}"${sel}>${escapeHtml(label)}</option>`;
  };
  return AGENT_GROUP_ORDER.map((name) => {
    const members = choices.filter((c) => c.group === name);
    return members.length
      ? `<optgroup label="${escapeHtml(AGENT_GROUP_LABELS[name])}">${members.map(option).join('')}</optgroup>`
      : '';
  }).join('');
}

/** The degraded-path warning, rendered next to the picker it applies to. */
function agentNoticeHtml(notice: string | undefined): string {
  return notice ? `<p class="edit-notice edit-notice-err">${escapeHtml(notice)}</p>` : '';
}

/** Shown under every agent picker: where the names come from, and what wins. */
const AGENT_PICKER_HINT =
  '<p class="text-muted">Agent profiles are defined by <code>[agents.&lt;name&gt;]</code> blocks in <code>lazy.toml</code> — ' +
  'harness, model, endpoint and credential together. The built-ins are one implicit profile per harness. ' +
  'The Model and Effort fields on this form override the chosen profile for this task.</p>';

export interface TaskEditOptions {
  /** Agent profiles this project offers, for the agent picker. */
  agents: readonly AgentChoice[];
  /** Set when the offered set is degraded (config unreadable) — shown by the picker. */
  agentsNotice?: string;
  /** Valid effort levels, for the effort picker. */
  efforts: readonly string[];
  /** Existing prompt versions, so the human can see what they are superseding. */
  promptVersions: TaskPromptVersion[];
  /** Result of the last attempt, if any. */
  notice?: { text: string; error?: boolean };
  /** Codes shared by more than one task — this page's task links fall back to the id for those. */
  duplicatedCodes?: ReadonlySet<string>;
}

/**
 * The task edit page: goal + prompt for a task that has not started, and the
 * model/effort/agent controls that stay live for one that has.
 *
 * Plain form POST, no client-side framework: the markdown preview is the
 * SAVED-or-typed prompt rendered server-side above the textarea, which is what
 * makes it work with JavaScript off. The rules come from src/task-edit-rules.ts
 * — the same predicate the daemon enforces — so this page never offers a field
 * that would then be refused.
 */
export function taskEditHtml(
  task: Task,
  editability: TaskEditability,
  lockedReason: string | null,
  draft: TaskEditDraft,
  options: TaskEditOptions,
): string {
  const taskDisplayId = displayId(task);
  const taskHref = taskPath(task, options.duplicatedCodes);
  const breadcrumb = `<div class="breadcrumb"><a href="${taskHref}">Task ${escapeHtml(taskDisplayId)}</a> &rsaquo; Edit</div>`;

  const notice = options.notice
    ? `<div class="edit-notice${options.notice.error ? ' edit-notice-err' : ''}">${escapeHtml(options.notice.text)}</div>`
    : '';

  // Terminal: nothing is editable, so there is no form to show — only the
  // reason, in product language, and the way back.
  if (editability.terminal) {
    return layoutHtml(`Edit ${taskDisplayId}`, `
      ${breadcrumb}
      <h1>Edit task ${escapeHtml(taskDisplayId)}</h1>
      ${notice}
      <div class="edit-notice edit-notice-err">${escapeHtml(lockedReason ?? 'This task can no longer be edited.')}</div>
      <p><a href="${taskHref}">Back to the task</a></p>
    `);
  }

  const lockedBanner = lockedReason
    ? `<div class="edit-notice edit-notice-locked">${escapeHtml(lockedReason)}</div>`
    : '';

  const promptPreview = draft.prompt.trim()
    ? `<div class="turn-content edit-preview">${renderMarkdown(draft.prompt)}</div>`
    : `<p class="text-muted">No prompt yet — what you write below is rendered as Markdown for the agent.</p>`;

  const versionNote = options.promptVersions.length > 0
    ? `<p class="text-muted">Saving the prompt adds version ${options.promptVersions.length + 1}; earlier versions stay readable on the task page.</p>`
    : '';

  const goalPromptFields = editability.canEditLockedFields
    ? `
      <label class="edit-label" for="edit-goal">Goal</label>
      <input class="input" type="text" id="edit-goal" name="goal" value="${escapeHtml(draft.goal)}" required>

      <label class="edit-label" for="edit-prompt">Prompt <span class="text-muted">(Markdown)</span></label>
      <details class="edit-preview-wrap" open>
        <summary>Rendered prompt</summary>
        ${promptPreview}
      </details>
      <textarea class="input edit-prompt" id="edit-prompt" name="prompt" rows="18" spellcheck="true">${escapeHtml(draft.prompt)}</textarea>
      ${versionNote}
    `
    : `
      <div class="detail-row"><span class="detail-label">Goal</span><span>${escapeHtml(task.goal)}</span></div>
      <details class="edit-preview-wrap">
        <summary>Current prompt</summary>
        ${promptPreview}
      </details>
    `;

  const effortOptions = ['', ...options.efforts]
    .map((level) => {
      const label = level === '' ? '(unchanged)' : level;
      const selected = level === draft.effort ? ' selected' : '';
      return `<option value="${escapeHtml(level)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join('');

  const agentOptions = agentChoiceOptions(options.agents, draft.agent);

  return layoutHtml(`Edit ${taskDisplayId}`, `
    ${breadcrumb}
    <h1>Edit task ${escapeHtml(taskDisplayId)}</h1>
    ${notice}
    ${lockedBanner}
    <form class="edit-form" method="post" action="${taskHref}/edit">
      ${goalPromptFields}

      <h2>Next turn</h2>
      <p class="text-muted">These take effect the next time the agent runs.</p>

      <label class="edit-label" for="edit-model">Model</label>
      <input class="input" type="text" id="edit-model" name="model" value="${escapeHtml(draft.model)}" placeholder="(project default)">

      <label class="edit-label" for="edit-effort">Effort</label>
      <select class="input" id="edit-effort" name="effort">${effortOptions}</select>

      <label class="edit-label" for="edit-agent">Agent profile</label>
      <select class="input" id="edit-agent" name="agent">${agentOptions}</select>
      ${agentNoticeHtml(options.agentsNotice)}
      ${AGENT_PICKER_HINT}

      <div class="action-links">
        <button type="submit" class="btn btn-primary">Save changes</button>
        <a href="${taskHref}" class="btn">Cancel</a>
      </div>
    </form>
  `);
}

export interface TaskCreateOptions {
  /** Agent profiles this project offers, for the agent picker. */
  agents: readonly AgentChoice[];
  /** Set when the offered set is degraded (config unreadable) — shown by the picker. */
  agentsNotice?: string;
  efforts: readonly string[];
  types: readonly string[];
  /** Same live-task + branch list the reparent dialog uses. */
  parentTargets: TaskReparentTargets | null;
  notice?: { text: string; error?: boolean };
  /**
   * Where page-mode Cancel goes. Defaults to the task list; the Clusters page
   * passes its own path so cancelling an inline form does not throw the human
   * onto a different surface.
   */
  cancelHref?: string;
  /** Submit-button wording. Defaults to "Create task"; the Clusters page says "Create cluster". */
  submitLabel?: string;
}

/**
 * The create form body — shared by the full New-task page and the palette's
 * stay-on-page dialog (`?fragment=1`). Cancel is a link on the page and a
 * close-dialog button in the fragment so neither surface dead-ends.
 */
export function taskCreateFormHtml(
  draft: TaskCreateDraft,
  options: TaskCreateOptions,
  mode: 'page' | 'fragment' = 'page',
): string {
  const notice = options.notice
    ? `<div class="edit-notice${options.notice.error ? ' edit-notice-err' : ''}">${escapeHtml(options.notice.text)}</div>`
    : '';

  const suggested = deriveCode(draft.goal.trim()) ?? '';
  const codeHint = suggested
    ? `<p class="text-muted">Suggested from the goal: <code>${escapeHtml(suggested)}</code> — used if you leave this blank.</p>`
    : `<p class="text-muted">Lowercase letters, digits and hyphens, 2–63 characters. Leave blank to derive one from the goal, or to use the task id.</p>`;

  const promptPreview = draft.prompt.trim()
    ? `<div class="turn-content edit-preview">${renderMarkdown(draft.prompt)}</div>`
    : `<p class="text-muted">No prompt yet — what you write below is rendered as Markdown for the agent.</p>`;

  const typeOptions = options.types
    .map((t) => `<option value="${escapeHtml(t)}"${t === (draft.type || 'task') ? ' selected' : ''}>${escapeHtml(t)}</option>`)
    .join('');

  const effortOptions = ['', ...options.efforts]
    .map((level) => {
      const label = level === '' ? '(project default)' : level;
      const selected = level === draft.effort ? ' selected' : '';
      return `<option value="${escapeHtml(level)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join('');

  // One builder for all three: each is "(inherit)" plus its own vocabulary, and
  // three hand-rolled copies would be three chances for the empty option to
  // stop meaning "inherit".
  const inheritOptions = (values: readonly string[], chosen: string): string =>
    ['', ...values]
      .map((value) => {
        const label = value === '' ? '(inherit)' : value;
        const selected = value === chosen ? ' selected' : '';
        return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
      })
      .join('');
  const reviewOptions = inheritOptions(REVIEW_MODE_INPUTS, draft.review);
  const reviewGateOptions = inheritOptions(REVIEW_GATE_INPUTS, draft.reviewGate);
  const reviewAutoFixOptions = inheritOptions(REVIEW_TOGGLE_INPUTS, draft.reviewAutoFix);

  const agentOptions =
    `<option value=""${draft.agent ? '' : ' selected'}>(project default, or the parent’s agent for a subtask)</option>` +
    agentChoiceOptions(options.agents, draft.agent);

  const targets = options.parentTargets;
  const parentOptions = [
    ...(targets?.tasks ?? []).map((t) => {
      const label = t.code ?? t.id.slice(0, 8);
      return `<option value="${escapeHtml(t.code ?? t.id)}">${escapeHtml(label)} — ${escapeHtml(t.goal)}</option>`;
    }),
    ...(targets?.branches ?? []).map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`),
  ].join('');

  const startChecked = draft.startNow ? ' checked' : '';
  // Fragment lives inside a dialog: fewer prompt rows so the viewport fits,
  // and Cancel closes the dialog instead of leaving the page.
  const promptRows = mode === 'fragment' ? 10 : 18;
  const cancel = mode === 'fragment'
    ? `<button type="button" class="btn" data-lz-create-cancel>Cancel</button>`
    : `<a href="${escapeHtml(options.cancelHref ?? '/tasks')}" class="btn">Cancel</a>`;
  const heading = mode === 'fragment' ? `<h2 class="lz-create-dialog-title">New task</h2>` : '';
  // Autofocus only on the full page — the palette island focuses the goal
  // after it injects the fragment, and a second autofocus races that.
  const autofocus = mode === 'page' ? ' autofocus' : '';

  return `
    ${heading}
    ${notice}
    <form class="edit-form lz-action-form lz-create-form" method="post" action="/tasks/new" data-lz-action-form data-lz-action-when="start_now" data-lz-action-title="Starting task">
      <label class="edit-label" for="create-goal">Goal</label>
      <input class="input" type="text" id="create-goal" name="goal" value="${escapeHtml(draft.goal)}" required${autofocus}>

      <label class="edit-label" for="create-prompt">Prompt <span class="text-muted">(Markdown)</span></label>
      <details class="edit-preview-wrap" open>
        <summary>Rendered prompt</summary>
        ${promptPreview}
      </details>
      <textarea class="input edit-prompt" id="create-prompt" name="prompt" rows="${promptRows}" spellcheck="true">${escapeHtml(draft.prompt)}</textarea>

      <label class="edit-label" for="create-code">Code</label>
      <input class="input" type="text" id="create-code" name="code" value="${escapeHtml(draft.code)}" placeholder="${escapeHtml(suggested || 'kebab-case-code')}" autocomplete="off" spellcheck="false">
      ${codeHint}

      <label class="edit-label" for="create-parent">Parent</label>
      <input class="input" type="text" id="create-parent" name="parent" value="${escapeHtml(draft.parent)}" list="lz-create-parents" placeholder="Task code, id, or branch (e.g. main) — optional">
      <datalist id="lz-create-parents">${parentOptions}</datalist>
      <p class="text-muted">A task becomes a subtask of that parent. A branch name makes a top-level task targeting that branch. Leave blank for the repo default branch.</p>

      <label class="edit-label" for="create-type">Type</label>
      <select class="input" id="create-type" name="type">${typeOptions}</select>

      <h2>Agent</h2>
      <p class="text-muted">These are the same <code>[agents.&lt;name&gt;]</code> profiles <code>lazy create --agent</code> uses. Leave them on the project default unless you want a different one.</p>

      <label class="edit-label" for="create-agent">Agent profile</label>
      <select class="input" id="create-agent" name="agent">${agentOptions}</select>
      ${agentNoticeHtml(options.agentsNotice)}
      ${AGENT_PICKER_HINT}

      <label class="edit-label" for="create-model">Model</label>
      <input class="input" type="text" id="create-model" name="model" value="${escapeHtml(draft.model)}" placeholder="(project default)">

      <label class="edit-label" for="create-effort">Effort</label>
      <select class="input" id="create-effort" name="effort">${effortOptions}</select>

      <label class="edit-label" for="create-review">Review</label>
      <select class="input" id="create-review" name="review">${reviewOptions}</select>
      <p class="text-muted">How this task gets reviewed once it declares its work finished.
      <strong>Low-high</strong> (the default) is fast: the writer reviews its own work inside its
      own session, with the diff still in context, and nothing gates accept.
      <strong>Separate</strong> runs a reviewer afterwards in its own session and its verdict gates
      accept &mdash; three to four times the wall-clock and the tokens, so pick it when the stakes
      justify a second cold read. <strong>Off</strong> means no review at all.</p>

      <label class="edit-label" for="create-review-gate">Review gate</label>
      <select class="input" id="create-review-gate" name="review_gate">${reviewGateOptions}</select>
      <p class="text-muted">When a recorded review holds the merge. <strong>auto</strong> lets the
      mode decide, and a review you asked for always gates; <strong>always</strong> makes any
      recorded review gate, the low-high self-review included; <strong>never</strong> means none
      does.</p>

      <label class="edit-label" for="create-review-auto-fix">Review auto-fix</label>
      <select class="input" id="create-review-auto-fix" name="review_auto_fix">${reviewAutoFixOptions}</select>
      <p class="text-muted">In <strong>separate</strong> mode only: whether a review that found
      something starts a fix turn by itself. Off by default &mdash; the task parks with its
      findings and you decide whether a round is worth it.</p>

      <p class="text-muted">Leave any of the three on <strong>(inherit)</strong> to take the parent
      task's value, or the project's <code>[review]</code> setting for a top-level task.</p>

      <label class="edit-check" for="create-start-now">
        <input type="checkbox" id="create-start-now" name="start_now" value="1"${startChecked}>
        Start now
      </label>
      <p class="text-muted">Launches the first agent turn after creating the task. Leave unchecked to land it in the backlog. A prompt is required to start.</p>

      <div class="action-links">
        <button type="submit" class="btn btn-primary">${escapeHtml(options.submitLabel ?? 'Create task')}</button>
        ${cancel}
      </div>
    </form>`;
}

/**
 * The New-task page: the same fields `lazy create` takes, as a plain form.
 *
 * Look matches the edit page (stacked labels, markdown preview above the
 * prompt). Parent is the reparent datalist. A blank code is filled from the
 * goal by the daemon (`deriveCode`); the hint shows that suggestion when we
 * already have a goal. Start now POSTs through the action dialog when
 * scripting is on, because start narrates phases; without JS it is one POST.
 */
export function taskCreateHtml(draft: TaskCreateDraft, options: TaskCreateOptions): string {
  const breadcrumb = `<div class="breadcrumb"><a href="/tasks">Tasks</a> &rsaquo; New</div>`;
  return layoutHtml('New task', `
    ${breadcrumb}
    <h1>New task</h1>
    ${taskCreateFormHtml(draft, options, 'page')}
    ${actionDialogChromeHtml()}
    ${actionDialogScript()}
  `);
}

export interface TaskLinkOptions {
  /** Same live-task + branch list the create / reparent dialogs use. */
  parentTargets: TaskReparentTargets | null;
  notice?: { text: string; error?: boolean };
}

/**
 * The Link page: adopt a PR URL or git branch as a blocked task.
 *
 * Look matches New task. Linking always has phases, so the form always
 * uses the action dialog when scripting is on (`data-lz-action-when="always"`).
 * Without JS it is a plain POST.
 */
export function taskLinkHtml(draft: TaskLinkDraft, options: TaskLinkOptions): string {
  const breadcrumb = `<div class="breadcrumb"><a href="/tasks">Tasks</a> &rsaquo; Link</div>`;
  const notice = options.notice
    ? `<div class="edit-notice${options.notice.error ? ' edit-notice-err' : ''}">${escapeHtml(options.notice.text)}</div>`
    : '';

  const targets = options.parentTargets;
  const parentOptions = [
    ...(targets?.tasks ?? []).map((t) => {
      const label = t.code ?? t.id.slice(0, 8);
      return `<option value="${escapeHtml(t.code ?? t.id)}">${escapeHtml(label)} — ${escapeHtml(t.goal)}</option>`;
    }),
    ...(targets?.branches ?? []).map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`),
  ].join('');

  return layoutHtml('Link a branch or PR', `
    ${breadcrumb}
    <h1>Link a branch or PR</h1>
    ${notice}
    <form class="edit-form lz-action-form" method="post" action="/tasks/link" data-lz-action-form data-lz-action-when="always" data-lz-action-title="Linking…">
      <label class="edit-label" for="link-ref">Pull request or branch</label>
      <input class="input" type="text" id="link-ref" name="ref" value="${escapeHtml(draft.ref)}" required autofocus placeholder="https://github.com/org/repo/pull/12 or feature/auth" autocomplete="off" spellcheck="false">
      <p class="text-muted">A PR or MR URL, a branch page, <code>origin/feature/foo</code>, or a bare branch name. The task uses that existing branch and is not started.</p>

      <label class="edit-label" for="link-parent">Parent</label>
      <input class="input" type="text" id="link-parent" name="parent" value="${escapeHtml(draft.parent)}" list="lz-link-parents" placeholder="Task code or id — optional">
      <datalist id="lz-link-parents">${parentOptions}</datalist>
      <p class="text-muted">Nest the linked task under another task. Leave blank for a top-level task.</p>

      <label class="edit-label" for="link-code">Code</label>
      <input class="input" type="text" id="link-code" name="code" value="${escapeHtml(draft.code)}" placeholder="kebab-case-code (optional)" autocomplete="off" spellcheck="false">
      <p class="text-muted">Human-readable id. Leave blank and lazy derives one from the branch name.</p>

      <div class="action-links">
        <button type="submit" class="btn btn-primary">Link</button>
        <a href="/tasks" class="btn">Cancel</a>
      </div>
    </form>
    ${actionDialogChromeHtml()}
    ${actionDialogScript()}
  `);
}

/**
 * The commit detail page.
 *
 * Uses the same renderer as the review surface. There was a second one
 * (@pierre/diffs) here, which produced a prettier, syntax-highlighted diff but
 * moved every line into a Shadow DOM — nothing outside the shadow root can
 * address a line, which is why inline comments needed their own renderer in
 * the first place. Two diff components meant two looks, two sets of behaviour
 * (collapse, wrap) and one of them structurally unable to grow the feature the
 * surface exists for. So: one renderer.
 *
 * The side-by-side view this page used to offer is back, built into the shared
 * renderer, so it arrived here without a line of change on this page — which is
 * the payoff of having one renderer. Syntax highlighting is still the
 * outstanding cost.
 *
 * No comment affordances and no "Viewed" ticks here — this is a historical
 * commit, not a change under review.
 */
export function commitDetailHtml(
  task: Task,
  commit: Commit,
  diffText: string,
  /** Codes shared by more than one task — the breadcrumb falls back to the id for those. */
  duplicatedCodes?: ReadonlySet<string>,
): string {
  const taskDisplayId = displayId(task);
  const breadcrumb = `<div class="breadcrumb"><a href="${taskPath(task, duplicatedCodes)}">Task ${escapeHtml(taskDisplayId)}</a> &rsaquo; Commit</div>`;
  const files = parseUnifiedDiff(diffText);
  const renderedHtml = renderReviewDiff(files, new Map(), { allowComments: false, allowViewed: false });

  return layoutHtml(`Commit ${escapeHtml(commit.sha.substring(0, 8))}`, `
    ${breadcrumb}
    <h1>Commit ${escapeHtml(commit.sha.substring(0, 8))}</h1>
    <div class="detail-section">
      <div class="detail-row"><span class="detail-label">SHA</span><span>${escapeHtml(commit.sha)}</span></div>
      <div class="detail-row"><span class="detail-label">Message</span><span>${escapeHtml(commit.message)}</span></div>
      <div class="detail-row"><span class="detail-label">Status</span><span>${statusBadge(commit.status)}</span></div>
      <div class="detail-row"><span class="detail-label">Time</span><span>${escapeHtml(formatDate(commit.timestamp))}</span></div>
    </div>
    ${diffViewOptionsHtml()}
    <div id="commit-diff">${renderedHtml}</div>
    ${diffViewScript('#commit-diff')}
    ${/* Collapse without persistence: a historical commit is not a change
          being worked through, so there is nothing to tick off. */ ''}
    ${viewedStateScript(null)}
  `);
}

/** The search box, pre-filled with the current query. */
function searchFormHtml(query: string): string {
  return `
      <form action="/search" method="get">
        <input class="input" type="text" name="q" value="${escapeHtml(query)}" placeholder="task:spike, status:blocked AND in:turns &quot;reconciler&quot;, or plain text" style="width:100%;max-width:640px" autofocus />
      </form>`;
}

/**
 * The query-language cheat sheet, rendered from the SAME data `lazy search
 * --help` prints (src/search/grammar.ts). Inline and expandable rather than a
 * link out: the human is mid-query, and a grammar they have to leave the page
 * to read is a grammar they do not use.
 */
function searchGrammarHtml(open: boolean): string {
  const docsHref = docsUrl('search');
  const sections = GRAMMAR_SECTIONS.map(section => `
      <div class="search-help-section">
        <h3>${escapeHtml(section.title)}</h3>
        <dl class="search-help-list">
          ${section.entries.map(e => `
          <dt><code>${escapeHtml(e.syntax)}</code></dt>
          <dd>${escapeHtml(e.summary)}</dd>`).join('')}
        </dl>
      </div>`).join('');

  // Each example is a link that runs itself — one click beats copy-then-paste,
  // and the text stays selectable for anyone who wants it on the CLI.
  const examples = GRAMMAR_EXAMPLES.map(ex => `
        <li>
          <a class="search-help-example" href="/search?q=${encodeURIComponent(ex.query)}"><code>${escapeHtml(ex.query)}</code></a>
          <span class="text-muted">${escapeHtml(ex.summary)}</span>
        </li>`).join('');

  const notes = GRAMMAR_NOTES.map(n => `<li>${escapeHtml(n)}</li>`).join('');

  return `
    <details class="search-help"${open ? ' open' : ''}>
      <summary>Query syntax</summary>
      <div class="search-help-body">
        ${sections}
        <div class="search-help-section">
          <h3>Good to know</h3>
          <ul class="search-help-notes">${notes}</ul>
        </div>
        <div class="search-help-section">
          <h3>Examples</h3>
          <ul class="search-help-examples">${examples}</ul>
        </div>
        ${docsHref ? `<p class="text-muted">Full reference: <a href="${escapeHtml(docsHref)}">Searching tasks</a>.</p>` : ''}
      </div>
    </details>`;
}

export function searchResultsHtml(
  results: SearchResult[],
  query: string,
  error?: string,
  hint?: string,
  /** Codes shared by more than one task — duplicated-code links fall back to the id. */
  duplicatedCodes?: ReadonlySet<string>,
): string {
  if (error) {
    return layoutHtml('Search', `
      <h1>Search: ${escapeHtml(query)}</h1>
      <div class="empty-state">${escapeHtml(error)}</div>
      ${searchFormHtml(query)}
      ${searchGrammarHtml(true)}
    `);
  }

  if (!query) {
    return layoutHtml('Search', `
      <h1>Search</h1>
      ${searchFormHtml('')}
      ${searchGrammarHtml(true)}
    `);
  }

  if (results.length === 0) {
    return layoutHtml('Search', `
      <h1>Search: ${escapeHtml(query)}</h1>
      ${searchFormHtml(query)}
      <div class="empty-state">No results found for "${escapeHtml(query)}"</div>
      ${hint ? `<div class="search-hint">${escapeHtml(hint)}</div>` : ''}
      ${searchGrammarHtml(true)}
    `);
  }

  const resultItems = results.map(r => {
    const href = searchResultHref(r, duplicatedCodes);
    const rDisplayId = r.task_code
      ?? (r.entity_type === 'conversation' || r.entity_type === 'memory'
        ? shortId(r.entity_id)
        : shortId(r.task_id));
    // A turn hit knows its sequence, and the turn detail route is keyed by
    // sequence — so link the hit straight at the turn instead of dropping the
    // reader on the task page to hunt for the excerpt. Conversations and
    // memories are not tasks; their primary link is the entity itself.
    const typeLabel = r.entity_type === 'turn' && r.turn_sequence !== undefined
      ? `<a class="search-result-type" href="${escapeHtml(href)}">turn #${r.turn_sequence}</a>`
      : `<span class="search-result-type">${escapeHtml(r.entity_type)}</span>`;
    return `
    <div class="search-result">
      ${typeLabel}
      <a href="${escapeHtml(href)}">${escapeHtml(rDisplayId)}</a>
      &mdash; ${escapeHtml(r.task_goal)}
      <div class="search-result-context">${escapeHtml(r.match_context)}</div>
    </div>
  `;
  }).join('');

  return layoutHtml(`Search: ${query}`, `
    <h1>Search: ${escapeHtml(query)}</h1>
    ${searchFormHtml(query)}
    ${searchGrammarHtml(false)}
    <p class="text-muted" style="margin-bottom:16px">${results.length} result${results.length === 1 ? '' : 's'}</p>
    ${resultItems}
  `);
}

export interface ActiveTaskInfo {
  task: Task;
  session: Session | null;
  lastTurnSummary: string;
}

export interface ChartDataPoint {
  date: string;
  backlog: number;      // Backlog size at end of day (snapshot)
  completed: number;    // Tasks accepted that day (daily count)
  closed: number;       // Tasks abandoned that day (daily count)
  submitted: number;    // Tasks opened as a PR that day (daily count)
}

export interface ActivityDay {
  date: string;
  humanTurns: number;
  agentTurns: number;
  tasksAccepted: number;
}

export interface ActiveStates {
  working: number;
  blocked: number;
  interrupted: number;
  merging: number;
  pairing: number;
  submitted: number;
}

export interface DashboardStats {
  totalTasks: number;
  workingCount: number;
  blockedCount: number;
  interruptedCount: number;
  completedCount: number;
  submittedCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalDurationMs: number;
  recentlyCreatedTasks: TaskWithSession[];
  activeTasks: ActiveTaskInfo[];
  blockedTasks: TaskWithSession[];
  chartData: ChartDataPoint[];
  activityData: ActivityDay[];
  activeStates: ActiveStates;
  /**
   * Unread system messages, newest first. Server-rendered here (rather than
   * left to the nav badge) so the signal survives with scripting off — this is
   * the surface that tells the human something was filed for them.
   */
  unreadMessages: SystemMessage[];
  /**
   * Pre-rendered usage-pause status line (src/server/usage-pause-banner.ts):
   * paused credentials, and ones the pause is armed for with no reading.
   * Empty when there is nothing to say or the daemon did not supply it.
   */
  usagePauseHtml?: string;
}

function computeThresholds(values: number[]): [number, number, number] {
  const nonZero = values.filter(v => v > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return [1, 2, 3];

  const max = nonZero[nonZero.length - 1];
  if (max <= 4) return [1, 2, 3];

  function pctValue(p: number): number {
    return nonZero[Math.min(Math.floor(nonZero.length * p), nonZero.length - 1)];
  }

  let t1 = pctValue(0.25);
  let t2 = pctValue(0.50);
  let t3 = pctValue(0.75);

  // If all non-zero values are the same, fall back to linear divisions
  if (t1 === t3) {
    return [
      Math.max(1, Math.floor(max / 4)),
      Math.max(1, Math.floor(max / 2)),
      Math.max(1, Math.floor(max * 3 / 4)),
    ];
  }

  // Ensure strictly increasing thresholds
  if (t2 <= t1) t2 = t1 + 1;
  if (t3 <= t2) t3 = t2 + 1;
  // Ensure the max value always gets the darkest shade
  if (t3 >= max) t3 = max - 1;
  if (t2 >= t3) t2 = Math.floor((t1 + t3) / 2);

  return [t1, t2, t3];
}

function activityHeatmapSectionHtml(activityData: ActivityDay[]): string {
  const dataMap = new Map<string, ActivityDay>();
  for (const day of activityData) {
    dataMap.set(day.date, day);
  }

  const NUM_WEEKS = 26;
  const CELL_SIZE = 13;
  const GAP = 3;
  const CELL_STEP = CELL_SIZE + GAP;

  // Compute today (UTC)
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  // Find this week's Monday
  const todayDow = new Date(todayMs).getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysFromMonday = todayDow === 0 ? 6 : todayDow - 1;
  const thisMondayMs = todayMs - daysFromMonday * 86400000;

  // Start from (NUM_WEEKS - 1) weeks before this Monday
  const startMs = thisMondayMs - (NUM_WEEKS - 1) * 7 * 86400000;

  function fmtDate(ms: number): string {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  // Compute dynamic thresholds from actual data distribution
  const humanValues = activityData.map(d => d.humanTurns);
  const acceptedValues = activityData.map(d => d.tasksAccepted);
  const humanThresholds = computeThresholds(humanValues);
  const acceptedThresholds = computeThresholds(acceptedValues);
  const maxHuman = Math.max(0, ...humanValues);
  const maxAccepted = Math.max(0, ...acceptedValues);
  const nonZeroHuman = humanValues.filter(v => v > 0);
  const nonZeroAccepted = acceptedValues.filter(v => v > 0);
  const minHuman = nonZeroHuman.length > 0 ? Math.min(...nonZeroHuman) : 0;
  const minAccepted = nonZeroAccepted.length > 0 ? Math.min(...nonZeroAccepted) : 0;

  function greenColor(count: number): string {
    if (count === 0) return 'var(--hm-empty)';
    if (count <= humanThresholds[0]) return 'var(--hm-g1)';
    if (count <= humanThresholds[1]) return 'var(--hm-g2)';
    if (count <= humanThresholds[2]) return 'var(--hm-g3)';
    return 'var(--hm-g4)';
  }

  function orangeColor(count: number): string {
    if (count === 0) return 'var(--hm-empty)';
    if (count <= acceptedThresholds[0]) return 'var(--hm-o1)';
    if (count <= acceptedThresholds[1]) return 'var(--hm-o2)';
    if (count <= acceptedThresholds[2]) return 'var(--hm-o3)';
    return 'var(--hm-o4)';
  }

  // Generate cells (column-first: for each week, output Mon..Sun)
  // and track month boundaries for labels
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabels: { label: string; column: number }[] = [];
  let prevMonth = -1;
  let cellsHtml = '';

  for (let w = 0; w < NUM_WEEKS; w++) {
    const weekStartMs = startMs + w * 7 * 86400000;
    const mondayMonth = new Date(weekStartMs).getUTCMonth();

    if (mondayMonth !== prevMonth) {
      monthLabels.push({ label: monthNames[mondayMonth], column: w });
      prevMonth = mondayMonth;
    }

    for (let d = 0; d < 7; d++) {
      const dayMs = weekStartMs + d * 86400000;
      if (dayMs > todayMs) {
        cellsHtml += '<div class="hm-day"></div>';
        continue;
      }

      const dateStr = fmtDate(dayMs);
      const data = dataMap.get(dateStr);
      const h = data?.humanTurns ?? 0;
      const a = data?.agentTurns ?? 0;
      const ta = data?.tasksAccepted ?? 0;

      const tip = `${dateStr}: ${h} human turn${h !== 1 ? 's' : ''}, ${ta} task${ta !== 1 ? 's' : ''} accepted`;

      cellsHtml += `<div class="hm-day hm-active" title="${escapeHtml(tip)}" data-date="${escapeHtml(dateStr)}" data-h="${h}" data-a="${a}" data-ta="${ta}" onclick="showDayReport(this)"><div class="hm-l" style="background:${greenColor(h)}"></div><div class="hm-r" style="background:${orangeColor(ta)}"></div></div>`;
    }
  }

  // Month labels (absolutely positioned)
  const monthLabelHtml = monthLabels.map(({ label, column }) =>
    `<span style="position:absolute;left:${column * CELL_STEP}px">${escapeHtml(label)}</span>`
  ).join('');

  // Day-of-week labels (Mon, Wed, Fri visible; others blank for spacing)
  const dayLabels = ['Mon', '', 'Wed', '', 'Fri', '', ''];
  const dayLabelHtml = dayLabels.map(label =>
    `<div style="height:${CELL_SIZE}px;line-height:${CELL_SIZE}px">${escapeHtml(label)}</div>`
  ).join('');

  // Scale legend with dynamic threshold ranges
  function rangeLabel(low: number, high: number): string {
    return low === high ? `${low}` : `${low}\u2013${high}`;
  }

  function legendSwatches(
    thresholds: [number, number, number],
    max: number,
    cssPrefix: string,
  ): string {
    if (max === 0) {
      return [
        `<span class="hm-swatch" style="background:var(--${escapeHtml(cssPrefix)}1)" title="—"></span>`,
        `<span class="hm-swatch" style="background:var(--${escapeHtml(cssPrefix)}2)" title="—"></span>`,
        `<span class="hm-swatch" style="background:var(--${escapeHtml(cssPrefix)}3)" title="—"></span>`,
        `<span class="hm-swatch" style="background:var(--${escapeHtml(cssPrefix)}4)" title="—"></span>`,
      ].join('');
    }
    return [
      `<span class="hm-swatch" style="background:var(--${escapeHtml(cssPrefix)}1)" title="${rangeLabel(1, thresholds[0])}"></span>`,
      `<span class="hm-swatch" style="background:var(--${escapeHtml(cssPrefix)}2)" title="${rangeLabel(thresholds[0] + 1, thresholds[1])}"></span>`,
      `<span class="hm-swatch" style="background:var(--${escapeHtml(cssPrefix)}3)" title="${rangeLabel(thresholds[1] + 1, thresholds[2])}"></span>`,
      `<span class="hm-swatch" style="background:var(--${escapeHtml(cssPrefix)}4)" title="${thresholds[2] + 1}+"></span>`,
    ].join('');
  }

  const legendHtml = `
    <div class="hm-legend-scale">
      <div class="hm-legend-group">
        <div class="hm-legend-title">Human turns</div>
        <div class="hm-legend-bar">
          <span class="hm-legend-text">${minHuman}</span>
          ${legendSwatches(humanThresholds, maxHuman, 'hm-g')}
          <span class="hm-legend-text">${maxHuman}</span>
        </div>
      </div>
      <div class="hm-legend-group">
        <div class="hm-legend-title">Tasks accepted</div>
        <div class="hm-legend-bar">
          <span class="hm-legend-text">${minAccepted}</span>
          ${legendSwatches(acceptedThresholds, maxAccepted, 'hm-o')}
          <span class="hm-legend-text">${maxAccepted}</span>
        </div>
      </div>
    </div>
  `;

  return `
    <div class="detail-section">
      <h2>Activity</h2>
      <div style="display:flex;gap:24px;align-items:flex-start">
        <div class="hm-scroll" style="flex:1;min-width:0">
          <div style="display:inline-block">
            <div class="hm-months" style="margin-left:35px;position:relative;height:18px;margin-bottom:4px">
              ${monthLabelHtml}
            </div>
            <div style="display:flex;gap:4px">
              <div class="hm-day-labels" style="display:flex;flex-direction:column;gap:${GAP}px">
                ${dayLabelHtml}
              </div>
              <div style="display:grid;grid-template-rows:repeat(7,${CELL_SIZE}px);grid-auto-flow:column;gap:${GAP}px">
                ${cellsHtml}
              </div>
            </div>
          </div>
        </div>
        ${legendHtml}
      </div>
      <div id="day-report" class="hm-report" style="display:none">
        <h3 id="dr-date"></h3>
        <div class="hm-report-stats">
          <div><strong id="dr-h">0</strong> human turns</div>
          <div><strong id="dr-a">0</strong> agent turns</div>
          <div><strong id="dr-ta">0</strong> tasks accepted</div>
        </div>
      </div>
    </div>
  `;
}

/**
 * "Unread messages" on the dashboard.
 *
 * Rendered only when there is something unread — the dashboard reports what IS,
 * not every channel that could have something. Titles only, linking into the
 * inbox: the body is read on demand, exactly as every other compact surface
 * treats a system message.
 */
function unreadMessagesSection(messages: SystemMessage[]): string {
  if (messages.length === 0) return '';
  const items = messages
    .slice()
    .sort((a, b) => b.created_at - a.created_at)
    .map((m) => `
      <div class="msg-panel-item">
        <span class="tag ${m.kind === 'alert' ? 'tag-warning' : m.kind === 'report' ? 'tag-accent' : 'tag-neutral'}" title="${escapeHtml(SYSTEM_MESSAGE_KIND_MEANING[m.kind] ?? '')}">${escapeHtml(m.kind)}</span>
        <a href="/messages/${escapeHtml(encodeURIComponent(m.id))}">${escapeHtml(m.title)}</a>
        <span class="msg-panel-meta">${escapeHtml(shortMessageId(m.id))} · from ${escapeHtml(m.source)} · ${escapeHtml(formatDate(m.created_at))}</span>
      </div>`)
    .join('');
  return `
    <div class="detail-section">
      <h2>Unread Messages (${messages.length})</h2>
      ${items}
      <div style="margin-top:12px"><a href="/messages">Open inbox &rarr;</a></div>
    </div>
  `;
}

export function dashboardHtml(
  stats: DashboardStats,
  /** Codes shared by more than one task — task links fall back to the id for those. */
  duplicatedCodes?: ReadonlySet<string>,
): string {
  const statCards = `
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-value">${stats.totalTasks}</div>
        <div class="stat-label">Total Tasks</div>
      </div>
      <a href="/tasks?filter=working" class="stat-card stat-card-link">
        <div class="stat-value" style="color:var(--color-accent)">${stats.workingCount}</div>
        <div class="stat-label">Working</div>
      </a>
      <a href="/tasks?filter=blocked" class="stat-card stat-card-link">
        <div class="stat-value" style="color:var(--color-warning)">${stats.blockedCount}</div>
        <div class="stat-label">Blocked</div>
      </a>
      <a href="/tasks?filter=interrupted" class="stat-card stat-card-link">
        <div class="stat-value" style="color:var(--color-violet-800)">${stats.interruptedCount}</div>
        <div class="stat-label">Interrupted</div>
      </a>
      <a href="/tasks?filter=submitted" class="stat-card stat-card-link">
        <div class="stat-value" style="color:var(--color-indigo-800)">${stats.submittedCount}</div>
        <div class="stat-label">Submitted</div>
      </a>
      <div class="stat-card">
        <div class="stat-value" style="color:var(--color-success)">${stats.completedCount}</div>
        <div class="stat-label">Completed</div>
      </div>
    </div>
  `;

  const usageSummary = `
    <div class="detail-section">
      <h2>Resource Usage</h2>
      <div class="detail-row"><span class="detail-label">Total Tokens In</span><span>${escapeHtml(formatTokenCount(stats.totalTokensIn))}</span></div>
      <div class="detail-row"><span class="detail-label">Total Tokens Out</span><span>${escapeHtml(formatTokenCount(stats.totalTokensOut))}</span></div>
      <div class="detail-row"><span class="detail-label">Total Duration</span><span>${escapeHtml(formatDuration(stats.totalDurationMs))}</span></div>
    </div>
  `;

  // Daily throughput chart with active states sidebar
  const chartDataJson = scriptJson(stats.chartData);
  const chartSection = `
    <div class="detail-section">
      <div style="display:flex;gap:20px;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <h2>Daily Task Throughput</h2>
          <div style="position:relative;height:300px">
            <canvas id="tasksChart"></canvas>
          </div>
        </div>
        <div style="flex-shrink:0;width:180px">
          <h3 class="text-muted" style="margin-top:0;font-size:14px">Active States</h3>
          <div class="state-rail">
            ${stateRow('working', 'Working', stats.activeStates.working)}
            ${stateRow('blocked', 'Blocked', stats.activeStates.blocked)}
            ${stateRow('interrupted', 'Interrupted', stats.activeStates.interrupted)}
            ${stateRow('merging', 'Merging', stats.activeStates.merging)}
            ${stateRow('pairing', 'Pairing', stats.activeStates.pairing)}
            ${stateRow('submitted', 'Submitted', stats.activeStates.submitted)}
            ${Object.values(stats.activeStates).every(n => n === 0) ? `
              <div class="empty-state" style="padding:var(--space-4);font-size:12px">No active tasks</div>
            ` : ''}
          </div>
        </div>
      </div>
    </div>
  `;

  // Active/Working Tasks table
  const activeSection = stats.activeTasks.length > 0 ? `
    <div class="detail-section">
      <h2>Active Tasks (${stats.activeTasks.length})</h2>
      <table class="table">
        <thead><tr>${forgeColumnHeader()}<th>Code</th><th>Duration</th><th>Last Active</th><th>Last Turn</th><th>Goal</th></tr></thead>
        <tbody>
          ${stats.activeTasks.map(({ task, session, lastTurnSummary }) => {
            const duration = session ? formatDuration(session.total_duration_ms) : '-';
            const lastActive = session?.last_interaction_at ? formatDate(session.last_interaction_at) : '-';
            const turnPreview = lastTurnSummary
              ? escapeHtml(lastTurnSummary.substring(0, 80)) + (lastTurnSummary.length > 80 ? '...' : '')
              : '-';
            return `<tr>
              ${forgeColumnCell(task)}
              <td><a href="${taskPath(task, duplicatedCodes)}">${escapeHtml(displayId(task))}</a></td>
              <td>${escapeHtml(duration)}</td>
              <td>${escapeHtml(lastActive)}</td>
              <td class="wrap text-muted" style="max-width:250px;font-size:12px">${turnPreview}</td>
              <td class="goal">${linkedBadgeHtml(task)}${escapeHtml(task.goal)}</td>
            </tr>`;
          }).join('\n')}
        </tbody>
      </table>
    </div>
  ` : '';

  // Blocked tasks needing attention
  const blockedSection = stats.blockedTasks.length > 0 ? `
    <div class="detail-section">
      <h2>Needs Attention (${stats.blockedTasks.length})</h2>
      <table class="table">
        <thead><tr>${forgeColumnHeader()}<th>Code</th><th>Status</th><th>Last Active</th><th>Goal</th></tr></thead>
        <tbody>
          ${stats.blockedTasks.map(({ task, session }) => {
            const status = getTaskStatus(task, session);
            const lastActive = session?.last_interaction_at ? formatDate(session.last_interaction_at) : '-';
            return `<tr>
              ${forgeColumnCell(task)}
              <td><a href="${taskPath(task, duplicatedCodes)}">${escapeHtml(displayId(task))}</a></td>
              <td>${statusBadge(status)} <a class="review-link" href="${taskPath(task, duplicatedCodes)}">review &rarr;</a></td>
              <td>${escapeHtml(lastActive)}</td>
              <td class="goal">${linkedBadgeHtml(task)}${escapeHtml(task.goal)}</td>
            </tr>`;
          }).join('\n')}
        </tbody>
      </table>
    </div>
  ` : '';

  // Recently Created Tasks (last 24h)
  const recentSection = stats.recentlyCreatedTasks.length > 0 ? `
    <div class="detail-section">
      <h2>Recently Created (last 24h)</h2>
      <table class="table">
        <thead><tr>${forgeColumnHeader()}<th>Code</th><th>Status</th><th>Created</th><th>Goal</th></tr></thead>
        <tbody>
          ${stats.recentlyCreatedTasks.map(({ task, session }) => {
            const status = getTaskStatus(task, session);
            return `<tr>
              ${forgeColumnCell(task)}
              <td><a href="${taskPath(task, duplicatedCodes)}">${escapeHtml(displayId(task))}</a></td>
              <td>${statusBadge(status)}</td>
              <td>${escapeHtml(formatDate(task.created_at))}</td>
              <td class="goal">${escapeHtml(task.goal)}</td>
            </tr>`;
          }).join('\n')}
        </tbody>
      </table>
    </div>
  ` : '';

  const viewAllLink = stats.totalTasks > 0
    ? `<div style="margin-top:12px;margin-bottom:24px"><a href="/tasks">View all tasks &rarr;</a></div>`
    : `<div class="detail-section"><div class="empty-state">No tasks yet. Create one with <code>lazy create</code>.</div></div>`;

  // Chart.js script (loaded from CDN, no build step)
  const chartScript = `
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
    <script>
      (function() {
        var data = ${chartDataJson};
        if (!data.length) return;

        // Chart.js paints on a canvas, so it needs concrete colours, not tokens.
        // Resolving them through a probe element's computed 'color' is what makes
        // color-mix() and var() usable here — and it means the chart follows the
        // stylesheet (including its dark-mode retune) with no palette of its own.
        var probe = document.createElement('span');
        probe.style.display = 'none';
        document.body.appendChild(probe);
        function token(expr) {
          probe.style.color = '';
          probe.style.color = expr;
          return getComputedStyle(probe).color;
        }
        var gridColor = token('color-mix(in srgb, var(--color-text) 10%, transparent)');
        var textColor = token('color-mix(in srgb, var(--color-text) 55%, transparent)');
        var neutralColor = token('var(--color-neutral-500)');
        var successColor = token('var(--color-success)');
        var dangerColor = token('var(--color-danger)');
        var submittedColor = token('var(--color-indigo-800)');
        var fontMono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
        probe.remove();

        var ctx = document.getElementById('tasksChart');
        new Chart(ctx, {
          type: 'line',
          data: {
            labels: data.map(function(d) { return d.date; }),
            datasets: [
              {
                label: 'Backlog',
                data: data.map(function(d) { return d.backlog; }),
                borderColor: neutralColor,
                backgroundColor: token('color-mix(in srgb, var(--color-neutral-500) 12%, transparent)'),
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: neutralColor,
                tension: 0.2
              },
              {
                label: 'Submitted',
                data: data.map(function(d) { return d.submitted; }),
                borderColor: submittedColor,
                backgroundColor: token('color-mix(in srgb, var(--color-indigo-800) 12%, transparent)'),
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: submittedColor,
                tension: 0.2
              },
              {
                label: 'Completed',
                data: data.map(function(d) { return d.completed; }),
                borderColor: successColor,
                backgroundColor: token('color-mix(in srgb, var(--color-success) 12%, transparent)'),
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: successColor,
                tension: 0.2
              },
              {
                label: 'Abandoned',
                data: data.map(function(d) { return d.closed; }),
                borderColor: dangerColor,
                backgroundColor: token('color-mix(in srgb, var(--color-danger) 12%, transparent)'),
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: dangerColor,
                tension: 0.2
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { labels: { color: textColor, font: { family: fontMono, size: 11 } } }
            },
            scales: {
              x: {
                grid: { color: gridColor },
                ticks: { color: textColor, maxRotation: 45, font: { size: 10 } }
              },
              y: {
                beginAtZero: true,
                grid: { color: gridColor },
                ticks: { color: textColor, stepSize: 1, font: { size: 10 } }
              }
            }
          }
        });
      })();
    </script>
    <script>setTimeout(function() { location.reload(); }, 30000);</script>
    <script>
    function showDayReport(el) {
      document.getElementById('dr-date').textContent = el.getAttribute('data-date');
      document.getElementById('dr-h').textContent = el.getAttribute('data-h');
      document.getElementById('dr-a').textContent = el.getAttribute('data-a');
      document.getElementById('dr-ta').textContent = el.getAttribute('data-ta');
      document.getElementById('day-report').style.display = 'block';
      var prev = document.querySelectorAll('.hm-selected');
      for (var i = 0; i < prev.length; i++) prev[i].classList.remove('hm-selected');
      el.classList.add('hm-selected');
    }
    </script>
  `;


  return layoutHtml('Dashboard', `
    <h1>Dashboard</h1>
    ${statCards}
    ${stats.usagePauseHtml ?? ''}
    ${unreadMessagesSection(stats.unreadMessages)}
    ${activityHeatmapSectionHtml(stats.activityData)}
    ${usageSummary}
    ${chartSection}
    ${activeSection}
    ${blockedSection}
    ${recentSection}
    ${viewAllLink}
    ${chartScript}
  `);
}

export function errorHtml(title: string, message: string): string {
  return layoutHtml(title, `
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="/">Back to dashboard</a></p>
  `);
}
