/**
 * Lazy HTTP server
 *
 * Serves a read-only HTML dashboard for lazy tasks, sessions, and search.
 * Uses Bun's built-in HTTP server with no additional dependencies.
 */

import { withPromotedTaskCodes } from '../task/show-sections';
import { reviewSettingsViewOf, type ReviewSettingsView } from '../review/mode';
import type { Storage, Task, Session, StatusChange, Turn } from '../storage';
import { getCommitDiff } from '../git/operations';
import { executeSearch, QueryParseError } from '../search';
import { logger } from '../utils/logger';
import { latestAgentWorkTurn } from '../task/turn-context';

import {
  taskListHtml,
  searchResultsHtml,
  errorHtml,
  commitDetailHtml,
  promptVersionHtml,
  taskEditHtml,
  taskCreateHtml,
  taskCreateFormHtml,
  taskLinkHtml,
  type TaskEditDraft,
  type AgentChoice,
  dashboardHtml,
  totalInputTokens,
  TASK_LIST_SORT_FIELDS,
  type TaskListSortField,
} from './templates';
import { parseSortParam, type SortConfig } from './sort';
import type { DashboardStats, TaskWithSession, ActiveTaskInfo, ActivityDay, ActiveStates } from './templates';
import { buildChartData } from './throughput-chart';
import { reviewQueueHtml, reviewTaskHtml, threadsJson, parseRaisedResolutionsFromForm, parseReviewQueueSort, sortReviewQueue, type ReviewDraft, type ReviewLiveState } from './review';
import { regionExtras } from './review-regions';
import { parseUnifiedDiff } from './review-diff';
import { loadMarkdownSources } from './review-markdown';
import { buildTaskCodeLinkify } from './task-code-links';
import { taskPath, taskPathSegment, taskCodeTables, duplicateTaskCodes, decodePathSegment, type TaskPathRef } from './task-urls';
import { buildSymbolTable } from './review-symbols';
import type { MarkdownLinkifyTable, RenderMarkdownOptions } from './markdown';
import { resolveShellContainer } from './shell-ws';
import type { ShellAvailability } from './shell-ui';
import { computeReviewActivity, type ReviewActivity } from './review-activity';
import { RenderTimings, SERVER_TIMING_HEADER } from './render-timings';
import { TASK_LEVEL_REVIEW_ANCHOR } from '../review/task-level-anchor';
import { acceptRemedyOf, isClusterTask, isTerminalStatus, VALID_TASK_TYPES, type AcceptRemedy, type RaisedItemResolveAction, type RaisedItem, type ReviewDraftPatch, type ReviewDraftState } from '../types';
// The daemon's own dashboard has no sign-in, so every review it renders is the
// single-IC reviewer's. A Teams client reaches the same drafts over RPC, where
// the key comes from that request's user token instead.
import {
  LOCAL_REVIEWER,
  MAX_LINE_DRAFTS,
  parseReviewDraftPatch,
  ReviewDraftPatchError,
} from '../review-draft';
import {
  resolveAskAvailability,
  unblockUnavailableReason,
  acceptBlockedByViolations,
  type ReviewActions,
} from './review-actions';
import { isValidMessageId, type MessageActions } from './message-actions';
import type { ReviewSessionActions } from './review-session-actions';
import type { TaskActions, TaskCreateInput, TaskEditInput } from './task-actions';
import { parseCreateTaskForm, type TaskCreateDraft } from './task-create-form';
import { parseLinkTaskForm, type TaskLinkDraft } from './task-link-form';
import { taskCanOfferSubmit } from './submit-action';
import {
  TASK_PAGE_VERBS,
  REASON_REQUIRED_VERBS,
  taskPageVerbUnavailableReason,
  restructureVerbUnavailableReason,
  type TaskPageVerb,
} from './task-verbs';
import { submitConfirmMatches } from '../submit-confirmation';
import { taskEditability, lockedFieldsReason, LOCKED_ONCE_STARTED } from '../task-edit-rules';
import { currentPromptOf } from '../task-prompt';
import { listSelectableAgents } from '../agent/registry';
import { agentProfilesFor, selectableAgentProfiles, agentProfileSummary } from '../config/agent-profiles';
import { VALID_EFFORT_LEVELS } from '../config/types';
import {
  REVIEW_WITH_BUILDER_GONE_MESSAGE,
  reviewSessionPageHtml,
  reviewSessionPollJson,
} from './review-session';
import { messagesInboxHtml, messageDetailHtml, unreadCount } from './messages';
import { computeNavCounts } from './nav-counts';
import { scratchIndexHtml, scratchSearchHtml, scratchFileHtml } from './scratch';
import { groupScratchBySession, scratchEntry, searchScratch, scratchPathsMentionedIn } from '../builder/scratch-view';
import {
  raisedInboxHtml,
  raisedPanelHtml,
  raisedListOptions,
  orderRaisedForDisplay,
  parseRaisedSort,
  similarRaisedForDetail,
  type RaisedView,
} from './raised';
import type { ListedRaisedItem } from '../raised';
import { parseRaisedDecisionForm, raisedDecisionNotice } from './raised-decide';
import {
  conversationsIndexHtml,
  conversationsSearchHtml,
  conversationDetailHtml,
  conversationsApiPayload,
  resolveConversationSessionId,
  runConversationSearch,
  MESSAGES_PER_PAGE,
} from './conversations';
import {
  buildConversationTaskPrompt,
  conversationPromotions,
  defaultConversationCode,
  defaultConversationGoal,
  resolveMessageRange,
  type MessageRange,
} from '../conversation/promote';
import type { MemoryActions } from './memory-actions';
import type { DoctorActions } from './doctor-actions';
import type { ServeActions } from './serve-actions';
import {
  settingsDoctorHtml,
  doctorStreamOpenHtml,
  doctorProgressLineHtml,
  doctorStreamCloseHtml,
  doctorDialogEventLine,
} from './settings';
import { isDoctorRemedyFlag, isDestructiveRemedy, type DoctorRemedyFlag } from '../doctor/remedies';
import {
  memoryIndexHtml,
  memoryShowHtml,
  memoryNewHtml,
  memoryRemoveConfirmHtml,
  memoryCompactHtml,
  memoryCompactStreamOpenHtml,
  memoryCompactProgressLineHtml,
  memoryCompactStreamResultHtml,
  memoryCompactStreamErrorHtml,
  memoryApiPayload,
  formString,
} from './memory';
import { DEFAULT_MEMORY_WARN_BYTES, normalizeMemoryName } from '../memory';
import type { CompactMode } from '../memory/run-compact';
import { isUnreadSystemMessage } from '../messages';
import { STYLESHEET_PATH, bundledStylesheet, stylesheetFromDisk } from './styles';
import {
  MERMAID_ASSET_PATH,
  bundledMermaidJs,
  mermaidJsFromDisk,
} from './mermaid';
import {
  XTERM_JS_PATH,
  XTERM_FIT_JS_PATH,
  XTERM_CSS_PATH,
  bundledXtermJs,
  bundledXtermFitJs,
  bundledXtermCss,
  xtermJsFromDisk,
  xtermFitJsFromDisk,
  xtermCssFromDisk,
} from './xterm';
import {
  taskRefFromId,
  taskRef,
  getWorktreePath,
  getBranchName,
  TASK_PATH_SEGMENT_NEW,
  TASK_PATH_SEGMENT_LINK,
} from '../task/identity';
import { taskBranchFor } from '../git/branch-prefix';
import { runGit } from '../utils/git';
import { parentTaskIdOf } from '../task-target';
import { branchServeAdviceFor } from '../serve/branch-advice';
import { childSubtreeCounts } from './subtasks';
import { classifyHubChildren } from '../task-diff-base';
import { MAX_PORT_ATTEMPTS } from '../config/constants';
import { DAEMON_IDLE_TIMEOUT_S, WEB_REQUEST_DEADLINE_MS } from '../daemon/heartbeat';
import { RpcError } from '../daemon/rpc-error';
import { stoppableClaimOf } from '../daemon/in-flight-turn';
import { turnText } from '../utils/turn-content';
import type { FileViolation } from '../types';
import { findLazyRoot } from '../project-paths';
import { resolveOutstandingViolations } from '../protection/outstanding-resolver';
import { outstandingFromRecords, violationRecordsByFile } from '../protection/outstanding';
import { loadConfig } from '../config/loader';
import { join } from 'path';
import { parseStatsScope } from '../task/stats';
import { loadTaskStats, type TaskStatsResult } from '../task/stats-data';
import { taskLaunchIdentityView, type TaskLaunchIdentityView } from '../task/launch-identity-view';
import { readProjectSettings, resolveProjectModel } from '../daemon/project-settings';
import { pathMatchesAnyMaintainPattern } from '../automation/maintain-match';
import {
  loadProtectionContext,
  contextIsInert,
  protectionStatusForTask,
  type TaskProtectionStatus,
} from '../protection/status';
import { getTaskServeState } from '../serve/discovery';
import { probeServices } from '../serve/probe';
import type { ProbedServeState, ServicesCardControls } from './services-card';
import { beginContainerStart, getContainerStart, containerStartJson } from './container-start';
import {
  beginActionRun,
  getActionRun,
  actionRunJson,
  actionRunMatchesPath,
  wantsActionDialog,
} from './action-run';
import type { ProgressEmitter } from '../daemon/progress';
import { parseServeNotice } from './serve-notice';
import type { WebSocketUpgrader } from './ws';
import { taskPageHtml, type TaskPageReviewExtras, type TaskProgressLine } from './task-page';
import { commentSaveFailedHtml, commentEditRefusedHtml } from './task-notes';
import { editUnseenComment, CommentAlreadySeenError, CommentNotFoundError } from '../task/comment-edit';
import { relocatedReviewPath, isTaskTabSlug, type TaskTabId } from './task-tabs';
import { buildLiveStatusPayload, type TaskLiveRegionSources } from './task-live-status';
import { sanitizeUserText } from '../utils/sanitize-text';
import { getActor } from '../constants';
import { clustersPageHtml } from './cluster-tasks';
import { activeClusterCount, listClusterEntries, type ClusterEntry } from '../task/cluster-entries';
import { actionDialogChromeHtml, actionDialogScript } from './action-dialog';
import { protocolDir } from '../protocol';
import { readTaskProgress } from '../protocol/progress';
import type { TurnReport } from '../types';
import { usagePauseBannerHtml } from './usage-pause-banner';
import type { UsagePauseState } from '../daemon/usage-pause';

/**
 * Protection status for a page's tasks, keyed by task id — the SAME derivation
 * the CLI renders (src/protection/status.ts), so the dashboard can never claim
 * a different gate than `lazy show` does.
 *
 * Returns an empty map when the project protects nothing, so an ordinary
 * project's pages do no extra work. Never throws: a dashboard page must render
 * even when protection config cannot be read.
 */
async function protectionForTasks(
  storage: Storage,
  tasks: Task[],
): Promise<Map<string, TaskProtectionStatus>> {
  const byTask = new Map<string, TaskProtectionStatus>();
  try {
    const root = findLazyRoot();
    if (!root) return byTask;
    const config = await loadConfig(root);
    const ctx = await loadProtectionContext(storage, config, root);
    if (contextIsInert(ctx)) return byTask;
    for (const task of tasks) {
      byTask.set(task.id, await protectionStatusForTask(storage, ctx, task));
    }
  } catch (err) {
    logger.debug(`Dashboard: could not resolve protection status: ${err instanceof Error ? err.message : err}`);
  }
  return byTask;
}

/**
 * What a task runs on — agent profile, model, effort — for the always-on header.
 *
 * Same ladder a launch resolves, through the shared read-only view
 * (src/task/launch-identity-view.ts) so the header cannot claim a different
 * model than the next turn would use. Never throws and never guesses: a project
 * whose config cannot be read gets `null`, and the header simply omits the
 * items rather than printing a value nobody resolved.
 */
/**
 * The task's effective review settings, pre-composed: the line, what each value
 * means, where each came from, and the docs pointer.
 *
 * Composed with the same helper `lazy show` and `lazy_show` use, so the three
 * surfaces cannot word it differently. Null on an unreadable config, exactly
 * like the launch identity above — the header drops the item rather than
 * guessing.
 */
async function reviewViewForTask(
  task: Task,
  parentTask: Task | null,
): Promise<ReviewSettingsView | null> {
  try {
    const root = findLazyRoot();
    if (!root) return null;
    const config = await loadConfig(root);
    // The parent matters only for a task that has not launched: it has pinned
    // nothing, so without its parent the header would claim the project default
    // on a child whose hub chose otherwise.
    return reviewSettingsViewOf(task.metadata, config.review, {
      metadata: parentTask?.metadata,
      code: parentTask?.code,
    });
  } catch (err) {
    logger.debug(`Dashboard: could not resolve review settings: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function launchIdentityForTask(
  storage: Storage,
  task: Task,
): Promise<TaskLaunchIdentityView | null> {
  try {
    const root = findLazyRoot();
    if (!root) return null;
    const config = await loadConfig(root);
    const settings = await readProjectSettings(storage);
    return taskLaunchIdentityView({
      task,
      config,
      projectModel: resolveProjectModel(settings, config),
    });
  } catch (err) {
    logger.debug(`Dashboard: could not resolve launch identity: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function html(content: string, status: number = 200): Response {
  return new Response(content, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Answer a measured page: attach the numbers to the response and log them.
 *
 * The ONE place a measured render turns into a Response, so a route cannot
 * accidentally ship a page with the header missing, or with a total that stops
 * before the HTML was actually built. `Server-Timing` is emitted on every such
 * render — permanently, not behind a flag — because the whole point is that
 * page cost is measured rather than guessed. The debug LINE is gated: the
 * numbers are already on the response, so building a second copy as a string
 * is the only part worth skipping when nothing reads it.
 *
 * `html_bytes` is counted here rather than by the caller so it can never
 * disagree with the body actually sent. `Buffer.byteLength` does not allocate,
 * and the HTTP layer walks the same bytes anyway to set Content-Length.
 */
function timedHtml(timings: RenderTimings, content: string, status: number = 200): Response {
  timings.count('html_bytes', Buffer.byteLength(content, 'utf8'));
  timings.finish();
  const response = html(content, status);
  response.headers.set(SERVER_TIMING_HEADER, timings.header());
  if (logger.isDebugEnabled()) logger.debug(timings.logLine());
  return response;
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A refused action: HTML for a plain form POST, JSON for the action dialog
 * (which stays open and paints the error). Same status either way.
 */
function refuseAction(dialog: boolean, title: string, message: string, status: number): Response {
  if (dialog) return json({ error: message }, status);
  return html(errorHtml(title, message), status);
}

function actionRunStarted(
  taskId: string,
  operation: string,
  work: (onProgress: ProgressEmitter) => Promise<{ redirect: string }>,
): Response {
  return json(actionRunJson(beginActionRun({ taskId, operation, work })), 202);
}

type SortField = TaskListSortField;

function parseTaskListSort(sort: string | null, filter: string): SortConfig<SortField> {
  // Default: blocked filter sorts by last_active DESC, others by created DESC.
  // An unrecognised field falls back to the same default, so a hand-edited URL
  // lands on the order the page would have shown anyway.
  const fallback: SortConfig<SortField> = (filter === 'blocked' || filter === 'conflict' || filter === 'submitted')
    ? { field: 'last_active', direction: 'desc' }
    : { field: 'created', direction: 'desc' };
  return parseSortParam(sort, TASK_LIST_SORT_FIELDS, fallback);
}

function sortTasks(
  tasksWithSessions: { task: Task; session: Session | null; turnCount?: number }[],
  sortConfig: SortConfig<SortField>,
): void {
  const dir = sortConfig.direction === 'desc' ? -1 : 1;

  tasksWithSessions.sort((a, b) => {
    let cmp = 0;

    switch (sortConfig.field) {
      case 'status': {
        const aStatus = a.session?.outcome ?? (a.session?.ended_at ? 'ended' : a.task.status);
        const bStatus = b.session?.outcome ?? (b.session?.ended_at ? 'ended' : b.task.status);
        cmp = aStatus.localeCompare(bStatus);
        break;
      }
      case 'agent': {
        cmp = a.task.agent_id.localeCompare(b.task.agent_id);
        break;
      }
      case 'model': {
        const aModel = a.task.model ?? '';
        const bModel = b.task.model ?? '';
        cmp = aModel.localeCompare(bModel);
        break;
      }
      case 'last_active': {
        const aTime = a.session?.last_interaction_at ?? null;
        const bTime = b.session?.last_interaction_at ?? null;
        if (aTime === null && bTime === null) cmp = 0;
        else if (aTime === null) cmp = 1;  // nulls always sort to bottom
        else if (bTime === null) cmp = -1;
        else cmp = aTime - bTime;
        // For last_active, return early to handle null-to-bottom correctly
        if (aTime === null || bTime === null) {
          return cmp || (b.task.created_at - a.task.created_at);
        }
        break;
      }
      case 'turns': {
        const aTurns = (a as { turnCount?: number }).turnCount ?? 0;
        const bTurns = (b as { turnCount?: number }).turnCount ?? 0;
        cmp = aTurns - bTurns;
        break;
      }
      case 'duration': {
        const aDur = a.session?.total_duration_ms ?? 0;
        const bDur = b.session?.total_duration_ms ?? 0;
        cmp = aDur - bDur;
        break;
      }
      case 'tokens': {
        const aTokens = a.session?.total_usage
          ? a.session.total_usage.inputTokens + a.session.total_usage.outputTokens + a.session.total_usage.cacheCreationTokens + a.session.total_usage.cacheReadTokens
          : 0;
        const bTokens = b.session?.total_usage
          ? b.session.total_usage.inputTokens + b.session.total_usage.outputTokens + b.session.total_usage.cacheCreationTokens + b.session.total_usage.cacheReadTokens
          : 0;
        cmp = aTokens - bTokens;
        break;
      }
      case 'goal': {
        cmp = a.task.goal.localeCompare(b.task.goal);
        break;
      }
      case 'created': {
        cmp = a.task.created_at - b.task.created_at;
        break;
      }
    }

    // Apply direction, then stable fallback to created_at DESC
    return (cmp * dir) || (b.task.created_at - a.task.created_at);
  });
}

function toUTCDateString(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function buildActivityData(
  storage: Storage,
  tasksWithSessions: TaskWithSession[],
): Promise<ActivityDay[]> {
  const dailyMap = new Map<string, { humanTurns: number; agentTurns: number; tasksAccepted: number }>();

  // Count turns from all sessions
  await Promise.all(
    tasksWithSessions
      .filter(({ session }) => session !== null)
      .map(async ({ session }) => {
        const turns = await storage.getSessionTurns(session!.id);

        for (const turn of turns) {
          const date = toUTCDateString(turn.timestamp);
          let entry = dailyMap.get(date);
          if (!entry) {
            entry = { humanTurns: 0, agentTurns: 0, tasksAccepted: 0 };
            dailyMap.set(date, entry);
          }
          if (turn.role === 'human') entry.humanTurns++;
          else entry.agentTurns++;
        }
      })
  );

  // Count tasks accepted by their completion date
  for (const { task } of tasksWithSessions) {
    if (task.completed_at && task.status === 'complete') {
      const date = toUTCDateString(task.completed_at);
      let entry = dailyMap.get(date);
      if (!entry) {
        entry = { humanTurns: 0, agentTurns: 0, tasksAccepted: 0 };
        dailyMap.set(date, entry);
      }
      entry.tasksAccepted++;
    }
  }

  const result: ActivityDay[] = [];
  for (const [date, counts] of dailyMap) {
    result.push({ date, ...counts });
  }
  result.sort((a, b) => a.date.localeCompare(b.date));
  return result;
}

/**
 * The dashboard's usage-pause status line. A failure to read the state costs
 * the line, never the page: it is logged, and the rest of the dashboard renders.
 */
async function dashboardUsagePauseHtml(usagePauseState?: () => Promise<UsagePauseState>): Promise<string> {
  if (!usagePauseState) return '';
  try {
    return usagePauseBannerHtml(await usagePauseState());
  } catch (err) {
    logger.warn(`Dashboard: could not read the usage-pause state: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

async function handleDashboard(
  storage: Storage,
  usagePauseState?: () => Promise<UsagePauseState>,
): Promise<Response> {
  const allTasks = await storage.listTasks();

  // Fetch sessions for each task
  const allWithSessions: TaskWithSession[] = await Promise.all(
    allTasks.map(async (task) => ({
      task,
      session: await storage.getSessionByTaskId(task.id),
    }))
  );

  // Count by status
  let workingCount = 0;
  let blockedCount = 0;
  let interruptedCount = 0;
  let completedCount = 0;
  let pairingCount = 0;
  let mergingCount = 0;
  let submittedCount = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalDurationMs = 0;

  for (const { task, session } of allWithSessions) {
    switch (task.status) {
      case 'working': workingCount++; break;
      case 'blocked': blockedCount++; break;
      case 'submitted':
        submittedCount++;
        break;
      case 'pairing':
        blockedCount++; // pairing counts as needing attention
        pairingCount++;
        break;
      case 'merging':
        blockedCount++; // merging counts as needing attention (waiting for CI/merge)
        mergingCount++;
        break;
      case 'interrupted': interruptedCount++; break;
      case 'complete': completedCount++; break;
      case 'abandoned': completedCount++; break;
      default: break; // backlog and any other statuses
    }
    if (session?.total_usage) {
      totalTokensIn += totalInputTokens(session.total_usage);
      totalTokensOut += session.total_usage.outputTokens;
    }
    if (session) {
      totalDurationMs += session.total_duration_ms;
    }
  }

  // Active states for sidebar display
  const activeStates = {
    working: workingCount,
    blocked: blockedCount - pairingCount - mergingCount, // blocked excluding pairing/merging
    interrupted: interruptedCount,
    merging: mergingCount,
    pairing: pairingCount,
    submitted: submittedCount,
  };

  // Recently created tasks (last 24h, sorted by creation time DESC)
  const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentlyCreatedTasks = allWithSessions
    .filter(({ task }) => task.created_at >= twentyFourHoursAgo)
    .sort((a, b) => b.task.created_at - a.task.created_at);

  // Active/working tasks with last turn summary
  const workingTaskEntries = allWithSessions
    .filter(({ task }) => task.status === 'working')
    .sort((a, b) => {
      const aTime = a.session?.last_interaction_at ?? a.task.created_at;
      const bTime = b.session?.last_interaction_at ?? b.task.created_at;
      return bTime - aTime;
    });

  const activeTasks: ActiveTaskInfo[] = await Promise.all(
    workingTaskEntries.map(async ({ task, session }) => {
      let lastTurnSummary = '';
      if (session) {
        const turns = await storage.getSessionTurns(session.id);
        if (turns.length > 0) {
          const lastTurn = turns[turns.length - 1];
          lastTurnSummary = turnText(lastTurn).replace(/\s+/g, ' ').trim();
        }
      }
      return { task, session, lastTurnSummary };
    })
  );

  // Blocked tasks needing attention
  const blockedTasks = allWithSessions
    .filter(({ task }) => task.status === 'blocked' || task.status === 'conflict' || task.status === 'submitted' || task.status === 'pairing')
    .sort((a, b) => {
      const aTime = a.session?.last_interaction_at ?? a.task.created_at;
      const bTime = b.session?.last_interaction_at ?? b.task.created_at;
      return bTime - aTime;
    });

  // Build chart data from per-task status changelogs
  const statusHistories = new Map<string, StatusChange[]>();
  await Promise.all(
    allTasks.map(async (task) => {
      const history = await storage.getStatusHistory(task.id);
      statusHistories.set(task.id, history);
    })
  );
  const chartData = buildChartData(allTasks, statusHistories);

  // Build activity heatmap data (daily turns + commits)
  const activityData = await buildActivityData(storage, allWithSessions);

  // Unread system messages — the same set the builder gets injected on launch.
  const unreadMessages = (await storage.listSystemMessages()).filter(isUnreadSystemMessage);

  const duplicatedCodes = duplicateTaskCodes(await storage.listTaskCodes());

  const stats: DashboardStats = {
    totalTasks: allTasks.length,
    workingCount,
    blockedCount,
    interruptedCount,
    completedCount,
    submittedCount,
    totalTokensIn,
    totalTokensOut,
    totalDurationMs,
    recentlyCreatedTasks,
    activeTasks,
    blockedTasks,
    chartData,
    activityData,
    activeStates,
    unreadMessages,
    usagePauseHtml: await dashboardUsagePauseHtml(usagePauseState),
  };

  return html(dashboardHtml(stats, duplicatedCodes));
}

async function handleTaskList(storage: Storage, url: URL): Promise<Response> {
  const timings = new RenderTimings('/tasks');
  const filter = url.searchParams.get('filter') ?? '';
  const sortParam = url.searchParams.get('sort');
  const sortConfig = parseTaskListSort(sortParam, filter);

  const tasks = await timings.measure('storage.list', async () => {
    switch (filter) {
      case 'all':
        return await storage.listTasks();
      case 'working':
        return await storage.listTasksWithOptions({ workingOnly: true });
      case 'interrupted':
        return await storage.listTasksWithOptions({ interruptedOnly: true });
      case 'blocked':
        return await storage.listTasksWithOptions({ blockedOnly: true });
      case 'merging':
        return await storage.listTasksWithOptions({ mergingOnly: true });
      case 'submitted':
        return await storage.listTasksWithOptions({ submittedOnly: true });
      default:
        return await storage.listTasksWithOptions({ nonTerminalOnly: true });
    }
  });

  // Fetch sessions and turn counts for each task. One phase for the whole fan-
  // out, not one per task: N phases named after N tasks would be a header the
  // size of the page. The `tasks` count below is what makes N readable.
  const tasksWithSessions = await timings.measure('storage.sessions', () => Promise.all(
    tasks.map(async (task) => ({
      task,
      session: await storage.getSessionByTaskId(task.id),
      turnCount: await storage.getTurnCountByTaskId(task.id),
    }))
  ));

  // Sort tasks
  timings.measureSync('sort', () => sortTasks(tasksWithSessions, sortConfig));

  const protection = await timings.measure('protection', () => protectionForTasks(storage, tasks));
  for (const node of tasksWithSessions) {
    const status = protection.get(node.task.id);
    if (status) (node as TaskWithSession).protection = status;
  }

  timings.count('tasks', tasks.length);
  // One dup set per request, like search/palette: a code two tasks share makes
  // BOTH rows link by id rather than ambiguously.
  const duplicatedCodes = duplicateTaskCodes(await storage.listTaskCodes());
  return timedHtml(
    timings,
    timings.measureSync('render', () =>
      taskListHtml(tasksWithSessions, filter, sortConfig.field, sortConfig.direction, duplicatedCodes),
    ),
  );
}

/**
 * A task's `[serve]` mapping for the detail page, or null when it cannot be
 * read. Same posture as protectionForTasks above: the dashboard is a read-only
 * view, so a runner that is unreachable (no docker, stale container) must cost
 * the page a row, never the whole render.
 *
 * Detail page ONLY (and the review page). Resolving this costs a `docker port`
 * call per task, so it is one call for one task the human is already looking
 * at — the task LIST deliberately does not do it N times per render.
 *
 * Services come back PROBED: a parallel TCP connect per published port
 * (src/serve/probe.ts — close on connect, no bytes, ~300ms cap). That bound is
 * why the probe runs server-side at render instead of behind an /api poll: it
 * costs the page at most one probe timeout, not one per service.
 */
async function serveStateForTask(task: Task, session: Session | null): Promise<ProbedServeState | null> {
  try {
    const root = findLazyRoot();
    if (!root) return null;
    const state = await getTaskServeState(root, task, session);
    return { ...state, services: await probeServices(state.services) };
  } catch (err) {
    logger.debug(`Dashboard: could not resolve serve state: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Whether a web shell can be opened into this task, as far as a page render is
 * allowed to ask: does the task have a session, and does its runner have a
 * container at all (`resolveShellContainer`). Returns null when the project root
 * cannot be resolved — the page then shows no shell control at all rather than a
 * misleading one.
 *
 * It does NOT ask whether the container is running. That question costs a
 * `docker ps` with a ten-second cap and was being asked on every render of every
 * tab, which is why the Shell tab took ten seconds to appear while Docker was
 * wedged — and it no longer changes what the page shows, because opening the
 * shell starts the container.
 */
async function shellAvailabilityForTask(task: Task, session: Session | null): Promise<ShellAvailability | null> {
  try {
    const root = findLazyRoot();
    if (!root) return null;
    const target = await resolveShellContainer(root, task, session);
    return target.available
      ? { available: true }
      : { available: false, reason: target.reason, code: target.code };
  } catch (err) {
    logger.debug(`Dashboard: could not resolve shell availability: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * What the Services card and the shell block may offer for this task: a Start
 * container button, and a Start services button when the project has a Start
 * services command designated.
 *
 * The gate is deliberate on every clause. No action port means no mutation is
 * possible at all (a Storage-only dashboard). A terminal task's container is not
 * something to bring back — the task is over. And the button appears ONLY where
 * the page has actually established that the container is down: a button that
 * would be a no-op is noise, and one offered next to a live container invites a
 * restart nobody asked for. The daemon re-checks all of it.
 *
 * Only the SERVE state can establish "down" now — the Services tab probes ports
 * anyway, so it pays for the answer for its own reasons. Shell availability no
 * longer contributes, because the page no longer probes for it and because the
 * terminal controls start the container themselves rather than asking.
 */
/**
 * A task URL for a redirect or a link the route composes outside a page
 * render: code when the task has a unique code, id otherwise. Loads the code
 * tables per call (one index-served read) because a POST redirect must land on
 * the task that was acted on, and a duplicated code resolves to its winner —
 * a different task — instead.
 */
async function taskPageUrl(
  storage: Storage,
  origin: string,
  taskOrId: Task | string,
  suffix = '',
): Promise<string> {
  const [task, codes] = await Promise.all([
    typeof taskOrId === 'string' ? storage.getTask(taskOrId) : Promise.resolve(taskOrId),
    storage.listTaskCodes(),
  ]);
  const ref: TaskPathRef = task
    ? { id: task.id, code: task.code ?? null }
    : { id: typeof taskOrId === 'string' ? taskOrId : taskOrId.id };
  return `${origin}${taskPath(ref, duplicateTaskCodes(codes))}${suffix}`;
}

async function containerControlsForTask(
  task: Task,
  serve: ProbedServeState | null,
  shell: ShellAvailability | null,
  taskActions: TaskActions | undefined,
  serveActions: ServeActions | undefined,
  /** Task's URL segment (code or id, dup-aware) — form action + shell selector. */
  seg?: string,
): Promise<ServicesCardControls> {
  const containerDown = serve?.unavailable === 'not-running';
  return {
    taskId: seg ?? task.id,
    canStart: !!taskActions && !isTerminalStatus(task.status) && containerDown,
    start: getContainerStart(task.id),
    startServicesCmd: await readStartServicesCmd(serveActions),
    shellAvailable: shell?.available === true,
    // Designation saves to the project store through ServeActions —
    // without that port the form would 503, so it stays hidden.
    canDesignate: !!serveActions,
  };
}

/**
 * POST /tasks/:id/comments/add — add a comment from the Comments tab.
 *
 * INVARIANT: this persists a comment and NOTHING else. No signal is emitted, no
 * turn is started, no status changes — exactly as `lazy comment` behaves, and
 * for the same reason: a comment that auto-launched a turn raced the human's own
 * unblock and lost their real feedback. The comment rides the next unblock,
 * which builds its notes block from storage.
 *
 * Content is sanitized at this intake boundary, like every other comment
 * surface: the text becomes prompt text, which becomes argv of `claude -p`.
 *
 * NEVER LOSE HUMAN FEEDBACK (CLAUDE.md's first invariant): a failed write must
 * not swallow what someone typed. The store can refuse — a full disk, a lost
 * remote-storage connection, a task deleted between render and submit — and the
 * browser has already discarded the textarea by the time the response lands. So
 * the failure path renders the submitted text back VERBATIM, the same way
 * `handleTaskAction`'s `keptReason` carries a close/reject reason back, and says
 * what failed so the human knows whether re-submitting is worth trying.
 */
async function handleAddComment(
  storage: Storage,
  req: Request,
  url: URL,
  taskIdParam: string,
): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  const resolved = await storage.resolveTask(taskIdParam);
  const task = resolved.task;
  if (!task) {
    return html(errorHtml('Not Found', `Task not found: ${taskIdParam}`), 404);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return html(errorHtml('Bad Request', 'Could not read the form body.'), 400);
  }
  const raw = form.get('content');
  const content = typeof raw === 'string' ? raw.trim() : '';
  const back = await taskPageUrl(storage, url.origin, task, '/comments');
  if (!content) {
    // Never lose what the human typed: an empty body is the only case where
    // there is nothing to lose, so this is a plain refusal, not a discard.
    return html(errorHtml('Empty comment', 'A comment needs some text. Nothing was saved.'), 400);
  }

  if (wantsActionDialog(req)) {
    // The Ask dialog's "Add comment" button posts here through the action
    // dialog, which follows a run rather than a redirect. Same single write;
    // a failure leaves the dialog open with the words still in it.
    const taskId = task.id;
    const actor = getActor();
    return actionRunStarted(taskId, 'comment', async () => {
      await storage.createComment(taskId, sanitizeUserText(content), actor);
      return { redirect: back };
    });
  }
  try {
    await storage.createComment(task.id, sanitizeUserText(content), getActor());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`web: could not save comment on task ${task.id.slice(0, 8)}: ${message}`);
    return html(commentSaveFailedHtml(task.id, content, message), 500);
  }
  return Response.redirect(back, 303);
}

/**
 * POST /tasks/:id/comments/:commentId/edit — replace the text of a comment the
 * agent has not been shown yet. The rule (and the refusal's wording) is
 * `editUnseenComment`'s; a refusal echoes the submitted text back so nothing
 * the human typed is lost.
 */
async function handleEditCommentForm(
  storage: Storage,
  req: Request,
  url: URL,
  taskIdParam: string,
  commentId: string,
): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  const task = (await storage.resolveTask(taskIdParam)).task;
  if (!task) {
    return html(errorHtml('Not Found', `Task not found: ${taskIdParam}`), 404);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return html(errorHtml('Bad Request', 'Could not read the form body.'), 400);
  }
  const raw = form.get('content');
  const content = typeof raw === 'string' ? raw.trim() : '';
  if (!content) {
    return html(errorHtml('Empty comment', 'A comment cannot be edited to be empty. Nothing was changed.'), 400);
  }
  try {
    await editUnseenComment(storage, task.id, commentId, content, { editor: getActor() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof CommentAlreadySeenError ? 409 : err instanceof CommentNotFoundError ? 404 : 500;
    return html(commentEditRefusedHtml(task.id, content, message), status);
  }
  return Response.redirect(await taskPageUrl(storage, url.origin, task, '/comments'), 303);
}

/**
 * The project's Start services command, through the daemon's port. '' when no
 * port was injected or the read fails: an unreadable setting is one missing
 * button, not a failed page render.
 */
async function readStartServicesCmd(serveActions: ServeActions | undefined): Promise<string> {
  if (!serveActions) return '';
  try {
    return await serveActions.getStartServicesCmd();
  } catch (err) {
    logger.warn(`Dashboard: could not read the Start services command: ${err instanceof Error ? err.message : err}`);
    return '';
  }
}

/**
 * POST /tasks/:id/services/start-cmd — designate (or change) the project-wide
 * Start services command from the Services card. POST
 * /tasks/:id/services/start-cmd/clear (`mode: 'clear'`) clears it; the clear
 * sticks — lazy.toml's old key is not read back or re-imported.
 *
 * Saves to the project store through ServeActions (the daemon owns the write;
 * lazy.toml is never edited). Never a GET — designation is a mutation. Redirects back to the
 * Services tab so the card re-renders with Start services when a shell is up.
 */
async function handleDesignateStartCmd(
  storage: Storage,
  serveActions: ServeActions | undefined,
  req: Request,
  url: URL,
  taskIdParam: string,
  mode: 'set' | 'clear' = 'set',
): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  const task = await storage.getTask(taskIdParam);
  if (!task) {
    return html(errorHtml('Not Found', `Task not found: ${taskIdParam}`), 404);
  }
  if (!serveActions) {
    return html(
      errorHtml(
        'Unavailable',
        'Designating a Start services command is not available: this dashboard was started without a daemon serve-actions port.',
      ),
      503,
    );
  }

  if (mode === 'clear') {
    // Clearing takes no input — nothing typed can be lost.
    try {
      await serveActions.clearStartServicesCmd();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return html(errorHtml('Could not clear', message), 500);
    }
    return Response.redirect(await taskPageUrl(storage, url.origin, task, '/services'), 303);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return html(errorHtml('Bad Request', 'Could not read the form body.'), 400);
  }
  const raw = form.get('command');
  const command = typeof raw === 'string' ? raw : '';

  try {
    await serveActions.setStartServicesCmd(command);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Validation (blank, non-string) is a 400 the human can fix; anything else
    // (unwritable file, uneditable TOML shape) surfaces as the refusal page.
    return html(errorHtml('Could not save', message), 400);
  }

  return Response.redirect(await taskPageUrl(storage, url.origin, task, '/services'), 303);
}

/**
 * POST /tasks/:id/container/start — bring the task's environment up.
 *
 * Behind the dashboard guard like every other route here, and it goes through
 * the daemon's own container-ensure path (the same one `lazy shell` uses) via
 * the TaskActions port. It never starts a turn: the human wants the environment,
 * not agent work.
 *
 * Kicks the launch off and redirects immediately rather than awaiting it — an
 * image rebuild can take minutes, well past the web request deadline, so the
 * page follows the launch's own narration instead of holding a socket open.
 */
async function handleContainerStart(
  storage: Storage,
  taskActions: TaskActions | undefined,
  req: Request,
  url: URL,
  taskIdParam: string,
): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  const task = await storage.getTask(taskIdParam);
  if (!task) {
    return html(errorHtml('Not Found', `Task not found: ${taskIdParam}`), 404);
  }
  if (!taskActions) {
    return html(
      errorHtml('Unavailable', 'Starting a container is not available: this dashboard was started without a daemon action port.'),
      503,
    );
  }
  if (isTerminalStatus(task.status)) {
    return html(
      errorHtml(
        'Not Allowed',
        `Task ${task.code ?? task.id.substring(0, 8)} is ${task.status} — reopen it before starting its container.`,
      ),
      409,
    );
  }

  // The runner check is the daemon's (`ensureTaskContainer` refuses a
  // host-process task with the reason), but a page that already knows can say
  // it without a launch attempt.
  const session = await storage.getSessionByTaskId(task.id);
  const shell = await shellAvailabilityForTask(task, session);
  if (shell && !shell.available && shell.code === 'no-container-runner') {
    return html(errorHtml('Not Allowed', shell.reason), 409);
  }

  beginContainerStart(task.id, taskActions);
  return Response.redirect(await taskPageUrl(storage, url.origin, task), 303);
}

/**
 * `POST /tasks/:id/container/ensure` and `GET /tasks/:id/container/state` — the
 * same start as the button, for a panel that is about to need the container.
 *
 * Watch / Shell / Pair / Chat call ensure the moment the human opens them, then
 * poll state until it settles, and only then open their WebSocket. That is the
 * whole point of the pair: the container is an implementation detail of "give me
 * a terminal into this task", so the panel resolves it instead of reporting it.
 *
 * Begin-or-join, because `beginContainerStart` is idempotent while in flight:
 * open Watch and Shell together and the second ensure attaches to the first
 * one's launch and narrates the same lines, rather than racing a second
 * `docker run` for the same task.
 *
 * Refusals are JSON, not an error page — the caller is a fetch, and it renders
 * the reason inline in its own panel next to a retry button. A GET never starts
 * anything: it is the follow-along half, and a poll that could launch a
 * container would put the render-time start back through the side door.
 */
async function handleContainerEnsure(
  storage: Storage,
  taskActions: TaskActions | undefined,
  req: Request,
  taskIdParam: string,
  action: 'ensure' | 'state',
): Promise<Response> {
  const wantMethod = action === 'ensure' ? 'POST' : 'GET';
  if (req.method !== wantMethod) {
    return json({ error: 'Method not allowed' }, 405);
  }
  const task = await storage.getTask(taskIdParam);
  if (!task) {
    return json({ error: `Task not found: ${taskIdParam}` }, 404);
  }

  if (action === 'state') {
    return json(containerStartJson(getContainerStart(task.id)));
  }

  if (!taskActions) {
    return json(
      { error: 'This dashboard was started without a daemon action port, so it cannot start a container.' },
      503,
    );
  }
  if (isTerminalStatus(task.status)) {
    return json(
      { error: `Task ${task.code ?? task.id.substring(0, 8)} is ${task.status} — reopen it before starting its container.` },
      409,
    );
  }
  const session = await storage.getSessionByTaskId(task.id);
  const shell = await shellAvailabilityForTask(task, session);
  if (shell && !shell.available && shell.code === 'no-container-runner') {
    return json({ error: shell.reason }, 409);
  }

  return json(containerStartJson(beginContainerStart(task.id, taskActions)));
}

/**
 * Symbol table for prose jump links. Changes rebuilds this from its own
 * parse, so callers skip this when `tab === 'changes'` to avoid a second
 * getDiff. A failed diff is not a failed page — task-code links still work.
 */
async function loadSymbolLinkify(
  actions: ReviewActions,
  taskId: string,
  /** Pre-escaped task path segment the symbol hrefs point through. */
  seg: string,
  timings: RenderTimings,
): Promise<MarkdownLinkifyTable | undefined> {
  try {
    const diffText = await timings.measure('symbols.diff', () => actions.getDiff(taskId));
    const files = timings.measureSync('symbols.parse', () => parseUnifiedDiff(diffText));
    const lookup = timings.measureSync('symbols.table', () => buildSymbolTable(files, seg));
    if (lookup.size === 0) return undefined;
    return { lookup, className: 'lz-sym-link' };
  } catch (err) {
    logger.debug(`symbol table for ${taskId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

async function handleTaskDetail(
  storage: Storage,
  taskId: string,
  url: URL,
  taskActions?: TaskActions,
  reviewActions?: ReviewActions,
  tab: TaskTabId = 'landing',
  reviewNotice?: { text: string; error?: boolean },
  reviewDraft?: ReviewDraft,
  reviewRemedy?: AcceptRemedy,
  extras?: {
    /** Direct `/raised/:id` load — Raised tab with this dialog open. */
    openRaisedId?: string;
    openRaisedPanel?: string;
    /** Designate Start services — project-wide lazy.toml write port. */
    serveActions?: ServeActions;
  },
): Promise<Response> {
  const timings = new RenderTimings('/tasks/:id');
  const task = await timings.measure('storage.task', () => storage.getTask(taskId));
  if (!task) {
    return html(errorHtml('Not Found', `Task not found: ${taskId}`), 404);
  }

  // Every storage read the page needs, under one parent phase so `storage` is
  // one number a reader can compare against `diff`/`render` at a glance, with
  // the per-entity breakdown nested under it (`storage.turns`, …).
  const storagePhase = timings.begin('storage');
  const session = await timings.measure('session', () => storage.getSessionByTaskId(task.id));
  const turns = session ? await timings.measure('turns', () => storage.getSessionTurns(session.id)) : [];
  const commits = session ? await timings.measure('commits', () => storage.getSessionCommits(session.id)) : [];
  const comments = await timings.measure('comments', () => storage.getTaskComments(task.id));
  const journal = await timings.measure('journal', () => storage.getTaskJournal(task.id));
  const children = await timings.measure('children', () => storage.getChildTasks(task.id));
  const promptVersions = await timings.measure('prompts', () => storage.getPromptHistory(task.id));
  const parentId = parentTaskIdOf(task);
  const parentTask = parentId ? await timings.measure('parent', () => storage.getTask(parentId)) : null;
  const raisedItems = await timings.measure('raised', async () => withPromotedTaskCodes(await storage.getTaskRaisedItems(task.id), (id) => storage.getTask(id)));
  storagePhase.end();

  const protection = (await timings.measure('protection', () => protectionForTasks(storage, [task]))).get(task.id) ?? null;
  // The base branch used to live only on the deleted /pr page; it is the one
  // thing that page showed which this one did not, so it moves here.
  const baseBranch = parentId
    ? taskBranchFor(await timings.measure('base_branch', () => taskRefFromId(parentId, storage)))
    : 'main';

  // Set when the proxy sent them here: they opened a task service's subdomain
  // URL and nothing answered. Parsed (not trusted) — the banner's wording comes
  // from the task's own state, and rendering it starts nothing.
  const serveNotice = parseServeNotice(url);

  // Not storage: this shells out to docker and probes TCP ports, which is
  // exactly why it is worth its own phase rather than being lumped in — and why
  // it is asked for ONLY on the tabs that render the answer. A project with
  // `[serve]` ports declared used to pay a `docker ps` (ten-second cap) plus a
  // `docker port` on every render of every tab, so a wedged Docker Desktop made
  // the whole task page — Landing, Turns, Shell — wait on a question those tabs
  // never show. Elsewhere `serve` is null, which renders as "no services known"
  // rather than a wrong answer: the Metadata panel's Serving row is on the
  // Services and Changes tabs, where the card it belongs to lives.
  const wantsServe = tab === 'services' || tab === 'changes' || serveNotice !== null;
  const serve = wantsServe
    ? await timings.measure('serve', () => serveStateForTask(task, session))
    : null;
  const shell = await timings.measure('shell', () => shellAvailabilityForTask(task, session));

  // Task-code autolink needs every task's code, and so do the page's own task
  // URLs: links read by code, falling back to the id when a code is shared by
  // more than one task. Both used to arrive via one listTasks(), which reads
  // every task.json in the store and was the largest phase on this page
  // (~27ms at 600 tasks, ~87ms at 2000, growing linearly). The store answers
  // both from its own index now, so neither grows with the size of the tasks,
  // only with their number. Loaded here, before the Services card, whose form
  // action and shell selector carry the same code-or-id segment.
  const taskCodes = await timings.measure('storage.task_codes', () => storage.listTaskCodes());
  const codeTables = taskCodeTables(taskCodes);
  const seg = taskPathSegment(task, codeTables.duplicated);
  const controls = await timings.measure('controls', () => containerControlsForTask(task, serve, shell, taskActions, extras?.serveActions, seg));

  // Default newest-first; `?chunks=oldest` restores chronological chunk order.
  // Not a setting — just a query-string escape hatch for the old order.
  const chunkOrder = url.searchParams.get('chunks') === 'oldest' ? 'oldest' : 'newest';

  // Fragment shape, resolved before any of the expensive per-tab loads below.
  // `body=0` is the live island asking for header + strip alone: it wants the
  // status badge and the strip badges, and the visible tab is one it is not
  // allowed to swap (Changes, Current review, Shell, Verify) or one whose
  // regions did not move. Rendering the body anyway would put a full diff
  // parse on a three-second background poll.
  const fragment = url.searchParams.get('fragment') === '1';
  const chrome = fragment && url.searchParams.get('chrome') === '1';
  const omitBody = chrome && url.searchParams.get('body') === '0';

  const activity = session
    ? timings.measureSync('activity', () => computeReviewActivity({ turns, commits, comments, journal, raisedItems }))
    : null;

  timings.count('turns', turns.length);
  timings.count('commits', commits.length);
  timings.count('comments', comments.length);
  timings.count('journal', journal.length);
  timings.count('raised', raisedItems.length);
  timings.count('children', children.length);

  // Landing's working-task body is the only thing that RENDERS the progress
  // line, but every tab stamps it into the header freshness key — and the
  // live-status poll always reads it. Loading it only on Landing meant a
  // working task sitting on any other tab compared a key with no progress
  // against a payload with one, and refreshed its chrome every three seconds
  // forever. `loadTaskProgressLine` is already a no-op off `working`.
  const progress = await timings.measure('progress', () => loadTaskProgressLine(task));
  const { lastAgentTurn, turnReport } = await timings.measure('report', () =>
    loadLandingReport(storage, task.id, session),
  );
  // Full history is only the Verify tab's superseded list. Other tabs (and
  // the strip badge) use the current session's report, which loadLandingReport
  // already has — paying for every session's reports on Landing would make
  // every tab load as expensive as Verify.
  const turnReports = tab === 'verify' && !omitBody
    ? await timings.measure('storage.turn_reports', () => storage.getTaskTurnReports(task.id))
    : undefined;

  let storedDraft: ReviewDraftState | null = null;
  if (reviewActions) {
    try {
      storedDraft = await timings.measure('storage.draft', () =>
        reviewActions.getDraft(task.id, LOCAL_REVIEWER),
      );
    } catch (err) {
      logger.error(
        `Could not load the review draft for task ${task.id.substring(0, 8)}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const viewedFiles = storedDraft?.viewed_files ?? {};
  // Drafts written before line drafts existed have no such key.
  const lineDrafts = storedDraft?.line_drafts ?? {};
  const effectiveDraft: ReviewDraft = {
    feedback: reviewDraft?.feedback ?? (storedDraft?.feedback || undefined),
    reason: reviewDraft?.reason ?? (storedDraft?.accept_reason || undefined),
  };

  const promoted = url.searchParams.get('promoted')?.trim().slice(0, 80);
  const flash = url.searchParams.get('flash')?.trim();
  const notice = reviewNotice
    ?? (flash ? { text: flash.slice(0, 400) } : undefined)
    ?? (tab === 'review' && promoted
      ? { text: `Promoted to ${promoted} — the task was created and never auto-starts.` }
      : undefined);

  const needsDiff = tab === 'changes' && !omitBody;
  let reviewExtras: TaskPageReviewExtras | undefined;
  if (tab === 'regions' && !omitBody && reviewActions) {
    // The Regions tab needs the cover and NOTHING else — no diff, no markdown
    // sources, no comments. Loading the review embed here would make opening
    // the map pay for the territory, which is the cost this tab exists to let
    // a reviewer avoid.
    const cover = await timings.measure('regions', () => reviewActions.listRegions(task.id));
    timings.count('region_count', cover.regions.length);
    reviewExtras = {
      notice,
      draft: effectiveDraft,
      remedy: reviewRemedy,
      regions: regionExtras(cover, url.searchParams.get('region')?.trim() || null),
    };
  } else if (needsDiff && reviewActions) {
    // Measured inside loadReviewEmbed as top-level `diff` / `diff_parse` so
    // the Changes tab still answers "which phase is slow?" the way the old
    // /review/:id page did — an outer wrapper would nest those names away.
    reviewExtras = await loadReviewEmbed(storage, reviewActions, task, session, {
      // The region filter. Parsed, never trusted: an id that is not in the
      // cover makes the daemon refuse, and the tab renders the refusal as a
      // notice rather than silently showing the unfiltered diff.
      region: url.searchParams.get('region')?.trim() || null,
      notice,
      draft: effectiveDraft,
      remedy: reviewRemedy,
      raisedItems,
      lastAgentTurn,
      turnReport,
      serve,
      shell,
      controls,
      activity,
      timings,
    });
  } else if (tab === 'review' && !omitBody && reviewActions) {
    const comments = await timings.measure('review_comments', () => reviewActions.listComments(task.id));
    const state = await reviewLiveState(storage, task);
    const violations = await timings.measure('violations', () => taskFileViolations(storage, task.id));
    reviewExtras = {
      notice,
      draft: effectiveDraft,
      remedy: reviewRemedy,
      reviewComments: comments,
      state,
      fileViolations: violations,
    };
  } else if (omitBody && reviewActions && (tab === 'review' || tab === 'changes')) {
    // A body-less poll render still paints the tab strip, and the "N queued"
    // badge is computed from these comments. Skipping them made the badge
    // VANISH a few seconds after a reviewer opened Current review — and an
    // absent badge reads as "nothing queued", the opposite of true. One
    // storage read, and none of the body work (no diff, no violations, no
    // live state) that `body=0` exists to avoid.
    const comments = await timings.measure('review_comments', () => reviewActions.listComments(task.id));
    reviewExtras = {
      notice,
      draft: effectiveDraft,
      remedy: reviewRemedy,
      reviewComments: comments,
    };
  } else if (tab === 'verify' || notice) {
    reviewExtras = {
      notice,
      draft: effectiveDraft,
      remedy: reviewRemedy,
    };
  }

  // Task-code autolink (the table above) and the Subtasks tab's descendant
  // counts are the only things this late block still loads.
  let subtreeCounts: Map<string, number> | undefined;
  if (tab === 'subtasks' && !omitBody && children.length > 0) {
    const counts = await timings.measure('storage.descendants', () =>
      storage.countDescendants(children.map((c) => c.id)),
    );
    subtreeCounts = childSubtreeCounts(children, new Map(Object.entries(counts)));
  }

  // Stats reads things no other tab needs, and only on that tab: status
  // changelogs (the only source for time-in-status), the turns and commits of
  // whatever scope was asked for, and the durable per-task tool records. A hub
  // DEFAULTS to the subtree view — its own handful of turns is not its spend —
  // and `?scope=task` narrows back to the task alone. The proxy audit trail is
  // no longer read here at all: the tool table comes from records that do not
  // expire, so opening this tab no longer parses 20k log lines either.
  let stats: TaskStatsResult | undefined;
  if (tab === 'stats' && !omitBody) {
    const requested = parseStatsScope(url.searchParams.get('scope'));
    const statusHistory = await timings.measure('storage.status_history', () =>
      storage.getStatusHistory(task.id),
    );
    stats = await timings.measure('stats.load', () =>
      loadTaskStats(storage, task, {
        // Default subtree: on a leaf task the loader answers `task` anyway, so
        // this only changes what a hub shows, which is the whole point.
        scope: requested ?? 'subtree',
        // This page already read the task's session, turns and commits for the
        // header and every other tab — hand them over rather than read twice.
        root: { task, session, turns, commits, statusHistory },
      }),
    );
  }

  // Worktree lazy.toml is untrusted data. Missing root / missing file /
  // unparseable TOML all mean "no advice" — the page still renders.
  let branchAdvice: Awaited<ReturnType<typeof branchServeAdviceFor>> | undefined;
  if (tab === 'services' && !omitBody) {
    const root = findLazyRoot();
    if (root) {
      const declared = serve?.declared ?? [];
      branchAdvice = await timings.measure('branch_advice', () =>
        branchServeAdviceFor(getWorktreePath(root, task), declared, taskRef(task)),
      );
    }
  }

  // Header-only, like upstream below: a plain fragment (tab switch) does not
  // re-emit the header, a chrome fragment (live-status refresh) does.
  const reviewSettings = (!fragment || chrome)
    ? await timings.measure('review_line', () => reviewViewForTask(task, parentTask))
    : null;
  const launchIdentity = (!fragment || chrome)
    ? await timings.measure('launch_identity', () => launchIdentityForTask(storage, task))
    : null;

  let upstream = null as Awaited<ReturnType<NonNullable<TaskActions>['getUpstreamStatus']>> | null;
  let reparentTargets = null as Awaited<ReturnType<NonNullable<TaskActions>['listReparentTargets']>> | null;
  let submitPreflight = null as Awaited<ReturnType<NonNullable<TaskActions>['submitPreflight']>> | null;
  if (taskActions) {
    // Both of these feed the always-on header. A plain fragment (tab switch)
    // does not emit the header — strip + body only — so skip the loads. A
    // chrome fragment (live-status refresh) does emit the header and needs
    // them. Current review also renders the upstream line in its own body.
    const wantsUpstream = !fragment || chrome || tab === 'review';
    // Reparent's target list fills a `<datalist>` inside the reparent dialog,
    // which is only in the markup when the verb is actually available — a
    // working or terminal task cannot be reparented, so nothing consumed it.
    const wantsReparentTargets =
      (!fragment || chrome) && restructureVerbUnavailableReason('reparent', task.status) === null;
    if (wantsUpstream) {
      try {
        upstream = await timings.measure('upstream', () => taskActions.getUpstreamStatus(task.id));
      } catch (err) {
        logger.debug(`upstream status for ${task.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (wantsReparentTargets) {
      try {
        reparentTargets = await timings.measure('reparent_targets', () => taskActions.listReparentTargets(task.id));
      } catch (err) {
        logger.debug(`reparent targets for ${task.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
      }
    }
    // Header Submit lives on every tab of a blocked/conflict task; Current
    // review also renders it. A plain fragment tab switch does not re-emit the
    // header; a chrome fragment (live-status) does.
    const wantsSubmitPreflight =
      taskCanOfferSubmit(task.status) && (!fragment || chrome || tab === 'review');
    if (wantsSubmitPreflight) {
      try {
        submitPreflight = await timings.measure('submit_preflight', () => taskActions.submitPreflight(task.id));
      } catch (err) {
        logger.debug(`submit preflight for ${task.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // The `changes` freshness key, stamped only on the full page — a fragment
  // does not carry the root element that holds the keys, so paying a
  // `rev-parse` on an in-place tab switch would buy nothing.
  const headSha = fragment
    ? null
    : await timings.measure('head_sha', () => taskBranchHeadSha(task));

  const linkify: MarkdownLinkifyTable[] = [buildTaskCodeLinkify(taskCodes)];
  // Changes merges symbols from its own diff parse. Landing/raised/turns
  // need the table here so `` `name()` `` in a report or dialog still jumps.
  if (reviewActions && !omitBody && tab !== 'changes' && (tab !== 'landing' || turnReport)) {
    const symbols = await loadSymbolLinkify(reviewActions, task.id, seg, timings);
    if (symbols) linkify.push(symbols);
  }
  const markdown: RenderMarkdownOptions = {
    linkify,
    // `seg` is the code-or-id segment, ALREADY escaped by taskPathSegment —
    // which is why it is interpolated raw here. That carries upstream's intent
    // (the id used to go in unescaped) and the code spelling together.
    hashLinkBase: `/tasks/${seg}/changes`,
  };

  // `render` stays open for the whole synchronous render, so the per-block
  // phases the template opens land under it as `render.turns`, `render.children`
  // and so on — no block has to know its own prefix.
  const page = timings.measureSync('render', () =>
    taskPageHtml({
      task,
      session,
      turns,
      commits,
      comments,
      journal,
      raisedItems,
      children,
      promptVersions,
      parentTask,
      protection,
      baseBranch,
      serve,
      chunkOrder,
      shell,
      controls,
      activity,
      serveNotice,
      timings,
      tab,
      fragment,
      chrome,
      omitBody,
      headSha,
      viewedFiles,
      lineDrafts,
      progress,
      turnReport,
      lastAgentTurn,
      turnReports,
      review: reviewExtras,
      subtreeCounts,
      branchAdvice,
      upstream,
      launchIdentity,
      reviewSettings,
      reparentTargets,
      submitPreflight,
      markdown,
      openRaisedId: extras?.openRaisedId,
      openRaisedPanel: extras?.openRaisedPanel,
      stats,
      duplicatedCodes: codeTables.duplicated,
    }),
  );
  if (fragment) {
    // Measured like every other render. An in-place tab switch is the request
    // a human actually waits on — leaving it off the instrumentation meant the
    // one path anyone would call slow was the one path publishing no numbers.
    const response = timedHtml(timings, page);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
  return timedHtml(timings, page);
}

/**
 * The agent's own progress line for a working task — one file read, no runner.
 *
 * This used to ALSO derive the working substate, which meant `createRunner()`
 * plus a `runner.isRunning()` docker probe on every render of every tab of a
 * working task. That is a page blocking on the container runtime: with Docker
 * Desktop wedged, the probe ran to its ten-second cap and the whole task page —
 * Turns, Subtasks, Changes — waited on a question none of them asks.
 *
 * Nothing was lost. The only thing the page ever read off the substate was
 * `.progress`, which is this same `progress.json` line arriving by a longer
 * route. The substate's real consumers are `lazy list` and `lazy show`, where a
 * probe is a command the human ran, not a page they opened.
 */
async function loadTaskProgressLine(task: Task): Promise<TaskProgressLine | null> {
  if (task.status !== 'working') return null;
  try {
    const entry = await readTaskProgress(protocolDir(task.id));
    return entry ? { message: entry.message, recordedAt: entry.recorded_at } : null;
  } catch (err) {
    logger.debug(`progress for ${task.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * The task branch's HEAD sha — the `changes` region's freshness key.
 *
 * One `rev-parse` against the project repo, never a fetch and never a diff: a
 * merge, an accept or an agent commit all move this ref, and that is exactly
 * the set of things that make the Changes tab stale. Any failure (no branch
 * yet, no lazy root) is null, which reads as "nothing to compare".
 */
async function taskBranchHeadSha(task: Task): Promise<string | null> {
  const root = findLazyRoot();
  if (!root) return null;
  try {
    const result = await runGit(
      ['rev-parse', '--verify', '--quiet', `${getBranchName(task)}^{commit}`],
      { cwd: root },
    );
    if (result.exitCode !== 0) return null;
    const sha = result.stdout.trim();
    return sha || null;
  } catch (err) {
    logger.debug(`branch head for ${task.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Everything the per-region freshness keys compare, for one task.
 *
 * Each entry is one small JSON file in the task's own directory (children are
 * served from the store index, so that is O(children) reads, not a store
 * scan). No diff render, no runner probe, no upstream fetch — the same budget
 * the single-token handler had, plus the reads that let it notice a subtask,
 * a comment, a journal entry or a commit.
 */
async function loadLiveRegionSources(
  storage: Storage,
  task: Task,
  session: Session | null,
): Promise<TaskLiveRegionSources> {
  const [children, turns, comments, journal, raised, commits, headSha] = await Promise.all([
    storage.getChildTasks(task.id),
    session ? storage.getSessionTurns(session.id) : Promise.resolve([]),
    storage.getTaskComments(task.id),
    storage.getTaskJournal(task.id),
    storage.getTaskRaisedItems(task.id),
    session ? storage.getSessionCommits(session.id) : Promise.resolve([]),
    taskBranchHeadSha(task),
  ]);
  return {
    children: children.map((c) => ({ id: c.id, status: c.status })),
    turns: turns.map((t) => ({ id: t.id, sequence: t.sequence, review: t.review })),
    comments: comments.map((c) => ({ id: c.id, edited_at: c.edited_at })),
    journal: journal.map((j) => ({ id: j.id })),
    raised: raised.map((r) => ({ id: r.id, status: r.status })),
    commits: commits.map((c) => ({ sha: c.sha })),
    headSha,
  };
}

/**
 * `GET /tasks/:id/live-status` — the cheap per-region freshness poll.
 *
 * Returns one key per region (see `task-live-regions.ts`) plus the header
 * fields. The client diffs the keys against what the page is stamped with, and
 * only then fetches a fragment — header + strip alone unless the visible tab's
 * own region moved and its policy allows an in-place patch.
 */
async function handleTaskLiveStatus(storage: Storage, taskId: string): Promise<Response> {
  const resolved = await storage.resolveTask(taskId);
  if (!resolved.task) return json({ error: 'Task not found' }, 404);
  const task = resolved.task;
  const session = await storage.getSessionByTaskId(task.id);
  const [turns, progress, sources] = await Promise.all([
    storage.getTurnCountByTaskId(task.id),
    loadTaskProgressLine(task),
    loadLiveRegionSources(storage, task, session),
  ]);
  const payload = buildLiveStatusPayload({ task, session, progress, turns }, sources);
  const response = json(payload);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

async function loadLandingReport(
  storage: Storage,
  taskId: string,
  session: Session | null,
): Promise<{ lastAgentTurn: Turn | null; turnReport: TurnReport | null }> {
  const lastAgentTurn = await loadLastAgentTurn(storage, taskId);
  let turnReport: TurnReport | null = null;
  if (lastAgentTurn?.session_id) {
    turnReport = await storage.getTurnReportBySession(taskId, lastAgentTurn.session_id);
  }
  if (!turnReport && session) {
    turnReport = await storage.getTurnReportBySession(taskId, session.id);
  }
  return { lastAgentTurn, turnReport };
}

async function loadReviewEmbed(
  storage: Storage,
  actions: ReviewActions,
  task: Task,
  session: Session | null,
  already: {
    region?: string | null;
    notice?: { text: string; error?: boolean };
    draft?: ReviewDraft;
    remedy?: AcceptRemedy;
    raisedItems: RaisedItem[];
    lastAgentTurn: Turn | null;
    turnReport: TurnReport | null;
    serve: Awaited<ReturnType<typeof serveStateForTask>>;
    shell: Awaited<ReturnType<typeof shellAvailabilityForTask>>;
    controls: Awaited<ReturnType<typeof containerControlsForTask>>;
    activity: ReviewActivity | null;
    timings: RenderTimings;
  },
): Promise<TaskPageReviewExtras> {
  const timings = already.timings;
  let diffText = '';
  let notice = already.notice;
  // Regions come first because the filter below depends on one existing: a
  // `?region=` the cover does not contain is dropped with a notice rather
  // than sent to the daemon, which would refuse and take the diff with it.
  const regionCover = await timings.measure('regions', () => actions.listRegions(task.id));
  const regionRows = regionCover.regions;
  let activeRegion: string | null = already.region ?? null;
  // A `?region=` the walkthrough does not contain is dropped with a notice
  // rather than sent to the daemon, which would refuse and take the diff with
  // it. The check is rows-only now (§6.3): areas were the second axis a human
  // could select, and the walkthrough has no second axis — a name that isn't a
  // group id is simply not a region.
  const selectable = (id: string) => regionRows.some((r) => r.id === id);
  if (activeRegion && !selectable(activeRegion)) {
    notice = notice ?? {
      text: `No region '${activeRegion}' in this task's walkthrough — showing all changes.`,
      error: true,
    };
    activeRegion = null;
  }
  timings.count('region_count', regionRows.length);

  const diffPhase = timings.begin('diff');
  try {
    diffText = await actions.getDiff(task.id, activeRegion ? { region: activeRegion } : undefined);
  } catch (err) {
    notice = notice ?? {
      text: `Could not load the diff: ${err instanceof Error ? err.message : String(err)}`,
      error: true,
    };
  } finally {
    // Ended in `finally` so a failed diff is still measured: "the diff took 40s
    // and then threw" is exactly the kind of thing this instrumentation exists
    // to make visible.
    diffPhase.end();
  }
  timings.count('diff_bytes', Buffer.byteLength(diffText, 'utf8'));
  const comments = await actions.listComments(task.id);
  const state = await reviewLiveState(storage, task);
  const violations = await taskFileViolations(storage, task.id);
  const fileDecisions = await storage.getTaskFileDecisions(task.id);
  const diffFiles = timings.measureSync('diff_parse', () => parseUnifiedDiff(diffText));
  timings.count('diff_files', diffFiles.length);
  const markdownSources = await loadMarkdownSources(diffFiles, (query) =>
    actions.getFileLines(task.id, query),
  );
  const isMaintainedPath = await maintainPathMatcher();
  const hubChildren = classifyHubChildren(await storage.getChildTasks(task.id));
  void session;
  return {
    notice,
    diffText,
    reviewComments: comments,
    state,
    fileViolations: violations,
    draft: already.draft,
    remedy: already.remedy,
    fileDecisions,
    isMaintainedPath,
    markdownSources,
    hubChildren,
    regions: regionExtras({ ...regionCover, regions: regionRows }, activeRegion),
    // Only the files this view actually renders. The gutter is a reading aid
    // on the diff in front of someone, and a release cover's whole per-line map
    // is proportional to LINES rather than files.
    lineAttribution: await actions.lineAttribution(task.id, diffFiles.map((f) => f.path)),
  };
}

/**
 * POST /tasks/:id/actions/:verb — the task page's lifecycle buttons.
 *
 * Same design as handleTaskEdit: WHICH verbs the page offers comes from the
 * shared predicate (src/server/task-verbs.ts), this route refuses with the
 * same predicate's reason (so an illegal verb is a 4xx whether or not the
 * button was ever drawn), and the daemon's own lifecycle implementation —
 * behind the TaskActions port — performs the act and has the final word.
 *
 * Plain form POST + 303 redirect back to the task page: no scripting needed.
 * A refused action renders the reason AND echoes the typed reason text, so a
 * failure never silently discards what the human wrote.
 *
 * The action dialog sends `X-Lazy-Action-Dialog: 1` and gets a 202 with a
 * run id instead: the daemon work continues in-process (accept can outlive
 * WEB_REQUEST_DEADLINE_MS) and the open dialog follows the same ProgressEvents
 * the CLI prints. Validation failures are JSON so the dialog can stay open.
 */
async function handleTaskAction(
  storage: Storage,
  taskActions: TaskActions | undefined,
  req: Request,
  url: URL,
  taskIdParam: string,
  verbParam: string,
): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  const dialog = wantsActionDialog(req);
  if (!(TASK_PAGE_VERBS as readonly string[]).includes(verbParam)) {
    return refuseAction(dialog, 'Not Found', `Unknown task action: ${verbParam}`, 404);
  }
  const verb = verbParam as TaskPageVerb;

  const task = await storage.getTask(taskIdParam);
  if (!task) {
    return refuseAction(dialog, 'Not Found', `Task not found: ${taskIdParam}`, 404);
  }
  if (!taskActions) {
    const msg = 'Task actions are not available: this dashboard was started without a daemon action port.';
    return refuseAction(dialog, 'Unavailable', msg, 503);
  }

  // An empty POST (no body at all) must be a "reason required" refusal, not a
  // 500 from formData() choking on the missing content type.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    form = new FormData();
  }
  const reason = String(form.get('reason') ?? '').trim();
  const keptReason = reason
    ? ` Your reason was not lost — it was: “${reason}”`
    : '';

  // Same gate the template rendered from. The daemon re-checks everything, but
  // refusing here turns "the task changed between render and click" into a
  // readable sentence instead of a raw RPC error — and makes an illegal verb a
  // 4xx even when the button was never drawn.
  const session = await storage.getSessionByTaskId(task.id);
  const hasOpenSession = session !== null && !session.ended_at;
  const hasCommits = session ? (await storage.getSessionCommits(session.id)).length > 0 : false;
  const unavailable = taskPageVerbUnavailableReason(verb, task.status, hasOpenSession, {
    hasCommits,
    // Same claim the button row was drawn from — without it this gate refuses
    // the very POST the template correctly offered on a parked task whose
    // review is still claimed.
    hasStoppableClaim: stoppableClaimOf(task) !== null,
  });
  if (unavailable) {
    return refuseAction(dialog, 'Not Allowed', `${unavailable}${keptReason}`, 409);
  }

  if ((REASON_REQUIRED_VERBS as ReadonlySet<string>).has(verb) && !reason) {
    return refuseAction(dialog, 'Reason Required', `A reason is required to ${verb} a task.`, 400);
  }
  if (verb === 'reopen' && task.status === 'complete' && !reason) {
    return refuseAction(dialog, 'Reason Required', 'A reason is required to reopen a completed task.', 400);
  }
  if (verb === 'redo' && !reason) {
    return refuseAction(dialog, 'Reason Required', 'A reason is required to redo a task.', 400);
  }

  // The task's URL segment — code, or id when codeless or duplicated — for
  // every redirect this handler composes.
  const seg = taskPathSegment(task, duplicateTaskCodes(await storage.listTaskCodes()));

  // The referer's task segment is matched EXACTLY, not by substring: codes
  // are short slugs and a code can be a prefix of another task's code or
  // UUID-bearing path, which a substring test would call "the same task".
  // Matching the first path segment against the task's id and code-or-id
  // segment covers pages reached by either spelling.
  //
  // A malformed Referer (a proxy strips nothing here; a browser or script can
  // send anything) must not throw — the POST carries the human's typed reason
  // in this very form, so the parse is guarded and an unparseable referer
  // simply means "not the task's own page" (never-lose-human-feedback).
  const referer = req.headers.get('referer') ?? '';
  const refererUrl = referer && URL.canParse(referer) ? new URL(referer) : null;
  // Both sides are compared DECODED: the referer carries the escaped segment a
  // link emitted, and `seg` is escaped too, so an escaped code would otherwise
  // be matched against its own decoded spelling and never equal it.
  const refererSeg = decodePathSegment(refererUrl?.pathname.match(/^\/tasks\/([^/?#]+)/)?.[1] ?? '');
  const sameTask = refererSeg === task.id || refererSeg === decodePathSegment(seg);
  const backPath = sameTask && refererUrl
    ? refererUrl.pathname
    : `/tasks/${seg}`;

  if (verb === 'reparent') {
    const parent = String(form.get('parent') ?? '').trim();
    if (!parent) {
      return refuseAction(dialog, 'Parent Required', 'Name a task or branch to reparent onto.', 400);
    }
  }

  if (verb === 'submit') {
    const preflight = await taskActions.submitPreflight(task.id);
    if (!preflight.canSubmit) {
      return refuseAction(dialog, 'Not Allowed', preflight.refusal ?? 'Submit is not available.', 409);
    }
    if (preflight.confirmationTier === 'plain') {
      if (String(form.get('confirm') ?? '') !== '1') {
        return refuseAction(dialog, 'Confirmation Required', 'Tick the box to create the PR.', 400);
      }
    } else if (preflight.confirmationTier === 'strong') {
      const typed = String(form.get('typed_confirmation') ?? '');
      if (!submitConfirmMatches(typed, preflight, task.code)) {
        return refuseAction(
          dialog,
          'Confirmation Required',
          `Type the target branch name (${preflight.targetBranch}) or the task code to submit.`,
          400,
        );
      }
    }
  }

  const runVerb = async (onProgress?: ProgressEmitter): Promise<string> => {
    switch (verb) {
      case 'start':
        await taskActions.startTask(task.id, onProgress);
        break;
      case 'stop':
        await taskActions.stopTask(task.id, reason, onProgress);
        break;
      case 'close':
        await taskActions.closeTask(task.id, reason, onProgress);
        break;
      case 'reject':
        await taskActions.rejectTask(task.id, reason, onProgress);
        break;
      case 'resume':
        await taskActions.resumeTask(task.id, onProgress);
        break;
      case 'reopen':
        await taskActions.reopenTask(task.id, reason || undefined, onProgress);
        break;
      case 'sync': {
        const result = await taskActions.syncTask(task.id, onProgress);
        const msg = [result.message, ...(result.warnings ?? [])].filter(Boolean).join(' ');
        return `${url.origin}${backPath}?flash=${encodeURIComponent(msg)}`;
      }
      case 'reparent': {
        const parent = String(form.get('parent') ?? '').trim();
        const result = await taskActions.reparentTask(task.id, parent, onProgress);
        const msg = [result.message, ...(result.warnings ?? [])].filter(Boolean).join(' ');
        return `${url.origin}${backPath}?flash=${encodeURIComponent(msg)}`;
      }
      case 'redo': {
        const result = await taskActions.redoTask(task.id, reason);
        const warn = result.imagePinWarning ? ` ${result.imagePinWarning}` : '';
        const msg = `Redone from ${result.oldDisplayId}.${warn}`;
        return `${await taskPageUrl(storage, url.origin, result.newTaskId)}?flash=${encodeURIComponent(msg)}`;
      }
      case 'clone': {
        const result = await taskActions.cloneTask(task.id, {
          goal: String(form.get('goal') ?? '').trim() || undefined,
          prompt: String(form.get('prompt') ?? '') || undefined,
          code: String(form.get('code') ?? '').trim() || undefined,
          model: String(form.get('model') ?? '').trim() || undefined,
          agent: String(form.get('agent') ?? '').trim() || undefined,
          sameBase: String(form.get('same_base') ?? '') === '1',
        });
        const warn = result.imagePinWarning ? ` ${result.imagePinWarning}` : '';
        const msg = `Cloned from this task.${warn}`;
        return `${await taskPageUrl(storage, url.origin, result.newTaskId)}?flash=${encodeURIComponent(msg)}`;
      }
      case 'submit': {
        const result = await taskActions.submitTask(task.id);
        const msg = result.prUrl
          ? `Submitted. PR: ${result.prUrl}`
          : `Task ${result.displayId} submitted for review.`;
        return `${url.origin}${backPath}?flash=${encodeURIComponent(msg)}`;
      }
      case 'review': {
        const autoFix = String(form.get('auto_fix') ?? '') === '1';
        const result = await taskActions.reviewTask(task.id, { autoFix }, onProgress);
        const extra = (result.warnings ?? []).filter(Boolean).join(' ');
        const msg = extra
          ? `Review finished (turn ${result.turnNumber}). ${extra}`
          : `Review finished (turn ${result.turnNumber}).`;
        const dest = new URL(`${url.origin}/tasks/${seg}/reviews`);
        dest.searchParams.set('flash', msg);
        return dest.toString();
      }
    }
    return `${url.origin}/tasks/${seg}`;
  };

  if (dialog) {
    return actionRunStarted(task.id, verb, async (onProgress) => ({
      redirect: await runVerb(onProgress),
    }));
  }

  try {
    return Response.redirect(await runVerb(), 303);
  } catch (err) {
    const status = err instanceof RpcError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    return html(
      errorHtml(status >= 500 ? 'Server Error' : 'Not Allowed', `${message}${keptReason}`),
      status,
    );
  }
}

/**
 * The agent choices the task edit form offers: the project's PROFILE names, not
 * the agent registry's harness names. `--agent` and `task.agent_id` name a
 * profile, so a project with `[agents.local-ollama-pi]` must see it here — and
 * must NOT be offered a bare `pi` it never defined.
 *
 * Internal agents are never offered; the task's own agent stays listed so saving
 * the form cannot silently switch a deliberately-pinned one.
 *
 * The project's own blocks come FIRST and are labelled as such, each with a
 * summary of what it runs (harness, model, endpoint, credential): a list of
 * bare names reads as a list of harnesses, which is exactly the confusion this
 * ordering and labelling exist to remove.
 *
 * Degrades to the built-in names when config cannot be read. A page that renders
 * the wrong SET of choices is a smaller failure than one that 500s — the same
 * posture as the dashboard's protection lookup above — but it must SAY it is
 * degraded: the likeliest cause is the bad `[agents.<name>]` block the human is
 * on their way to fix, and a silent fallback would tell them their own profile
 * is a built-in. Hence the notice, which the form renders next to the picker.
 */
async function selectableAgentsForTask(
  taskAgentId: string | null | undefined,
): Promise<{ choices: AgentChoice[]; notice?: string }> {
  const pinned = taskAgentId?.trim();

  /**
   * Keep the task's own agent selectable when the offered set does not contain
   * it, so saving the form cannot silently switch a deliberately-pinned one.
   * Its own group, appended last: it is neither a profile the project
   * configured nor a built-in, and claiming either would be a lie in the one
   * place whose job is to say where a name came from.
   */
  const withPinned = (choices: AgentChoice[], summary: string): AgentChoice[] =>
    pinned && !choices.some((c) => c.name === pinned)
      ? [...choices, { name: pinned, summary, group: 'pinned' as const }]
      : choices;

  const fallback = (): AgentChoice[] =>
    withPinned(
      listSelectableAgents(taskAgentId).map((name) => ({ name, summary: '', group: 'degraded' as const })),
      'pinned on this task',
    );

  try {
    const root = findLazyRoot();
    if (!root) {
      return {
        choices: fallback(),
        notice: 'No lazy project root found from the dashboard’s working directory — showing the built-in agents only.',
      };
    }
    const config = await loadConfig(root);
    const profiles = agentProfilesFor(config);
    const choices: AgentChoice[] = selectableAgentProfiles(profiles).map((profile) => ({
      name: profile.name,
      summary: agentProfileSummary(profile),
      group: profile.builtin ? 'builtin' : 'configured',
    }));
    // A pinned name that resolves is a real profile the offered set merely hides
    // — today that is lazy's internal qa-agent — so it keeps its true summary
    // and must not be described as undefined.
    const pinnedProfile = pinned ? profiles.get(pinned) : undefined;
    return {
      choices: withPinned(
        choices,
        pinnedProfile
          ? agentProfileSummary(pinnedProfile)
          : 'this task names it, but no [agents.<name>] block in lazy.toml defines it',
      ),
    };
  } catch (err) {
    // WARN, not debug: the page still renders, but it renders a DIFFERENT set of
    // choices than the project configured — the user's own `[agents.<name>]`
    // profiles are missing from a form whose whole job is to pick one. That is
    // a degradation someone has to be able to see without turning on debug
    // logging, and the message is also the only place the config error itself
    // (a bad profile block) surfaces on this path.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Task edit: could not resolve agent profiles, offering the built-in names instead: ${message}`);
    return {
      choices: fallback(),
      // The reason, verbatim: on this path it is the config error itself (a bad
      // profile block names its own file and key), and the person reading the
      // page is the person who can fix it.
      notice: `Could not read this project’s agent profiles, so only lazy’s built-in agents are offered: ${message}`,
    };
  }
}

function emptyCreateDraft(parent = ''): TaskCreateDraft {
  return {
    goal: '',
    prompt: '',
    code: '',
    parent,
    type: 'task',
    model: '',
    effort: '',
    review: '',
    reviewGate: '',
    reviewAutoFix: '',
    agent: '',
    startNow: false,
  };
}

function createInputFromDraft(draft: TaskCreateDraft): TaskCreateInput {
  const input: TaskCreateInput = { goal: draft.goal };
  if (draft.prompt.trim()) input.prompt = draft.prompt;
  if (draft.code.trim()) input.code = draft.code.trim();
  if (draft.parent.trim()) input.parent = draft.parent.trim();
  if (draft.type.trim()) input.type = draft.type.trim();
  if (draft.model.trim()) input.model = draft.model.trim();
  if (draft.effort.trim()) input.effort = draft.effort.trim();
  if (draft.review.trim()) input.review = draft.review.trim();
  if (draft.reviewGate.trim()) input.reviewGate = draft.reviewGate.trim();
  if (draft.reviewAutoFix.trim()) input.reviewAutoFix = draft.reviewAutoFix.trim();
  if (draft.agent.trim()) input.agent = draft.agent.trim();
  return input;
}

/**
 * GET/POST /tasks/new — create a backlog task, optionally start it.
 *
 * Same two rules as the edit form: the daemon owns every write, and a
 * refused submit re-renders from the typed draft so nothing is lost.
 * Start-now with the action-dialog header creates first (fast), then
 * follows start through beginActionRun so the page sees the same phases
 * as the Start button.
 */
async function handleTaskCreate(
  storage: Storage,
  taskActions: TaskActions | undefined,
  req: Request,
  url: URL,
): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const dialog = wantsActionDialog(req);
  const parentPrefill = url.searchParams.get('parent') ?? '';
  const agentChoices = await selectableAgentsForTask(null);
  const parentTargets = taskActions ? await taskActions.listReparentTargets() : null;

  const render = (draft: TaskCreateDraft, notice?: { text: string; error?: boolean }, status = 200) =>
    html(
      taskCreateHtml(draft, {
        agents: agentChoices.choices,
        ...(agentChoices.notice ? { agentsNotice: agentChoices.notice } : {}),
        efforts: VALID_EFFORT_LEVELS,
        types: VALID_TASK_TYPES,
        parentTargets,
        ...(notice ? { notice } : {}),
      }),
      status,
    );

  if (req.method === 'GET') {
    // Fragment = form body only for the command-palette create dialog.
    // Same fields as the page; no layout chrome, no action-dialog island
    // (plain POST still works for Start now without progressive phases).
    if (url.searchParams.get('fragment') === '1') {
      return html(
        taskCreateFormHtml(emptyCreateDraft(parentPrefill), {
          agents: agentChoices.choices,
          ...(agentChoices.notice ? { agentsNotice: agentChoices.notice } : {}),
          efforts: VALID_EFFORT_LEVELS,
          types: VALID_TASK_TYPES,
          parentTargets,
        }, 'fragment'),
      );
    }
    return render(emptyCreateDraft(parentPrefill));
  }

  if (!taskActions) {
    const msg = 'Creating a task is not available: this dashboard was started without a daemon action port.';
    if (dialog) return json({ error: msg }, 503);
    return html(errorHtml('Unavailable', msg), 503);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    // A missing or unreadable body is not an empty goal — that message
    // would send them hunting for a box they already filled.
    const msg = 'The form body could not be read. Submit the form again.';
    if (dialog) return json({ error: msg }, 400);
    return render(emptyCreateDraft(parentPrefill), { text: msg, error: true }, 400);
  }
  const parsed = parseCreateTaskForm(form);
  if (!parsed.ok) {
    if (dialog) return json({ error: parsed.error }, 400);
    return render(parsed.draft, { text: parsed.error, error: true }, 400);
  }
  const draft = parsed.draft;

  let created: { taskId: string; displayId: string; warnings?: string[] };
  try {
    created = await taskActions.createTask(createInputFromDraft(draft));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof RpcError ? err.status : 500;
    if (dialog) return json({ error: message }, status);
    // Only a caller mistake re-renders the form. A write failure must not —
    // retrying the form after the row existed would create a second task.
    if (status === 400) {
      return render(draft, { text: message, error: true }, 400);
    }
    return html(errorHtml('Server Error', message), status);
  }

  // Redirect lands on the new task by its code when it has a unique one —
  // created.taskId is the UUID; the address bar should carry the name.
  const taskPage = new URL(await taskPageUrl(storage, url.origin, created.taskId));
  const flashes = [...(created.warnings ?? [])];
  const taskUrl = (extra?: string): string => {
    const dest = new URL(taskPage);
    const text = [...flashes, extra].filter(Boolean).join(' ');
    if (text) dest.searchParams.set('flash', text);
    return dest.toString();
  };

  if (!draft.startNow) {
    return Response.redirect(taskUrl(), 303);
  }

  // Start failure must not re-show the create form. The task exists; a
  // retry would duplicate it. Same destination as the noscript path.
  const startWork = async (onProgress?: ProgressEmitter) => {
    try {
      await taskActions.startTask(created.taskId, onProgress);
      return { redirect: taskUrl() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        redirect: taskUrl(`Created ${created.displayId}, but it could not be started: ${message}`),
      };
    }
  };

  if (dialog) {
    return actionRunStarted(created.taskId, 'start', startWork);
  }

  return Response.redirect((await startWork()).redirect, 303);
}

/**
 * GET /clusters — every `cluster` task with its derived progress, plus a
 * New-cluster form.
 *
 * The children are read per cluster rather than by scanning the whole store: a
 * project has few clusters, and `getChildTasks` is an index lookup. Progress
 * itself is never computed here — {@link clustersPageHtml} renders
 * `clusterProgressOf`.
 */
async function handleClusterTasks(
  storage: Storage,
  taskActions: TaskActions | undefined,
  req: Request,
  url: URL,
): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const entries: ClusterEntry[] = await listClusterEntries(storage);

  // The create form is the SAME body /tasks/new renders — same fields, same
  // POST target, same daemon validation — with the type pinned to `cluster`.
  // A second create path here would be a second set of rules to keep honest.
  let createForm: string | undefined;
  if (taskActions) {
    const agentChoices = await selectableAgentsForTask(null);
    const parentTargets = await taskActions.listReparentTargets();
    createForm = taskCreateFormHtml(
      { ...emptyCreateDraft(url.searchParams.get('parent') ?? ''), type: 'cluster' },
      {
        agents: agentChoices.choices,
        ...(agentChoices.notice ? { agentsNotice: agentChoices.notice } : {}),
        efforts: VALID_EFFORT_LEVELS,
        types: VALID_TASK_TYPES,
        parentTargets,
        cancelHref: '/clusters',
        submitLabel: 'Create cluster',
      },
      'page',
    );
  }

  return html(
    clustersPageHtml(entries, {
      ...(createForm ? { createFormHtml: createForm } : {}),
      createChromeHtml: `${actionDialogChromeHtml()}\n${actionDialogScript()}`,
    }),
  );
}

function emptyLinkDraft(): TaskLinkDraft {
  return { ref: '', parent: '', code: '' };
}

function linkInputFromDraft(draft: TaskLinkDraft): { ref: string; parent?: string; code?: string } {
  const input: { ref: string; parent?: string; code?: string } = { ref: draft.ref.trim() };
  if (draft.parent.trim()) input.parent = draft.parent.trim();
  if (draft.code.trim()) input.code = draft.code.trim();
  return input;
}

/**
 * GET/POST /tasks/link — adopt a PR URL or git branch as a blocked task.
 *
 * Same two rules as create: the daemon owns every write, and a refused
 * submit re-renders from the typed draft so nothing is lost. Linking
 * always has phases, so the action-dialog header runs the whole call
 * through beginActionRun.
 */
async function handleTaskLink(
  storage: Storage,
  taskActions: TaskActions | undefined,
  req: Request,
  url: URL,
): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const dialog = wantsActionDialog(req);
  const parentTargets = taskActions ? await taskActions.listReparentTargets() : null;

  const render = (draft: TaskLinkDraft, notice?: { text: string; error?: boolean }, status = 200) =>
    html(
      taskLinkHtml(draft, {
        parentTargets,
        ...(notice ? { notice } : {}),
      }),
      status,
    );

  if (req.method === 'GET') {
    return render(emptyLinkDraft());
  }

  if (!taskActions) {
    const msg = 'Linking a branch is not available: this dashboard was started without a daemon action port.';
    if (dialog) return json({ error: msg }, 503);
    return html(errorHtml('Unavailable', msg), 503);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    const msg = 'The form body could not be read. Submit the form again.';
    if (dialog) return json({ error: msg }, 400);
    return render(emptyLinkDraft(), { text: msg, error: true }, 400);
  }
  const parsed = parseLinkTaskForm(form);
  if (!parsed.ok) {
    if (dialog) return json({ error: parsed.error }, 400);
    return render(parsed.draft, { text: parsed.error, error: true }, 400);
  }
  const draft = parsed.draft;

  const runLink = async (onProgress?: ProgressEmitter) => {
    const result = await taskActions.linkTask(linkInputFromDraft(draft), onProgress);
    const dest = new URL(await taskPageUrl(storage, url.origin, result.taskId));
    const flashes = [...(result.warnings ?? [])].filter(Boolean);
    if (flashes.length) dest.searchParams.set('flash', flashes.join(' '));
    return { redirect: dest.toString(), taskId: result.taskId };
  };

  if (dialog) {
    // No task id yet. A shared key (`new-link`) would coalesce two browsers
    // into one run: the second submit attaches to the first and never links.
    // A per-request UUID is unguessable, has no `/`, and the poll/WS routes
    // already match `run.taskId === params.id`. Finished keys still expire
    // via ACTION_RUN_TERMINAL_TTL_MS.
    const linkRunKey = crypto.randomUUID();
    return actionRunStarted(linkRunKey, 'link', async (onProgress) => {
      const done = await runLink(onProgress);
      return { redirect: done.redirect };
    });
  }

  try {
    const done = await runLink();
    return Response.redirect(done.redirect, 303);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof RpcError ? err.status : 500;
    if (status === 400 || status === 404 || status === 409 || status === 422) {
      return render(draft, { text: message, error: true }, status);
    }
    return html(errorHtml('Server Error', message), status);
  }
}

/**
 * The task edit page — GET renders the form, POST saves through the daemon.
 *
 * Two rules shape this handler:
 *
 *  - ONE set of edit rules. What the form offers comes from
 *    `taskEditability()`, the same predicate `editTask` enforces, so the page
 *    never shows a box the daemon would refuse. When it refuses anyway (a turn
 *    started between render and submit), the reason is rendered in product
 *    language rather than as a raw RPC error.
 *  - Never lose what was typed. A failed save re-renders from the SUBMITTED
 *    values, not from storage.
 */
async function handleTaskEdit(
  storage: Storage,
  taskActions: TaskActions | undefined,
  req: Request,
  url: URL,
  taskIdParam: string,
): Promise<Response> {
  const task = await storage.getTask(taskIdParam);
  if (!task) {
    return html(errorHtml('Not Found', `Task not found: ${taskIdParam}`), 404);
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const turnCount = await storage.getTurnCountByTaskId(task.id);
  const editability = taskEditability(task.status, turnCount);
  const lockedReason = lockedFieldsReason(task.status, turnCount);
  const savedPrompt = currentPromptOf(task) ?? '';
  const savedEffort = String(task.metadata?.effort ?? '');

  const agentChoices = await selectableAgentsForTask(task.agent_id);
  const duplicatedCodes = duplicateTaskCodes(await storage.listTaskCodes());

  const render = async (draft: TaskEditDraft, notice?: { text: string; error?: boolean }) => {
    const promptVersions = await storage.getPromptHistory(task.id);
    return html(
      taskEditHtml(task, editability, lockedReason, draft, {
        agents: agentChoices.choices,
        ...(agentChoices.notice ? { agentsNotice: agentChoices.notice } : {}),
        efforts: VALID_EFFORT_LEVELS,
        promptVersions,
        duplicatedCodes,
        ...(notice ? { notice } : {}),
      }),
      notice?.error ? 400 : 200,
    );
  };

  const savedDraft: TaskEditDraft = {
    goal: task.goal,
    prompt: savedPrompt,
    model: task.model ?? '',
    effort: savedEffort,
    agent: task.agent_id,
  };

  if (req.method === 'GET') {
    return render(savedDraft);
  }

  if (!taskActions) {
    const msg = 'Task editing is not available: this dashboard was started without a daemon action port.';
    return html(errorHtml('Unavailable', msg), 503);
  }

  const form = await req.formData();
  // Locked fields are not in the form at all when the task has started, so the
  // saved values stand in for display; they are never sent as an edit.
  const draft: TaskEditDraft = {
    goal: form.has('goal') ? String(form.get('goal') ?? '') : task.goal,
    prompt: form.has('prompt') ? String(form.get('prompt') ?? '') : savedPrompt,
    model: String(form.get('model') ?? '').trim(),
    effort: String(form.get('effort') ?? '').trim(),
    agent: String(form.get('agent') ?? task.agent_id).trim(),
  };

  const input: TaskEditInput = {};
  if (editability.canEditLockedFields) {
    if (draft.goal.trim() !== task.goal) input.goal = draft.goal;
    if (draft.prompt !== savedPrompt) input.prompt = draft.prompt;
  }
  if (draft.model && draft.model !== (task.model ?? '')) input.model = draft.model;
  if (draft.effort && draft.effort !== savedEffort) input.effort = draft.effort;
  if (draft.agent && draft.agent !== task.agent_id) input.agent = draft.agent;

  if (editability.canEditLockedFields && !draft.goal.trim()) {
    return render(draft, { text: 'The goal cannot be empty.', error: true });
  }
  // The model box cannot express "no override" — an empty box means "leave it
  // alone", and saying so beats silently doing nothing.
  if (!draft.model && task.model) {
    return render(draft, {
      text: `The model override (${task.model}) cannot be cleared from here — type a different model, or run \`lazy edit ${task.code ?? task.id} --model <name>\` to change it in a terminal.`,
      error: true,
    });
  }
  if (Object.keys(input).length === 0) {
    return render(draft, { text: 'Nothing changed.' });
  }

  try {
    await taskActions.editTask(task.id, input);
  } catch (err) {
    // A task can start between the GET that drew this form and this POST — the
    // daemon then refuses a goal/prompt edit in its own CLI wording ("task has
    // already been started; only model, effort, runner and agent can be
    // changed…"). Correct, and exactly the raw refusal this page exists to
    // avoid showing. Re-read the task instead of matching on that string: if
    // the locked fields are no longer editable and we sent one, this IS that
    // race, and it gets the same product language the locked form uses.
    //
    // The form re-renders with the stale (editable) shape on purpose, so the
    // typed prompt is still there to copy out. Saving it again will refuse
    // again — the notice says why, and the task page is one click away.
    const fresh = await storage.getTask(task.id);
    if (fresh) {
      const freshTurns = await storage.getTurnCountByTaskId(task.id);
      const freshEditability = taskEditability(fresh.status, freshTurns);
      // Read against the shared list rather than naming goal/prompt here, so a
      // field added to it later is covered without touching this handler.
      const sentLocked = LOCKED_ONCE_STARTED.some(
        (field) => (input as Record<string, unknown>)[field] !== undefined,
      );
      const nowRefused =
        !freshEditability.canEditMidFlightFields || (sentLocked && !freshEditability.canEditLockedFields);
      if (nowRefused) {
        const reason = lockedFieldsReason(fresh.status, freshTurns);
        return render(draft, {
          text: `${reason ?? ''} The task changed while you were typing, so nothing was saved — copy anything you want to keep before you leave this page.`.trim(),
          error: true,
        });
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return render(draft, { text: `That edit could not be saved: ${message}`, error: true });
  }

  return Response.redirect(await taskPageUrl(storage, url.origin, task), 303);
}

async function handleCommitDetail(storage: Storage, taskId: string, commitId: string): Promise<Response> {
  const task = await storage.getTask(taskId);
  if (!task) {
    return html(errorHtml('Not Found', `Task not found: ${taskId}`), 404);
  }

  const session = await storage.getSessionByTaskId(task.id);
  if (!session) {
    return html(errorHtml('Not Found', 'Task has no session'), 404);
  }

  const commits = await storage.getSessionCommits(session.id);
  const commit = commits.find(c => c.id === commitId);
  if (!commit) {
    return html(errorHtml('Not Found', `Commit not found: ${commitId}`), 404);
  }

  // Fetch diff from git on demand (no longer stored in commits.json)
  const diffText = await getCommitDiff(commit.sha);

  return html(commitDetailHtml(task, commit, diffText, duplicateTaskCodes(await storage.listTaskCodes())));
}

/**
 * `/tasks/:id/turns/:sequence` — the turn IN ITS CHUNK.
 *
 * A turn used to get a page of its own, which is exactly the fragmentation the
 * Turns tab was regrouped to end: the turn arrived stripped of the nudge that
 * caused it and the work that followed. The URL is unchanged and still the way
 * every other surface names a turn; it now redirects to the chunked Turns tab
 * anchored on that turn, where the reveal island scrolls to it and marks its
 * chunk current.
 *
 * The turn is still resolved first, so a sequence this task does not have is a
 * 404 here rather than a silent landing on the top of the tab.
 */
async function handleTurnDetail(
  storage: Storage,
  taskId: string,
  turnSequence: number,
  origin: string,
): Promise<Response> {
  const task = await storage.getTask(taskId);
  if (!task) {
    return html(errorHtml('Not Found', `Task not found: ${taskId}`), 404);
  }

  const session = await storage.getSessionByTaskId(task.id);
  if (!session) {
    return html(errorHtml('Not Found', 'Task has no session'), 404);
  }

  const allTurns = await storage.getSessionTurns(session.id);
  if (!allTurns.some((t) => t.sequence === turnSequence)) {
    return html(errorHtml('Not Found', `Turn ${turnSequence} not found`), 404);
  }

  return Response.redirect(
    `${await taskPageUrl(storage, origin, task)}/turns#turn-${turnSequence}`,
    302,
  );
}

async function handlePromptVersion(storage: Storage, taskId: string, versionParam: string): Promise<Response> {
  const task = await storage.getTask(taskId);
  if (!task) {
    return html(errorHtml('Not Found', `Task not found: ${taskId}`), 404);
  }

  const [allVersions, codes] = await Promise.all([
    storage.getPromptHistory(task.id),
    storage.listTaskCodes(),
  ]);
  const duplicatedCodes = duplicateTaskCodes(codes);

  if (versionParam === 'current') {
    return html(promptVersionHtml(task, null, 'current', allVersions, duplicatedCodes));
  }

  const versionNum = parseInt(versionParam, 10);
  if (isNaN(versionNum)) {
    return html(errorHtml('Bad Request', `Invalid version: ${versionParam}`), 400);
  }

  const version = await storage.getPromptVersion(task.id, versionNum);
  if (!version) {
    return html(errorHtml('Not Found', `Prompt version ${versionNum} not found`), 404);
  }

  return html(promptVersionHtml(task, version, versionParam, allVersions, duplicatedCodes));
}

async function handleSearch(storage: Storage, url: URL): Promise<Response> {
  const query = url.searchParams.get('q') ?? '';
  if (!query) return html(searchResultsHtml([], query));

  try {
    // executeSearch, never storage.search: mode selection (fuzzy / structured /
    // regex) is the business rule the CLI and MCP run, and calling the store
    // directly here is what made `code:spike` mean two different things.
    const { results, hint } = await executeSearch(storage, { query });
    // Results link by task code; duplicated codes fall back to the id.
    const dup = duplicateTaskCodes(await storage.listTaskCodes());
    return html(searchResultsHtml(results, query, undefined, hint, dup));
  } catch (err) {
    // A refused regex, or a query the parser rejects, is the human's query and
    // not a server fault: say so on the page instead of 500-ing, with the same
    // wording `lazy search` prints for the same query.
    const message = err instanceof QueryParseError
      ? `Query parse error: ${err.message}`
      : err instanceof Error ? err.message : String(err);
    return html(searchResultsHtml([], query, message), 400);
  }
}

/**
 * JSON search for the command palette. Same store search as `/search`, but
 * returns results the palette island can render without a full page load.
 */
async function handleApiSearch(storage: Storage, url: URL): Promise<Response> {
  const query = url.searchParams.get('q') ?? '';
  if (!query.trim()) {
    return json({ query, results: [] });
  }
  try {
    // Same engine as /search and the CLI — see handleSearch above.
    const { results } = await executeSearch(storage, { query });
    // The palette renders task links from these results; duplicated codes go
    // along so those links can fall back to the id like every other surface.
    const duplicated_codes = [...duplicateTaskCodes(await storage.listTaskCodes())];
    return json({ query, results, duplicated_codes });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : String(err), query, results: [] },
      400,
    );
  }
}

async function handleApiTaskList(storage: Storage, url: URL): Promise<Response> {
  const filter = url.searchParams.get('filter') ?? '';

  let tasks;
  switch (filter) {
    case 'all':
      tasks = await storage.listTasks();
      break;
    case 'working':
      tasks = await storage.listTasksWithOptions({ workingOnly: true });
      break;
    case 'interrupted':
      tasks = await storage.listTasksWithOptions({ interruptedOnly: true });
      break;
    case 'blocked':
      tasks = await storage.listTasksWithOptions({ blockedOnly: true });
      break;
    case 'submitted':
      tasks = await storage.listTasksWithOptions({ submittedOnly: true });
      break;
    default:
      tasks = await storage.listTasksWithOptions({ nonTerminalOnly: true });
      break;
  }

  return json(tasks);
}

async function handleApiActivity(storage: Storage): Promise<Response> {
  const allTasks = await storage.listTasks();
  const tasksWithSessions: TaskWithSession[] = await Promise.all(
    allTasks.map(async (task) => ({
      task,
      session: await storage.getSessionByTaskId(task.id),
    }))
  );
  const activityData = await buildActivityData(storage, tasksWithSessions);
  return json(activityData);
}

async function handleApiTaskDetail(storage: Storage, taskId: string): Promise<Response> {
  const task = await storage.getTask(taskId);
  if (!task) {
    return json({ error: 'Task not found' }, 404);
  }

  const session = await storage.getSessionByTaskId(task.id);
  const turns = session ? await storage.getSessionTurns(session.id) : [];
  const commits = session ? await storage.getSessionCommits(session.id) : [];
  const comments = await storage.getTaskComments(task.id);
  const journal = await storage.getTaskJournal(task.id);
  const raisedItems = await withPromotedTaskCodes(await storage.getTaskRaisedItems(task.id), (id) => storage.getTask(id));
  const children = await storage.getChildTasks(task.id);

  return json({ task, session, turns, commits, comments, journal, raisedItems, children });
}

/**
 * Origin for Location headers. Prefer the request Host so a fetch that
 * transports to 127.0.0.1 with Host: lazy.localhost:<port> (the dashboard
 * gate) keeps following on that host — url.origin would be 127.0.0.1 and
 * the next hop would drop the Host override and 401.
 */
function requestOrigin(req: Request, url: URL): string {
  const host = req.headers.get('host');
  return host ? `${url.protocol}//${host}` : url.origin;
}

/**
 * Match a URL path against a pattern with :param placeholders.
 * Returns extracted params or null if no match.
 */
function matchRoute(path: string, pattern: string): Record<string, string> | null {
  const pathParts = path.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);

  if (pathParts.length !== patternParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      // Captured params are DECODED here, once, for every route — the inverse
      // of the single escape generation applies to each path segment. Doing it
      // at the split is what keeps the pair symmetric: a handler cannot forget
      // it, and no handler decodes twice.
      params[patternParts[i].slice(1)] = decodePathSegment(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Race a dashboard request against {@link WEB_REQUEST_DEADLINE_MS}.
 *
 * Every route below reads storage proportionally to project size — the
 * dashboard and `/api/activity` walk every task and every turn, and a commit
 * page spawns `git diff`. On a large project under load, none of them is
 * *structurally* bounded below the listener's `idleTimeout`, and an unbounded
 * request on Bun.serve does not fail: it is reaped mid-flight, leaving the
 * browser with a closed socket and the user with no idea why.
 *
 * The daemon's RPC and MCP routes solve this with the heartbeat envelope, which
 * is not available here — a browser cannot opt in via `X-Lazy-Heartbeat` and
 * cannot read NDJSON. So the dashboard gets a deadline instead, landing inside
 * the idle timeout so the failure is always an HTTP response the user can read
 * rather than a silent reap. That makes "bounded under the idle timeout" true
 * for these routes by construction rather than by hope.
 *
 * The in-flight work is deliberately NOT cancelled: these routes are read-only,
 * the read will finish and be discarded, and there is no cancellation token to
 * thread through storage anyway.
 */
async function withWebRequestDeadline(
  path: string,
  work: Promise<Response>,
  deadlineMs: number,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Response>(resolve => {
    timer = setTimeout(() => {
      const seconds = Math.round(deadlineMs / 1000);
      const message =
        `This page took longer than ${seconds}s to build and was stopped before the ` +
        `daemon's connection timeout could kill it silently. This usually means the ` +
        `project has grown large enough that a full dashboard render is expensive, or ` +
        `the storage backend is slow or unreachable. Try a narrower view (a single task ` +
        `page rather than the dashboard), and check \`lazy doctor\`.`;
      logger.error(`Web request exceeded ${seconds}s deadline: ${path}`);
      resolve(
        path.startsWith('/api/')
          ? Response.json({ error: message }, { status: 503 })
          : html(errorHtml('Request Timed Out', message), 503),
      );
    }, deadlineMs);
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    // Always cleared — an uncleared interval/timeout keeps the daemon's event
    // loop scheduling work for every request it ever served.
    if (timer) clearTimeout(timer);
  }
}

/**
 * Create the web dashboard request handler for a given storage instance.
 *
 * This handler serves HTML pages and JSON API endpoints for the web dashboard.
 * It's used by the daemon's TCP-bound web server, which is the only thing that
 * serves the dashboard (`lazy daemon dashboard-url` just prints its URL).
 *
 * ROUTE BOUNDING (see the daemon route table in src/daemon/server.ts):
 * every route here is storage-proportional and therefore NOT structurally
 * bounded below the listener idle timeout on a large project. None can be
 * heartbeat-framed (the client is a browser). They are bounded instead by
 * {@link withWebRequestDeadline}, which applies uniformly to all of them —
 * including the 404 and the error path — so no route is left unaccounted for
 * when a new one is added below.
 *
 * `options.deadlineMs` exists so tests can compress the deadline the way
 * `heartbeatEnvelopeResponse`'s `intervalMs` does — production never passes it.
 *
 * `options.stylesheetFromDisk` picks the stylesheet SOURCE (see ./styles.ts).
 * The daemon leaves it off and serves the copy compiled into the binary; a
 * process running from source turns it on so a CSS edit is picked up by a page
 * reload alone. It changes where the bytes come from, nothing about the render.
 */
export function createWebRequestHandler(
  storage: Storage,
  actions?: ReviewActions,
  options?: {
    deadlineMs?: number;
    stylesheetFromDisk?: boolean;
    messageActions?: MessageActions;
    /** Unused on HTTP: Review with builder start/send is gone. Kept so daemon bind stays compatible. */
    reviewSessionActions?: ReviewSessionActions;
    /** Shared-memory writes (save/delete/compact). Reads stay on Storage. */
    memoryActions?: MemoryActions;
    /** Doctor run / last-report / remedies. GET never runs the sweep. */
    doctorActions?: DoctorActions;
    /** Task goal/prompt edits — the /tasks/:id/edit form. */
    taskActions?: TaskActions;
    /** Designate `[serve] start_services_cmd` on the project root's lazy.toml. */
    serveActions?: ServeActions;
    /** The daemon's [usage_pause] state, for the dashboard's status line. */
    usagePauseState?: () => Promise<UsagePauseState>;
  },
): (req: Request) => Promise<Response> {
  const deadlineMs = options?.deadlineMs ?? WEB_REQUEST_DEADLINE_MS;
  const cssFromDisk = options?.stylesheetFromDisk === true;
  const messageActions = options?.messageActions;
  const reviewSessionActions = options?.reviewSessionActions;
  const memoryActions = options?.memoryActions;
  const doctorActions = options?.doctorActions;
  const taskActions = options?.taskActions;
  const serveActions = options?.serveActions;
  const usagePauseState = options?.usagePauseState;
  return async (req: Request) => {
    const url = new URL(req.url);
    const path = url.pathname;
    return withWebRequestDeadline(
      path,
      routeWebRequest(
        storage,
        actions,
        messageActions,
        reviewSessionActions,
        memoryActions,
        doctorActions,
        taskActions,
        serveActions,
        req,
        url,
        path,
        cssFromDisk,
        usagePauseState,
      ),
      deadlineMs,
    );
  };
}

/**
 * Serve the dashboard stylesheet.
 *
 * `no-store` rather than a cached response with an ETag: this is a loopback
 * dashboard where a stale stylesheet costs far more (an edit that appears not
 * to have happened) than a re-fetch of ~20KB does.
 */
async function handleStylesheet(fromDisk: boolean): Promise<Response> {
  const css = fromDisk ? await stylesheetFromDisk() : bundledStylesheet();
  return new Response(css, {
    headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * Vendored mermaid.js for offline diagram rendering on the review surface.
 *
 * Same fromDisk/bundled split as the stylesheet: a from-source process re-reads
 * node_modules so a mermaid upgrade is a reload away; the compiled binary
 * serves the copy baked in at build time. Cache-Control is deliberate — the
 * file is ~3.5MB and immutable per install, so browsers may keep it for the
 * session; a binary upgrade changes the URL's bytes but not its path, which is
 * fine on loopback (the daemon restarts with the new binary).
 */
async function handleMermaidAsset(fromDisk: boolean): Promise<Response> {
  const js = fromDisk ? await mermaidJsFromDisk() : bundledMermaidJs();
  return new Response(js, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** Vendored xterm.js / addon / CSS for the web shell. Same fromDisk/bundled
 * split and no-store posture as mermaid; loaded only by a page opening a
 * shell panel. */
function jsAsset(js: string): Response {
  return new Response(js, {
    headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * The route table itself. Bounded by its caller — see {@link createWebRequestHandler}.
 *
 * Takes the whole `Request` (not just the URL) because the review routes are
 * the only ones that mutate: they need the method and the body.
 */
async function routeWebRequest(
  storage: Storage,
  actions: ReviewActions | undefined,
  messageActions: MessageActions | undefined,
  reviewSessionActions: ReviewSessionActions | undefined,
  memoryActions: MemoryActions | undefined,
  doctorActions: DoctorActions | undefined,
  taskActions: TaskActions | undefined,
  serveActions: ServeActions | undefined,
  req: Request,
  url: URL,
  path: string,
  cssFromDisk: boolean,
  usagePauseState?: () => Promise<UsagePauseState>,
): Promise<Response> {
  try {
    if (path === STYLESHEET_PATH) {
      return await handleStylesheet(cssFromDisk);
    }
    if (path === MERMAID_ASSET_PATH) {
      return await handleMermaidAsset(cssFromDisk);
    }
    if (path === XTERM_JS_PATH) {
      return jsAsset(cssFromDisk ? await xtermJsFromDisk() : bundledXtermJs());
    }
    if (path === XTERM_FIT_JS_PATH) {
      return jsAsset(cssFromDisk ? await xtermFitJsFromDisk() : bundledXtermFitJs());
    }
    if (path === XTERM_CSS_PATH) {
      const css = cssFromDisk ? await xtermCssFromDisk() : bundledXtermCss();
      return new Response(css, {
        headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // The nav badges' one fetch. Above the per-surface routers because it spans
    // all of them — it is not part of any single surface.
    if (path === '/api/nav-counts') {
      return await handleNavCounts(storage, actions, req, url);
    }

    // Command-palette live search. Same store search as `/search`; JSON only.
    if (path === '/api/search') {
      if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      return await handleApiSearch(storage, url);
    }

    // Cluster TASKS (the `cluster` task type). `/loops` is kept as a redirect for
    // one release: the page was called Loops until 2026-09-20 and the path is in
    // people's history, bookmarks and the command palette's cached entries.
    if (path === '/clusters') {
      return await handleClusterTasks(storage, taskActions, req, url);
    }
    if (path === '/loops') {
      return Response.redirect(new URL('/clusters', url).toString(), 301);
    }

    // Review surface and follow-up promote mutate through action ports — i.e.
    // through the daemon. Reads on those pages may still use Storage directly.
    if (path === '/review' || path.startsWith('/review/') || path.startsWith('/api/review/')) {
      return await handleReviewRoute(storage, actions, reviewSessionActions, taskActions, serveActions, req, url, path);
    }

    // System-messages inbox. Reads are plain storage reads; the two state
    // changes go through the MessageActions port — i.e. through the daemon.
    if (path === '/messages' || path.startsWith('/messages/') || path === '/api/messages') {
      return await handleMessagesRoute(storage, messageActions, req, url, path);
    }

    // Raised items — one page for blocking and non-blocking alike. The old
    // /followups paths redirect rather than 404: they are in old task prompts,
    // in bookmarks, and in the CHANGELOG of the release before this one.
    if (path === '/followups' || path.startsWith('/followups/') || path === '/api/followups') {
      const moved = path.replace(/^\/followups/, '/raised').replace(/^\/api\/followups/, '/api/raised');
      return Response.redirect(`${url.origin}${moved}${url.search}`, 308);
    }

    if (path === '/raised' || path.startsWith('/raised/') || path === '/api/raised') {
      return await handleRaisedRoute(storage, actions, req, url, path, taskActions, serveActions);
    }

    // Builder conversations. Reads come straight from Storage; the one
    // mutation — promoting part of a transcript into a task — goes through the
    // action port like every other write on this surface.
    if (
      path === '/conversations' ||
      path.startsWith('/conversations/') ||
      path === '/api/conversations'
    ) {
      return await handleConversationsRoute(storage, actions, req, url, path);
    }

    // Builder scratch — read-only, straight from the store.
    if (path === '/scratch' || path.startsWith('/scratch/') || path === '/api/scratch') {
      return await handleScratchRoute(storage, req, url, path);
    }

    // Settings — Memories (the existing memory index) and Doctor. The old
    // /memory listing redirects here so bookmarks keep working; create/edit
    // / compact stay at their /memory/... paths.
    if (path === '/settings' || path.startsWith('/settings/')) {
      return await handleSettingsRoute(storage, doctorActions, req, url, path);
    }

    // Shared memory. Reads are Storage; create/delete/compact go through
    // MemoryActions — i.e. through the daemon — so authoring validation and
    // the LLM compact stay one implementation.
    if (path === '/memory' || path.startsWith('/memory/') || path === '/api/memory') {
      return await handleMemoryRoute(storage, memoryActions, req, url, path);
    }

    // HTML routes
    if (path === '/') {
      return await handleDashboard(storage, usagePauseState);
    }

    // Review with builder is gone: the listing was itself an entry point.
    if (path === '/sessions') {
      if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      return html(errorHtml('Gone', REVIEW_WITH_BUILDER_GONE_MESSAGE), 410);
    }

    if (path === '/tasks') {
      return await handleTaskList(storage, url);
    }

    // New-task and Link forms. Must be before /tasks/:id so "new" / "link"
    // are not treated as task ids — which is also why no task may CARRY those
    // codes: the segments are listed once in RESERVED_TASK_PATH_SEGMENTS, which
    // validateCode refuses and link generation falls back from. Matching
    // against that list here is what keeps a future reserved route from
    // drifting away from the rule.
    if (path === `/tasks/${TASK_PATH_SEGMENT_NEW}`) {
      return await handleTaskCreate(storage, taskActions, req, url);
    }
    if (path === `/tasks/${TASK_PATH_SEGMENT_LINK}`) {
      return await handleTaskLink(storage, taskActions, req, url);
    }

    if (path === '/search') {
      return await handleSearch(storage, url);
    }

    // Review actions and the builder-session leaf under the Current review tab.
    // GET /tasks/:id/review is the tab itself and is handled below.
    if (/^\/tasks\/[^/]+\/review(\/|$)/.test(path)) {
      const reviewTab = matchRoute(path, '/tasks/:id/review');
      if (reviewTab && req.method === 'GET') {
        return await handleTaskDetail(storage, reviewTab.id, url, taskActions, actions, 'review', undefined, undefined, undefined, { serveActions });
      }
      return await handleReviewRoute(storage, actions, reviewSessionActions, taskActions, serveActions, req, url, path);
    }

    // Commit detail: /tasks/:id/commits/:commitId
    let params = matchRoute(path, '/tasks/:id/commits/:commitId');
    if (params) {
      return await handleCommitDetail(storage, params.id, params.commitId);
    }

    // Turn detail: /tasks/:id/turns/:sequence
    params = matchRoute(path, '/tasks/:id/turns/:sequence');
    if (params) {
      const seq = parseInt(params.sequence, 10);
      if (isNaN(seq)) {
        return html(errorHtml('Bad Request', 'Invalid turn sequence'), 400);
      }
      return await handleTurnDetail(storage, params.id, seq, requestOrigin(req, url));
    }

    // Task edit form: /tasks/:id/edit (GET renders, POST saves)
    params = matchRoute(path, '/tasks/:id/edit');
    if (params) {
      return await handleTaskEdit(storage, taskActions, req, url, params.id);
    }

    // Lifecycle actions: /tasks/:id/actions/:verb (POST-only, form + redirect)
    params = matchRoute(path, '/tasks/:id/actions/:verb');
    if (params) {
      return await handleTaskAction(storage, taskActions, req, url, params.id, params.verb);
    }

    // Container start: /tasks/:id/container/start (POST-only, form + redirect)
    params = matchRoute(path, '/tasks/:id/container/start');
    if (params) {
      return await handleContainerStart(storage, taskActions, req, url, params.id);
    }

    // Designate / change / clear the project's Start services command
    // (POST-only). Before the generic /tasks/:id/:tab route so "services" is not
    // eaten as a tab slug for a POST that must mutate.
    params = matchRoute(path, '/tasks/:id/services/start-cmd/clear');
    if (params) {
      return await handleDesignateStartCmd(storage, serveActions, req, url, params.id, 'clear');
    }
    params = matchRoute(path, '/tasks/:id/services/start-cmd');
    if (params) {
      return await handleDesignateStartCmd(storage, serveActions, req, url, params.id);
    }

    // Add a comment from the Comments tab (POST-only). Before the generic
    // /tasks/:id/:tab route for the same reason start-cmd is: `comments` is a
    // tab slug, and a mutation must not be swallowed as a tab render.
    params = matchRoute(path, '/tasks/:id/comments/add');
    if (params) {
      return await handleAddComment(storage, req, url, params.id);
    }

    // Edit a comment the agent has not seen yet (POST-only), same ordering reason.
    params = matchRoute(path, '/tasks/:id/comments/:commentId/edit');
    if (params) {
      return await handleEditCommentForm(storage, req, url, params.id, params.commentId);
    }

    // The same start, for a panel that needs the container rather than a human
    // pressing a button: POST to begin-or-join, GET to follow it to the end.
    params = matchRoute(path, '/tasks/:id/container/ensure');
    if (params) {
      return await handleContainerEnsure(storage, taskActions, req, params.id, 'ensure');
    }
    params = matchRoute(path, '/tasks/:id/container/state');
    if (params) {
      return await handleContainerEnsure(storage, taskActions, req, params.id, 'state');
    }

    // Live action-dialog follow: snapshot of one in-flight verb.
    params = matchRoute(path, '/tasks/:id/action-runs/:runId');
    if (params) {
      if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const run = getActionRun(params.runId);
      if (!run) return json({ error: 'Action run not found' }, 404);
      // Link has no task yet, so the run is keyed on a per-request UUID.
      // Match that key first; fall back to resolving a real task so
      // `/tasks/<short-id>/action-runs/…` still works. A run for task A is
      // never served under task B's path even when the run id is known.
      if (run.taskId === params.id) {
        return json(actionRunJson(run));
      }
      const resolved = await storage.resolveTask(params.id);
      if (!actionRunMatchesPath(run, params.id, resolved.task?.id ?? null)) {
        return json({ error: 'Action run not found' }, 404);
      }
      return json(actionRunJson(run));
    }

    // Live status token: cheap poll the task page uses to refresh chrome
    // when status / progress / turns change without a full reload.
    params = matchRoute(path, '/tasks/:id/live-status');
    if (params) {
      if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      return await handleTaskLiveStatus(storage, params.id);
    }

    // Prompt version: /tasks/:id/prompts/:version
    params = matchRoute(path, '/tasks/:id/prompts/:version');
    if (params) {
      return await handlePromptVersion(storage, params.id, params.version);
    }

    // Named tabs under /tasks/:id/<slug>. Landing is the bare path below.
    params = matchRoute(path, '/tasks/:id/:tab');
    if (params && isTaskTabSlug(params.tab)) {
      return await handleTaskDetail(storage, params.id, url, taskActions, actions, params.tab, undefined, undefined, undefined, { serveActions });
    }

    // Task detail / Landing: /tasks/:id (must be after sub-routes)
    params = matchRoute(path, '/tasks/:id');
    if (params) {
      return await handleTaskDetail(storage, params.id, url, taskActions, actions, 'landing', undefined, undefined, undefined, { serveActions });
    }

    // JSON API routes
    if (path === '/api/activity') {
      return await handleApiActivity(storage);
    }

    if (path === '/api/tasks') {
      return await handleApiTaskList(storage, url);
    }

    params = matchRoute(path, '/api/tasks/:id');
    if (params) {
      return await handleApiTaskDetail(storage, params.id);
    }

    return html(errorHtml('Not Found', 'Page not found'), 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Server error: ${message}`);
    if (path.startsWith('/api/')) {
      const status = err instanceof RpcError ? err.status : 500;
      return json({ error: message }, status);
    }
    return html(errorHtml('Server Error', message), 500);
  }
}

/**
 * Every count the nav shows, in one response. The counts — and the reasoning
 * behind each one — live in ./nav-counts, shared with the daemon's `navCounts`
 * RPC so Lazy Teams' nav cannot disagree with this one.
 */
async function handleNavCounts(
  storage: Storage,
  actions: ReviewActions | undefined,
  req: Request,
  url: URL,
): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  return json(await computeNavCounts(storage, actions, Number(url.searchParams.get('conversationsSince'))));
}

/**
 * Route the review surface.
 *
 * Split out of the main router because these routes need the ReviewActions
 * port. When no port is injected (Storage-only handler, as in unit tests), they
 * answer 503 with an explanation instead of half-working — a review page that
 * renders but silently drops comments would violate "never lose human
 * feedback" in the worst possible way.
 */
async function handleReviewRoute(
  storage: Storage,
  actions: ReviewActions | undefined,
  _sessionActions: ReviewSessionActions | undefined,
  taskActions: TaskActions | undefined,
  serveActions: ServeActions | undefined,
  req: Request,
  url: URL,
  path: string,
): Promise<Response> {
  const wantsJson = path.startsWith('/api/');

  // Redirect targets inside this route read the task's code (id when the code
  // is duplicated), so the browser lands on the task that was acted on and
  // the address bar reads like every other task URL.
  //
  // Read LAZILY, and at most once: this handler also serves the hot JSON
  // routes — `file-lines` fires on every diff expand and `draft/autosave` on
  // every keystroke pause — and neither builds a task URL, so neither should
  // pay a whole-store code read. The queue page below shares this same read
  // rather than issuing its own.
  let reviewDupCache: ReadonlySet<string> | null = null;
  const reviewDupCodes = async (): Promise<ReadonlySet<string>> => {
    reviewDupCache ??= duplicateTaskCodes(await storage.listTaskCodes());
    return reviewDupCache;
  };

  // Old /review/:id… bookmarks and form POSTs keep working: 308 preserves
  // method and body. The queue and the JSON API do not move.
  const relocated = relocatedReviewPath(path);
  if (relocated) {
    return Response.redirect(`${url.origin}${relocated}${url.search}`, 308);
  }

  // Review with builder start/send is gone. GET still reads a stored
  // review-session.json when one exists; nothing here launches a builder.
  if (
    matchRoute(path, '/tasks/:id/review/session/start') ||
    matchRoute(path, '/tasks/:id/review/session/send') ||
    matchRoute(path, '/tasks/:id/review/session') ||
    matchRoute(path, '/api/review/:id/session')
  ) {
    return await handleReviewSessionRoute(storage, req, url, path);
  }

  // Screenshot bytes for a presentation's image cards. Reads the ARTIFACT
  // STORE through Storage — never the task worktree, which is agent-writable
  // and may not even exist by review time. No action port needed: this only
  // reads, and the dashboard session guard already ran before the router.
  const artifactParams = matchRoute(path, '/api/review/:id/artifact');
  if (artifactParams) {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(artifactParams.id);
    if (!resolved.task) return json({ error: 'Task not found' }, 404);
    const name = url.searchParams.get('name') ?? '';
    if (!name) return json({ error: 'name is required' }, 400);
    const artifact = await storage.getTaskArtifact(resolved.task.id, name);
    if (!artifact) return json({ error: `Artifact not found: ${name}` }, 404);
    // Images only. Serving arbitrary artifact bytes inline on the dashboard's
    // own origin would let an agent-authored HTML or SVG artifact run script
    // against this page; a screenshot route has no reason to allow it.
    if (!artifact.mime_type.startsWith('image/') || artifact.mime_type === 'image/svg+xml') {
      return json({ error: `Artifact is not a renderable image: ${name} (${artifact.mime_type})` }, 415);
    }
    return new Response(Buffer.from(artifact.content_base64, 'base64'), {
      headers: {
        'Content-Type': artifact.mime_type,
        'Content-Disposition': `inline; filename="${encodeURIComponent(artifact.name.split('/').pop() ?? 'screenshot')}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  }

  if (!actions) {
    const msg = 'Review actions are not available: this dashboard was started without a daemon action port.';
    return wantsJson ? json({ error: msg }, 503) : html(errorHtml('Unavailable', msg), 503);
  }

  if (path === '/review') {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    // `queue` is the daemon walking every task in the project to find the
    // blocked ones and count their descendants — the queue's whole cost, and
    // the reason it is measured separately from rendering the table.
    const queueTimings = new RenderTimings('/review');
    const queue = await queueTimings.measure('queue', () => actions.listQueue());
    queueTimings.count('entries', queue.length);
    // Shares the handler's single code read rather than issuing a second one.
    const queueDup = await reviewDupCodes();
    return timedHtml(
      queueTimings,
      queueTimings.measureSync('render', () => reviewQueueHtml(queue, url.searchParams.get('sort'), queueDup)),
    );
  }

  if (path === '/api/review/queue') {
    // Same ordering as the page, from the same parser — a client reading the
    // JSON gets the queue in the order `/review?sort=…` would have shown it.
    const sort = parseReviewQueueSort(url.searchParams.get('sort'));
    return json({ queue: sortReviewQueue(await actions.listQueue(), sort) });
  }

  let params = matchRoute(path, '/api/review/:id/threads');
  if (params) {
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return json({ error: 'Task not found' }, 404);
    return json(
      threadsJson(await actions.listComments(resolved.task.id), await reviewLiveState(storage, resolved.task), resolved.task),
    );
  }

  // Unchanged context around a hunk, for the diff's expand controls. A GET
  // because it reads: no state changes, and the daemon bounds the range and
  // refuses any path outside this task's diff (see handleFileLines).
  params = matchRoute(path, '/api/review/:id/file-lines');
  if (params) {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return json({ error: 'Task not found' }, 404);
    const q = url.searchParams;
    const sideParam = q.get('side') ?? 'new';
    if (sideParam !== 'old' && sideParam !== 'new') {
      return json({ error: "side must be 'old' or 'new'" }, 400);
    }
    try {
      return json(
        await actions.getFileLines(resolved.task.id, {
          path: q.get('path') ?? '',
          side: sideParam,
          start: Number(q.get('start')),
          end: Number(q.get('end')),
        }),
      );
    } catch (err) {
      const status = err instanceof RpcError ? err.status : 500;
      return json({ error: err instanceof Error ? err.message : String(err) }, status);
    }
  }

  params = matchRoute(path, '/tasks/:id/review/ask');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return json({ error: 'Task not found' }, 404);
    const taskId = resolved.task.id;
    const contentType = req.headers.get('content-type') ?? '';
    let content = '';
    let threadId: string | undefined;
    // JSON asks (the island) stay on the tab via 201, not a redirect.
    let form: FormData | null = null;
    if (contentType.includes('application/json')) {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch (err) {
        return json({ error: `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}` }, 400);
      }
      content = typeof body.content === 'string' ? body.content.trim() : '';
      threadId = typeof body.threadId === 'string' ? body.threadId : undefined;
    } else {
      form = await req.formData();
      content = String(form.get('content') ?? '').trim();
      const tid = form.get('threadId');
      threadId = typeof tid === 'string' && tid ? tid : undefined;
    }
    if (!content) {
      const dialog = wantsActionDialog(req);
      if (dialog || wantsJson) {
        return json({ error: dialog ? 'Ask cannot be empty — write a question first.' : 'content is required' }, 400);
      }
      return renderReviewPage(storage, actions, taskActions, resolved.task.id, {
            text: 'Ask cannot be empty — write a question first.',
            error: true,
          }, undefined, undefined, serveActions);
    }
    if (wantsActionDialog(req)) {
      // SAVE is postComment itself. Wait for the ask turn so the dialog
      // narrates the same phases the CLI prints, then close + refresh.
      return actionRunStarted(taskId, 'ask', async (onProgress) => {
        await actions.postComment(taskId, {
          ...TASK_LEVEL_REVIEW_ANCHOR,
          content,
          intent: 'ask',
          threadId,
        }, { waitForAsk: true, onProgress });
        return { redirect: `${url.origin}${taskPath({ id: taskId, code: resolved.task?.code ?? null }, await reviewDupCodes())}/review` };
      });
    }
    const comment = await actions.postComment(resolved.task.id, {
      ...TASK_LEVEL_REVIEW_ANCHOR,
      content,
      intent: 'ask',
      threadId,
    });
    if (wantsJson || contentType.includes('application/json')) {
      return json({ comment }, 201);
    }
    return Response.redirect(`${url.origin}${taskPath(resolved.task, await reviewDupCodes())}/review`, 303);
  }

  params = matchRoute(path, '/tasks/:id/review/comment');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return json({ error: 'Task not found' }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch (err) {
      return json({ error: `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }
    const file = typeof body.file === 'string' ? body.file : '';
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    const line = typeof body.line === 'number' ? body.line : NaN;
    const side = body.side === 'old' ? 'old' : body.side === 'new' ? 'new' : null;
    if (!file || !content || !Number.isFinite(line) || !side) {
      return json({ error: 'file, line, side and content are required' }, 400);
    }
    // Absent intent means 'ask' — a question dispatched now. An explicit value
    // must be one of the three; a typo'd one is rejected rather than silently
    // treated as a question the reviewer never asked.
    if (
      body.intent !== undefined &&
      body.intent !== 'ask' &&
      body.intent !== 'comment' &&
      body.intent !== 'unblock'
    ) {
      return json({ error: "intent must be 'ask', 'comment' or 'unblock'" }, 400);
    }
    const unblocking = body.intent === 'unblock';
    try {
      // 'unblock' is a COMMENT plus the ordinary unblock, in that order. The
      // comment carries the anchor (file/line, prose quote, thread) exactly as
      // Add comment would, and it is durable BEFORE the turn is attempted —
      // launchUnblockTask then batches it, with every other queued comment,
      // into the turn it starts. CLAUDE.md: never lose human feedback.
      const comment = await actions.postComment(resolved.task.id, {
        file,
        line,
        side,
        content,
        intent: body.intent === 'comment' || unblocking ? 'comment' : 'ask',
        threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
        anchorSnippet: typeof body.anchorSnippet === 'string' ? body.anchorSnippet : undefined,
      });
      if (unblocking) {
        try {
          await actions.unblock(resolved.task.id, 'Act on the review comment I just left.', undefined, undefined, {
            keepFeedbackDraft: true,
          });
        } catch (err) {
          // The words are safe as a queued comment; say why no turn started.
          return json({ comment, unblockError: err instanceof Error ? err.message : String(err) }, 201);
        }
      }
      return json({ comment }, 201);
    } catch (err) {
      const status = err instanceof RpcError ? err.status : 500;
      return json({ error: err instanceof Error ? err.message : String(err) }, status);
    }
  }

  // Re-send a question whose ask failed. Deliberately a plain form POST with a
  // redirect rather than a fetch(): the whole point of this route is that the
  // reviewer's question survives, so it must work with scripting off too.
  params = matchRoute(path, '/tasks/:id/review/comment/:commentId/retry');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    try {
      await actions.retryAsk(resolved.task.id, params.commentId);
    } catch (err) {
      return renderReviewPage(storage, actions, taskActions, resolved.task.id, {
        text: `Could not re-send the question: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      }, undefined, undefined, serveActions);
    }
    return Response.redirect(`${url.origin}${taskPath(resolved.task, await reviewDupCodes())}/review`, 303);
  }

  // Promote a review discussion — a question and the answer it got — into a
  // real task. A plain form POST + redirect, like retry and withdraw, so it
  // works with scripting off; post-redirect-get so a refresh cannot try to
  // promote the same thread twice. The task is created in the BACKLOG: the web
  // UI never auto-starts work.
  params = matchRoute(path, '/tasks/:id/review/thread/:threadId/promote');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    const form = await req.formData();
    const field = (name: string): string | undefined => {
      const value = form.get(name);
      return typeof value === 'string' && value.trim() ? value : undefined;
    };
    try {
      const result = await actions.promoteDiscussion(resolved.task.id, params.threadId, {
        goal: field('goal'),
        prompt: field('prompt'),
        code: field('code'),
        relation: form.get('relation') === 'peer' ? 'peer' : 'subtask',
      });
      const label = result.task.code ?? result.task.id.slice(0, 8);
      return Response.redirect(
        `${url.origin}${taskPath(resolved.task, await reviewDupCodes())}/review?promoted=${encodeURIComponent(label)}`,
        303,
      );
    } catch (err) {
      return renderReviewPage(storage, actions, taskActions, resolved.task.id, {
        text: `Could not promote the discussion: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      }, undefined, undefined, serveActions);
    }
  }

  // Retract one of the reviewer's own messages before it reaches the agent.
  // Same plain form POST + redirect shape as retry, for the same reason: the
  // reviewer must be able to take a comment back with scripting off. The
  // daemon owns the rules about WHAT may be withdrawn (withdrawRefusalReason);
  // its message is relayed verbatim, so the page never invents its own.
  params = matchRoute(path, '/tasks/:id/review/comment/:commentId/withdraw');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    try {
      await actions.withdrawComment(resolved.task.id, params.commentId);
    } catch (err) {
      return renderReviewPage(storage, actions, taskActions, resolved.task.id, {
        text: `Could not withdraw: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      }, undefined, undefined, serveActions);
    }
    return Response.redirect(`${url.origin}${taskPath(resolved.task, await reviewDupCodes())}/review`, 303);
  }

  // Autosave for a review in progress: the unsent feedback and accept-reason
  // text and the viewed ticks, patched onto the task so the same review shows
  // up in another tab, another browser, or after navigating away.
  params = matchRoute(path, '/tasks/:id/review/draft');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return json({ error: 'Task not found' }, 404);
    let body: unknown;
    try {
      body = await req.json();
    } catch (err) {
      return json({ error: `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }
    // Parsed with the same validator the RPC verb uses: this route is an
    // external surface in its own right and may not rely on being the safe one.
    let patch: ReviewDraftPatch;
    try {
      patch = parseReviewDraftPatch((body as { patch?: unknown } | null)?.patch);
    } catch (err) {
      if (err instanceof ReviewDraftPatchError) return json({ error: err.message }, 400);
      throw err;
    }
    try {
      const draft = await actions.saveDraft(resolved.task.id, LOCAL_REVIEWER, patch);
      // An over-limit line draft refuses ONE anchor rather than the whole write
      // (see FileStorage.saveReviewDraft), so the rest of this patch — the
      // feedback box, an accept reason, the viewed ticks — is saved. Saying
      // nothing about the refused one would be the mute failure that made the
      // old all-or-nothing throw wrong in the first place, so the comparison is
      // done here and the reviewer is told which boxes are not being kept.
      const refused = Object.entries(patch.lineDrafts ?? {})
        .filter(([anchor, text]) => text !== '' && (draft.line_drafts ?? {})[anchor] !== text)
        .map(([anchor]) => anchor);
      if (refused.length > 0) {
        return json({
          savedAt: draft.updated_at,
          refusedLineDrafts: refused,
          warning:
            `${refused.length} comment box${refused.length === 1 ? '' : 'es'} could not be saved: ` +
            `this review already holds the maximum of ${MAX_LINE_DRAFTS} unsent comments. ` +
            `The words are still in the box — send or cancel some of the others, then type again to save.`,
        });
      }
      return json({ savedAt: draft.updated_at });
    } catch (err) {
      // Never a silent failure: the page turns its indicator red on this, which
      // is the reviewer's cue that their words are only in the textarea.
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  params = matchRoute(path, '/tasks/:id/review/unblock');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    const taskId = resolved.task.id;
    const form = await req.formData();
    // `content` is the Ask dialog's textarea, whose Unblock button posts here
    // (askDialogActionsHtml); the Unblock dialog's own box is `message`.
    const fromFeedbackBox = form.get('message') !== null;
    const message = String(form.get('message') ?? form.get('content') ?? '').trim();
    const dialog = wantsActionDialog(req);
    if (!message) {
      if (dialog) return json({ error: 'Feedback cannot be empty.' }, 400);
      return renderReviewPage(storage, actions, taskActions, resolved.task.id, {
        text: 'Feedback cannot be empty.',
        error: true,
      }, undefined, undefined, serveActions);
    }
    // SAVE FIRST. Everything below can fail — a status gate, a worktree lock,
    // a runner that will not start — and with JS off nothing has autosaved
    // these words yet. Persisting before attempting is what makes the refusal
    // recoverable instead of a blank textarea. CLAUDE.md: never lose human
    // feedback.
    //
    // Only the feedback box's own words go into its draft. Words sent from the
    // Ask box are not that draft, and overwriting it would erase feedback the
    // reviewer typed in the Unblock dialog; they are covered instead by the
    // recovery file actions.unblock writes before it attempts anything, and
    // by the dialog, which stays open with them on a refusal.
    if (fromFeedbackBox) await saveDraftQuietly(actions, resolved.task.id, { feedback: message });
    const raisedResolutions = parseRaisedResolutionsFromForm(form);
    // INVARIANT (approval-happens-at-accept — move-file-approval-to-accept):
    // no protected-file gate here. Unblock reverts nothing, so a pending
    // violation neither blocks this POST nor travels with it.
    const redirect = `${url.origin}${taskPath(resolved.task, await reviewDupCodes())}`;
    if (dialog) {
      return actionRunStarted(taskId, 'unblock', async (onProgress) => {
        await actions.unblock(
          taskId,
          message,
          raisedResolutions.length > 0 ? raisedResolutions : undefined,
          onProgress,
          { keepFeedbackDraft: !fromFeedbackBox },
        );
        return { redirect };
      });
    }
    try {
      await actions.unblock(
        resolved.task.id,
        message,
        raisedResolutions.length > 0 ? raisedResolutions : undefined,
        undefined,
        { keepFeedbackDraft: !fromFeedbackBox },
      );
    } catch (err) {
      return renderReviewPage(storage, actions, taskActions, resolved.task.id, {
        text: `Unblock failed: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      }, undefined, undefined, serveActions);
    }
    // The draft is cleared by the daemon on a delivered unblock, not here —
    // so a reviewer who types on this page and then unblocks from a terminal
    // gets the same result. src/daemon/task-lifecycle.ts.
    return Response.redirect(redirect, 303);
  }

  params = matchRoute(path, '/tasks/:id/review/accept');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    const taskId = resolved.task.id;
    const form = await req.formData();
    const reason = String(form.get('reason') ?? '').trim() || undefined;
    const dialog = wantsActionDialog(req);
    const approvedFiles = form.getAll('approved_files')
      .map((v) => String(v).trim())
      .filter(Boolean);
    // Everything the reviewer had typed, carried through every re-render below.
    const draft: ReviewDraft = {
      reason,
      feedback: String(form.get('feedback') ?? '') || undefined,
      ...(approvedFiles.length > 0 ? { approvedFiles } : {}),
    };
    // Present only when the reviewer is clearing a protection gate from the
    // page. It goes to the daemon and nowhere else — never into the draft,
    // never into a log line, never back into the rendered form.
    const passphrase = String(form.get('passphrase') ?? '') || undefined;
    // SAVE FIRST, same reason as unblock: the accept below may be refused, and
    // a reason typed with JS off has never been autosaved.
    await saveDraftQuietly(actions, resolved.task.id, {
      acceptReason: reason ?? '',
      ...(draft.feedback !== undefined ? { feedback: draft.feedback } : {}),
    });
    // Presentation only — acceptTaskPreflight enforces this too, but its advice
    // ("use --approve-file") is meaningless in a browser.
    const blocked = acceptBlockedByViolations(await taskFileViolations(storage, resolved.task.id));
    if (blocked) {
      if (dialog) return json({ error: blocked }, 409);
      return renderReviewPage(
        storage, actions, taskActions, resolved.task.id,
        { text: blocked, error: true }, draft, undefined,
        serveActions,
      );
    }
    const raisedResolutions = parseRaisedResolutionsFromForm(form);
    // The Accept dialog's explicit "merge without delivering the queued
    // comments" box — the web twin of `--allow-queued-comments`.
    const acceptOptions = { allowQueuedComments: form.get('allow_queued_comments') === '1' };
    const redirect = `${url.origin}${taskPath(resolved.task, await reviewDupCodes())}`;
    if (dialog) {
      return actionRunStarted(taskId, 'accept', async (onProgress) => {
        await actions.accept(
          taskId,
          reason,
          passphrase,
          raisedResolutions.length > 0 ? raisedResolutions : undefined,
          onProgress,
          approvedFiles.length > 0 ? approvedFiles : undefined,
          acceptOptions,
        );
        return { redirect };
      });
    }
    try {
      await actions.accept(
        resolved.task.id,
        reason,
        passphrase,
        raisedResolutions.length > 0 ? raisedResolutions : undefined,
        undefined,
        approvedFiles.length > 0 ? approvedFiles : undefined,
        acceptOptions,
      );
    } catch (err) {
      // The remedy is the daemon's, read straight off the error — this page
      // never reads the message to guess what went wrong. An error without one
      // still shows the daemon's words verbatim, as before.
      const remedy: AcceptRemedy | undefined = acceptRemedyOf(err);
      return renderReviewPage(
        storage,
        actions,
        taskActions,
        resolved.task.id,
        { text: `Accept failed: ${err instanceof Error ? err.message : String(err)}`, error: true },
        draft,
        remedy,
        serveActions,
      );
    }
    // Merged: the whole review is over. The daemon drops the draft record on a
    // non-refused accept, so `lazy accept` from a terminal clears it too.
    return Response.redirect(redirect, 303);
  }

  // The in-page half of a "sync first" remedy: same syncTask the CLI runs, so
  // the reviewer does not have to leave the page to clear a stale merge base.
  params = matchRoute(path, '/tasks/:id/review/sync');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    const taskId = resolved.task.id;
    const form = await req.formData();
    const dialog = wantsActionDialog(req);
    const draft: ReviewDraft = {
      reason: String(form.get('reason') ?? '') || undefined,
      feedback: String(form.get('feedback') ?? '') || undefined,
    };
    if (dialog) {
      return actionRunStarted(taskId, 'sync', async (onProgress) => {
        const result = await actions.sync(taskId, onProgress);
        const dest = `${url.origin}${taskPath({ id: taskId, code: resolved.task?.code ?? null }, await reviewDupCodes())}/review`;
        const withFlash = new URL(dest);
        withFlash.searchParams.set('flash', result.message ?? 'Sync started.');
        return { redirect: withFlash.toString() };
      });
    }
    try {
      const result = await actions.sync(resolved.task.id);
      return renderReviewPage(
        storage,
        actions,
        taskActions,
        resolved.task.id,
        { text: result.message ?? 'Sync started.' },
        draft,
      );
    } catch (err) {
      return renderReviewPage(
        storage,
        actions,
        taskActions,
        resolved.task.id,
        { text: `Sync failed: ${err instanceof Error ? err.message : String(err)}`, error: true },
        draft,
      );
    }
  }

  params = matchRoute(path, '/tasks/:id/review/violation');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    const form = await req.formData();
    const file = String(form.get('file') ?? '');
    const approved = String(form.get('approved') ?? '') === '1';
    if (!file) return json({ error: 'file is required' }, 400);
    // The island asks for JSON so it can patch the control without a reload;
    // a plain form POST gets the redirect.
    const asJson = (req.headers.get('accept') ?? '').includes('application/json');
    let violations;
    try {
      violations = await actions.setViolationDecision(resolved.task.id, file, approved);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (asJson) return json({ error: message }, 400);
      return renderReviewPage(storage, actions, taskActions, resolved.task.id, { text: message, error: true });
    }
    // The island posts this and patches the one control in place; without JS
    // the browser follows the redirect and re-renders the page with the new
    // state. Either way the decision is already durable.
    if (asJson) return json({ violations });
    return Response.redirect(`${url.origin}${taskPath(resolved.task, await reviewDupCodes())}/review`, 303);
  }

  // Undo a raised-item resolution whose comment has not been delivered yet.
  params = matchRoute(path, '/tasks/:id/review/raised/unresolve');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    const form = await req.formData();
    const id = String(form.get('id') ?? '').trim();
    if (!id) {
      return renderReviewPage(storage, actions, taskActions, resolved.task.id, {
        text: 'Raised item id is required.',
        error: true,
      });
    }
    try {
      await actions.unresolveRaisedItem(resolved.task.id, id);
    } catch (err) {
      return renderReviewPage(storage, actions, taskActions, resolved.task.id, {
        text: `Could not undo raised item: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      });
    }
    return Response.redirect(`${url.origin}${taskPath(resolved.task, await reviewDupCodes())}/review`, 303);
  }

  // Decide one raised item — respond / acknowledge / dismiss / promote — from
  // the review page. ONE route because it is one control (src/server/raised-decide.ts):
  // the Decide dropdown carries the action and promote carries its card's
  // goal/code alongside it, for a blocking item and a non-blocking one alike.
  // Durable immediately; a blocking item stops gating accept the moment it is
  // decided, and the comment stays pending until the next unblock or accept.
  params = matchRoute(path, '/tasks/:id/review/raised');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    const form = await req.formData();
    const parsed = parseRaisedDecisionForm(form);
    if ('error' in parsed) {
      return handleTaskDetail(
        storage,
        resolved.task.id,
        new URL(`http://dashboard.invalid/tasks/${resolved.task.id}/raised`),
        taskActions,
        actions,
        'raised',
        { text: parsed.error, error: true },
      );
    }
    const { decision } = parsed;
    try {
      if (decision.action === 'promote_subtask' || decision.action === 'promote_peer') {
        const result = await actions.promoteRaisedItem(resolved.task.id, decision.id, {
          goal: decision.goal,
          code: decision.code,
          relation: decision.action === 'promote_peer' ? 'peer' : 'subtask',
        });
        // Post-redirect-get like every other decision: a promote answered with
        // a rendered page would be re-POSTed by a browser refresh, and "the
        // store refuses a second promote" is an error message, not a design.
        // The new task's name is worth saying, so it rides the redirect and the
        // GET below turns it back into the same notice.
        const label = result.task.code ?? result.task.id.slice(0, 8);
        return Response.redirect(
          `${url.origin}${taskPath(resolved.task, await reviewDupCodes())}/review?promoted=${encodeURIComponent(label)}`,
          303,
        );
      }
      await actions.resolveRaisedItem(resolved.task.id, decision.id, {
        action: decision.action,
        ...(decision.response ? { response: decision.response } : {}),
      });
    } catch (err) {
      return handleTaskDetail(
        storage,
        resolved.task.id,
        new URL(`http://dashboard.invalid/tasks/${resolved.task.id}/raised`),
        taskActions,
        actions,
        'raised',
        {
          text: `Could not record the decision: ${err instanceof Error ? err.message : String(err)}`,
          error: true,
        },
      );
    }
    return Response.redirect(`${url.origin}${taskPath(resolved.task, await reviewDupCodes())}/raised`, 303);
  }

  // GET /review/:id is redirected at the top of this function (308). A
  // leftover handler here would never run and would reintroduce a second
  // review page.

  return html(errorHtml('Not Found', 'Page not found'), 404);
}

/**
 * Retired Review-with-builder routes.
 *
 * POST start/send answer 410 and never launch a builder. GET is an archive of
 * an existing `review-session.json` when one is there; no record → 410, so the
 * page cannot offer a working start.
 */
async function handleReviewSessionRoute(
  storage: Storage,
  req: Request,
  _url: URL,
  path: string,
): Promise<Response> {
  const wantsJson = path.startsWith('/api/');
  const gone = () =>
    wantsJson
      ? json({ error: REVIEW_WITH_BUILDER_GONE_MESSAGE }, 410)
      : html(errorHtml('Gone', REVIEW_WITH_BUILDER_GONE_MESSAGE), 410);

  let params = matchRoute(path, '/api/review/:id/session');
  if (params) {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return json({ error: 'Task not found' }, 404);
    const session = await storage.getReviewSessionByTaskId(resolved.task.id);
    if (!session) return gone();
    return json(reviewSessionPollJson(session, session.messages ?? []));
  }

  // Start and send used to compose a live builder turn. 410 even when a
  // stored session exists — continuing the chat is the loop we are closing.
  params = matchRoute(path, '/tasks/:id/review/session/start')
    ?? matchRoute(path, '/tasks/:id/review/session/send');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    return gone();
  }

  params = matchRoute(path, '/tasks/:id/review/session');
  if (params) {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    const session = await storage.getReviewSessionByTaskId(resolved.task.id);
    if (!session) return gone();
    return html(reviewSessionPageHtml(resolved.task, session, session.messages ?? []));
  }

  return wantsJson ? json({ error: 'Not found' }, 404) : html(errorHtml('Not Found', 'Page not found'), 404);
}

/**
 * Route the system-messages inbox.
 *
 * Split out for the same reason as the review routes: the mutating ones need
 * the daemon's action port. The asymmetry with review is deliberate — READING
 * the inbox is a plain storage read and works with no port at all, so a
 * Storage-only handler still shows the human what was filed for them; only the
 * two state changes answer 503. A message the human can see but not dismiss is
 * strictly better than one they cannot see.
 */
async function handleMessagesRoute(
  storage: Storage,
  actions: MessageActions | undefined,
  req: Request,
  url: URL,
  path: string,
): Promise<Response> {
  // The inbox listing as JSON. The INDEX only — bodies stay behind
  // `/messages/:id`, which is also where reading one marks it read.
  // The nav badge outgrew this route: it needs four counts, so it fetches
  // `/api/nav-counts` and this one is no longer on every page's critical path.
  if (path === '/api/messages') {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const includeDismissed = url.searchParams.get('all') === '1';
    const messages = await storage.listSystemMessages({ includeDismissed });
    return json({
      unread: unreadCount(messages),
      messages: messages.map(({ body: _body, ...rest }) => rest),
    });
  }

  if (path === '/messages') {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const allView = url.searchParams.get('all') === '1';
    const messages = await storage.listSystemMessages({ includeDismissed: allView });
    return html(messagesInboxHtml(messages, allView));
  }

  const actionMatch =
    matchRoute(path, '/messages/:id/read') ?? matchRoute(path, '/messages/:id/dismiss');
  const detailMatch = matchRoute(path, '/messages/:id');
  // Already decoded by matchRoute — decoding again would corrupt any id
  // containing a literal '%'.
  const id = actionMatch?.id ?? detailMatch?.id;
  if (!id) return html(errorHtml('Not Found', 'Page not found'), 404);

  if (!isValidMessageId(id)) {
    return html(
      errorHtml('Bad Request', `Invalid message id '${id}' — ids are hex UUIDs (or a unique prefix).`),
      400,
    );
  }

  let existing;
  try {
    existing = await storage.getSystemMessage(id);
  } catch (err) {
    // An ambiguous prefix — the store's own refusal, relayed verbatim.
    return html(errorHtml('Bad Request', err instanceof Error ? err.message : String(err)), 400);
  }
  if (!existing) {
    return html(errorHtml('Not Found', `No system message matches '${id}'.`), 404);
  }

  if (actionMatch) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!actions) {
      const msg =
        'Message actions are not available: this dashboard was started without a daemon action port.';
      return html(errorHtml('Unavailable', msg), 503);
    }
    const form = await req.formData();
    const allView = String(form.get('all') ?? '') === '1';
    const back = `${url.origin}/messages${allView ? '?all=1' : ''}`;
    try {
      if (path.endsWith('/read')) await actions.markRead(existing.id);
      else await actions.dismiss(existing.id);
    } catch (err) {
      const messages = await storage.listSystemMessages({ includeDismissed: allView });
      return html(
        messagesInboxHtml(messages, allView, {
          text: `Could not update the message: ${err instanceof Error ? err.message : String(err)}`,
          error: true,
        }),
      );
    }
    return Response.redirect(back, 303);
  }

  // Detail: reading the body IS the human seeing it, so this marks the message
  // read — the same rule `lazy messages read <id>` follows, and the reason the
  // UI needs no separate "I have seen this" click for a message it just showed
  // you. Idempotent in the store: the first read's timestamp never moves.
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!actions) {
    return html(
      messageDetailHtml(existing, {
        text: 'Read-only: this dashboard was started without a daemon action port, so this message was not marked read and cannot be dismissed here.',
        error: true,
      }, await scratchMentionsFor(storage, existing)),
    );
  }
  let message = existing;
  let notice: { text: string; error?: boolean } | undefined;
  try {
    message = await actions.markRead(existing.id);
  } catch (err) {
    // The body still renders — failing to record the read must not withhold the
    // message itself, which is the whole point of the page.
    notice = {
      text: `Shown, but could not record it as read: ${err instanceof Error ? err.message : String(err)}`,
      error: true,
    };
  }
  return html(messageDetailHtml(message, notice, await scratchMentionsFor(storage, message)));
}

/**
 * Cross-task raised-items listing — one triage queue for blocking and
 * non-blocking items alike, with decide and promote on the detail pages.
 *
 * Mutations go through {@link ReviewActions}; reads use Storage directly.
 */
async function handleRaisedRoute(
  storage: Storage,
  actions: ReviewActions | undefined,
  req: Request,
  url: URL,
  path: string,
  taskActions?: TaskActions,
  serveActions?: ServeActions,
): Promise<Response> {
  const showAll = url.searchParams.get('all') === '1';
  const state = showAll ? 'all' as const : 'open' as const;
  // Normalised to the values this page offers rather than carried raw: the
  // filter bar reflects them back into every link's href, and a query param is
  // reader-supplied input (see the task list's ?filter= injection fix).
  const gateParam = url.searchParams.get('gate');
  const blocking =
    gateParam === 'blocking' ? 'blocking' as const
    : gateParam === 'non-blocking' ? 'non-blocking' as const
    : 'all' as const;
  const status = url.searchParams.get('status') === 'complete-only' ? 'complete-only' as const : undefined;
  const recurringOnly = url.searchParams.get('recurring') === '1';
  // The order is the service's to apply — the page passes the reader's choice
  // through, and only ranks the columns listRaisedItems has no ordering for.
  const sort = parseRaisedSort(url.searchParams.get('sort'), { recurringOnly });
  // One view drives both what is asked for and what is rendered, so a link the
  // page emits and the listing it lands on cannot disagree.
  const view: RaisedView = { state, blocking, status, recurringOnly, sort };
  const listOptions = raisedListOptions(view);
  // Task links on this page read the task's code, falling back to the id when
  // the code is shared by more than one task.
  const raisedCodes = taskCodeTables(await storage.listTaskCodes());
  const raisedDup = raisedCodes.duplicated;

  // Detail, decide and flag-toggle all need the item by id, and the listing is
  // the only shape that carries its task's code and its recurrence — so they share
  // one uncollapsed read rather than each inventing a lookup.
  const loadAll = async () =>
    (await storage.listRaisedItems({ state: 'all', collapseExactDuplicates: false })).items;
  const findItem = (items: ListedRaisedItem[], id: string) =>
    items.find((i) => i.id === id || i.id.startsWith(id));

  const panelFor = async (item: ListedRaisedItem, allListed: ListedRaisedItem[], decideError?: string) => {
    const linkify: MarkdownLinkifyTable[] = [buildTaskCodeLinkify(await storage.listTaskCodes())];
    if (actions) {
      try {
        const diffText = await actions.getDiff(item.task_id);
        const files = parseUnifiedDiff(diffText);
        const symbols = buildSymbolTable(files, taskPathSegment({ id: item.task_id, code: item.task_code }, raisedDup));
        if (symbols.size > 0) linkify.push({ lookup: symbols, className: 'lz-sym-link' });
      } catch (err) {
        // Diff is optional for the dialog body: task-code links still work.
        logger.debug(`raised panel symbols for ${item.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return raisedPanelHtml(item, similarRaisedForDetail(item, allListed), {
      markdown: { linkify, hashLinkBase: taskPath({ id: item.task_id, code: item.task_code }, raisedDup) + '/changes' },
      taskCodes: raisedCodes,
      ...(decideError ? { decideError } : {}),
    });
  };

  const raisedTabPage = async (
    item: ListedRaisedItem,
    allListed: ListedRaisedItem[],
    decideError?: string,
  ) => {
    const panel = await panelFor(item, allListed, decideError);
    const tabUrl = new URL(`${url.origin}${taskPath({ id: item.task_id, code: item.task_code }, raisedDup)}/raised`);
    return handleTaskDetail(
      storage,
      item.task_id,
      tabUrl,
      taskActions,
      actions,
      'raised',
      decideError ? { text: decideError, error: true } : undefined,
      undefined,
      undefined,
      { openRaisedId: item.id, openRaisedPanel: panel, serveActions },
    );
  };

  const detailParams = matchRoute(path, '/raised/:id');
  const decideParams = matchRoute(path, '/raised/:id/decide');
  const blockingParams = matchRoute(path, '/raised/:id/blocking');

  if (decideParams || blockingParams) {
    const wanted = (decideParams ?? blockingParams)!.id;
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!actions) {
      const msg = 'Review actions are not available: this dashboard was started without a daemon action port.';
      return html(errorHtml('Unavailable', msg), 503);
    }
    const allListed = await loadAll();
    const item = findItem(allListed, wanted);
    if (!item) return html(errorHtml('Not Found', 'Raised item not found'), 404);
    const rerender = (message: string) => raisedTabPage(item, allListed, message);

    if (blockingParams) {
      // The flag is the human's to correct: an agent's judgement about whether
      // its question gates this task's own accept is a starting point, not the
      // last word (docs/design/raised-items-unified.md).
      const form = await req.formData();
      const next = String(form.get('blocking') ?? '').trim();
      if (next !== 'true' && next !== 'false') {
        return rerender('Choose whether this raised item gates accept.');
      }
      try {
        await actions.setRaisedItemBlocking(item.task_id, item.id, next === 'true');
      } catch (err) {
        return rerender(
          `Could not change the gate: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return Response.redirect(`${url.origin}/raised/${item.id}`, 303);
    }

    const form = await req.formData();
    // The id comes from the URL: the page is already scoped to one raised item,
    // and a form field disagreeing with the path would be a second answer to a
    // question the route already settled.
    const parsed = parseRaisedDecisionForm(form, { id: item.id });
    if ('error' in parsed) return rerender(parsed.error);
    const { decision } = parsed;
    try {
      if (decision.action === 'promote_subtask' || decision.action === 'promote_peer') {
        const result = await actions.promoteRaisedItem(item.task_id, item.id, {
          ...(decision.goal ? { goal: decision.goal } : {}),
          ...(decision.code ? { code: decision.code } : {}),
          relation: decision.action === 'promote_peer' ? 'peer' : 'subtask',
        });
        return Response.redirect(`${url.origin}${taskPath(result.task, raisedDup)}`, 303);
      }
      await actions.resolveRaisedItem(item.task_id, item.id, {
        action: decision.action,
        ...(decision.response ? { response: decision.response } : {}),
      });
      return Response.redirect(`${url.origin}${taskPath({ id: item.task_id, code: item.task_code }, raisedDup)}/raised`, 303);
    } catch (err) {
      return rerender(
        `Could not record the decision: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (detailParams) {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const wanted = detailParams.id.trim();
    if (!wanted) return html(errorHtml('Not Found', 'Raised item not found'), 404);
    const allListed = await loadAll();
    const item = findItem(allListed, wanted);
    if (!item) return html(errorHtml('Not Found', 'Raised item not found'), 404);
    if (url.searchParams.get('fragment') === '1') {
      return html(await panelFor(item, allListed));
    }
    return raisedTabPage(item, allListed);
  }

  if (path === '/api/raised') {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const result = await storage.listRaisedItems(listOptions);
    // Same ordering as the page, so a `?sort=` the JSON caller passes means what
    // it means in a browser rather than silently degrading to the default.
    const items = orderRaisedForDisplay(result.items, sort);
    return json({
      total: result.total,
      total_open_blocking: result.total_open_blocking,
      total_open_non_blocking: result.total_open_non_blocking,
      recurrences: result.recurrences.filter((c) => c.size > 1),
      items: items.map(({ content, ...rest }) => ({ ...rest, content_preview: content.slice(0, 200) })),
    });
  }

  if (path === '/raised') {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const result = await storage.listRaisedItems(listOptions);
    return html(raisedInboxHtml(result, { ...view, taskCodes: raisedCodes }));
  }

  return html(errorHtml('Not Found', 'Page not found'), 404);
}

/**
 * Route the builder scratch surface: the captured files, grouped by builder
 * session, one file rendered (or raw), and search within them. Every route is a
 * read from the store — never the live `$LAZY_SCRATCH_DIR` — and there is no
 * write: removal stays `lazy scratch rm`.
 */
async function handleScratchRoute(storage: Storage, req: Request, url: URL, path: string): Promise<Response> {
  if (req.method !== 'GET') {
    return path.startsWith('/api/')
      ? json({ error: 'Method not allowed' }, 405)
      : html(errorHtml('Method Not Allowed', 'This page is read-only.'), 405);
  }
  if (path === '/api/scratch') {
    return json({ groups: groupScratchBySession(await storage.listScratchFiles()) });
  }
  if (path === '/scratch/file') {
    const filePath = url.searchParams.get('path') ?? '';
    const file = filePath ? await storage.getScratchFile(filePath) : null;
    if (!file) {
      return html(errorHtml('Not Found', `No captured scratch file at '${filePath}'.`), 404);
    }
    const entry = { ...scratchEntry(file), content: file.skipped ? null : file.content };
    return html(scratchFileHtml(entry, url.searchParams.get('raw') === '1'));
  }
  if (path === '/scratch') {
    const query = (url.searchParams.get('q') ?? '').trim();
    if (!query) return html(scratchIndexHtml(groupScratchBySession(await storage.listScratchFiles())));
    try {
      return html(scratchSearchHtml(query, await searchScratch(storage, query)));
    } catch (err) {
      return html(scratchSearchHtml(query, [], err instanceof Error ? err.message : String(err)), 400);
    }
  }
  return html(errorHtml('Not Found', 'Page not found'), 404);
}

/**
 * Captured scratch paths a system message names — linked from its detail page.
 *
 * Best effort: the links are an extra, the message is the page. A scratch store
 * that cannot be read must not withhold the message body, so a failure is
 * logged and yields no links (Teams' message page makes the same call).
 */
async function scratchMentionsFor(storage: Storage, message: { id: string; title: string; body: string }): Promise<string[]> {
  try {
    const paths = (await storage.listScratchFiles()).map((f) => f.path);
    return scratchPathsMentionedIn(`${message.title}\n${message.body}`, paths);
  } catch (err) {
    logger.warn(
      `Could not read builder scratch to link paths in message ${message.id}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Route the builder-conversations surface.
 *
 * Every listing and transcript route is a read served straight from Storage.
 * The single mutation — POST /conversations/:id/promote, which turns a chosen
 * range of a transcript into a backlog task — goes through {@link ReviewActions}
 * like every other write the web layer performs, and answers 503 rather than
 * half-working when no port is wired.
 *
 * Listing and the JSON API use `listConversationSummaries()` — metadata only,
 * no transcript parse. Search still loads full transcripts because it matches
 * message bodies. The detail page loads one conversation by id (prefix
 * resolved against the summaries), not the whole store.
 */
async function handleConversationsRoute(
  storage: Storage,
  actions: ReviewActions | undefined,
  req: Request,
  url: URL,
  path: string,
): Promise<Response> {
  const wantsJson = path.startsWith('/api/');

  const promoteParams = matchRoute(path, '/conversations/:sessionId/promote');
  if (promoteParams) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!actions) {
      return html(
        errorHtml('Unavailable', 'This dashboard cannot create tasks — no daemon action port is wired.'),
        503,
      );
    }
    const sessionId = promoteParams.sessionId;
    const form = await req.formData();
    const field = (name: string): string | undefined => {
      const value = form.get(name);
      return typeof value === 'string' && value.trim() ? value : undefined;
    };
    const number = (name: string): number | undefined => {
      const raw = field(name);
      const parsed = raw != null ? Number(raw) : NaN;
      return Number.isSafeInteger(parsed) ? parsed : undefined;
    };
    const offset = number('offset') ?? 0;
    const from = number('from');
    const to = number('to');
    try {
      const result = await actions.promoteConversation(sessionId, {
        ...(from != null ? { from } : {}),
        ...(to != null ? { to } : {}),
        ...(field('goal') != null ? { goal: field('goal')! } : {}),
        ...(field('prompt') != null ? { prompt: field('prompt')! } : {}),
        ...(field('code') != null ? { code: field('code')! } : {}),
        ...(field('parent') != null ? { parent: field('parent')! } : {}),
      });
      // Post-redirect-get, like the discussion promote: a refresh must not try
      // to create the same task again. The selection is dropped on the way
      // back — the range it named is now a task. The created task's link
      // segment rides the query (code when unique, id otherwise) so the
      // banner links by name like every other task URL.
      const seg = taskPathSegment(result.task, duplicateTaskCodes(await storage.listTaskCodes()));
      const label = result.task.code ?? result.task.id.slice(0, 8);
      return Response.redirect(
        `${url.origin}/conversations/${encodeURIComponent(result.session_id)}` +
        `?offset=${offset}&promoted=${encodeURIComponent(label)}&promotedTask=${encodeURIComponent(seg)}`,
        303,
      );
    } catch (err) {
      // Re-render the transcript with the selection intact and the refusal on
      // top: the human's edited goal and prompt are still in the form they
      // came from, so nothing they typed is thrown away by a bad code.
      const message = err instanceof Error ? err.message : String(err);
      return await renderConversationDetail(storage, url, sessionId, offset, {
        from: from ?? null,
        to: to ?? null,
        error: message,
      });
    }
  }

  if (req.method !== 'GET') {
    return wantsJson
      ? json({ error: 'Method not allowed' }, 405)
      : html(errorHtml('Method Not Allowed', 'This page is read-only.'), 405);
  }

  if (path === '/api/conversations') {
    const summaries = await storage.listConversationSummaries();
    return json(conversationsApiPayload(summaries));
  }

  const detailParams = matchRoute(path, '/conversations/:sessionId');
  if (detailParams) {
    const requestedOffset = parseInt(url.searchParams.get('offset') ?? '0', 10);
    const selectedFrom = parseInt(url.searchParams.get('from') ?? '', 10);
    const selectedTo = parseInt(url.searchParams.get('to') ?? '', 10);
    return await renderConversationDetail(
      storage,
      url,
      detailParams.sessionId,
      Number.isFinite(requestedOffset) ? requestedOffset : 0,
      {
        from: Number.isSafeInteger(selectedFrom) ? selectedFrom : null,
        to: Number.isSafeInteger(selectedTo) ? selectedTo : null,
      },
    );
  }

  if (path === '/conversations') {
    const query = (url.searchParams.get('q') ?? '').trim();
    if (!query) {
      const summaries = await storage.listConversationSummaries();
      return html(conversationsIndexHtml(summaries));
    }
    const conversations = await storage.listConversations();
    const { hits, error } = await runConversationSearch(conversations, query);
    const byId = new Map(conversations.map((c) => [c.sessionId, c]));
    return html(conversationsSearchHtml(query, hits, byId, error), error ? 400 : 200);
  }

  return html(errorHtml('Not Found', 'Page not found'), 404);
}

/**
 * Render one conversation's transcript page, with whatever promote state the
 * request carries.
 *
 * Shared by the GET and by a FAILED promote, so a refusal comes back on the
 * same page with the same selection rather than as a bare error the human has
 * to navigate out of.
 *
 * The seed text is computed HERE, from the same module the daemon seeds the
 * task with: what a promoted task says is a rule, not something the browser
 * gets its own opinion about.
 */
async function renderConversationDetail(
  storage: Storage,
  url: URL,
  requestedId: string,
  requestedOffset: number,
  selection: { from: number | null; to: number | null; error?: string },
): Promise<Response> {
  const summaries = await storage.listConversationSummaries();
  const sessionId = resolveConversationSessionId(summaries, requestedId);
  const conv = sessionId ? await storage.loadConversation(sessionId) : null;
  if (!conv) {
    return html(
      errorHtml(
        'Not Found',
        'No builder conversation matches that id. If you used a short id, it may now match ' +
        'more than one conversation — open it from the list instead.',
      ),
      404,
    );
  }

  // Clamp rather than reject: an offset past the end is a stale link (the
  // transcript is append-only while capture runs), and landing on the last
  // page is a better answer than an error the human cannot act on.
  const raw = requestedOffset > 0 ? requestedOffset : 0;
  const maxOffset = Math.max(0, conv.messages.length - 1);
  const offset = Math.min(raw, maxOffset);
  const page = conv.messages.slice(offset, offset + MESSAGES_PER_PAGE);

  const tasks = await storage.listTasks();
  const promotions = conversationPromotions(tasks, conv.sessionId);

  // A selection out of range is treated as no selection: the page says how to
  // make one rather than refusing to render the transcript.
  let range: MessageRange | null = null;
  let seed: { goal: string; code: string; prompt: string } | null = null;
  if (selection.from != null) {
    try {
      range = resolveMessageRange(conv, { from: selection.from, to: selection.to ?? selection.from });
      const goal = defaultConversationGoal(conv, range);
      seed = {
        goal,
        code: defaultConversationCode(goal) ?? '',
        prompt: buildConversationTaskPrompt(conv, range),
      };
    } catch {
      // Deliberately swallowed: the only failure here is a range this
      // transcript does not have, and the page's own "pick a range"
      // instruction is the answer to it. The promote POST re-validates and
      // reports for real.
      range = null;
    }
  }

  const promotedLabel = url.searchParams.get('promoted');
  const promotedTask = url.searchParams.get('promotedTask');
  return html(conversationDetailHtml(conv, page, offset, {
    selection: range,
    seed,
    promotions,
    created: promotedLabel && promotedTask ? { id: promotedTask, label: promotedLabel } : null,
    error: selection.error ?? null,
  }, duplicateTaskCodes(await storage.listTaskCodes())));
}

const MEMORY_ACTIONS_UNAVAILABLE =
  'Memory actions are not available: this dashboard was started without a daemon action port.';

const DOCTOR_ACTIONS_UNAVAILABLE =
  'Doctor actions are not available: this dashboard was started without a daemon action port.';

const DOCTOR_DIALOG_HEADER = 'x-lazy-doctor-dialog';

/**
 * Settings: Memories (the existing listing) and Doctor (last report + run +
 * remedies). GET /settings/doctor is a file read — it never starts the sweep.
 */
async function handleSettingsRoute(
  storage: Storage,
  doctorActions: DoctorActions | undefined,
  req: Request,
  url: URL,
  path: string,
): Promise<Response> {
  // Settings itself is the Memories tab — a 302 to /settings/memory would
  // drop the dashboard Host rewrite on fetch-follow (401). Both URLs render
  // the same listing so the nav link and the tab permalink both 200.
  if (path === '/settings' || path === '/settings/' || path === '/settings/memory') {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const allView = url.searchParams.get('all') === '1';
    const warnBytes = await memoryWarnBytes();
    const records = await storage.listMemories({ includeDeleted: allView });
    const compact = await storage.getMemoryCompact();
    return html(memoryIndexHtml(records, compact, warnBytes, { allView }));
  }

  if (path === '/settings/doctor') {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    if (!doctorActions) return html(settingsDoctorHtml(null, { unavailable: true }));
    // Last snapshot only — a file read. The sweep is POST /settings/doctor/run.
    const stored = await doctorActions.report();
    return html(settingsDoctorHtml(stored));
  }

  if (path === '/settings/doctor/run') {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!doctorActions) return html(errorHtml('Unavailable', DOCTOR_ACTIONS_UNAVAILABLE), 503);
    return streamDoctorRun(doctorActions, wantsDoctorDialog(req));
  }

  const remedyMatch = matchRoute(path, '/settings/doctor/remedy/:flag');
  if (remedyMatch) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!doctorActions) return html(errorHtml('Unavailable', DOCTOR_ACTIONS_UNAVAILABLE), 503);
    if (!isDoctorRemedyFlag(remedyMatch.flag)) {
      return html(errorHtml('Bad Request', `Unknown doctor remedy '${remedyMatch.flag}'.`), 400);
    }
    const form = req.headers.get('content-type')?.includes('form')
      ? await req.formData()
      : null;
    const confirm = form ? formString(form, 'confirm') === '1' : false;
    return streamDoctorRemedy(doctorActions, remedyMatch.flag, confirm, wantsDoctorDialog(req));
  }

  return html(errorHtml('Not Found', 'Page not found'), 404);
}

function wantsDoctorDialog(req: Request): boolean {
  return req.headers.get(DOCTOR_DIALOG_HEADER) === '1';
}

function streamDoctorRun(actions: DoctorActions, asDialog: boolean): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      if (asDialog) {
        write(doctorDialogEventLine({ kind: 'step', label: 'Running health checks', state: 'start' }));
      } else {
        write(doctorStreamOpenHtml('Running doctor'));
        write(doctorProgressLineHtml({ label: 'Running health checks', state: 'start' }));
      }
      const heartbeat = setInterval(() => {
        write(asDialog ? doctorDialogEventLine({ kind: 'heartbeat' }) : '<!-- still running -->\n');
      }, 15_000);
      try {
        const report = await actions.run();
        if (asDialog) {
          write(doctorDialogEventLine({ kind: 'step', label: 'Running health checks', state: 'done' }));
          write(doctorDialogEventLine({ kind: 'report', report }));
        } else {
          write(doctorProgressLineHtml({ label: 'Running health checks', state: 'done' }));
          write(doctorStreamCloseHtml({}));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (asDialog) write(doctorDialogEventLine({ kind: 'error', message }));
        else write(doctorStreamCloseHtml({ error: message }));
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': asDialog ? 'application/x-ndjson; charset=utf-8' : 'text/html; charset=utf-8',
    },
  });
}

function streamDoctorRemedy(
  actions: DoctorActions,
  flag: DoctorRemedyFlag,
  confirm: boolean,
  asDialog: boolean,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      const asHtml = !asDialog;
      if (asHtml) write(doctorStreamOpenHtml(flag));
      const heartbeat = setInterval(() => {
        write(asDialog ? doctorDialogEventLine({ kind: 'heartbeat' }) : '<!-- still running -->\n');
      }, 15_000);
      try {
        // Destructive flags (and every first click) show the dry-run list.
        // Apply only after confirm=1, or immediately for a non-destructive
        // flag whose preview is empty (nothing to do — still show the preview).
        const preview = await actions.previewRemedy(flag);
        const mustConfirm = isDestructiveRemedy(flag) || !confirm;
        if (!confirm && (mustConfirm || preview.empty || !isDestructiveRemedy(flag))) {
          // First POST: always preview. Non-destructive flags with items still
          // apply on this first POST so "Run" means run — the list is in the
          // dialog as it happens. Destructive flags stop here.
          if (asDialog) {
            write(doctorDialogEventLine({ kind: 'preview', ...preview }));
            if (!preview.empty && !isDestructiveRemedy(flag)) {
              const result = await actions.applyRemedy(flag, (event) => {
                write(doctorDialogEventLine({ kind: 'step', ...event }));
              });
              write(doctorDialogEventLine({ kind: 'result', result }));
            }
          } else if (!preview.empty && !isDestructiveRemedy(flag)) {
            const result = await actions.applyRemedy(flag, (event) => {
              write(doctorProgressLineHtml(event));
            });
            write(doctorStreamCloseHtml({ result }));
          } else {
            write(doctorStreamCloseHtml({ preview }));
          }
          return;
        }
        const result = await actions.applyRemedy(flag, (event) => {
          if (asDialog) write(doctorDialogEventLine({ kind: 'step', ...event }));
          else write(doctorProgressLineHtml(event));
        });
        if (asDialog) write(doctorDialogEventLine({ kind: 'result', result }));
        else write(doctorStreamCloseHtml({ result }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (asDialog) write(doctorDialogEventLine({ kind: 'error', message }));
        else write(doctorStreamCloseHtml({ error: message }));
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': asDialog ? 'application/x-ndjson; charset=utf-8' : 'text/html; charset=utf-8',
    },
  });
}

async function memoryWarnBytes(): Promise<number> {
  try {
    const root = findLazyRoot();
    if (!root) return DEFAULT_MEMORY_WARN_BYTES;
    const config = await loadConfig(root);
    return config.memory.warn_bytes;
  } catch {
    return DEFAULT_MEMORY_WARN_BYTES;
  }
}

function parseCompactMode(raw: string): CompactMode {
  if (raw === 'mechanical' || raw === 'llm' || raw === 'auto') return raw;
  return 'auto';
}

/**
 * Route the shared-memory surface.
 *
 * Reads (list, show, compact --show, JSON) go through Storage. Writes
 * (save, remove, compact, clear) go through MemoryActions so authoring
 * validation and the LLM oneshot stay in the daemon. Compact POST returns a
 * streaming Response immediately: the first HTML is the progress log, which
 * both narrates the LLM wait and keeps Bun.serve's idle timer from reaping
 * the connection.
 */
async function handleMemoryRoute(
  storage: Storage,
  actions: MemoryActions | undefined,
  req: Request,
  url: URL,
  path: string,
): Promise<Response> {
  const allView = url.searchParams.get('all') === '1';
  const warnBytes = await memoryWarnBytes();

  if (path === '/api/memory') {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const records = await storage.listMemories({ includeDeleted: allView });
    return json(memoryApiPayload(records));
  }

  // --- compact (reserved path, before :name) ---
  if (path === '/memory/compact/clear') {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!actions) return html(errorHtml('Unavailable', MEMORY_ACTIONS_UNAVAILABLE), 503);
    const cleared = await actions.clearCompact();
    const records = await storage.listMemories();
    const compact = await storage.getMemoryCompact();
    return html(memoryCompactHtml(records, compact, warnBytes, {
      notice: {
        text: cleared
          ? 'Cleared the memory compact. Injection falls back to the full index.'
          : 'No memory compact to clear. Injection is already using the full index.',
      },
    }));
  }

  if (path === '/memory/compact') {
    if (req.method === 'GET') {
      const records = await storage.listMemories();
      const compact = await storage.getMemoryCompact();
      return html(memoryCompactHtml(records, compact, warnBytes));
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!actions) return html(errorHtml('Unavailable', MEMORY_ACTIONS_UNAVAILABLE), 503);
    const form = await req.formData();
    const mode = parseCompactMode(formString(form, 'mode'));
    const model = formString(form, 'model').trim() || undefined;
    return streamMemoryCompact(storage, actions, warnBytes, mode, model);
  }

  if (path === '/memory/new') {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return html(memoryNewHtml());
  }

  // POST /memory — create
  if (path === '/memory' && req.method === 'POST') {
    if (!actions) return html(errorHtml('Unavailable', MEMORY_ACTIONS_UNAVAILABLE), 503);
    const form = await req.formData();
    const input = {
      name: formString(form, 'name'),
      type: formString(form, 'type'),
      description: formString(form, 'description'),
      body: formString(form, 'body'),
    };
    try {
      const record = await actions.save(input);
      return Response.redirect(`${url.origin}${recordHrefPath(record.name)}`, 303);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return html(memoryNewHtml({ ...input, error: message }), 400);
    }
  }

  if (path === '/memory') {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return Response.redirect(`${requestOrigin(req, url)}/settings/memory${url.search}`, 308);
  }

  const removeMatch = matchRoute(path, '/memory/:name/remove');
  const detailMatch = matchRoute(path, '/memory/:name');
  // Already decoded by matchRoute.
  const matchedName = removeMatch?.name ?? detailMatch?.name;
  if (!matchedName) return html(errorHtml('Not Found', 'Page not found'), 404);

  let name: string;
  try {
    name = normalizeMemoryName(matchedName);
  } catch (err) {
    return html(errorHtml('Bad Request', err instanceof Error ? err.message : String(err)), 400);
  }

  const record = await storage.getMemory(name);

  if (removeMatch) {
    if (!record) return html(errorHtml('Not Found', `No memory record named '${name}'.`), 404);
    if (req.method === 'GET') return html(memoryRemoveConfirmHtml(record));
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!actions) return html(errorHtml('Unavailable', MEMORY_ACTIONS_UNAVAILABLE), 503);
    try {
      await actions.remove(name);
    } catch (err) {
      const events = await storage.getMemoryHistory(name);
      return html(memoryShowHtml(record, events, {
        text: `Could not remove the record: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      }));
    }
    return Response.redirect(`${requestOrigin(req, url)}/settings/memory`, 303);
  }

  // POST /memory/:name — update
  if (req.method === 'POST') {
    if (!actions) return html(errorHtml('Unavailable', MEMORY_ACTIONS_UNAVAILABLE), 503);
    const form = await req.formData();
    const input = {
      name,
      type: formString(form, 'type'),
      description: formString(form, 'description'),
      body: formString(form, 'body'),
    };
    try {
      const saved = await actions.save(input);
      return Response.redirect(`${url.origin}${recordHrefPath(saved.name)}`, 303);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const events = await storage.getMemoryHistory(name);
      if (record) {
        return html(memoryShowHtml({ ...record, ...input, type: record.type }, events, {
          text: message,
          error: true,
        }), 400);
      }
      return html(memoryNewHtml({ ...input, error: message }), 400);
    }
  }

  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!record) return html(errorHtml('Not Found', `No memory record named '${name}'.`), 404);
  const events = await storage.getMemoryHistory(name);
  return html(memoryShowHtml(record, events));
}

function recordHrefPath(name: string): string {
  return `/memory/${encodeURIComponent(name)}`;
}

/**
 * Stream compact progress as HTML. Returning a Response immediately is load
 * bearing: it satisfies the web-request deadline (a GET-bounding mechanism that
 * must not kill an LLM oneshot) and the first chunk announces the work before
 * the model is called.
 */
function streamMemoryCompact(
  storage: Storage,
  actions: MemoryActions,
  warnBytes: number,
  mode: CompactMode,
  model: string | undefined,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const write = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      write(memoryCompactStreamOpenHtml());
      // Keep Bun.serve's idle timer from reaping the connection while the
      // oneshot sits on the model: HTML comments are invisible and 15s is the
      // same interval the event feed uses (an 8x margin on the 120s idleTimeout).
      const heartbeat = setInterval(() => write('<!-- still compacting -->\n'), 15_000);
      try {
        const result = await actions.compact({ mode, model }, (event) => {
          write(memoryCompactProgressLineHtml(event));
        });
        const records = await storage.listMemories();
        const compact = await storage.getMemoryCompact();
        write(memoryCompactStreamResultHtml(records, compact, warnBytes, result));
      } catch (err) {
        write(memoryCompactStreamErrorHtml(err instanceof Error ? err.message : String(err)));
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** Load [[automation.maintain]] for the review presentation renderer. Never throws. */
async function maintainPathMatcher(): Promise<(path: string) => boolean> {
  try {
    const root = findLazyRoot();
    if (!root) return () => false;
    const config = await loadConfig(root);
    const entries = config.automation.maintain;
    if (!entries.length) return () => false;
    return (path: string) => pathMatchesAnyMaintainPattern(path, entries);
  } catch {
    return () => false;
  }
}

/**
 * Patch the review draft without letting a draft problem take down the action
 * the reviewer actually asked for.
 *
 * Ordering matters more than the return value here: the save is awaited (so
 * "save first, act second" is real), but a failure to persist a DRAFT must not
 * turn a successful unblock into an error page, nor stop an unblock from being
 * attempted at all. It is logged loudly instead — the draft is a safety net for
 * the action, not a precondition of it.
 */
async function saveDraftQuietly(
  actions: ReviewActions,
  taskId: string,
  patch: ReviewDraftPatch,
): Promise<void> {
  try {
    await actions.saveDraft(taskId, LOCAL_REVIEWER, patch);
  } catch (err) {
    logger.error(
      `Could not save the review draft for task ${taskId.substring(0, 8)}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function renderReviewPage(
  storage: Storage,
  actions: ReviewActions,
  /** Task-level port — the Services card's Start container button needs it. */
  taskActions: TaskActions | undefined,
  taskId: string,
  notice?: { text: string; error?: boolean },
  /** Text the reviewer had typed, re-rendered into the boxes it came from. */
  draft?: ReviewDraft,
  /** The daemon's remedy for a refused accept, rendered as offered actions. */
  remedy?: AcceptRemedy,
  /** Designate Start services — project-wide lazy.toml write port. */
  serveActions?: ServeActions,
): Promise<Response> {
  const timings = new RenderTimings('/review/:id');
  const resolved = await timings.measure('storage.resolve', () => storage.resolveTask(taskId));
  if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);

  const comments = await timings.measure('storage.comments', () => actions.listComments(resolved.task!.id));
  let diffText = '';
  let diffNotice = notice;
  const diffPhase = timings.begin('diff');
  try {
    diffText = await actions.getDiff(resolved.task.id);
  } catch (err) {
    // A missing worktree or absent session must not blank the page — the
    // comment threads are the durable record and still have to render.
    diffNotice = diffNotice ?? {
      text: `Could not load the diff: ${err instanceof Error ? err.message : String(err)}`,
      error: true,
    };
  } finally {
    // Ended in `finally` so a failed diff is still measured: "the diff took 40s
    // and then threw" is exactly the kind of thing this instrumentation exists
    // to make visible.
    diffPhase.end();
  }
  timings.count('diff_bytes', Buffer.byteLength(diffText, 'utf8'));
  const state = await timings.measure('storage.state', () => reviewLiveState(storage, resolved.task!));
  const violations = await timings.measure('storage.violations', () => taskFileViolations(storage, resolved.task!.id));
  // Report-first extras: raised items (blocking and not), last agent turn.
  // Loaded from Storage (read-only) so a Storage-only handler still shows them.
  const [raisedItems, lastAgentTurn, fileDecisions] = await timings.measure('storage.extras', () => Promise.all([
    storage.getTaskRaisedItems(resolved.task!.id).then((items) => withPromotedTaskCodes(items, (id) => storage.getTask(id))),
    loadLastAgentTurn(storage, resolved.task!.id),
    storage.getTaskFileDecisions(resolved.task!.id),
  ]));
  const reportPhase = timings.begin('storage.report');
  const turnReport = lastAgentTurn?.session_id
    ? await storage.getTurnReportBySession(resolved.task.id, lastAgentTurn.session_id)
    : null;
  // Prefer session from the live session record when the turn lacks session_id
  // (older turns) — fall back via the task session.
  let report = turnReport;
  if (!report) {
    const session = await storage.getSessionByTaskId(resolved.task.id);
    if (session) {
      report = await storage.getTurnReportBySession(resolved.task.id, session.id);
    }
  }
  reportPhase.end();
  // Markdown files are rendered as documents, which needs their full text —
  // read here, through the same port the expand controls use, because the page
  // renderer is synchronous.
  //
  // The parse is measured on its own rather than folded into the read: this is
  // the FIRST of two parses of the same diff text (reviewTaskHtml does it again
  // as `render.diff_parse`), and the header is where that shows up.
  const diffFiles = timings.measureSync('diff_parse', () => parseUnifiedDiff(diffText));
  timings.count('diff_files', diffFiles.length);
  const markdownSources = await timings.measure('markdown_sources', () => loadMarkdownSources(diffFiles, (query) =>
    actions.getFileLines(resolved.task!.id, query),
  ));
  const isMaintainedPath = await timings.measure('maintain_matcher', () => maintainPathMatcher());

  // The review in progress: what this reviewer had typed and ticked, whether
  // they were last here in this tab, another one, or another browser. The
  // `draft` argument is the failing-POST case and wins where it has a value —
  // it is what the reviewer just submitted, so it is never older than the
  // stored copy.
  let stored: ReviewDraftState | null = null;
  const draftPhase = timings.begin('storage.draft');
  try {
    stored = await actions.getDraft(resolved.task.id, LOCAL_REVIEWER);
  } catch (err) {
    // A draft that cannot be read must not blank the page: the diff and the
    // threads are the durable record and still have to render.
    logger.error(
      `Could not load the review draft for task ${resolved.task.id.substring(0, 8)}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    draftPhase.end();
  }
  const effectiveDraft: ReviewDraft = {
    feedback: draft?.feedback ?? (stored?.feedback || undefined),
    reason: draft?.reason ?? (stored?.accept_reason || undefined),
  };

  const reviewSession = await timings.measure('storage.session', () => storage.getSessionByTaskId(resolved.task!.id));
  const serve = await timings.measure('serve', () => serveStateForTask(resolved.task!, reviewSession));
  const shell = await timings.measure('shell', () => shellAvailabilityForTask(resolved.task!, reviewSession));
  const controls = await timings.measure('controls', () => containerControlsForTask(resolved.task!, serve, shell, taskActions, serveActions));
  const activity = await timings.measure('storage.activity', () => loadReviewActivity(storage, resolved.task!.id, reviewSession, { raisedItems }));
  const hubChildren = classifyHubChildren(
    await timings.measure('storage.children', () => storage.getChildTasks(resolved.task!.id)),
  );
  timings.count('children', hubChildren.accepted.length + hubChildren.inProgress.length);

  timings.count('turns', state.turns);
  timings.count('comments', comments.length);
  timings.count('raised', raisedItems.length);
  // Error re-renders land on the Current review tab of the merged page.
  return handleTaskDetail(
    storage,
    resolved.task.id,
    new URL(`http://dashboard.invalid/tasks/${resolved.task.id}/review`),
    taskActions,
    actions,
    'review',
    diffNotice,
    effectiveDraft,
    remedy,
    { serveActions },
  );
}

/**
 * The "since you last looked" window for a task, or null when it has no session
 * (nothing has happened yet, so there is nothing to summarize).
 *
 * Loads only what the card lists. The caller passes the raised items it has
 * already read so the page does not fetch them twice.
 */
async function loadReviewActivity(
  storage: Storage,
  taskId: string,
  session: Session | null,
  loaded: { raisedItems: RaisedItem[] },
): Promise<ReviewActivity | null> {
  if (!session) return null;
  const [turns, commits, comments, journal] = await Promise.all([
    storage.getSessionTurns(session.id),
    storage.getSessionCommits(session.id),
    storage.getTaskComments(taskId),
    storage.getTaskJournal(taskId),
  ]);
  return computeReviewActivity({
    turns,
    commits,
    comments,
    journal,
    raisedItems: loaded.raisedItems,
  });
}

/** Last agent turn for the report-first review surface, or null. */
async function loadLastAgentTurn(storage: Storage, taskId: string) {
  const session = await storage.getSessionByTaskId(taskId);
  if (!session) return null;
  const turns = await storage.getSessionTurns(session.id);
  // The agent's own account of the work, not whatever spoke last: a parked
  // task's newest agent turn is routinely the presentation step's reply. See
  // latestAgentWorkTurn.
  return latestAgentWorkTurn(turns);
}

/**
 * The file permission violations the review page shows.
 *
 * INVARIANT (the page shows what ACCEPT will ask — move-file-approval-to-accept):
 * this is the whole-branch outstanding set from `resolveOutstandingViolations`,
 * the same resolver the accept gate calls, plus the files already approved so
 * the summary can show them as decided. Reading one turn's record instead
 * (`latestViolationTurn`) showed "nothing owed" for a task whose earlier turn
 * had an unapproved protected edit still in the diff — the reviewer then had no
 * way to know accept was about to merge it, or, after the newest record
 * replaced the older one, was refused on a file the page never listed.
 *
 * A task with no session (never started) has nothing to report rather than
 * failing the page.
 */
async function taskFileViolations(storage: Storage, taskId: string): Promise<FileViolation[]> {
  const resolved = await storage.resolveTask(taskId);
  const session = await storage.getSessionByTaskId(taskId);
  if (!session || !resolved.task) return [];
  const turns = await storage.getSessionTurns(session.id);
  const root = findLazyRoot();
  if (!root) return outstandingFromRecords(turns);
  const state = await resolveOutstandingViolations(root, resolved.task, session, turns, storage);
  return [
    ...state.outstanding,
    ...state.approved.map((file) => ({
      file,
      base_sha: violationRecordsByFile(turns).get(file)?.base_sha ?? '',
      status: 'approved' as const,
    })),
  ];
}

/**
 * Live state for the review page's sticky status bar.
 *
 * Turn count and last activity come from the session rather than the task,
 * because those are what tell a reviewer whether the agent is still moving.
 * A task with no session yet (never started) reports zero turns and no
 * activity rather than failing the page.
 */
async function reviewLiveState(storage: Storage, task: Task): Promise<ReviewLiveState> {
  const [session, turns] = await Promise.all([
    storage.getSessionByTaskId(task.id),
    storage.getTurnCountByTaskId(task.id),
  ]);
  // One rule for live-vs-record, shared with the daemon (resolveAskAvailability).
  // The worktree is deliberately NOT stat-ed from a page render: see AskContext.
  const availability = resolveAskAvailability({
    status: task.status,
    liveSession: !!session && !session.ended_at,
    resumableAgentSession: !!session?.agent_session_id,
    worktreeExists: true,
    hasRecord: turns > 0,
  });
  return {
    status: task.status,
    turns,
    lastActiveAt: session ? (session.last_interaction_at ?? session.started_at) : null,
    askable: availability.unavailable === null,
    askUnavailable: availability.unavailable,
    askRoute: availability.route,
    askProvenance: availability.provenance,
    unblockUnavailable: unblockUnavailableReason(task.status),
  };
}

/**
 * Try to bind an HTTP server to a TCP port with auto-increment on conflict.
 * Returns the server instance, or null if all ports were exhausted.
 *
 * `hostname` is the network interface to bind to. It defaults to loopback
 * ('127.0.0.1') so the daemon's unauthenticated dashboard and the /mcp + /rpc
 * endpoints are NOT reachable from other machines. Callers wanting LAN/remote
 * access must pass an explicit interface (e.g. '0.0.0.0').
 */
export function tryBindTcpPort(
  port: number,
  handler: (req: Request, server: ReturnType<typeof Bun.serve>) => Promise<Response>,
  maxAttempts: number = MAX_PORT_ATTEMPTS,
  hostname: string = '127.0.0.1',
  websocket?: WebSocketUpgrader,
): { server: ReturnType<typeof Bun.serve>; lastError: unknown } | null {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tryPort = port + attempt;
    try {
      // Bun passes the Server handle as the second argument. It is only needed
      // to perform a WebSocket upgrade; when an upgrader is wired, it gets first
      // refusal on every request and returns 'upgraded' (so fetch returns
      // undefined) when it has upgraded the connection. The `websocket` handler
      // key must be OMITTED, not set to undefined, when no upgrader is present —
      // Bun's serve types reject `websocket: undefined` alongside a fetch that
      // may return undefined.
      // The daemon-wide ceiling. Long /rpc and /mcp calls are kept alive by the
      // heartbeat envelope, not by this value — see src/daemon/heartbeat.ts.
      // The `websocket` handler key must be OMITTED, not set to undefined, when
      // no upgrader is present: Bun's serve types only permit a fetch that
      // returns undefined alongside a websocket handler.
      const server = websocket
        ? Bun.serve({
            hostname,
            port: tryPort,
            fetch: async (req, srv) => {
              const outcome = await websocket.tryUpgrade(req, srv);
              if (outcome === 'upgraded') return undefined;
              if (outcome) return outcome;
              return handler(req, srv);
            },
            websocket: websocket.handler,
            idleTimeout: DAEMON_IDLE_TIMEOUT_S,
          })
        : Bun.serve({
            hostname,
            port: tryPort,
            fetch: (req, srv) => handler(req, srv),
            idleTimeout: DAEMON_IDLE_TIMEOUT_S,
          });
      if (tryPort !== port) {
        logger.info(`Port ${port} was busy, using port ${tryPort} instead`);
      }
      return { server, lastError: null };
    } catch (err) {
      lastError = err;
      const isAddrInUse =
        err instanceof Error &&
        (('code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') ||
         err.message.includes('EADDRINUSE'));
      if (!isAddrInUse) {
        throw err;
      }
      // EADDRINUSE — try next port
    }
  }

  return null;
}
