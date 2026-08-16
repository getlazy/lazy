/**
 * Access classification for every agent-facing MCP tool.
 *
 * One table, deliberately hand-maintained: whether a tool can mutate state is a
 * judgement call about that tool's effects, not something derivable from its
 * schema. `test/unit/mcp-tool-access-coverage.test.ts` asserts the table covers
 * exactly the tools in `allTools`, so a newly added tool cannot silently default
 * to either side — the author has to classify it.
 *
 * This module deliberately imports nothing. The read-only name list is needed by
 * the runners (to pre-approve builder tools) and by the MCP server entry points
 * (to serve a read-only toolset during ask turns); dragging in tools.ts — and
 * with it the whole handler graph — for a list of names would be gratuitous.
 *
 * 'read' means the tool cannot change task state, worktree contents, or launch
 * an agent. `lazy_wait` is read: it polls and returns, it does not start work.
 * `lazy_ask` is a WRITE — it launches an agent turn on another task.
 */

export type ToolAccess = 'read' | 'write';

export const TOOL_ACCESS: Readonly<Record<string, ToolAccess>> = {
  // --- Reads ---
  lazy_search: 'read',
  lazy_show: 'read',
  lazy_list: 'read',
  lazy_blocked: 'read',
  lazy_active: 'read',
  lazy_diff: 'read',
  lazy_status: 'read',
  lazy_wait: 'read',
  lazy_conversations: 'read',
  lazy_conversation_search: 'read',
  lazy_conversation_read: 'read',
  lazy_memory_recall: 'read',

  // --- Writes ---
  lazy_create: 'write',
  lazy_start: 'write',
  lazy_unblock: 'write',
  lazy_ask: 'write',
  // Writes nothing — the conversation is immutable and the answer goes to the
  // caller — but it launches a throwaway agent, and 'read' means "cannot launch
  // an agent". Classified by effect, not by what it persists.
  lazy_conversation_ask: 'write',
  lazy_accept: 'write',
  lazy_reject: 'write',
  lazy_close: 'write',
  lazy_stop: 'write',
  lazy_submit: 'write',
  lazy_resume: 'write',
  lazy_edit: 'write',
  lazy_clone: 'write',
  lazy_reopen: 'write',
  lazy_redo: 'write',
  lazy_sync: 'write',
  lazy_reparent: 'write',
  lazy_prioritize: 'write',
  lazy_comment: 'write',
  lazy_journal: 'write',
  lazy_tag: 'write',
  lazy_untag: 'write',
  lazy_add_followup: 'write',
  lazy_commit: 'write',
  lazy_memory_save: 'write',
};

/** Tool names that cannot mutate state, in table order. */
export const READ_ONLY_TOOL_NAMES: readonly string[] = Object.entries(TOOL_ACCESS)
  .filter(([, access]) => access === 'read')
  .map(([name]) => name);

/**
 * Is this tool safe to expose on a read-only turn?
 *
 * An UNKNOWN name answers false. Fail closed: a tool nobody classified is not
 * one we can promise is harmless.
 */
export function isReadOnlyTool(name: string): boolean {
  return TOOL_ACCESS[name] === 'read';
}
