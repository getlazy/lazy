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
  lazy_regions: 'read',
  lazy_status: 'read',
  lazy_wait: 'read',
  lazy_conversations: 'read',
  lazy_conversation_search: 'read',
  lazy_conversation_read: 'read',
  lazy_memory_recall: 'read',
  // Read-only by construction: builders write scratch by writing FILES into
  // $LAZY_SCRATCH_DIR, and capture persists them. There is no write tool.
  lazy_scratch: 'read',
  // Pure read by design: it never marks messages read (read state tracks the
  // human, set by `lazy messages read`) — see createMessagesHandler.
  lazy_messages: 'read',
  // Pure read of the proxy's latest readings and the pause state.
  lazy_usage_limits: 'read',
  lazy_raised_items: 'read',
  lazy_raised_promote: 'write',
  lazy_artifact_list: 'read',
  lazy_artifact_get: 'read',

  // --- Writes ---
  lazy_create: 'write',
  lazy_start: 'write',
  lazy_unblock: 'write',
  lazy_ask: 'write',
  lazy_review: 'write',
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
  lazy_link: 'write',
  lazy_comment: 'write',
  lazy_journal: 'write',
  lazy_tag: 'write',
  lazy_untag: 'write',
  lazy_raise: 'write',
  // Writes no task state and starts nothing, but it records a claim the accept
  // gate will read and drops a marker the supervisor acts on. Classified by
  // effect, like lazy_update_progress: 'read' is the promise that a tool is inert.
  lazy_final: 'write',
  lazy_raised_item_comment: 'write',
  lazy_report: 'write',
  lazy_justify_protected: 'write',
  lazy_justify_maintain: 'write',
  lazy_artifact_add: 'write',
  // Writes no task state, no worktree, launches nothing — but it does write a
  // per-turn observability marker the daemon owns, and 'read' is the promise
  // that a tool is inert. Classified by effect: an ask turn's contract is "your
  // final message is the answer, call no tools", so there is nothing for a
  // progress line to narrate there either.
  lazy_update_progress: 'write',
  lazy_commit: 'write',
  lazy_memory_save: 'write',
  lazy_message_post: 'write',
  lazy_message_dismiss: 'write',
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

/**
 * Write tools a review turn may call. Findings are Raises — the reviewer files
 * them with `lazy_raise` and otherwise stays read-only (no commits, no edits).
 */
export const REVIEW_WRITE_TOOLS = ['lazy_raise'] as const;

/**
 * MCP toolset for one turn.
 *
 * - `full` — work turns (every classified tool the role may see)
 * - `read` — ask turns (inert tools only)
 * - `review` — agent review turns (reads + {@link REVIEW_WRITE_TOOLS})
 */
export type McpToolset = 'full' | 'read' | 'review';

/**
 * May this tool be advertised / called on the given toolset?
 *
 * Unknown names fail closed on every non-full toolset.
 */
export function isToolAllowedOnToolset(name: string, toolset: McpToolset): boolean {
  if (toolset === 'full') return name in TOOL_ACCESS;
  if (toolset === 'read') return isReadOnlyTool(name);
  return isReadOnlyTool(name) || (REVIEW_WRITE_TOOLS as readonly string[]).includes(name);
}

/** Resolve CLI flags (`--read-only`, `--review`) into a toolset. */
export function mcpToolsetFromFlags(flags: {
  readOnly?: boolean;
  review?: boolean;
}): McpToolset {
  if (flags.review) return 'review';
  if (flags.readOnly) return 'read';
  return 'full';
}
