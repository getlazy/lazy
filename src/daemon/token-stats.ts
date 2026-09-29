/** One daemon-owned projection for CLI, Stats clients, and MCP token planning. */
import { join } from 'path';
import type { Storage } from '../storage/interface';
import type { Task, TaskType, Turn } from '../types';
import { VALID_TASK_TYPES } from '../types';
import type { ProxyAuditRecord } from '../storage/types';
import { loadConfig } from '../config/loader';
import { readAuditRecords } from '../proxy/audit-log';
import { aggregateUsage, type TokenGroup, type TokenReport } from '../proxy/aggregate';
import {
  buildToolStats, mergeToolStats, partitionAuditRecordsByTask, toolStatsFromRecord,
  type TaskToolStats,
} from '../task/stats';
import { collectDescendantTasks, loadToolStatsRecords } from '../task/stats-data';

export type TokenStatsGroup = 'task' | 'model' | 'role';
export type TokenStatsScope = 'tokens' | 'tools';
export type TokenStatsCaller = { kind: 'builder' } | { kind: 'task'; root: Task };

export interface TokenStatsOptions {
  scope?: TokenStatsScope;
  task?: Task;
  subtree?: boolean;
  groupBy?: TokenStatsGroup;
  sinceMs?: number;
  top?: number;
  taskType?: TaskType;
  minTasks?: number;
  caller?: TokenStatsCaller;
  limit?: number;
  role?: string;
  taskIdPrefix?: string;
  windowedTools?: boolean;
}

export interface TaskPlanningRow {
  taskId: string;
  code: string | null;
  taskType: string;
  outcome: 'accepted' | 'rejected' | 'closed' | 'open';
  models: string[];
  requestedModels: string[];
  efforts: string[];
  harnesses: string[];
  feedbackRounds: number;
  turnWallClockMs: number | null;
  tokens: number;
  modelTokens: Record<string, number | null>;
}

export function summarizeModels(rows: TaskPlanningRow[], minTasks: number) {
  const modelMap = new Map<string, TaskPlanningRow[]>();
  for (const row of rows) {
    for (const model of row.models) {
      const list = modelMap.get(model) ?? [];
      list.push(row);
      modelMap.set(model, list);
    }
  }
  return [...modelMap].map(([model, modelTasks]) => {
    const accepted = modelTasks.filter(t => t.outcome === 'accepted');
    const acceptedWithTokens = accepted.filter(t => typeof t.modelTokens[model] === 'number');
    const sufficient = modelTasks.length >= minTasks;
    const rounds = modelTasks.reduce((n, t) => n + t.feedbackRounds, 0) / modelTasks.length;
    return {
      model,
      taskCount: modelTasks.length,
      sample: sufficient ? 'sufficient' : 'insufficient data',
      acceptRate: sufficient ? accepted.length / modelTasks.length : null,
      averageRounds: sufficient ? rounds : null,
      firstPassRate: sufficient
        ? accepted.filter(t => t.feedbackRounds === 0).length / modelTasks.length
        : null,
      tokensPerAcceptedTask: acceptedWithTokens.length
        ? acceptedWithTokens.reduce((n, t) => n + t.modelTokens[model]!, 0) /
          acceptedWithTokens.length
        : null,
    };
  }).sort((a, b) => b.taskCount - a.taskCount || a.model.localeCompare(b.model));
}

export function parseTokenStatsSince(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+)(m|h|d)$/.exec(value);
  if (!match) throw new Error("since must be a duration such as '30m', '2h', or '1d'");
  const unit = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : 86_400_000;
  return now - Number(match[1]) * unit;
}

export function parseTokenStatsTaskType(value: unknown): TaskType | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !VALID_TASK_TYPES.includes(value as TaskType)) {
    throw new Error(`task_type must be one of: ${VALID_TASK_TYPES.join(', ')}`);
  }
  return value as TaskType;
}

export async function loadAudit(projectRoot: string, limit = 50_000): Promise<ProxyAuditRecord[]> {
  const config = await loadConfig(projectRoot);
  return readAuditRecords(join(projectRoot, config.data.path), { limit });
}

export async function loadTokenReport(
  projectRoot: string,
  taskIds: string[] | undefined,
  options: Pick<TokenStatsOptions, 'sinceMs' | 'limit' | 'role'> & { taskId?: string } = {},
): Promise<TokenReport> {
  return aggregateUsage(await loadAudit(projectRoot, options.limit), {
    sinceMs: options.sinceMs,
    taskIds,
    role: options.role,
    taskId: options.taskId,
  });
}

function outcomeOf(task: Task, sessionOutcome: string | null): TaskPlanningRow['outcome'] {
  if (sessionOutcome === 'accepted' || task.status === 'complete') return 'accepted';
  if (sessionOutcome === 'rejected') return 'rejected';
  if (task.status === 'abandoned') return 'closed';
  return 'open';
}

function labels(turns: Turn[], key: 'model' | 'effort' | 'agent'): string[] {
  return [...new Set(turns.map(t => t[key]).filter((v): v is string => Boolean(v)))].sort();
}

function servedModels(turns: Turn[]): string[] {
  const agentTurns = turns.filter(t => t.role === 'agent');
  const concrete = agentTurns.map(t => t.model_id ?? t.model).filter((v): v is string => Boolean(v));
  return [...new Set(concrete.length ? concrete : labels(turns, 'model'))].sort();
}

function feedbackRounds(turns: Turn[]): number {
  const workRequests = turns.filter(t => t.role === 'human' && (t.turn_type ?? 'work') === 'work');
  return Math.max(0, workRequests.length - 1);
}

function turnWallClock(turns: Turn[]): number | null {
  const work = turns.filter(t => (t.turn_type ?? 'work') === 'work').sort((a, b) => a.timestamp - b.timestamp);
  return work.length > 1 ? work[work.length - 1].timestamp - work[0].timestamp : null;
}

export function planningActivityAt(endedAt: number | null | undefined, turns: Turn[]): number {
  return Math.max(endedAt ?? 0, ...turns.map(turn => turn.timestamp), 0);
}

function tokenCount(record: ProxyAuditRecord): number {
  const u = record.usage;
  return u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) +
    (u.cacheCreationInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) : 0;
}

/**
 * One pass over the trail, keyed by the attributed task id. Records whose id is
 * a full task id are found by exact lookup; only the (rare) short-prefix ids
 * need the prefix comparison, and those are few distinct keys, not records.
 */
export function indexAuditByTask(
  records: ProxyAuditRecord[],
  taskIds: string[],
): (taskId: string) => ProxyAuditRecord[] {
  const byKey = new Map<string, ProxyAuditRecord[]>();
  for (const record of records) {
    if (!record.taskId) continue;
    const list = byKey.get(record.taskId) ?? [];
    list.push(record);
    byKey.set(record.taskId, list);
  }
  const full = new Set(taskIds);
  const partialKeys = [...byKey.keys()].filter(key => !full.has(key));
  return (taskId) => [
    ...(byKey.get(taskId) ?? []),
    ...partialKeys
      .filter(key => taskId.startsWith(key) || key.startsWith(taskId))
      .flatMap(key => byKey.get(key)!),
  ];
}

function modelTokensForTask(records: ProxyAuditRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const record of records) {
    const model = record.model ?? '(unattributed)';
    out[model] = (out[model] ?? 0) + tokenCount(record);
  }
  return out;
}

function attributedModelTokens(
  records: ProxyAuditRecord[],
  storedModels: string[],
): Record<string, number | null> {
  const wire = modelTokensForTask(records);
  if (storedModels.length === 1) {
    return { [storedModels[0]]: Object.values(wire).reduce((sum, tokens) => sum + tokens, 0) };
  }
  return Object.fromEntries(storedModels.map(model => [model, wire[model] ?? null]));
}

function within(root: Task, task: Task, descendants: Task[]): boolean {
  return task.id === root.id || descendants.some(d => d.id === task.id);
}

async function loadTools(
  projectRoot: string,
  storage: Storage,
  ids: string[],
  options: TokenStatsOptions,
): Promise<TaskToolStats | null> {
  if (options.sinceMs !== undefined || options.windowedTools) {
    const all = await loadAudit(projectRoot, options.limit);
    const records = options.sinceMs === undefined
      ? all
      : all.filter(record => record.ts >= options.sinceMs!);
    const byTask = partitionAuditRecordsByTask(records, ids);
    return mergeToolStats(ids.map(id => buildToolStats(byTask.get(id) ?? [], id)));
  }
  const byTask = await loadToolStatsRecords(storage, ids);
  const present = ids.map(id => byTask.get(id) ?? null).filter(r => r !== null);
  return present.length ? mergeToolStats(present.map(r => toolStatsFromRecord(r!))) : null;
}

export async function describeTokenStats(
  projectRoot: string,
  storage: Storage,
  options: TokenStatsOptions = {},
): Promise<Record<string, unknown>> {
  const scope = options.scope ?? 'tokens';
  const top = options.top ?? 10;
  const minTasks = options.minTasks ?? 3;
  const caller = options.caller ?? { kind: 'builder' as const };
  const allowedDescendants = caller.kind === 'task'
    ? await collectDescendantTasks(storage, caller.root.id)
    : [];
  if (options.task && caller.kind === 'task' && !within(caller.root, options.task, allowedDescendants)) {
    throw new Error('Task agents may read token details only for their own task or its subtree.');
  }

  const selectedRoot = options.task ?? (caller.kind === 'task' ? caller.root : undefined);
  if (scope === 'tools') {
    if (!selectedRoot) throw new Error("scope 'tools' requires task");
    if (options.groupBy || options.taskType || options.minTasks !== undefined) {
      throw new Error("scope 'tools' does not accept group_by, task_type, or min_tasks");
    }
    const descendants = options.subtree ? await collectDescendantTasks(storage, selectedRoot.id) : [];
    const ids = [selectedRoot.id, ...descendants.map(task => task.id)];
    const tools = await loadTools(projectRoot, storage, ids, options);
    return {
      scope,
      taskId: selectedRoot.id,
      taskCode: selectedRoot.code,
      subtree: descendants.length > 0,
      descendantCount: descendants.length,
      tools: tools ? { ...tools, totalRows: tools.rows.length, rows: tools.rows.slice(0, top) } : null,
    };
  }

  let tasks: Task[];
  if (selectedRoot) {
    const descendants = options.subtree ? await collectDescendantTasks(storage, selectedRoot.id) : [];
    tasks = [selectedRoot, ...descendants];
  } else {
    tasks = await storage.listTasks();
  }
  if (options.taskType) tasks = tasks.filter(t => t.type === options.taskType);

  // Read the bounded trail ONCE per call and index it by task id: the planning
  // loop below visits every project task, so a per-task rescan of the trail
  // would be tasks × records work on the daemon's event loop.
  const rawAudit = await loadAudit(projectRoot, options.limit);
  const report = aggregateUsage(rawAudit, {
    sinceMs: options.sinceMs,
    taskIds: selectedRoot || options.taskType ? tasks.map(t => t.id) : undefined,
    role: options.role,
    taskId: options.taskIdPrefix,
  });
  let planningTasks = caller.kind === 'task' ? await storage.listTasks() : tasks;
  if (options.taskType) planningTasks = planningTasks.filter(t => t.type === options.taskType);
  const audit = rawAudit.filter(
    record => options.sinceMs === undefined || record.ts >= options.sinceMs,
  );
  const recordsFor = indexAuditByTask(audit, planningTasks.map(task => task.id));
  const allRows: TaskPlanningRow[] = [];
  for (const task of planningTasks) {
    const session = await storage.getSessionByTaskId(task.id);
    const turns = session ? await storage.getSessionTurns(session.id) : [];
    const lastActivity = planningActivityAt(session?.ended_at, turns);
    if (options.sinceMs !== undefined && lastActivity < options.sinceMs) continue;
    const models = servedModels(turns);
    const taskRecords = recordsFor(task.id);
    const modelTokens = attributedModelTokens(taskRecords, models);
    allRows.push({
      taskId: task.id,
      code: task.code,
      taskType: task.type,
      outcome: outcomeOf(task, session?.outcome ?? null),
      models,
      requestedModels: labels(turns, 'model'),
      efforts: labels(turns.filter(t => t.role === 'agent'), 'effort'),
      harnesses: labels(turns.filter(t => t.role === 'agent'), 'agent'),
      feedbackRounds: feedbackRounds(turns),
      turnWallClockMs: turnWallClock(turns),
      tokens: taskRecords.reduce((sum, record) => sum + tokenCount(record), 0),
      modelTokens,
    });
  }

  const byModel = summarizeModels(allRows, minTasks);
  const breakdown = options.groupBy === 'task' ? report.byTask
    : options.groupBy === 'model' ? report.byModel
    : options.groupBy === 'role' ? report.byRole : undefined;
  const detailIds = new Set(tasks.map(task => task.id));
  const detailRows = allRows
    .filter(row => detailIds.has(row.taskId))
    .sort((a, b) => b.tokens - a.tokens || a.taskId.localeCompare(b.taskId));
  return {
    scope,
    source: {
      tokens: 'bounded proxy audit trail; requests without usage count as requests',
      planning: 'durable task, session, and turn storage',
    },
    totals: report.totals,
    firstTs: report.firstTs,
    lastTs: report.lastTs,
    ...(breakdown
      ? { groupBy: options.groupBy, groups: breakdown.slice(0, top) }
      : {
          byRole: report.byRole.slice(0, top),
          byTask: report.byTask.slice(0, top),
          byModelTokens: report.byModel.slice(0, top),
        }),
    tasks: detailRows.slice(0, top),
    models: byModel.slice(0, top),
    minTasks,
  };
}
