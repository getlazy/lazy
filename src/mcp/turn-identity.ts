/**
 * Fail-closed binding between an agent and ITS OWN task's MCP server.
 *
 * THE HOLE THIS CLOSES
 * --------------------
 * Claude Code discovers MCP servers in exactly one place: `$HOME/.claude.json`.
 * Lazy rewrites the `mcpServers.lazy` entry there before every turn, stamping in
 * that turn's `--task-id` and `--worktree` (see supervisor/mcp-setup.ts and
 * mcp/config.ts). There is one such file per HOME, so two agents that share a
 * HOME share the entry: whichever supervisor wrote last decides which task the
 * OTHER agent's `lazy_*` tools operate on. Containerized tasks are unaffected
 * (each has its own HOME inside its container), but every host-process
 * supervisor writes the real one.
 *
 * That is not theoretical. A leaked e2e supervisor (host-process runner, its
 * temp worktree already deleted) rewrote the entry while a real agent was
 * working; the agent's next `lazy_commit` was served against the test task and
 * failed with "working directory '/tmp/lazy-e2e-.../worktrees/...' does not
 * exist". The tool channel had silently changed owners.
 *
 * We cannot give each host-process agent its own HOME — HOME is also where
 * Claude Code finds its credentials — so the entry stays shared, and the
 * binding is enforced at the other end instead: the supervisor exports the task
 * it is about to run, and the MCP server refuses to start if the entry it was
 * spawned from names a different one. An agent therefore either reaches its own
 * task's server or gets NO tools with a loud reason — never another task's
 * server. The "no tools" case is itself already fatal and visible: the turn is
 * aborted by the MCP verification in supervisor/work.ts.
 *
 * These are ordinary production env vars, not test-only hatches: the supervisor
 * sets them on every turn, in every runner.
 */

/** Full UUID of the task whose turn this process tree belongs to. */
export const MCP_EXPECTED_TASK_ID_ENV = 'LAZY_MCP_EXPECTED_TASK_ID';
/** Worktree that task's turn is running in. */
export const MCP_EXPECTED_WORKTREE_ENV = 'LAZY_MCP_EXPECTED_WORKTREE';

/** The MCP server was spawned for a different task than the turn it landed in. */
export class McpTurnIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpTurnIdentityError';
  }
}

export interface McpServerClaim {
  /** `--task-id` the server was spawned with (empty/undefined in builder mode). */
  taskId?: string;
  /** `--worktree` the server was spawned with. */
  worktreePath?: string;
}

/**
 * Verify that this MCP server serves the turn that spawned it.
 *
 * No-op when the expectation is absent — the builder and any hand-run
 * `lazy mcp` have no turn to be checked against, and an unset variable must
 * never be treated as a mismatch.
 *
 * @throws McpTurnIdentityError when the claim disagrees with the expectation.
 */
export function assertMcpServesExpectedTurn(
  claim: McpServerClaim,
  env: Record<string, string | undefined> = process.env,
): void {
  const expectedTaskId = env[MCP_EXPECTED_TASK_ID_ENV];
  if (!expectedTaskId) return;

  const expectedWorktree = env[MCP_EXPECTED_WORKTREE_ENV];
  const taskMatches = claim.taskId === expectedTaskId;
  const worktreeMatches = !expectedWorktree || claim.worktreePath === expectedWorktree;
  if (taskMatches && worktreeMatches) return;

  throw new McpTurnIdentityError(
    `Refusing to serve lazy MCP tools: this server was configured for a different task ` +
    `than the turn it was spawned in.\n` +
    `  This turn expects: task ${expectedTaskId}` +
    `${expectedWorktree ? ` in ${expectedWorktree}` : ''}\n` +
    `  The MCP entry says: task ${claim.taskId || '(none)'}` +
    `${claim.worktreePath ? ` in ${claim.worktreePath}` : ''}\n` +
    `Claude Code reads ONE MCP config per HOME ($HOME/.claude.json), so another ` +
    `lazy supervisor sharing this HOME overwrote the entry — commonly a stray ` +
    `\`lazy supervise\` process from an earlier run. Find it with ` +
    `\`ps ax | grep "lazy supervise"\` and kill it, then re-run this turn. ` +
    `Serving the other task's tools instead would have let this agent read and ` +
    `write the wrong task, so this process exits with no tools rather than the ` +
    `wrong ones.`,
  );
}

/** The worktree this MCP server is bound to no longer exists on disk. */
export class McpWorktreeMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpWorktreeMissingError';
  }
}

/**
 * Verify the worktree a tool is about to operate in still exists.
 *
 * The startup check above catches a server that was spawned from a hijacked
 * entry. This catches the same incident from the other side — a server whose
 * worktree was deleted UNDER it (an e2e temp dir cleaned up mid-turn, a task
 * accepted and its worktree removed) — and, for a server started with no
 * expectation to check against, it is the only guard there is.
 *
 * Without it the agent sees git's own wording, `fatal: cannot change to
 * '/tmp/lazy-e2e-…': No such file or directory`, which names a directory it has
 * never heard of and suggests nothing to do about it.
 *
 * @throws McpWorktreeMissingError when the path is gone.
 */
export async function assertWorktreeUsable(
  toolName: string,
  worktreePath: string,
  taskId?: string,
): Promise<void> {
  const { stat } = await import('fs/promises');
  try {
    const info = await stat(worktreePath);
    if (info.isDirectory()) return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Anything other than "it is not there" is a real filesystem problem
    // (permissions, I/O) and must surface as itself, not as a stale-cwd story.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new Error(`${toolName}: cannot access worktree ${worktreePath}: ${(err as Error).message}`);
    }
  }
  throw new McpWorktreeMissingError(
    `${toolName} cannot run: the worktree this lazy MCP server is bound to no longer exists.\n` +
    `  Worktree: ${worktreePath}\n` +
    `  Task:     ${taskId || '(builder)'}\n` +
    `This server is serving a turn whose worktree has been deleted, or its entry in ` +
    `$HOME/.claude.json was overwritten by another lazy supervisor sharing this HOME ` +
    `(one MCP config per HOME) — a stray \`lazy supervise\` from an earlier run is the ` +
    `usual cause; find it with \`ps ax | grep "lazy supervise"\`. Your own files are ` +
    `untouched: nothing was read or written in the missing directory. Report this rather ` +
    `than retrying — every lazy_* tool on this connection is bound to the same dead path.`,
  );
}
