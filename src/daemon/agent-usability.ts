/**
 * Which tasks name an agent this installation cannot run, and why.
 *
 * Imports are verbatim: a store adopted from somebody's laptop brings its tasks
 * as they are, including ones pinned to a profile the project's configuration
 * here does not have (or keeps but does not use). Nothing rewrites those tasks;
 * this answers the question a control plane must put in front of a person —
 * the adopter, and whoever opens the task — before a launch fails on it.
 *
 * (`agentProfilesFor`) and the same provenance the "Unknown agent profile"
 * error reads.
 */

import { agentProfilesFor, profileNameForAgent } from '../config/agent-profiles';
import { lastLoadedConfig } from '../config/config-provenance';
import { PROFILE_AWAITING_CONFIRMATION } from '../config/agent-profile-advice';
import { loadConfig } from '../config/loader';
import type { Storage } from '../storage/interface';
import { isTerminalStatus, type Task } from '../types';
import { displayId } from '../task/identity';

export interface TaskAgentProblem {
  taskId: string;
  displayId: string;
  goal: string;
  status: string;
  agent: string;
  /** One sentence for the person reading it: what is wrong and what to do. */
  reason: string;
}

/** Why `agent` cannot run on this project, or null when it can. */
export async function agentProblem(projectRoot: string, agent: string | null | undefined): Promise<string | null> {
  const config = await loadConfig(projectRoot);
  const name = profileNameForAgent(agent);
  const profile = agentProfilesFor(config).get(name);
  if (profile) {
    return null;
  }
  const loaded = lastLoadedConfig();
  const withheld = loaded?.withheldProfiles?.[name];
  if (withheld !== undefined && loaded?.awaitingConfirmation?.includes(name)) {
    return `profile "${name}" is in this project's configuration but not used here: it is ${PROFILE_AWAITING_CONFIRMATION} its endpoints (${withheld}) — confirm them under Settings › Configuration › Endpoints and agent profiles, or switch the task to another profile`;
  }
  if (withheld !== undefined) {
    return `profile "${name}" is in this project's configuration but not used here: ${withheld} — change it on the Configuration page, or switch the task to another profile`;
  }
  if (loaded?.repositoryAgentNames?.includes(name)) {
    return `profile "${name}" is in the repository's lazy.toml but not in this project's configuration — it is ${PROFILE_AWAITING_CONFIRMATION} bringing it in under Settings › Configuration › Endpoints and agent profiles, or switch the task to another profile`;
  }
  if (Array.isArray(loaded?.repositoryAgentNames)) {
    return `profile "${name}" is not in this project's configuration, nor in the repository's lazy.toml in this project's checkout — it is not defined anywhere; add it on the Configuration page, or switch the task to another profile`;
  }
  return `profile "${name}" is not in this project's configuration — add it on the Configuration page, or switch the task to another profile`;
}

/**
 * Every live task (or the ones named) whose agent cannot run here. Terminal
 * tasks never launch again, so they are not listed.
 */
export async function taskAgentProblems(
  storage: Storage,
  projectRoot: string,
  taskIds?: string[],
): Promise<TaskAgentProblem[]> {
  const tasks = taskIds
    ? (await Promise.all(taskIds.map(async (id) => (await storage.resolveTask(id)).task ?? null)))
      .filter((t): t is Task => t !== null && !isTerminalStatus(t.status))
    : (await storage.listTasks()).filter((t) => !isTerminalStatus(t.status));
  const problems: TaskAgentProblem[] = [];
  const byAgent = new Map<string, string | null>();
  for (const task of tasks) {
    const agent = task.agent_id ?? '';
    if (!byAgent.has(agent)) byAgent.set(agent, await agentProblem(projectRoot, agent));
    const reason = byAgent.get(agent);
    if (reason) {
      problems.push({ taskId: task.id, displayId: displayId(task), goal: task.goal, status: task.status, agent, reason });
    }
  }
  return problems;
}
