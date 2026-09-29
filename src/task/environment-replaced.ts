/**
 * Telling the agent its environment was replaced between turns.
 *
 * A task's container outlives its turns, so an agent reasonably assumes that
 * whatever it installed or upgraded outside the worktree last turn is still
 * there. Lazy sometimes takes that container away between turns:
 *
 *   - a member entered the task through a Teams terminal, which STOPS the
 *     task's container (src/daemon/member-entry.ts), so the next turn gets a
 *     fresh one;
 *   - a turn's credential is a different kind than the running container was
 *     launched with, the task's agent changed, or its per-task variables
 *     (`lazy env`) changed — all fix the launch env at create time, so the
 *     launch paths recreate it.
 *
 * Without a word from lazy the agent then chases "tool not found" errors it
 * cannot explain. So every such replacement records a one-shot fact on the
 * task (task metadata, reasons in plain words), and the NEXT WORK turn's prompt
 * opens with it, once. A replacement that happens during an ask or a sync is
 * recorded and waits for the next work turn; one that happens while launching a
 * work turn is told to that very turn.
 *
 * The fact is cleared only after the work turn that carries it has been
 * launched, so a launch that fails after the old container was removed does not
 * lose it. It is recorded only when a RUNNING container was actually taken
 * away: a container that had already died needs no explaining beyond what the
 * agent would see anyway, and a first turn has nothing to lose.
 */

import type { Storage } from '../storage';

import environmentReplacedTemplate from '../prompts/environment-replaced.md' with { type: 'text' };

/** Task metadata key holding the pending reasons (newline-free, "; "-joined). */
export const ENVIRONMENT_REPLACED_KEY = 'environment_replaced';

/** Reason: a member worked in the task through a terminal. */
export const REASON_MEMBER_ENTERED = 'a member worked in this task through a terminal';
/** Reason: the turn's credential needs a different launch environment. */
export const REASON_CREDENTIAL_CHANGED = "the credential this task's turns run on changed";
/** Reason: the task was switched to a different agent. */
export const REASON_AGENT_CHANGED = 'the task was switched to a different agent';

/** Reason: the task's own environment variables (`lazy env`) changed. */
export const REASON_TASK_ENV_CHANGED = "this task's environment variables changed";

/** The plain-words reason a launch recreates the container for, or null when it does not. */
export function recreationReason(forCredential: boolean, forAgent: boolean, forTaskEnv = false): string | null {
  const reasons = [
    ...(forCredential ? [REASON_CREDENTIAL_CHANGED] : []),
    ...(forAgent ? [REASON_AGENT_CHANGED] : []),
    ...(forTaskEnv ? [REASON_TASK_ENV_CHANGED] : []),
  ];
  return reasons.length > 0 ? reasons.join('; ') : null;
}

/** Record that the task's environment was replaced, adding to any reason still pending. */
export async function recordEnvironmentReplaced(
  storage: Pick<Storage, 'getTaskMetadata' | 'updateTaskMetadata'>,
  taskId: string,
  reason: string,
): Promise<void> {
  const existing = await storage.getTaskMetadata(taskId, ENVIRONMENT_REPLACED_KEY);
  const reasons = existing ? existing.split('; ') : [];
  for (const r of reason.split('; ')) if (!reasons.includes(r)) reasons.push(r);
  await storage.updateTaskMetadata(taskId, ENVIRONMENT_REPLACED_KEY, reasons.join('; '));
}

/**
 * A launch that is about to recreate the task's container records the fact —
 * but only when the container it replaces is actually running, and only on a
 * sandboxed runner: a host-process run's environment is the host itself, and
 * recreating it loses nothing outside the worktree.
 */
export async function recordRecreationIfRunning(
  storage: Pick<Storage, 'getTaskMetadata' | 'updateTaskMetadata'>,
  taskId: string,
  reason: string | null,
  runner: { usesSandbox(): boolean; isRunning(runName: string): Promise<boolean> },
  runName: string,
): Promise<void> {
  if (!reason) return;
  if (!runner.usesSandbox()) return;
  if (!(await runner.isRunning(runName))) return;
  await recordEnvironmentReplaced(storage, taskId, reason);
}

/** The prompt line for a set of reasons. */
export function environmentReplacedLine(reason: string): string {
  return environmentReplacedTemplate.trim().replace('{{reason}}', () => reason);
}

/**
 * The prefix a work turn's prompt opens with: the line and a separator when a
 * replacement is pending, `''` otherwise. Does NOT clear it — call
 * {@link clearEnvironmentReplaced} once the turn has launched.
 */
export async function environmentReplacedPrefix(
  storage: Pick<Storage, 'getTaskMetadata'>,
  taskId: string,
): Promise<string> {
  const reason = await storage.getTaskMetadata(taskId, ENVIRONMENT_REPLACED_KEY);
  if (!reason) return '';
  return `${environmentReplacedLine(reason)}\n\n---\n\n`;
}

/** Clear the pending fact once a work turn carrying it has launched. */
export async function clearEnvironmentReplaced(
  storage: Pick<Storage, 'updateTaskMetadata'>,
  taskId: string,
): Promise<void> {
  await storage.updateTaskMetadata(taskId, ENVIRONMENT_REPLACED_KEY, '');
}
