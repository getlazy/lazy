/**
 * Shell wrapper around `lazy-agent` for Claude Code's lazy MCP server entry.
 *
 * Claude Code respawns the MCP child on connection loss — including after a
 * daemon restart or `lazy upgrade` that rewrote the bind-mounted binary. A bare
 * Bun runtime mounted at /usr/local/bin/lazy-agent dies with "Script not found
 * mcp" before our TypeScript ever runs; a compiled but wrong file fails the
 * builder's launch preflight but NOT a mid-session reconnect, because the first
 * spawn succeeded against an earlier binary.
 *
 * This wrapper runs `lazy-agent selfcheck` on every spawn attempt and exits
 * non-zero with an actionable message when the mount is not the compiled agent,
 * so Claude's reconnect surfaces the fix instead of a silent -32000.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { AGENT_SELFCHECK_SENTINEL } from '../agent/binary-identity';

/** Default agent binary the wrapper execs after selfcheck passes. */
export const DEFAULT_AGENT_BINARY = 'lazy-agent';

/**
 * Write a per-launch shell script that selfcheck-gates every MCP spawn.
 *
 * Lives beside other per-launch builder temp files; the container bind-mounts
 * it read-only and ~/.claude.json points `mcpServers.lazy.command` at it.
 */
export async function writeMcpLaunchWrapper(opts: {
  tmpDir: string;
  builderId: string;
  /** Binary to exec after selfcheck (default {@link DEFAULT_AGENT_BINARY}). */
  agentBinary?: string;
}): Promise<string> {
  const agentBinary = opts.agentBinary ?? DEFAULT_AGENT_BINARY;
  const path = join(opts.tmpDir, `lazy-mcp-wrapper-${opts.builderId}.sh`);
  const script = `#!/bin/sh
# Lazy MCP launch wrapper — selfcheck before every Claude Code reconnect spawn.
if ! ${agentBinary} selfcheck 2>/dev/null | grep -q '${AGENT_SELFCHECK_SENTINEL}'; then
  echo "[lazy-mcp] The lazy-agent binary at /usr/local/bin/lazy-agent failed selfcheck after an upgrade or rebuild." >&2
  echo "[lazy-mcp] lazy_* tools cannot reconnect until it is fixed. On the HOST, run: bun run build, then lazy upgrade" >&2
  echo "[lazy-mcp] Then retry your lazy tool call — Claude Code will respawn the MCP server automatically." >&2
  exit 1
fi
exec ${agentBinary} "$@"
`;
  await writeFile(path, script, { mode: 0o755 });
  return path;
}

/**
 * Container path for a host-written wrapper bind-mounted at the same absolute
 * path (docker-runner uses host paths for bind mounts).
 */
export function mcpWrapperContainerCommand(wrapperHostPath: string): string {
  return wrapperHostPath;
}
