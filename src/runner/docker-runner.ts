import { withLaunchInFlight } from './launch-in-flight';
/**
 * DockerRunner — Runner implementation backed by Docker containers.
 *
 * Thin wrapper around the existing functions in capture/claude.ts.
 * No functional changes from the pre-Runner behavior.
 */

import type { SandboxConfig } from '../capture/claude';
import type { AgentResponse } from '../types';
import type { Runner, RunInfo, FollowHandle, HealthCheck, RunStream, DiagnoseOptions, RunInfoProbe } from './types';
import type { PhaseNotify } from '../daemon/progress';
import { parsePortBindings, type PortBinding } from '../serve/ports';
import type { RunnerType, RoleTarget } from '../config/types';

import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { mkdir as mkdirAsync, writeFile as writeFileAsync, chmod as chmodAsync } from 'fs/promises';
import { spawn } from '../utils/spawn';
import { join, basename } from 'path';
import { getHome } from '../utils/home';
import { logger } from '../utils/logger';
import { redactSecrets } from '../utils/redact';
import {
  checkTargetConnectivity,
  preflightRoleTarget,
  probesUpstream,
  ANTHROPIC_DEFAULT_TARGET,
} from '../utils/role-target';

import {
  checkDocker,
  ensureImage,
  ensureAgentBinary,
  containerNameForTask,
  launchSupervisorAsync,
  runClaude,
  getLaunchAuthEnvVars,
  isContainerRunning,
  containerExists,
  getContainerInfo as dockerGetContainerInfo,
  probeContainerInfo,
  getContainerExitCode,
  getContainerLogs,
  removeContainer,
  resolveImageName,
  localImageExists,
} from '../capture/claude';

import { ClaudeCodePackaging } from '../agent/claude-code-packaging';
import { getAgentPackaging } from '../agent/registry';
import type { Agent } from '../agent/interface';
import { encodeProjectPath } from '../import/claude-code-logs';
import { projectsDirHoldsSession, shouldMountProjectsDir, type BuilderLaunchProjects } from '../builder/projects-isolation';
import { ensureBuilderScratchDir, SCRATCH_ENV_VAR } from '../builder/scratch';
import {
  CONTAINER_CREDENTIAL_STORE,
  builderClaudeConfigPath,
  builderClaudeSessionConfigPath,
  persistBuilderSessionClaudeConfig,
  writeBuilderSessionClaudeConfig,
  writeNeutralCredentialStore,
  builderSessionLaunchDir,
} from '../builder/claude-home';
import { assertDaemonMcpConfigMounted } from '../builder/mcp-config-check';
import { assertSiblingContainerLaunchSupported } from './sibling-containers';
import { writeMcpLaunchWrapper } from '../builder/mcp-launch-wrapper';
import { builderSupervisorLogPath, builderSupervisorLogHostPath } from '../builder/supervisor-log-path';
import { printableTail } from '../utils/terminal-text';
import { SANDBOX_DIR } from '../utils/sandbox';
import { resolveAuthEnvFromDaemon } from '../daemon/auth-env';
import type { LaunchIdentity } from '../proxy/placeholder-env';
import { findLazyRoot } from '../project-paths';
import { projectSlug } from '../daemon/paths';
import type { OneshotRequest, OneshotRepoAccess } from '../oneshot/types';
import type {
  LaunchBuilderHeadlessParams, LaunchBuilderHeadlessResult,
  LaunchBuilderDetachedParams, LaunchBuilderDetachedResult,
} from './types';
import {
  buildOneshotAgentArgv,
  resolveOneshotTimeoutMs,
  DEFAULT_ONESHOT_TIMEOUT_MS,
  ONESHOT_KILL_GRACE_MS,
} from '../oneshot/args';
import { execBoundedOneshot } from '../oneshot/exec';
import { buildBuilderHeadlessClaudeArgs, builderHeadlessModel, parseBuilderHeadlessStdout } from './builder-headless';
import { detectBuilderLaunchSessionId } from '../builder/session-detect';
import { ensureOneshotAgentHome } from '../oneshot/state-dir';
import dockerBuilderInstructions from '../prompts/docker-builder-runner-instructions.md' with { type: 'text' };
import dockerAgentInstructions from '../prompts/docker-agent-instructions.md' with { type: 'text' };
import { writeToolPermissions } from '../mcp/config';
import { READ_ONLY_TOOL_NAMES } from '../mcp/tool-access';
import { isToolForRole } from '../mcp/tool-roles';

// Agent packaging for tool checks. Instantiated once; stateless.
const agentPackaging = new ClaudeCodePackaging();

const DOCKER_TIMEOUT_MS = 10_000;
/** At most this much of a dead builder's supervisor log is read. */
const SUPERVISOR_LOG_READ_BYTES = 64 * 1024;

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
const BUILDER_READ_ONLY_TOOLS = READ_ONLY_TOOL_NAMES.filter(n => isToolForRole(n, 'builder'));

/** Docker label key used to scope containers to a project root. */
export const PROJECT_LABEL_KEY = 'lazy.project';

/**
 * Label marking a container as a machine one-shot rather than a task run. Both
 * carry PROJECT_LABEL, so this is what tells them apart without parsing names.
 */
export const ONESHOT_LABEL = 'lazy.oneshot=1';

/**
 * Distinct name per one-shot container. One-shots can overlap — `lazy report`
 * fans out map units concurrently — so a fixed name would make the second run
 * collide with the first.
 */
let oneshotCounter = 0;
function oneshotContainerName(lazyRoot: string): string {
  oneshotCounter += 1;
  return `lazy-oneshot-${projectSlug(lazyRoot)}-${process.pid}-${oneshotCounter}`;
}

/**
 * Who a one-shot's credential grant belongs to.
 *
 * Pure and exported for the same reason {@link buildOneshotDockerArgs} is: the
 * credential posture of a one-shot is a property of this value, and a test that
 * had to launch a container to check it would never be written.
 *
 * Three decisions are load-bearing:
 *
 * - **Role `builder`.** A one-shot is a fresh-context call lazy makes on the
 *   HUMAN's behalf, not a turn on anyone's session: it strips
 *   `--resume`/`--continue`, so it inherits no session and no prompt cache from
 *   the task it may be about. It therefore runs the builder role's target
 *   throughout — endpoint, credential, harness, model — and its grant says so,
 *   because the role is what the audit trail records and what the proxy routes
 *   on. An `agent`-role grant would redeem the placeholder against the task
 *   agent's upstream while the argv was composed from the builder's.
 * - **The profile is read off the target this launch was composed FROM.** The
 *   proxy forwards a verified caller to the upstream its grant's profile
 *   resolves to, and pays that upstream with the credential mapped to it
 *   (`src/proxy/agent-upstreams.ts`), while the env in the argv came from
 *   `builderTarget()` — that profile's endpoint, wire and credential. Naming any
 *   other profile would redeem the placeholder against a different upstream
 *   than the one this argv was built for; naming none would silently take the
 *   proxy's PRIMARY upstream, which is the pre-profiles behaviour.
 * - **The label is per-project, and per-TASK when there is a task.** A grant is
 *   keyed on `identityKey`, which for the builder role ignores the task id and
 *   uses the label alone — so a single `oneshot:<root>` label would hand every
 *   later task the FIRST task's grant, and the proxy (which reads the task id
 *   off the grant, not off the request header) would attribute all of them to
 *   that first task. A `:<taskId>` suffix keeps attribution honest. The taskless
 *   form stays stable and per-project: a taskless one-shot has no lifecycle
 *   event to be revoked on, so a per-RUN label would leave one live placeholder
 *   behind for every `lazy ask` / `lazy report`, forever.
 *
 * A one-shot ABOUT a task is attributed to that task and revoked with it —
 * `revokeTaskCredentialGrants` filters on task id regardless of role, so these
 * task-scoped builder grants are cleaned up at task end and are excluded from
 * the builder-grant cap (see `src/proxy/credential-broker.ts`) rather than
 * pressuring it and evicting a live builder session.
 */
export function oneshotLaunchIdentity(
  lazyRoot: string,
  profile: string,
  taskId?: string | null,
): LaunchIdentity {
  return {
    role: 'builder',
    taskId: taskId ?? null,
    label: taskId ? `oneshot:${lazyRoot}:${taskId}` : `oneshot:${lazyRoot}`,
    profile,
  };
}

/**
 * Compose the full `docker run` argv for a one-shot.
 *
 * Pure and exported so the isolation posture is assertable without a Docker
 * daemon: "no repo mount when none was asked for" and "`:ro` when it was" are
 * properties of this array, and a test that has to spawn a container to check
 * them is a test nobody runs.
 */
export function buildOneshotDockerArgs(opts: {
  binary: string;
  containerName: string;
  lazyRoot: string;
  repoAccess: OneshotRepoAccess;
  agentStateHome: string;
  imageName: string;
  authEnvVars: { key: string; value: string }[];
  /** The agent BINARY the one-shot runs — a harness, not a profile name. */
  harness: string;
  prompt: string;
  model?: string;
  /** Effort fixed by the one-shot's KIND. See OneshotRequest.effort. */
  effort?: string;
}): string[] {
  const agentConfigDir = getAgentPackaging(opts.harness).configDirName();
  return [
    opts.binary, 'run', '--rm', '--init',
    '--name', opts.containerName,
    '--label', `${PROJECT_LABEL}=${opts.lazyRoot}`,
    // Marks this container as a one-shot rather than a task run, so anything
    // enumerating lazy containers can tell the two apart without parsing names.
    '--label', ONESHOT_LABEL,
    // The proxy listens on the host; without this the container cannot reach it.
    '--add-host=host.docker.internal:host-gateway',
    // INVARIANT: never `:rw`, and no mount at all unless the call site declared
    // it needs the repo. A one-shot has no business writing to the project —
    // this is what makes the accept-time commit-on-main bug structurally
    // impossible rather than merely disallowed by argv.
    ...(opts.repoAccess === 'read-only'
      ? ['-v', `${opts.lazyRoot}:${opts.lazyRoot}:ro`, '-w', opts.lazyRoot]
      : []),
    '-v', `${opts.agentStateHome}:/home/user/${agentConfigDir}`,
    ...opts.authEnvVars.flatMap(v => ['-e', `${v.key}=${v.value}`]),
    opts.imageName,
    ...buildOneshotAgentArgv(opts.harness, opts.prompt, opts.model, opts.effort),
  ];
}

export class DockerRunner implements Runner {
  readonly type: RunnerType;
  readonly runLabel = 'Container';
  protected readonly binary: string;
  private lazyRoot: string | undefined;
  protected _roleTargets?: { builder: RoleTarget; agent: RoleTarget };
  protected _agent?: Agent;
  /** The `[agents.<name>]` profile `_agent` was resolved from. See setAgent. */
  protected _agentProfile?: string;

  constructor(binary: string = 'docker', type: RunnerType = 'docker', lazyRoot?: string) {
    this.binary = binary;
    this.type = type;
    this.lazyRoot = lazyRoot;
  }

  /**
   * Prepare what every launch needs — the runner image and the agent binary —
   * ahead of the first launch. Both are idempotent and cached; this only moves
   * a cold build out of whichever launch would otherwise pay for it
   * (src/daemon/launch-warmup.ts).
   */
  async prepareLaunchInputs(notify?: (detail: string) => void): Promise<void> {
    await Promise.all([ensureImage(this.binary, notify ? { notify } : undefined), ensureAgentBinary()]);
  }

  /** Set the per-role model targets (builder vs agent backends). */
  setRoleTargets(targets: { builder: RoleTarget; agent: RoleTarget }): void {
    this._roleTargets = targets;
  }

  /**
   * Set the task's agent so launches build the right image, forward the right
   * credentials, and run the right tool checks. Called by the daemon's task
   * paths (task-lifecycle/task-launcher) after createRunner.
   *
   * `profileName` is the `[agents.<name>]` profile the task selected, which the
   * daemon resolved `agent` FROM. Both travel together deliberately: the
   * registry entry decides which binary runs, the profile name decides where
   * the proxy forwards its traffic and whose credential pays, and a runner told
   * only one of the two would have to guess the other.
   */
  setAgent(agent: Agent, profileName?: string): void {
    this._agent = agent;
    this._agentProfile = profileName;
  }

  /**
   * Point the agent role at the profile THIS task selected. See
   * {@link Runner.setAgentTarget}.
   *
   * The live proxy address is carried across from the role target rather than
   * re-resolved: it is a fact about the daemon serving this launch, not a
   * property of any profile, and `withProxyTargets` already paid for it (and
   * already failed loudly if it could not be resolved). `primaryUpstream`
   * travels with it for the same reason — it is `[proxy] upstream`, a property
   * of the daemon's proxy rather than of the profile being switched in.
   */
  setAgentTarget(target: RoleTarget): void {
    const current = this.agentTarget();
    this._roleTargets = {
      builder: this._roleTargets?.builder ?? ANTHROPIC_DEFAULT_TARGET,
      agent: current.proxyUrl
        ? { ...target, proxyUrl: current.proxyUrl, primaryUpstream: current.primaryUpstream }
        : target,
    };
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
    // FIRST, and before Docker is even probed: a deployment whose Docker host
    // is a foreign filesystem cannot run ANY workload container here.
    //
    // This is the placement that matters, not the two launch sites. Every
    // task-turn path — start, unblock, resume, auto-resume, auto-delivery —
    // calls this during preflight, BEFORE a worktree is created, a branch is
    // cut, a session row is written or a credential placeholder is minted.
    // Refusing at launch instead left the task `interrupted`, which reads as a
    // crash: the reconciler auto-resumed it, the slow lane re-queued it, and
    // each attempt rebuilt all of that just to refuse again. The condition is
    // static and environment-only, so there is nothing to retry — refuse while
    // the task still has its pre-start status and let the caller's 4xx/5xx say
    // why. auto-resume catches this and skips, which is exactly right.
    assertSiblingContainerLaunchSupported('use the docker runner');
    await checkDocker(this.binary);
    // Auth is NOT enforced here. The turn credential gate
    // (src/daemon/credential-gate.ts, asked by planTurnCredential before every
    // turn launch) is the single enforcement point, and it refuses by PROFILE —
    // a redundant runner-level check would duplicate (and risk diverging from)
    // it, and would know nothing about which profile the turn runs on.
    // Early, non-fatal warning if a profile whose upstream lazy probes looks
    // unreachable. The fail-hard enforcement happens at launch
    // (preflightRoleTarget); here we only nudge so the user gets feedback before
    // they kick off a task.
    for (const role of ['agent', 'builder'] as const) {
      const target = role === 'agent' ? this.agentTarget() : this.builderTarget();
      // The same rule the launch-time preflight applies, so the nudge cannot
      // go quiet for an upstream that will refuse the launch a moment later —
      // which is exactly what a pi profile on the default local Ollama is.
      if (!probesUpstream(target)) continue;
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
    taskUuid?: string,
    pinnedImage?: string,
    notify?: PhaseNotify,
  ): Promise<void> {
    // Belt to checkAvailability's braces. That is where a start, unblock or
    // resume is refused BEFORE any task state is written; this catches a launch
    // path that reached here some other way, so the last thing before the argv
    // is built is still a refusal rather than a container mounted on
    // directories the host daemon invented. See src/runner/sibling-containers.ts.
    assertSiblingContainerLaunchSupported('start a task turn');
    // Fail hard before launch if the agent's backend is unreachable — never
    // silently fall back to a different backend (CLAUDE.md: fail hard).
    await preflightRoleTarget('agent', this.agentTarget());
    // The PROFILE, not the harness: the launch mints its credential grant
    // against this name, and that grant is how the proxy knows which upstream
    // and which credential this turn's traffic belongs to. Handing it
    // `_agent.id` would route every custom profile as if it were the built-in
    // of the same harness. Falling back to the harness is exact rather than
    // approximate — every harness name IS a built-in profile name.
    //
    // INVARIANT: a missing profile must FAIL, not default to claude-code.
    // Call sites that forgot setRunnerAgentForTask used to pass undefined here;
    // launchSupervisorAsync then resolved the default Anthropic profile, so a
    // cursor task's container never got CURSOR_API_KEY and fatal_auth'd while
    // sibling cursor tasks (launched on paths that did set the agent) worked.
    const agentProfile = this._agentProfile ?? this._agent?.id;
    if (!agentProfile) {
      throw new Error(
        `launchSupervisor called without an agent profile on the runner. ` +
        `Every launch path must call setRunnerAgentForTask (or applyRunnerAgent) ` +
        `before launch — otherwise a cursor/codex task silently gets the default ` +
        `claude-code credential environment and fails with fatal_auth.`,
      );
    }
    // Registered for the reconciler for as long as this takes — image build
    // included. See launch-in-flight.ts for the false interrupt this prevents.
    await withLaunchInFlight(runName, taskUuid, () => launchSupervisorAsync(
      sandbox,
      runName,
      protocolDir,
      debug ?? false,
      this.binary,
      daemonConfigPath,
      this.agentTarget(),
      taskId,
      taskUuid,
      agentProfile,
      pinnedImage,
      notify,
    ));
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

  /**
   * One-shot in a throwaway container from the project's agent image.
   *
   * The isolation is structural rather than advisory, which is the whole point
   * of moving one-shots behind the Runner: `repoAccess: 'none'` gets NO repo
   * mount, so there is no working tree to commit into; `'read-only'` gets the
   * project root mounted `:ro`, so a write fails at the kernel even if the tool
   * denial in the argv were somehow bypassed.
   *
   * `--rm` plus the project label means a one-shot container is reaped exactly
   * like every other lazy container — the host path's bespoke process reaper has
   * no counterpart to grow here.
   */
  async runOneshot(req: OneshotRequest): Promise<AgentResponse> {
    // Same gate as launchSupervisor, for the same reason: a one-shot mounts the
    // project root and an agent state dir by absolute path, and redeems its
    // credential placeholder against a proxy it reaches at host.docker.internal.
    // `lazy report`, `lazy ask` over a stored conversation and memory compaction
    // all come through here — the refusal names them.
    assertSiblingContainerLaunchSupported('run this in an agent container');
    const lazyRoot = this.lazyRoot ?? findLazyRoot();
    if (!lazyRoot) {
      throw new Error('Cannot run a one-shot: not in a lazy project. Run `lazy init` first.');
    }
    const repoAccess = req.repoAccess ?? 'none';

    // One resolution of the target for the whole launch: what is preflighted,
    // what the auth env is built from, and what the grant is minted for must be
    // the same profile — see oneshotLaunchIdentity.
    //
    // INVARIANT: that target is the BUILDER role's, never the agent role's and
    // never a task's. A one-shot is a fresh-context call lazy makes on the
    // human's behalf — it strips `--resume`/`--continue`, so a task's model
    // buys it no cache and no continuation, and a task's model id need not even
    // be valid on the builder's harness. Everything downstream follows from
    // this one line: endpoint, credential, wire, harness, model and image.
    const target = this.builderTarget();

    // Fail hard before launch if the backend is unreachable — a one-shot gets
    // the same treatment as a supervisor launch, never a silent fallback.
    await preflightRoleTarget('builder', target);

    // The harness the one-shot's argv is composed for. `createOneshotRunner`
    // sets `this._agent` from the builder profile's harness and refuses to build
    // a runner whose harness cannot run containerised one-shots, so the fallback
    // here only covers a runner assembled some other way.
    const harness = this._agent?.id ?? target.harness;
    // Always concrete: every harness refuses a model-less launch. A target with
    // no model resolves through the harness's declared default, never to an
    // omitted flag (see resolveBuilderModel).
    const { loadConfig } = await import('../config/loader');
    // Deferred for the same circular-init reason as buildOneshotAgentArgv's
    // registry import (agent-model reaches the registry).
    const { resolveBuilderModel } = await import('../agent/agent-model');
    const effectiveModel = resolveBuilderModel(
      await loadConfig(lazyRoot), { harness, model: target.model }, req.model,
    );

    // JIT CREDENTIALS: the container receives a redeemable PLACEHOLDER, never the
    // real credential. `docker run` argv is readable by anything that can run `ps`
    // or `docker inspect` for the life of the run, and a real key also means the
    // traffic need not traverse lazy's proxy — so the one-shot would escape the
    // wire allowlist, the audit trail and usage attribution along with it. The
    // grant is also what the proxy ROUTES by, so a one-shot without one takes the
    // primary upstream rather than its profile's.
    //
    // Minted LOCALLY rather than over the `getAuthEnv` RPC, because a one-shot
    // only ever executes where that RPC is bypassed: `runOneshot`
    // (src/oneshot/index.ts) reaches a Runner exclusively inside the daemon or
    // under the test harness, so `resolveAuthEnvFromDaemon` would fall through to
    // its daemon-self branch and hand back the real credential no matter what
    // identity it was given. This is the same seam every other in-daemon launch
    // uses (src/daemon/review-session-builder-turn.ts), and it degrades the same
    // way when there is no daemon context: no proxy to redeem a placeholder
    // against, so the credential is passed through unswapped as before.
    const authEnvVars = await getLaunchAuthEnvVars(
      oneshotLaunchIdentity(lazyRoot, target.profile, req.taskId),
      target,
      // Builder role, but still carrying the task id: the run is billed to the
      // builder credential (or, for a team-mode link description, to the member
      // in `ownerCredentialEnv`) and attributed to the task it is ABOUT, so accounting
      // for an accept-time summary still lands on that task.
      { role: 'builder', taskId: req.taskId },
      'container',
      // A human-owned run (a team-mode link description) carries its owner's
      // session placeholder, passed through unswapped by getLaunchAuthEnvVars.
      req.ownerCredentialEnv,
    );

    const agentConfigDir = getAgentPackaging(harness).configDirName();
    const agentStateHome = await ensureOneshotAgentHome(lazyRoot, agentConfigDir);

    const containerName = oneshotContainerName(lazyRoot);
    const args = buildOneshotDockerArgs({
      binary: this.binary,
      containerName,
      lazyRoot,
      repoAccess,
      agentStateHome,
      // ensureImage resolves the PROFILE to the harness it must bake in — the
      // builder's, so the image actually carries the binary this argv invokes.
      imageName: await ensureImage(this.binary, { agentId: target.profile }),
      authEnvVars,
      harness,
      prompt: req.prompt,
      model: effectiveModel,
      effort: req.effort,
    });

    logger.debug(`[oneshot] ${redactSecrets(args).join(' ')}`);

    return execBoundedOneshot(args, {
      timeoutMs: resolveOneshotTimeoutMs(req),
      label: `${this.binary} one-shot`,
      harness,
      // Killing the `docker run` CLIENT does not stop the CONTAINER, so a
      // timed-out one-shot would otherwise keep running with nobody watching it.
      onTimeout: async () => {
        await removeContainer(containerName, this.binary);
      },
    });
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

  async probeRunInfo(runName: string): Promise<RunInfoProbe> {
    return probeContainerInfo(runName, this.binary);
  }

  async getRunExitCode(runName: string): Promise<number | null> {
    return getContainerExitCode(runName, this.binary);
  }

  async getRunLogs(runName: string, tailLines?: number): Promise<string | null> {
    return getContainerLogs(runName, tailLines, this.binary);
  }

  async describeExitedRun(runName: string, opts: { rawLines: number; keepLines: number; supervisorLogHostFile?: string }): Promise<string[]> {
    const run = async (argv: string[]) => {
      try {
        const proc = spawn([this.binary, ...argv], { stdout: 'pipe', stderr: 'pipe', timeout: DOCKER_TIMEOUT_MS });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
        ]);
        return { stdout, stderr: stderr.trim(), exitCode };
      } catch (err) {
        return { stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: null };
      }
    };
    const lines: string[] = [];

    // The runtime's record: a container that never got as far as running its
    // command (a bad mount, a missing binary) says so in State.Error, and the
    // start/finish times tell "died at once" from "ran, then exited".
    const state = await run(['inspect', '--format', '{{json .State}}', runName]);
    if (state.exitCode === 0) {
      try {
        const s = JSON.parse(state.stdout) as Record<string, unknown>;
        lines.push(
          `Container: exit code ${String(s.ExitCode)}, started ${String(s.StartedAt)}, finished ${String(s.FinishedAt)}` +
          `${s.OOMKilled ? ', killed for running out of memory' : ''}${s.Error ? `, runtime error: ${String(s.Error)}` : ''}`,
        );
      } catch (err) {
        lines.push(`Container state unreadable: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      lines.push(`Could not read the container's state: ${state.stderr || `exit ${state.exitCode}`}`);
    }

    // What it printed. `getContainerLogs` folds every failure into null,
    // which read as "printed nothing"; here the two are told apart. Read wide
    // and keep the lines that survive stripping: a TTY program's last screen
    // can be pure escape codes, which a short raw tail reduces to nothing.
    const logs = await run(['logs', '--tail', String(opts.rawLines), runName]);
    if (logs.exitCode !== 0) {
      lines.push(`Could not read its output: ${logs.stderr || `exit ${logs.exitCode}`}`);
    } else {
      const raw = logs.stdout + logs.stderr;
      const printable = printableTail(raw, opts.keepLines);
      if (printable) lines.push('Its output:', printable);
      else if (raw.trim()) lines.push('It printed only terminal control sequences.');
      else lines.push('It printed nothing.');
    }

    lines.push(await this.readSupervisorLog(runName, opts.keepLines, run, opts.supervisorLogHostFile));
    return lines;
  }

  /**
   * The in-container supervisor's own log (its stdout is the terminal's), which
   * is removed with the container. Copies exactly ONE file — the fixed path
   * for this builder id — never a directory the container filled, and refuses
   * anything that is not a regular file: the container chooses what sits at
   * that path, and a symlink there must not make the daemon read a host file.
   * Never throws; says what went wrong instead.
   */
  private async readSupervisorLog(
    runName: string,
    keepLines: number,
    run: (argv: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>,
    hostFile?: string,
  ): Promise<string> {
    const builderId = /^lazy-builder-([0-9a-f]{8})$/.exec(runName)?.[1];
    if (!builderId) return 'Its supervisor log was not read (not a builder container).';
    // The persistent copy first: it is there even when the container is not
    // (a replaced machine, a removed container). Empty means the supervisor
    // never wrote to it, and the container copy below is asked instead.
    if (hostFile) {
      const persisted = await readCappedLogFile(hostFile, keepLines);
      if (persisted.kind === 'text') return `Supervisor log (kept on the project disk):\n${persisted.text}`;
      if (persisted.kind === 'refused') return `Its kept supervisor log ${persisted.reason}; not read.`;
    }
    const { mkdtemp, lstat, open, rm } = await import('fs/promises');
    const { constants } = await import('fs');
    const { tmpdir } = await import('os');
    const containerPath = builderSupervisorLogPath(builderId);
    let dest: string | null = null;
    try {
      dest = await mkdtemp(join(tmpdir(), 'lazy-exited-run-'));
      const local = join(dest, 'supervisor.log');
      const cp = await run(['cp', `${runName}:${containerPath}`, local]);
      if (cp.exitCode !== 0) {
        return /no such file|could not find/i.test(cp.stderr)
          ? `It left no supervisor log at ${containerPath} (it exited before the supervisor started).`
          : `Could not copy its supervisor log: ${cp.stderr || `exit ${cp.exitCode}`}`;
      }
      const info = await lstat(local);
      if (!info.isFile()) return `Its supervisor log at ${containerPath} is not a regular file; not read.`;
      const handle = await open(local, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const size = (await handle.stat()).size;
        const length = Math.min(size, SUPERVISOR_LOG_READ_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        const text = printableTail(buffer.toString('utf-8'), keepLines);
        return `Supervisor log (${containerPath}):\n${text || '(empty)'}`;
      } finally {
        await handle.close();
      }
    } catch (err) {
      return `Could not read its supervisor log: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (dest) {
        await rm(dest, { recursive: true, force: true }).catch((err: unknown) =>
          logger.warn(`Could not remove ${dest}: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  }

  async execInRun(
    runName: string,
    argv: string[],
    opts?: { timeoutMs?: number; interactive?: boolean },
  ): Promise<number | null> {
    // Output is inherited, not captured: the caller is passing a diagnostic
    // through to a human, and re-printing a captured buffer would reorder
    // stdout against stderr and delay every line to the end of the run.
    //
    // No `-t` by default: allocating a pty would translate newlines and inject
    // control characters into output that gets pasted into issues. Nothing lazy
    // runs this way colorizes, so there is nothing to gain for the cost.
    //
    // `interactive` opts INTO `-it` for the one case that needs a terminal:
    // `lazy shell --container`, where the human is typing at a real shell and
    // wants line editing, job control and a working `clear`.
    const execFlags = opts?.interactive ? ['-it'] : [];
    const proc = spawn([this.binary, 'exec', ...execFlags, runName, ...argv], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      // The default 60s subprocess timeout is too short for what runs in here
      // (the MCP self-test alone allows 20s, `--probe-agent` 90s), and a
      // timeout kill would look exactly like a failing check.
      //
      // An interactive session has NO deadline: the human decides when their
      // shell ends, and killing it out from under them after five minutes
      // would be the definition of surprising.
      timeout: opts?.timeoutMs ?? (opts?.interactive ? 0 : 300_000),
    });
    return await proc.exited;
  }

  openRunStream(runName: string, argv: string[]): RunStream | null {
    // `-i` (stdin, no tty): a pty would translate newlines and inject control
    // characters into a byte stream that is not text at all.
    //
    // `timeout: 0` — no deadline, deliberately. This carries one live connection
    // for `lazy forward`, and a websocket or a psql session legitimately outlives
    // any backstop we could pick. The caller kills it when its socket closes, and
    // the command kills every one of them on the way out.
    const proc = spawn([this.binary, 'exec', '-i', runName, ...argv], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 0,
    });
    return {
      write: (chunk: Uint8Array) => {
        proc.stdin.write(chunk);
      },
      end: () => {
        proc.stdin.end();
      },
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited: proc.exited,
      kill: () => proc.kill(),
    };
  }

  async getRunPortBindings(runName: string): Promise<PortBinding[] | null> {
    // `docker port <name>` prints one `3000/tcp -> 127.0.0.1:49154` line per
    // published port, and nothing at all when none are published. It is the
    // source of truth precisely because the host ports are OS-assigned.
    const proc = spawn([this.binary, 'port', runName], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 15_000,
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      // No such container (or docker is unreachable). "No bindings" and "no
      // container" are different answers, but the caller has already checked
      // the container is running before asking — so an error here is a
      // genuinely empty result, not a state worth guessing about.
      return [];
    }
    return parsePortBindings(stdout);
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

  agentPiAgentDir(worktreePath: string): string {
    // Docker/Podman bind-mount the sandbox .pi dir at /home/user/.pi (the
    // launch args in capture/claude.ts, same arrangement as .claude and
    // .cursor), so pi's agent config dir — its settings.json and the
    // sessions/ tree — lives in the sandbox, not in the image's real HOME.
    return join(worktreePath, SANDBOX_DIR, '.pi', 'agent');
  }

  supervisorToolChecks(): { cmd: string; name: string; hint: string }[] {
    // Check the task's agent when one was set; the Claude Code default keeps
    // agent-less callers (builder paths) behaving as before.
    const pkg = this._agent ? getAgentPackaging(this._agent.id) : agentPackaging;
    return pkg.supervisorToolChecks();
  }

  mcpServerConfig(
    taskId: string,
    worktreePath: string,
    opts?: { readOnly?: boolean; review?: boolean; toolset?: 'full' | 'read' | 'review' },
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
    const toolset = opts?.toolset
      ?? (opts?.review ? 'review' : opts?.readOnly ? 'read' : 'full');
    const toolsetFlag =
      toolset === 'review' ? ['--review'] :
      toolset === 'read' ? ['--read-only'] :
      [];
    return {
      command: 'lazy-agent',
      args: [
        'mcp',
        '--daemon-config', daemonConfigTemplate,
        '--task-id', taskId,
        '--worktree', worktreePath,
        // Restricted turns must be scoped HERE. Proxy handlers run the tool in
        // the daemon, which does not inherit the supervisor's
        // LAZY_MCP_READ_ONLY / LAZY_MCP_REVIEW, so the in-handler guard cannot
        // see this turn.
        ...toolsetFlag,
      ],
    };
  }

  /**
   * The agent harness version baked into the runner IMAGE — not the host's.
   *
   * WHY IT IS WORTH A LINE. `Dockerfile.lazy` installs the harness unpinned
   * (`curl … install.sh | bash`), so the version inside the image is whatever
   * was current on the day it was built, and it never changes again until
   * someone rebuilds. Every other version lazy reports is the HOST binary's,
   * which is the one no task ever runs. The gap is invisible until it bites —
   * an old harness has an older model table, and a model it does not know gets
   * a smaller context window with no error anywhere.
   *
   * NEVER BUILDS. It runs only against an image already on this machine and
   * says "not built yet" otherwise: a diagnostic that could kick off a
   * multi-minute `docker build` is one nobody would run twice.
   */
  private async diagnoseImageHarnessVersion(): Promise<HealthCheck[]> {
    const lazyRoot = this.lazyRoot;
    if (!lazyRoot) return [];

    const harness = this._agent?.id ?? 'claude-code';
    const pkg = getAgentPackaging(harness);
    if (!pkg.supportsContainerRunner()) return [];
    const what = `${pkg.binaryName()} in the runner image`;

    try {
      const image = await resolveImageName(lazyRoot, this._agentProfile);
      if (!(await localImageExists(image, this.binary))) {
        return [{
          state: 'ok',
          what: `${what}: image not built yet (${image})`,
        }];
      }
      const proc = spawn(
        [this.binary, 'run', '--rm', '--entrypoint', pkg.binaryName(), image, '--version'],
        { stdout: 'pipe', stderr: 'ignore', timeout: 20_000 },
      );
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (exitCode !== 0) {
        return [{
          state: 'fail',
          what,
          reason:
            `\`${pkg.binaryName()} --version\` failed inside ${image}. The image is present but ` +
            `its agent binary is not usable — rebuild it with \`lazy upgrade\`.`,
        }];
      }
      return [{ state: 'ok', what: `${what}: ${stdout.trim()} (${image})` }];
    } catch (err) {
      // Reported, never fatal: this is a nice-to-know line, and a docker hiccup
      // here must not turn a healthy project's doctor run red.
      return [{
        state: 'ok',
        what: `${what}: could not probe (${err instanceof Error ? err.message : String(err)})`,
      }];
    }
  }

  async diagnose(options: DiagnoseOptions = {}): Promise<HealthCheck[]> {
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
    let daemonRunning = false;
    try {
      const proc = spawn([this.binary, 'info'], {
        stdout: 'ignore', stderr: 'ignore', timeout,
      });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const name = this.binary === 'podman' ? 'Podman' : 'Docker';
        results.push({ state: 'ok', what: `${name} daemon running` });
        daemonRunning = true;
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

    // The image-harness probe needs a working daemon (`docker run` / `inspect`).
    // Asking it while the daemon is down produces a confusing "could not probe"
    // line on top of the failure already reported above.
    // It is also the one probe that starts a container, so a caller that must
    // stay cheap (`lazy daemon health`) opts out of it.
    if (daemonRunning && options.launchProbes !== false) {
      results.push(...(await this.diagnoseImageHarnessVersion()));
    }

    // Check connectivity for any role whose upstream lazy probes — see
    // probesUpstream. `pinned` alone would skip the LOCAL default (the built-in
    // pi profile's Ollama), so doctor would say nothing about a stopped server
    // that refuses every launch, which is the one place diagnosis belongs.
    for (const role of ['agent', 'builder'] as const) {
      const target = role === 'agent' ? this.agentTarget() : this.builderTarget();
      if (!probesUpstream(target)) continue;
      const check = await checkTargetConnectivity(target);
      if (check.reachable) {
        results.push({ state: 'ok', what: `[${role}] ${target.profile} reachable at ${check.endpoint}` });
      } else {
        results.push({ state: 'fail', what: `[${role}] ${target.profile} reachable`, reason: check.reason });
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
  private async probeProjectsDirWritable(hostDir: string, imageName: string, adopt = false): Promise<boolean> {
    try {
      const proc = spawn(
        builderProjectsProbeArgs({ binary: this.binary, hostDir, imageName, adopt }),
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
    // gate on this last hop too: the proxy is always on, so a builder that
    // ends up with no proxy address fails instead of connecting direct.
    const { loadConfig } = await import('../config/loader');
    const config = await loadConfig(lazyRoot);
    //
    // The builder authenticates with the DAEMON's credential, exactly like a
    // task agent and like pairing. It never falls back to the human's own
    // ~/.claude/.credentials.json — see src/builder/claude-home.ts for why that
    // store is deliberately shadowed inside the container.
    //
    // JIT CREDENTIALS: the daemon answers with a PLACEHOLDER bound to this
    // builder session, not the real token — the proxy swaps the real one in
    // upstream. The label is `builder-<id>`, the same identity the session's
    // daemon MCP token is minted under (see src/cli/commands/builder.ts), so the
    // revoke on the way out clears both.
    const builderId = basename(builderConfigPath, '.json').replace('builder-', '');
    // The grant's profile is what the proxy ROUTES by, so it must be the profile
    // this launch actually resolved — not the built-in name. A builder pinned
    // with `[models.roles.builder] agent = "..."` would otherwise be preflighted
    // against its own endpoint and then have its traffic sent to the primary
    // upstream on the primary credential.
    const builderTarget = this.builderTarget();
    const authEnvVars = await resolveAuthEnvFromDaemon(
      builderTarget,
      { role: 'builder' },
      'container',
      config,
      { role: 'builder', taskId: null, label: `builder-${builderId}`, profile: builderTarget.profile },
    );

    // Read the builder config to get port for the container config
    const builderConfig = JSON.parse(readFileSync(builderConfigPath, 'utf-8'));

    // Get the data directory path for mounting
    const dataDir = join(lazyRoot, config.data.path);

    // Write system prompt to a temp file in the data dir (accessible inside container)
    const tmpDir = join(dataDir, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const promptFile = join(tmpDir, `builder-prompt-${Date.now()}.txt`);
    writeFileSync(promptFile, systemPrompt);


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
    const mcpWrapperPath = await writeMcpLaunchWrapper({ tmpDir, builderId });
    tempFilesToClean.push(mcpWrapperPath);
    await writeBuilderSessionClaudeConfig({
      sessionPath: mergedConfigFile,
      persistedPath: persistedConfigFile,
      hostConfigPath: join(getHome(), '.claude.json'),
      mcpArgs,
      mcpCommand: mcpWrapperPath,
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
      mcpWrapperPath,
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

  /**
   * One non-interactive builder turn for the UI review-session path: same
   * container mounts/MCP/credential posture as {@link launchBuilderInteractive},
   * but runs `claude -p` directly and returns the parsed answer.
   */
  async launchBuilderHeadless(params: LaunchBuilderHeadlessParams): Promise<LaunchBuilderHeadlessResult> {
    const {
      lazyRoot, systemPrompt, prompt, resumeSessionId, builderId, daemonConfigPath,
      projects, authEnvVars, debug,
    } = params;

    await preflightRoleTarget('builder', this.builderTarget());

    const [imageName, agentBinaryPath] = await Promise.all([
      ensureImage(this.binary),
      ensureAgentBinary(),
    ]);

    const { loadConfig } = await import('../config/loader');
    const config = await loadConfig(lazyRoot);
    const dataDir = join(lazyRoot, config.data.path);

    const { generateBuilderConfig } = await import('../builder/server');
    const { configPath: builderConfigPath, config: builderConfig } =
      generateBuilderConfig(lazyRoot, config.data.path);
    writeFileSync(builderConfigPath, JSON.stringify(builderConfig, null, 2));

    const tmpDir = join(dataDir, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const containerConfigFile = join(tmpDir, `builder-container-${builderId}.json`);
    writeFileSync(containerConfigFile, JSON.stringify({ ...builderConfig, host: 'host.docker.internal' }, null, 2));

    const useDaemonProxy = !!daemonConfigPath;
    const mcpArgs = useDaemonProxy
      ? ['mcp', '--daemon-config', daemonConfigPath!, '--worktree', lazyRoot]
      : ['mcp', '--builder-config', containerConfigFile, '--worktree', lazyRoot];

    const persistedConfigFile = builderClaudeConfigPath(dataDir);
    const mergedConfigFile = builderClaudeSessionConfigPath(tmpDir, builderId);
    const mcpWrapperPath = await writeMcpLaunchWrapper({ tmpDir, builderId });
    await writeBuilderSessionClaudeConfig({
      sessionPath: mergedConfigFile,
      persistedPath: persistedConfigFile,
      hostConfigPath: join(getHome(), '.claude.json'),
      mcpArgs,
      mcpCommand: mcpWrapperPath,
      onWarn: (message) => logger.warn(message),
    });

    const neutralCredentialStore = await writeNeutralCredentialStore(tmpDir, builderId);
    await writeToolPermissions(BUILDER_READ_ONLY_TOOLS);

    let useProjectsMount = false;
    if (projects) {
      const probeWritable = projects.trustWritable
        ? true
        : await this.probeProjectsDirWritable(projects.hostDir, imageName);
      useProjectsMount = shouldMountProjectsDir({ trustWritable: projects.trustWritable, probeWritable });
    }

    const scratchDir = await ensureBuilderScratchDir(lazyRoot);
    const claudeArgs = buildBuilderHeadlessClaudeArgs(systemPrompt, prompt, resumeSessionId, builderHeadlessModel(config, this.builderTarget()));
    const launchedAtMs = Date.now();

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
      mcpWrapperPath,
      authEnvVars,
      imageName,
      promptFile: join(tmpDir, `builder-headless-${builderId}.txt`),
      daemonConfigPath: useDaemonProxy ? daemonConfigPath : undefined,
      claudeExtraArgs: [],
      debug: debug ?? false,
      headlessClaudeArgs: claudeArgs,
    });

    if (useDaemonProxy) {
      await assertDaemonMcpConfigMounted(daemonConfigPath!, mergedConfigFile);
    }

    if (debug) {
      console.log('[DEBUG] Running headless builder:', redactSecrets(dockerArgs).join(' '));
    }

    const proc = spawn(dockerArgs, { stdout: 'pipe', stderr: 'pipe', timeout: 0 });
    const timeoutMs = DEFAULT_ONESHOT_TIMEOUT_MS;
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try { proc.kill('SIGTERM'); } catch { /* already exited */ }
          setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch { /* already exited */ }
          }, ONESHOT_KILL_GRACE_MS);
        }, timeoutMs)
      : null;

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timer) clearTimeout(timer);

    if (timedOut) {
      await removeContainer(`lazy-builder-${builderId}`, this.binary);
      throw new Error(
        `Builder review-session turn timed out after ${timeoutMs}ms and was killed.`,
      );
    }

    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim();
      throw new Error(
        detail
          ? `Headless builder turn failed (exit ${exitCode}): ${detail.slice(0, 500)}`
          : `Headless builder turn failed with exit code ${exitCode}`,
      );
    }

    const parsed = parseBuilderHeadlessStdout(stdout);
    const sessionId = parsed.sessionId ?? await detectBuilderLaunchSessionId({
      lazyRoot,
      projectsHostDir: useProjectsMount ? projects!.hostDir : undefined,
      launchedAtMs,
      resumeId: resumeSessionId ?? null,
    });

    const tempFiles = [
      builderConfigPath, containerConfigFile, mergedConfigFile, neutralCredentialStore,
      mcpWrapperPath,
    ];
    for (const tmpFile of tempFiles) {
      try { unlinkSync(tmpFile); } catch { /* best effort */ }
    }

    return { answer: parsed.answer, sessionId, exitCode };
  }

  /**
   * Start a daemon-owned, detached interactive builder session and return as
   * soon as `docker run -d` reports the container up — never blocks for the
   * session's lifetime, unlike {@link launchBuilderInteractive}.
   *
   * Mirrors that function's mount/config assembly (neutral credential store,
   * per-launch `~/.claude.json`, projects isolation) but launches the
   * INTERACTIVE supervisor detached rather than `-it --rm` in this process's
   * foreground, and mounts `homeDirAbs` in place of the host user's home — a
   * per member+project Claude home (see the caller,
   * src/daemon/builder-sessions.ts, and
   * docs/design/actor-identity-and-remote-clients.md §5.5).
   */
  async launchBuilderDetached(params: LaunchBuilderDetachedParams): Promise<LaunchBuilderDetachedResult> {
    const { lazyRoot, systemPrompt, builderId, daemonConfigPath, projects, authEnvVars, homeDirAbs, debug } = params;
    let resumeSessionId = params.resumeSessionId;
    const trace = params.trace;
    const phase = <T>(name: string, work: () => Promise<T>): Promise<T> => (trace ? trace.phase(name, work) : work());

    await phase('builder target preflight', () => preflightRoleTarget('builder', this.builderTarget()));

    // Image resolution is the one phase that can take minutes (a missing or
    // too-old image is BUILT here, or waits behind another launch's build), so
    // its narration goes into the trail too, not only its duration.
    const [imageName, agentBinaryPath] = await Promise.all([
      phase('container image', () => ensureImage(this.binary, trace ? {
        // Build output and heartbeats are already logged by the build itself;
        // only the decisions (up to date, rebuilding because…, waiting) go here.
        notify: (d) => { if (!/^(building \S+: |still building )/.test(d)) trace.note(`image: ${d}`); },
      } : undefined)),
      phase('agent binary', () => ensureAgentBinary()),
    ]);

    const { loadConfig } = await import('../config/loader');
    const config = await loadConfig(lazyRoot);
    const dataDir = join(lazyRoot, config.data.path);

    // This method runs in the DAEMON's event loop, not a short-lived CLI
    // process (unlike launchBuilderInteractive below) — a sync fs call here
    // stalls the reconciler, every HTTP handler, and every other project's
    // RPCs for as long as it takes (CLAUDE.md: sync fs is only for CLI
    // startup, exit handlers, and test setup). fs/promises throughout.
    // Per-launch files go in a directory under the MEMBER's home, never
    // <dataDir>/tmp: every builder container mounts the data dir read-write,
    // so files there (this session's live ~/.claude.json, its credential store,
    // its container config) were readable and writable by every other member's
    // container. Each file below is bind-mounted individually; the directory
    // itself is mounted nowhere. See builderSessionLaunchDir.
    const tmpDir = builderSessionLaunchDir(homeDirAbs, builderId);
    await mkdirAsync(tmpDir, { recursive: true });
    await mkdirAsync(join(homeDirAbs, '.claude'), { recursive: true });

    const promptFile = join(tmpDir, `builder-prompt-${builderId}.txt`);
    await writeFileAsync(promptFile, systemPrompt);

    const { generateBuilderConfig } = await import('../builder/server');
    const { configPath: builderConfigPath, config: builderConfig } =
      generateBuilderConfig(lazyRoot, config.data.path);
    await writeFileAsync(builderConfigPath, JSON.stringify(builderConfig, null, 2));

    const containerConfigFile = join(tmpDir, `builder-container-${builderId}.json`);
    await writeFileAsync(containerConfigFile, JSON.stringify({ ...builderConfig, host: 'host.docker.internal' }, null, 2));

    const useDaemonProxy = !!daemonConfigPath;
    // Every path the container is handed is its FIXED container path, never
    // the host path: see BUILDER_CONTAINER_DIR.
    const inContainer = BUILDER_CONTAINER_PATHS;
    const mcpArgs = useDaemonProxy
      ? ['mcp', '--daemon-config', inContainer.daemonConfig, '--worktree', lazyRoot]
      : ['mcp', '--builder-config', inContainer.containerConfig, '--worktree', lazyRoot];

    // Per-member+project state: seed/write-back file lives under this
    // session's own home rather than the shared project-level one, so two
    // members' onboarding/model choices never overwrite each other.
    const persistedConfigFile = builderClaudeConfigPath(homeDirAbs);
    const mergedConfigFile = builderClaudeSessionConfigPath(tmpDir, builderId);
    const mcpWrapperPath = await writeMcpLaunchWrapper({ tmpDir, builderId });
    await writeBuilderSessionClaudeConfig({
      sessionPath: mergedConfigFile,
      persistedPath: persistedConfigFile,
      // NEVER the daemon host user's ~/.claude.json. This process runs as the
      // daemon's user, whose home is nobody's (design §5.5): seeding from it
      // gave every member the operator's oauthAccount, userID, project history
      // and MCP server entries with their env secrets — on every launch, since
      // the per-member file was never written back. A member's session seeds
      // from their own persisted state, or from nothing on first launch.
      hostConfigPath: null,
      mcpArgs,
      mcpCommand: inContainer.mcpWrapper,
      // ...which on first launch is `{}`: a brand-new install to Claude Code,
      // opening its theme picker/trust/key prompts. Fill those answers (never
      // identity), trusting the directory the container runs in (`-w lazyRoot`).
      firstRun: {
        trustPaths: [lazyRoot],
        apiKey: authEnvVars.find(v => v.key === 'ANTHROPIC_API_KEY')?.value,
      },
      onWarn: (message) => logger.warn(message),
    });

    const neutralCredentialStore = await writeNeutralCredentialStore(tmpDir, builderId);
    // Every file in the launch dir is bind-mounted into a container whose user
    // is not necessarily the daemon's uid (a root daemon on native Linux).
    await setBuilderLaunchModes(tmpDir, {
      files: [promptFile, containerConfigFile, mergedConfigFile, neutralCredentialStore],
      executables: [mcpWrapperPath],
    });
    // The in-container supervisor's log, on the member's launch dir (the
    // project's persistent disk) rather than the container's /tmp: it survives
    // the container's exit AND the machine being replaced, so a builder that
    // dies at minute five leaves the same evidence as one that dies at once.
    // World-writable because the container user need not be the daemon's uid;
    // the launch dir itself is 0700.
    const supervisorLogFile = builderSupervisorLogHostPath(tmpDir, builderId);
    await writeFileAsync(supervisorLogFile, '');
    await chmodAsync(supervisorLogFile, 0o666);
    // This container mounts homeDirAbs/.claude, not the daemon host user's
    // ~/.claude — so the permissions must be written THERE (and only there): a
    // default-target write would both leave the session without its lazy tool
    // permissions and silently rewrite the host operator's real settings.
    await writeToolPermissions(BUILDER_READ_ONLY_TOOLS, homeDirAbs);

    let useProjectsMount = false;
    if (projects) {
      const probeWritable = projects.trustWritable
        ? true
        // adopt: this dir is under the member's own lazy-owned home, and the
        // container's entry adopts it too — probe what the builder will see.
        : await phase('projects dir write probe', () => this.probeProjectsDirWritable(projects.hostDir, imageName, true));
      useProjectsMount = shouldMountProjectsDir({ trustWritable: projects.trustWritable, probeWritable });
    }

    // Decided HERE, once the mount is known: a failed write probe drops the
    // overlay, and then the container sees the member home's projects dir.
    // `claude --resume <id>` exits at once ("No conversation found") when
    // <id>.jsonl is not in the dir it sees, so such a launch would be dead in
    // seconds — start a fresh conversation instead and say which was used.
    if (resumeSessionId) {
      const seen = useProjectsMount && projects ? projects.hostDir : join(homeDirAbs, '.claude', 'projects');
      if (!(await projectsDirHoldsSession(seen, lazyRoot, resumeSessionId))) {
        logger.warn(
          `Builder ${builderId}: conversation ${resumeSessionId} is not in the projects dir the container will see ` +
          `(${seen}), so it cannot be resumed; starting a fresh conversation instead.`,
        );
        resumeSessionId = null;
      }
    }
    if (projects) {
      trace?.note(`projects dir ${useProjectsMount ? 'mounted' : 'NOT mounted (write probe failed)'}; ` +
        (resumeSessionId ? `resuming conversation ${resumeSessionId}` : 'fresh conversation'));
    }

    const scratchDir = await ensureBuilderScratchDir(lazyRoot);
    // The detached (Teams) builder composes its own argv, apart from `lazy builder`:
    // it too runs the builder default unless the role's profile names a model.
    const { resolveBuilderModel } = await import('../agent/agent-model');
    const builderTarget = this.builderTarget();
    const builderModel = resolveBuilderModel(config, { harness: builderTarget.harness, model: builderTarget.model });
    const claudeExtraArgs = [
      ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
      '--model', builderModel,
    ];

    const dockerArgs = buildBuilderDockerArgs({
      binary: this.binary,
      builderId,
      lazyRoot,
      scratchDir,
      dataDir,
      containerConfigFile,
      agentBinaryPath,
      home: homeDirAbs,
      projectsHostDir: useProjectsMount ? projects!.hostDir : undefined,
      neutralCredentialStore,
      supervisorLogFile,
      mergedConfigFile,
      mcpWrapperPath,
      authEnvVars,
      imageName,
      promptFile,
      daemonConfigPath: useDaemonProxy ? daemonConfigPath : undefined,
      claudeExtraArgs,
      debug: debug ?? false,
      detached: true,
    });

    if (useDaemonProxy) {
      await assertDaemonMcpConfigMounted(daemonConfigPath!, mergedConfigFile, inContainer.daemonConfig);
    }

    if (debug) {
      console.log('[DEBUG] Launching detached builder session:', redactSecrets(dockerArgs).join(' '));
    }

    // `docker run -d` prints the container id and exits immediately — the
    // container's own lifetime is what continues, not this process's.
    await phase(`${this.binary} run`, async () => {
      const proc = spawn(dockerArgs, { stdout: 'pipe', stderr: 'pipe', timeout: DOCKER_TIMEOUT_MS });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim();
        throw new Error(
          detail
            ? `Failed to start detached builder session (exit ${exitCode}): ${detail.slice(0, 500)}`
            : `Failed to start detached builder session (exit code ${exitCode})`,
        );
      }
    });

    return { containerName: `lazy-builder-${builderId}`, resumed: resumeSessionId ?? null };
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
  /**
   * Detached builders only: a daemon-created host file mounted read-write at
   * the supervisor's log path, so the log outlives the container.
   */
  supervisorLogFile?: string;
  mergedConfigFile: string;
  /** Selfcheck wrapper script for lazy MCP reconnect spawns. */
  mcpWrapperPath?: string;
  authEnvVars: Array<{ key: string; value: string }>;
  imageName: string;
  promptFile: string;
  /** Path to this builder's daemon MCP config, when running in daemon proxy mode. */
  daemonConfigPath?: string;
  claudeExtraArgs: string[];
  debug: boolean;
  /**
   * When set, run these `claude` argv tokens directly instead of the interactive
   * builder supervisor. Omits `-it` — headless review-session turns only.
   */
  headlessClaudeArgs?: string[];
  /**
   * Launch DAEMON-OWNED and DETACHED (`-d`, no `--rm`, no `-it`) rather than
   * `-it --rm` in the caller's foreground. The container's lifetime is then the
   * session's, not the launching process's — see
   * docs/design/actor-identity-and-remote-clients.md §5.2. Mutually exclusive
   * with `headlessClaudeArgs` (a detached session runs the interactive
   * supervisor, never a one-shot `claude -p`).
   */
  detached?: boolean;
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
    home, projectsHostDir, neutralCredentialStore, supervisorLogFile, mergedConfigFile, authEnvVars,
    mcpWrapperPath,
    imageName, promptFile, daemonConfigPath, claudeExtraArgs, debug, headlessClaudeArgs,
    detached,
  } = params;

  const interactive = !headlessClaudeArgs?.length;

  // Where each launch file appears INSIDE the container. A detached (Teams)
  // builder gets fixed paths under BUILDER_CONTAINER_DIR; the interactive and
  // headless `lazy builder` launches keep identity mounts (host path ==
  // container path) — their files live under the operator's own home.
  const at = detached
    ? {
        scratchDir: BUILDER_CONTAINER_PATHS.scratchDir,
        containerConfigFile: BUILDER_CONTAINER_PATHS.containerConfig,
        promptFile: BUILDER_CONTAINER_PATHS.prompt,
        mcpWrapperPath: BUILDER_CONTAINER_PATHS.mcpWrapper,
        daemonConfigPath: BUILDER_CONTAINER_PATHS.daemonConfig,
      }
    : { scratchDir, containerConfigFile, promptFile, mcpWrapperPath, daemonConfigPath };

  const dockerArgs = [
    binary, 'run', '--init',
    // A detached session still runs the INTERACTIVE supervisor, which spawns
    // Claude Code with stdin inherited, expecting a pty — `-d` alone with no
    // `-i`/`-t` gives it neither, so the TUI hits EOF immediately and the
    // container exits within seconds. `-i -t` is also what a later `docker
    // attach` requires to have anything to attach to.
    ...(detached ? ['-d', '-i', '-t'] : [...(interactive ? ['-it'] : []), '--rm']),
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
    // (A detached builder mounts it at a fixed container path instead — see
    // BUILDER_CONTAINER_DIR; its human reads scratch through `lazy scratch`.)
    '-v', `${scratchDir}:${at.scratchDir}`,
    '-e', `${SCRATCH_ENV_VAR}=${at.scratchDir}`,
    // Container-specific builder config (has host.docker.internal)
    '-v', `${containerConfigFile}:${at.containerConfigFile}:ro`,
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
    // MCP selfcheck wrapper — Claude Code respawns this on reconnect; must
    // verify the bind-mounted lazy-agent after every upgrade before exec.
    ...(mcpWrapperPath ? ['-v', `${mcpWrapperPath}:${at.mcpWrapperPath}:ro`] : []),
    // A detached session's prompt file lives in the member's own launch dir,
    // outside the data-dir mount it used to ride in on, so it needs a mount of
    // its own (read-only, at the path the supervisor is told to read).
    ...(detached ? ['-v', `${promptFile}:${at.promptFile}:ro`] : []),
    ...(detached && supervisorLogFile ? ['-v', `${supervisorLogFile}:${builderSupervisorLogPath(builderId)}`] : []),
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
    dockerArgs.push('-v', `${daemonConfigPath}:${at.daemonConfigPath}:ro`);
  }

  if (headlessClaudeArgs?.length) {
    dockerArgs.push(imageName, ...headlessClaudeArgs);
  } else {
    dockerArgs.push(
      imageName,
      // Run the builder supervisor (not Claude directly)
      'lazy-agent', 'builder',
      '--system-prompt-file', at.promptFile,
      '--worktree', lazyRoot,
      // Use container config (host.docker.internal) not the host config (127.0.0.1)
      '--builder-config', at.containerConfigFile,
      // Stable builder id so the supervisor can stamp the detected Claude
      // sessionId onto this builder's resume intent on exit (host gets
      // sessionId: null from the runner — only the supervisor knows the id).
      '--builder-id', builderId,
    );

    // Pass daemon config to builder supervisor if available
    if (daemonConfigPath) {
      dockerArgs.push('--daemon-config', at.daemonConfigPath!);
    }

    // Pass through extra Claude args after --
    if (claudeExtraArgs.length > 0) {
      dockerArgs.push('--', ...claudeExtraArgs);
    }
  }

  // The writable mounts under the container user's home are created by the
  // daemon — root-owned for a root-run daemon on native Linux (the smolvm
  // guest, a Linux server). Take ownership inside the container before the
  // builder starts, as a task container's wrapper does
  // (buildSupervisorWrapperScript, src/capture/claude.ts). Only these: they
  // belong to this member alone; the data dir and repo are never adopted.
  // DETACHED ONLY: there `home` is the lazy-owned per-member home under
  // ~/.lazy/builder-homes/. The interactive and headless launches mount the
  // operator's REAL ~/.claude, and a chown there would re-own the operator's
  // own Claude config on the host.
  if (detached) {
    const adoptPaths = [
      '/home/user/.claude',
      '/home/user/.claude.json',
      ...(projectsHostDir ? ['/home/user/.claude/projects'] : []),
    ];
    dockerArgs.splice(dockerArgs.indexOf(imageName) + 1, 0,
      'sh', '-c', builderAdoptScript(adoptPaths), 'lazy-builder-entry');
  }

  if (debug) {
    dockerArgs.splice(dockerArgs.indexOf(imageName), 0, '-e', 'DEBUG=1');
  }

  return dockerArgs;
}

/**
 * Argv for the projects-dir write probe. With `adopt` (the detached,
 * per-member launch only) the probe first takes ownership exactly as the
 * builder's own entry will: a root daemon creates the dir root-owned, and a
 * bare `touch` as the container user then failed on every Teams launch,
 * silently dropping per-builder projects isolation. Never `adopt` for a dir in
 * the operator's own home (the interactive `lazy builder` path).
 */
export function builderProjectsProbeArgs(opts: {
  binary: string; hostDir: string; imageName: string; adopt: boolean;
}): string[] {
  const mount = '/home/user/.claude/projects';
  const probeTarget = `${mount}/.lazy-write-probe`;
  const touch = ['sh', '-c', `touch ${probeTarget} && rm -f ${probeTarget}`];
  return [
    opts.binary, 'run', '--rm', '--init',
    '-v', `${opts.hostDir}:${mount}`,
    opts.imageName,
    ...(opts.adopt ? ['sh', '-c', builderAdoptScript([mount]), 'lazy-builder-probe'] : []),
    ...touch,
  ];
}

/**
 * Fixed container-side home of a DETACHED (Teams) builder's launch files.
 *
 * These files are written under the daemon's HOME, which for a root-run daemon
 * (the smolvm guest) is /root — and the runner image ships /root 0700 root, so
 * identity-mounting them (host path == container path) left the container
 * user (uid 1000) unable to traverse to its own prompt file: EACCES, exit 1.
 * Reopening /root with a 0755 tmpfs does NOT work: when a tmpfs destination
 * already exists in the rootfs, runc gives the tmpfs the IMAGE dir's mode
 * (v1.0.x `mountToRootfs` chmods it back after mounting; v1.1+ prepends
 * `mode=<image mode>` to the tmpfs data) — reproduced in the guest as a
 * `drwx------ /root` tmpfs.
 *
 * So, like a task container's protocol dir (containerProtocolDir,
 * src/capture/claude.ts), every file lands at a path the image does not have,
 * whose missing parents the runtime creates 0755. Every path baked into the
 * argv and the merged ~/.claude.json is one of these. One builder per
 * container, so no per-builder component is needed.
 *
 * The scratch dir moves here too: "identical host path so the human reads it
 * as printed" does not hold for a Teams builder, whose host is a VM nobody
 * reads from — scratch is read through `lazy scratch` / the store capture, and
 * LAZY_SCRATCH_DIR tells the builder where it is. Scratch is never adopted
 * (chowned): it is per PROJECT, shared with other members and the operator,
 * and ensureBuilderScratchDir already creates it 0777.
 */
export const BUILDER_CONTAINER_DIR = '/lazy-builder';

export const BUILDER_CONTAINER_PATHS = {
  prompt: `${BUILDER_CONTAINER_DIR}/builder-prompt.txt`,
  containerConfig: `${BUILDER_CONTAINER_DIR}/builder-container.json`,
  mcpWrapper: `${BUILDER_CONTAINER_DIR}/lazy-mcp-wrapper.sh`,
  daemonConfig: `${BUILDER_CONTAINER_DIR}/daemon-mcp.json`,
  scratchDir: `${BUILDER_CONTAINER_DIR}/scratch`,
} as const;

/**
 * `sh -c` entry that takes ownership of the given mounted paths when the
 * container user cannot write them, then execs the real command ("$@").
 * Never fatal: a path it cannot adopt is reported and the builder still starts.
 * One line, deliberately: it is a single argv token, and tooling that logs a
 * container's argv line by line (and the fake docker in the e2e suites) must
 * not see it split.
 */
export function builderAdoptScript(paths: string[]): string {
  const quoted = paths.map((p) => `"${p}"`).join(' ');
  return [
    `for p in ${quoted}; do`,
    '[ -e "$p" ] || continue;',
    'find "$p" ! -writable -print -quit 2>/dev/null | grep -q . || continue;',
    'if command -v sudo >/dev/null 2>&1; then',
    'sudo -n chown -R "$(id -u):$(id -g)" "$p" || echo "lazy: could not take ownership of $p (a root-run daemon on Linux needs this to be writable)" >&2;',
    'else',
    'echo "lazy: $p is not writable by $(id -un) and sudo is unavailable — writes there will fail" >&2;',
    'fi;',
    'done;',
    'exec "$@"',
  ].join(' ');
}

/**
 * Explicit modes for a builder launch dir and the files the container reads
 * from it through individual bind mounts. A write honours the process umask,
 * so the modes a container saw depended on how the daemon was started; and the
 * container user is uid 1000 whatever uid the daemon runs as.
 *
 * - Files 0644, scripts 0755: readable by the container user, writable only by
 *   their owner. (The two the container must WRITE — its `~/.claude.json` and
 *   credential store — are taken over inside the container by the builder's
 *   entry script, never widened here.)
 * - The dir 0700: a bind mount's source is resolved by the container engine,
 *   not by the container user, so the dir needs no bits for anyone else — and
 *   keeping it closed keeps the tokens in these files away from other host users.
 */
export async function setBuilderLaunchModes(
  launchDir: string,
  opts: { files: string[]; executables: string[] },
): Promise<void> {
  await chmodAsync(launchDir, 0o700);
  await Promise.all([
    ...opts.files.map((f) => chmodAsync(f, 0o644)),
    ...opts.executables.map((f) => chmodAsync(f, 0o755)),
  ]);
}

/**
 * Read the tail of a log file the CONTAINER could write to, without trusting
 * it: refuses anything that is not a regular file and opens with O_NOFOLLOW, so
 * a planted symlink never makes the daemon read a host file. Capped at
 * SUPERVISOR_LOG_READ_BYTES. `empty` for a missing or zero-length file.
 */
export async function readCappedLogFile(
  path: string,
  keepLines: number,
): Promise<{ kind: 'text'; text: string } | { kind: 'empty' } | { kind: 'refused'; reason: string }> {
  const { lstat, open } = await import('fs/promises');
  const { constants } = await import('fs');
  let info;
  try {
    info = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'empty' };
    return { kind: 'refused', reason: `could not be inspected (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!info.isFile()) return { kind: 'refused', reason: 'is not a regular file' };
  if (info.size === 0) return { kind: 'empty' };
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    return { kind: 'refused', reason: `could not be opened (${err instanceof Error ? err.message : String(err)})` };
  }
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, SUPERVISOR_LOG_READ_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return { kind: 'text', text: printableTail(buffer.toString('utf-8'), keepLines) || '(only terminal control sequences)' };
  } finally {
    await handle.close();
  }
}
