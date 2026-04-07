/**
 * DockerRunner — Runner implementation backed by Docker containers.
 *
 * Thin wrapper around the existing functions in capture/claude.ts.
 * No functional changes from the pre-Runner behavior.
 */

import type { SandboxConfig } from '../capture/claude';
import type { AgentResponse } from '../types';
import type { Runner, RunInfo, FollowHandle, HealthCheck } from './types';
import type { RunnerType, OllamaConfig } from '../config/types';

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { spawn, spawnSync } from '../utils/spawn';
import { join, basename } from 'path';
import { getHome } from '../utils/home';
import { logger } from '../utils/logger';
import { checkOllamaConnectivity } from '../utils/ollama';

import {
  checkDocker,
  getAuthEnvVars,
  ensureImage,
  ensureAgentBinary,
  containerNameForTask,
  launchSupervisorAsync,
  runClaude,
  isContainerRunning,
  containerExists,
  getContainerInfo as dockerGetContainerInfo,
  getContainerExitCode,
  getContainerLogs,
  removeContainer,
} from '../capture/claude';

import { ClaudeCodePackaging } from '../agent/claude-code-packaging';
import dockerBuilderInstructions from '../prompts/docker-builder-runner-instructions.md' with { type: 'text' };
import dockerAgentInstructions from '../prompts/docker-agent-instructions.md' with { type: 'text' };
import { writeToolPermissions } from '../mcp/config';

// Agent packaging for tool checks. Instantiated once; stateless.
const agentPackaging = new ClaudeCodePackaging();

const DOCKER_TIMEOUT_MS = 10_000;


/**
 * Read-only MCP tools that should be pre-approved in the builder session.
 * These tools only read state and don't mutate tasks or trigger operations.
 * Mutating tools (create, start, accept, reject, etc.) require user confirmation.
 */
const BUILDER_READ_ONLY_TOOLS = [
  'lazy_search',
  'lazy_show',
  'lazy_status',
  'lazy_conversations',
  'lazy_conversation_search',
  'lazy_conversation_read',
  'lazy_list',
  'lazy_blocked',
  'lazy_active',
  'lazy_diff',
  'lazy_wait',
];

export class DockerRunner implements Runner {
  readonly type: RunnerType;
  readonly runLabel = 'Container';
  protected readonly binary: string;
  protected _ollamaConfig?: OllamaConfig;

  constructor(binary: string = 'docker', type: RunnerType = 'docker') {
    this.binary = binary;
    this.type = type;
  }

  /** Set Ollama config for local model inference. */
  setOllamaConfig(config: OllamaConfig): void {
    this._ollamaConfig = config;
  }

  runDisplayName(runName: string): string {
    return runName;
  }

  checkAvailability(): void {
    checkDocker(this.binary);
    if (this._ollamaConfig?.enabled) {
      // When Ollama is configured, auth is always available (dummy tokens).
      // Log a warning if Ollama is unreachable (don't fail — it might come up later).
      const check = checkOllamaConnectivity(this._ollamaConfig);
      if (!check.reachable) {
        logger.warn(check.reason);
      }
    } else {
      getAuthEnvVars(); // Fail fast on missing auth before creating state
    }
  }

  async ensureReady(): Promise<void> {
    await ensureImage(this.binary);
    await ensureAgentBinary();
  }

  runNameForTask(taskShortId: string): string {
    return containerNameForTask(taskShortId);
  }

  async launchSupervisor(
    sandbox: SandboxConfig,
    runName: string,
    protocolDir: string,
    debug?: boolean,
    daemonConfigPath?: string,
  ): Promise<void> {
    await launchSupervisorAsync(sandbox, runName, protocolDir, debug ?? false, this.binary, daemonConfigPath, this._ollamaConfig);
  }

  async runClaudeSync(
    prompt: string,
    sandbox: SandboxConfig,
    verbose?: boolean,
    debug?: boolean,
    model?: string,
  ): Promise<AgentResponse> {
    return runClaude(prompt, sandbox, verbose ?? false, debug ?? false, model, this.binary, this._ollamaConfig);
  }

  isRunning(runName: string): boolean {
    return isContainerRunning(runName, this.binary);
  }

  runExists(runName: string): boolean {
    return containerExists(runName, this.binary);
  }

  getRunInfo(runName: string): RunInfo | null {
    return dockerGetContainerInfo(runName, this.binary);
  }

  getRunExitCode(runName: string): number | null {
    return getContainerExitCode(runName, this.binary);
  }

  getRunLogs(runName: string, tailLines?: number): string | null {
    return getContainerLogs(runName, tailLines, this.binary);
  }

  stopRun(runName: string): boolean {
    try {
      const result = spawnSync(
        [this.binary, 'stop', runName],
        { stdout: 'ignore', stderr: 'pipe', timeout: 30_000 },
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  removeRun(runName: string): void {
    removeContainer(runName, this.binary);
  }

  discoverRunningRuns(): string[] {
    try {
      const result = spawnSync(
        [this.binary, 'ps', '--filter', 'name=^lazy-', '--format', '{{.Names}}'],
        { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS },
      );
      if (result.exitCode !== 0) return [];
      const output = result.stdout.toString().trim();
      if (!output) return [];
      return output.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  followOutput(runName: string, since?: string): FollowHandle | null {
    try {
      const args = [this.binary, 'logs', '--follow'];
      if (since) {
        args.push('--since', since);
      } else {
        args.push('--tail', '0');
      }
      args.push(runName);

      const proc = spawn(args, { stdout: 'pipe', stderr: 'pipe' });
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
    return true;
  }

  supervisorToolChecks(): { cmd: string; name: string; hint: string }[] {
    return agentPackaging.supervisorToolChecks();
  }

  mcpServerConfig(taskId: string, worktreePath: string): { command: string; args: string[] } {
    // The daemon is required in v0.11+ and always provides LAZY_DAEMON_CONFIG
    // when launching containers. MCP tool calls route through the daemon's
    // /mcp routes via HTTP proxy.
    const daemonConfigTemplate = process.env.LAZY_DAEMON_CONFIG;
    if (!daemonConfigTemplate) {
      throw new Error(
        'LAZY_DAEMON_CONFIG not set. The daemon must provide MCP config when launching containers.\n' +
        'This indicates a bug in the launch path — containers should always receive daemon config.',
      );
    }

    // Pass the daemon config template and task ID as separate args.
    // The MCP server reads the template and overrides taskId in memory.
    // We must NOT write a task-scoped config file here — the daemon config
    // template is in .lazy/tmp/ which is under the container's read-only
    // repo mount. Writing next to it would fail with EROFS.
    return {
      command: 'lazy-agent',
      args: ['mcp', '--daemon-config', daemonConfigTemplate, '--task-id', taskId, '--worktree', worktreePath],
    };
  }

  diagnose(): HealthCheck[] {
    const results: HealthCheck[] = [];
    const timeout = 10_000;

    // Check binary installed
    try {
      const result = spawnSync([this.binary, '--version'], {
        stdout: 'pipe', stderr: 'ignore', timeout,
      });
      if (result.exitCode === 0) {
        const raw = result.stdout.toString().trim();
        const match = this.binary === 'podman'
          ? raw.match(/podman version ([^\s,]+)/)
          : raw.match(/Docker version ([^\s,]+)/);
        const version = match ? match[1] : raw;
        const name = this.binary === 'podman' ? 'Podman' : 'Docker';
        results.push({ state: 'ok', what: `${name} installed (v${version})` });
      } else {
        const name = this.binary === 'podman' ? 'Podman' : 'Docker';
        const url = this.binary === 'podman'
          ? 'https://podman.io/docs/installation'
          : 'https://docs.docker.com/get-docker/';
        results.push({ state: 'fail', what: `${name} installed`, reason: `${name} is not installed. Install it: ${url}` });
        return results; // No point checking daemon if binary is missing
      }
    } catch {
      const name = this.binary === 'podman' ? 'Podman' : 'Docker';
      results.push({ state: 'fail', what: `${name} installed`, reason: `${name} is not installed.` });
      return results;
    }

    // Check daemon running
    try {
      const result = spawnSync([this.binary, 'info'], {
        stdout: 'ignore', stderr: 'ignore', timeout,
      });
      if (result.exitCode === 0) {
        const name = this.binary === 'podman' ? 'Podman' : 'Docker';
        results.push({ state: 'ok', what: `${name} daemon running` });
      } else {
        if (this.binary === 'podman') {
          results.push({ state: 'fail', what: 'Podman daemon running', reason: 'Podman is not responsive. Start the Podman machine or run: podman machine start' });
        } else {
          results.push({ state: 'fail', what: 'Docker daemon running', reason: 'Docker daemon is not responsive. Start Docker Desktop or run: sudo systemctl start docker' });
        }
      }
    } catch {
      const name = this.binary === 'podman' ? 'Podman' : 'Docker';
      results.push({ state: 'fail', what: `${name} daemon running`, reason: `${name} is not responsive.` });
    }

    // Check Ollama connectivity when configured
    if (this._ollamaConfig?.enabled) {
      const check = checkOllamaConnectivity(this._ollamaConfig);
      if (check.reachable) {
        results.push({ state: 'ok', what: `Ollama reachable at ${check.endpoint}` });
      } else {
        results.push({ state: 'fail', what: 'Ollama reachable', reason: check.reason });
      }
    }

    return results;
  }

  // ----- Prompt support -----

  getAgentInstructions(): string {
    return dockerAgentInstructions;
  }

  getBuilderInstructions(): string {
    return dockerBuilderInstructions;
  }

  async launchBuilderInteractive(
    lazyRoot: string,
    systemPrompt: string,
    builderConfigPath: string,
    claudeExtraArgs: string[],
    debug?: boolean,
    daemonConfigPath?: string,
  ): Promise<{ exitCode: number; sessionId: string | null }> {
    const [imageName, agentBinaryPath] = await Promise.all([
      ensureImage(this.binary),
      ensureAgentBinary(),
    ]);

    const authEnvVars = getAuthEnvVars(this._ollamaConfig);

    // Read the builder config to get port for the container config
    const builderConfig = JSON.parse(readFileSync(builderConfigPath, 'utf-8'));

    // Get the data directory path for mounting
    const { loadConfig } = await import('../config/loader');
    const config = await loadConfig(lazyRoot);
    const dataDir = join(lazyRoot, config.data.path);

    // Write system prompt to a temp file in the data dir (accessible inside container)
    const tmpDir = join(dataDir, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const promptFile = join(tmpDir, `builder-prompt-${Date.now()}.txt`);
    writeFileSync(promptFile, systemPrompt);

    // Extract short ID from config filename (e.g., "builder-a1b2c3d4.json" → "a1b2c3d4")
    const configBasename = basename(builderConfigPath, '.json');
    const builderId = configBasename.replace('builder-', '');

    // Determine MCP proxy mode: daemon (preferred) or legacy builder server
    const useDaemonProxy = !!daemonConfigPath;

    // Write a container-specific config with host.docker.internal instead of 127.0.0.1.
    // The container can't reach the host's localhost, so we use Docker's built-in DNS alias.
    const containerConfigFile = join(tmpDir, `builder-container-${builderId}.json`);
    const containerConfig = {
      ...builderConfig,
      host: 'host.docker.internal',
    };
    writeFileSync(containerConfigFile, JSON.stringify(containerConfig, null, 2));

    // Build MCP server args based on proxy mode
    let mcpArgs: string[];
    const tempFilesToClean = [promptFile, containerConfigFile];

    if (useDaemonProxy) {
      // Daemon proxy mode: MCP server forwards tool calls to daemon /mcp routes
      mcpArgs = ['mcp', '--daemon-config', daemonConfigPath!, '--worktree', lazyRoot];
      // Mount daemon config into container
      tempFilesToClean.push(daemonConfigPath!);
    } else {
      // Legacy mode: MCP server forwards to per-session builder HTTP server
      mcpArgs = ['mcp', '--builder-config', containerConfigFile, '--worktree', lazyRoot];
    }

    // Prepare merged Claude config: host's ~/.claude.json + lazy MCP server entry.
    // Claude Code reads config from ~/.claude.json (at $HOME root, not inside ~/.claude/).
    // We merge to a temp file so the host's real config is never modified.
    const mergedConfigFile = join(tmpDir, `builder-claude-config-${Date.now()}.json`);
    const hostConfigPath = join(getHome(), '.claude.json');
    let hostConfig: Record<string, unknown> = {};
    try {
      if (existsSync(hostConfigPath)) {
        hostConfig = JSON.parse(readFileSync(hostConfigPath, 'utf-8'));
      }
    } catch {
      // Start fresh on parse error
    }
    const mergedConfig = {
      ...hostConfig,
      mcpServers: {
        ...((hostConfig.mcpServers as Record<string, unknown>) ?? {}),
        lazy: {
          command: 'lazy-agent',
          args: mcpArgs,
        },
      },
    };
    writeFileSync(mergedConfigFile, JSON.stringify(mergedConfig, null, 2) + '\n');
    tempFilesToClean.push(mergedConfigFile);

    // Pre-approve read-only lazy MCP tools so the builder doesn't prompt for permission.
    // Mutating tools (create, start, accept, etc.) still require user confirmation.
    await writeToolPermissions(BUILDER_READ_ONLY_TOOLS);

    // Build container args: launch lazy-agent in builder mode
    // --init provides a proper PID 1 init process (tini/catatonit) that forwards
    // signals and reaps zombies. Required for Podman where conmon doesn't provide
    // PID 1 protection, and harmless for Docker. Without it, interactive applications
    // (like Claude Code's trust prompt TUI) can hang in Podman after terminal mode
    // switches — see https://github.com/google-gemini/gemini-cli/issues/17275.
    const dockerArgs = [
      this.binary, 'run', '-it', '--init', '--rm',
      '--name', `lazy-builder-${builderId}`,
      // Allow container to reach host TCP server via host.docker.internal
      // (built-in on macOS Docker Desktop; needs this flag on Linux)
      '--add-host=host.docker.internal:host-gateway',
      // Mount repo READ-ONLY — all writes happen on host via HTTP
      '-v', `${lazyRoot}:${lazyRoot}:ro`,
      // Mount data dir read-write (conversation capture needs write access)
      '-v', `${dataDir}:${dataDir}`,
      // Container-specific builder config (has host.docker.internal)
      '-v', `${containerConfigFile}:${containerConfigFile}:ro`,
      // MCP binary for proxy tool access
      '-v', `${agentBinaryPath}:/usr/local/bin/lazy-agent:ro`,
      // Claude config dir (settings, conversations, credentials) — mount to container's home
      // so Claude Code finds them at $HOME/.claude and $HOME/.claude.json without needing
      // to override HOME (which would cause warnings about missing .local/bin).
      '-v', `${getHome()}/.claude:/home/user/.claude`,
      // Merged Claude config with MCP server entry (writable — Claude Code updates it on startup)
      '-v', `${mergedConfigFile}:/home/user/.claude.json`,
      // Auth
      ...authEnvVars.flatMap(v => ['-e', `${v.key}=${v.value}`]),
      // SSH: auto-accept new host keys without TTY prompt (accept-new still rejects changed keys)
      '-e', 'GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new',
      // Working directory
      '-w', lazyRoot,
    ];

    // Mount daemon config file if using daemon proxy
    if (useDaemonProxy && daemonConfigPath) {
      dockerArgs.push('-v', `${daemonConfigPath}:${daemonConfigPath}:ro`);
    }

    dockerArgs.push(
      imageName,
      // Run the builder supervisor (not Claude directly)
      'lazy-agent', 'builder',
      '--system-prompt-file', promptFile,
      '--worktree', lazyRoot,
      // Use container config (host.docker.internal) not the host config (127.0.0.1)
      '--builder-config', containerConfigFile,
    );

    // Pass daemon config to builder supervisor if available
    if (useDaemonProxy && daemonConfigPath) {
      dockerArgs.push('--daemon-config', daemonConfigPath);
    }

    // Pass through extra Claude args after --
    if (claudeExtraArgs.length > 0) {
      dockerArgs.push('--', ...claudeExtraArgs);
    }

    if (debug) {
      dockerArgs.splice(dockerArgs.indexOf(imageName), 0, '-e', 'DEBUG=1');
      console.log('[DEBUG] Running builder container command:', dockerArgs.join(' '));
    }

    logger.info('Launching builder container...');

    const proc = spawn(dockerArgs, {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      timeout: 0, // Long-running: supervisor runs for the lifetime of the task
    });

    const exitCode = await proc.exited;

    // Clean up temp files
    for (const tmpFile of tempFilesToClean) {
      try {
        unlinkSync(tmpFile);
      } catch {
        // Best effort
      }
    }

    return { exitCode, sessionId: null };
  }
}
