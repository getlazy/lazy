/**
 * Runner abstraction — decouples task execution from Docker.
 *
 * A Runner knows how to launch supervisors, check if they're alive,
 * collect logs/exit codes, and clean up. Two implementations:
 *   - DockerRunner:      wraps existing Docker container lifecycle
 *   - HostProcessRunner: spawns native processes (for use in VMs)
 */

import type { SandboxConfig } from '../capture/claude';
import type { ClaudeResponse } from '../types';
import type { RunnerType } from '../config/types';
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
   * Pre-flight check. Throws if the runner infrastructure is not available
   * (e.g., Docker not installed, claude not on PATH).
   */
  checkAvailability(): void;

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
  ): Promise<ClaudeResponse>;

  /** Check if a run is currently active. */
  isRunning(runName: string): boolean;

  /** Check if a run exists (active or stopped). */
  runExists(runName: string): boolean;

  /** Get detailed info about a run. Returns null if not found. */
  getRunInfo(runName: string): RunInfo | null;

  /** Get exit code of a stopped run. Returns null if still running or not found. */
  getRunExitCode(runName: string): number | null;

  /** Get logs from a run. */
  getRunLogs(runName: string, tailLines?: number): string | null;

  /** Stop a running process/container. Returns true if successfully stopped. */
  stopRun(runName: string): boolean;

  /** Remove/cleanup a stopped run (container rm, PID file cleanup). */
  removeRun(runName: string): void;

  /** List all running lazy runs (container names or run names). */
  discoverRunningRuns(): string[];

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
  diagnose(): HealthCheck[];

  // ----- Builder support -----

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
   * @returns Exit code from the Claude Code session
   */
  launchBuilderInteractive(
    lazyRoot: string,
    systemPrompt: string,
    builderConfigPath: string,
    claudeExtraArgs: string[],
    debug?: boolean,
  ): Promise<number>;
}
