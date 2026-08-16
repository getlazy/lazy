/**
 * DockerRunner — Runner implementation backed by Docker containers.
 *
 * Thin wrapper around the existing functions in capture/claude.ts.
 * No functional changes from the pre-Runner behavior.
 */

import type { SandboxConfig } from '../capture/claude';
import type { AgentResponse } from '../types';
import type { Runner, RunInfo, FollowHandle, HealthCheck } from './types';
import type { RunnerType, RoleTarget } from '../config/types';

import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { spawn } from '../utils/spawn';
import { join, basename } from 'path';
import { getHome } from '../utils/home';
import { logger } from '../utils/logger';
import { redactSecrets } from '../utils/redact';
import {
  checkTargetConnectivity,
  preflightRoleTarget,
  ANTHROPIC_DEFAULT_TARGET,
} from '../utils/role-target';

import {
  checkDocker,
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
import { encodeProjectPath } from '../import/claude-code-logs';
import { shouldMountProjectsDir, type BuilderLaunchProjects } from '../builder/projects-isolation';
import { ensureBuilderScratchDir, SCRATCH_ENV_VAR } from '../builder/scratch';
import {
  CONTAINER_CREDENTIAL_STORE,
  builderClaudeConfigPath,
  builderClaudeSessionConfigPath,
  persistBuilderSessionClaudeConfig,
  writeBuilderSessionClaudeConfig,
  writeNeutralCredentialStore,
} from '../builder/claude-home';
import { assertDaemonMcpConfigMounted } from '../builder/mcp-config-check';
import { SANDBOX_DIR } from '../utils/sandbox';
import { resolveAuthEnvFromDaemon } from '../daemon/auth-env';
import dockerBuilderInstructions from '../prompts/docker-builder-runner-instructions.md' with { type: 'text' };
import dockerAgentInstructions from '../prompts/docker-agent-instructions.md' with { type: 'text' };
import { writeToolPermissions } from '../mcp/config';
import { READ_ONLY_TOOL_NAMES } from '../mcp/tool-access';

// Agent packaging for tool checks. Instantiated once; stateless.
const agentPackaging = new ClaudeCodePackaging();

const DOCKER_TIMEOUT_MS = 10_000;

/**
 * Label applied to every lazy-launched container that identifies the project
 * (lazy root path) it belongs to. Used to scope container discovery so that a
 * command run in project A never enumerates or touches containers belonging
 * to project B.
 */
export const PROJECT_LABEL = 'lazy.project';

/**
 * Read-only MCP tools that should be pre-approved in the builder session.
 * These tools only read state and don't mutate tasks or trigger operations.
 * Mutating tools (create, start, accept, reject, etc.) require user confirmation.
 *
 * Sourced from the one classification of every tool (src/mcp/tool-access.ts) so
 * the builder's pre-approval list and the ask turn's read-only toolset can never
 * drift apart — a new write tool is a write tool for both, by default.
 */
const BUILDER_READ_ONLY_TOOLS = [...READ_ONLY_TOOL_NAMES];

/** Docker label key used to scope containers to a project root. */
export const PROJECT_LABEL_KEY = 'lazy.project';

export class DockerRunner implements Runner {
  readonly type: RunnerType;
  readonly runLabel = 'Container';
  // An idle container stays fully resident between turns → eligible for base reap.
  readonly reapsIdleRuns = true;
  protected readonly binary: string;
  private lazyRoot: string | undefined;
  protected _roleTargets?: { builder: RoleTarget; agent: RoleTarget };

  constructor(binary: string = 'docker', type: RunnerType = 'docker', lazyRoot?: string) {
    this.binary = binary;
    this.type = type;
    this.lazyRoot = lazyRoot;
  }

  /** Set the per-role model targets (builder vs agent backends). */
  setRoleTargets(targets: { builder: RoleTarget; agent: RoleTarget }): void {
    this._roleTargets = targets;
  }

  /** The resolved target for task/supervisor (agent) launches. */
  protected agentTarget(): RoleTarget {
    return this._roleTargets?.agent ?? ANTHROPIC_DEFAULT_TARGET;
  }

  /** The resolved target for builder launches. */
  protected builderTarget(): RoleTarget {
    return this._roleTargets?.builder ?? ANTHROPIC_DEFAULT_TARGET;
  }

  runDisplayName(runName: string): string {
    return runName;
  }

  async checkAvailability(): Promise<void> {
    await checkDocker(this.binary);
    // Auth is NOT enforced here. The daemon credential gate
    // (src/daemon/credential-gate.ts) is the single enforcement point — every
    // path that launches containers goes through a daemon that refuses to start
    // without a credential, so a redundant client-side check here would just
    // duplicate (and risk diverging from) that gate.
    // Early, non-fatal warning if a configured local backend looks unreachable.
    // The fail-hard enforcement happens at launch (preflightRoleTarget); here we
    // only nudge so the user gets feedback before they kick off a task.
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
    taskId?: string,
  ): Promise<void> {
    // Fail hard before launch if the agent's backend is unreachable — never
    // silently fall back to a different backend (CLAUDE.md: fail hard).
    await preflightRoleTarget('agent', this.agentTarget());
    await launchSupervisorAsync(sandbox, runName, protocolDir, debug ?? false, this.binary, daemonConfigPath, this.agentTarget(), taskId);
  }

  async runClaudeSync(
    prompt: string,
    sandbox: SandboxConfig,
    verbose?: boolean,
    debug?: boolean,
    model?: string,
  ): Promise<AgentResponse> {
    return runClaude(prompt, sandbox, verbose ?? false, debug ?? false, model, this.binary, this.agentTarget());
  }

  async isRunning(runName: string): Promise<boolean> {
    return isContainerRunning(runName, this.binary);
  }

  async runExists(runName: string): Promise<boolean> {
    return containerExists(runName, this.binary);
  }

  async getRunInfo(runName: string): Promise<RunInfo | null> {
    return dockerGetContainerInfo(runName, this.binary);
  }

  async getRunExitCode(runName: string): Promise<number | null> {
    return getContainerExitCode(runName, this.binary);
  }

  async getRunLogs(runName: string, tailLines?: number): Promise<string | null> {
    return getContainerLogs(runName, tailLines, this.binary);
  }

  async execInRun(runName: string, argv: string[], opts?: { timeoutMs?: number }): Promise<number | null> {
    // Output is inherited, not captured: the caller is passing a diagnostic
    // through to a human, and re-printing a captured buffer would reorder
    // stdout against stderr and delay every line to the end of the run.
    //
    // No `-t`: allocating a pty would translate newlines and inject control
    // characters into output that gets pasted into issues. Nothing lazy runs
    // this way colorizes, so there is nothing to gain for the cost.
    const proc = spawn([this.binary, 'exec', runName, ...argv], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      // The default 60s subprocess timeout is too short for what runs in here
      // (the MCP self-test alone allows 20s, `--probe-agent` 90s), and a
      // timeout kill would look exactly like a failing check.
      timeout: opts?.timeoutMs ?? 300_000,
    });
    return await proc.exited;
  }

  async stopRun(runName: string, opts?: { gracefulTimeoutSeconds?: number }): Promise<boolean> {
    try {
      // Default: `kill` (immediate SIGKILL), not `stop` (SIGTERM + ~10s grace +
      // SIGKILL) — an agent's container has no graceful shutdown to wait for, and
      // `stop`'s grace period is pure latency here.
      //
      // `gracefulTimeoutSeconds` switches to `stop --time <n>`, which delivers
      // SIGTERM (forwarded to the supervisor by the container's `--init` PID 1)
      // and escalates to SIGKILL only if the container overstays. Builders are
      // stopped this way by `lazy upgrade`: their supervisor's SIGTERM handler
      // flushes the conversation capture and stamps the resume session id, and
      // SIGKILL skipped both — which is what left an upgrade-relaunched builder
      // with no session to resume.
      const args = opts?.gracefulTimeoutSeconds != null
        ? [this.binary, 'stop', '--time', String(opts.gracefulTimeoutSeconds), runName]
        : [this.binary, 'kill', runName];
      // Async spawn (not spawnSync) because this runs in the daemon hot path
      // (stopTask in src/daemon/task-lifecycle.ts); a blocking spawn would freeze
      // the entire daemon event loop for the duration of the call.
      //
      // The docker CLI call itself must outlive the grace period it was asked to
      // wait out, or the timeout would kill `docker stop` mid-wait and report a
      // failure for a container that is shutting down exactly as instructed.
      const timeout = opts?.gracefulTimeoutSeconds != null
        ? DOCKER_TIMEOUT_MS + opts.gracefulTimeoutSeconds * 1000
        : DOCKER_TIMEOUT_MS;
      const proc = spawn(
        args,
        { stdout: 'ignore', stderr: 'ignore', timeout },
      );
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      // stopRun's contract is "true on success" — a spawn failure (binary missing,
      // container already gone) is reported as a non-success, not propagated.
      return false;
    }
  }

  async removeRun(runName: string): Promise<void> {
    await removeContainer(runName, this.binary);
  }

  async discoverRunningRuns(): Promise<string[]> {
    try {
      // Query container names and their project labels in one call.
      // Format: "name\tlabel" where label is empty for unlabeled (pre-label) containers.
      const proc = spawn(
        [this.binary, 'ps', '--filter', 'name=^lazy-',
         '--format', `{{.Names}}\t{{.Label "${PROJECT_LABEL_KEY}"}}`],
        { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS },
      );
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (exitCode !== 0) return [];
      const output = stdout.trim();
      if (!output) return [];

      const lines = output.split('\n').filter(Boolean);
      const names: string[] = [];

      for (const line of lines) {
        const [name, label] = line.split('\t');
        if (!name) continue;

        if (this.lazyRoot) {
          // Project-scoped filtering: include containers that belong to this project
          // (matching label) OR have no label at all (backward compat with pre-label containers).
          if (label === this.lazyRoot || !label) {
            names.push(name);
          }
        } else {
          // No project root available — return all (legacy behavior).
          names.push(name);
        }
      }

      return names;
    } catch {
      return [];
    }
  }

  async discoverProjectBuilderRuns(projectRoot: string): Promise<string[]> {
    try {
      const proc = spawn(
        [
          this.binary, 'ps',
          '--filter', 'name=^lazy-builder-',
          '--filter', `label=${PROJECT_LABEL}=${projectRoot}`,
          '--format', '{{.Names}}',
        ],
        { stdout: 'pipe', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS },
      );
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (exitCode !== 0) return [];
      const output = stdout.trim();
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

  agentSessionProjectDir(worktreePath: string): string {
    // Docker/Podman run Claude with HOME pointed at the in-worktree sandbox,
    // so its session JSONL lands under <worktree>/.lazy-task-sandbox/.claude.
    const encoded = encodeProjectPath(worktreePath);
    return join(worktreePath, SANDBOX_DIR, '.claude', 'projects', encoded);
  }

  supervisorToolChecks(): { cmd: string; name: string; hint: string }[] {
    return agentPackaging.supervisorToolChecks();
  }

  mcpServerConfig(
    taskId: string,
    worktreePath: string,
    opts?: { readOnly?: boolean },
  ): { command: string; args: string[] } {
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
      args: [
        'mcp',
        '--daemon-config', daemonConfigTemplate,
        '--task-id', taskId,
        '--worktree', worktreePath,
        // Read-only turns must be scoped HERE. Proxy handlers run the tool in
        // the daemon, which does not inherit the supervisor's
        // LAZY_MCP_READ_ONLY, so the in-handler guard cannot see this turn.
        ...(opts?.readOnly ? ['--read-only'] : []),
      ],
    };
  }

  async diagnose(): Promise<HealthCheck[]> {
    const results: HealthCheck[] = [];
    const timeout = 10_000;

    // Check binary installed
    try {
      const proc = spawn([this.binary, '--version'], {
        stdout: 'pipe', stderr: 'ignore', timeout,
      });
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (exitCode === 0) {
        const raw = stdout.trim();
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
      const proc = spawn([this.binary, 'info'], {
        stdout: 'ignore', stderr: 'ignore', timeout,
      });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
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
    return dockerAgentInstructions;
  }

  getBuilderInstructions(): string {
    return dockerBuilderInstructions;
  }

  /**
   * Probe whether the in-container `user` can WRITE the per-builder isolation
   * dir when it's bind-mounted at the same path Claude will use. This is the
   * faithful test: it runs a throwaway container from the SAME image with NO
   * `--user` override (so it runs as the image's default `user`, exactly like
   * the real builder) and tries to create+remove a file under the overlay mount
   * point. Exit 0 ⇒ writable ⇒ safe to isolate; anything else ⇒ fall back.
   *
   * Why a container probe and not a host-side uid check: ownership semantics for
   * bind mounts depend on the platform (Docker Desktop's VM maps uids, userns
   * remapping shifts them, Linux-native preserves host uid). Only an actual
   * write as the container user reflects what Claude will experience. Cost is one
   * short-lived container (~hundreds of ms) per launch — acceptable for an
   * interactive command, and the price of never shipping a broken overlay.
   *
   * Conservative by design: any error (spawn failure, timeout, non-zero exit)
   * returns false so we degrade to the shared dir rather than risk a broken run.
   */
  private async probeProjectsDirWritable(hostDir: string, imageName: string): Promise<boolean> {
    try {
      const probeTarget = '/home/user/.claude/projects/.lazy-write-probe';
      const proc = spawn(
        [
          this.binary, 'run', '--rm', '--init',
          '-v', `${hostDir}:/home/user/.claude/projects`,
          imageName,
          'sh', '-c', `touch ${probeTarget} && rm -f ${probeTarget}`,
        ],
        { stdout: 'ignore', stderr: 'ignore', timeout: DOCKER_TIMEOUT_MS },
      );
      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      // Conservative: treat any probe failure as "not writable" → fall back.
      return false;
    }
  }

  async launchBuilderInteractive(
    lazyRoot: string,
    systemPrompt: string,
    builderConfigPath: string,
    claudeExtraArgs: string[],
    debug?: boolean,
    daemonConfigPath?: string,
    projects?: BuilderLaunchProjects,
  ): Promise<{ exitCode: number; sessionId: string | null }> {
    // Fail hard before launch if the builder's backend is unreachable.
    await preflightRoleTarget('builder', this.builderTarget());

    const [imageName, agentBinaryPath] = await Promise.all([
      ensureImage(this.binary),
      ensureAgentBinary(),
    ]);

    // The builder container is launched here by the CLI CLIENT process, not by
    // the daemon — so it cannot inherit the daemon's environment. Source the
    // credential from the daemon over RPC instead of from this process's env,
    // which in a daemon-only-env deployment legitimately has none. (Reading the
    // client env here was the cause of the spurious "Authentication required"
    // failure on `lazy builder`.) Passing the config arms the proxy fail-loud
    // gate on this last hop too: with [proxy] enabled, a builder that ends up
    // with no proxy address fails instead of connecting direct.
    const { loadConfig } = await import('../config/loader');
    const config = await loadConfig(lazyRoot);
    //
    // The builder authenticates with the DAEMON's credential, exactly like a
    // task agent and like pairing. It never falls back to the human's own
    // ~/.claude/.credentials.json — see src/builder/claude-home.ts for why that
    // store is deliberately shadowed inside the container.
    const authEnvVars = await resolveAuthEnvFromDaemon(this.builderTarget(), { role: 'builder' }, 'container', config);

    // Read the builder config to get port for the container config
    const builderConfig = JSON.parse(readFileSync(builderConfigPath, 'utf-8'));

    // Get the data directory path for mounting
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

    // Prepare the builder's ~/.claude.json: persisted builder state (seeded once
    // from the host's) + THIS launch's lazy MCP server entry. Claude Code reads
    // this at $HOME root, not inside ~/.claude/. It is a separate file so the
    // human's real config is never modified.
    //
    // The mounted copy is PER LAUNCH and the persisted state is written back on
    // exit. Mounting one stable file into every builder of a project was the
    // cause of "builder comes up with no lazy_* tools after an upgrade": the
    // entry carries a per-launch `--daemon-config` path, and a second launch
    // rewriting the shared file in place is visible through the first
    // container's bind mount — pointing it at a token file it never had. See
    // src/builder/claude-home.ts for the full mechanism.
    const persistedConfigFile = builderClaudeConfigPath(dataDir);
    const mergedConfigFile = builderClaudeSessionConfigPath(tmpDir, builderId);
    await writeBuilderSessionClaudeConfig({
      sessionPath: mergedConfigFile,
      persistedPath: persistedConfigFile,
      hostConfigPath: join(getHome(), '.claude.json'),
      mcpArgs,
      onWarn: (message) => logger.warn(message),
    });
    // Removed only AFTER its state is folded back into the persisted file.
    tempFilesToClean.push(mergedConfigFile);

    // Shadow the human's credential store inside the container. The builder runs
    // on the daemon credential; leaving the host's ~/.claude/.credentials.json
    // readable let Claude Code's 401-recovery path swap that credential for the
    // host's stale one and then demand /login. See src/builder/claude-home.ts.
    const neutralCredentialStore = await writeNeutralCredentialStore(tmpDir, builderId);
    tempFilesToClean.push(neutralCredentialStore);

    // Pre-approve read-only lazy MCP tools so the builder doesn't prompt for permission.
    // Mutating tools (create, start, accept, etc.) still require user confirmation.
    await writeToolPermissions(BUILDER_READ_ONLY_TOOLS);

    // Self-healing isolation: only overlay the per-builder projects dir if the
    // container user can actually WRITE it. This is the one failure mode that
    // can't be detected host-side: on Linux-native docker a bind mount preserves
    // host ownership, so the in-container `user` (uid 1000) may be unable to
    // write a dir created by a host uid that differs (Docker Desktop / userns
    // remapping make this a non-issue, but we can't assume that). If Claude
    // started against an unwritable overlay it would fail to create session
    // JSONL — breaking the builder. So we PROBE first and fall back to the
    // shared ~/.claude/projects dir (today's behavior) when the probe fails.
    //
    // EXCEPTION (the residual auto-resume fix): when host-side resolution located
    // this dir because it ALREADY HOLDS the resume target's session
    // (projects.trustWritable), the dir is known-writable — Claude wrote that
    // session's JSONL into it through a container user that could write there. A
    // write-probe can transiently fail (e.g. a `docker run` timeout under upgrade
    // load); letting that flip drop the mount would strand `--resume`, since the
    // session lives ONLY in this dir. So we skip the probe and mount it. A fresh
    // (untrusted) dir has no session at stake, so the probe still gates it.
    let useProjectsMount = false;
    if (projects) {
      const probeWritable = projects.trustWritable
        ? true // known-writable — skip the probe (avoids a transient-failure flip)
        : await this.probeProjectsDirWritable(projects.hostDir, imageName);
      useProjectsMount = shouldMountProjectsDir({ trustWritable: projects.trustWritable, probeWritable });
      if (!useProjectsMount) {
        logger.warn(
          `Per-builder Claude projects isolation is disabled for this run: the container ` +
          `user could not write the isolation dir (${projects.hostDir}). Falling back to the ` +
          `shared ~/.claude/projects dir. Concurrent builders may cross-capture sessions ` +
          `this run; single-builder /clear-resume is unaffected.`,
        );
      }
    }

    // Builder scratch dir — writable, outside the repo, mounted at the SAME
    // absolute path so a path the builder prints pastes into a host shell.
    // Derived from lazyRoot alone (no config), so this runner and the
    // host-process runner cannot disagree about where it is. See
    // src/builder/scratch.ts. Never mounted into a task-agent container.
    const scratchDir = await ensureBuilderScratchDir(lazyRoot);

    // Build container args: launch lazy-agent in builder mode.
    const dockerArgs = buildBuilderDockerArgs({
      binary: this.binary,
      builderId,
      lazyRoot,
      scratchDir,
      dataDir,
      containerConfigFile,
      agentBinaryPath,
      home: getHome(),
      projectsHostDir: useProjectsMount ? projects!.hostDir : undefined,
      neutralCredentialStore,
      mergedConfigFile,
      authEnvVars,
      imageName,
      promptFile,
      daemonConfigPath: useDaemonProxy ? daemonConfigPath : undefined,
      claudeExtraArgs,
      debug: debug ?? false,
    });

    if (debug) {
      console.log('[DEBUG] Running builder container command:', redactSecrets(dockerArgs).join(' '));
    }

    // Fail loud BEFORE the container starts if the MCP credential the builder is
    // about to be pointed at is not on disk. Without this the container starts,
    // Claude Code's MCP child exits on a missing file, and the human discovers
    // several turns later that the builder has no lazy_* tools at all.
    if (useDaemonProxy) {
      await assertDaemonMcpConfigMounted(daemonConfigPath!, mergedConfigFile);
    }

    logger.info('Launching builder container...');

    const proc = spawn(dockerArgs, {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      timeout: 0, // Long-running: supervisor runs for the lifetime of the task
    });

    const exitCode = await proc.exited;

    // Fold this session's ~/.claude.json (onboarding, folder trust, model
    // choice, MCP approvals Claude Code wrote inside the container) back into
    // the persisted per-project state, BEFORE the per-launch copy is unlinked.
    await persistBuilderSessionClaudeConfig({
      sessionPath: mergedConfigFile,
      persistedPath: persistedConfigFile,
      onWarn: (message) => logger.warn(message),
    });

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

export interface BuilderDockerArgsParams {
  binary: string;
  builderId: string;
  lazyRoot: string;
  dataDir: string;
  /**
   * Builder scratch dir on the host (see src/builder/scratch.ts). Mounted
   * read-write at the identical absolute path. BUILDER ONLY — no agent launch
   * path takes this parameter, and none may ever mount it.
   */
  scratchDir: string;
  containerConfigFile: string;
  agentBinaryPath: string;
  /** Host home dir — source of the ~/.claude mount. */
  home: string;
  /** Per-builder Claude projects dir, when the write-probe cleared it. */
  projectsHostDir?: string;
  neutralCredentialStore: string;
  mergedConfigFile: string;
  authEnvVars: Array<{ key: string; value: string }>;
  imageName: string;
  promptFile: string;
  /** Path to this builder's daemon MCP config, when running in daemon proxy mode. */
  daemonConfigPath?: string;
  claudeExtraArgs: string[];
  debug: boolean;
}

/**
 * Container argv for an interactive builder.
 *
 * Split out of launchBuilderInteractive so the mount set is inspectable without
 * running Docker: test/unit/daemon-dir-never-mounted.test.ts asserts that no
 * mount source exposes the daemon state dir — see the INVARIANT comment there.
 *
 * --init provides a proper PID 1 init process (tini/catatonit) that forwards
 * signals and reaps zombies. Required for Podman where conmon doesn't provide
 * PID 1 protection, and harmless for Docker. Without it, interactive applications
 * (like Claude Code's trust prompt TUI) can hang in Podman after terminal mode
 * switches — see https://github.com/google-gemini/gemini-cli/issues/17275.
 */
export function buildBuilderDockerArgs(params: BuilderDockerArgsParams): string[] {
  const {
    binary, builderId, lazyRoot, dataDir, scratchDir, containerConfigFile, agentBinaryPath,
    home, projectsHostDir, neutralCredentialStore, mergedConfigFile, authEnvVars,
    imageName, promptFile, daemonConfigPath, claudeExtraArgs, debug,
  } = params;

  const dockerArgs = [
    binary, 'run', '-it', '--init', '--rm',
    '--name', `lazy-builder-${builderId}`,
    // Scope this container to the project. Other projects' `lazy upgrade`,
    // discovery, and cleanup commands filter on this label to avoid
    // cross-project interference (see discoverProjectBuilderRuns).
    '--label', `${PROJECT_LABEL}=${lazyRoot}`,
    // Allow container to reach host TCP server via host.docker.internal
    // (built-in on macOS Docker Desktop; needs this flag on Linux)
    '--add-host=host.docker.internal:host-gateway',
    // Mount repo READ-ONLY — all writes happen on host via HTTP
    '-v', `${lazyRoot}:${lazyRoot}:ro`,
    // Mount data dir read-write (conversation capture needs write access)
    '-v', `${dataDir}:${dataDir}`,
    // Builder scratch dir: read-write, at the identical host path so anything
    // the builder writes is readable by the human with the path as printed.
    // Lives outside the repo (~/.lazy/scratch/<project-slug>), so it can never
    // be committed. BUILDER ONLY — see src/builder/scratch.ts.
    '-v', `${scratchDir}:${scratchDir}`,
    '-e', `${SCRATCH_ENV_VAR}=${scratchDir}`,
    // Container-specific builder config (has host.docker.internal)
    '-v', `${containerConfigFile}:${containerConfigFile}:ro`,
    // MCP binary for proxy tool access
    '-v', `${agentBinaryPath}:/usr/local/bin/lazy-agent:ro`,
    // Claude config dir (settings, conversations, credentials) — mount to container's home
    // so Claude Code finds them at $HOME/.claude and $HOME/.claude.json without needing
    // to override HOME (which would cause warnings about missing .local/bin).
    '-v', `${home}/.claude:/home/user/.claude`,
    // Per-builder projects isolation: overlay a dedicated host dir at
    // ~/.claude/projects (a deeper, more-specific bind than the ~/.claude mount
    // above, so it shadows only the projects subtree). This gives THIS builder
    // its own Claude session JSONL dir, so post-/clear session ownership is
    // evidence-based and concurrent builders never cross-capture. Creds/settings/
    // .claude.json stay shared via the ~/.claude mount. See projects-isolation.ts.
    // Gated on the write-probe above so an unwritable overlay never breaks the run.
    ...(projectsHostDir ? ['-v', `${projectsHostDir}:/home/user/.claude/projects`] : []),
    // Credential-store isolation: another deeper, more-specific bind over the
    // ~/.claude mount, shadowing ONLY .credentials.json with an empty store.
    // The builder authenticates from the daemon credential in its env; leaving
    // the human's real record visible let a single transient 401 replace that
    // credential with the host's stale token and strand the builder in /login.
    // Writable, so an in-container /login still works for that container's
    // lifetime — it just cannot reach through to the host record.
    '-v', `${neutralCredentialStore}:${CONTAINER_CREDENTIAL_STORE}`,
    // Persisted builder Claude config with MCP server entry (writable — Claude
    // Code updates it on startup and when the human answers a trust/model prompt)
    '-v', `${mergedConfigFile}:/home/user/.claude.json`,
    // Auth
    ...authEnvVars.flatMap(v => ['-e', `${v.key}=${v.value}`]),
    // SSH: auto-accept new host keys without TTY prompt (accept-new still rejects changed keys)
    '-e', 'GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new',
    // Working directory
    '-w', lazyRoot,
  ];

  // Mount daemon config file if using daemon proxy. This file is the ONLY
  // thing from the daemon state dir a container may ever see: a single file,
  // read-only, holding just this builder's own token.
  if (daemonConfigPath) {
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
    // Stable builder id so the supervisor can stamp the detected Claude
    // sessionId onto this builder's resume intent on exit (host gets
    // sessionId: null from the runner — only the supervisor knows the id).
    '--builder-id', builderId,
  );

  // Pass daemon config to builder supervisor if available
  if (daemonConfigPath) {
    dockerArgs.push('--daemon-config', daemonConfigPath);
  }

  // Pass through extra Claude args after --
  if (claudeExtraArgs.length > 0) {
    dockerArgs.push('--', ...claudeExtraArgs);
  }

  if (debug) {
    dockerArgs.splice(dockerArgs.indexOf(imageName), 0, '-e', 'DEBUG=1');
  }

  return dockerArgs;
}
