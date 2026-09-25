/**
 * Which MCP tools each caller ROLE is served.
 *
 * There are two roles, and the signal is the task id the caller's identity is
 * bound to: a task agent always has one, the builder's is `''`. Every tool named
 * below already REFUSES the wrong role inside its handler (see the `ctx.taskId`
 * guards in tools.ts) — several of those refusals are security boundaries, not
 * conveniences. This table does not replace them: it stops a tool the caller can
 * never successfully call from being ADVERTISED to it, so the model does not pay
 * for its schema in every prompt.
 *
 * The two layers are deliberately separate. Advertisement is a context-cost
 * decision and lives here; the refusal is the enforcement and stays in the
 * handler, where it also covers a caller that invokes a hidden tool from a stale
 * context. `test/unit/mcp-tool-roles.test.ts` asserts every name below still
 * matches a real tool, and that the handler refusal is still there.
 *
 * This module deliberately imports nothing, for the same reason tool-access.ts
 * does not: the runners need the name lists to pre-approve tools without
 * dragging in the whole handler graph.
 */

export type McpRole = 'builder' | 'agent';

/**
 * Tools only a TASK AGENT can call. Each one acts on "the current task", which
 * the builder does not have — its handler throws "not available in builder
 * mode".
 */
export const AGENT_ONLY_TOOL_NAMES: readonly string[] = [
  // Declaring a task done is a claim about work you did, in the turn you did it
  // — there is deliberately no `lazy_final` for a task you do not own, and no
  // builder surface for declaring someone else's final.
  'lazy_final',
  'lazy_raise',
  'lazy_raised_item_comment',
  'lazy_report',
  'lazy_justify_protected',
  'lazy_justify_maintain',
  'lazy_update_progress',
  'lazy_commit',
];

/**
 * Tools only the BUILDER (acting for the human) can call.
 *
 * Two different reasons, both enforced in the handlers:
 * - vetting/curation acts an agent must not perform on its own work —
 *   `lazy_memory_save` (injected into every future session),
 *   `lazy_raised_promote` (turning your own raised item into a backlog task),
 *   `lazy_message_dismiss` (clearing the human's inbox), and `lazy_scratch`
 *   (the builder↔human channel);
 * - task-tree operations whose result lands OUTSIDE the agent's own subtree —
 *   `lazy_clone`, `lazy_redo` and `lazy_reparent` all parent a task somewhere
 *   the agent may not write.
 */
export const BUILDER_ONLY_TOOL_NAMES: readonly string[] = [
  'lazy_memory_save',
  'lazy_scratch',
  'lazy_raised_promote',
  'lazy_message_dismiss',
  'lazy_clone',
  'lazy_redo',
  'lazy_reparent',
];

const AGENT_ONLY = new Set(AGENT_ONLY_TOOL_NAMES);
const BUILDER_ONLY = new Set(BUILDER_ONLY_TOOL_NAMES);

/**
 * The role a caller with this task id acts as.
 *
 * Builder ⇔ empty task id. That equivalence is set at the `lazy-agent mcp`
 * argv boundary (builder launches pass no `--task-id`) and is the same signal
 * every handler guard reads, so advertisement and enforcement cannot disagree.
 */
export function roleForTaskId(taskId: string | undefined | null): McpRole {
  return taskId ? 'agent' : 'builder';
}

/** Is this tool advertised to this role? Unknown names are served (fail open). */
export function isToolForRole(name: string, role: McpRole): boolean {
  if (role === 'builder') return !AGENT_ONLY.has(name);
  return !BUILDER_ONLY.has(name);
}
