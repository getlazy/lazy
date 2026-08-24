/**
 * Which agent should a NEWLY CREATED task run on?
 *
 * This exists because the storage layer is not a safe place to decide it.
 * `Storage.createTask()` stamps `agent_id: agentId ?? 'claude-code'` (see
 * `file-storage.ts` / `postgres-storage.ts`), so a caller that passes nothing
 * does not leave the field open for the project default to fill in later — it
 * silently pins the new task to Claude Code, forever. Storage cannot fix that
 * itself: resolving the default requires lazy.toml, and a storage backend has
 * no business loading project config.
 *
 * So every creation path has to decide explicitly, and this is the one place
 * that decision lives. Call it wherever a task is created.
 *
 * Precedence, highest first:
 *   1. `explicit`     — the user said so (`--agent`, or the MCP `agent` field).
 *   2. `inheritFrom`  — the task this one is DERIVED from (clone source, redo
 *                       original, parent of a subtask). A clone of a Cursor
 *                       task is still a Cursor task; the project default must
 *                       not quietly retarget it.
 *   3. `configDefault`— the project's `[agent] agent_id`, for a fresh task
 *                       that is not derived from anything.
 */
export function resolveAgentForNewTask(opts: {
  /** An explicit user choice, if one was given. Already validated by the caller. */
  explicit?: string | null;
  /** The task this one is derived from, for clone/redo/subtask. */
  inheritFrom?: { agent_id?: string | null } | null;
  /** The project's configured default (`config.agent.agent_id`). */
  configDefault: string;
}): string {
  return opts.explicit || opts.inheritFrom?.agent_id || opts.configDefault;
}
