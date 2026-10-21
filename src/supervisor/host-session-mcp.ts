/**
 * The lazy MCP server a HOST pairing session hands its agent.
 *
 * In the container, `lazy pair <task>` gets its lazy_* tools from
 * `prepareTurnMcp`, which writes the container's own `~/.claude.json` and points
 * it at the task's daemon MCP config (its token). On the host neither half is
 * available: `~/.claude.json` is the human's real file — host pairing must
 * never write the host home (test/unit/pair-no-host-home-writes.test.ts) — and
 * the daemon's config files carry the container address. So this:
 *
 *   1. asks the daemon for the task's OWN token (`getTaskMcpConfig`,
 *      src/daemon/task-mcp-config.ts) — the same identity the container's
 *      server presents, refused unless the task is `pairing`;
 *   2. writes a private copy (a fresh `mkdtemp` dir, mode 0700, files 0600)
 *      with the loopback address this CLI reaches the daemon on;
 *   3. hands Claude Code `--mcp-config <file> --strict-mcp-config`, whose one
 *      server is `lazy mcp --daemon-config …`: the same daemon-proxy server the
 *      container runs, so every call is the daemon's to authorise
 *      (src/daemon/mcp-turn-authority.ts) exactly as it is for the container;
 *   4. removes the directory when the session ends.
 *
 * It is re-done on every (re)launch — the interactive supervisor relaunches
 * after a daemon restart, and the daemon's port may have moved with it.
 */

import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { getDaemonTcpTarget } from '../daemon/lifecycle';
import { queryTaskMcpConfig } from '../daemon/rpc-fallback';
import type { TaskMcpConfigResult } from '../daemon/task-mcp-config';
import type { DaemonMcpConfigFile } from '../daemon/mcp-proxy';
import { MCP_EXPECTED_TASK_ID_ENV, MCP_EXPECTED_WORKTREE_ENV } from '../mcp/turn-identity';
import { toolNamesForRole } from '../mcp/tool-surface';
import type { McpToolset } from '../mcp/tool-access';
import { getLazyCommand } from '../utils/cli-path';
import { logger } from '../utils/logger';

/** Name of the one MCP server the session gets — what `mcp__lazy__*` tool names are keyed on. */
const SERVER_NAME = 'lazy';

export interface HostSessionMcpOptions {
  root: string;
  /** Full task id: the token's identity and the server's `--task-id`. */
  taskId: string;
  worktreePath: string;
  /** `full` for pairing; `read` for a reflective session. */
  toolset: McpToolset;
  /** Injectable for tests; the daemon RPC by default. */
  fetchConfig?: (params: { taskId: string }) => Promise<TaskMcpConfigResult>;
  /** Injectable for tests; the daemon's loopback address by default. */
  daemonTarget?: (root: string) => string | null;
  /** Injectable for tests; the running lazy CLI by default. */
  lazyCommand?: () => string[];
}

/** What one launch adds to the agent's argv and environment. */
export interface HostSessionMcpLaunch {
  args: string[];
  env: Record<string, string>;
  /** The `--mcp-config` file, for diagnostics and tests. */
  mcpConfigPath: string;
}

export interface HostSessionMcp {
  /** (Re)write the config for one launch. Throws when the tools cannot be given. */
  prepare(): Promise<HostSessionMcpLaunch>;
  /** Remove the private config directory. Idempotent; never throws. */
  dispose(): Promise<void>;
}

function toolsetFlag(toolset: McpToolset): string[] {
  if (toolset === 'review') return ['--review'];
  if (toolset === 'read') return ['--read-only'];
  return [];
}

export function createHostSessionMcp(opts: HostSessionMcpOptions): HostSessionMcp {
  const fetchConfig = opts.fetchConfig ?? queryTaskMcpConfig;
  const daemonTarget = opts.daemonTarget ?? getDaemonTcpTarget;
  const lazyCommand = opts.lazyCommand ?? getLazyCommand;
  let dir: string | null = null;

  return {
    async prepare() {
      const config = await fetchConfig({ taskId: opts.taskId });
      if (config.taskId !== opts.taskId) {
        // The daemon answers for the task it was asked about; anything else is
        // a bug, and handing the agent another task's token would be the worst
        // way to find it.
        throw new Error(
          `The daemon returned an MCP token for task ${config.taskId}, not ${opts.taskId} — refusing to use it.`,
        );
      }
      const target = daemonTarget(opts.root);
      if (!target) {
        throw new Error(
          `Cannot give the paired agent its lazy tools: no daemon address is recorded for ${opts.root}. ` +
          'Check `lazy daemon status`.',
        );
      }

      // mkdtemp creates the directory 0700, so nobody else can even list it.
      dir ??= await mkdtemp(join(tmpdir(), 'lazy-pair-mcp-'));
      const daemonConfigPath = join(dir, 'daemon-mcp.json');
      const mcpConfigPath = join(dir, 'claude-mcp.json');

      const daemonConfig: DaemonMcpConfigFile = {
        token: config.token,
        projectRoot: config.projectRoot,
        taskId: config.taskId,
        target,
      };
      // 0600: the file carries the task's bearer token.
      await writeFile(daemonConfigPath, JSON.stringify(daemonConfig, null, 2), { mode: 0o600 });

      const [command, ...prefix] = lazyCommand();
      const server = {
        command,
        args: [
          ...prefix,
          'mcp',
          '--daemon-config', daemonConfigPath,
          '--task-id', opts.taskId,
          '--worktree', opts.worktreePath,
          ...toolsetFlag(opts.toolset),
        ],
      };
      await writeFile(
        mcpConfigPath,
        JSON.stringify({ mcpServers: { [SERVER_NAME]: server } }, null, 2),
        { mode: 0o600 },
      );

      // Pre-approved on the command line, never in ~/.claude/settings.json as a
      // container turn does it: the host settings file is the human's.
      const allowed = toolNamesForRole('agent', { toolset: opts.toolset })
        .map((name) => `mcp__${SERVER_NAME}__${name}`);

      return {
        args: [
          '--mcp-config', mcpConfigPath,
          // Only this server: not the human's own ~/.claude.json servers, and not
          // a `.mcp.json` the task's agent may have committed to the worktree.
          '--strict-mcp-config',
          '--allowedTools', allowed.join(','),
        ],
        // The server refuses to start for any other task than this pairing's
        // (src/mcp/turn-identity.ts), and this overrides a value inherited from
        // whatever shell the human ran `lazy pair` in.
        env: {
          [MCP_EXPECTED_TASK_ID_ENV]: opts.taskId,
          [MCP_EXPECTED_WORKTREE_ENV]: opts.worktreePath,
        },
        mcpConfigPath,
      };
    },

    async dispose() {
      if (!dir) return;
      const toRemove = dir;
      dir = null;
      try {
        await rm(toRemove, { recursive: true, force: true });
      } catch (err) {
        // A leftover 0700 temp dir is not worth failing the end of a session
        // over, but the token in it is — say where it is.
        logger.warn(
          `Warning: could not remove the pairing session's MCP config at ${toRemove}: ` +
          `${err instanceof Error ? err.message : String(err)}. Delete it by hand; it holds the task's MCP token.`,
        );
      }
    },
  };
}
