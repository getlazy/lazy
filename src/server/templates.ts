/**
 * HTML templates for the lazy server
 *
 * Server-rendered HTML with inline CSS. No frontend build step needed.
 */

import type { Task, Session, Turn, Commit, Comment, JournalEntry, FollowUp, SearchResult, TaskPromptVersion } from '../storage';
import type { TokenUsage } from '../types';
import { renderMarkdown } from './markdown';
import {
  parseUnifiedDiff,
  renderReviewDiff,
  diffViewOptionsHtml,
  diffViewScript,
} from './review-diff';
import { STYLESHEET_PATH } from './styles';
import { parentTaskIdOf } from '../task-target';
import { groupTurnsIntoChunks } from '../utils/turn-chunks';
import { turnText } from '../utils/turn-content';
import { formatTurnLaunchLabels, NO_LAUNCH_LABEL } from '../utils/turn-labels';
import {
  protectionMarkers,
  protectionHeadline,
  protectionSummary,
  protectionAdvice,
  PROTECTION_MARKER_LEGEND,
  type TaskProtectionStatus,
} from '../protection/status';

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
 * The protection badge for a table row: the shared `[P]` / `[P][A]` markers,
 * with the shared phrasing as the tooltip. Empty string when nothing is gated.
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

function displayId(task: Task): string {
  return task.code ?? shortId(task.id);
}

function formatDate(ts: number): string {
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    working: '#2563eb',
    blocked: '#d97706',
    conflict: '#ea580c',
    interrupted: '#9333ea',
    complete: '#16a34a',
    abandoned: '#dc2626',
    accepted: '#16a34a',
    rejected: '#dc2626',
    ended: '#6b7280',
  };
  const color = colors[status] ?? '#6b7280';
  return `<span class="badge" style="background:${color}">${escapeHtml(status)}</span>`;
}

function getTaskStatus(task: Task, session: Session | null): string {
  if (session) {
    return session.outcome ?? (session.ended_at ? 'ended' : task.status);
  }
  return task.status;
}

export function layoutHtml(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - Lazy</title>
  <link rel="stylesheet" href="${STYLESHEET_PATH}">
</head>
<body>
  <nav>
    <span class="brand"><a href="/">lazy</a></span>
    <span class="sep">|</span>
    <a href="/">dashboard</a>
    <a href="/tasks">tasks</a>
    <a href="/review">review</a>
    <a href="/search">search</a>
    <form class="search-form" action="/search" method="get">
      <input type="text" name="q" placeholder="search..." />
    </form>
  </nav>
  ${content}
</body>
</html>`;
}

export function taskListHtml(
  tasksWithSessions: TaskWithSession[],
  filter: string,
  sortField: string = 'created',
  sortDirection: string = 'desc',
): string {
  const filters = [
    { key: '', label: 'All Active' },
    { key: 'all', label: 'All' },
    { key: 'working', label: 'Working' },
    { key: 'interrupted', label: 'Interrupted' },
    { key: 'blocked', label: 'Blocked' },
  ];

  // Preserve sort param in filter links
  const sortParam = sortField !== 'created' || sortDirection !== 'desc'
    ? `&sort=${sortDirection === 'desc' ? '-' : ''}${sortField}`
    : '';

  const filterBar = `<div class="filter-bar">${filters.map(f =>
    `<a href="/tasks?filter=${f.key}${sortParam}" class="${filter === f.key ? 'active' : ''}">${f.label}</a>`
  ).join('')}</div>`;

  if (tasksWithSessions.length === 0) {
    return layoutHtml('Tasks', `
      <h1>Tasks</h1>
      ${filterBar}
      <div class="empty-state">No tasks found.</div>
    `);
  }

  // Build sortable column header
  const sortableColumns: { field: string; label: string }[] = [
    { field: 'status', label: 'Status' },
    { field: 'agent', label: 'Agent' },
    { field: 'model', label: 'Model' },
    { field: 'turns', label: 'Turns' },
    { field: 'last_active', label: 'Last Active' },
    { field: 'duration', label: 'Duration' },
    { field: 'tokens', label: 'Tokens' },
    { field: 'goal', label: 'Goal' },
  ];

  function columnHeader(field: string, label: string): string {
    const isActive = sortField === field;
    // Clicking active column toggles direction; clicking inactive column uses default direction
    const newDir = isActive
      ? (sortDirection === 'desc' ? '' : '-')
      : '-'; // default to DESC for new column
    const indicator = isActive ? (sortDirection === 'desc' ? ' ▼' : ' ▲') : '';
    const href = `/tasks?filter=${filter}&sort=${newDir}${field}`;
    return `<th><a href="${href}" class="sort-link${isActive ? ' sort-active' : ''}">${label}${indicator}</a></th>`;
  }

  const rows = tasksWithSessions.map(({ task, session, turnCount, protection }) => {
    const status = getTaskStatus(task, session);
    const lastActive = session?.last_interaction_at ? formatDate(session.last_interaction_at) : '-';
    const duration = session ? formatDuration(session.total_duration_ms) : '-';
    const tokens = formatTokenUsage(session?.total_usage ?? null);
    const turns = turnCount !== undefined && turnCount > 0 ? String(turnCount) : '-';

    // A task the human has to act on gets a direct link to the review page —
    // that page IS the pull request here, and hunting for it via task detail
    // was the slowest step in the whole loop.
    const reviewLink = (status === 'blocked' || status === 'conflict')
      ? ` <a class="review-link" href="/review/${task.id}" title="Review changes">review →</a>`
      : '';
    return `<tr>
      <td><a href="/tasks/${task.id}">${escapeHtml(displayId(task))}</a></td>
      <td>${statusBadge(status)}${reviewLink}</td>
      <td>${escapeHtml(task.agent_id)}</td>
      <td>${escapeHtml(task.model ?? '-')}</td>
      <td>${escapeHtml(turns)}</td>
      <td>${escapeHtml(lastActive)}</td>
      <td>${escapeHtml(duration)}</td>
      <td>${escapeHtml(tokens)}</td>
      <td class="goal">${protectionBadge(protection)}${escapeHtml(task.goal)}</td>
    </tr>`;
  }).join('\n');

  const anyProtected = tasksWithSessions.some(t => t.protection && protectionMarkers(t.protection));
  const legend = anyProtected
    ? `<div class="protection-legend">${escapeHtml(PROTECTION_MARKER_LEGEND)}</div>`
    : '';


  return layoutHtml('Tasks', `
    <h1>Tasks</h1>
    ${filterBar}
    <table>
      <thead>
        <tr>
          <th>Code</th>
          ${sortableColumns.map(c => columnHeader(c.field, c.label)).join('\n          ')}
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
function protectionDetailRow(
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

export function taskDetailHtml(
  task: Task,
  session: Session | null,
  turns: Turn[],
  commits: Commit[],
  comments: Comment[],
  journal: JournalEntry[],
  followUps: FollowUp[],
  children: Task[],
  promptVersions: TaskPromptVersion[],
  parentTask?: Task | null,
  protection?: TaskProtectionStatus | null,
  baseBranch?: string,
): string {
  const status = getTaskStatus(task, session);
  const taskDisplayId = displayId(task);
  const parentId = parentTaskIdOf(task);

  // Task info section
  let content = `
    <h1>Task ${escapeHtml(taskDisplayId)}</h1>
    <div class="action-links">
      ${session ? `<a href="/review/${task.id}" class="primary">Review changes</a>` : ''}
    </div>
    <div class="detail-section">
      <h2>Details</h2>
      <div class="detail-row"><span class="detail-label">ID</span><span>${escapeHtml(task.id)}</span></div>
      ${task.code ? `<div class="detail-row"><span class="detail-label">Code</span><span>${escapeHtml(task.code)}</span></div>` : ''}
      <div class="detail-row"><span class="detail-label">Goal</span><span>${escapeHtml(task.goal)}</span></div>
      <div class="detail-row"><span class="detail-label">Status</span><span>${statusBadge(status)}</span></div>
      <div class="detail-row"><span class="detail-label">Agent</span><span>${escapeHtml(task.agent_id)}</span></div>
      ${task.model ? `<div class="detail-row"><span class="detail-label">Model</span><span>${escapeHtml(task.model)}</span></div>` : ''}
      <div class="detail-row"><span class="detail-label">Created</span><span>${escapeHtml(formatDate(task.created_at))}</span></div>
      ${task.completed_at ? `<div class="detail-row"><span class="detail-label">Completed</span><span>${escapeHtml(formatDate(task.completed_at))}</span></div>` : ''}
      ${task.close_reason ? `<div class="detail-row"><span class="detail-label">Reason</span><span>${escapeHtml(task.close_reason)}</span></div>` : ''}
      ${parentId ? `<div class="detail-row"><span class="detail-label">Parent</span><span><a href="/tasks/${parentId}">${escapeHtml(parentTask ? displayId(parentTask) : shortId(parentId))}</a></span></div>` : ''}
      ${task.branched_from_sha ? `<div class="detail-row"><span class="detail-label">Branched From</span><span>${escapeHtml(task.branched_from_sha.substring(0, 8))}</span></div>` : ''}
      ${protectionDetailRow(protection, taskDisplayId)}
    </div>
  `;

  // Session section
  if (session) {
    const sessionStatus = session.outcome ?? (session.ended_at ? 'ended' : task.status);
    content += `
      <div class="detail-section">
        <h2>Session (${escapeHtml(session.agent_id)})</h2>
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
      </div>
    `;
  } else {
    content += `
      <div class="detail-section">
        <h2>Session</h2>
        <p style="color:var(--text-secondary)">Not started</p>
      </div>
    `;
  }

  // Turns section - grouped into review chunks (one human/builder boundary plus
  // its following agent/supervisor/system turns) using the single source of
  // truth, so intermediate auto-resume/supervisor turns are never visually lost.
  // Rendered as Markdown with links to turn detail pages.
  if (turns.length > 0) {
    const renderTurnHtml = (turn: Turn): string => {
      const turnLink = session ? `/tasks/${task.id}/turns/${turn.sequence}` : '#';
      const preview = renderMarkdown(turnText(turn));
      const usageInfo = turn.usage
        ? ` <span class="turn-tokens">${escapeHtml(formatTokenCount(totalInputTokens(turn.usage)))} in, ${escapeHtml(formatTokenCount(turn.usage.outputTokens))} out</span>`
        : '';
      // Label human-role turns by their authoring actor (e.g. 'supervisor' for
      // push-back/maintain prompts) so the UI distinguishes them from the human.
      const authorLabel = turn.role === 'human' && turn.actor && turn.actor !== 'human'
        ? turn.actor
        : turn.role;
      // Surface auto-triggered provenance so a reviewer can tell automation turns
      // (auto-resume, nudge) from a real human/builder turn.
      const autoBadge = turn.auto_triggered ? ` <span class="turn-auto">auto</span>` : '';
      // What the turn ran under. Always all three fields, `unknown` for anything
      // the turn does not carry — never back-filled from the task's current agent.
      // Omitted entirely for a turn lazy wrote itself — no agent ran it, so
      // there is nothing missing to report.
      const launchSegment = formatTurnLaunchLabels(turn);
      const launchInfo = launchSegment ? ` <span class="turn-launch">${escapeHtml(launchSegment)}</span>` : '';
      return `
      <div class="turn">
        <div class="turn-header">
          <span><a href="${turnLink}">#${turn.sequence}</a> [${escapeHtml(authorLabel)}]${autoBadge} ${escapeHtml(formatDate(turn.timestamp))}${usageInfo}${launchInfo}</span>
        </div>
        <div class="turn-content">${preview}</div>
      </div>
    `;
    };

    const chunks = groupTurnsIntoChunks(turns);
    const chunkItems = chunks.map(chunk => {
      const b = chunk.boundary;
      const boundaryLabel = b
        ? `#${b.sequence} [${escapeHtml(b.role === 'human' && b.actor && b.actor !== 'human' ? b.actor : b.role)}]`
        : '(no boundary — leading automation turns)';
      const turnsHtml = chunk.turns.map(renderTurnHtml).join('');
      return `
      <div class="turn-chunk">
        <div class="turn-chunk-header">Chunk ${chunk.index + 1} · ${boundaryLabel} · ${chunk.turns.length} turn${chunk.turns.length === 1 ? '' : 's'}</div>
        ${turnsHtml}
      </div>
    `;
    }).join('');

    content += `
      <div class="detail-section">
        <h2>Turns (${turns.length} in ${chunks.length} chunk${chunks.length === 1 ? '' : 's'})</h2>
        ${chunkItems}
      </div>
    `;
  }

  // Commits section - with links to commit detail pages
  if (commits.length > 0) {
    const commitItems = commits.map(c => `
      <div class="commit-row">
        <a href="/tasks/${task.id}/commits/${c.id}" class="commit-sha">${escapeHtml(c.sha.substring(0, 8))}</a>
        ${statusBadge(c.status)}
        <span class="commit-message">${escapeHtml(c.message)}</span>
      </div>
    `).join('');

    content += `
      <div class="detail-section">
        <h2>Commits (${commits.length})</h2>
        ${commitItems}
      </div>
    `;
  }

  // Comments section
  if (comments.length > 0) {
    const commentItems = comments.map(comment => `
      <div class="note">
        <div class="note-date">${escapeHtml(formatDate(comment.created_at))}</div>
        <div class="note-content">${escapeHtml(comment.content)}</div>
      </div>
    `).join('');

    content += `
      <div class="detail-section">
        <h2>Comments (${comments.length})</h2>
        ${commentItems}
      </div>
    `;
  }

  // Journal section — append-only, prompt-immune side channel (separate from Comments)
  if (journal.length > 0) {
    const journalItems = journal.map(entry => `
      <div class="note">
        <div class="note-date">${escapeHtml(formatDate(entry.created_at))}${entry.actor ? ` · ${escapeHtml(entry.actor)}` : ''}</div>
        <div class="note-content">${escapeHtml(entry.content)}</div>
      </div>
    `).join('');

    content += `
      <div class="detail-section">
        <h2>Journal (${journal.length})</h2>
        ${journalItems}
      </div>
    `;
  }

  // Follow-ups section (passive, agent-recorded orthogonal-work notes; display only)
  if (followUps.length > 0) {
    const followUpItems = followUps.map(followUp => `
      <div class="note">
        <div class="note-date">${escapeHtml(formatDate(followUp.created_at))}</div>
        <div class="note-content">${escapeHtml(followUp.content)}</div>
      </div>
    `).join('');

    content += `
      <div class="detail-section">
        <h2>Follow-ups (${followUps.length})</h2>
        ${followUpItems}
      </div>
    `;
  }

  // Children section
  if (children.length > 0) {
    const childRows = children.map(child => `
      <tr>
        <td><a href="/tasks/${child.id}">${escapeHtml(displayId(child))}</a></td>
        <td>${statusBadge(child.status)}</td>
        <td class="goal">${escapeHtml(child.goal)}</td>
      </tr>
    `).join('');

    content += `
      <div class="detail-section">
        <h2>Child Tasks (${children.length})</h2>
        <table>
          <thead><tr><th>Code</th><th>Status</th><th>Goal</th></tr></thead>
          <tbody>${childRows}</tbody>
        </table>
      </div>
    `;
  }

  // Prompt history section - links to individual prompt versions
  if (promptVersions.length > 0) {
    const versionLinks = promptVersions.map(v =>
      `<a href="/tasks/${task.id}/prompts/${v.version}" class="prompt-link">v${v.version} (${escapeHtml(formatDate(v.created_at))})</a>`
    ).join('');

    content += `
      <div class="detail-section">
        <h2>Prompt History (${promptVersions.length} version${promptVersions.length === 1 ? '' : 's'})</h2>
        <div>${versionLinks}</div>
      </div>
    `;
  } else if (task.prompt) {
    content += `
      <div class="detail-section">
        <h2>Prompt</h2>
        <a href="/tasks/${task.id}/prompts/current" class="prompt-link">View current prompt</a>
      </div>
    `;
  }

  return layoutHtml(`Task ${taskDisplayId}`, content);
}

export function promptVersionHtml(task: Task, version: TaskPromptVersion | null, versionNum: string, allVersions: TaskPromptVersion[]): string {
  const taskDisplayId = displayId(task);
  const breadcrumb = `<div class="breadcrumb"><a href="/tasks/${task.id}">Task ${escapeHtml(taskDisplayId)}</a> &rsaquo; Prompt</div>`;

  const promptContent = version?.content ?? task.prompt ?? '(no prompt)';
  const title = version ? `v${version.version}` : 'Current';

  const versionLinks = allVersions.map(v =>
    `<a href="/tasks/${task.id}/prompts/${v.version}" class="prompt-link ${v.version === version?.version ? 'active' : ''}" style="${v.version === version?.version ? 'background:var(--link);color:#fff;border-color:var(--link)' : ''}"">v${v.version}</a>`
  ).join('');

  return layoutHtml(`Prompt ${title}`, `
    ${breadcrumb}
    <h1>Prompt ${escapeHtml(title)}</h1>
    ${allVersions.length > 0 ? `<div style="margin-bottom:16px">${versionLinks}</div>` : ''}
    ${version ? `<p style="color:var(--text-secondary);margin-bottom:12px">Created: ${escapeHtml(formatDate(version.created_at))}</p>` : ''}
    <div class="detail-section">
      <div class="turn-content">${renderMarkdown(promptContent)}</div>
    </div>
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
export function commitDetailHtml(task: Task, commit: Commit, diffText: string): string {
  const taskDisplayId = displayId(task);
  const breadcrumb = `<div class="breadcrumb"><a href="/tasks/${task.id}">Task ${escapeHtml(taskDisplayId)}</a> &rsaquo; Commit</div>`;
  const files = parseUnifiedDiff(diffText);
  const rendered = renderReviewDiff(files, new Map(), { allowComments: false, allowViewed: false });

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
    <div id="commit-diff">${rendered}</div>
    ${diffViewScript('#commit-diff')}
  `);
}

/**
 * "Ran As" row for a single turn on the turn detail page: which agent, model and
 * effort it was launched with. Always all three; an absent field renders as
 * `unknown` rather than being filled in from the task's current settings.
 */
function launchDetailRow(turn: Turn): string {
  // The row has a fixed slot on this page, so it says not-applicable in words
  // rather than going blank — a blank row reads as a rendering bug.
  const segment = formatTurnLaunchLabels(turn) || NO_LAUNCH_LABEL;
  return `
      <div class="detail-row" style="margin-bottom:8px">
        <span class="detail-label">Ran As</span>
        <span>${escapeHtml(segment)}</span>
      </div>`;
}

export function turnDetailHtml(
  task: Task,
  session: Session,
  humanTurn: Turn | null,
  agentTurn: Turn | null,
  turnSequence: number,
  totalTurns: number,
): string {
  const taskDisplayId = displayId(task);
  const breadcrumb = `<div class="breadcrumb"><a href="/tasks/${task.id}">Task ${escapeHtml(taskDisplayId)}</a> &rsaquo; Turn ${turnSequence}</div>`;

  // Navigation between turns
  const navLinks: string[] = [];
  if (turnSequence > 1) {
    navLinks.push(`<a href="/tasks/${task.id}/turns/${turnSequence - 1}">&laquo; Previous turn</a>`);
  }
  if (turnSequence < totalTurns) {
    navLinks.push(`<a href="/tasks/${task.id}/turns/${turnSequence + 1}">Next turn &raquo;</a>`);
  }
  const turnNav = navLinks.length > 0 ? `<div class="action-links">${navLinks.join('')}</div>` : '';

  let content = `
    ${breadcrumb}
    <h1>Turn ${turnSequence}</h1>
    ${turnNav}
  `;

  // Human turn — heading reflects the authoring actor (e.g. "Supervisor" for a
  // push-back/maintain prompt) so it's not mislabeled as the human's words.
  if (humanTurn) {
    const authorHeading = humanTurn.actor === 'supervisor'
      ? 'Supervisor'
      : humanTurn.actor === 'builder'
        ? 'Builder'
        : 'Human';
    content += `
      <div class="detail-section">
        <h2>${authorHeading}</h2>
        ${launchDetailRow(humanTurn)}
        <div class="turn-content">${renderMarkdown(turnText(humanTurn))}</div>
      </div>
    `;
  }

  // Agent turn
  if (agentTurn) {
    const agentUsageHtml = agentTurn.usage ? `
      <div class="detail-row" style="margin-bottom:8px">
        <span class="detail-label">Token Usage</span>
        <span>${escapeHtml(formatTokenCount(totalInputTokens(agentTurn.usage)))} in, ${escapeHtml(formatTokenCount(agentTurn.usage.outputTokens))} out</span>
      </div>
      ${agentTurn.usage.cacheCreationTokens > 0 || agentTurn.usage.cacheReadTokens > 0 ? `
      <div class="detail-row" style="margin-bottom:8px">
        <span class="detail-label">Cache Tokens</span>
        <span>${escapeHtml(formatTokenCount(agentTurn.usage.cacheCreationTokens))} write, ${escapeHtml(formatTokenCount(agentTurn.usage.cacheReadTokens))} read</span>
      </div>` : ''}
    ` : '';
    content += `
      <div class="detail-section">
        <h2>Agent</h2>
        ${launchDetailRow(agentTurn)}
        ${agentUsageHtml}
        <div class="turn-content">${renderMarkdown(turnText(agentTurn))}</div>
      </div>
    `;
  }

  return layoutHtml(`Turn ${turnSequence} - Task ${taskDisplayId}`, content);
}

export function searchResultsHtml(results: SearchResult[], query: string): string {
  if (!query) {
    return layoutHtml('Search', `
      <h1>Search</h1>
      <form action="/search" method="get">
        <input type="text" name="q" placeholder="Search tasks, turns, commits, notes..." style="font-family:var(--font-ui);font-size:14px;padding:8px 12px;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text);width:100%;max-width:500px;" autofocus />
      </form>
    `);
  }

  if (results.length === 0) {
    return layoutHtml('Search', `
      <h1>Search: ${escapeHtml(query)}</h1>
      <div class="empty-state">No results found for "${escapeHtml(query)}"</div>
    `);
  }

  const resultItems = results.map(r => {
    const rDisplayId = r.task_code ?? shortId(r.task_id);
    // A turn hit knows its sequence, and the turn detail route is keyed by
    // sequence — so link the hit straight at the turn instead of dropping the
    // reader on the task page to hunt for the excerpt.
    const typeLabel = r.entity_type === 'turn' && r.turn_sequence !== undefined
      ? `<a class="search-result-type" href="/tasks/${r.task_id}/turns/${r.turn_sequence}">turn #${r.turn_sequence}</a>`
      : `<span class="search-result-type">${escapeHtml(r.entity_type)}</span>`;
    return `
    <div class="search-result">
      ${typeLabel}
      <a href="/tasks/${r.task_id}">${escapeHtml(rDisplayId)}</a>
      &mdash; ${escapeHtml(r.task_goal)}
      <div class="search-result-context">${escapeHtml(r.match_context)}</div>
    </div>
  `;
  }).join('');

  return layoutHtml(`Search: ${query}`, `
    <h1>Search: ${escapeHtml(query)}</h1>
    <p style="color:var(--text-secondary);margin-bottom:16px">${results.length} result${results.length === 1 ? '' : 's'}</p>
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
}

export interface DashboardStats {
  totalTasks: number;
  workingCount: number;
  blockedCount: number;
  interruptedCount: number;
  completedCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalDurationMs: number;
  recentlyCreatedTasks: TaskWithSession[];
  activeTasks: ActiveTaskInfo[];
  blockedTasks: TaskWithSession[];
  chartData: ChartDataPoint[];
  activityData: ActivityDay[];
  activeStates: ActiveStates;
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

function activityHeatmapSection(activityData: ActivityDay[]): string {
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
  let cells = '';

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
        cells += '<div class="hm-day"></div>';
        continue;
      }

      const dateStr = fmtDate(dayMs);
      const data = dataMap.get(dateStr);
      const h = data?.humanTurns ?? 0;
      const a = data?.agentTurns ?? 0;
      const ta = data?.tasksAccepted ?? 0;

      const tip = `${dateStr}: ${h} human turn${h !== 1 ? 's' : ''}, ${ta} task${ta !== 1 ? 's' : ''} accepted`;

      cells += `<div class="hm-day hm-active" title="${escapeHtml(tip)}" data-date="${dateStr}" data-h="${h}" data-a="${a}" data-ta="${ta}" onclick="showDayReport(this)"><div class="hm-l" style="background:${greenColor(h)}"></div><div class="hm-r" style="background:${orangeColor(ta)}"></div></div>`;
    }
  }

  // Month labels (absolutely positioned)
  const monthLabelHtml = monthLabels.map(({ label, column }) =>
    `<span style="position:absolute;left:${column * CELL_STEP}px">${label}</span>`
  ).join('');

  // Day-of-week labels (Mon, Wed, Fri visible; others blank for spacing)
  const dayLabels = ['Mon', '', 'Wed', '', 'Fri', '', ''];
  const dayLabelHtml = dayLabels.map(label =>
    `<div style="height:${CELL_SIZE}px;line-height:${CELL_SIZE}px">${label}</div>`
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
        `<span class="hm-swatch" style="background:var(--${cssPrefix}1)" title="—"></span>`,
        `<span class="hm-swatch" style="background:var(--${cssPrefix}2)" title="—"></span>`,
        `<span class="hm-swatch" style="background:var(--${cssPrefix}3)" title="—"></span>`,
        `<span class="hm-swatch" style="background:var(--${cssPrefix}4)" title="—"></span>`,
      ].join('');
    }
    return [
      `<span class="hm-swatch" style="background:var(--${cssPrefix}1)" title="${rangeLabel(1, thresholds[0])}"></span>`,
      `<span class="hm-swatch" style="background:var(--${cssPrefix}2)" title="${rangeLabel(thresholds[0] + 1, thresholds[1])}"></span>`,
      `<span class="hm-swatch" style="background:var(--${cssPrefix}3)" title="${rangeLabel(thresholds[1] + 1, thresholds[2])}"></span>`,
      `<span class="hm-swatch" style="background:var(--${cssPrefix}4)" title="${thresholds[2] + 1}+"></span>`,
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
                ${cells}
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

export function dashboardHtml(stats: DashboardStats): string {
  const statCards = `
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-value">${stats.totalTasks}</div>
        <div class="stat-label">Total Tasks</div>
      </div>
      <a href="/tasks?filter=working" class="stat-card stat-card-link">
        <div class="stat-value" style="color:#2563eb">${stats.workingCount}</div>
        <div class="stat-label">Working</div>
      </a>
      <a href="/tasks?filter=blocked" class="stat-card stat-card-link">
        <div class="stat-value" style="color:#d97706">${stats.blockedCount}</div>
        <div class="stat-label">Blocked</div>
      </a>
      <a href="/tasks?filter=interrupted" class="stat-card stat-card-link">
        <div class="stat-value" style="color:#9333ea">${stats.interruptedCount}</div>
        <div class="stat-label">Interrupted</div>
      </a>
      <div class="stat-card">
        <div class="stat-value" style="color:#16a34a">${stats.completedCount}</div>
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
  const chartDataJson = JSON.stringify(stats.chartData);
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
          <h3 style="margin-top:0;font-size:14px;color:var(--text-secondary)">Active States</h3>
          <div style="display:flex;flex-direction:column;gap:8px">
            ${stats.activeStates.working > 0 ? `
              <div style="padding:8px 12px;background:var(--card-bg);border-left:3px solid #2563eb;border-radius:4px">
                <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">Working</div>
                <div style="font-size:20px;font-weight:600;color:var(--text-primary)">${stats.activeStates.working}</div>
              </div>
            ` : ''}
            ${stats.activeStates.blocked > 0 ? `
              <div style="padding:8px 12px;background:var(--card-bg);border-left:3px solid #d97706;border-radius:4px">
                <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">Blocked</div>
                <div style="font-size:20px;font-weight:600;color:var(--text-primary)">${stats.activeStates.blocked}</div>
              </div>
            ` : ''}
            ${stats.activeStates.interrupted > 0 ? `
              <div style="padding:8px 12px;background:var(--card-bg);border-left:3px solid #9333ea;border-radius:4px">
                <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">Interrupted</div>
                <div style="font-size:20px;font-weight:600;color:var(--text-primary)">${stats.activeStates.interrupted}</div>
              </div>
            ` : ''}
            ${stats.activeStates.merging > 0 ? `
              <div style="padding:8px 12px;background:var(--card-bg);border-left:3px solid #0891b2;border-radius:4px">
                <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">Merging</div>
                <div style="font-size:20px;font-weight:600;color:var(--text-primary)">${stats.activeStates.merging}</div>
              </div>
            ` : ''}
            ${stats.activeStates.pairing > 0 ? `
              <div style="padding:8px 12px;background:var(--card-bg);border-left:3px solid #ec4899;border-radius:4px">
                <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">Pairing</div>
                <div style="font-size:20px;font-weight:600;color:var(--text-primary)">${stats.activeStates.pairing}</div>
              </div>
            ` : ''}
            ${stats.activeStates.working === 0 && stats.activeStates.blocked === 0 && stats.activeStates.interrupted === 0 && stats.activeStates.merging === 0 && stats.activeStates.pairing === 0 ? `
              <div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:12px">
                No active tasks
              </div>
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
      <table>
        <thead><tr><th>Code</th><th>Duration</th><th>Last Active</th><th>Last Turn</th><th>Goal</th></tr></thead>
        <tbody>
          ${stats.activeTasks.map(({ task, session, lastTurnSummary }) => {
            const duration = session ? formatDuration(session.total_duration_ms) : '-';
            const lastActive = session?.last_interaction_at ? formatDate(session.last_interaction_at) : '-';
            const turnPreview = lastTurnSummary
              ? escapeHtml(lastTurnSummary.substring(0, 80)) + (lastTurnSummary.length > 80 ? '...' : '')
              : '-';
            return `<tr>
              <td><a href="/tasks/${task.id}">${escapeHtml(displayId(task))}</a></td>
              <td>${escapeHtml(duration)}</td>
              <td>${escapeHtml(lastActive)}</td>
              <td class="wrap" style="max-width:250px;font-size:12px;color:var(--text-secondary)">${turnPreview}</td>
              <td class="goal">${escapeHtml(task.goal)}</td>
            </tr>`;
          }).join('\n')}
        </tbody>
      </table>
    </div>
  ` : '';

  // Blocked/Needs Attention
  const blockedSection = stats.blockedTasks.length > 0 ? `
    <div class="detail-section">
      <h2>Needs Attention (${stats.blockedTasks.length})</h2>
      <table>
        <thead><tr><th>Code</th><th>Status</th><th>Last Active</th><th>Goal</th></tr></thead>
        <tbody>
          ${stats.blockedTasks.map(({ task, session }) => {
            const status = getTaskStatus(task, session);
            const lastActive = session?.last_interaction_at ? formatDate(session.last_interaction_at) : '-';
            return `<tr>
              <td><a href="/tasks/${task.id}">${escapeHtml(displayId(task))}</a></td>
              <td>${statusBadge(status)} <a class="review-link" href="/review/${task.id}">review &rarr;</a></td>
              <td>${escapeHtml(lastActive)}</td>
              <td class="goal">${escapeHtml(task.goal)}</td>
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
      <table>
        <thead><tr><th>Code</th><th>Status</th><th>Created</th><th>Goal</th></tr></thead>
        <tbody>
          ${stats.recentlyCreatedTasks.map(({ task, session }) => {
            const status = getTaskStatus(task, session);
            return `<tr>
              <td><a href="/tasks/${task.id}">${escapeHtml(displayId(task))}</a></td>
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

        var isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        var gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
        var textColor = isDark ? '#9ca3af' : '#6b7280';

        var ctx = document.getElementById('tasksChart');
        new Chart(ctx, {
          type: 'line',
          data: {
            labels: data.map(function(d) { return d.date; }),
            datasets: [
              {
                label: 'Backlog',
                data: data.map(function(d) { return d.backlog; }),
                borderColor: '#6b7280',
                backgroundColor: 'rgba(107,114,128,0.1)',
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: '#6b7280',
                tension: 0.2
              },
              {
                label: 'Completed',
                data: data.map(function(d) { return d.completed; }),
                borderColor: '#16a34a',
                backgroundColor: 'rgba(22,163,74,0.1)',
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: '#16a34a',
                tension: 0.2
              },
              {
                label: 'Abandoned',
                data: data.map(function(d) { return d.closed; }),
                borderColor: '#dc2626',
                backgroundColor: 'rgba(220,38,38,0.1)',
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: '#dc2626',
                tension: 0.2
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { labels: { color: textColor, font: { family: "'SF Mono','Cascadia Code','Fira Code',Menlo,monospace", size: 11 } } }
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
    ${activityHeatmapSection(stats.activityData)}
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
