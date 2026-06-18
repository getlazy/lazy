/**
 * HostProcessRunner — Runner implementation that spawns native processes.
 *
 * Designed for use inside VMs or other already-isolated environments where
 * Docker is unavailable or unnecessary. Runs the supervisor and Claude Code
 * directly on the host.
 *
 * DANGER: No filesystem or process isolation. The agent has full access to
 * the host system. Only use in environments that are already sandboxed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import { getHome } from '../utils/home';
import type { SandboxConfig } from '../capture/claude';
import { spawn } from '../utils/spawn';
import type { AgentResponse } from '../types';
import type { Runner, RunInfo, FollowHandle, HealthCheck } from './types';
import type { RoleTarget } from '../config/types';
import { getAuthEnvVars as getDefaultAuthEnvVars } from '../capture/claude';
import { ClaudeCodePackaging } from '../agent/claude-code-packaging';
import { encodeProjectPath } from '../import/claude-code-logs';
import { logger } from '../utils/logger';
import {
  checkTargetConnectivity,
  preflightRoleTarget,
  ANTHROPIC_DEFAULT_TARGET,
} from '../utils/role-target';
import { getLazyCommand } from '../utils/cli-path';
import type { Agent } from '../agent/interface';
import { snapshotSessionFiles, captureConversation } from '../import/capture-session';

import hostProcessBuilderInstructions from '../prompts/host-process-builder-runner-instructions.md' with { type: 'text' };

// Agent packaging for availability checks and tool checks.
const agentPackaging = new ClaudeCodePackaging();

/** Directory inside worktrees where we store PID files and logs. */
const RUN_STATE_DIR = '.lazy-run';

interface PidFileData {
  pid: number;
  startedAt: string;
  logFile: string;
  /** Project root path — used to scope discovery to the current project. */
  projectRoot?: string;
}

function runStateDir(worktreePath: string): string {
  return join(worktreePath, RUN_STATE_DIR);
}

/** Write a PID file for a running supervisor process. */
function writePidFile(runName: string, data: PidFileData): void {
  const dir = pidFileDir();
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${runName}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/** Read a PID file, or null if not found. */
function readPidFile(runName: string): PidFileData | null {
  const filePath = join(pidFileDir(), `${runName}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Remove a PID file. */
function removePidFile(runName: string): void {
  const filePath = join(pidFileDir(), `${runName}.json`);
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Best effort
  }
}

/** Directory where PID files are stored. */
function pidFileDir(): string {
  return join(getHome(), '.lazy', 'run');
}

// Re-export alias for backward compat with call sites in this file
const getLazyCliCommand = getLazyCommand;

/** Check if a process with the given PID is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class HostProcessRunner implements Runner {
  readonly type = 'dangerously-host-process-without-any-isolation' as const;
  readonly runLabel = 'Process';
  private lazyRoot: string | undefined;

  constructor(lazyRoot?: string) {
    this.lazyRoot = lazyRoot;
  }

  private _agent?: Agent;
  private _roleTargets?: { builder: RoleTarget; agent: RoleTarget };

  /** Set the agent to use for auth. If not set, falls back to ClaudeCodeAgent singleton. */
  setAgent(agent: Agent): void {
    this._agent = agent;
  }

  /** Set the per-role model targets (builder vs agent backends). */
  setRoleTargets(targets: { builder: RoleTarget; agent: RoleTarget }): void {
    this._roleTargets = targets;
  }

  /** The resolved target for task/supervisor (agent) launches. */
  private agentTarget(): RoleTarget {
    return this._roleTargets?.agent ?? ANTHROPIC_DEFAULT_TARGET;
  }

  /** The resolved target for builder launches. */
  private builderTarget(): RoleTarget {
    return this._roleTargets?.builder ?? ANTHROPIC_DEFAULT_TARGET;
  }

  private getAuthEnvVars(target?: RoleTarget): Array<{ key: string; value: string }> {
    const resolved = target ?? this.agentTarget();
    // Local backends are self-contained; the anthropic path may use the
    // injected agent's credential (falls back to the default reader).
    if (resolved.backend === 'anthropic' && this._agent) {
      return this._agent.getAuthEnvVars();
    }
    return getDefaultAuthEnvVars(resolved);
  }

  runDisplayName(runName: string): string {
    const pidData = readPidFile(runName);
    return pidData ? `PID ${pidData.pid}` : runName;
  }

  async checkAvailability(): Promise<void> {
    // Check that the agent binary is on PATH.
    // Skip for non-claude agents (e.g., qa-agent) — they don't use the claude CLI.
    if (!this._agent || this._agent.id === 'claude-code') {
      const binaryName = agentPackaging.binaryName();
      const proc = spawn([binaryName, '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        throw new Error(
          `${binaryName} CLI not found. Install it with: npm install -g ${agentPackaging.npmPackage()}\n` +
          `Host-process runner requires ${binaryName} to be installed on the host.`
        );
      }
    }

    // Auth is NOT enforced here. The daemon credential gate
    // (src/daemon/credential-gate.ts) is the single enforcement point.
    // Early, non-fatal reachability nudge for local backends (fail-hard happens
    // at launch via preflightRoleTarget).
    for (const role of ['agent', 'builder'] as const) {
      const target = role === 'agent' ? this.agentTarget() : this.builderTarget();
      if (target.backend === 'anthropic') continue;
      const check = await checkTargetConnectivity(target);
      if (!check.reachable) {
        logger.warn(`[${role}] ${check.reason}`);
      }
    }
  }

  async ensureReady(): Promise<void> {
    // No agent binary needed — supervisor runs via `lazy supervise` directly.
  }

  runNameForTask(taskShortId: string): string {
    return `lazy-${taskShortId}`;
  }

  async launchSupervisor(
    sandbox: SandboxConfig,
    runName: string,
    protocolDir: string,
    debug?: boolean,
    daemonConfigPath?: string,
  ): Promise<void> {
    // Fail hard before launch if the agent's backend is unreachable.
    await preflightRoleTarget('agent', this.agentTarget());

    const authEnvVars = this.getAuthEnvVars(this.agentTarget());

    // Set up log file for this run
    const logDir = join(getHome(), '.lazy', 'logs');
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, `${runName}.log`);

    const supervisorArgs = [
      ...getLazyCliCommand(),
      'supervise',
      '--protocol-dir', protocolDir,
      '--worktree', sandbox.worktreePath,
      '--runner', this.type,
    ];

    if (debug) {
      console.log('[DEBUG] Launching supervisor process:', supervisorArgs.join(' '));
    }

    logger.info('Launching supervisor process...');

    // Redirect stdout/stderr to a log file via Bun.file
    const logFileHandle = Bun.file(logFile);

    // Build a clean env: strip vars that cause issues in child processes.
    // Docker mode doesn't have this issue because containers get clean environments.
    const cleanEnv = { ...process.env } as Record<string, string>;
    // CLAUDECODE: prevents "nested session" errors when lazy is invoked from
    // inside a Claude Code session (e.g., lazy builder).
    delete cleanEnv.CLAUDECODE;
    // LAZY_IS_DAEMON: when the daemon spawns the supervisor, this env var
    // leaks down to Claude Code → MCP server. The MCP server's local handlers
    // call requireDaemonStorage() which skips the daemon connection when
    // LAZY_IS_DAEMON=1, breaking MCP tool execution.
    delete cleanEnv.LAZY_IS_DAEMON;

    const proc = spawn(supervisorArgs, {
      cwd: sandbox.worktreePath,
      stdout: logFileHandle,
      stderr: logFileHandle,
      timeout: 0, // Long-running: supervisor runs for the lifetime of the task
      env: {
        ...cleanEnv,
        ...Object.fromEntries(authEnvVars.map(v => [v.key, v.value])),
        // Ensure HOME is set for Claude Code
        HOME: getHome(),
        // Pass daemon config to supervisor so MCP server can route through daemon
        ...(daemonConfigPath ? { LAZY_DAEMON_CONFIG: daemonConfigPath } : {}),
      },
    });

    // Unref so this process doesn't keep the parent alive
    proc.unref();

    // Store PID for later status checks
    writePidFile(runName, {
      pid: proc.pid,
      startedAt: new Date().toISOString(),
      logFile,
      projectRoot: this.lazyRoot,
    });

    logger.debug(`Supervisor process ${runName} launched (PID ${proc.pid})`);
  }

  async runClaudeSync(
    prompt: string,
    sandbox: SandboxConfig,
    verbose?: boolean,
    debug?: boolean,
    model?: string,
  ): Promise<AgentResponse> {
    const target = this.agentTarget();
    const authEnvVars = this.getAuthEnvVars(target);

    // The caller resolves the model; for a local backend fall back to the
    // target's authoritative model when none was passed.
    const effectiveModel =
      model ?? (target.backend !== 'anthropic' ? target.model : undefined);

    const claudeArgs = [
      'claude', '-p', prompt,
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ];

    if (effectiveModel) {
      claudeArgs.push('--model', effectiveModel);
    }

    if (debug) {
      console.log('[DEBUG] Running Claude command:', claudeArgs.join(' '));
    }

    logger.info('Running Claude Code...');

    // Strip env vars that cause issues in child processes (same as launchSupervisor).
    const cleanEnv = { ...process.env } as Record<string, string>;
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.LAZY_IS_DAEMON;

    const proc = spawn(claudeArgs, {
      cwd: sandbox.worktreePath,
      stdout: 'pipe',
      stderr: verbose || debug ? 'inherit' : 'pipe',
      timeout: 0, // Long-running: Claude Code sessions can take minutes or hours
      env: {
        ...cleanEnv,
        ...Object.fromEntries(authEnvVars.map(v => [v.key, v.value])),
        HOME: getHome(),
      },
    });

    const outputPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();

    const [output, stderr, exitCode] = await Promise.all([
      outputPromise,
      stderrPromise,
      proc.exited,
    ]);

    logger.stream('Claude stdout:\n' + output);
    logger.stream('Claude stderr:\n' + stderr);

    if (exitCode !== 0) {
      if (!(verbose || debug) && stderr) {
        const stderrLines = stderr.trim().split('\n');
        const lastOutput = stderrLines.slice(-20).join('\n  ');
        logger.error(`Claude Code exited with code ${exitCode}\n\nLast output:\n  ${lastOutput}`);
      } else {
        logger.error(`Claude Code exited with code ${exitCode}`);
      }
      throw new Error(`Claude exited with code ${exitCode}`);
    }

    logger.debug('Parsing Claude response...');
    return JSON.parse(output) as AgentResponse;
  }

  async isRunning(runName: string): Promise<boolean> {
    const pidData = readPidFile(runName);
    if (!pidData) return false;
    return isProcessAlive(pidData.pid);
  }

  async runExists(runName: string): Promise<boolean> {
    return readPidFile(runName) !== null;
  }

  async getRunInfo(runName: string): Promise<RunInfo | null> {
    const pidData = readPidFile(runName);
    if (!pidData) return null;

    const running = isProcessAlive(pidData.pid);
    return {
      running,
      // We can't reliably get exit codes from detached processes after they exit.
      // The reconciler relies on protocol response.json for success detection.
      // For crash detection, the process simply disappears.
      exitCode: running ? 0 : 1,
      finishedAt: running ? null : new Date().toISOString(),
    };
  }

  async getRunExitCode(runName: string): Promise<number | null> {
    const pidData = readPidFile(runName);
    if (!pidData) return null;
    if (isProcessAlive(pidData.pid)) return null;
    // Can't get real exit code of detached process; 1 indicates abnormal exit
    return 1;
  }

  async getRunLogs(runName: string, tailLines?: number): Promise<string | null> {
    const pidData = readPidFile(runName);
    if (!pidData) return null;

    try {
      const content = readFileSync(pidData.logFile, 'utf-8');
      if (!tailLines) return content;
      const lines = content.split('\n');
      return lines.slice(-tailLines).join('\n');
    } catch {
      return null;
    }
  }

  async stopRun(runName: string): Promise<boolean> {
    const pidData = readPidFile(runName);
    if (!pidData) return false;

    try {
      process.kill(pidData.pid, 'SIGTERM');
      // Give it a moment, then SIGKILL if still alive
      const start = Date.now();
      while (Date.now() - start < 5_000) {
        if (!isProcessAlive(pidData.pid)) return true;
        Bun.sleepSync(100);
      }
      // Force kill
      try {
        process.kill(pidData.pid, 'SIGKILL');
      } catch {
        // Already dead
      }
      return true;
    } catch {
      // Process already dead or permission denied
      return false;
    }
  }

  async removeRun(runName: string): Promise<void> {
    const pidData = readPidFile(runName);
    if (!pidData) return;

    // Kill if still running
    if (isProcessAlive(pidData.pid)) {
      try {
        process.kill(pidData.pid, 'SIGKILL');
      } catch {
        // Best effort
      }
    }

    // Remove PID file
    removePidFile(runName);

    // Optionally remove log file
    try {
      if (existsSync(pidData.logFile)) {
        unlinkSync(pidData.logFile);
      }
    } catch {
      // Best effort
    }
  }

  async discoverRunningRuns(): Promise<string[]> {
    const dir = pidFileDir();
    if (!existsSync(dir)) return [];

    try {
      const files = readdirSync(dir) as string[];
      const running: string[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const runName = file.replace(/\.json$/, '');
        const pidData = readPidFile(runName);
        if (!pidData || !isProcessAlive(pidData.pid)) continue;

        if (this.lazyRoot) {
          // Project-scoped filtering: include processes that belong to this project
          // (matching projectRoot) OR have no projectRoot (backward compat with pre-label PID files).
          if (pidData.projectRoot === this.lazyRoot || !pidData.projectRoot) {
            running.push(runName);
          }
        } else {
          // No project root available — return all (legacy behavior).
          running.push(runName);
        }
      }

      return running;
    } catch {
      return [];
    }
  }

  async discoverProjectBuilderRuns(_projectRoot: string): Promise<string[]> {
    // Host-process mode launches the builder as a foreground Claude Code
    // process without writing a PID file, so there are no builder runs to
    // enumerate here. `lazy upgrade` therefore has nothing to stop for
    // host-process builders.
    return [];
  }

  followOutput(runName: string, _since?: string): FollowHandle | null {
    const pidData = readPidFile(runName);
    if (!pidData || !existsSync(pidData.logFile)) return null;

    try {
      const proc = spawn(
        ['tail', '-f', pidData.logFile],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      return {
        process: { kill: () => proc.kill() },
        stdout: proc.stdout as ReadableStream<Uint8Array>,
        exited: proc.exited.then(code => code ?? 0),
      };
    } catch {
      return null;
    }
  }

  usesSandbox(): boolean {
    return false;
  }

  agentSessionProjectDir(worktreePath: string): string {
    // Host-process runs Claude with the real host HOME (no sandbox), so its
    // session JSONL lands under <host-home>/.claude/projects/<encoded>.
    const encoded = encodeProjectPath(worktreePath);
    return join(getHome(), '.claude', 'projects', encoded);
  }

  supervisorToolChecks(): { cmd: string; name: string; hint: string }[] {
    const binaryName = agentPackaging.binaryName();
    return [
      { cmd: 'git', name: 'git', hint: 'Required tool not found: git' },
      { cmd: binaryName, name: binaryName, hint: `${binaryName} CLI not found. Install with: npm install -g ${agentPackaging.npmPackage()}` },
      // No lazy-agent check — in host-process mode, the supervisor IS lazy itself.
    ];
  }

  mcpServerConfig(taskId: string, worktreePath: string): { command: string; args: string[] } {
    const lazyCmd = getLazyCliCommand();
    return {
      command: lazyCmd[0],
      args: [...lazyCmd.slice(1), 'mcp', '--task-id', taskId, '--worktree', worktreePath],
    };
  }

  async diagnose(): Promise<HealthCheck[]> {
    const results: HealthCheck[] = [];

    // Delegate agent-specific checks to packaging
    results.push(...agentPackaging.diagnose());

    results.push({ state: 'ok', what: 'Runner mode: host-process (no container isolation)' });

    // Check connectivity for any per-role local backend (ollama/proxy).
    for (const role of ['agent', 'builder'] as const) {
      const target = role === 'agent' ? this.agentTarget() : this.builderTarget();
      if (target.backend === 'anthropic') continue;
      const check = await checkTargetConnectivity(target);
      if (check.reachable) {
        results.push({ state: 'ok', what: `[${role}] ${target.backend} reachable at ${check.endpoint}` });
      } else {
        results.push({ state: 'fail', what: `[${role}] ${target.backend} reachable`, reason: check.reason });
      }
    }

    return results;
  }

  // ----- Prompt support -----

  getAgentInstructions(): string {
    return '';
  }

  getBuilderInstructions(): string {
    return hostProcessBuilderInstructions;
  }

  async launchBuilderInteractive(
    lazyRoot: string,
    systemPrompt: string,
    _builderConfigPath: string,
    claudeExtraArgs: string[],
    debug?: boolean,
    daemonConfigPath?: string,
    _projectsDir?: string,
  ): Promise<{ exitCode: number; sessionId: string | null }> {
    // Host-process mode: launch Claude Code directly (no supervisor, no MCP proxy).
    // projectsDir isolation is N/A here — there is no container HOME to remap, so
    // Claude reads/writes the real host ~/.claude/projects. (This mode is the
    // explicitly-unisolated runner anyway.)
    // MCP tools are not available in this mode — the builder relies on Claude Code's
    // built-in capabilities plus any tools the user has configured.
    // We still capture the conversation after exit by reading JSONL files.

    // Fail hard before launch if the builder's backend is unreachable.
    await preflightRoleTarget('builder', this.builderTarget());

    // Inject the builder target's backend env vars (base URL for ollama/proxy,
    // dummy credentials for ollama) so a local-backend builder actually talks to
    // that backend rather than the inherited shell's default endpoint.
    const builderEnvVars = this.getAuthEnvVars(this.builderTarget());

    const claudeArgs = [
      'claude',
      '--append-system-prompt', systemPrompt,
      ...claudeExtraArgs,
    ];

    if (debug) {
      console.log('[DEBUG] Launching Claude Code directly:', claudeArgs.join(' '));
    }

    logger.info('Launching Claude Code...');

    // Snapshot JSONL file times before launch for conversation capture
    const beforeSnapshot = await snapshotSessionFiles(lazyRoot);

    const proc = spawn(claudeArgs, {
      cwd: lazyRoot,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      env: {
        ...process.env,
        ...Object.fromEntries(builderEnvVars.map(v => [v.key, v.value])),
      },
    });

    const exitCode = await proc.exited;

    // Capture conversation from JSONL files
    const detectedSessionId = await captureConversation(lazyRoot, beforeSnapshot, 'Builder');

    return { exitCode, sessionId: detectedSessionId };
  }
}
