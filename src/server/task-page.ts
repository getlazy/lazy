/**
 * The tabbed task page — one address, thirteen real pages, in-place switching.
 *
 * Landing is status-driven (§5.1). Every other tab relocates today's content
 * without redesigning it. Review-page blocks come from `reviewTaskHtml({ embed })`
 * so unit tests of those blocks stay on the full assembler.
 */

import { regionsTabHtml, regionsStripOptions } from './review-regions';
import { taskPath, taskPathSegment, type TaskPathRef } from './task-urls';
import type { Task, Session, Turn, Commit, Comment, JournalEntry, RaisedItem, TaskPromptVersion } from '../storage';
import type { TaskStatsResult } from '../task/stats-data';
import { latestAgentWorkTurn } from '../task/turn-context';
import { statsTabHtml, statsScopeHref, formatTokens } from './stats-tab';
import type { TurnReport, FileDecision, AcceptRemedy, FileViolation, ReviewComment } from '../types';
import { isTerminalStatus } from '../types';
import { parentTaskIdOf } from '../task-target';
import { resolveTaskForgeLink, taskForgeLinkHtml } from '../task-forge-link';
import { isLinkedTask, formatLinkedMarker, linkedBranchOf } from '../task/linked';
import { escapeHtml } from './review-diff';
import { renderMarkdown, type RenderMarkdownOptions } from './markdown';
import { viewedCardHtml } from './viewed-cards';
import { reviewDraftScript } from './review-draft-script';
import { viewedStateScript } from './viewed-cards';
import { reviewNavControlsHtml, reviewNavigationScript } from './review-navigation';
import { screenshotLightboxScript } from './screenshot-lightbox';
import { servicesCardHtml, branchServeAdviceHtml, toProbedState, type ServicesCardControls } from './services-card';
import { hubRollupHtml, subtasksSectionHtml } from './subtasks';
import type { BranchServeAdvice } from '../serve/branch-advice';
import { shellPanelHtml, shellClientScript, shellTabHtml, type ShellAvailability } from './shell-ui';
import { verifyCopyScript, verifyRunScript } from './review-verify';
import { watchPanelHtml, watchClientScript } from './watch-ui';
import { reviewActivityCardHtml, type ReviewActivity } from './review-activity';
import { screenshotsCardHtml } from './review-presentation';
import { reportHasImplementation } from '../review/report-policy';
import { reviewExplanationLine, type ReviewSettingsView } from '../review/mode';
import { agentReportHtml, pendingDeliveryComments, raisedItemsSummary, reviewScript, reviewTaskHtml, statusBarHtml, type ReviewDraft, type ReviewLiveState } from './review';
import { raisedDialogChromeHtml, raisedDialogScript } from './raised-dialog';
import { actionDialogChromeHtml, actionDialogScript, actionDialogButtonHtml, actionDialogTemplateHtml } from './action-dialog';
import { raisedDisplayTitle } from '../raised/content';
import { raisedGateBadgeHtml } from './raised-badges';
import { raisedGateVocabulary } from '../raised/vocabulary';
import { resolveAskAvailability, unblockUnavailableReason, hasAnyAsk, hasAnyQueuedComment, type ReviewQueueEntry } from './review-actions';
import { currentReviewHtml } from './current-review';
import { acceptGateTurns } from '../review/accept-gate';
import { buildShowFinal } from '../task/show-sections';
import {
  verifyTabHtml,
  partitionVerifyReports,
  countVerifiedSteps,
  splitVerifySteps,
  howToVerifySource,
} from './review-verify';
import type { TaskUpstreamStatusView, TaskReparentTargets, TaskSubmitPreflight } from './task-actions';
import { submitActionHtml, taskCanOfferSubmit } from './submit-action';
import {
  restructureVerbUnavailableReason,
  reviewEndVerbUnavailableReason,
  agentReviewUnavailableReason,
} from './task-verbs';
import { unmeasured, type RenderTimings } from './render-timings';
import type { TaskProtectionStatus } from '../protection/status';
import type { TaskLaunchIdentityView, LaunchIdentityItem } from '../task/launch-identity-view';
import type { TaskServeState } from '../serve/discovery';
import type { ServeNotice } from './serve-notice';
import {
  layoutHtml,
  displayId,
  statusBadge,
  formatDate,
  taskActionRowHtml,
  serveNoticeBannerHtml,
  protectionDetailRow,
  serveDetailRow,
  taskTurnsSectionHtml,
  taskCommitsSectionHtml,
  taskRaisedSectionHtml,
  taskPromptSectionHtml,
  getTaskStatus,
  type TaskChunkOrder,
} from './templates';
import {
  taskTabStripHtml,
  taskTabSwitchScript,
  taskTabHref,
  type TaskTabId,
  type TaskTabBadge,
} from './task-tabs';
import type { MarkdownSources } from './review-markdown';
import { turnText } from '../utils/turn-content';
import { reviewFindingsSectionHtml, reviewFindingTurnsOf } from './review-findings';
import { reviewsTabHtml, reviewsTabCount } from './reviews-tab';
import { taskCommentsTabHtml, taskJournalTabHtml, queuedComments } from './task-notes';
import {
  buildLiveStatusKeys,
  taskLiveStatusScript,
  type TaskLiveRegionSources,
} from './task-live-status';
import { liveKeysToken } from './task-live-regions';
import { domMorphScript } from './dom-morph';
import { timestampHtml } from './timestamps';

export interface TaskProgressLine {
  message: string;
  recordedAt: string;
}

export interface TaskPageReviewExtras {
  notice?: { text: string; error?: boolean };
  diffText?: string;
  reviewComments?: ReviewComment[];
  state?: ReviewLiveState;
  fileViolations?: FileViolation[];
  draft?: ReviewDraft;
  remedy?: AcceptRemedy;
  fileDecisions?: FileDecision[];
  isMaintainedPath?: (path: string) => boolean;
  markdownSources?: MarkdownSources;
  hubChildren?: { accepted: Task[]; inProgress: Task[] };
  /** Review regions and the `?region=` filter in force, for the Changes tab. */
  regions?: {
    rows: import('../regions').RegionSummary[];
    active: string | null;
    notes: string[];
  };
  /**
   * Per-line unit attribution for the files the Changes tab is rendering — the
   * subtask-blame gutter. Absent on every other tab, and on a task with no
   * carved cover.
   */
  lineAttribution?: Map<string, import('../regions').FileLineAttribution>;
}

export interface TaskPageInput {
  task: Task;
  session: Session | null;
  turns: Turn[];
  commits: Commit[];
  comments: Comment[];
  journal: JournalEntry[];
  raisedItems: RaisedItem[];
  children: Task[];
  promptVersions: TaskPromptVersion[];
  parentTask?: Task | null;
  protection?: TaskProtectionStatus | null;
  baseBranch?: string;
  serve?: TaskServeState | null;
  chunkOrder?: TaskChunkOrder;
  shell?: ShellAvailability | null;
  controls?: ServicesCardControls;
  activity?: ReviewActivity | null;
  serveNotice?: ServeNotice | null;
  timings?: RenderTimings;
  tab: TaskTabId;
  fragment?: boolean;
  /**
   * With `fragment`, also emit the landing header. Live-status chrome refresh
   * sets this; plain tab switching does not — it only needs strip + body, and
   * skips the header-only data loads (upstream, reparent targets, …).
   */
  chrome?: boolean;
  /**
   * With `fragment` + `chrome`, emit header + strip and NO tab body.
   *
   * The live island asks for this when the visible tab's policy is "pill" or
   * "never", or when its regions did not move: the header and the strip badges
   * still need refreshing, but rendering the body would mean a full diff parse
   * on the Changes tab every time an unrelated subtask changed status.
   */
  omitBody?: boolean;
  /**
   * Task branch HEAD sha — the `changes` region's freshness key. Null when the
   * branch does not exist yet. Never used for rendering.
   */
  headSha?: string | null;
  viewedFiles?: Record<string, string>;
  /** Half-typed comment boxes from the stored draft, seeded into the island. */
  lineDrafts?: Record<string, string>;
  progress?: TaskProgressLine | null;
  turnReport?: TurnReport | null;
  lastAgentTurn?: Turn | null;
  /** All session reports — Verify tab history. Oldest-first from storage. */
  turnReports?: TurnReport[];
  review?: TaskPageReviewExtras;
  /**
   * Descendants-of-this-child, keyed by child id. Loaded only on the
   * Subtasks tab, from `Storage.countDescendants()`. Missing → every row
   * shows the nothing-nested dash.
   */
  subtreeCounts?: Map<string, number>;
  /** Branch `[serve]` ports the root config lacks. Services tab only. */
  branchAdvice?: BranchServeAdvice[];
  /** No-network upstream indicator — Landing header and Current review. */
  upstream?: TaskUpstreamStatusView | null;
  /**
   * The task's effective review settings, pre-composed by the daemon
   * (`reviewSettingsViewOf`): the line, one plain-words clause per value with
   * its provenance, and the docs pointer. Rendered verbatim — this page never
   * assembles any of it from the three fields, so it cannot word them
   * differently from `lazy show`. Absent simply drops the item.
   */
  reviewSettings?: ReviewSettingsView | null;
  /**
   * What this task runs on — agent profile, model, effort — for the header
   * status line. Absent (config unreadable) simply drops those items: the
   * header never guesses a value it did not resolve.
   */
  launchIdentity?: TaskLaunchIdentityView | null;
  reparentTargets?: TaskReparentTargets | null;
  submitPreflight?: TaskSubmitPreflight | null;
  /** Shared linkify tables (task codes; symbols merge in on Changes). */
  markdown?: RenderMarkdownOptions;
  /** Direct `/raised/:id` load — render the Raised tab with this dialog open. */
  openRaisedId?: string;
  /** Pre-rendered dialog body for `openRaisedId`. */
  openRaisedPanel?: string;
  /**
   * The Stats readout, already derived by the route through the shared loader
   * (`src/task/stats-data.ts`) so the same numbers reach the tab, the RPC and
   * the CLI. Stats tab only; absent renders the tab's own empty state.
   */
  stats?: TaskStatsResult;
  /**
   * Codes shared by more than one task, from `Storage.listTaskCodes()`. Task
   * URLs on this page fall back to the id for those, so a link cannot land on
   * a sibling task with the same code; absent, links just use code-or-id.
   */
  duplicatedCodes?: ReadonlySet<string>;
}

function emptyTab(message: string): string {
  return `<p class="lz-empty-tab">${escapeHtml(message)}</p>`;
}

/**
 * This task's URL segment — its code, or its id when it has no code or its
 * code is one of the shared ones. Already URL-escaped; every link this page
 * renders starts from it so a URL reads by task code like every other surface.
 */
function pageSeg(input: TaskPageInput): string {
  return taskPathSegment(input.task, input.duplicatedCodes);
}

/**
 * Ask state for a render the route handler did not hand one to.
 *
 * Goes through the shared rule (`resolveAskAvailability`) like every other
 * surface — this used to spell its own status check and its own refusal
 * sentence, which is how the page came to promise something the daemon
 * decided differently. The worktree is not stat-ed here: see AskContext.
 */
function askLiveStateFallback(task: Task, session: Session | null, turnCount: number): ReviewLiveState {
  const availability = resolveAskAvailability({
    status: task.status,
    liveSession: session !== null && !session.ended_at,
    resumableAgentSession: !!session?.agent_session_id,
    worktreeExists: true,
    hasRecord: turnCount > 0,
  });
  return {
    status: task.status,
    turns: turnCount,
    lastActiveAt: session?.last_interaction_at ?? session?.started_at ?? null,
    askable: availability.unavailable === null,
    askUnavailable: availability.unavailable,
    askRoute: availability.route,
    askProvenance: availability.provenance,
    unblockUnavailable: unblockUnavailableReason(task.status),
  };
}

function landingExtraActionsHtml(input: TaskPageInput): string {
  const { task } = input;
  // Form targets name THIS task exactly: a code shared with a sibling task
  // would POST into the winner, so it falls back to the id here.
  const seg = pageSeg(input);
  const parts: string[] = [];
  const reviewReason = agentReviewUnavailableReason(task.status);
  parts.push(actionDialogButtonHtml({
    verb: 'review',
    label: 'Review',
    disabledReason: reviewReason,
  }));
  if (!reviewReason) {
    parts.push(actionDialogTemplateHtml('review', `
      <form method="post" action="/tasks/${seg}/actions/review" class="lz-action-form" data-lz-action-form>
        <p>Run a read-only agent review of this task's work. Security and data integrity first. Issues are filed as Raises. The task stays in its current status afterwards.</p>
        <p class="rv-hint">The report stays on this page — lazy does not post reviews to a pull or merge request.</p>
        <label class="edit-check" for="lz-review-auto-fix">
          <input type="checkbox" id="lz-review-auto-fix" name="auto_fix" value="1">
          Automatically fix — start a work turn that injects any Raises the review files
        </label>
        <div class="rv-form-actions"><button type="submit" class="btn btn-primary">Review</button></div>
      </form>`));
  }

  const syncReason = reviewEndVerbUnavailableReason('sync', task.status);
  parts.push(actionDialogButtonHtml({
    verb: 'sync',
    label: 'Sync',
    disabledReason: syncReason,
  }));
  if (!syncReason) {
    parts.push(actionDialogTemplateHtml('sync', `
      <form method="post" action="/tasks/${seg}/actions/sync" class="lz-action-form" data-lz-action-form>
        <p>Merge the parent branch into this task. The agent resolves conflicts.</p>
        <div class="rv-form-actions"><button type="submit" class="btn">Sync</button></div>
      </form>`));
  }

  // Same row as Sync / Reparent: a reviewer looking at Summary must see
  // Submit without opening Current review. The dialog (not a disabled
  // button) is where a preflight refusal is explained.
  if (taskCanOfferSubmit(task.status)) {
    parts.push(submitActionHtml(seg, input.submitPreflight));
  }

  const reparentReason = restructureVerbUnavailableReason('reparent', task.status);
  const targets = input.reparentTargets;
  const options = [
    ...(targets?.tasks ?? []).map((t) => {
      const label = t.code ?? t.id.slice(0, 8);
      return `<option value="${escapeHtml(t.code ?? t.id)}">${escapeHtml(label)} — ${escapeHtml(t.goal)}</option>`;
    }),
    ...(targets?.branches ?? []).map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`),
  ].join('');
  parts.push(actionDialogButtonHtml({
    verb: 'reparent',
    label: 'Reparent',
    disabledReason: reparentReason,
  }));
  if (!reparentReason) {
    parts.push(actionDialogTemplateHtml('reparent', `
      <form method="post" action="/tasks/${seg}/actions/reparent" class="lz-action-form" data-lz-action-form>
        <p class="rv-hint">Reparent merges the new parent into this task and relaunches the agent to resolve conflicts (it is a sync). See the upstream line above.</p>
        <input class="input" type="text" name="parent" required list="lz-reparent-targets" placeholder="Task code, id, or branch (e.g. main)">
        <datalist id="lz-reparent-targets">${options}</datalist>
        <div class="rv-form-actions"><button type="submit" class="btn">Reparent</button></div>
      </form>`));
  }

  const redoReason = restructureVerbUnavailableReason('redo', task.status);
  parts.push(actionDialogButtonHtml({
    verb: 'redo',
    label: 'Redo',
    disabledReason: redoReason,
  }));
  if (!redoReason) {
    parts.push(actionDialogTemplateHtml('redo', `
      <form method="post" action="/tasks/${seg}/actions/redo" class="lz-action-form" data-lz-action-form>
        <p class="rv-hint">Closes this task and creates a fresh replacement under the same parent. The replacement is not started.</p>
        <input class="input" type="text" name="reason" required placeholder="Why redo this attempt?">
        <div class="rv-form-actions"><button type="submit" class="btn">Redo task</button></div>
      </form>`));
  }

  const cloneReason = restructureVerbUnavailableReason('clone', task.status);
  parts.push(actionDialogButtonHtml({
    verb: 'clone',
    label: 'Clone',
    disabledReason: cloneReason,
  }));
  if (!cloneReason) {
    parts.push(actionDialogTemplateHtml('clone', `
      <form method="post" action="/tasks/${seg}/actions/clone" class="lz-action-form" data-lz-action-form>
        <p class="rv-hint">Creates a variant in backlog, not started. A custom image pin on the source is not inherited.</p>
        <input class="input" type="text" name="goal" placeholder="Goal (optional — defaults to this task's)">
        <textarea class="input" name="prompt" rows="3" placeholder="Prompt override (optional)"></textarea>
        <input class="input" type="text" name="code" placeholder="Code (optional)">
        <input class="input" type="text" name="model" placeholder="Model (optional — defaults to this task's)">
        <input class="input" type="text" name="agent" placeholder="Agent profile (optional — defaults to this task's)">
        <label class="rv-hint"><input type="checkbox" name="same_base" value="1"> Same base — start from the exact commit this task started from, pinned there (no automatic sync), for a like-for-like re-run</label>
        <div class="rv-form-actions"><button type="submit" class="btn">Clone task</button></div>
      </form>`));
  }
  return parts.join('');
}

/**
 * `<profile> · <model> · <effort>` — what this task runs on, on the header's
 * status line next to the upstream indicator.
 *
 * A value that came from lazy.toml rather than from the task is rendered
 * subdued and says so in its tooltip: the header must not present a default as
 * a choice someone made. Nothing is invented — an unresolvable identity (bad or
 * missing config) renders nothing at all.
 */
export function launchIdentityHtml(view: TaskLaunchIdentityView | null | undefined): string {
  if (!view) return '';
  const items: Array<[string, LaunchIdentityItem]> = [
    ['Agent profile', view.agent],
    ['Model', view.model],
    ['Effort', view.effort],
  ];
  const rendered = items.map(([label, item]) => {
    // "recorded on this task", NOT "set on this task": the record does not
    // distinguish a value a human pinned from one the first launch filled in
    // from config, so claiming intent here would invite a conclusion the data
    // does not support. See the source doc in src/task/launch-identity-view.ts.
    const provenance = item.source === 'default'
      ? `${label} — from lazy.toml default`
      : `${label} — recorded on this task`;
    const title = item.note ? `${provenance} (${item.note})` : provenance;
    const cls = item.source === 'default' ? 'lz-launch-item lz-launch-default' : 'lz-launch-item';
    return `<span class="${cls}" title="${escapeHtml(title)}">${escapeHtml(item.value)}</span>`;
  });
  const sep = '<span class="lz-launch-sep">·</span>';
  return `<span class="lz-launch-identity">${rendered.join(sep)}</span>`;
}

/**
 * The header's `Review:` item — the line, with the daemon's own clauses as its
 * tooltip and a link to the page that explains the vocabulary.
 *
 * Every word here comes from the payload. The page adds no explanation of its
 * own, so a reader comparing it with `lazy show` sees one answer, provenance
 * included: "why is this separate when the project default is low-high" is the
 * question the bare line could not answer (engineer report, 2026-09-21).
 */
export function reviewItemHtml(view: ReviewSettingsView | null | undefined): string {
  if (!view) return '';
  const title = [
    'How this task gets reviewed once it declares final:',
    ...(view.explanations ?? []).map(reviewExplanationLine),
  ].join('\n');
  const label = escapeHtml(`Review: ${view.line}`);
  const body = view.docs_url
    ? `<a href="${escapeHtml(view.docs_url)}" target="_blank" rel="noreferrer noopener">${label}</a>`
    : label;
  return `<span class="lz-launch-item" title="${escapeHtml(title)}">${body}</span>`;
}

function landingHeaderHtml(input: TaskPageInput): string {
  const { task, session, parentTask } = input;
  const status = getTaskStatus(task, session);
  const taskDisplayId = displayId(task);
  const parentId = parentTaskIdOf(task);
  const seg = pageSeg(input);
  const hasOpenSession = session !== null && !session.ended_at;
  const forge = resolveTaskForgeLink(task);
  const tags = (task.tags ?? []).filter((t) => t.trim().length > 0);
  const parentHtml = parentId
    ? `<span class="task-parent">Parent <a href="${taskPath({ id: parentId, code: parentTask?.code ?? null }, input.duplicatedCodes)}">${escapeHtml(parentTask ? displayId(parentTask) : parentId.substring(0, 8))}</a></span>`
    : '';
  const tagHtml = tags.length
    ? `<div class="lz-landing-tags">${tags.map((t) => `<span class="lz-tag">#${escapeHtml(t)}</span>`).join('')}</div>`
    : '';
  const forgeHtml = forge ? `<span class="lz-forge">${taskForgeLinkHtml(forge)}</span>` : '';
  const linkedHtml = isLinkedTask(task)
    ? `<span class="lz-linked" title="${escapeHtml(linkedBranchOf(task) ?? '')}">${escapeHtml(formatLinkedMarker(task) ?? 'linked')}</span>`
    : '';
  const upstreamHtml = input.upstream
    ? `<span class="lz-upstream" title="as of last fetch">${escapeHtml(input.upstream.htmlLine)}</span>`
    : '';
  // Blocked/conflict: the action row is how you finish a review. Other
  // statuses use the tab strip — do not duplicate a Current review button.
  // The header is always-on, so hide the CTA when you are already there.
  const goReview = (input.tab !== 'review'
    && (task.status === 'blocked' || task.status === 'conflict'))
    ? `<a href="${taskPath(task, input.duplicatedCodes)}/review" class="btn btn-primary">Go to Current review</a>`
    : '';

  // Current review already paints this notice next to the remedy (the
  // failed-step analogue when scripting is off). Repeating it in the always-on
  // header is the double "would merge …" the engineer hit on a gated accept.
  const headerNotice = input.tab === 'review' ? undefined : input.review?.notice;
  // `flash` query values (daemon warnings after Link/Review/Sync) land here
  // as notice.text. Always escape — those strings are not HTML.
  const flash = headerNotice
    ? `<div class="rv-notice${headerNotice.error ? ' rv-notice-err' : ''}">${escapeHtml(headerNotice.text)}</div>`
    : '';

  return `
    <div class="lz-landing-header">
      ${flash}
      <h1>Task ${escapeHtml(taskDisplayId)}</h1>
      <div class="task-signal">
        <p class="task-goal">${escapeHtml(task.goal)}</p>
        <div class="task-signal-meta">
          ${statusBadge(status)}
          ${parentHtml}
          ${linkedHtml}
          ${forgeHtml}
          ${upstreamHtml}
          ${launchIdentityHtml(input.launchIdentity)}
          ${reviewItemHtml(input.reviewSettings)}
        </div>
        ${tagHtml}
      </div>
      <div class="action-links">
        ${goReview}
        ${landingExtraActionsHtml(input)}
        ${taskActionRowHtml(task, hasOpenSession, input.duplicatedCodes)}
        ${isTerminalStatus(task.status) ? '' : `<a href="${taskPath(task, input.duplicatedCodes)}/edit" class="btn">Edit task</a>`}
        ${isTerminalStatus(task.status) ? '' : `<a href="/tasks/new?parent=${seg}" class="btn">New subtask</a>`}
        ${isTerminalStatus(task.status) ? '' : watchPanelHtml(seg, true)}
        ${reviewNavControlsHtml()}
      </div>
    </div>
  `;
}

function metadataHtml(input: TaskPageInput): string {
  const { task, session, protection, baseBranch, serve } = input;
  const taskDisplayId = displayId(task);
  // Agent and Model are NOT here: they are on the header's status line, with the
  // effort and with the provenance of each (launchIdentityHtml). A row that
  // restated them would be a second, staler answer to "what runs this task" —
  // the metadata row only ever knew the STORED value, so an unstarted task
  // showed no model at all. What is left is the provenance a reviewer occasionally
  // needs: the full id, the timestamps, the gate, the session's branch and base.
  let sessionMeta: string;
  if (session) {
    const sessionStatus = session.outcome ?? (session.ended_at ? 'ended' : task.status);
    sessionMeta = `
      <h3 class="task-metadata-subhead">Session (${escapeHtml(session.agent_id)})</h3>
      <div class="detail-row"><span class="detail-label">Status</span><span>${statusBadge(sessionStatus)}</span></div>
      <div class="detail-row"><span class="detail-label">Branch</span><span>${escapeHtml(session.git_branch)}</span></div>
      ${baseBranch ? `<div class="detail-row"><span class="detail-label">Base</span><span>${escapeHtml(baseBranch)}</span></div>` : ''}
      <div class="detail-row"><span class="detail-label">Started</span><span>${escapeHtml(formatDate(session.started_at))}</span></div>
    `;
  } else {
    sessionMeta = `<h3 class="task-metadata-subhead">Session</h3><p class="text-muted">Not started</p>`;
  }
  return `
    <details class="detail-section task-metadata">
      <summary>Metadata</summary>
      <div class="detail-row"><span class="detail-label">ID</span><span>${escapeHtml(task.id)}</span></div>
      <div class="detail-row"><span class="detail-label">Created</span><span>${escapeHtml(formatDate(task.created_at))}</span></div>
      ${task.completed_at ? `<div class="detail-row"><span class="detail-label">Completed</span><span>${escapeHtml(formatDate(task.completed_at))}</span></div>` : ''}
      ${task.close_reason ? `<div class="detail-row"><span class="detail-label">Reason</span><span>${escapeHtml(task.close_reason)}</span></div>` : ''}
      ${protectionDetailRow(protection, taskDisplayId)}
      ${serveDetailRow(serve)}
      ${sessionMeta}
    </details>
  `;
}

function progressAge(recordedAt: string, now = Date.now()): string {
  const then = Date.parse(recordedAt);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The agent's own account of the work.
 *
 * Excludes reviews (they have their own Reviews block) and every supervised
 * closing step — the presentation step runs on each human-facing park, so its
 * boilerplate reply is otherwise the newest agent turn on a parked task.
 */
function lastWorkAgentTurn(turns: Turn[]): Turn | null {
  return latestAgentWorkTurn(turns);
}

function landingBehaviorHtml(
  taskId: string,
  turn: Turn | null,
  report: TurnReport | null,
  markdown?: RenderMarkdownOptions,
): string {
  const sections = report?.sections ?? [];
  if (sections.length === 0 && !turn) return '';
  if (sections.length === 0) {
    // Unstructured last-turn prose — today's degradation, shown as the claim.
    return agentReportHtml(taskId, turn, report, { markdown });
  }
  const card = agentReportHtml(taskId, turn, report, {
    surface: 'landing',
    markdown,
    showNoBehaviorNotice: true,
  });
  if (!card) return '';
  // Hint only when the new kind actually lives on Changes — a legacy
  // `what_was_done` report is already on this tab.
  const implHint = reportHasImplementation(sections)
    // taskId is the ESCAPED path segment (taskPathSegment) — interpolate raw.
    ? `<p class="rv-hint"><a href="/tasks/${escapeHtml(taskId)}/changes">implementation lives on Changes →</a></p>`
    : '';
  return `${card}${implHint}`;
}

function landingBlockingHtml(taskId: string, items: RaisedItem[]): string {
  const open = items.filter((i) => i.status === 'open');
  const blocking = open.filter((i) => i.blocking);
  const rest = open.length - blocking.length;
  if (blocking.length === 0 && rest === 0) return '';
  const rows = blocking.map((item) =>
    `<li>${raisedGateBadgeHtml(true)} <a href="/raised/${escapeHtml(item.id)}">${escapeHtml(raisedDisplayTitle(item))}</a></li>`
  ).join('');
  return `<div class="detail-section">
    <h2>${escapeHtml(raisedGateVocabulary(true).emoji)} ${blocking.length} blocking item${blocking.length === 1 ? '' : 's'} need${blocking.length === 1 ? 's' : ''} an answer</h2>
    ${rows ? `<ul>${rows}</ul>` : '<p class="text-muted">None blocking.</p>'}
    ${rest > 0 ? `<p class="rv-hint"><a href="/tasks/${escapeHtml(taskId)}/raised">${rest} non-blocking item${rest === 1 ? '' : 's'} → Raised</a></p>` : ''}
  </div>`;
}

function landingBodyHtml(input: TaskPageInput): string {
  const { task, session, turns, children, raisedItems, activity, serveNotice, serve, controls } = input;
  const seg = pageSeg(input);
  const probedServe = serve ? toProbedState(serve) : null;
  const rollup = hubRollupHtml(seg, children, task);
  const notice = serveNoticeBannerHtml(task, serveNotice, probedServe, controls);
  const findings = reviewFindingsSectionHtml(seg, reviewFindingTurnsOf(turns));
  // A review turn's body is JSON. The Reviews block renders it; the Agent
  // report card should still be the last *work* turn, not that dump.
  const behaviorTurn = lastWorkAgentTurn(turns);
  const behaviorReport = (
    input.lastAgentTurn
    && behaviorTurn
    && input.lastAgentTurn.sequence === behaviorTurn.sequence
  ) ? (input.turnReport ?? null) : null;

  if (task.status === 'working') {
    // The agent's own line, or a plain "Working". The second source used to be
    // the working substate's `.progress`, which was this same progress.json
    // value reached through a docker liveness probe — see loadTaskProgressLine.
    const line = input.progress?.message ?? null;
    const age = input.progress?.recordedAt ? progressAge(input.progress.recordedAt) : '';
    const progress = line
      ? `<div class="lz-progress"><span class="lz-progress-line">${escapeHtml(line)}</span>${age ? `<span class="lz-progress-age">${escapeHtml(age)}</span>` : ''}</div>`
      : `<div class="lz-progress"><span class="lz-progress-line">Working</span></div>`;
    const latest = lastWorkAgentTurn(turns);
    const preview = latest
      ? viewedCardHtml({
          key: `landing-turn:${latest.sequence}`,
          content: turnText(latest),
          headHtml: `<a href="${taskPath(task, input.duplicatedCodes)}/turns/${latest.sequence}">Latest turn #${latest.sequence}</a>`
            + ` <span class="rv-hint">${timestampHtml(latest.timestamp)}</span>`,
          bodyHtml: `<div class="turn-content">${renderMarkdown(turnText(latest).split('\n').slice(0, 15).join('\n'), input.markdown)}</div>
            <p class="rv-hint"><a href="${taskPath(task, input.duplicatedCodes)}/turns">Full turn → Turns</a></p>`,
          sectionClass: 'turn',
        })
      : '';
    return `${rollup}${notice}${progress}${preview}${findings}${metadataHtml(input)}`;
  }

  if (task.status === 'blocked' || task.status === 'conflict') {
    const shots = screenshotsCardHtml(seg, input.turnReport?.presentation?.screenshots);
    const behavior = landingBehaviorHtml(seg, behaviorTurn ?? null, behaviorReport, input.markdown);
    const blocking = landingBlockingHtml(seg, raisedItems);
    const activityCard = activity ? reviewActivityCardHtml(activity, seg) : '';
    return `${rollup}${notice}${shots}${behavior}${findings}${blocking}${activityCard}${metadataHtml(input)}`;
  }

  if (isTerminalStatus(task.status)) {
    const when = task.completed_at
      ? ` ${timestampHtml(task.completed_at, { absolute: true })}`
      : '';
    const reason = task.close_reason ? `<p>${escapeHtml(task.close_reason)}</p>` : '';
    const behavior = landingBehaviorHtml(seg, behaviorTurn ?? null, behaviorReport, input.markdown);
    return `${rollup}${notice}<div class="lz-outcome"><h2>Outcome</h2>
      <p>${escapeHtml(task.status === 'complete' ? 'Accepted' : 'Closed')}${when}</p>
      ${reason}${behavior}</div>${findings}${metadataHtml(input)}`;
  }

  // backlog (and anything else, including submitted / interrupted): what the task is
  return `${rollup}${notice}${taskPromptSectionHtml(task, input.promptVersions, input.duplicatedCodes)}${findings}${metadataHtml(input)}`;
}

function tabBodyHtml(input: TaskPageInput): string {
  const { task, session, tab, chunkOrder = 'newest' } = input;
  const review = input.review ?? {};
  const seg = pageSeg(input);
  const embedExtras = {
    draft: review.draft,
    viewedFiles: input.viewedFiles ?? {},
    remedy: review.remedy,
    raisedItems: input.raisedItems,
    lastAgentTurn: input.lastAgentTurn,
    turnReport: input.turnReport,
    fileDecisions: review.fileDecisions,
    isMaintainedPath: review.isMaintainedPath,
    duplicatedCodes: input.duplicatedCodes,
    serve: input.serve ? toProbedState(input.serve) : null,
    shell: input.shell,
    controls: input.controls,
    activity: input.activity,
    markdownSources: review.markdownSources,
    hubChildren: review.hubChildren,
    regions: review.regions,
    lineAttribution: review.lineAttribution,
    timings: input.timings,
    markdown: input.markdown,
  };

  switch (tab) {
    case 'landing':
      return landingBodyHtml(input);
    case 'regions':
      return regionsTabHtml({
        ...regionsStripOptions(seg, review.regions),
        forceRender: true,
      }) || emptyTab('No review regions yet — this task has no committed work to carve.');
    case 'changes':
      return reviewTaskHtml(
        task,
        review.diffText ?? '',
        review.reviewComments ?? [],
        review.notice,
        review.state,
        review.fileViolations ?? [],
        { ...embedExtras, embed: 'changes' },
      ) || emptyTab('No changes to show yet.');
    case 'verify': {
      const parts = partitionVerifyReports(
        input.turnReports ?? (input.turnReport ? [input.turnReport] : []),
        input.lastAgentTurn ?? null,
      );
      return verifyTabHtml({
        current: parts.current,
        currentSequence: parts.currentSequence,
        earlier: parts.earlier,
        shell: input.shell ?? null,
        taskCode: displayId(task),
        markdown: input.markdown,
      });
    }
    case 'turns': {
      const clock = input.timings ?? unmeasured();
      return clock.measureSync('turns', () => {
        const turns = taskTurnsSectionHtml(task, session, input.turns, chunkOrder, {
          commits: input.commits,
          comments: input.comments,
          journal: input.journal,
          duplicatedCodes: input.duplicatedCodes,
        }, input.markdown);
        return turns.trim() ? turns : emptyTab('No turns yet.');
      });
    }
    case 'commits': {
      const body = taskCommitsSectionHtml(task, input.commits, input.duplicatedCodes);
      return body.trim() ? body : emptyTab('No commits yet.');
    }
    case 'reviews':
      return reviewsTabHtml(seg, acceptGateTurns(input.turns));
    case 'subtasks':
      return (input.timings ?? unmeasured()).measureSync('children', () =>
        subtasksSectionHtml({
          parentId: task.id,
          children: input.children,
          subtreeCounts: input.subtreeCounts,
        }) || emptyTab('No subtasks.'),
      );
    case 'raised': {
      const notice = review.notice
        ? `<div class="rv-notice${review.notice.error ? ' rv-notice-err' : ''}">${escapeHtml(review.notice.text)}</div>`
        : '';
      return notice + (raisedItemsSummary(seg, input.raisedItems, { duplicatedCodes: input.duplicatedCodes }) || taskRaisedSectionHtml(input.raisedItems, input.markdown, { duplicatedCodes: input.duplicatedCodes }) || emptyTab('No raised items.'));
    }
    case 'comments':
      return taskCommentsTabHtml({
        taskId: seg,
        taskStatus: task.status,
        comments: input.comments,
        session: input.session,
        turns: input.turns,
        markdown: input.markdown,
      });
    case 'journal':
      return taskJournalTabHtml(input.journal, input.markdown);
    case 'stats': {
      const stats = input.stats;
      // The route loads these only for a real Stats render; absent means this
      // render never asked for them, which is not the same as "no data".
      if (!stats) return emptyTab('Stats were not loaded for this render.');
      return (input.timings ?? unmeasured()).measureSync('stats', () =>
        statsTabHtml(stats.stats, {
          scope: stats.scope,
          descendantCount: stats.descendantCount,
          taskHref: statsScopeHref(seg, 'task'),
          subtreeHref: statsScopeHref(seg, 'subtree'),
        }),
      );
    }
    case 'shell':
      return shellTabHtml({
        taskId: seg,
        taskCode: displayId(task),
        avail: input.shell ?? { available: false, reason: 'No shell on this page.', code: 'no-session' },
      });
    case 'services': {
      const advice = branchServeAdviceHtml(input.branchAdvice ?? []);
      const card = servicesCardHtml(task, input.serve ? toProbedState(input.serve) : null, input.controls);
      const body =
        serveNoticeBannerHtml(task, input.serveNotice, input.serve ? toProbedState(input.serve) : null, input.controls) +
        (card || '') +
        advice;
      return body.trim() ? body : emptyTab('No services declared.');
    }
    case 'review': {
      const session = input.session;
      const hasOpenSession = session !== null && !session.ended_at;
      return currentReviewHtml({
        task,
        comments: review.reviewComments ?? [],
        // Task comments (`lazy comment`, the Comments tab) the agent has not
        // been shown — resolved by the same function the Comments tab uses.
        queuedNotes: queuedComments(input.comments, session, input.turns),
        raisedItems: input.raisedItems,
        fileViolations: review.fileViolations ?? [],
        viewedFiles: input.viewedFiles ?? {},
        draft: review.draft ?? {},
        live: review.state ?? askLiveStateFallback(task, session, input.turns.length),
        notice: review.notice,
        remedy: review.remedy,
        submitPreflight: input.submitPreflight,
        upstream: input.upstream,
        hasOpenSession,
        hasCommits: input.commits.length > 0,
        verifyProgress: currentVerifyProgress(input),
        turns: acceptGateTurns(input.turns),
        duplicatedCodes: input.duplicatedCodes,
        // The ANSWER, from the one resolver — never the turns for this page to
        // re-derive finality from.
        final: buildShowFinal(input.turns),
      });
    }
  }
}

function currentVerifyProgress(input: TaskPageInput): { verified: number; total: number } {
  const parts = partitionVerifyReports(
    input.turnReports ?? (input.turnReport ? [input.turnReport] : []),
    input.lastAgentTurn ?? null,
  );
  const source = howToVerifySource(parts.current);
  const steps = source ? splitVerifySteps(source) : [];
  return countVerifiedSteps(input.viewedFiles ?? {}, parts.currentSequence, steps);
}

function tabBadges(input: TaskPageInput): Partial<Record<TaskTabId, TaskTabBadge>> {
  const badges: Partial<Record<TaskTabId, TaskTabBadge>> = {};
  if (input.children.length) badges.subtasks = { text: String(input.children.length) };
  const blocking = input.raisedItems.filter((i) => i.status === 'open' && i.blocking).length;
  if (blocking) badges.raised = { text: String(blocking), title: `${blocking} blocking` };
  else if (input.raisedItems.length) badges.raised = { text: String(input.raisedItems.length) };
  if (input.turns.length) badges.turns = { text: String(input.turns.length) };
  // Only reviews the tab actually lists — a failed/unparsed review turn is not
  // one, and a badge counting those would send the reader to an empty row.
  const reviews = reviewsTabCount(acceptGateTurns(input.turns));
  if (reviews) badges.reviews = { text: String(reviews), title: `${reviews} formal review${reviews === 1 ? '' : 's'}` };
  if (input.comments.length) {
    // Queued/total, so a reviewer sees from the strip that feedback is waiting
    // for a turn that has not run. Same cutoff the next unblock will use.
    const pending = queuedComments(input.comments, input.session, input.turns).length;
    badges.comments = pending
      ? { text: `${pending}/${input.comments.length}`, title: `${pending} queued for the next turn` }
      : { text: String(input.comments.length) };
  }
  if (input.journal.length) badges.journal = { text: String(input.journal.length) };
  // Stats badges the number the tab exists for — total recorded tokens — not a
  // row count. It is summed from the turns the strip already has, so every tab
  // can show it without the Stats tab's own loads.
  const tokens = input.turns.reduce(
    (sum, turn) =>
      sum +
      (turn.usage
        ? turn.usage.inputTokens +
          turn.usage.outputTokens +
          turn.usage.cacheCreationTokens +
          turn.usage.cacheReadTokens
        : 0),
    0,
  );
  if (tokens > 0) {
    badges.stats = {
      text: formatTokens(tokens),
      title: `${tokens.toLocaleString('en-US')} tokens recorded across this task's turns`,
    };
  }
  if (input.commits.length) badges.commits = { text: String(input.commits.length) };
  // Only present on the tabs that already loaded the cover — a badge is not
  // worth carving a release hub on every tab render.
  const regionRows = input.review?.regions?.rows;
  if (regionRows?.length) {
    badges.regions = { text: String(regionRows.length), title: `${regionRows.length} review regions` };
  }
  const queued = (input.review?.reviewComments ?? []).filter(
    (c) => c.role === 'human' && c.intent === 'comment' && c.delivery_state === 'pending_delivery' && !c.withdrawn_at,
  ).length;
  if (queued) badges.review = { text: String(queued), title: `${queued} queued` };
  const verify = currentVerifyProgress(input);
  if (verify.total > 0) {
    badges.verify = {
      text: `${verify.verified}/${verify.total}`,
      title: `${verify.verified} of ${verify.total} verified`,
    };
  }
  return badges;
}

/**
 * Everything the region keys compare, pulled from what the page already loaded.
 *
 * The page and `GET /tasks/:id/live-status` must build identical keys or the
 * poller would see a change on its very first tick. Both go through
 * `buildLiveRegionKeys`; this is the page's half of the input.
 */
function liveRegionSources(input: TaskPageInput): TaskLiveRegionSources {
  return {
    children: input.children.map((c) => ({ id: c.id, status: c.status })),
    turns: input.turns.map((t) => ({ id: t.id, sequence: t.sequence, review: t.review })),
    comments: input.comments.map((c) => ({ id: c.id, edited_at: c.edited_at })),
    journal: input.journal.map((j) => ({ id: j.id })),
    raised: input.raisedItems.map((r) => ({ id: r.id, status: r.status })),
    commits: input.commits.map((c) => ({ sha: c.sha })),
    headSha: input.headSha ?? null,
  };
}

/**
 * The full tabbed page, or strip + body when `fragment` is set (same renderer
 * either way — the island fetches `?fragment=1`). Pass `chrome` with fragment
 * to also emit the landing header for a live-status refresh, and `omitBody`
 * to get header + strip alone.
 */
export function taskPageHtml(input: TaskPageInput): string {
  const clock = input.timings ?? unmeasured();
  const hideShell = input.shell?.available === false && input.shell.code === 'no-container-runner';
  const seg = pageSeg(input);
  const strip = taskTabStripHtml({
    taskId: seg,
    current: input.tab,
    hideShell,
    badges: tabBadges(input),
  });
  const header = landingHeaderHtml(input);
  // No extra wrapper around the body: reviewTaskHtml opens `changes` /
  // `threads` / `report` on this same clock, and those must land as
  // `render.changes` (the names the slow-page diagnosis uses), not
  // `render.tab_body.changes`.
  const omitBody = Boolean(input.fragment && input.omitBody);
  const body = omitBody ? '' : tabBodyHtml(input);
  const persistShell = input.shell && !hideShell
    ? `<div data-lz-persist-shell>${shellPanelHtml(seg, input.shell)}</div>`
    : '';
  // Watch lives in the always-on header (outside the swapped tab body), so
  // an in-place tab switch does not tear the panel down — no persist host.

  // Page-wide sticky bar (design §5.9). Lives outside the tab body so an
  // in-place switch does not tear it down; the same poll that refreshes
  // threads writes data-rv-askable here, which the re-send flow reads.
  const reviewComments = input.review?.reviewComments ?? [];
  const live: ReviewLiveState = input.review?.state
    ?? askLiveStateFallback(input.task, input.session, input.turns.length);
  const bar = statusBarHtml(
    input.task,
    live,
    pendingDeliveryComments(reviewComments).length,
    reviewComments.filter((c) => c.ask_state === 'pending').length,
    {
      // The full child list, so a loop's k/n in the bar is the same derivation
      // the Subtasks rollup and `lazy show` print.
      children: input.children,
      everQueued: hasAnyQueuedComment(reviewComments),
      everAsked: hasAnyAsk(reviewComments),
      duplicatedCodes: input.duplicatedCodes,
    },
  );

  const persistRaised = `<div data-lz-persist-raised>${raisedDialogChromeHtml({
    bodyHtml: input.openRaisedPanel,
    open: Boolean(input.openRaisedId),
  })}</div>`;
  const persistAction = `<div data-lz-persist-action>${actionDialogChromeHtml()}</div>`;

  const liveKeys = buildLiveStatusKeys(
    {
      task: input.task,
      session: input.session,
      progress: input.progress,
      turns: input.turns.length,
    },
    liveRegionSources(input),
  );
  const liveToken = liveKeysToken(liveKeys);

  const tabPath = taskTabHref(seg, input.tab);
  const inner =
    `<div data-lz-task-page data-lz-task-id="${escapeHtml(seg)}" data-lz-current-tab="${input.tab}" data-lz-live-token="${escapeHtml(liveToken)}" data-lz-live-keys="${escapeHtml(JSON.stringify(liveKeys))}">` +
    header +
    strip +
    `<div data-lz-persist>${persistRaised}${persistAction}</div>` +
    `<div class="lz-tab-body" data-lz-tab-body data-lz-tab-path="${escapeHtml(tabPath)}">${body}</div>` +
    persistShell +
    `</div>`;

  if (input.fragment) {
    // Plain tab switch: strip + body only. Live-status (`chrome`) also needs
    // the header so status/actions update without a full navigation.
    const bodyEl = omitBody
      ? ''
      : `<div class="lz-tab-body" data-lz-tab-body data-lz-tab-path="${escapeHtml(tabPath)}">${body}</div>`;
    // The island re-stamps the keys from the poll payload, not from here: the
    // payload is what it compared against, so stamping anything else could
    // make it miss the next change. A fragment rendered a moment later than
    // the payload only ever costs one redundant (no-op) morph.
    return input.chrome ? `${header}${strip}${bodyEl}` : `${strip}${bodyEl}`;
  }

  const scripts =
    reviewDraftScript(seg) +
    viewedStateScript(input.task.id, { serverState: input.viewedFiles ?? {} }) +
    reviewNavigationScript() +
    screenshotLightboxScript() +
    reviewScript(seg, { lineDrafts: input.lineDrafts ?? {} }) +
    taskTabSwitchScript() +
    raisedDialogScript() +
    actionDialogScript() +
    verifyCopyScript() +
    (input.shell ? verifyRunScript() : '') +
    (input.shell?.available ? shellClientScript() : '') +
    (!isTerminalStatus(input.task.status) ? watchClientScript() : '') +
    // Always wire the poller: a backlog/blocked page still needs to notice
    // a start or unblock that happened in another tab. Terminal tasks omit
    // it — nothing further will change the chrome.
    (!isTerminalStatus(input.task.status) ? domMorphScript() + taskLiveStatusScript() : '');

  return clock.measureSync('layout', () =>
    layoutHtml(`Task ${displayId(input.task)}`, inner + bar + scripts),
  );
}
