/**
 * Lazy HTTP server
 *
 * Serves a read-only HTML dashboard for lazy tasks, sessions, and search.
 * Uses Bun's built-in HTTP server with no additional dependencies.
 */

import type { Storage, Task, Session, StatusChange } from '../storage';
import { getCommitDiff } from '../git/operations';
import { logger } from '../utils/logger';

import {
  taskListHtml,
  taskDetailHtml,
  searchResultsHtml,
  errorHtml,
  commitDetailHtml,
  turnDetailHtml,
  promptVersionHtml,
  dashboardHtml,
  totalInputTokens,
} from './templates';
import type { DashboardStats, TaskWithSession, ChartDataPoint, ActiveTaskInfo, ActivityDay, ActiveStates } from './templates';
import { reviewQueueHtml, reviewTaskHtml, threadsJson, type ReviewDraft, type ReviewLiveState } from './review';
import { acceptRemedyOf, type AcceptRemedy } from '../types';
import { askUnavailableReason, acceptBlockedByViolations, type ReviewActions } from './review-actions';
import { STYLESHEET_PATH, bundledStylesheet, stylesheetFromDisk } from './styles';
import { taskRefFromId } from '../cli/helpers';
import { parentTaskIdOf } from '../task-target';
import { MAX_PORT_ATTEMPTS } from '../config/constants';
import { DAEMON_IDLE_TIMEOUT_S, WEB_REQUEST_DEADLINE_MS } from '../daemon/heartbeat';
import { turnText } from '../utils/turn-content';
import { latestViolationTurn } from '../utils/turns';
import type { FileViolation } from '../types';
import { findLazyRoot } from '../cli/init';
import { loadConfig } from '../config/loader';
import {
  loadProtectionContext,
  contextIsInert,
  protectionStatusForTask,
  type TaskProtectionStatus,
} from '../protection/status';

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

function html(content: string, status: number = 200): Response {
  return new Response(content, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type SortField = 'status' | 'agent' | 'model' | 'turns' | 'last_active' | 'duration' | 'tokens' | 'goal' | 'created';
type SortDirection = 'asc' | 'desc';

interface SortConfig {
  field: SortField;
  direction: SortDirection;
}

function parseSortParam(sort: string | null, filter: string): SortConfig {
  // Default: blocked filter sorts by last_active DESC, others by created DESC
  if (!sort) {
    return (filter === 'blocked' || filter === 'conflict')
      ? { field: 'last_active', direction: 'desc' }
      : { field: 'created', direction: 'desc' };
  }

  const desc = sort.startsWith('-');
  const fieldName = desc ? sort.slice(1) : sort;
  const validFields: SortField[] = ['status', 'agent', 'model', 'last_active', 'duration', 'tokens', 'goal', 'created'];

  if (!validFields.includes(fieldName as SortField)) {
    return { field: 'created', direction: 'desc' };
  }

  return { field: fieldName as SortField, direction: desc ? 'desc' : 'asc' };
}

function sortTasks(
  tasksWithSessions: { task: Task; session: Session | null; turnCount?: number }[],
  sortConfig: SortConfig,
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

/**
 * Build daily throughput chart data from per-task status changelogs and timestamps.
 *
 * Data points:
 * - backlog: snapshot of backlog size at end of day (tasks in backlog status)
 * - completed: count of tasks accepted that day
 * - closed: count of tasks abandoned that day
 */
function buildChartData(
  allTasks: Task[],
  statusHistories: Map<string, StatusChange[]>,
): ChartDataPoint[] {
  const now = Date.now();
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000;
  const dailyMap = new Map<string, ChartDataPoint>();

  // Initialize last 14 days with zero counts
  const msPerDay = 24 * 60 * 60 * 1000;
  const startDay = new Date(fourteenDaysAgo);
  startDay.setUTCHours(0, 0, 0, 0);

  for (let t = startDay.getTime(); t <= now; t += msPerDay) {
    const dateStr = toUTCDateString(t);
    dailyMap.set(dateStr, {
      date: dateStr,
      backlog: 0,
      completed: 0,
      closed: 0,
    });
  }

  // For each day, compute backlog snapshot and daily deltas
  for (let t = startDay.getTime(); t <= now; t += msPerDay) {
    const endOfDay = t + msPerDay - 1;
    const dateStr = toUTCDateString(t);
    const point = dailyMap.get(dateStr)!;

    for (const task of allTasks) {
      // Task didn't exist yet at end of this day
      if (task.created_at > endOfDay) continue;

      // Replay status changelog to determine status at end-of-day
      const changes = statusHistories.get(task.id) ?? [];
      let statusAtEndOfDay = 'backlog';
      for (const change of changes) {
        if (change.timestamp <= endOfDay) {
          statusAtEndOfDay = change.status;
        } else {
          break; // Changes are chronological
        }
      }

      // Count backlog snapshot
      if (statusAtEndOfDay === 'backlog') {
        point.backlog++;
      }

      // Count daily deltas for completed/closed
      if (task.completed_at) {
        const completedDate = toUTCDateString(task.completed_at);
        if (completedDate === dateStr) {
          if (task.status === 'complete') {
            point.completed++;
          } else if (task.status === 'abandoned') {
            point.closed++;
          }
        }
      }
    }
  }

  // Convert map to array and sort by date
  const points = Array.from(dailyMap.values());
  points.sort((a, b) => a.date.localeCompare(b.date));
  return points;
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

async function handleDashboard(storage: Storage): Promise<Response> {
  // Fetch all tasks for aggregate stats
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
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalDurationMs = 0;

  for (const { task, session } of allWithSessions) {
    switch (task.status) {
      case 'working': workingCount++; break;
      case 'blocked': blockedCount++; break;
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

  const stats: DashboardStats = {
    totalTasks: allTasks.length,
    workingCount,
    blockedCount,
    interruptedCount,
    completedCount,
    totalTokensIn,
    totalTokensOut,
    totalDurationMs,
    recentlyCreatedTasks,
    activeTasks,
    blockedTasks,
    chartData,
    activityData,
    activeStates,
  };

  return html(dashboardHtml(stats));
}

async function handleTaskList(storage: Storage, url: URL): Promise<Response> {
  const filter = url.searchParams.get('filter') ?? '';
  const sortParam = url.searchParams.get('sort');
  const sortConfig = parseSortParam(sortParam, filter);

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
    case 'merging':
      tasks = await storage.listTasksWithOptions({ mergingOnly: true });
      break;
    default:
      tasks = await storage.listTasksWithOptions({ nonTerminalOnly: true });
      break;
  }

  // Fetch sessions and turn counts for each task
  const tasksWithSessions = await Promise.all(
    tasks.map(async (task) => ({
      task,
      session: await storage.getSessionByTaskId(task.id),
      turnCount: await storage.getTurnCountByTaskId(task.id),
    }))
  );

  // Sort tasks
  sortTasks(tasksWithSessions, sortConfig);

  const protection = await protectionForTasks(storage, tasks);
  for (const node of tasksWithSessions) {
    const status = protection.get(node.task.id);
    if (status) (node as TaskWithSession).protection = status;
  }

  return html(taskListHtml(tasksWithSessions, filter, sortConfig.field, sortConfig.direction));
}

async function handleTaskDetail(storage: Storage, taskId: string): Promise<Response> {
  const task = await storage.getTask(taskId);
  if (!task) {
    return html(errorHtml('Not Found', `Task not found: ${taskId}`), 404);
  }

  const session = await storage.getSessionByTaskId(task.id);
  const turns = session ? await storage.getSessionTurns(session.id) : [];
  const commits = session ? await storage.getSessionCommits(session.id) : [];
  const comments = await storage.getTaskComments(task.id);
  const journal = await storage.getTaskJournal(task.id);
  const followUps = await storage.getTaskFollowUps(task.id);
  const children = await storage.getChildTasks(task.id);
  const promptVersions = await storage.getPromptHistory(task.id);
  const parentId = parentTaskIdOf(task);
  const parentTask = parentId ? await storage.getTask(parentId) : null;

  const protection = (await protectionForTasks(storage, [task])).get(task.id) ?? null;
  // The base branch used to live only on the deleted /pr page; it is the one
  // thing that page showed which this one did not, so it moves here.
  const baseBranch = parentId ? 'lazy/' + await taskRefFromId(parentId, storage) : 'main';

  return html(taskDetailHtml(task, session, turns, commits, comments, journal, followUps, children, promptVersions, parentTask, protection, baseBranch));
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

  return html(commitDetailHtml(task, commit, diffText));
}

async function handleTurnDetail(storage: Storage, taskId: string, turnSequence: number): Promise<Response> {
  const task = await storage.getTask(taskId);
  if (!task) {
    return html(errorHtml('Not Found', `Task not found: ${taskId}`), 404);
  }

  const session = await storage.getSessionByTaskId(task.id);
  if (!session) {
    return html(errorHtml('Not Found', 'Task has no session'), 404);
  }

  const allTurns = await storage.getSessionTurns(session.id);

  // Turns are numbered by sequence. A "turn" in the UI sense is a
  // human-agent pair. We look for the human turn at this sequence
  // and the corresponding agent turn.
  const humanTurn = allTurns.find(t => t.sequence === turnSequence && t.role === 'human') ?? null;
  const agentTurn = allTurns.find(t => t.sequence === turnSequence && t.role === 'agent') ?? null;

  // If neither found, try treating sequence as raw turn index
  if (!humanTurn && !agentTurn) {
    const rawTurn = allTurns.find(t => t.sequence === turnSequence);
    if (!rawTurn) {
      return html(errorHtml('Not Found', `Turn ${turnSequence} not found`), 404);
    }
    const singleHuman = rawTurn.role === 'human' ? rawTurn : null;
    const singleAgent = rawTurn.role === 'agent' ? rawTurn : null;
    const maxSequence = Math.max(...allTurns.map(t => t.sequence));

    return html(turnDetailHtml(
      task, session, singleHuman, singleAgent, turnSequence, maxSequence,
    ));
  }

  const maxSequence = Math.max(...allTurns.map(t => t.sequence));

  return html(turnDetailHtml(
    task, session, humanTurn, agentTurn, turnSequence, maxSequence,
  ));
}

async function handlePromptVersion(storage: Storage, taskId: string, versionParam: string): Promise<Response> {
  const task = await storage.getTask(taskId);
  if (!task) {
    return html(errorHtml('Not Found', `Task not found: ${taskId}`), 404);
  }

  const allVersions = await storage.getPromptHistory(task.id);

  if (versionParam === 'current') {
    return html(promptVersionHtml(task, null, 'current', allVersions));
  }

  const versionNum = parseInt(versionParam, 10);
  if (isNaN(versionNum)) {
    return html(errorHtml('Bad Request', `Invalid version: ${versionParam}`), 400);
  }

  const version = await storage.getPromptVersion(task.id, versionNum);
  if (!version) {
    return html(errorHtml('Not Found', `Prompt version ${versionNum} not found`), 404);
  }

  return html(promptVersionHtml(task, version, versionParam, allVersions));
}

async function handleSearch(storage: Storage, url: URL): Promise<Response> {
  const query = url.searchParams.get('q') ?? '';
  const results = query ? await storage.search(query) : [];
  return html(searchResultsHtml(results, query));
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
  const followUps = await storage.getTaskFollowUps(task.id);
  const children = await storage.getChildTasks(task.id);

  return json({ task, session, turns, commits, comments, journal, followUps, children });
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
      params[patternParts[i].slice(1)] = pathParts[i];
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
  options?: { deadlineMs?: number; stylesheetFromDisk?: boolean },
): (req: Request) => Promise<Response> {
  const deadlineMs = options?.deadlineMs ?? WEB_REQUEST_DEADLINE_MS;
  const cssFromDisk = options?.stylesheetFromDisk === true;
  return async (req: Request) => {
    const url = new URL(req.url);
    const path = url.pathname;
    return withWebRequestDeadline(
      path,
      routeWebRequest(storage, actions, req, url, path, cssFromDisk),
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
 * The route table itself. Bounded by its caller — see {@link createWebRequestHandler}.
 *
 * Takes the whole `Request` (not just the URL) because the review routes are
 * the only ones that mutate: they need the method and the body.
 */
async function routeWebRequest(
  storage: Storage,
  actions: ReviewActions | undefined,
  req: Request,
  url: URL,
  path: string,
  cssFromDisk: boolean,
): Promise<Response> {
  try {
    if (path === STYLESHEET_PATH) {
      return await handleStylesheet(cssFromDisk);
    }

    // Review surface (queue, diff review, inline comments, resolution
    // actions). These are the only routes that mutate state, and they do it
    // exclusively through the ReviewActions port — i.e. through the daemon.
    if (path === '/review' || path.startsWith('/review/') || path.startsWith('/api/review/')) {
      return await handleReviewRoute(storage, actions, req, url, path);
    }

    // HTML routes
    if (path === '/') {
      return await handleDashboard(storage);
    }

    if (path === '/tasks') {
      return await handleTaskList(storage, url);
    }

    if (path === '/search') {
      return await handleSearch(storage, url);
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
      return await handleTurnDetail(storage, params.id, seq);
    }

    // Prompt version: /tasks/:id/prompts/:version
    params = matchRoute(path, '/tasks/:id/prompts/:version');
    if (params) {
      return await handlePromptVersion(storage, params.id, params.version);
    }

    // Task detail: /tasks/:id (must be after sub-routes)
    params = matchRoute(path, '/tasks/:id');
    if (params) {
      return await handleTaskDetail(storage, params.id);
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
    return html(errorHtml('Server Error', message), 500);
  }
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
  req: Request,
  url: URL,
  path: string,
): Promise<Response> {
  const wantsJson = path.startsWith('/api/');
  if (!actions) {
    const msg = 'Review actions are not available: this dashboard was started without a daemon action port.';
    return wantsJson ? json({ error: msg }, 503) : html(errorHtml('Unavailable', msg), 503);
  }

  if (path === '/review') {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    return html(reviewQueueHtml(await actions.listQueue()));
  }

  if (path === '/api/review/queue') {
    return json({ queue: await actions.listQueue() });
  }

  let params = matchRoute(path, '/api/review/:id/threads');
  if (params) {
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return json({ error: 'Task not found' }, 404);
    return json(
      threadsJson(await actions.listComments(resolved.task.id), await reviewLiveState(storage, resolved.task)),
    );
  }

  params = matchRoute(path, '/review/:id/comment');
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
    // must be one of the two intents; a typo'd one is rejected rather than
    // silently treated as a question the reviewer never asked.
    if (body.intent !== undefined && body.intent !== 'ask' && body.intent !== 'comment') {
      return json({ error: "intent must be 'ask' or 'comment'" }, 400);
    }
    const comment = await actions.postComment(resolved.task.id, {
      file,
      line,
      side,
      content,
      intent: body.intent === 'comment' ? 'comment' : 'ask',
      threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
      anchorSnippet: typeof body.anchorSnippet === 'string' ? body.anchorSnippet : undefined,
    });
    return json({ comment }, 201);
  }

  // Re-send a question whose ask failed. Deliberately a plain form POST with a
  // redirect rather than a fetch(): the whole point of this route is that the
  // reviewer's question survives, so it must work with scripting off too.
  params = matchRoute(path, '/review/:id/comment/:commentId/retry');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    try {
      await actions.retryAsk(resolved.task.id, params.commentId);
    } catch (err) {
      return renderReviewPage(storage, actions, resolved.task.id, {
        text: `Could not re-send the question: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      });
    }
    return Response.redirect(`${url.origin}/review/${resolved.task.id}`, 303);
  }

  // Retract one of the reviewer's own messages before it reaches the agent.
  // Same plain form POST + redirect shape as retry, for the same reason: the
  // reviewer must be able to take a comment back with scripting off. The
  // daemon owns the rules about WHAT may be withdrawn (withdrawRefusalReason);
  // its message is relayed verbatim, so the page never invents its own.
  params = matchRoute(path, '/review/:id/comment/:commentId/withdraw');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    try {
      await actions.withdrawComment(resolved.task.id, params.commentId);
    } catch (err) {
      return renderReviewPage(storage, actions, resolved.task.id, {
        text: `Could not withdraw: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      });
    }
    return Response.redirect(`${url.origin}/review/${resolved.task.id}`, 303);
  }

  params = matchRoute(path, '/review/:id/unblock');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    const form = await req.formData();
    const message = String(form.get('message') ?? '').trim();
    if (!message) {
      return renderReviewPage(storage, actions, resolved.task.id, {
        text: 'Feedback cannot be empty.',
        error: true,
      });
    }
    try {
      await actions.unblock(resolved.task.id, message);
    } catch (err) {
      return renderReviewPage(storage, actions, resolved.task.id, {
        text: `Unblock failed: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      });
    }
    return Response.redirect(`${url.origin}/tasks/${resolved.task.id}`, 303);
  }

  params = matchRoute(path, '/review/:id/accept');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    const form = await req.formData();
    const reason = String(form.get('reason') ?? '').trim() || undefined;
    // Everything the reviewer had typed, carried through every re-render below.
    const draft: ReviewDraft = {
      reason,
      feedback: String(form.get('feedback') ?? '') || undefined,
    };
    // Present only when the reviewer is clearing a protection gate from the
    // page. It goes to the daemon and nowhere else — never into the draft,
    // never into a log line, never back into the rendered form.
    const passphrase = String(form.get('passphrase') ?? '') || undefined;
    // Presentation only — acceptTaskPreflight enforces this too, but its advice
    // ("use --approve-file") is meaningless in a browser.
    const blocked = acceptBlockedByViolations(await taskFileViolations(storage, resolved.task.id));
    if (blocked) {
      return renderReviewPage(storage, actions, resolved.task.id, { text: blocked, error: true }, draft);
    }
    try {
      await actions.accept(resolved.task.id, reason, passphrase);
    } catch (err) {
      // The remedy is the daemon's, read straight off the error — this page
      // never reads the message to guess what went wrong. An error without one
      // still shows the daemon's words verbatim, as before.
      const remedy: AcceptRemedy | undefined = acceptRemedyOf(err);
      return renderReviewPage(
        storage,
        actions,
        resolved.task.id,
        { text: `Accept failed: ${err instanceof Error ? err.message : String(err)}`, error: true },
        draft,
        remedy,
      );
    }
    return Response.redirect(`${url.origin}/tasks/${resolved.task.id}`, 303);
  }

  // The in-page half of a "sync first" remedy: same syncTask the CLI runs, so
  // the reviewer does not have to leave the page to clear a stale merge base.
  params = matchRoute(path, '/review/:id/sync');
  if (params) {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    const form = await req.formData();
    const draft: ReviewDraft = {
      reason: String(form.get('reason') ?? '') || undefined,
      feedback: String(form.get('feedback') ?? '') || undefined,
    };
    try {
      const result = await actions.sync(resolved.task.id);
      return renderReviewPage(
        storage,
        actions,
        resolved.task.id,
        { text: result.message ?? 'Sync started.' },
        draft,
      );
    } catch (err) {
      return renderReviewPage(
        storage,
        actions,
        resolved.task.id,
        { text: `Sync failed: ${err instanceof Error ? err.message : String(err)}`, error: true },
        draft,
      );
    }
  }

  params = matchRoute(path, '/review/:id/violation');
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
      return renderReviewPage(storage, actions, resolved.task.id, { text: message, error: true });
    }
    // The island posts this and patches the one control in place; without JS
    // the browser follows the redirect and re-renders the page with the new
    // state. Either way the decision is already durable.
    if (asJson) return json({ violations });
    return Response.redirect(`${url.origin}/review/${resolved.task.id}`, 303);
  }

  params = matchRoute(path, '/review/:id');
  if (params) {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const resolved = await storage.resolveTask(params.id);
    if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);
    return renderReviewPage(storage, actions, resolved.task.id);
  }

  return html(errorHtml('Not Found', 'Page not found'), 404);
}

async function renderReviewPage(
  storage: Storage,
  actions: ReviewActions,
  taskId: string,
  notice?: { text: string; error?: boolean },
  /** Text the reviewer had typed, re-rendered into the boxes it came from. */
  draft?: ReviewDraft,
  /** The daemon's remedy for a refused accept, rendered as offered actions. */
  remedy?: AcceptRemedy,
): Promise<Response> {
  const resolved = await storage.resolveTask(taskId);
  if (!resolved.task) return html(errorHtml('Not Found', 'Task not found'), 404);

  const comments = await actions.listComments(resolved.task.id);
  let diffText = '';
  let diffNotice = notice;
  try {
    diffText = await actions.getDiff(resolved.task.id);
  } catch (err) {
    // A missing worktree or absent session must not blank the page — the
    // comment threads are the durable record and still have to render.
    diffNotice = diffNotice ?? {
      text: `Could not load the diff: ${err instanceof Error ? err.message : String(err)}`,
      error: true,
    };
  }
  const state = await reviewLiveState(storage, resolved.task);
  const violations = await taskFileViolations(storage, resolved.task.id);
  return html(reviewTaskHtml(resolved.task, diffText, comments, diffNotice, state, violations, { draft, remedy }));
}

/**
 * The file permission violations the review page shows.
 *
 * INVARIANT (violations-come-from-the-violation-turn): read through
 * latestViolationTurn, never the last agent turn — a later push-back or nudge
 * reply carries no violations, so `pop()` would report "none" for a task the
 * daemon is about to revert files on. See src/utils/turns.ts.
 *
 * A task with no session (never started) has nothing to report rather than
 * failing the page.
 */
async function taskFileViolations(storage: Storage, taskId: string): Promise<FileViolation[]> {
  const session = await storage.getSessionByTaskId(taskId);
  if (!session) return [];
  const turns = await storage.getSessionTurns(session.id);
  return latestViolationTurn(turns)?.violations ?? [];
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
  const reason = askUnavailableReason(task.status);
  return {
    status: task.status,
    turns,
    lastActiveAt: session ? (session.last_interaction_at ?? session.started_at) : null,
    askable: reason === null,
    askUnavailable: reason,
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
  handler: (req: Request) => Promise<Response>,
  maxAttempts: number = MAX_PORT_ATTEMPTS,
  hostname: string = '127.0.0.1',
): { server: ReturnType<typeof Bun.serve>; lastError: unknown } | null {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tryPort = port + attempt;
    try {
      const server = Bun.serve({
        hostname,
        port: tryPort,
        fetch: handler,
        // Same ceiling as the unix-socket listener. Long /rpc and /mcp calls are
        // kept alive by the heartbeat envelope, not by this value — see
        // src/daemon/heartbeat.ts for why no idleTimeout can cover them.
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
