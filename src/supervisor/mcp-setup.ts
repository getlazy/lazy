/**
 * Per-turn MCP wiring for the agent Claude Code is about to run.
 *
 * WHY EVERY TURN, NOT ONCE PER TASK: `~/.claude.json` — where Claude Code
 * discovers MCP servers — is NOT persisted for a task. The supervisor container
 * mounts `<worktree>/.lazy-task-sandbox/.claude` at `/home/user/.claude`, but
 * `/home/user/.claude.json` sits beside that mount on the container's own
 * ephemeral filesystem. A container relaunch (the normal case for a task that
 * has been blocked for a while — its container is long gone) starts with no MCP
 * entry at all. That is exactly how ask turns lost their lazy tools: the ask
 * path was the one agent-running path that never wrote this file, so an ask into
 * a freshly launched container reported "the lazy MCP tools are currently
 * disconnected" and could not query live task state.
 *
 * INVARIANT: every supervisor path that runs an agent calls this first, so the
 * config in the container always describes THIS turn — including its read-only
 * scope. `test/unit/supervisor-mcp-setup.test.ts` enforces it.
 */

import { hostname } from 'os';
import { writeMcpConfig, writeCursorMcpConfig, writeToolPermissions } from '../mcp/config';
import { ensureCursorHttp1Config, cursorCliConfigPath } from '../agent/cursor-cli-config';
import { allTools } from '../mcp/tools';
import { READ_ONLY_TOOL_NAMES } from '../mcp/tool-access';
import { log as supervisorLog, logWarn as supervisorLogWarn } from './log';
import type { Runner } from '../runner';

/**
 * The turn could not be given its lazy tools.
 *
 * Thrown rather than logged: see the note on `prepareTurnMcp`. The supervisor's
 * top-level handler turns this into an error response for the turn, so the
 * failure reaches the human instead of dying in a container log.
 */
export class McpToolsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolsUnavailableError';
  }
}

/** Sink for this module's two log lines. Injectable so tests can assert on them. */
export interface TurnMcpLog {
  info: (message: string) => void;
  warn: (message: string) => void;
}

const defaultLog: TurnMcpLog = { info: supervisorLog, warn: supervisorLogWarn };

export interface TurnMcpOptions {
  /**
   * Scope the turn to tools that cannot mutate state (ask turns).
   *
   * This is the layer that actually holds for containerized agents: proxy tool
   * calls execute in the daemon, which never sees the supervisor's
   * LAZY_MCP_READ_ONLY env var, so the in-handler guard alone would let a write
   * tool through. The flag reaches the in-container MCP server, which withholds
   * the write tools before anything is proxied.
   */
  readOnly?: boolean;
  /**
   * The turn's agent id. Cursor discovers MCP servers via ~/.cursor/mcp.json,
   * not ~/.claude.json, so its config file is written IN ADDITION when the
   * agent is cursor. Defaults to claude-code behavior when omitted.
   */
  agentId?: string;
}

/**
 * Write this turn's MCP server entry and tool permissions.
 *
 * FAILS THE TURN when the MCP server entry cannot be written (throws
 * McpToolsUnavailableError). This used to be caught and logged as "non-fatal:
 * Claude Code will work without MCP tools (they just won't be available)", and
 * that judgement was wrong in a way that cost days of diagnosis: an agent with
 * no `lazy_*` tools is a BROKEN turn, not a degraded one. It cannot read task
 * history, record follow-ups, commit through lazy, or reach any lazy state at
 * all — it just does the work with the wrong picture and no way to say so. The
 * only trace was one warn line inside the container's supervisor log, which is
 * exactly where nobody looks. Per CLAUDE.md ("never swallow, always surface";
 * "errors are for humans, not for code") this must reach the human as a turn
 * failure they can see and act on.
 */
export async function prepareTurnMcp(
  runner: Runner,
  taskId: string,
  worktreePath: string,
  opts: TurnMcpOptions,
  log: TurnMcpLog = defaultLog,
): Promise<void> {
  const readOnly = opts.readOnly === true;

  try {
    const mcpConfig = runner.mcpServerConfig(taskId, worktreePath, { readOnly });
    await writeMcpConfig(mcpConfig);
    if (opts.agentId === 'cursor') {
      // Cursor reads ~/.cursor/mcp.json; without this the cursor agent runs
      // with no lazy_* tools at all. The ~/.claude.json write above stays —
      // in-container merge turns still run claude.
      await writeCursorMcpConfig(mcpConfig);
    }
    log.info(
      `[supervisor] Wrote MCP config for task ${taskId.substring(0, 8)}` +
      `${readOnly ? ' (read-only toolset)' : ''}` +
      `${opts.agentId === 'cursor' ? ' (claude + cursor discovery files)' : ''}`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Name every fact the human needs to act on, per CLAUDE.md's "errors are
    // actionable": WHICH task lost its tools, WHERE it was running (in a
    // container the hostname is the container id), and the underlying cause —
    // typically LAZY_DAEMON_CONFIG unset, or a config path that is unreadable
    // from inside the container.
    throw new McpToolsUnavailableError(
      `Could not register the lazy MCP tools for task ${taskId.substring(0, 8)}, ` +
      `so this turn would have run with NO lazy_* tools at all — refusing to run it.\n` +
      `  Container/host: ${hostname()}\n` +
      `  Turn scope: ${readOnly ? 'read-only' : 'write'}\n` +
      `  Cause: ${detail}\n` +
      `An agent without lazy tools cannot read task history, record follow-ups, or ` +
      `reach any lazy state, so its turn is not trustworthy. Check the daemon is running ` +
      `(\`lazy daemon status\`) and re-run the turn; \`lazy doctor\` reports launch-path problems.`,
    );
  }

  // Cursor's CLI config rides on this chokepoint rather than on each of the four
  // supervisor call sites: this function is the enforced per-turn place to write
  // "the files this turn's agent will read out of its ephemeral HOME", and that
  // is exactly what ~/.cursor/cli-config.json is. Without it cursor's agent
  // stream either fails against lazy's HTTP/1.1 proxy or routes around it — see
  // src/agent/cursor-cli-config.ts. FAILS THE TURN for the same reason the MCP
  // write does: silently running unproxied would leave no audit trail at all.
  if (opts.agentId === 'cursor') {
    try {
      if (await ensureCursorHttp1Config()) {
        log.info(
          `[supervisor] Set network.useHttp1ForAgent in ${cursorCliConfigPath()} ` +
          `— cursor's agent stream needs HTTP/1.1 to reach lazy's proxy`,
        );
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new McpToolsUnavailableError(
        `Could not write ${cursorCliConfigPath()} for task ${taskId.substring(0, 8)}, so this ` +
        `cursor turn would run with its agent stream unable to reach lazy's audit proxy — ` +
        `refusing to run it.\n  Cause: ${detail}\n` +
        `Fix or move that file aside and re-run the turn.`,
      );
    }
  }

  // Pre-approve so Claude Code doesn't prompt for permission mid-turn. A
  // read-only turn approves only the read-only tools: an unapproved write tool
  // is one more thing standing between a misbehaving model and a mutation.
  //
  // DELIBERATE ASYMMETRY with the config write above, which fails the turn.
  // Losing permissions is genuinely degraded-but-working: the tools are
  // registered and callable, the agent is merely prompted to approve each one
  // the first time. Under an agent that auto-approves (or a permission mode
  // that bypasses) the turn is unaffected; at worst the agent asks. That is a
  // real difference in kind from having no tools at all, so this half stays
  // non-fatal on purpose — do not "make it consistent" by throwing here.
  try {
    const toolNames = readOnly ? [...READ_ONLY_TOOL_NAMES] : allTools.map(t => t.name);
    await writeToolPermissions(toolNames);
    log.info(`[supervisor] Pre-approved ${toolNames.length} MCP tools`);
  } catch (err) {
    log.warn(`[supervisor] Failed to write tool permissions: ${err instanceof Error ? err.message : err}`);
  }
}
