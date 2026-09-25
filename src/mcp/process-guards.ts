/**
 * Process-level guards shared by every MCP server entry point.
 *
 * There are two of them — `lazy mcp` (src/index.ts, used by the host-process
 * runner) and `lazy-agent mcp` (src/agent-entry.ts, used inside containers) —
 * and they must not drift: whichever one an agent happens to be spawned from is
 * that agent's ONLY channel to lazy state for the whole turn. Only the
 * containerized entry had the keep-alive net, and the host-process entry is
 * precisely the one a stale/clobbered `~/.claude.json` points at.
 */

/**
 * Keep the server alive through an unexpected throw.
 *
 * Claude Code does not respawn an MCP server that exits, so an uncaught throw
 * removes every `lazy_*` tool for the REST OF THE TURN — that is how agents
 * ended up unable to record a journal entry or follow-ups at end of turn. Every
 * tool call already has its own error path (the server answers with a JSON-RPC
 * error and stays up), so anything reaching here is by definition not a reason
 * to take the whole channel down: log it loudly on stderr (stdout is the
 * protocol channel) and keep serving.
 *
 * Install this ONLY in an MCP server process. The supervisor and builder must
 * keep failing loudly, since there a crash is visible and recoverable.
 */
export function installMcpKeepAlive(): void {
  process.on('uncaughtException', (err) => {
    console.error(`[lazy-mcp] uncaught exception (server staying up): ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`[lazy-mcp] unhandled rejection (server staying up): ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });
}

/**
 * Report a startup failure and exit non-zero.
 *
 * Startup failed, so there is no server to keep alive — say why on stderr
 * (Claude Code otherwise reports only an opaque connection error) rather than
 * lingering as a process that serves nothing.
 */
export function reportMcpStartupFailure(err: unknown): never {
  console.error(`[lazy-mcp] server failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
}
