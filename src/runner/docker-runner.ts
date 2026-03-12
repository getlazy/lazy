/**
 * DockerRunner — Runner implementation backed by Docker containers.
 *
 * Thin wrapper around the existing functions in capture/claude.ts.
 * No functional changes from the pre-Runner behavior.
 */

import type { SandboxConfig } from '../capture/claude';
import type { AgentResponse } from '../types';
import type { Runner, RunInfo, FollowHandle, HealthCheck } from './types';
import type { RunnerType } from '../config/types';

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { spawn, spawnSync } from '../utils/spawn';
import { join, basename } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger';

import {
  checkDocker,
  getAuthEnv,
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

export interface DockerRunnerOptions {
  dockerAgentNoNetwork?: boolean;
}

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
  private options: DockerRunnerOptions;

  constructor(binary: string = 'docker', type: RunnerType = 'docker', options?: DockerRunnerOptions) {
    this.binary = binary;
    this.type = type;
    this.options = options ?? {};
  }

  runDisplayName(runName: string): string {
    return runName;
  }

  checkAvailability(): void {
    checkDocker(this.binary);
    getAuthEnv(); // Fail fast on missing auth before creating state
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
  ): Promise<void> {
    await launchSupervisorAsync(sandbox, runName, protocolDir, debug ?? false, this.binary, this.options);
  }

  async runClaudeSync(
    prompt: string,
    sandbox: SandboxConfig,
    verbose?: boolean,
    debug?: boolean,
    model?: string,
  ): Promise<AgentResponse> {
    return runClaude(prompt, sandbox, verbose ?? false, debug ?? false, model, this.binary, this.options);
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
    return {
      command: 'lazy-agent',
      args: ['mcp', '--task-id', taskId, '--worktree', worktreePath],
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
  ): Promise<{ exitCode: number; sessionId: string | null }> {
    const [imageName, agentBinaryPath] = await Promise.all([
      ensureImage(this.binary),
      ensureAgentBinary(),
    ]);

    const auth = getAuthEnv();

    // Read the builder config to get port for the container config
    const builderConfig = JSON.parse(readFileSync(builderConfigPath, 'utf-8'));

    // Get the data directory path for mounting
    const { loadConfig } = await import('../config/loader');
    const config = loadConfig(lazyRoot);
    const dataDir = join(lazyRoot, config.data.path);

    // Write system prompt to a temp file in the data dir (accessible inside container)
    const tmpDir = join(dataDir, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const promptFile = join(tmpDir, `builder-prompt-${Date.now()}.txt`);
    writeFileSync(promptFile, systemPrompt);

    // Extract short ID from config filename (e.g., "builder-a1b2c3d4.json" → "a1b2c3d4")
    const configBasename = basename(builderConfigPath, '.json');
    const builderId = configBasename.replace('builder-', '');

    // Write a container-specific config with host.docker.internal instead of 127.0.0.1.
    // The container can't reach the host's localhost, so we use Docker's built-in DNS alias.
    const containerConfigFile = join(tmpDir, `builder-container-${builderId}.json`);
    const containerConfig = {
      ...builderConfig,
      host: 'host.docker.internal',
    };
    writeFileSync(containerConfigFile, JSON.stringify(containerConfig, null, 2));

    // Prepare merged Claude config: host's ~/.claude.json + lazy MCP server entry.
    // Claude Code reads config from ~/.claude.json (at $HOME root, not inside ~/.claude/).
    // We merge to a temp file so the host's real config is never modified.
    // The MCP entry points to the container config file (host.docker.internal).
    const mergedConfigFile = join(tmpDir, `builder-claude-config-${Date.now()}.json`);
    const hostConfigPath = join(homedir(), '.claude.json');
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
          args: ['mcp', '--builder-config', containerConfigFile, '--worktree', lazyRoot],
        },
      },
    };
    writeFileSync(mergedConfigFile, JSON.stringify(mergedConfig, null, 2) + '\n');

    // Pre-approve read-only lazy MCP tools so the builder doesn't prompt for permission.
    // Mutating tools (create, start, accept, etc.) still require user confirmation.
    writeToolPermissions(BUILDER_READ_ONLY_TOOLS);

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
      '-v', `${homedir()}/.claude:/home/user/.claude`,
      // Merged Claude config with MCP server entry (writable — Claude Code updates it on startup)
      '-v', `${mergedConfigFile}:/home/user/.claude.json`,
      // Auth
      '-e', `${auth.key}=${auth.value}`,
      // SSH: auto-accept new host keys without TTY prompt (accept-new still rejects changed keys)
      '-e', 'GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new',
      // Working directory
      '-w', lazyRoot,
      imageName,
      // Run the builder supervisor (not Claude directly)
      'lazy-agent', 'builder',
      '--system-prompt-file', promptFile,
      '--worktree', lazyRoot,
      // Use container config (host.docker.internal) not the host config (127.0.0.1)
      '--builder-config', containerConfigFile,
    ];

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
    });

    const exitCode = await proc.exited;

    // Clean up temp files
    for (const tmpFile of [promptFile, mergedConfigFile, containerConfigFile]) {
      try {
        unlinkSync(tmpFile);
      } catch {
        // Best effort
      }
    }

    return { exitCode, sessionId: null };
  }
}
