/**
 * Lazy HTTP server
 *
 * Serves a read-only HTML dashboard for lazy tasks, sessions, and search.
 * Uses Bun's built-in HTTP server with no additional dependencies.
 */

import type { Storage, Task, Session, StatusChange } from '../storage';
import { findLazyRoot } from '../cli/init';
import { tryRemoteStorage } from '../cli/helpers';
import { getCommitDiff } from '../git/operations';
import { logger } from '../utils/logger';

import {
  taskListHtml,
  taskDetailHtml,
  searchResultsHtml,
  errorHtml,
  commitDetailHtml,
  taskPrHtml,
  turnDetailHtml,
  promptVersionHtml,
  dashboardHtml,
  totalInputTokens,
} from './templates';
import type { DashboardStats, TaskWithSession, ChartDataPoint, ActiveTaskInfo, ActivityDay, ActiveStates } from './templates';
import { taskRefFromId } from '../cli/helpers';

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

function getViewMode(url: URL): 'side-by-side' | 'unified' {
  const view = url.searchParams.get('view');
  return view === 'unified' ? 'unified' : 'side-by-side';
}

type SortField = 'status' | 'model' | 'turns' | 'last_active' | 'duration' | 'tokens' | 'goal' | 'created';
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
  const validFields: SortField[] = ['status', 'model', 'last_active', 'duration', 'tokens', 'goal', 'created'];

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
 * - closed: count of tasks closed/rejected that day
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
          } else if (task.status === 'closed' || task.status === 'abandoned') {
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
      case 'abandoned': case 'closed': completedCount++; break;
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
          lastTurnSummary = lastTurn.content.replace(/\s+/g, ' ').trim();
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
  const children = await storage.getChildTasks(task.id);
  const promptVersions = await storage.getPromptHistory(task.id);
  const parentTask = task.parent_task_id ? await storage.getTask(task.parent_task_id) : null;

  return html(taskDetailHtml(task, session, turns, commits, comments, children, promptVersions, parentTask));
}

async function handleCommitDetail(storage: Storage, taskId: string, commitId: string, url: URL): Promise<Response> {
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
  const viewMode = getViewMode(url);

  return html(commitDetailHtml(task, commit, diffText, viewMode));
}

async function handleTaskPr(storage: Storage, taskId: string): Promise<Response> {
  const task = await storage.getTask(taskId);
  if (!task) {
    return html(errorHtml('Not Found', `Task not found: ${taskId}`), 404);
  }

  const session = await storage.getSessionByTaskId(task.id);
  if (!session) {
    return html(errorHtml('Not Found', 'Task has no session'), 404);
  }

  const commits = await storage.getSessionCommits(session.id);

  const baseBranch = task.parent_task_id
    ? 'lazy/' + await taskRefFromId(task.parent_task_id, storage)
    : 'main';

  return html(taskPrHtml(task, session, commits, baseBranch));
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
  const children = await storage.getChildTasks(task.id);

  return json({ task, session, turns, commits, comments, children });
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

const MAX_PORT_ATTEMPTS = 100;

/**
 * Create the web dashboard request handler for a given storage instance.
 *
 * This handler serves HTML pages and JSON API endpoints for the web dashboard.
 * It's used by both the standalone `lazy server` command and the daemon's
 * TCP-bound web server.
 */
export function createWebRequestHandler(storage: Storage): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const url = new URL(req.url);
    const path = url.pathname;

    try {

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

      // Task PR page: /tasks/:id/pr
      let params = matchRoute(path, '/tasks/:id/pr');
      if (params) {
        return await handleTaskPr(storage, params.id);
      }

      // Commit detail: /tasks/:id/commits/:commitId
      params = matchRoute(path, '/tasks/:id/commits/:commitId');
      if (params) {
        return await handleCommitDetail(storage, params.id, params.commitId, url);
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
  };
}

/**
 * Try to bind an HTTP server to a TCP port with auto-increment on conflict.
 * Returns the server instance, or null if all ports were exhausted.
 */
export function tryBindTcpPort(
  port: number,
  handler: (req: Request) => Promise<Response>,
  maxAttempts: number = MAX_PORT_ATTEMPTS,
): { server: ReturnType<typeof Bun.serve>; lastError: unknown } | null {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tryPort = port + attempt;
    try {
      const server = Bun.serve({
        port: tryPort,
        fetch: handler,
        idleTimeout: 120,
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

export async function startServer(port: number): Promise<void> {
  const root = findLazyRoot();
  if (!root) {
    console.error('Error: not in a lazy project. Run `lazy init` first.');
    process.exit(1);
  }

  const storage = await tryRemoteStorage(root);
  if (!storage) {
    console.error('Error: Daemon is not running. Start it with: lazy daemon start');
    process.exit(1);
  }

  const requestHandler = createWebRequestHandler(storage);

  const result = tryBindTcpPort(port, requestHandler);
  if (!result) {
    console.error(
      `Error: Could not find an available port (tried ${port}–${port + MAX_PORT_ATTEMPTS - 1}).`,
    );
    await storage.close();
    process.exit(1);
  }

  const server = result.server;

  logger.info(`Lazy server running at http://localhost:${server.port}`);
  console.log(`Lazy server running at http://localhost:${server.port}`);
  console.log('Press Ctrl+C to stop.');

  // Graceful shutdown handler
  const shutdown = async () => {
    logger.info('Shutting down server...');
    server!.stop();
    await storage.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Block forever — the process.exit(0) in index.ts fires after dispatch()
  // returns, so we must never return. Ctrl+C / SIGTERM triggers shutdown above.
  await new Promise(() => {});
}
