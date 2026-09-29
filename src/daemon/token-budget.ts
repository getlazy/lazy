/**
 * The daemon half of the token-budget view (src/usage-pause/budget-view.ts):
 * gathers the usage-limit view, the audit trail and every agent turn's recorded
 * usage, and hands them to the pure projection. Every surface — the
 * `tokenBudget` RPC behind `lazy stats budget`, the dashboard's budget box,
 * Lazy Teams' project page, and `lazy_usage_limits` over MCP — reads it here.
 */
import type { Storage } from '../storage/interface';
import { daemonUsageLimits, usageLimitCredentialKey } from '../proxy/usage-limits';
import type { Turn } from '../types';
import { projectUsageLimits, type UsageLimitsView } from '../usage-pause/limits-view';
import { budgetLookbackStart, projectTokenBudget, type BudgetTurnInput, type TokenBudgetView } from '../usage-pause/budget-view';
import { describeUsagePauseState, describeUsageLimitsView, seedUsageLimitsView, turnSpendCredential, type UsageLimitsCaller } from './usage-pause';
import { loadAudit } from './token-stats';
import { loadConfig } from '../config/loader';
import { SERVICE_CREDENTIAL_USER_ID, teamModeEnabled } from './user-credentials';

/**
 * The credential a Teams agent turn spent, from its own row: a turn someone
 * asked for bills that person (`user:<email>`), a turn the daemon started by
 * itself bills the service credential (its row's channel is `system`). A row
 * naming neither is UNKNOWN (null), and the budget then refuses to attribute
 * turns to any window rather than guess.
 */
export function teamsTurnCredential(t: Pick<Turn, 'actor' | 'actor_email'>): string | null {
  if (t.actor === 'system') return usageLimitCredentialKey({ userId: SERVICE_CREDENTIAL_USER_ID, upstream: '' });
  if (t.actor_email) return usageLimitCredentialKey({ userId: t.actor_email, upstream: '' });
  return null;
}

/** Every agent turn with a timestamp inside the lookback, across the project. */
export async function loadBudgetTurns(
  projectRoot: string,
  storage: Storage,
  now: number = Date.now(),
): Promise<BudgetTurnInput[]> {
  const since = budgetLookbackStart(now);
  // Which credential a turn spent. On a Teams host a turn is billed to the
  // person who asked for it, and its agent row names that person; a turn
  // nobody asked for runs on the service credential and its row says
  // `system` (teamsTurnCredential). On a single-person install it is the
  // task's agent profile's credential.
  const teams = await teamModeEnabled(projectRoot);
  const config = teams ? null : await loadConfig(projectRoot);
  const out: BudgetTurnInput[] = [];
  for (const task of await storage.listTasks()) {
    const session = await storage.getSessionByTaskId(task.id);
    if (!session) continue;
    // A session that ended before the lookback has no turn inside it.
    if (session.ended_at && session.ended_at < since) continue;
    let credential: string | null | undefined;
    for (const t of await storage.getSessionTurns(session.id)) {
      if (t.role !== 'agent' || t.timestamp < since) continue;
      let spent: string | null;
      if (teams) {
        spent = teamsTurnCredential(t);
      } else {
        if (credential === undefined) {
          credential = (await turnSpendCredential(projectRoot, config!, task))?.credential ?? null;
        }
        spent = credential;
      }
      out.push({ taskId: task.id, taskCode: task.code, agent: t.agent, timestamp: t.timestamp, usage: t.usage, credential: spent });
    }
  }
  return out;
}

async function budgetOver(
  projectRoot: string,
  storage: Storage,
  limits: UsageLimitsView,
  now: number,
  taskId?: string,
): Promise<TokenBudgetView> {
  return projectTokenBudget(limits, await loadAudit(projectRoot), await loadBudgetTurns(projectRoot, storage, now), now, { taskId });
}

/**
 * The project-wide budget — every credential the proxy has seen. Control-plane
 * only through the RPC, like `usageLimits` (Lazy Teams narrows it to the viewer
 * itself, as it does the pause state). Refuses, like the limits view, while the
 * saved readings cannot be read.
 */
export async function describeProjectTokenBudget(
  projectRoot: string,
  storage: Storage,
  now: number = Date.now(),
): Promise<TokenBudgetView> {
  await seedUsageLimitsView(projectRoot);
  const limits = projectUsageLimits(daemonUsageLimits.readings(), await describeUsagePauseState(projectRoot, storage), now);
  return budgetOver(projectRoot, storage, limits, now);
}

/**
 * The budget for an MCP caller, built over the limits view ALREADY NARROWED to
 * that caller (describeUsageLimitsView): a task agent sees its own credential
 * and its own task's row; a Teams builder no other member's credential.
 */
export async function describeTokenBudgetFor(
  projectRoot: string,
  storage: Storage,
  caller: UsageLimitsCaller,
  limits?: UsageLimitsView,
  now: number = Date.now(),
): Promise<TokenBudgetView> {
  const view = limits ?? await describeUsageLimitsView(projectRoot, storage, caller);
  return budgetOver(projectRoot, storage, view, now, caller.kind === 'task' ? caller.taskId : undefined);
}
