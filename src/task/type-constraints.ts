/**
 * Per-TYPE behavioural constraints injected into a task agent's turn prompt.
 *
 * Two different mechanisms carry type constraints today, and the difference is
 * deliberate:
 *
 *   - `lazy fix` / `lazy document` / `lazy refactor` bake their constraints
 *     into the task's stored PROMPT at creation time. Those are methodology
 *     notes for work the agent does once; the human can edit them afterwards,
 *     and a task created another way simply does not get them.
 *
 *   - A `cluster` task's constraints ride the TURN, every turn, and are resolved
 *     from `task.type` here. A driver's rules are not advice about how to
 *     approach the work — they are the contract for a task that runs for many
 *     turns and is created from four different surfaces. Baking them into the
 *     prompt at creation would mean a cluster created through `lazy_create`, the
 *     dashboard form or `lazy edit --type cluster` ran without them, and a prompt
 *     edit could silently drop them mid-cluster.
 *
 * This section is deliberately NOT part of the system prompt: it is per-task
 * conditional text, which `src/context-budget.ts` documents as out of scope
 * for the "before the first message" measurement.
 */

import type { Task, TaskType } from '../types';

import clusterConstraints from '../prompts/cluster-constraints.md' with { type: 'text' };

/** Constraint text by task type. Types absent here contribute nothing. */
const CONSTRAINTS_BY_TYPE: Partial<Record<TaskType, string>> = {
  cluster: clusterConstraints,
};

/**
 * The constraints block for a task's type, ready to layer into a turn prompt,
 * or `''` when the type has none (every type but `cluster` today).
 *
 * Returns a trailing separator so the caller can concatenate layers without
 * knowing whether this one is present.
 */
export function typeConstraintsSection(task: Pick<Task, 'type'> | null | undefined): string {
  if (!task?.type) return '';
  const text = CONSTRAINTS_BY_TYPE[task.type];
  if (!text) return '';
  return `${text}\n\n---\n\n`;
}
