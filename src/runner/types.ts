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
import type { BuilderLaunchProjects } from '../builder/projects-isolation';
import type { PortBinding } from '../serve/ports';
import type { OneshotRequest } from '../oneshot/types';
import type { AuthEnvVar } from '../proxy/placeholder-env';
import type { PhaseNotify } from '../daemon/progress';

export type { RunnerType } from '../config/types';
export type { HealthCheck };

/** What a run lookup found, and whether the runtime answered at all. */
export type RunInfoProbe =
  | { kind: 'answered'; info: RunInfo | null }
  | { kind: 'no-answer'; reason: string };

/** What a caller of `Runner.diagnose` is willing to pay for. */
export interface DiagnoseOptions {
  /**
   * `false` skips every probe that STARTS a container (the image-harness
   * `--version` run). `lazy doctor` wants them; `lazy daemon health` runs on
   * demand and inside every doctor run, and must stay cheap and bounded, so it
   * passes false. Default: run them.
   */
  launchProbes?: boolean;
}

/** Inputs for a single headless builder `-p` turn (UI review session). */
export interface LaunchBuilderHeadlessParams {
  lazyRoot: string;
  systemPrompt: string;
  prompt: string;
  resumeSessionId?: string | null;
  /** Stable per-turn builder id — keys MCP identity and container name. */
  builderId: string;
  /** Host path to this turn's daemon MCP config (docker mode). */
  daemonConfigPath?: string;
  projects?: BuilderLaunchProjects;
  /** Credential env prepared by the daemon (placeholders in team mode). */
  authEnvVars: AuthEnvVar[];
  debug?: boolean;
}

/** Outcome of one headless builder turn. */
export interface LaunchBuilderHeadlessResult {
  answer: string;
  sessionId: string | null;
  exitCode: number;
}

/** Inputs for a daemon-owned, detached interactive builder session. */
export interface LaunchBuilderDetachedParams {
  lazyRoot: string;
  systemPrompt: string;
  /** Stable per-session builder id — keys the container name, MCP identity and resume intent. */
  builderId: string;
  daemonConfigPath?: string;
  projects?: BuilderLaunchProjects;
  /** Credential env prepared by the daemon (placeholders in team mode). */
  authEnvVars: AuthEnvVar[];
  /**
   * Home directory whose `.claude` subtree is mounted at the container's
   * `/home/user/.claude`, replacing the host `~/.claude` mount — a per
   * member+project Claude home rather than the launching host user's
   * (docs/design/actor-identity-and-remote-clients.md §5.5).
   */
  homeDirAbs: string;
  /** Claude session id to `--resume`, or null for a fresh session. */
  resumeSessionId?: string | null;
  debug?: boolean;
}

/** Outcome of starting a detached builder session's container. */
export interface LaunchBuilderDetachedResult {
  containerName: string;
}

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

/**
 * A raw, piped exec channel into a run — stdin/stdout/stderr as streams rather
 * than inherited, and no deadline.
 *
 * Distinct from `execInRun`, which inherits this process's stdio and bounds the
 * child: that is right for a diagnostic a human reads, and useless for tunneling
 * bytes, where the caller IS the other end of the pipe and the run may last as
 * long as someone keeps a socket open.
 */
export interface RunStream {
  /** Send bytes to the command's stdin. */
  write(chunk: Uint8Array): void;
  /** Close stdin — no more bytes are coming. */
  end(): void;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number | null>;
  kill(): void;
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
   * Override the agent role's target with the profile THIS task selected.
   *
   * `setRoleTargets` carries the role DEFAULT — what a task runs when it names
   * no agent of its own. A task that names one has to launch on that profile's
   * endpoint, credential slot and model, not the role's: without this the
   * profile would decide only where the proxy forwards, while the launch still
   * preflighted the role's upstream and demanded the role's credential (a
   * `credential = "none"` profile in a project with no Anthropic key could not
   * launch at all).
   *
   * Called by the daemon's launch paths right after `setAgent`, from the same
   * resolved profile — see src/daemon/task-harness.ts. A runner nobody calls it
   * on keeps the role default, which is the correct answer for the builder and
   * for every task that named no profile.
   */
  setAgentTarget(target: RoleTarget): void;

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
    /**
     * Short task id, threaded onto proxied agent traffic as `x-lazy-task-id` so
     * the proxy audit plane can attribute each request to its task. Optional —
     * omitted only where the caller lacks it (audit records then carry a null
     * task id, as before).
     */
    taskId?: string,
    /**
     * Full task UUID. Distinct from `taskId` above, which is the task REF (the
     * task code, or the short id before a code exists) — the ref can change and
     * is not assigned until first launch, so it is not a stable key. Used to
     * look up this task's own environment variables (`lazy env set`), which are
     * keyed by UUID in the daemon state dir. Optional: omitted only where the
     * caller lacks it, and a launch without it simply carries no per-task env.
     */
    taskUuid?: string,
    /**
     * Task-pinned container image (metadata.custom_image). When set, the docker
     * runner uses it and fails loud if missing — never falls back to root.
     * Host-process runners ignore it. Optional; Part 2 may thread daemon
     * adoption through a related seam.
     */
    pinnedImage?: string,
    /**
     * Narration sink for the launch's interior — which image is being used, why
     * a rebuild is needed, `docker build`'s own output, the container start.
     *
     * A bare callback rather than the daemon's PhaseReporter on purpose: the
     * runner narrates, it does not own the caller's checklist, and it must not
     * be able to open, close or fail a phase. Optional everywhere, and never
     * load-bearing — a launch with nobody listening behaves identically.
     */
    notify?: PhaseNotify,
  ): Promise<void>;

  /**
   * Run a MACHINE ONE-SHOT: a single prompt-in / text-out model call lazy makes
   * on its own behalf (accept's fidelity summary, a `lazy report` unit, a
   * `lazy ask` pass, memory compaction). No supervisor, no session, no resume,
   * no MCP.
   *
   * This is a Runner verb because a one-shot IS an agent run, and every
   * guarantee lazy makes about agent runs applies to it: it is isolated the way
   * this runner isolates agent turns, and it is credentialed by the same
   * machinery — so its traffic goes through the audit/policy proxy like every
   * other model call. It used to be a bare `claude -p` spawned by whoever
   * wanted one, which is how three of the four call sites ended up unable to
   * authenticate in a daemon-credential deployment, and how all four went
   * straight to Anthropic unaudited.
   *
   * Implementations MUST:
   *  - disallow write tools unconditionally (`buildOneshotAgentArgv`),
   *  - honor `req.repoAccess` — no repository at all for `none`, an unwritable
   *    one for `read-only`,
   *  - bound the run by `resolveOneshotTimeoutMs(req)`.
   *
   * See docs/oneshot-execution.md.
   */
  runOneshot(req: OneshotRequest): Promise<AgentResponse>;

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

  /**
   * `getRunInfo` for a caller that must tell "the runtime answered: there is
   * no such run" from "the runtime did not answer" — `getRunInfo` returns null
   * for both. Optional: a runner whose lookup is local and cannot fail to answer
   * (host-process reads a pid file) leaves it out, and callers fall back to
   * `getRunInfo` as an answer.
   */
  probeRunInfo?(runName: string): Promise<RunInfoProbe>;

  /** Get exit code of a stopped run. Returns null if still running or not found. */
  getRunExitCode(runName: string): Promise<number | null>;

  /** Get logs from a run. */
  getRunLogs(runName: string, tailLines?: number): Promise<string | null>;

  /**
   * Run a command INSIDE an existing run, streaming its output straight through
   * to this process's stdout/stderr, and resolve with its exit code.
   *
   * Returns null when this runner has no inside to reach — a host-process run is
   * not an environment you can enter; its agent already runs on this machine
   * with this machine's filesystem, so there is nothing a remote exec would show
   * that a local command cannot.
   *
   * Used by `lazy doctor <task-id>` to run `lazy-agent doctor` where the agent
   * actually lives. That question cannot be answered from the host: the MCP
   * config, the tool permissions and the daemon route being diagnosed are all
   * inside the container, and several of them are written per turn.
   */
  execInRun(
    runName: string,
    argv: string[],
    opts?: { timeoutMs?: number; interactive?: boolean },
  ): Promise<number | null>;

  /**
   * Open a raw, piped, unbounded exec channel into an existing run.
   *
   * The tunneling counterpart to `execInRun`: nothing is inherited and nothing
   * is timed out, because the caller is piping a live connection through it and
   * only the caller knows when that connection ends. Used by `lazy forward` to
   * carry one host connection into the environment.
   *
   * Returns null when this runner has no inside to reach, same as `execInRun`.
   */
  openRunStream(runName: string, argv: string[]): RunStream | null;

  /**
   * Live host↔environment port mappings for a run — the `[serve]` ports the
   * environment actually publishes right now.
   *
   * The RUNTIME is the source of truth, not lazy's config: host ports are
   * OS-assigned (`127.0.0.1:0`) precisely so parallel tasks cannot collide, so
   * the only way to know a task's port is to read it back. A run created before
   * a `[serve]` edit therefore reports what it was created with, which is the
   * honest answer.
   *
   * Returns null when this runner has no ports to map — a host-process run
   * shares the host's network, so its services are already on the host at the
   * ports they bound.
   */
  getRunPortBindings(runName: string): Promise<PortBinding[] | null>;

  /**
   * Stop a running process/container, and everything it started. Returns true if
   * successfully stopped.
   *
   * IMPLEMENTORS: stopping the run must stop the AGENT, not merely the
   * supervisor that launched it. A container gets this by construction — the run
   * IS the container — but a runner that spawns plain processes has to reach the
   * whole tree deliberately, or the agent is reparented to init and goes on
   * holding the worktree it was working in. See HostProcessRunner.stopRun.
   *
   * `gracefulTimeoutSeconds` SETS the window between the polite signal and the
   * kill; absent, each runner uses its own default. The defaults differ because
   * the runners genuinely differ, and neither is a bug:
   *
   *  - Docker's default is `docker kill` — an immediate SIGKILL, no grace at
   *    all, because a task container has no shutdown work worth waiting for and
   *    the wait is pure latency in the daemon's hot path. Passing the option
   *    there switches to `docker stop --time <n>`, which is a REAL behaviour
   *    change rather than a tuning knob, so pass it only when the run has exit
   *    work worth waiting for.
   *  - The host-process runner's default is SIGTERM, then SIGKILL after five
   *    seconds, because a plain process tree has no container boundary to fall
   *    back on. Passing a SMALLER number there is meaningful and honoured: the
   *    daemon's own shutdown sweep does exactly that, because it is racing a
   *    SIGKILL from whoever signalled it and a grace period that gets cut off is
   *    worse than a short one that completes.
   *
   * A BUILDER is the case with real exit work — its supervisor flushes the
   * conversation capture and stamps the resume session id from its signal
   * handler (src/supervisor/builder.ts) — which is why `lazy upgrade` stops
   * builders with an explicit window.
   */
  stopRun(runName: string, opts?: { gracefulTimeoutSeconds?: number }): Promise<boolean>;

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
   * Absolute directory of THIS runner's pi agent config dir for the given
   * worktree — the dir pi resolves its own `getAgentDir()` to inside the
   * environment it gives the agent (settings.json, models.json and the
   * `sessions/` tree all live under it). Same source-of-truth rationale as
   * {@link agentSessionProjectDir}, with the same per-runner split:
   *   - sandbox runners (docker/podman):
   *       <worktree>/.lazy-task-sandbox/.pi/agent
   *   - host-process runner:
   *       <host-home>/.pi/agent
   *
   * pi's session discovery (`src/agent/session-discovery.ts`) asks the runner
   * for this directory rather than computing it, exactly like the Claude path:
   * it depends on the HOME the runner gives the agent, which only the runner
   * knows.
   */
  agentPiAgentDir(worktreePath: string): string;

  /**
   * Tool checks the supervisor should run before starting work.
   * Each runner knows what tools its environment requires.
   */
  supervisorToolChecks(): { cmd: string; name: string; hint: string }[];

  /**
   * MCP server config for Claude Code integration.
   * Returns the command and args that Claude Code should use to spawn the MCP server.
   *
   * `opts.toolset` / `opts.readOnly` / `opts.review` ask for a restricted
   * toolset — the supervisor sets it for ask (`read`) and review turns
   * (`review` = reads + lazy_raise). It must be honored in the ARGS (not
   * just by an env var on the supervisor): in daemon-proxy mode the handlers
   * execute in the daemon, so only the in-container server can withhold a write
   * tool from a containerized agent.
   */
  mcpServerConfig(
    taskId: string,
    worktreePath: string,
    opts?: { readOnly?: boolean; review?: boolean; toolset?: 'full' | 'read' | 'review' },
  ): { command: string; args: string[] };

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
  diagnose(options?: DiagnoseOptions): Promise<HealthCheck[]>;

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
   * @param projects           Optional per-builder Claude projects dir to mount at
   *                           ~/.claude/projects (session ownership isolation), with
   *                           a trust signal telling the runner whether the dir is
   *                           known-writable (holds the resume target) and so may be
   *                           mounted despite a failing write-probe. Ignored by
   *                           runners that cannot isolate the projects dir (host-process).
   * @returns Exit code and detected session ID (if available)
   */
  launchBuilderInteractive(
    lazyRoot: string,
    systemPrompt: string,
    builderConfigPath: string,
    claudeExtraArgs: string[],
    debug?: boolean,
    daemonConfigPath?: string,
    projects?: BuilderLaunchProjects,
  ): Promise<{ exitCode: number; sessionId: string | null }>;

  /**
   * Run ONE headless builder turn: builder system prompt, full MCP surface,
   * `claude -p` with stream-json, container isolation when applicable.
   * Used by the UI review-session daemon path — not an interactive terminal session.
   */
  launchBuilderHeadless(params: LaunchBuilderHeadlessParams): Promise<LaunchBuilderHeadlessResult>;

  /**
   * Start a daemon-owned, DETACHED interactive builder session container and
   * return as soon as it is up — never blocks for the container's lifetime.
   *
   * Docker/podman only: a detached container with an attach route is a
   * container-runner concept, so runners that cannot isolate a sandbox
   * (host-process) do not implement this. Optional for that reason; callers
   * check `usesSandbox()` first.
   */
  launchBuilderDetached?(params: LaunchBuilderDetachedParams): Promise<LaunchBuilderDetachedResult>;
}
