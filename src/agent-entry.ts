#!/usr/bin/env bun

/**
 * Lazy agent binary — runs inside containers.
 *
 * Default mode: supervisor loop (container entrypoint). Watches for commands
 * from the host via the protocol directory and runs work phases.
 *
 * Subcommands:
 *   mcp:      MCP server (spawned by Claude Code as a child process for tool
 *             access via stdio JSON-RPC).
 *   builder:  Builder supervisor (runs an interactive Claude Code session with
 *             MCP tools and conversation capture).
 */

// Enables top-level await in TypeScript module context
export {};

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`lazy-agent — supervisor, MCP server, and builder for lazy containers

Usage:
  lazy-agent --protocol-dir <path> --worktree <path>   Run supervisor (default)
  lazy-agent mcp [--task-id <uuid>] --worktree <path>   Start MCP server
  lazy-agent builder --system-prompt-file <path> --worktree <path>   Run builder

The default mode runs the supervisor loop: it watches for commands from the
host via the protocol directory and manages work phases (sync, work, etc.).

The mcp subcommand starts a stdio-based MCP server that exposes lazy tools
to Claude Code. It is spawned automatically by Claude Code via ~/.claude.json.

The builder subcommand runs the builder supervisor: it launches Claude Code
interactively and captures the conversation. MCP config is set up by the host.

Options:
  --protocol-dir <path>       Protocol directory (supervisor mode)
  --worktree <path>           Worktree path (all modes)
  --task-id <uuid>            Task UUID (mcp mode)
  --system-prompt-file <path> System prompt file (builder mode)
  --lazy-cli <json-array>     CLI command for lifecycle tools (builder mode)
  --one-shot                  Process one command then exit (supervisor mode)
  --help, -h                  Show this help`);
}

// Handle builder subcommand
if (command === 'builder') {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: lazy-agent builder --system-prompt-file <path> --worktree <path> --builder-config <path> [options]

Run the builder supervisor: launches Claude Code interactively and captures the
conversation into lazy's storage. MCP config is prepared by the host-side runner.

Options:
  --system-prompt-file <path>  Path to the system prompt file (required)
  --worktree <path>            Path to the repo root (required)
  --builder-config <path>      Path to builder config JSON (host + port + token) (required)
  --daemon-config <path>       Path to daemon MCP config (preferred over builder-config)
  -- <args...>                 Additional args passed to Claude Code`);
    process.exit(0);
  }

  const worktreeIdx = args.indexOf('--worktree');
  const promptFileIdx = args.indexOf('--system-prompt-file');
  const builderConfigIdx = args.indexOf('--builder-config');
  const daemonConfigIdx = args.indexOf('--daemon-config');
  const dashDashIdx = args.indexOf('--');

  if (worktreeIdx === -1 || worktreeIdx + 1 >= args.length) {
    console.error('Missing required flag: --worktree <path>');
    process.exit(1);
  }
  if (promptFileIdx === -1 || promptFileIdx + 1 >= args.length) {
    console.error('Missing required flag: --system-prompt-file <path>');
    process.exit(1);
  }
  if (builderConfigIdx === -1 || builderConfigIdx + 1 >= args.length) {
    console.error('Missing required flag: --builder-config <path>');
    process.exit(1);
  }

  const worktreePath = args[worktreeIdx + 1];
  const systemPromptFile = args[promptFileIdx + 1];
  const builderConfigPath = args[builderConfigIdx + 1];
  const daemonConfigPath = (daemonConfigIdx !== -1 && daemonConfigIdx + 1 < args.length)
    ? args[daemonConfigIdx + 1]
    : undefined;
  const claudeExtraArgs = dashDashIdx !== -1 ? args.slice(dashDashIdx + 1) : undefined;

  const { runBuilderSupervisor } = await import('./supervisor/builder');
  await runBuilderSupervisor({
    worktreePath,
    systemPromptFile,
    builderConfigPath,
    daemonConfigPath,
    claudeExtraArgs,
    debug: args.includes('--debug'),
  });
} else if (command === 'mcp') {
// Handle mcp subcommand
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: lazy-agent mcp [--task-id <uuid>] --worktree <path> [--daemon-config <path>] [--builder-config <path>]

Start a stdio-based MCP server that exposes lazy tools to Claude Code.
The server reads JSON-RPC requests from stdin and writes responses to stdout.

Options:
  --task-id <uuid>           Full UUID of the current task (optional for builder mode)
  --worktree <path>          Path to the worktree or repo root (required)
  --daemon-config <path>     Path to daemon MCP config for proxy mode (preferred)
  --builder-config <path>    Path to builder config JSON for legacy proxy mode

When --daemon-config is provided, the MCP server runs in daemon proxy mode: tool
calls are forwarded to the daemon's /mcp routes over HTTP. This is the preferred
mode — the daemon executes tools with full host access.

When --builder-config is provided (legacy), tool calls are forwarded to a
per-session builder HTTP server over TCP.

When neither proxy config is provided, tools execute locally.

When --task-id is omitted, the MCP server runs in project-scoped (builder) mode.
Tools that require a task context (lazy_commit, lazy_propose) are unavailable.

The MCP server is spawned automatically by Claude Code via ~/.claude.json.`);
    process.exit(0);
  }

  const taskIdIdx = args.indexOf('--task-id');
  const worktreeIdx = args.indexOf('--worktree');
  const daemonConfigIdx = args.indexOf('--daemon-config');
  const builderConfigIdx = args.indexOf('--builder-config');

  if (worktreeIdx === -1 || worktreeIdx + 1 >= args.length) {
    console.error('Missing required flag: --worktree <path>');
    process.exit(1);
  }

  // Daemon proxy mode (preferred): forward all tool calls to the daemon
  if (daemonConfigIdx !== -1 && daemonConfigIdx + 1 < args.length) {
    const daemonConfigPath = args[daemonConfigIdx + 1];
    // Task ID override: the daemon config template has taskId='' (empty).
    // The supervisor passes --task-id to scope tool calls to the correct task.
    const taskIdOverride = (taskIdIdx !== -1 && taskIdIdx + 1 < args.length) ? args[taskIdIdx + 1] : undefined;
    const { startMcpServerDaemonProxy } = await import('./mcp/index');
    await startMcpServerDaemonProxy(daemonConfigPath, taskIdOverride);
  } else if (builderConfigIdx !== -1 && builderConfigIdx + 1 < args.length) {
    // Legacy builder proxy mode: forward to per-session builder HTTP server
    const builderConfigPath = args[builderConfigIdx + 1];
    const { startMcpServerProxy } = await import('./mcp/index');
    await startMcpServerProxy(builderConfigPath);
  } else {
    // Normal mode: execute tools locally
    const taskId = (taskIdIdx !== -1 && taskIdIdx + 1 < args.length) ? args[taskIdIdx + 1] : '';
    const worktreePath = args[worktreeIdx + 1];
    const { startMcpServer } = await import('./mcp/index');
    await startMcpServer({ taskId, worktreePath });
  }
} else {
  // Default mode: supervisor
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }

  const protocolDirIdx = args.indexOf('--protocol-dir');
  const worktreeIdx = args.indexOf('--worktree');

  if (protocolDirIdx === -1 || protocolDirIdx + 1 >= args.length) {
    console.error('Missing required flag: --protocol-dir <path>');
    usage();
    process.exit(1);
  }
  if (worktreeIdx === -1 || worktreeIdx + 1 >= args.length) {
    console.error('Missing required flag: --worktree <path>');
    usage();
    process.exit(1);
  }

  const protocolDir = args[protocolDirIdx + 1];
  const worktreePath = args[worktreeIdx + 1];
  const oneShot = args.includes('--one-shot');

  const { runSupervisor } = await import('./supervisor/index');
  await runSupervisor({ protocolDir, worktreePath, oneShot });
}
