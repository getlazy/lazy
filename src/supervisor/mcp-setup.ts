/**
 * Per-turn MCP wiring for the agent Claude Code is about to run.
 *
 * WHY EVERY TURN, NOT ONCE PER TASK: `~/.claude.json` — where Claude Code
 * discovers MCP servers — must be present on every container launch. Task
 * containers mount `<worktree>/.lazy-task-sandbox/.claude.json` at
 * `/home/user/.claude.json` (see src/task/claude-home.ts); `prepareTurnMcp`
 * merges the lazy MCP entry into that file each turn. Pairing on a container
 * that predates the mount copies the sandbox file onto the ephemeral path first.
 *
 * INVARIANT: every supervisor path that runs an agent calls this first, so the
 * config in the container always describes THIS turn — including its read-only
 * scope. `test/unit/supervisor-mcp-setup.test.ts` enforces it.
 */

import { hostname } from 'os';
import { writeMcpConfig, writeCursorMcpConfig, writeToolPermissions } from '../mcp/config';
import { MCP_EXPECTED_TASK_ID_ENV, MCP_EXPECTED_WORKTREE_ENV } from '../mcp/turn-identity';
import { ensureCursorHttp1Config, cursorCliConfigPath } from '../agent/cursor-cli-config';
import {
  writePiBridgeExtension,
  writePiModelsConfig,
  writePiSettingsConfig,
  piBridgeExtensionPath,
  piModelsConfigPath,
  piSettingsConfigPath,
} from '../agent/pi-turn-config';
import { writeCodexConfig, codexConfigPath } from '../agent/codex-config';
import { CODEX_ENDPOINT_ENV } from '../proxy/codex-route';
import { toolNamesForRole } from '../mcp/tool-surface';
import type { McpToolset } from '../mcp/tool-access';
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
   * Turn toolset. Prefer this over the legacy `readOnly` boolean.
   * - `full` — work turns
   * - `read` — ask turns (inert tools only)
   * - `review` — agent review (reads + lazy_raise)
   */
  toolset?: McpToolset;
  /**
   * Scope the turn to tools that cannot mutate state (ask turns).
   *
   * This is the layer that actually holds for containerized agents: proxy tool
   * calls execute in the daemon, which never sees the supervisor's
   * LAZY_MCP_READ_ONLY env var, so the in-handler guard alone would let a write
   * tool through. The flag reaches the in-container MCP server, which withholds
   * the write tools before anything is proxied.
   *
   * Ignored when `toolset` is set.
   */
  readOnly?: boolean;
  /**
   * The turn's HARNESS — which agent binary runs — not the profile name.
   *
   * Every writer below keys off it: cursor discovers MCP servers via
   * ~/.cursor/mcp.json rather than ~/.claude.json, pi has no MCP at all and
   * needs its bridge extension, codex needs its config.toml. Defaults to
   * claude-code behavior when omitted.
   *
   * It must be the harness, because a profile name need not equal one: a
   * project with `[agents.local-ollama-pi] harness = "pi"` would match none of
   * these branches, and the pi turn would run with no lazy tools and its model
   * traffic unpinned from the audit proxy — the exact failures the throws below
   * exist to prevent. The daemon resolves profile → harness and states it on
   * the command; see the note above `CommandType` in src/protocol/types.ts.
   */
  harness?: string;
  /**
   * The model THIS turn runs — `cmd.model_id` for a supervised turn, the task's
   * persisted model for a pair session.
   *
   * Only pi's models.json needs it, and only for a custom-provider profile: such
   * a provider offers exactly the models the file declares, and it declares THIS
   * model and nothing else, so a pi turn can only ever run the task's sticky
   * model. Omitting it for such a profile fails the turn (see
   * writePiModelsConfig).
   */
  model?: string;
}

function resolveTurnToolset(opts: TurnMcpOptions): McpToolset {
  if (opts.toolset) return opts.toolset;
  return opts.readOnly === true ? 'read' : 'full';
}

function toolsetScopeLabel(toolset: McpToolset): string {
  if (toolset === 'review') return 'review (reads + lazy_raise)';
  if (toolset === 'read') return 'read-only';
  return 'write';
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
  const toolset = resolveTurnToolset(opts);
  const scopeLabel = toolsetScopeLabel(toolset);

  // Declare, for this process tree, which task's tools the agent is allowed to
  // be given. The agent inherits the supervisor's environment (see
  // executeAgent), and so does the MCP server Claude Code spawns from
  // ~/.claude.json — which is a SHARED file: another supervisor with the same
  // HOME can overwrite the entry between this write and the spawn. The server
  // checks these against its own arguments and refuses to serve a different
  // task rather than silently handing this agent another task's tool channel.
  // See src/mcp/turn-identity.ts.
  process.env[MCP_EXPECTED_TASK_ID_ENV] = taskId;
  process.env[MCP_EXPECTED_WORKTREE_ENV] = worktreePath;

  try {
    const mcpConfig = runner.mcpServerConfig(taskId, worktreePath, { toolset });
    await writeMcpConfig(mcpConfig);
    if (opts.harness === 'codex') {
      // Codex reads BOTH its lazy_* MCP entry and its model-provider routing
      // from ~/.codex/config.toml, so one managed write covers them. The proxy
      // base arrives via the launch env (see src/proxy/codex-route.ts) — its
      // absence here means the launch wiring failed, and running anyway would
      // dial api.openai.com directly with no audit record, so this throws into
      // the same fail-the-turn path as a failed MCP write.
      const proxyBaseUrl = process.env[CODEX_ENDPOINT_ENV];
      if (!proxyBaseUrl) {
        throw new Error(
          `${CODEX_ENDPOINT_ENV} is not set in this turn's environment, so lazy cannot point ` +
          `codex at its audit proxy (${codexConfigPath()} would route to api.openai.com directly). ` +
          `This is a launch-wiring fault, not a credentials problem — check \`lazy daemon status\` ` +
          `and relaunch the turn.`,
        );
      }
      await writeCodexConfig({ proxyBaseUrl, mcpServer: mcpConfig });
    }
    if (opts.harness === 'cursor') {
      // Cursor reads ~/.cursor/mcp.json; without this the cursor agent runs
      // with no lazy_* tools at all. The ~/.claude.json write above stays: it
      // is cheap, and it keeps any claude one-shot in this container (and a
      // human who attaches) working.
      await writeCursorMcpConfig(mcpConfig);
    }
    if (opts.harness === 'pi') {
      // pi has no MCP support at all — its lazy_* tools arrive via the bridge
      // extension lazy writes into the turn's HOME. Without this the pi agent
      // runs with no lazy tools, which is the same BROKEN turn the throw above
      // guards against for Claude Code.
      await writePiBridgeExtension(mcpConfig);
    }
    log.info(
      `[supervisor] Wrote MCP config for task ${taskId.substring(0, 8)}` +
      `${toolset !== 'full' ? ` (${scopeLabel} toolset)` : ''}` +
      `${opts.harness === 'cursor' ? ' (claude + cursor discovery files)' : ''}` +
      `${opts.harness === 'pi' ? ' (claude discovery file + pi bridge extension)' : ''}` +
      `${opts.harness === 'codex' ? ' (claude + codex config.toml: MCP + proxy provider)' : ''}`,
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
      `  Turn scope: ${scopeLabel}\n` +
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
  if (opts.harness === 'cursor') {
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

  // pi's provider routing rides the same chokepoint and fails the turn for the
  // same reason cursor's cli-config does: models.json is what pins pi's
  // provider base URLs to lazy's proxy, so a turn that ran without it would
  // dial api.anthropic.com directly — unaudited and with a placeholder that
  // authenticates nothing there.
  if (opts.harness === 'pi') {
    try {
      await writePiModelsConfig({ turnModel: opts.model });
      log.info(
        `[supervisor] Wrote ${piModelsConfigPath()} — pi provider base URLs pinned to lazy's proxy ` +
        `(bridge at ${piBridgeExtensionPath()})`,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new McpToolsUnavailableError(
        `Could not write ${piModelsConfigPath()} for task ${taskId.substring(0, 8)}, so this ` +
        `pi turn would run with its model traffic not pinned to lazy's audit proxy — ` +
        `refusing to run it.\n  Cause: ${detail}`,
      );
    }

    // pi's own request idle timeout defaults to 300s, which is SHORTER than
    // lazy's proxy ceiling (30 min): a request that takes 5+ minutes dies at
    // pi's client-side timeout while the proxy is still serving it — the exact
    // shape of the 2026-09-16 local-Ollama incident. The launch env states the
    // proxy ceiling; this write turns it into pi's settings value, so the
    // chokepoint fails the turn rather than run one that self-destructs.
    try {
      await writePiSettingsConfig();
      log.info(
        `[supervisor] Wrote ${piSettingsConfigPath()} — pi's request idle timeout pinned above ` +
        `lazy's proxy ceiling`,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new McpToolsUnavailableError(
        `Could not write ${piSettingsConfigPath()} for task ${taskId.substring(0, 8)}, so this ` +
        `pi turn would keep pi's 300s request timeout and die while the proxy was still serving ` +
        `it — refusing to run it.\n  Cause: ${detail}`,
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
    // Role 'agent': prepareTurnMcp only ever runs for a task turn, and a builder-only
    // tool is not advertised to it, so pre-approving one would be noise.
    const toolNames = toolNamesForRole('agent', { toolset });
    await writeToolPermissions(toolNames);
    log.info(`[supervisor] Pre-approved ${toolNames.length} MCP tools`);
  } catch (err) {
    log.warn(`[supervisor] Failed to write tool permissions: ${err instanceof Error ? err.message : err}`);
  }
}
