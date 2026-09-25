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

import { requireLaunchModel } from '../agent/launch-model';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { realpath } from 'fs/promises';
import { join } from 'path';
import { getHome } from '../utils/home';
import type { SandboxConfig } from '../capture/claude';
import { spawn } from '../utils/spawn';
import type { AgentResponse } from '../types';
import type { Runner, RunInfo, FollowHandle, HealthCheck, RunStream } from './types';
import type { PhaseNotify } from '../daemon/progress';
import type { PortBinding } from '../serve/ports';
import type { RoleTarget, SandboxBoundaryVerification } from '../config/types';
import {
  profileNameForAgent,
  profileForAgentNameOrNull,
} from '../config/agent-profiles';
import type { BuilderLaunchProjects } from '../builder/projects-isolation';
import { ensureBuilderScratchDir, SCRATCH_ENV_VAR } from '../builder/scratch';
import { getAuthEnvVars as getDefaultAuthEnvVars, getLaunchAuthEnvVars } from '../capture/claude';
import { findLazyRoot } from '../project-paths';
import { getTaskEnv } from '../daemon/task-env';
import { sessionCredentialEnvFor } from '../daemon/turn-credentials';
import { mintCredentialGrant } from '../proxy/credential-broker';
import type { LaunchIdentity } from '../proxy/placeholder-env';
import { ClaudeCodePackaging } from '../agent/claude-code-packaging';
import { getAgentPackaging } from '../agent/registry';
import { agentSupportsApiKey, resolveAgentApiKey, AGENT_KEY_ENV } from '../agent/credentials';
import { encodeProjectPath } from '../import/claude-code-logs';
import {
  readProcessIdentity,
  processGroupId,
  processesInGroup,
  processCwd,
  isRunningProcess,
} from '../utils/process-identity';
import { logger } from '../utils/logger';
import { redactSecrets } from '../utils/redact';
import {
  checkTargetConnectivity,
  probesUpstream,
  preflightRoleTarget,
  ANTHROPIC_DEFAULT_TARGET,
  type ProxyAuditHints,
} from '../utils/role-target';
import { cursorLaunchEnvVars } from '../proxy/cursor-route';
import { piLaunchEnvVars, piCredentialMirror } from '../agent/pi-turn-config';
import { DEFAULT_UPSTREAM_TIMEOUT_SECONDS } from '../proxy/upstream-defaults';
import { codexLaunchEnvVars } from '../proxy/codex-route';
import { hasDaemonContext, getDaemonContext } from '../daemon/context';
import { loadConfig } from '../config/loader';
import { getLazyCommand } from '../utils/cli-path';
import type { Agent } from '../agent/interface';
import { safeArgvPrompt } from '../agent/argv-safety';
import { snapshotSessionFiles, captureConversation } from '../import/capture-session';
import { buildAgentSandboxArgs, type HostPermissionConfig } from './host-sandbox';
import type { OneshotRequest } from '../oneshot/types';
import type { LaunchBuilderHeadlessParams, LaunchBuilderHeadlessResult } from './types';
import { DEFAULT_ONESHOT_TIMEOUT_MS, ONESHOT_KILL_GRACE_MS } from '../oneshot/args';
import { buildBuilderHeadlessClaudeArgs, builderHeadlessModel, parseBuilderHeadlessStdout } from './builder-headless';
import { buildBuilderPermissionArgs } from './host-sandbox';
import { ensureHostBoundaryVerified, diagnoseBoundaryVerdict } from './host-boundary-guard';

import hostProcessBuilderInstructions from '../prompts/host-process-builder-runner-instructions.md' with { type: 'text' };

// Agent packaging for availability checks and tool checks.
const agentPackaging = new ClaudeCodePackaging();

/** Directory inside worktrees where we store PID files and logs. */
const RUN_STATE_DIR = '.lazy-run';

/**
 * How long a stopped run gets between SIGTERM and SIGKILL when the caller names
 * no window of its own. See {@link HostProcessRunner.stopRun}.
 */
const DEFAULT_STOP_GRACE_MS = 5_000;

interface PidFileData {
  pid: number;
  startedAt: string;
  logFile: string;
  /** Project root path — used to scope discovery to the current project. */
  projectRoot?: string;
  /**
   * Worktree the supervisor was launched against (`lazy supervise --worktree`).
   *
   * This is what makes a record falsifiable. Run names are `lazy-<task ref>`,
   * and a ref is the task's CODE for every task a human creates — so the name
   * alone identifies nothing: two projects can each have a `fix-login`, and a
   * pid outlives the process it was assigned to. Recording the worktree lets a
   * reader ask the OS whether the process behind this record is still the
   * supervisor the record describes. Absent on records written before this
   * field existed, which are believed as-is.
   */
  worktree?: string;
  /**
   * Process group the supervisor leads, read back from the OS at launch.
   *
   * The launch spawns with `detached: true`, so the supervisor calls `setsid()`
   * and should be its own group leader — but this field records what the OS
   * actually reported rather than restating that expectation, and every reader
   * re-checks `pgid === pid` before trusting it. A recorded value that is not
   * equal to the pid is therefore inert, not dangerous.
   *
   * It is recorded at all because the group is UNREADABLE once the supervisor
   * dies, and a supervisor dying while its agent lives is the orphan this whole
   * mechanism exists to reach. Absent on records written before this field, and
   * on any launch where the group could not be read — both fall back to
   * signalling the pid alone. See {@link resolveStopTarget}.
   */
  pgid?: number;
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

/**
 * Reading another process is NOT this module’s job — procfs-vs-`ps`, the
 * parse-after-the-last-`)` rule, zombie states and process groups all live in
 * src/utils/process-identity.ts, which owns that split for the storage lock and
 * documents why each half is shaped the way it is. This file had its own copies
 * of two of them; they are imported now so a fix to the parsing reaches every
 * caller instead of the one somebody happened to be looking at.
 */
async function processCommandLine(pid: number): Promise<string | null> {
  const identity = await readProcessIdentity(pid);
  return identity?.command ?? null;
}

/**
 * What a stop signals: the supervisor's whole process group, or its pid alone.
 *
 * Stopping a run has to stop the AGENT the supervisor spawned, not just the
 * supervisor — otherwise the agent is reparented to init and keeps running,
 * holding the worktree and the agent bundle it launched with. Under Docker that
 * is free (a run IS the container), which is why the leak only exists here.
 *
 * Signalling a process GROUP is how a POSIX process reaches a whole tree, but
 * a group id is only safe to signal if we know what is in it. Supervisors used
 * to inherit the DAEMON's group, so `kill(-pgid)` on one of them would have
 * killed the daemon and every other supervisor with it. The launch therefore
 * puts each supervisor in a group of its own (`detached: true` → `setsid()`),
 * and the only thing signalled as a group is a pid that is its OWN group
 * leader — which is proof of ownership rather than a guess: a process can only
 * join a group led by another process in its session, and a session leader's
 * session contains nothing but its own descendants. So `pgid === pid` means
 * every member is this supervisor or something it started.
 *
 * A DEAD supervisor is the case this cannot read live, and the one that matters
 * most: its agent is exactly the orphan being hunted, but `pgid` comes off the
 * supervisor's own `/proc` entry, which is gone. So the group is RECORDED in the
 * run file at launch and used when the live read cannot answer.
 *
 * A RECORDED group is VERIFIED before it is signalled, never argued for. The
 * rule this file already states for the supervisor pid — "verified, not merely
 * read: signalling a pid that is no longer our supervisor would kill whatever
 * inherited it" — applies with more force to a group, because the blast radius
 * is every process in it. A pgid IS a pid, pids are recycled, and "the group is
 * non-empty so it must still be ours" is a plausibility argument, not a proof:
 * it holds only if the number was never reused, which is exactly what cannot be
 * assumed. This project has already lost an afternoon to a recycled pid making a
 * dead storage-lock holder look alive forever.
 *
 * So `verifyGroupOwnership` requires a MEMBER of the group to be working in the
 * worktree this run recorded. The supervisor and every process under it are
 * launched with the worktree as their cwd, and that path names one task under
 * one project root. It is an exact path comparison, never a substring — the same
 * correction `src/demo/reap.ts` needed when its first version matched any
 * command line merely CONTAINING the demo root.
 *
 * What that buys, stated exactly rather than as "safe": a wrong kill now needs
 * the recycled pgid's group to ALSO contain a process whose cwd is this task's
 * own worktree — that is, another lazy process for this very task, not merely
 * some unrelated process that inherited the number. It is a much smaller target
 * than "any group that still has members", which is what this replaced, but it
 * is not a proof that no such process can exist, and it is not claimed as one.
 *
 * Unverifiable is treated as unowned, in both directions that matters:
 *   - cwd is readable from procfs and nowhere else lazy is willing to depend on
 *     (macOS would need `lsof`), so on a non-Linux host no group is ever
 *     signalled from a recorded pgid. The cost is a missed reap, never a wrong
 *     kill — and a missed reap is precisely the behaviour that shipped before
 *     any of this existed.
 *   - an empty or unreadable member list is not evidence of ownership either, so
 *     it declines too.
 *
 * Anything else — a record from before this launch behaviour existed, a platform
 * where the group could not be read — falls back to the pid alone, which is what
 * this runner did before and no worse.
 */
interface StopTarget {
  /**
   * The argument `kill(2)` is given: a pid, or a NEGATED pgid, which is how
   * POSIX addresses a whole process group.
   */
  target: number;
  group: boolean;
  /** The supervisor pid this target came from. */
  pid: number;
  /** The group id, when `group` is set — needed to enumerate its members. */
  pgid: number;
}

/**
 * Is this recorded group still the one our supervisor led?
 *
 * Answered from evidence, not from the pgid's arithmetic. See the header for why
 * a non-empty group is not on its own an answer.
 *
 * BOTH SIDES ARE `realpath`ed, and that is not defensive tidiness — without it
 * this check silently declines FOREVER on any project path containing a
 * symlink, which turns the verification that fixes the orphan leak into a new
 * way of never reaping anything. It fails closed and quietly, so nothing would
 * point at it.
 *
 * The recorded worktree is whatever string the launch was handed; the cwd comes
 * back from the kernel through `/proc/<pid>/cwd`, already fully resolved. On
 * macOS those differ for every temp path there is — `tmpdir()` is `/var`, which
 * is a symlink to `/private/var` — which is why docs/testing-harness.md already
 * tells you to `realpath` a temp root before comparing it with a path some other
 * tool printed. Same trap, same fix. Do not "simplify" this back to a bare
 * comparison.
 *
 * A path that cannot be resolved (it was deleted under us) yields null and is
 * simply not a match, which is the safe direction.
 */
async function verifyGroupOwnership(pgid: number, worktree: string): Promise<boolean> {
  const expected = await resolvePathOrNull(worktree);
  if (expected === null) return false;

  for (const member of await processesInGroup(pgid)) {
    const cwd = await processCwd(member);
    if (cwd === null) continue;
    if ((await resolvePathOrNull(cwd)) === expected) return true;
  }
  return false;
}

/** `realpath`, with "the path is gone" as a value rather than a throw. */
async function resolvePathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

async function resolveStopTarget(data: PidFileData): Promise<StopTarget> {
  const pidAlone: StopTarget = { target: data.pid, group: false, pid: data.pid, pgid: data.pid };

  // A recorded group is only a candidate when the launch confirmed the
  // supervisor led its own, and only when there is a worktree to verify against.
  const recorded = data.pgid != null && data.pgid === data.pid && data.worktree
    ? { pgid: data.pgid, worktree: data.worktree }
    : null;

  if (await isRunningProcess(data.pid)) {
    // The supervisor is alive: read its group from the OS and require it to lead
    // its own. A live read that agrees needs no further proof — the leader is
    // right there, and its own descendants are all a session leader's session
    // can contain.
    const pgid = await processGroupId(data.pid);
    if (pgid !== null && pgid === data.pid) return { target: -pgid, group: true, pid: data.pid, pgid };
    // The live read could not answer (it raced the exit, or the platform would
    // not say). Fall through to the recorded group rather than to the bare pid:
    // that race is precisely what the recorded value exists to survive.
    if (pgid !== null) return pidAlone;
  }

  if (!recorded) return pidAlone;
  return (await verifyGroupOwnership(recorded.pgid, recorded.worktree))
    ? { target: -recorded.pgid, group: true, pid: data.pid, pgid: recorded.pgid }
    : pidAlone;
}

function signalTarget(target: StopTarget, signal: NodeJS.Signals): void {
  process.kill(target.target, signal);
}

/**
 * Is anything the stop is aimed at still RUNNING?
 *
 * For a group this is deliberately "any member", not "the leader": the leak
 * being fixed is an agent that outlives its supervisor, so escalating the moment
 * the supervisor died would leave exactly that process behind.
 *
 * Zombies do not count, and that is not pedantry. `kill(pid, 0)` succeeds
 * against a process that has exited and not yet been reaped, and a stop
 * routinely kills a parent while its children are mid-exit — so a group of
 * not-yet-reaped zombies read as alive, the early return was skipped, and the
 * stop burned its whole grace period before a SIGKILL that had nothing to kill.
 * That is 5s on a standalone stop and 1s inside a shutdown already capped at
 * SIGNAL_SHUTDOWN_BUDGET_MS, spent waiting for processes that were already dead.
 */
async function isTargetAlive(target: StopTarget): Promise<boolean> {
  if (!target.group) return isRunningProcess(target.pid);

  // `kill(-pgid, 0)` is the cheap "does this group exist at all" probe; only
  // when it says yes is it worth reading each member's state.
  try {
    process.kill(target.target, 0);
  } catch {
    return false;
  }
  for (const member of await processesInGroup(target.pgid)) {
    if (await isRunningProcess(member)) return true;
  }
  return false;
}

/**
 * Is the process behind this run record still the supervisor the record claims?
 *
 * A live pid is NOT enough. PID files live in one global `~/.lazy/run`
 * directory keyed only by run name, so the same record can be answered by a
 * completely unrelated process: another project's supervisor for a task with
 * the same code, or whatever the OS handed the recycled pid to. Either way the
 * launcher reads "supervisor already running, it will pick up the command",
 * launches nothing, and the task sits in `working` forever while the reconciler
 * logs "still running, no response yet". That cost a real afternoon.
 *
 * So the record is checked against the running process: a supervisor's argv
 * carries the worktree it was launched with. A record with no recorded worktree
 * (written before the field existed) is believed on liveness alone — the old
 * behavior, for exactly the records that cannot be checked.
 */
async function isRecordedRunAlive(data: PidFileData): Promise<boolean> {
  if (!isProcessAlive(data.pid)) return false;
  if (!data.worktree) return true;
  const cmdline = await processCommandLine(data.pid);
  // No answer means the check is unavailable, not that the run is foreign;
  // claiming "not running" here would launch a second supervisor for a task
  // that already has one.
  if (cmdline === null) return true;
  return cmdline.includes(data.worktree);
}

/**
 * Read a run record and verify it still describes a live supervisor.
 *
 * A record that fails verification is deleted: leaving it behind is what wedges
 * the next task that carries the same run name.
 */
async function readLiveRun(runName: string): Promise<PidFileData | null> {
  const data = readPidFile(runName);
  if (!data) return null;
  if (await isRecordedRunAlive(data)) return data;
  if (isProcessAlive(data.pid)) {
    // Alive, but it is not our supervisor — never signal it, and stop letting
    // it answer for this run name.
    logger.debug(`Run ${runName}: pid ${data.pid} is not the recorded supervisor; discarding stale run record`);
    removePidFile(runName);
    return null;
  }
  return data;
}

export class HostProcessRunner implements Runner {
  readonly type = 'dangerously-host-process-without-any-isolation' as const;
  readonly runLabel = 'Process';
  private lazyRoot: string | undefined;

  constructor(lazyRoot?: string) {
    this.lazyRoot = lazyRoot;
  }

  private _agent?: Agent;
  /** The `[agents.<name>]` profile `_agent` was resolved from. See setAgent. */
  private _agentProfile?: string;
  private _roleTargets?: { builder: RoleTarget; agent: RoleTarget };
  // Host permission posture. Defaults to the safe sandbox posture so a runner
  // constructed without explicit config (createRunnerFromType) is never an
  // accidental full bypass. createRunner() overrides this from lazy.toml.
  private _hostPermission: HostPermissionConfig = {
    mode: 'sandbox',
    allowedDomains: ['*.anthropic.com'],
    allowWeakerNested: false,
    denyRead: [],
    denyWrite: [],
  };

  /**
   * Set the agent to use for auth. If not set, falls back to ClaudeCodeAgent
   * singleton. `profileName` is the `[agents.<name>]` profile the daemon
   * resolved `agent` from — see DockerRunner.setAgent for why both travel
   * together.
   */
  setAgent(agent: Agent, profileName?: string): void {
    this._agent = agent;
    this._agentProfile = profileName;
  }

  /** Set the per-role model targets (builder vs agent backends). */
  setRoleTargets(targets: { builder: RoleTarget; agent: RoleTarget }): void {
    this._roleTargets = targets;
  }

  /**
   * Point the agent role at the profile THIS task selected. See
   * {@link Runner.setAgentTarget}; the proxy address is carried across from the
   * role target for the reason DockerRunner.setAgentTarget documents.
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

  /** Set the host permission posture (sandbox vs bypass) from lazy.toml. */
  setHostPermission(cfg: HostPermissionConfig): void {
    this._hostPermission = cfg;
  }

  // Runtime file-tool boundary verification. Defaults to 'off' — the standing
  // signal is CI, not every launch. Deliberately NOT part of
  // HostPermissionConfig: that object defines the posture that becomes the
  // agent's --settings, and a policy knob has no business inside it.
  private _verifyBoundary: SandboxBoundaryVerification = 'off';

  /** Set the runtime boundary-verification mode from lazy.toml. */
  setBoundaryVerification(mode: SandboxBoundaryVerification): void {
    this._verifyBoundary = mode;
  }

  /** The resolved target for task/supervisor (agent) launches. */
  private agentTarget(): RoleTarget {
    return this._roleTargets?.agent ?? ANTHROPIC_DEFAULT_TARGET;
  }

  /** The resolved target for builder launches. */
  private builderTarget(): RoleTarget {
    return this._roleTargets?.builder ?? ANTHROPIC_DEFAULT_TARGET;
  }

  /**
   * Launch-time auth env with the Anthropic credential swapped for a per-launch
   * placeholder (src/proxy/placeholder-env.ts). Every path that hands env to a
   * process it is about to SPAWN uses this; {@link getAuthEnvVars} stays for
   * the in-process/non-launch readers.
   *
   * The injected agent still supplies the credential (see {@link getAuthEnvVars}),
   * but it is handed DOWN as injectedCreds rather than returned directly: the
   * swap has to happen on whichever credential this launch would really carry,
   * and a branch that returned early here is exactly how a real key would keep
   * reaching a launched process unnoticed.
   */
  private async getLaunchAuthEnvVars(
    identity: LaunchIdentity,
    target?: RoleTarget,
    hints?: ProxyAuditHints,
    credentialOverride?: Array<{ key: string; value: string }> | null,
  ): Promise<Array<{ key: string; value: string }>> {
    const resolved = target ?? this.agentTarget();
    // credentialOverride is team mode's per-session token: the launcher already
    // decided whose credential this turn runs on, so it wins over the agent's
    // own. Either way the launch gets a PLACEHOLDER — the override changes what
    // the proxy resolves it to, not whether one is minted.
    const injected = credentialOverride ?? (resolved.credential === 'anthropic' && this._agent
      ? this._agent.getAuthEnvVars()
      : undefined);
    return getLaunchAuthEnvVars(identity, resolved, hints, 'host', injected ?? undefined);
  }

  private getAuthEnvVars(
    target?: RoleTarget,
    hints?: ProxyAuditHints,
    credentialOverride?: Array<{ key: string; value: string }> | null,
  ): Array<{ key: string; value: string }> {
    const resolved = target ?? this.agentTarget();
    // A profile billing the Anthropic credential may use the injected agent's
    // credential (falls back to the default reader). That path emits no proxy
    // audit headers, so `hints` only takes effect via `getDefaultAuthEnvVars`.
    if (resolved.credential === 'anthropic' && this._agent) {
      return credentialOverride ?? this._agent.getAuthEnvVars();
    }
    // 'host': this runner launches Claude Code as a plain host process (the
    // sandbox shares the host network namespace), so it must never receive the
    // Docker-internal `host.docker.internal` alias. See LaunchSurface.
    return getDefaultAuthEnvVars(resolved, hints, 'host', credentialOverride);
  }

  runDisplayName(runName: string): string {
    const pidData = readPidFile(runName);
    return pidData ? `PID ${pidData.pid}` : runName;
  }

  async checkAvailability(): Promise<void> {
    // Check that the agent binary is on PATH, using the task agent's own
    // packaging when one is set (qa-agent's binary is `bun`, cursor's is
    // `cursor-agent`; the Claude Code default covers agent-less callers).
    {
      const pkg = this._agent ? getAgentPackaging(this._agent.id) : agentPackaging;
      const binaryName = pkg.binaryName();
      const proc = spawn([binaryName, '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const npmPackage = pkg.npmPackage();
        const installHint = npmPackage
          ? `Install it with: npm install -g ${npmPackage}`
          : pkg.supervisorToolChecks().find(c => c.cmd.startsWith(binaryName))?.hint
            ?? `Install the ${pkg.agentId} CLI.`;
        throw new Error(
          `${binaryName} CLI not found. ${installHint}\n` +
          `Host-process runner requires ${binaryName} to be installed on the host.`
        );
      }
    }

    // Sandbox dependency pre-flight (Linux/WSL2 only; macOS uses built-in
    // Seatbelt). When permission_mode = "sandbox", Claude Code's bubblewrap
    // backend needs `bwrap` and `socat`. We do NOT auto-install them — per the
    // host-first-runner spike, the sandbox failing must be a hard, actionable
    // error, never a silent fallback to an unsandboxed agent.
    if (this._hostPermission.mode === 'sandbox' && process.platform === 'linux') {
      const missing: string[] = [];
      for (const tool of ['bwrap', 'socat']) {
        try {
          const probe = spawn([tool, '--version'], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
          const code = await probe.exited;
          // socat --version exits non-zero on some builds but still exists; treat
          // "binary present" (no spawn throw) as sufficient.
          if (code !== 0 && tool === 'bwrap') missing.push(tool);
        } catch {
          // spawn throws ENOENT when the binary isn't on PATH.
          missing.push(tool);
        }
      }
      if (missing.length > 0) {
        throw new Error(
          `Host sandbox requires ${missing.join(' and ')} on Linux, but ${missing.length > 1 ? 'they are' : 'it is'} not on PATH.\n` +
          `Install with: sudo apt-get install -y bubblewrap socat (Debian/Ubuntu) or sudo dnf install bubblewrap socat (Fedora).\n` +
          `Alternatively set [runner] permission_mode = "bypass" in lazy.toml to run without the sandbox (no isolation).`
        );
      }
    }

    // File-tool boundary verification (opt-in via [runner]
    // verify_sandbox_boundary). The OS sandbox check above covers Bash; this
    // covers the Read/Edit/Write tools, which bypass the OS sandbox and are held
    // back only by the permissions.deny rules Claude Code honors for us. Throws
    // HostBoundaryBrokenError — refusing the launch — when a deny rule was
    // provably violated on this Claude Code version. See host-boundary-guard.ts
    // for why this is off by default and why an inconclusive run only warns.
    await ensureHostBoundaryVerified(this._hostPermission, this._verifyBoundary);

    // Auth is NOT enforced here. The daemon credential gate
    // (src/daemon/credential-gate.ts) is the single enforcement point.
    // Early, non-fatal reachability nudge for every upstream lazy probes
    // (fail-hard happens at launch via preflightRoleTarget). The same predicate
    // as the preflight, so the warning cannot go quiet for an upstream that
    // will refuse the launch a moment later.
    for (const role of ['agent', 'builder'] as const) {
      const target = role === 'agent' ? this.agentTarget() : this.builderTarget();
      if (!probesUpstream(target)) continue;
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
    taskId?: string,
    taskUuid?: string,
    _pinnedImage?: string,
    notify?: PhaseNotify,
  ): Promise<void> {
    // Fail hard before launch if the agent's backend is unreachable.
    await preflightRoleTarget('agent', this.agentTarget());
    // Same invariant as DockerRunner: a missing profile must fail loudly.
    // Without setRunnerAgentForTask the host path also defaults toward
    // Claude credentials while the command may still name cursor/codex.
    const agentProfile = this._agentProfile ?? this._agent?.id;
    if (!agentProfile) {
      throw new Error(
        `launchSupervisor called without an agent profile on the runner. ` +
        `Every launch path must call setRunnerAgentForTask (or applyRunnerAgent) ` +
        `before launch — otherwise a cursor/codex task silently gets the default ` +
        `claude-code credential environment and fails with fatal_auth.`,
      );
    }
    // No image to resolve or build here — the host runner spawns a process
    // directly, which is why this path was never the one that sat silent.
    notify?.('starting supervisor process');

    // This task's own environment variables (`lazy env set`), read from the
    // daemon state dir. See src/daemon/task-env.ts. Empty unless the user set
    // one, so behavior is unchanged for every other task. Keyed by the task
    // UUID, not the ref — see RunnerInterface.launchSupervisor.
    const projectRoot = this.lazyRoot ?? findLazyRoot();

    // Supervisor launches are always the `agent` role; the task turn it runs
    // inherits this env, so proxied traffic is attributed to agent + task.
    //
    // In team mode the launcher has already bound this task's turn to an owner;
    // the supervisor's placeholder resolves to that owner's credential instead
    // of the daemon's own. Null for every single-user install.
    const sessionCredential = (taskUuid && projectRoot)
      ? await sessionCredentialEnvFor(projectRoot, taskUuid)
      : null;
    const taskEnv = (taskUuid && projectRoot) ? await getTaskEnv(projectRoot, taskUuid) : {};

    // The daemon resolved this task's `[agents.<name>]` profile before setting
    // the agent; `_agent.id` is the HARNESS it runs. Both are needed below —
    // the harness decides which launch env to build, the profile decides where
    // the proxy forwards and whose credential pays. Read once so the two
    // inline `loadConfig` calls further down (cursor/codex bind address) do not
    // each pay for their own.
    const config = projectRoot ? await loadConfig(projectRoot) : null;
    const harness = this._agent?.id;
    // Prefer the checked profile (fail-loud above); harness fallback is only
    // for typing — agentProfile is always set when we reach here.
    const profileName = profileNameForAgent(agentProfile ?? harness);
    const profile = config ? profileForAgentNameOrNull(config, profileName) : null;
    const proxyBind = config?.proxy.bind ?? '127.0.0.1';

    const supervisorIdentity: LaunchIdentity = {
      role: 'agent',
      taskId: taskId ?? null,
      label: runName,
      // The task's agent IS its profile name — what the proxy routes by.
      profile: profileName,
    };
    const authEnvVars = await this.getLaunchAuthEnvVars(
      supervisorIdentity, this.agentTarget(), { role: 'agent', taskId }, sessionCredential,
    );

    // Non-claude agents with a managed API key (cursor): resolve it at LAUNCH
    // time (env override → per-project .lazy credentials file) so a key set
    // while the daemon runs takes effect on the next launch. No gate here:
    // a host process can also use the agent's own login session, and the CLI
    // fails with its own actionable auth error when neither exists.
    if (this._agent && this._agent.id !== 'claude-code' && agentSupportsApiKey(this._agent.id) && this.lazyRoot) {
      const key = await resolveAgentApiKey(this.lazyRoot, this._agent.id);
      if (key) {
        // JIT INJECTION: the launched process gets a PLACEHOLDER. The real key
        // is resolved here only to establish that one exists — the proxy
        // re-resolves it per request and injects it upstream.
        const envVar = AGENT_KEY_ENV[this._agent.id]!;
        const placeholder = await mintCredentialGrant(this.lazyRoot, {
          ...supervisorIdentity, envKey: envVar,
        });
        authEnvVars.push({ key: envVar, value: placeholder });
        logger.debug(`Resolved ${this._agent.id} API key from ${key.source}; host launch gets a placeholder`);
      }
    }

    // Cursor API traffic routes through lazy's proxy, same as Anthropic's. The
    // host surface must get a loopback address, never host.docker.internal —
    // see LaunchSurface. The path segment carries this launch's placeholder, or
    // `-` when the process authenticates with its own `cursor-agent login`
    // session (no key to swap — the only launch that stays unattributed).
    if (harness === 'cursor') {
      authEnvVars.push(...cursorLaunchEnvVars({
        harness,
        runnerType: 'dangerously-host-process-without-any-isolation',
        proxyPort: hasDaemonContext() ? getDaemonContext().proxyPort : undefined,
        bind: proxyBind,
        token: authEnvVars.find(v => v.key === AGENT_KEY_ENV.cursor)?.value ?? null,
      }));
    }

    // pi launch env: provider selection + no-startup-egress flags, plus the
    // OAuth-placeholder mirror. Same values the container launch path sets —
    // the PROFILE decides which of pi's providers runs and which model that
    // provider declares. See src/agent/pi-turn-config.ts.
    if (harness === 'pi') {
      authEnvVars.push(...piLaunchEnvVars({
        harness,
        profile: profile ?? undefined,
        upstreamTimeoutMs:
          (config?.proxy.upstreamTimeoutSeconds ?? DEFAULT_UPSTREAM_TIMEOUT_SECONDS) * 1000,
      }));
      authEnvVars.push(...piCredentialMirror(authEnvVars));
    }

    // Codex traffic routes through the proxy's OpenAI-compatible route; the
    // supervisor writes the base into ~/.codex/config.toml per turn. Loopback
    // address here — same LaunchSurface reasoning as the cursor branch above.
    if (harness === 'codex') {
      authEnvVars.push(...codexLaunchEnvVars({
        harness,
        runnerType: 'dangerously-host-process-without-any-isolation',
        proxyPort: hasDaemonContext() ? getDaemonContext().proxyPort : undefined,
        bind: proxyBind,
        endpoint: profile?.endpoint,
      }));
    }

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
      // supervisorArgs carries no env assignments, but pass the task's keys
      // anyway so the guarantee holds if one is ever added here.
      console.log('[DEBUG] Launching supervisor process:', redactSecrets(supervisorArgs, Object.keys(taskEnv)).join(' '));
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
      // setsid: the supervisor leads a process group (and session) of its own,
      // so stopping this run can signal the GROUP and take the agent with it.
      // Without this the supervisor inherits the daemon's group, which is both
      // why the agent survived a stop and why the group could not be signalled
      // — see resolveStopTarget. Safe for stdio here because the supervisor is
      // already unref'd with both streams redirected to a log file; the one
      // launch that owns a terminal is an interactive pair session, and that
      // never runs through this path (src/supervisor/interactive.ts).
      detached: true,
      timeout: 0, // Long-running: supervisor runs for the lifetime of the task
      env: {
        ...cleanEnv,
        // Per-task env goes in BEFORE lazy's own vars: reserved keys are already
        // refused at intake, and spreading it first means even a future gap in
        // that list cannot let a task redirect its own credentials or routing.
        ...taskEnv,
        ...Object.fromEntries(authEnvVars.map(v => [v.key, v.value])),
        // Ensure HOME is set for Claude Code
        HOME: getHome(),
        // Pass daemon config to supervisor so MCP server can route through daemon
        ...(daemonConfigPath ? { LAZY_DAEMON_CONFIG: daemonConfigPath } : {}),
      },
    });

    // Unref so this process doesn't keep the parent alive
    proc.unref();

    // Store PID for later status checks. The group is read back from the OS
    // rather than assumed to equal the pid: `detached: true` makes it so, but a
    // recorded group that merely restates an assumption would be worth nothing
    // on the day the assumption changed. Unreadable (a supervisor that died
    // instantly, a platform that will not say) leaves it absent, which every
    // reader treats as "signal the pid alone".
    const launchedPgid = await processGroupId(proc.pid);
    writePidFile(runName, {
      pid: proc.pid,
      startedAt: new Date().toISOString(),
      logFile,
      projectRoot: this.lazyRoot,
      worktree: sandbox.worktreePath,
      ...(launchedPgid !== null ? { pgid: launchedPgid } : {}),
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

    // The caller resolves the model; for a profile that pins its own endpoint
    // fall back to that profile's model when none was passed — the endpoint
    // serves it and nothing else.
    const effectiveModel = model ?? (target.pinned ? target.model : undefined);

    // Bypass interactive prompts (headless), then layer the OS sandbox on top in
    // "sandbox" mode so the agent is confined even though it never prompts. In
    // "bypass" mode this is just --dangerously-skip-permissions (no sandbox).
    const claudeArgs = [
      'claude', '-p', safeArgvPrompt(prompt, 'prompt'),
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      ...buildAgentSandboxArgs(this._hostPermission),
      // Always: see requireLaunchModel (src/agent/launch-model.ts).
      '--model', requireLaunchModel('claude-code', effectiveModel),
    ];

    if (debug) {
      console.log('[DEBUG] Running Claude command:', redactSecrets(claudeArgs).join(' '));
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

  /**
   * Machine one-shots never run on the host-process runner — see
   * {@link createOneshotRunner} in src/oneshot/container-runner.ts.
   */
  async runOneshot(_req: OneshotRequest): Promise<AgentResponse> {
    const { hostRunnerRemovedError } = await import('./host-runner-gate');
    throw hostRunnerRemovedError('machine one-shots');
  }

  /**
   * Deliberately the SUPERVISOR's liveness, not the run's whole process group —
   * unlike `discoverRunningRuns`, which answers "is there anything left to
   * stop".
   *
   * Both callers want the SUPERVISOR specifically: the launcher asks "is one
   * already up, which will pick up the command" (src/daemon/task-launcher.ts),
   * and the reconciler asks "is this turn still in flight"
   * (src/utils/reconcile.ts). An orphaned agent answers neither question yes.
   * Reporting it as running would refuse to launch a turn for a task whose
   * supervisor is gone and leave it in `working` forever, which is the exact
   * wedge `readLiveRun` exists to prevent. The orphan is the stop paths'
   * problem, not theirs.
   */
  async isRunning(runName: string): Promise<boolean> {
    const pidData = await readLiveRun(runName);
    if (!pidData) return false;
    return isRunningProcess(pidData.pid);
  }

  async runExists(runName: string): Promise<boolean> {
    return readPidFile(runName) !== null;
  }

  async getRunInfo(runName: string): Promise<RunInfo | null> {
    const pidData = await readLiveRun(runName);
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
    const pidData = await readLiveRun(runName);
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

  /**
   * Host-process runs have no inside to enter — the agent is a plain process on
   * this machine, sharing this filesystem and this HOME. Anything an exec would
   * show is already reachable locally, so callers get null and say so rather
   * than being handed a fake success.
   */
  async execInRun(
    _runName: string,
    _argv: string[],
    _opts?: { timeoutMs?: number; interactive?: boolean },
  ): Promise<number | null> {
    return null;
  }

  /** No inside to reach, for the same reason `execInRun` has none. */
  openRunStream(_runName: string, _argv: string[]): RunStream | null {
    return null;
  }

  /**
   * Host-process runs have no port mapping: the agent shares this machine's
   * network, so a server it starts on port 3000 IS on the host's port 3000.
   * Null says "there is nothing to map here" — distinct from an empty list,
   * which would mean "this environment publishes nothing".
   */
  async getRunPortBindings(_runName: string): Promise<PortBinding[] | null> {
    return null;
  }

  /**
   * `gracefulTimeoutSeconds` SETS the SIGTERM→SIGKILL window — it does not only
   * widen it. This runner is already graceful (SIGTERM first, escalate after the
   * grace period), so with the option absent it uses its own default; with the
   * option present the caller's number wins, in either direction.
   *
   * It used to be `max(5s, requested)`, which quietly ignored any caller asking
   * to escalate FASTER. The daemon's own shutdown sweep is exactly that caller:
   * it is racing a SIGKILL from whoever signalled it, and a grace period that
   * gets cut off is strictly worse than a short one that completes (see
   * SHUTDOWN_STOP_GRACE_SECONDS). Setting rather than widening also matches the
   * DockerRunner, where the same option has always chosen `stop --time <n>`
   * outright.
   */
  async stopRun(runName: string, opts?: { gracefulTimeoutSeconds?: number }): Promise<boolean> {
    // Verified, not merely read: signalling a pid that is no longer our
    // supervisor would kill whatever inherited it.
    const pidData = await readLiveRun(runName);
    if (!pidData) return false;

    const graceMs = opts?.gracefulTimeoutSeconds != null
      ? Math.max(0, opts.gracefulTimeoutSeconds * 1000)
      : DEFAULT_STOP_GRACE_MS;

    // The supervisor's whole process group when it owns one, so the agent it
    // spawned is stopped with it rather than orphaned to init — including when
    // the supervisor is already gone and the agent is all that is left.
    const target = await resolveStopTarget(pidData);

    try {
      signalTarget(target, 'SIGTERM');
      // Give it a moment, then SIGKILL if still alive.
      //
      // The wait is ASYNC on purpose. It used to be `Bun.sleepSync(100)`, which
      // froze the whole event loop for up to the full grace period — and the
      // daemon calls this for every supervisor it stops at shutdown, so a
      // handful of runs blocked the process for tens of seconds while the CLI's
      // `lazy daemon stop` gave up after five.
      const start = Date.now();
      while (Date.now() - start < graceMs) {
        if (!(await isTargetAlive(target))) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      // Force kill
      try {
        signalTarget(target, 'SIGKILL');
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
    const pidData = await readLiveRun(runName);
    if (!pidData) return;

    // Kill whatever is still running — the supervisor's whole group when it owns
    // one, so this does not leave the agent behind the way signalling the pid
    // alone did.
    //
    // Gated on the TARGET, not on the supervisor's pid. Gating on the pid is how
    // the worst version of this bug survived: a supervisor that died first made
    // `isProcessAlive` false, so the kill was skipped, the run record deleted,
    // and `src/task/cleanup.ts` went on to delete the worktree the agent was
    // still writing in.
    const target = await resolveStopTarget(pidData);
    if (await isTargetAlive(target)) {
      try {
        signalTarget(target, 'SIGKILL');
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
        // Verified: a record whose pid now belongs to something else must not
        // be reported as a running supervisor — callers stop what they discover.
        const pidData = await readLiveRun(runName);
        if (!pidData) continue;

        // A run counts as running when the SUPERVISOR is up OR when the group it
        // led still holds a verified member — i.e. an agent that outlived it.
        //
        // Requiring a live supervisor here is what kept the orphan fix off every
        // BULK path. `stop()`'s shutdown sweep, the restart reaper and
        // `lazy upgrade` all act on what this returns, so an agent whose
        // supervisor died first was invisible to all three and survived daemon
        // shutdown, daemon restart and an upgrade — reachable only by someone
        // naming the task. That is the scenario this work exists for: a run
        // stopped, and the agent still alive ninety seconds later.
        //
        // Discovery and the stop ask the SAME function, so a run reported here
        // is one the stop is prepared to signal — including the verification a
        // recorded group has to pass. Both read live state, so the two answers
        // can differ if a process exits between them; that costs a no-op stop,
        // which is the harmless direction.
        const target = await resolveStopTarget(pidData);
        if (!(await isTargetAlive(target))) continue;

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

  agentPiAgentDir(_worktreePath: string): string {
    // Host-process runs pi with the real host HOME (no sandbox), so pi's agent
    // config dir — its settings.json and the sessions/ tree — is the one under
    // that HOME. The worktree plays no part, matching agentSessionProjectDir.
    return join(getHome(), '.pi', 'agent');
  }

  supervisorToolChecks(): { cmd: string; name: string; hint: string }[] {
    const pkg = this._agent ? getAgentPackaging(this._agent.id) : agentPackaging;
    // Filter out the packaging's lazy-agent check — in host-process mode, the
    // supervisor IS lazy itself.
    return pkg.supervisorToolChecks().filter(c => c.name !== 'lazy-agent');
  }

  mcpServerConfig(
    taskId: string,
    worktreePath: string,
    opts?: { readOnly?: boolean; review?: boolean; toolset?: 'full' | 'read' | 'review' },
  ): { command: string; args: string[] } {
    const lazyCmd = getLazyCliCommand();
    const toolset = opts?.toolset
      ?? (opts?.review ? 'review' : opts?.readOnly ? 'read' : 'full');
    const toolsetFlag =
      toolset === 'review' ? ['--review'] :
      toolset === 'read' ? ['--read-only'] :
      [];
    return {
      command: lazyCmd[0],
      args: [
        ...lazyCmd.slice(1),
        'mcp',
        '--task-id', taskId,
        '--worktree', worktreePath,
        // Belt and braces here: this mode executes tools in-process, so it also
        // inherits the supervisor's LAZY_MCP_READ_ONLY / LAZY_MCP_REVIEW. The
        // flag makes the toolset explicit and visible in ~/.claude.json.
        ...toolsetFlag,
      ],
    };
  }

  async diagnose(): Promise<HealthCheck[]> {
    const results: HealthCheck[] = [];

    // Delegate agent-specific checks to packaging (task agent's own when set)
    results.push(...(this._agent ? getAgentPackaging(this._agent.id) : agentPackaging).diagnose());

    if (this._hostPermission.mode === 'bypass') {
      results.push({ state: 'ok', what: 'Runner mode: host-process, permission_mode = "bypass" (no sandbox, full --dangerously-skip-permissions)' });
    } else {
      results.push({ state: 'ok', what: `Runner mode: host-process, permission_mode = "sandbox" (OS sandbox; allowlist: ${this._hostPermission.allowedDomains.join(', ')})` });
      // On Linux the sandbox needs bwrap + socat. Surface a clear check result.
      if (process.platform === 'linux') {
        for (const tool of ['bwrap', 'socat']) {
          let present = false;
          try {
            const probe = spawn([tool, '--version'], { stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
            await probe.exited;
            present = true;
          } catch {
            present = false;
          }
          results.push(present
            ? { state: 'ok', what: `Sandbox dependency: ${tool}` }
            : { state: 'fail', what: `Sandbox dependency: ${tool}`, reason: `${tool} not on PATH — install bubblewrap and socat, or set permission_mode = "bypass"` });
        }
      }
      // The file-tool half of the boundary. Read-only here: doctor reports the
      // cached verdict and never spends three headless sessions of its own.
      results.push(await diagnoseBoundaryVerdict(this._hostPermission, this._verifyBoundary));
    }

    // Check connectivity for any role whose upstream lazy probes (see
    // probesUpstream) — including a LOCAL default nobody pinned.
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
    _projects?: BuilderLaunchProjects,
  ): Promise<{ exitCode: number; sessionId: string | null }> {
    // Host-process mode: launch Claude Code directly (no supervisor, no MCP proxy).
    // projects isolation is N/A here — there is no container HOME to remap, so
    // Claude reads/writes the real host ~/.claude/projects. (This mode is the
    // explicitly-unisolated runner anyway.)
    // MCP tools are not available in this mode — the builder relies on Claude Code's
    // built-in capabilities plus any tools the user has configured.
    // We still capture the conversation after exit by reading JSONL files.

    // Fail hard before launch if the builder's backend is unreachable.
    const builderTarget = this.builderTarget();
    await preflightRoleTarget('builder', builderTarget);

    // Inject the builder target's backend env vars (base URL for ollama/proxy,
    // dummy credentials for ollama) so a local-backend builder actually talks to
    // that backend rather than the inherited shell's default endpoint. The
    // identity carries the RESOLVED profile: it is the proxy's routing key, so a
    // hard-coded name would preflight one endpoint and then route to another.
    const builderEnvVars = await this.getLaunchAuthEnvVars(
      { role: 'builder', taskId: null, label: `host-builder:${lazyRoot}`, profile: builderTarget.profile },
      builderTarget,
      { role: 'builder' },
    );

    // Builder scratch dir — same contract as the container runner: a writable
    // place outside the repo, at the path the human reads. Derived from lazyRoot
    // by the same helper, so the two runners cannot drift. `lazy builder` also
    // passes it as `--add-dir` so the OS sandbox and the file tools treat it as
    // a workspace dir. See src/builder/scratch.ts.
    const scratchDir = await ensureBuilderScratchDir(lazyRoot);

    const claudeArgs = [
      'claude',
      '--append-system-prompt', safeArgvPrompt(systemPrompt, 'builder system prompt'),
      ...claudeExtraArgs,
    ];

    if (debug) {
      console.log('[DEBUG] Launching Claude Code directly:', redactSecrets(claudeArgs).join(' '));
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
        [SCRATCH_ENV_VAR]: scratchDir,
      },
    });

    const exitCode = await proc.exited;

    // Capture conversation from JSONL files
    const detectedSessionId = await captureConversation(lazyRoot, beforeSnapshot, 'Builder');

    return { exitCode, sessionId: detectedSessionId };
  }

  async launchBuilderHeadless(params: LaunchBuilderHeadlessParams): Promise<LaunchBuilderHeadlessResult> {
    const { lazyRoot, systemPrompt, prompt, resumeSessionId, authEnvVars, debug } = params;

    await preflightRoleTarget('builder', this.builderTarget());

    const config = await loadConfig(lazyRoot);
    const permissionArgs = buildBuilderPermissionArgs(
      {
        mode: config.runner.permission_mode,
        allowedDomains: config.runner.sandbox_allowed_domains,
        allowWeakerNested: config.runner.sandbox_allow_weaker_nested,
        denyRead: config.runner.sandbox_deny_read,
        denyWrite: config.runner.sandbox_deny_write,
      },
      true,
    );

    const scratchDir = await ensureBuilderScratchDir(lazyRoot);
    const argv = [
      ...buildBuilderHeadlessClaudeArgs(systemPrompt, prompt, resumeSessionId, builderHeadlessModel(config, this.builderTarget())),
      ...permissionArgs,
      '--add-dir', scratchDir,
    ];

    if (debug) {
      console.log('[DEBUG] Headless builder:', redactSecrets(argv).join(' '));
    }

    const beforeSnapshot = await snapshotSessionFiles(lazyRoot);
    const cleanEnv = { ...process.env } as Record<string, string>;
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.LAZY_IS_DAEMON;

    const proc = spawn(argv, {
      cwd: lazyRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...cleanEnv,
        ...Object.fromEntries(authEnvVars.map(v => [v.key, v.value])),
        [SCRATCH_ENV_VAR]: scratchDir,
      },
      timeout: 0,
    });

    const timeoutMs = DEFAULT_ONESHOT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch { /* already exited */ }
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already exited */ }
      }, ONESHOT_KILL_GRACE_MS);
    }, timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    if (timedOut) {
      throw new Error(`Builder review-session turn timed out after ${timeoutMs}ms and was killed.`);
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
    const sessionId = parsed.sessionId ?? await captureConversation(lazyRoot, beforeSnapshot, 'Builder');

    return { answer: parsed.answer, sessionId, exitCode };
  }
}
