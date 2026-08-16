/**
 * Verify, from the agent's OWN session-start report, that the turn actually got
 * its lazy tools.
 *
 * WHY THIS EXISTS: `prepareTurnMcp` proves only that lazy *wrote* an MCP config.
 * It cannot prove the agent read it, that the server registered any tools, or
 * that the agent's process loaded them. The incident this was written for looked
 * perfect from lazy's side — `~/.claude.json` had the entry and `claude mcp
 * list` printed "✔ Connected" — while the agent in that same container failed
 * every call with `No such tool available: lazy_status`. `mcp list` proves a
 * server starts and answers `initialize`; it never prints a tool count, and it
 * says nothing about the agent's own process.
 *
 * The agent hands us the answer on line 1 of its stream: Claude Code's init
 * event carries `mcp_servers` (with per-server status) and `tools` (the names
 * loaded in that process, MCP tools included, prefixed `mcp__<server>__`).
 *
 * This module is pure so the decision can be unit-tested without a process.
 */

import type { AgentActivityEvent } from '../agent/activity-stream';

/** MCP server name lazy registers in the agent's config. */
export const LAZY_MCP_SERVER_NAME = 'lazy';

/** Prefix Claude Code gives tools from that server, e.g. `mcp__lazy__lazy_status`. */
export const LAZY_MCP_TOOL_PREFIX = `mcp__${LAZY_MCP_SERVER_NAME}__`;

/**
 * What the agent reported about its lazy tools — small on purpose. This is what
 * gets recorded on the turn so `lazy show` can answer "did that turn have its
 * tools?" long after the container is gone.
 */
export interface McpToolObservation {
  /** Status the agent reported for the lazy server, or `absent` if unlisted. */
  serverStatus: string;
  /** How many `mcp__lazy__*` tools the agent loaded. */
  lazyToolCount: number;
}

export type McpVerification =
  /** The agent reported lazy tools. */
  | { outcome: 'ok'; observation: McpToolObservation }
  /**
   * The agent said nothing we can judge (no init event, or an init event with
   * neither field). Log and carry on — see `verifyInitMcpTools`.
   */
  | { outcome: 'unknown'; reason: string }
  /** Positive evidence the turn has NO lazy tools. */
  | { outcome: 'missing'; reason: string; observation: McpToolObservation };

/**
 * Judge a session-start event.
 *
 * TWO RULES, both load-bearing:
 *
 * 1. FAIL ONLY ON POSITIVE EVIDENCE OF ZERO. A missing init event, or an init
 *    event carrying neither `tools` nor `mcp_servers`, is `unknown` — not a
 *    failure. Absence of evidence is not evidence of absence: a future Claude
 *    Code that drops the fields, a different agent (Cursor emits no equivalent),
 *    or a parser miss must never take down a turn that was working fine.
 *
 * 2. ASSERT "AT LEAST ONE", NOT THE FULL SET. Ask turns are launched read-only
 *    (`LAZY_MCP_READ_ONLY=1`) and legitimately get only `READ_ONLY_TOOL_NAMES`,
 *    so any count-the-tools check would fail every ask turn.
 *
 * A connected server with zero tools still fails: that is precisely the observed
 * incident, and an agent with a connected-but-toolless server is as broken as
 * one with no server at all.
 */
export function verifyInitMcpTools(event: AgentActivityEvent | null | undefined): McpVerification {
  if (!event || event.kind !== 'session_start') {
    return { outcome: 'unknown', reason: 'the agent emitted no session-start event' };
  }

  const { mcpServers, toolNames } = event;
  if (mcpServers === undefined && toolNames === undefined) {
    return {
      outcome: 'unknown',
      reason: 'the agent\'s session-start event reported neither `mcp_servers` nor `tools`',
    };
  }

  const server = mcpServers?.find(s => s.name === LAZY_MCP_SERVER_NAME);
  const serverStatus = mcpServers === undefined
    ? 'unreported'
    : server
      ? (server.status ?? 'unknown')
      : 'absent';

  // `tools` unreported means we cannot count. The server list can still settle
  // it: an agent that enumerated its servers and did not list `lazy`, or listed
  // it as anything but connected, is positive evidence. Anything else is
  // unknown — this branch must never manufacture a failure out of a count we
  // do not have (rule 1).
  if (toolNames === undefined) {
    const serverLooksHealthy = server !== undefined
      && (server.status === undefined || server.status === 'connected');
    if (serverLooksHealthy) {
      return { outcome: 'unknown', reason: 'the agent reported no `tools` list to count' };
    }
    return {
      outcome: 'missing',
      reason: `the agent reported the \`${LAZY_MCP_SERVER_NAME}\` MCP server as ${serverStatus}`,
      observation: { serverStatus, lazyToolCount: 0 },
    };
  }

  const lazyToolCount = toolNames.filter(name => name.startsWith(LAZY_MCP_TOOL_PREFIX)).length;
  const observation: McpToolObservation = { serverStatus, lazyToolCount };

  if (lazyToolCount > 0 && (server === undefined || server.status === undefined || server.status === 'connected')) {
    return { outcome: 'ok', observation };
  }

  if (lazyToolCount === 0) {
    return {
      outcome: 'missing',
      reason:
        `the agent loaded ${toolNames.length} tool(s), none of them \`${LAZY_MCP_TOOL_PREFIX}*\` ` +
        `(\`${LAZY_MCP_SERVER_NAME}\` MCP server: ${serverStatus})`,
      observation,
    };
  }

  // Tools present but the server reports a non-connected status. Trust the
  // tools — they are the thing the agent can actually call — but say so.
  return { outcome: 'ok', observation };
}

/** Compact, greppable form recorded on the turn. */
export function formatMcpObservation(observation: McpToolObservation): string {
  return `${LAZY_MCP_SERVER_NAME}=${observation.serverStatus} tools=${observation.lazyToolCount}`;
}
