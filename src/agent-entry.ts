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
 *   doctor:   In-container MCP diagnosis (why does the agent have no lazy tools?).
 */

// Enables top-level await in TypeScript module context
export {};

// The sentinel this binary prints for `selfcheck`, and the same string the host
// greps for INSIDE the file to prove a candidate is really the compiled agent
// (a Linux cross-compile a macOS host cannot exec). One definition keeps the
// printed sentinel and the content check from drifting apart.
import { AGENT_SELFCHECK_SENTINEL } from './agent/binary-identity';

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`lazy-agent — supervisor, MCP server, and builder for lazy containers

Usage:
  lazy-agent --protocol-dir <path> --worktree <path>   Run supervisor (default)
  lazy-agent mcp [--task-id <uuid>] --worktree <path>   Start MCP server
  lazy-agent builder --system-prompt-file <path> --worktree <path>   Run builder
  lazy-agent doctor [--probe-agent] [--json]           Diagnose MCP wiring here

The default mode runs the supervisor loop: it watches for commands from the
host via the protocol directory and manages work phases (sync, work, etc.).

The mcp subcommand starts a stdio-based MCP server that exposes lazy tools
to Claude Code. It is spawned automatically by Claude Code via ~/.claude.json.

The builder subcommand runs the builder supervisor: it launches Claude Code
interactively and captures the conversation. MCP config is set up by the host.

The doctor subcommand diagnoses this container's lazy MCP wiring end to end,
including a live tool count that "claude mcp list" cannot report.

Options:
  --protocol-dir <path>       Protocol directory (supervisor mode)
  --worktree <path>           Worktree path (all modes)
  --task-id <uuid>            Task UUID (mcp mode)
  --system-prompt-file <path> System prompt file (builder mode)
  --lazy-cli <json-array>     CLI command for lifecycle tools (builder mode)
  --one-shot                  Process one command then exit (supervisor mode)
  --help, -h                  Show this help`);
}

// Self-identification guardrail.
//
// A fast, side-effect-free way to prove this binary is the compiled lazy agent
// and not a bare Bun runtime (or a stale/placeholder file) mistakenly mounted at
// /usr/local/bin/lazy-agent. When the wrong file is mounted there, Claude Code's
// MCP child (`lazy-agent mcp …`) exits immediately — the builder silently loses
// all lazy_* tools with only an opaque "Failed to reconnect to lazy: -32000" in
// Claude's logs. The builder-startup preflight (see supervisor/builder.ts) execs
// `lazy-agent selfcheck` and greps for this sentinel, turning that silent failure
// into an actionable error.
//
// A bare Bun binary prints its own version for --version/--revision and errors
// "Script not found selfcheck" for the subcommand — so both the presence of the
// sentinel and the exit code distinguish the real agent from bare Bun.
if (command === 'selfcheck' || command === '--version' || command === '-v' || command === '--revision') {
  const { VERSION } = await import('./version');
  // Sentinel string the preflight matches on. Keep 'lazy-agent ok' stable.
  console.log(`${AGENT_SELFCHECK_SENTINEL} ${VERSION}`);
  process.exit(0);
}

// Handle doctor subcommand
//
// Deliberately placed before every other subcommand's argument parsing: doctor
// is what a human runs from a bare `docker exec -it <container> bash` when the
// agent has no lazy tools, so it must work with no arguments and no environment
// beyond what the container already has.
if (command === 'doctor') {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: lazy-agent doctor [--probe-agent] [--json]

Diagnose this container's lazy MCP wiring. Answers the question \`claude mcp list\`
cannot: "✔ Connected" there proves only that the MCP server process starts and
answers \`initialize\` — never that it registered any tools, and never that Claude
Code loaded them into the agent's own process.

Checks, in order: the daemon MCP config the container was launched with;
~/.claude.json's lazy server entry; the mcp__lazy__* tool permissions;
read-only (ask) mode; a live MCP session that reports the actual TOOL COUNT;
and one real read-only tool call through to the daemon.

Exits non-zero if any check fails. The daemon bearer token is never printed.

Options:
  --probe-agent   Also start a REAL \`claude\` process (\`claude -p 'ok'\`), read
                  only its first stream-json line, and report which MCP servers
                  and lazy tools Claude Code itself loaded, then kill it. This
                  starts an actual agent process and may bill a request.
  --json          Machine-readable output`);
    process.exit(0);
  }

  const { runAgentDoctor, formatAgentDoctorReport } = await import('./agent/doctor');
  const result = await runAgentDoctor({
    probeAgent: args.includes('--probe-agent'),
    json: args.includes('--json'),
  });

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatAgentDoctorReport(result));
  }
  process.exit(result.ok ? 0 : 1);
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
  --builder-id <id>            Stable builder id; stamps sessionId onto its resume intent on exit
  -- <args...>                 Additional args passed to Claude Code`);
    process.exit(0);
  }

  const worktreeIdx = args.indexOf('--worktree');
  const promptFileIdx = args.indexOf('--system-prompt-file');
  const builderConfigIdx = args.indexOf('--builder-config');
  const daemonConfigIdx = args.indexOf('--daemon-config');
  const builderIdIdx = args.indexOf('--builder-id');
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
  const builderId = (builderIdIdx !== -1 && builderIdIdx + 1 < args.length)
    ? args[builderIdIdx + 1]
    : undefined;
  const claudeExtraArgs = dashDashIdx !== -1 ? args.slice(dashDashIdx + 1) : undefined;

  const { runBuilderSupervisor } = await import('./supervisor/builder');
  await runBuilderSupervisor({
    worktreePath,
    systemPromptFile,
    builderConfigPath,
    daemonConfigPath,
    builderId,
    claudeExtraArgs,
    debug: args.includes('--debug'),
  });
} else if (command === 'mcp') {
// Handle mcp subcommand
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: lazy-agent mcp [--task-id <uuid>] --worktree <path> [--daemon-config <path>] [--builder-config <path>] [--read-only]

Start a stdio-based MCP server that exposes lazy tools to Claude Code.
The server reads JSON-RPC requests from stdin and writes responses to stdout.

Options:
  --task-id <uuid>           Full UUID of the current task (optional for builder mode)
  --worktree <path>          Path to the worktree or repo root (required)
  --daemon-config <path>     Path to daemon MCP config for proxy mode (preferred)
  --builder-config <path>    Path to builder config JSON for legacy proxy mode
  --read-only                Serve only read-only tools (used for ask turns)

When --daemon-config is provided, the MCP server runs in daemon proxy mode: tool
calls are forwarded to the daemon's /mcp routes over HTTP. This is the preferred
mode — the daemon executes tools with full host access.

When --builder-config is provided (legacy), tool calls are forwarded to a
per-session builder HTTP server over TCP.

When neither proxy config is provided, tools execute locally.

With --read-only, only tools that cannot mutate state are advertised. A write
tool called anyway is refused with a message telling the agent to answer in text.

When --task-id is omitted, the MCP server runs in project-scoped (builder) mode.
Tools that require a task context (lazy_commit) are unavailable.

The MCP server is spawned automatically by Claude Code via ~/.claude.json.`);
    process.exit(0);
  }

  const taskIdIdx = args.indexOf('--task-id');
  const worktreeIdx = args.indexOf('--worktree');
  const daemonConfigIdx = args.indexOf('--daemon-config');
  const builderConfigIdx = args.indexOf('--builder-config');
  // Read-only turns (ask) get a toolset with the write tools withheld. The
  // supervisor writes this flag into ~/.claude.json per turn — see
  // src/supervisor/mcp-setup.ts.
  const readOnly = args.includes('--read-only');

  if (worktreeIdx === -1 || worktreeIdx + 1 >= args.length) {
    console.error('Missing required flag: --worktree <path>');
    process.exit(1);
  }

  // Keep this process alive through an unexpected throw.
  //
  // This process IS the agent's only channel to lazy state. Claude Code does not
  // respawn an MCP server that exits, so any uncaught throw here — a rejected
  // promise from an async path the per-call handlers do not cover, an error on
  // an idle socket — silently removes every lazy_* tool for the REST OF THE TURN.
  // That is how agents ended up unable to record a journal entry or follow-ups
  // at end of turn. Every tool call already has its own error path (the server
  // answers with a JSON-RPC error and stays up), so anything reaching here is by
  // definition not a reason to take the whole channel down: log it loudly on
  // stderr (stdout is the protocol channel) and keep serving.
  //
  // Scoped to `mcp` deliberately — the supervisor and builder paths must keep
  // failing loudly, since there a crash is visible and recoverable.
  process.on('uncaughtException', (err) => {
    console.error(`[lazy-mcp] uncaught exception (server staying up): ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`[lazy-mcp] unhandled rejection (server staying up): ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });

  try {
    // Daemon proxy mode (preferred): forward all tool calls to the daemon
    if (daemonConfigIdx !== -1 && daemonConfigIdx + 1 < args.length) {
      const daemonConfigPath = args[daemonConfigIdx + 1];
      // Task ID override: the supervisor passes --task-id to scope tool calls to
      // the correct task. A task config now also carries its own taskId (the
      // identity its token is bound to); the two must agree, and the daemon
      // refuses the call if the claim disagrees with the token.
      const taskIdOverride = (taskIdIdx !== -1 && taskIdIdx + 1 < args.length) ? args[taskIdIdx + 1] : undefined;
      const { startMcpServerDaemonProxy } = await import('./mcp/index');
      await startMcpServerDaemonProxy(daemonConfigPath, taskIdOverride, { readOnly });
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
      await startMcpServer({ taskId, worktreePath }, { readOnly });
    }
  } catch (err) {
    // Startup failed, so there is no server to keep alive — say why on stderr
    // (Claude Code otherwise reports only an opaque connection error) and exit
    // non-zero rather than lingering as a process that serves nothing.
    console.error(`[lazy-mcp] server failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
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
