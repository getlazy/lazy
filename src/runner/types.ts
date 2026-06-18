/**
 * Runner abstraction — decouples task execution from Docker.
 *
 * A Runner knows how to launch supervisors, check if they're alive,
 * collect logs/exit codes, and clean up. Two implementations:
 *   - DockerRunner:      wraps existing Docker container lifecycle
 *   - HostProcessRunner: spawns native processes (for use in VMs)
 */

import type { SandboxConfig } from '../capture/claude';
import type { AgentResponse } from '../types';
import type { RunnerType, RoleTarget } from '../config/types';
import type { HealthCheck } from '../remote/driver';

export type { RunnerType } from '../config/types';
export type { HealthCheck };

/** Information about a run (container or process). */
export interface RunInfo {
  running: boolean;
  exitCode: number;
  finishedAt: string | null;
}

/** Handle for following a run's output in real-time. */
export interface FollowHandle {
  /** The underlying process (for Docker: `docker logs --follow`, for host: tail -f on log file). */
  process: { kill: () => void };
  /** Readable stream of stdout output for line-by-line processing. */
  stdout: ReadableStream<Uint8Array> | null;
  /** Promise that resolves when the follow ends. */
  exited: Promise<number>;
}

export interface Runner {
  readonly type: RunnerType;

  /**
   * Set the fully-resolved per-role model targets (from config.models.roles).
   * The runner uses the `builder` target for builder launches and the `agent`
   * target for task/supervisor launches — to inject the right backend env vars
   * and to preflight reachability before launch. Optional: when unset (e.g. the
   * in-container supervisor's runner), both roles default to the anthropic
   * backend, preserving credential-inheritance behavior.
   */
  setRoleTargets(targets: { builder: RoleTarget; agent: RoleTarget }): void;

  /**
   * Pre-flight check. Throws if the runner infrastructure is not available
   * (e.g., Docker not installed, claude not on PATH).
   */
  checkAvailability(): Promise<void>;

  /**
   * Ensure infrastructure is ready (Docker image built, agent binary compiled, etc.).
   * Called before first launch. Idempotent.
   */
  ensureReady(): Promise<void>;

  /** Get the identifier name for a task's run (container name or PID-based name). */
  runNameForTask(taskShortId: string): string;

  /**
   * Launch a supervisor. Returns immediately after the supervisor process/container
   * is started in the background.
   */
  launchSupervisor(
    sandbox: SandboxConfig,
    runName: string,
    protocolDir: string,
    debug?: boolean,
    daemonConfigPath?: string,
  ): Promise<void>;

  /**
   * Run Claude synchronously. Used by pair command for summary generation.
   * Returns parsed JSON response.
   */
  runClaudeSync(
    prompt: string,
    sandbox: SandboxConfig,
    verbose?: boolean,
    debug?: boolean,
    model?: string,
  ): Promise<AgentResponse>;

  /** Check if a run is currently active. */
  isRunning(runName: string): Promise<boolean>;

  /** Check if a run exists (active or stopped). */
  runExists(runName: string): Promise<boolean>;

  /** Get detailed info about a run. Returns null if not found. */
  getRunInfo(runName: string): Promise<RunInfo | null>;

  /** Get exit code of a stopped run. Returns null if still running or not found. */
  getRunExitCode(runName: string): Promise<number | null>;

  /** Get logs from a run. */
  getRunLogs(runName: string, tailLines?: number): Promise<string | null>;

  /** Stop a running process/container. Returns true if successfully stopped. */
  stopRun(runName: string): Promise<boolean>;

  /** Remove/cleanup a stopped run (container rm, PID file cleanup). */
  removeRun(runName: string): Promise<void>;

  /** List all running lazy runs (container names or run names). */
  discoverRunningRuns(): Promise<string[]>;

  /**
   * List builder run names that belong to the given project root.
   *
   * Builders are launched via `launchBuilderInteractive` and — unlike task
   * supervisors — have no corresponding entity in storage, so ownership
   * cannot be reconciled via a task-id lookup. Implementations must use a
   * runner-specific mechanism to identify project ownership (DockerRunner
   * uses a container label; host-process mode has no builder runs).
   */
  discoverProjectBuilderRuns(projectRoot: string): Promise<string[]>;

  /**
   * Start following a run's output for live display.
   * Returns a handle to the follow process, or null if not supported.
   * @param since - Optional ISO timestamp; only show logs after this time (Docker --since).
   */
  followOutput(runName: string, since?: string): FollowHandle | null;

  /**
   * Whether this runner uses a sandbox directory for Claude session files.
   * Docker mode: true (session files live in .lazy-task-sandbox/.claude/).
   * Host-process mode: false (session files live in ~/.claude/).
   */
  usesSandbox(): boolean;

  /**
   * Absolute directory where THIS runner's Claude Code session JSONL files
   * land for the given worktree. The runner is the single source of truth for
   * this location because it depends on the HOME the runner gives Claude:
   *   - sandbox runners (docker/podman):
   *       <worktree>/.lazy-task-sandbox/.claude/projects/<encodedPath>
   *   - host-process runner:
   *       <host-home>/.claude/projects/<encodedPath>
   *
   * Callers that tail or discover the agent's session log (`lazy watch`, the
   * supervisor's graceful-exit recovery, the activity monitor) ask the runner
   * rather than guessing or scanning every candidate location.
   */
  agentSessionProjectDir(worktreePath: string): string;

  /**
   * Tool checks the supervisor should run before starting work.
   * Each runner knows what tools its environment requires.
   */
  supervisorToolChecks(): { cmd: string; name: string; hint: string }[];

  /**
   * MCP server config for Claude Code integration.
   * Returns the command and args that Claude Code should use to spawn the MCP server.
   */
  mcpServerConfig(taskId: string, worktreePath: string): { command: string; args: string[] };

  /** Human-readable label for the run in CLI output (e.g., "Container", "Process"). */
  readonly runLabel: string;

  /**
   * Human-readable display name for a specific run in CLI output.
   * Docker returns the container name; host-process returns "PID <pid>".
   */
  runDisplayName(runName: string): string;

  /**
   * Runner-specific health checks for `lazy doctor`.
   * Each runner knows what infrastructure it needs and returns appropriate checks.
   * DockerRunner checks Docker; HostProcessRunner checks `claude` on PATH; etc.
   * Follows the same HealthCheck pattern as remote driver's checkHealth().
   */
  diagnose(): Promise<HealthCheck[]>;

  // ----- Prompt support -----

  /**
   * Get runner-specific instructions for agent system prompts.
   * Returns a prompt fragment describing the agent's runtime environment.
   * Docker/Podman: tells agent it runs as root and can install packages.
   * Host-process: empty (agent runs in user's native environment).
   */
  getAgentInstructions(): string;

  /**
   * Get runner-specific instructions for the builder system prompt.
   * Returns a prompt fragment describing the builder's environment constraints.
   * This is injected into the builder prompt via the {{RUNNER_INSTRUCTIONS}} placeholder.
   */
  getBuilderInstructions(): string;

  /**
   * Launch the builder interactively.
   *
   * Docker mode: goes through the supervisor with MCP proxy and HTTP server.
   * Host-process mode: launches Claude Code directly (no supervisor/proxy).
   * Both modes capture the conversation into storage after exit.
   *
   * @param lazyRoot           Repo root path
   * @param systemPrompt       Full builder system prompt
   * @param builderConfigPath  Path to the builder config JSON (empty string in host-process mode)
   * @param claudeExtraArgs    Additional args for Claude Code (e.g., --model)
   * @param debug              Enable debug logging
   * @param daemonConfigPath   Optional path to daemon MCP config (preferred over builder server)
   * @param projectsDir        Optional host dir to mount at ~/.claude/projects so
   *                           this builder gets an isolated Claude projects dir
   *                           (per-builder session ownership). Ignored by runners
   *                           that cannot isolate the projects dir (host-process).
   * @returns Exit code and detected session ID (if available)
   */
  launchBuilderInteractive(
    lazyRoot: string,
    systemPrompt: string,
    builderConfigPath: string,
    claudeExtraArgs: string[],
    debug?: boolean,
    daemonConfigPath?: string,
    projectsDir?: string,
  ): Promise<{ exitCode: number; sessionId: string | null }>;
}
