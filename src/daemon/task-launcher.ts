/**
 * Daemon-side task launch orchestration.
 *
 * Owns the full lifecycle of starting a task: worktree creation, session
 * recording, protocol writing, MCP config generation, and supervisor launch.
 *
 * The daemon knows its own webPort and token, so MCP config generation is
 * trivial — no health checks, no fallbacks, no race conditions.
 *
 * This module must NOT:
 * - Call process.exit()
 * - Do interactive prompts (no TTY in daemon)
 * - Import CLI rendering/theme modules
 * - NEVER spawn lazy CLI as a subprocess (use internal functions instead)
 *
 * CRITICAL: The daemon has direct access to storage, runners, and all task
 * lifecycle functions. Never use getLazyCommand() or spawn lazy CLI from
 * daemon code — it causes deadlocks and storage lock contention.
 */

import { actorRole } from '../actor-ref';
import type { ReviewSettingsOverrides } from '../review/mode';

import { join } from 'path';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { pathExists } from '../utils/fs';
import { setupSandbox } from '../utils/sandbox';
import { loadConfig } from '../config/loader';
import type { EffortLevel, RunnerType } from '../config/types';
import { resolveProjectModel } from './project-settings';
import { switchTaskAgent, formatAgentSwitchAnnouncement } from './agent-switch';
import { resolveAndPersistLowHighLoop } from './effort';
import { resolveTurnLaunchIdentity } from './launch-identity';
import { resolveAgentChattiness, renderChattinessSnippet } from '../config/chattiness';
import { createRunner } from '../runner';
import { stampSessionRunner, removeTaskRun, mustRecreateForContainerAgent } from '../runner/session-launch';
import { pinnedCustomImage } from '../docker/worktree-image';
import { createDriver, resolveUpstreamMergeRef } from '../remote';
import { autoPushEnabled, autoPushConfigKey } from '../remote/auto-push';
import { getOrCreateStorage } from './rpc-handlers';
import { getDaemonContext, hasDaemonContext } from './context';
import { mintMcpToken, type McpIdentity, type MintMcpTokenOptions } from './mcp-tokens';
import {
  planTurnCredential,
  refuseLaunchWhileMemberInside,
  TurnCredentialUnavailableError,
  type TurnCredentialPlan,
} from './turn-credentials';
import { assertTurnStartAllowed, holdAgentStart } from './usage-pause';
import { isUsagePauseRefusal } from './rpc-error';
import { getMcpConfigDir } from './paths';
import { getCurrentSha, getRemoteDefaultBranch, createWorktreeFromSha, recoverMissingWorktree, copyUntrackedFilesIntoWorktree } from '../git/operations';
import { checkLock, acquireLock, removeLock } from '../utils/lock';
import { protocolDir as getProtocolDir, writeCommand, ensureProtocolDir, commonCommandFields, containerHandoffFileModeFor } from '../protocol';
import { shortId, displayId, taskRef, deriveTaskRef, getWorktreePath, getWorktreePathForRef, getBranchNameFromId } from '../task/identity';
import { taskBranchFor, looksLikeTaskBranch } from '../git/branch-prefix';
import { buildNotesContext, buildJournalNotice, buildArtifactNotice, buildSystemPrompt } from '../task/turn-context';
import { buildMemorySection } from '../memory';
import { buildLazyMdSection } from '../task/lazy-md';
import { checkOrphanedChild, retargetOrphanedChild } from '../task/orphan';
import { typeConstraintsSection } from '../task/type-constraints';
import { pinnedBaseOf } from '../task/base-pin';
import { parentTaskIdOf, branchTarget } from '../task-target';
import { isLinkedTask as isLinkedTaskFn } from '../task/linked';
import { getAgentPackaging } from '../agent/registry';
import { profileForAgentName, profileNameForAgent } from '../config/agent-profiles';
import { applyRunnerAgent } from './task-harness';
import { assertKnownAgentProfile } from './agent-profile-check';
import { getDataDir } from '../project-paths';
import { isFeatureEnabled } from '../utils/features';
import { logger } from '../utils/logger';
import { retargetReviewsAfterReparent } from './review-retarget';
import { getActor } from '../constants';
import { getNonHumanTurnCount, incrementNonHumanTurnCount, resetNonHumanTurnCount, checkTurnBudget } from './turn-budget';
import type { Actor, ActorInput } from '../types';
import { runGit } from '../utils/git';
import { withSpan } from '../tracing';
import { withTaskLifecycleLock } from './task-lifecycle-lock';
import { RpcError } from './rpc-handlers';
import { isOfflineMode } from '../utils/offline';
import { resetClusterFixRound } from './cluster-fix-rounds';
import { resolveWrapUpCommandFields } from './wrap-up-plan';
import type { StartCommand } from '../protocol';
import type { Task, Storage } from '../storage';
import {
  PhaseReporter,
  START_PHASES,
  startPhasePlan,
  type ProgressEmitter,
} from './progress';

import goalContextStartText from '../prompts/goal-context-start.md' with { type: 'text' };
import goalContextContinueText from '../prompts/goal-context-continue.md' with { type: 'text' };

// --- Input/Output types ---

export interface StartTaskParams {
  taskId: string;
  /**
   * The caller is a person who may use the one-shot usage-pause override
   * (src/daemon/usage-pause.ts, `overrideEligible`). Required: absent means
   * judged on the configured threshold alone, and refused without naming it.
   */
  usagePauseOverrideEligible?: boolean;
  modelOverride?: string;
  agentId?: string;
  forceLocal?: boolean;
  /** CLI has already prompted the user and confirmed orphan retargeting. */
  retargetOrphan?: boolean;
  /** CLI `--effort` override. Persists on the task so resumes see the same value. */
  effortOverride?: string;
  /**
   * `--review` / `--review-gate` / `--review-auto-fix` overrides. Each is
   * persisted on task metadata, so later turns stay in the same review arm and
   * a `lazy start --review` sticks with no second flag on every later command.
   * Whatever is not supplied is inherited: task > parent task > project.
   */
  reviewOverrides?: ReviewSettingsOverrides;
  /**
   * Per-task runner override (already resolved to a canonical RunnerType by the
   * CLI/MCP boundary). Highest precedence at launch and PERSISTED onto the task
   * so subsequent turns stay on the chosen runner (avoiding a cross-runner
   * flip-flop). null/undefined → fall back to `task.runner_type ?? global`.
   */
  runnerOverride?: RunnerType;
  /**
   * Who submitted this command, by channel: MCP boundary → 'builder' / 'agent',
   * CLI → 'human'. Persisted on the turn this launch writes.
   *
   * REQUIRED, deliberately. It used to default to `getActor()` — an env-var
   * read that answers `human` unless `LAZY_ACTOR=builder` is set — which meant
   * any launch path that forgot to thread the channel silently reported a HUMAN
   * launch. That is not merely an attribution slip: audience is derived from
   * who ran the task (`audienceOf`, src/task/audience.ts), so a child a cluster
   * started through a path that dropped the actor would be treated as work a
   * person is going to read, and pay for a presentation, screenshots and a
   * CHANGELOG pass that nobody opens. A required field makes the omission a
   * type error at the two call sites instead of a wrong answer at review time.
   */
  actor: ActorInput;
  /** Phase-narration sink (see ./progress.ts). Supplied by the transport — CLI only. */
  onProgress?: ProgressEmitter;
}

export interface StartTaskResult {
  sessionId: string;
  containerName: string;
  worktreePath: string;
  branchName: string;
  parentBranch: string | null;
  parentDisplayId: string | null;
  runnerType: string;
  warnings: string[];
  /**
   * Set when the start was HELD by the usage pause rather than launched: a
   * task's own agent started its subtask while the credential was paused
   * (src/daemon/usage-pause.ts, `holdAgentStart`). Nothing was launched, the
   * session/branch fields are empty, and `message` is what the agent is told.
   */
  usagePauseHeld?: { message: string };
}

// --- Helper functions ---

/**
 * The parameters a start the usage pause HELD is replayed with once the window
 * resets (src/daemon/usage-pause.ts, `holdAgentStart`): everything the agent
 * asked for except the task, the channel (the replay is always the agent's)
 * and the transport's progress sink.
 */
function heldStartParams(params: StartTaskParams): Record<string, unknown> {
  const { taskId: _task, actor: _actor, onProgress: _progress, ...rest } = params;
  return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
}

/**
 * May the usage pause HOLD this start (store it for a replay after the reset)?
 * Only when the start could otherwise go ahead as a FIRST start: the task is
 * `backlog` and has no session with turns. Anything else — a task already
 * started, running, parked or finished — gets its ordinary answer (the pause
 * refusal, or whatever the start path says), and nothing is written: a held
 * start on a task that is not waiting to start would replay into a 409, or
 * leave a pending-start mark on a task that can never honour it.
 */
async function startIsHoldable(storage: Storage, task: Task): Promise<boolean> {
  if (task.status !== 'backlog') return false;
  const session = await storage.getSessionByTaskId(task.id);
  return !session || (await storage.getTurnCountByTaskId(task.id)) === 0;
}

/** What a held start answers with: nothing launched, and what the agent is told. */
function heldStartResult(message: string): StartTaskResult {
  return {
    sessionId: '', containerName: '', worktreePath: '', branchName: '',
    parentBranch: null, parentDisplayId: null, runnerType: '',
    warnings: [message],
    usagePauseHeld: { message },
  };
}

/**
 * Replay a start the usage pause held, for the reconciler's pass once the
 * window resets (`processUsagePauseHolds`). Always as the AGENT that asked:
 * if the pause has tripped again by now, the launch path holds it anew.
 */
export async function launchHeldStart(
  projectRoot: string,
  taskId: string,
  params: Record<string, unknown>,
): Promise<'started' | 'held'> {
  const result = await launchTask(projectRoot, { ...(params as Partial<StartTaskParams>), taskId, actor: 'agent' });
  return result.usagePauseHeld ? 'held' : 'started';
}

function buildPromptWithInstructions(userPrompt: string, goal: string, isFirstTurn: boolean, lazyRoot: string, notesContext?: string, journalNotice?: string, artifactNotice?: string): string {
  const goalContext = (isFirstTurn ? goalContextStartText : goalContextContinueText)
    .replace(/\{\{goal\}\}/g, goal) + '\n\n';

  const notesSection = notesContext ?? '';
  // Count-only journal notice — never entry content. See buildJournalNotice.
  const journalSection = journalNotice ?? '';
  // Pointer to materialized files, never their content. See buildArtifactNotice.
  const artifactSection = artifactNotice ?? '';
  return goalContext + notesSection + journalSection + artifactSection + userPrompt;
}

async function buildLinkedTaskPreamble(worktreePath: string, branchName: string, parentBranch: string): Promise<string> {
  const lines: string[] = [];
  lines.push(`You are working on an existing branch '${branchName}' that was forked from '${parentBranch}'.`);
  lines.push('This branch already has work on it. Read the existing changes carefully before making modifications.');
  lines.push('');

  const countResult = await runGit(
    ['rev-list', '--left-right', '--count', `${parentBranch}...${branchName}`],
    { cwd: worktreePath },
  );
  if (countResult.exitCode === 0) {
    const parts = countResult.stdout.split(/\s+/);
    const behind = parseInt(parts[0], 10) || 0;
    const ahead = parseInt(parts[1], 10) || 0;
    lines.push(`Branch status: ${ahead} commit(s) ahead, ${behind} commit(s) behind ${parentBranch}.`);
    lines.push('');
  }

  const logResult = await runGit(
    ['log', '--no-color', '--oneline', `${parentBranch}..${branchName}`],
    { cwd: worktreePath },
  );
  if (logResult.exitCode === 0 && logResult.stdout) {
    lines.push('Existing commits on this branch:');
    lines.push(logResult.stdout);
    lines.push('');
  }

  const statusResult = await runGit(['status', '--short'], { cwd: worktreePath });
  if (statusResult.exitCode === 0) {
    const status = statusResult.stdout;
    if (status) {
      lines.push('Working tree has uncommitted changes:');
      lines.push(status);
    } else {
      lines.push('Working tree is clean.');
    }
    lines.push('');
  }

  const diffStatResult = await runGit(
    ['diff', '--no-color', '--stat', `${parentBranch}...${branchName}`],
    { cwd: worktreePath },
  );
  if (diffStatResult.exitCode === 0 && diffStatResult.stdout) {
    lines.push(`Diff from ${parentBranch}:`);
    lines.push(diffStatResult.stdout);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate daemon MCP config for a container.
 *
 * The daemon knows its own webPort — no health check or fallback needed. This
 * is the key advantage of daemon-owned launch: the MCP config is always correct
 * because the daemon IS the server.
 *
 * The token written here is NOT the shared daemon token: it is minted for, and
 * bound server-side to, `identity` alone (see src/daemon/mcp-tokens.ts). The
 * daemon derives the caller's identity from it and refuses a request whose
 * claimed `:taskId` disagrees, so a stolen or copied config cannot be used to
 * act as another task.
 *
 * CONTAINER REUSE: the path is stable per container and this write truncates in
 * place, so a container that ALREADY has this file bind-mounted (the mount pins
 * the inode) picks the new contents up without a relaunch — which is what lets
 * the reuse branches in task-lifecycle.ts skip re-mounting. The one thing that
 * cannot be repaired that way is a container whose FIRST launch received no
 * config: LAZY_DAEMON_CONFIG comes from the launch argv, so it stays unset for
 * that container's entire life and every turn in it would have no lazy_* tools.
 * That failure used to be swallowed (one warn line in a container log, days to
 * diagnose); prepareTurnMcp now fails the turn instead, so the condition is
 * self-reporting and the next relaunch supplies the config.
 */
export async function writeDaemonMcpConfig(
  projectRoot: string,
  containerName: string,
  identity: McpIdentity,
  options: MintMcpTokenOptions = {},
): Promise<string> {
  const { webPort } = getDaemonContext();
  const token = await mintMcpToken(projectRoot, identity, containerName, options);

  const configDir = daemonMcpConfigDir(projectRoot);
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, `${DAEMON_MCP_CONFIG_PREFIX}${containerName}.json`);

  const config = {
    token,
    projectRoot,
    // Task tokens carry their own task id; the supervisor still passes
    // --task-id, and the daemon refuses any claim that isn't this identity.
    taskId: identity.kind === 'task' ? identity.taskId : '',
    target: daemonMcpTarget(webPort),
  };
  // 0600: the file carries a bearer credential. It is bind-mounted read-only
  // into exactly one container, by absolute path. A root daemon on native
  // Linux widens it to 0644 so that container's user can read it at all —
  // see containerHandoffFileModeFor.
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: containerHandoffFileModeFor(process.getuid?.()) });

  return configPath;
}

/** Filename prefix for daemon MCP config files. */
export const DAEMON_MCP_CONFIG_PREFIX = 'daemon-mcp-';

/**
 * Directory holding this project's daemon MCP config files.
 *
 * SECURITY: this is the daemon's own state dir (~/.lazy/daemon/<slug>/mcp/),
 * NOT `<project>/.lazy/tmp/` where these files used to live. Task containers
 * bind-mount the whole repo read-only, so an in-repo config was readable by
 * every other agent — any agent could have lifted another task's (or the
 * builder's) token straight off disk, which would defeat per-task tokens
 * entirely. Each config is bind-mounted into its one container by absolute
 * path, so nothing needs it to be inside the repo.
 */
export function daemonMcpConfigDir(projectRoot: string): string {
  return getMcpConfigDir(projectRoot);
}

/** The TCP target a container uses to call back into the daemon. */
export function daemonMcpTarget(webPort: number): string {
  return `http://host.docker.internal:${webPort}`;
}

export interface McpConfigRefreshResult {
  scanned: number;
  updated: number;
  skipped: number;
}

/**
 * Bring every previously-minted daemon MCP config up to date with the daemon's
 * CURRENT web port.
 *
 * Why this exists: a config is minted once at launch and bind-mounted into a
 * container (`-v <path>:<path>:ro`). If the daemon later restarts onto a
 * different port — which happens whenever another project's daemon has taken
 * the port in the shared 26024+ window — every running container keeps calling
 * the old port. If a FOREIGN daemon has taken it, it answers and rejects our
 * token with a permanent 401 on every tool, read-only ones included; if nothing
 * has, the calls fail at the transport layer with ECONNREFUSED. Either way the
 * token is right and the daemon is wrong, so only the ADDRESS needs correcting.
 *
 * The token is deliberately preserved, never rewritten: it is bound to one
 * identity in the token registry (src/daemon/mcp-tokens.ts), which survives
 * daemon restarts precisely so a running container stays valid. Overwriting it
 * with some other token would hand a container an identity that isn't its own.
 *
 * A single-file bind mount pins the inode, so rewriting the file IN PLACE
 * (open + truncate, never rename) is visible inside the running container. The
 * container-side proxy re-reads it whenever a call fails to reach the daemon —
 * on a 401 and on a connection that never established — and retries once, so a
 * live session heals itself instead of losing every lazy tool until relaunch.
 *
 * Never fails the caller: a daemon must start even if this housekeeping can't.
 */
export async function refreshDaemonMcpConfigs(
  projectRoot: string,
  current: { webPort: number },
  log: { info: (m: string) => void; warn: (m: string) => void },
): Promise<McpConfigRefreshResult> {
  const result: McpConfigRefreshResult = { scanned: 0, updated: 0, skipped: 0 };
  const configDir = daemonMcpConfigDir(projectRoot);

  let entries: string[];
  try {
    entries = await readdir(configDir);
  } catch (err) {
    // No config dir yet (fresh project, nothing ever launched) is the normal
    // case — not an error. Anything else is worth a warning but not a failure.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Could not scan ${configDir} to refresh daemon MCP configs: ${err instanceof Error ? err.message : String(err)}`);
    }
    return result;
  }

  const target = daemonMcpTarget(current.webPort);

  for (const name of entries) {
    if (!name.startsWith(DAEMON_MCP_CONFIG_PREFIX) || !name.endsWith('.json')) continue;
    result.scanned++;
    const path = join(configDir, name);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
      if (parsed.target === target && parsed.projectRoot === projectRoot) {
        result.skipped++;
        continue;
      }
      // Preserve every other field — above all the per-identity token. Only
      // the address (and the project it names) are ours to correct.
      const next = { ...parsed, projectRoot, target };
      // writeFile truncates in place and keeps the inode, which is what makes
      // the change visible through an already-established bind mount. Do NOT
      // switch this to a write-temp-then-rename: rename breaks the mount.
      await writeFile(path, JSON.stringify(next, null, 2));
      result.updated++;
    } catch (err) {
      // A single unreadable/corrupt leftover must not stop the others.
      log.warn(`Could not refresh daemon MCP config ${path}: ${err instanceof Error ? err.message : String(err)}`);
      result.skipped++;
    }
  }

  if (result.updated > 0) {
    log.info(
      `Refreshed ${result.updated} daemon MCP config${result.updated === 1 ? '' : 's'} ` +
      `to ${target} — running containers pick this up on their next failed tool call`,
    );
  }
  return result;
}

/**
 * Failure message for a top-level task whose stored branch target cannot be
 * resolved (branch deleted, renamed, or never pushed).
 *
 * Silently falling back to the repo default here would discard the user's
 * explicit `--parent` choice and base the task on the wrong branch — the exact
 * silent-wrongness this message exists to prevent. Name the branch and give the
 * two real ways out.
 */
function unresolvableTargetMessage(branch: string, task: Task, detail?: string): string {
  const cause = detail ? `: ${detail}` : '';
  return (
    `Failed to resolve target branch '${branch}' for task ${displayId(task)}${cause}. ` +
    `This task was created with --parent ${branch}, so lazy will not silently start it ` +
    `from the repository default instead. Either make '${branch}' resolvable ` +
    `(fetch/restore it, or pass --force-local to start from its local ref), ` +
    `or retarget the task with: lazy reparent ${displayId(task)} <parent>`
  );
}

// --- Pre-flight validation ---

/*
 * REMOVED, DELIBERATELY: `assertLoopHasNoRunningChild`.
 *
 * INVARIANT: a cluster task may have ANY number of running children, and no
 * launch path may refuse a start because a sibling is running.
 *
 * The type was called `loop` and this file refused to START a second child
 * while one was active, on the argument that serial children cost no sibling
 * merges. Ten days of running them settled it the other way (engineer,
 * 2026-09-20): the merges it avoided were mostly micro-conflicts, and the
 * serialisation cost so much that two small children took 1h46m and 1h10m of
 * wall-clock apiece. The driver now decides concurrency itself, on file overlap
 * and dependency, in src/prompts/cluster-constraints.md.
 *
 * Do not reintroduce this as a cap or a queue: agent tasks are uncapped by
 * design (the agent concurrency cap, its queue machinery and the idle reaper
 * were all removed in 2026-08). If a cluster is starting children that collide,
 * the fix is the driver's judgement, not a daemon refusal.
 */

async function validateTask(storage: Storage, taskId: string, root: string, agentIdOverride?: string, retargetOrphan?: boolean) {
  const result = await storage.resolveTask(taskId);
  if (!result.task) {
    if (result.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${taskId}'. Matches: ${result.ambiguousMatches.map(t => `${shortId(t.id)} (${t.goal})`).join(', ')}`);
    }
    throw new RpcError(404, `Task not found: ${taskId}`);
  }

  let t = result.task;

  if (!t.prompt) {
    throw new RpcError(400, `Task ${displayId(t)} has no prompt. Set one with: lazy edit ${displayId(t)}`);
  }

  // Validate agent
  if (agentIdOverride) await assertKnownAgentProfile(root, agentIdOverride);

  // Handle orphaned child (parent accepted, branch gone) FIRST.
  // CLI prompts the user and passes retargetOrphan=true if confirmed.
  // Daemon only retargets when explicitly told to.
  //
  // This must precede the parent-worktree check below: an orphaned child's
  // parent is complete and its worktree is gone, so checking the worktree
  // first rejected every orphan with "start the parent first" — advice the
  // user cannot follow, and exactly the case retargeting exists to fix.
  const tParentId = parentTaskIdOf(t);
  if (tParentId && retargetOrphan) {
    const orphanStatus = await checkOrphanedChild(t, storage, root);
    if (orphanStatus.isOrphaned && orphanStatus.retargetBranch) {
      await retargetOrphanedChild(t, storage, orphanStatus.retargetBranch);
      // Refresh task
      t = (await storage.getTask(t.id))!;
      // Its open PR/MR follows the new target (./review-retarget.ts;
      // best-effort, never throws).
      for (const note of await retargetReviewsAfterReparent(root, storage, [t])) logger.info(note);
    }
  }

  // Check parent worktree exists for child tasks. Re-derive the parent from the
  // (possibly retargeted) task: a retargeted orphan now targets a branch and
  // has no parent left to check.
  const parentIdAfterRetarget = parentTaskIdOf(t);
  if (parentIdAfterRetarget) {
    const parentTask = await storage.getTask(parentIdAfterRetarget);
    if (!parentTask) {
      throw new RpcError(400, `Parent task not found: ${parentIdAfterRetarget}`);
    }
    const parentWorktreePath = getWorktreePath(root, parentTask);
    if (!await pathExists(parentWorktreePath)) {
      throw new RpcError(400, `Cannot start child task: parent task has no worktree. Start the parent first with: lazy start ${displayId(parentTask)}`);
    }
  }

  // Check task status
  if (t.status === 'pairing') {
    throw new RpcError(409, `Task ${displayId(t)} is locked (pairing in progress). End the pairing session first.`);
  }

  return t;
}

// --- Main launch orchestration ---

/**
 * Start a task. Called by the daemon's RPC handler.
 *
 * This is the single entry point for all task launches. The daemon owns:
 * - Runner creation and availability checking
 * - Worktree creation/recovery
 * - Session and turn recording
 * - Protocol file writing
 * - MCP config generation (daemon knows its own webPort)
 * - Supervisor launch
 * - Branch publishing
 */
export async function launchTask(
  projectRoot: string,
  params: StartTaskParams,
): Promise<StartTaskResult> {
  const phases = new PhaseReporter(params.onProgress, 'start');
  try {
    return await launchTaskRun(projectRoot, params, phases);
  } catch (err) {
    phases.fail(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function launchTaskRun(
  projectRoot: string,
  params: StartTaskParams,
  phases: PhaseReporter,
): Promise<StartTaskResult> {
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor: MCP-originated starts are 'builder'/'agent', CLI 'human'.
  // Required at this boundary — see StartTaskParams.actor for why there is no
  // fallback any more.
  const actor = params.actor;

  phases.begin(START_PHASES.preflight);

  // --- Validate task ---
  let t = await withSpan('start.validate', { 'lazy.task_id': params.taskId }, () =>
    validateTask(storage, params.taskId, projectRoot, params.agentId, params.retargetOrphan),
  );

  // Config needed for agent-switch re-resolution and later launch steps.
  // Loaded here (before runner preflight) so a mid-start --agent change can
  // re-resolve model/effort with the same ladder as edit/unblock.
  const config = await loadConfig(projectRoot);

  // --- Usage pause, judged BEFORE the agent/runner writes below ---
  // On the task as this start will run it (`--agent` applied), and without
  // spending the one-shot override: a refused start must leave the task exactly
  // as it was, stored agent included. The gate further down takes the override.
  //
  // A task's own AGENT starting its subtask (a cluster driver) is HELD rather
  // than refused: the start is stored on the subtask and the reconciler
  // launches it by itself once the window resets (see `holdAgentStart`).
  const verdictTask = params.agentId ? { ...t, agent_id: params.agentId } : t;
  try {
    await assertTurnStartAllowed(projectRoot, {
      task: verdictTask, config, actor, verb: 'start', peek: true,
      overrideEligible: params.usagePauseOverrideEligible === true,
    });
  } catch (err) {
    if (!isUsagePauseRefusal(err) || actorRole(actor) !== 'agent' || !(await startIsHoldable(storage, t))) throw err;
    const message = await holdAgentStart(projectRoot, storage, t, verdictTask, heldStartParams(params));
    phases.end(`${displayId(t)} held by the usage pause`);
    return heldStartResult(message);
  }

  // Apply agent override — persist + re-resolve model/effort when the agent
  // actually changes (same helper as edit/unblock). An in-memory-only override
  // used to leave task.agent_id stale and keep the previous agent's model.
  if (params.agentId && params.agentId !== t.agent_id) {
    const projectSettingsForSwitch = await storage.getProjectSettings();
    const switchResult = await switchTaskAgent({
      storage,
      task: t,
      newAgentId: params.agentId,
      config,
      projectModel: resolveProjectModel(projectSettingsForSwitch, config),
      modelOverride: params.modelOverride,
      effortOverride: params.effortOverride,
    });
    t = (await storage.getTask(t.id))!;
    for (const line of formatAgentSwitchAnnouncement(switchResult)) {
      warnings.push(line);
    }
    // Switch already applied co-supplied overrides; launch resolve below
    // should not treat them as a second durable write.
    params = { ...params, modelOverride: undefined, effortOverride: undefined };
  } else if (params.agentId) {
    t = { ...t, agent_id: params.agentId };
  }

  // --- Runner pre-flight ---
  // Per-task runner resolution: explicit start override > stored task override >
  // global config default. A start --runner override is persisted onto the task
  // so the next turn doesn't flip back to the global default.
  if (params.runnerOverride && t.runner_type !== params.runnerOverride) {
    await storage.updateTaskRunnerType(t.id, params.runnerOverride);
    t = { ...t, runner_type: params.runnerOverride };
  }
  const runner = await createRunner(projectRoot, t.runner_type ?? undefined);

  // `t.agent_id` names a PROFILE; packaging and the agent class are properties
  // of the HARNESS the profile runs. Resolve once here, at the daemon boundary
  // where the project's config is in hand, and hand the harness down — nothing
  // below this line should have to know that a profile is not an agent id.
  const profile = profileForAgentName(config, t.agent_id, `task ${displayId(t)}`);
  const harness = profile.harness;

  // Validate runner/agent compatibility against the RESOLVED runner. The
  // capability comes from the agent's packaging, not a hardcoded id list.
  if (
    runner.type !== 'dangerously-host-process-without-any-isolation' &&
    !getAgentPackaging(harness).supportsContainerRunner()
  ) {
    throw new RpcError(
      400,
      `Agent profile "${t.agent_id}" runs harness "${harness}", which does not support container runners. ` +
      `Select a profile whose harness is "claude-code", "codex", "cursor", or "pi" with [runner] type = "docker".`,
    );
  }

  // Set the configured agent on the runner so it uses the correct auth.
  // Without this, HostProcessRunner defaults to the ClaudeCodeAgent singleton
  // which requires ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN even for agents
  // that don't need them (e.g., qa-agent). The profile rides along so the launch
  // preflights ITS upstream, mints against ITS credential slot, and carries a
  // grant saying which upstream this turn's traffic belongs to.
  applyRunnerAgent(runner, profile);
  await runner.checkAvailability();

  phases.end(displayId(t));

  // --- Turn budget: cap consecutive turns without a human in the loop ---
  // Builder/agent-initiated starts count; a human start resets the count.
  // Checked before anything is provisioned so a task that would be refused
  // never consumes a turn.
  if (actorRole(actor) !== 'human') {
    const nonHumanTurnCount = await getNonHumanTurnCount(storage, t.id);
    const budgetDecision = checkTurnBudget(nonHumanTurnCount, config.limits.max_turns_without_human);
    if (!budgetDecision.allowed) {
      throw new RpcError(409, `Task ${displayId(t)}: ${budgetDecision.reason}`);
    }
  }

  // --- Usage pause ([usage_pause], src/daemon/usage-pause.ts) ---
  // The decision was already made (peek, above, before any write); this call
  // is where a one-shot override that decision relied on is TAKEN — after the
  // runner preflight, so it is not spent on a start that fails there. An agent's
  // start that a reading arriving since the peek now pauses is held like above.
  try {
    await assertTurnStartAllowed(projectRoot, {
      task: t, config, actor, verb: 'start',
      overrideEligible: params.usagePauseOverrideEligible === true,
    });
  } catch (err) {
    if (!isUsagePauseRefusal(err) || actorRole(actor) !== 'agent' || !(await startIsHoldable(storage, t))) throw err;
    return heldStartResult(await holdAgentStart(projectRoot, storage, t, t, heldStartParams(params)));
  }

  // --- Offline mode: auto-enable forceLocal and use local driver ---
  // Mirrors sync/reparent: when offline we branch from the LOCAL parent/integration
  // branch and never touch the remote. createDriver({ offline }) returns a
  // LocalDriver whose resolveUpstreamRef resolves the branch locally (no fetch),
  // so the parent-ref resolution below cannot make a network call. forceLocal is
  // also set so that if the local branch is missing we degrade to the parent
  // worktree HEAD rather than failing on a remote we're not allowed to reach.
  const offline = await isOfflineMode(join(projectRoot, '.lazy'), config.remote.offline);
  if (offline) {
    params.forceLocal = true;
    if (config.remote.driver === 'gitlab' || config.remote.driver === 'github') {
      warnings.push(
        'lazy is in offline mode. Starting from the local parent branch only — ' +
        'no remote fetch will be performed. ' +
        `Accepts will not create ${config.remote.driver === 'gitlab' ? 'MRs' : 'PRs'}, ` +
        'and remote sync will be skipped. Run `lazy system online` to restore remote operations.',
      );
    } else {
      warnings.push('Offline mode: starting from local HEAD (remote operations skipped)');
    }
  }

  const driver = createDriver(config, undefined, { offline });

  // --- Session check ---
  const isLinkedTask = isLinkedTaskFn(t);
  const existingSession = await storage.getSessionByTaskId(t.id);
  // A start refused at the credential plan (below) leaves exactly this behind:
  // an open session with NO turn, and the task still in its pre-start status.
  // The session exists only because the plan records the turn owner and binds
  // the credential against a session id; nothing ran on it. A retried start
  // reuses it — refusing with "already has an active session" would wedge the
  // task the refusal was careful not to touch.
  const refusedStartSession = existingSession && !isLinkedTask && !existingSession.ended_at
    && (await storage.getSessionTurns(existingSession.id)).length === 0
    ? existingSession
    : null;
  if (existingSession && !isLinkedTask && !refusedStartSession) {
    if (!existingSession.ended_at) {
      throw new RpcError(409, `Task ${displayId(t)} already has an active session. Unblock it with: lazy unblock ${displayId(t)}`);
    } else {
      throw new RpcError(409, `Task ${displayId(t)} session has ended (${existingSession.outcome}). Create a variant with: lazy branch ${displayId(t)}`);
    }
  }

  const lfsCheckEnabled = config.git.lfs_check !== 'off';
  phases.announce(startPhasePlan(lfsCheckEnabled, !isLinkedTask), displayId(t));

  phases.begin(START_PHASES.resolveBase);

  // --- Task ref ---
  if (!t.metadata?.task_ref) {
    const allTasks = await storage.listTasks();
    const ref = deriveTaskRef(t, allTasks);
    await storage.updateTaskMetadata(t.id, 'task_ref', ref);
    if (!t.metadata) t.metadata = {};
    t.metadata.task_ref = ref;
  }

  const tRef = taskRef(t);
  const branchName = isLinkedTask && existingSession
    ? existingSession.git_branch
    : taskBranchFor(tRef);

  // --- Determine parent branch and start SHA ---
  const tParentId = parentTaskIdOf(t);
  // Explicit branch target stored at create time (`lazy create --parent release-x`).
  // '' and a stale task-branch ref are "needs runtime resolution" sentinels, not
  // real targets (see src/task-target.ts) — treat both as absent. The check
  // accepts the built-in `lazy/` namespace as well as the configured one: a
  // project that changed `[git] default_branch_prefix` still has stale refs
  // written under the old namespace, and using one as a real integration target
  // is the dangerous direction. Mirrors resolveSyncTarget in task-lifecycle.ts.
  const storedRawTarget = t.target.kind === 'branch' ? t.target.branch : '';
  const storedBranchTarget = storedRawTarget && !looksLikeTaskBranch(storedRawTarget)
    ? storedRawTarget
    : undefined;
  let startSha: string;
  let parentBranch: string | null = null;

  if (isLinkedTask && existingSession) {
    startSha = existingSession.git_start_sha;
    parentBranch = t.metadata?.parent_branch ?? await getRemoteDefaultBranch(projectRoot, config.remote.git_remote);
  } else if (tParentId) {
    const parentTask = (await storage.getTask(tParentId))!;
    const parentWorktreePath = getWorktreePath(projectRoot, parentTask);
    parentBranch = await getBranchNameFromId(tParentId, storage);

    try {
      // Branch from the ref the child will eventually merge back into. A parent
      // TASK branch is unprotected, so accept merges into its LOCAL branch — and
      // its agent's commits are never on origin. Cutting a stacked child from
      // `origin/<parent>` would start it behind its own parent.
      const resolution = await resolveUpstreamMergeRef(driver, parentBranch, projectRoot, {
        remoteName: config.remote.git_remote,
      });
      warnings.push(...resolution.warnings);
      const parentRef = resolution.ref;
      const resolveResult = await runGit(['rev-parse', parentRef], { cwd: projectRoot });
      if (resolveResult.exitCode === 0) {
        startSha = resolveResult.stdout;
      } else if (params.forceLocal) {
        warnings.push('Using parent worktree HEAD (remote ref resolution failed)');
        startSha = await getCurrentSha(parentWorktreePath);
      } else {
        throw new RpcError(500, `Failed to resolve ${parentRef}. Use --force-local to start from local HEAD.`);
      }
    } catch (err) {
      if (err instanceof RpcError) throw err;
      if (params.forceLocal) {
        warnings.push(`Failed to fetch parent branch (using local HEAD): ${err instanceof Error ? err.message : err}`);
        startSha = await getCurrentSha(parentWorktreePath);
      } else {
        throw new RpcError(500, `Failed to fetch parent branch ${parentBranch}: ${err instanceof Error ? err.message : err}. Use --force-local to start from local HEAD.`);
      }
    }

    await storage.updateTaskBranchedFromSha(t.id, startSha);
    t.branched_from_sha = startSha;
  } else {
    // Top-level task. An explicitly stored branch target (`lazy create --parent
    // release-x`) is the user's instruction and MUST be honoured — branching from
    // the repo default instead would silently discard it (principle of least
    // surprise). Only with no stored target do we default to the repo's
    // configured integration branch (origin/HEAD → main fallback), NOT the user's
    // currently checked-out branch: adopting whatever the user happens to be on
    // at start time produced bad PRs targeting dead release branches.
    parentBranch = storedBranchTarget
      ?? await getRemoteDefaultBranch(projectRoot, config.remote.git_remote);

    // With a stored target, --force-local means "the branch's LOCAL ref" — never
    // the repo's current HEAD, which is a different branch and would resurrect
    // the silent-discard bug through the fallback path. If that local ref does
    // not resolve either, fail loudly with the branch named.
    const localStartSha = async (): Promise<string> => {
      if (!storedBranchTarget) return await getCurrentSha(projectRoot);
      const local = await runGit(
        ['rev-parse', '--verify', '--quiet', `${storedBranchTarget}^{commit}`],
        { cwd: projectRoot },
      );
      if (local.exitCode !== 0) {
        throw new RpcError(500, unresolvableTargetMessage(storedBranchTarget, t));
      }
      return local.stdout;
    };

    try {
      // Same resolution as the child-task path: a protected integration branch
      // resolves to `origin/<branch>` as before, while an unprotected local
      // target (which accept merges into locally) is not silently replaced by a
      // stale remote ref.
      const resolution = await resolveUpstreamMergeRef(driver, parentBranch, projectRoot, {
        remoteName: config.remote.git_remote,
      });
      warnings.push(...resolution.warnings);
      const parentRef = resolution.ref;
      const resolveResult = await runGit(['rev-parse', parentRef], { cwd: projectRoot });
      if (resolveResult.exitCode === 0) {
        startSha = resolveResult.stdout;
      } else if (params.forceLocal) {
        warnings.push(storedBranchTarget
          ? `Using local ${storedBranchTarget} (remote ref resolution failed)`
          : 'Using local HEAD (remote ref resolution failed)');
        startSha = await localStartSha();
      } else if (storedBranchTarget) {
        throw new RpcError(500, unresolvableTargetMessage(storedBranchTarget, t));
      } else {
        throw new RpcError(500, `Failed to resolve upstream ref. Use --force-local to start from local HEAD.`);
      }
    } catch (err) {
      if (err instanceof RpcError) throw err;
      if (params.forceLocal) {
        warnings.push(`Failed to fetch ${parentBranch} (using local ref): ${err instanceof Error ? err.message : err}`);
        startSha = await localStartSha();
      } else if (storedBranchTarget) {
        throw new RpcError(500, unresolvableTargetMessage(
          storedBranchTarget,
          t,
          err instanceof Error ? err.message : String(err),
        ));
      } else {
        throw new RpcError(500, `Failed to fetch ${parentBranch}: ${err instanceof Error ? err.message : err}. Use --force-local to start from local HEAD.`);
      }
    }
  }

  // --- Pinned base (lazy clone --same-base / --base) ---
  // INVARIANT: a pinned task's branch is cut from its pinned commit, never from
  // the parent's current head. The pin is the whole point of a like-for-like
  // re-run; starting it anywhere else makes the comparison meaningless. The
  // parent branch is still resolved above: it is where accept merges to.
  // A refused start's turnless session is a first start that never ran — pin it.
  const pinnedBase = !isLinkedTask && (!existingSession || refusedStartSession) ? pinnedBaseOf(t) : null;
  if (pinnedBase) {
    const pinned = await runGit(['rev-parse', '--verify', '--quiet', `${pinnedBase}^{commit}`], { cwd: projectRoot });
    if (pinned.exitCode !== 0) {
      throw new RpcError(
        409,
        `Task ${displayId(t)} is pinned to ${pinnedBase.substring(0, 12)}, but that commit is no longer in this repository ` +
        `(git pruned it after the branch that held it was deleted). Fetch it from a remote that still has it, ` +
        `or clone the source again without a pinned base.`,
      );
    }
    startSha = pinned.stdout.trim();
    await storage.updateTaskBranchedFromSha(t.id, startSha);
    t.branched_from_sha = startSha;
    phases.note(`Pinned to ${startSha.substring(0, 12)} — the parent is not merged in`);
  }

  phases.end(parentBranch ?? undefined);

  // --- Git LFS environment preflight ---
  // INVARIANT: never launch an agent into an environment where a commit would
  // silently store raw file content on an LFS-tracked path. Git only errors on
  // a broken LFS filter when `filter.lfs.required` is true; with it false the
  // clean filter is skipped and `git add` exits 0 having committed the whole
  // file (see src/git/lfs.ts for the incident this comes from).
  //
  // Runs BEFORE the worktree is created so a refusal leaves nothing behind, and
  // against `projectRoot` at `startSha` — worktrees share the repository's git
  // config, and `lazy_commit` stages host-side in the task worktree, so this is
  // the config that will decide what lands. `git-lfs` is never required to
  // ANSWER the question; only to pass it.
  //
  // The message is deliberately one line plus a doctor referral: `lazy doctor`
  // is the single diagnosis surface and carries the full remedy.
  if (lfsCheckEnabled) {
    phases.begin(START_PHASES.lfs);
    const { inspectLfsEnvironment } = await import('../git/lfs');
    const lfs = await inspectLfsEnvironment(projectRoot, startSha);
    if (lfs.problems.length > 0) {
      const summary =
        `This repository uses git LFS, but ${lfs.problems.map((p) => p.message).join('; and ')}. ` +
        `Commits made here would silently store raw file content instead of LFS pointers, ` +
        `producing a branch that cannot be pushed.`;
      if (config.git.lfs_check === 'warn') {
        warnings.push(`${summary} Run \`lazy doctor\` for details.`);
        phases.end('warn only');
      } else {
        throw new RpcError(
          400,
          `Refusing to start task ${displayId(t)}: ${summary}\n\n` +
          `Run \`lazy doctor\` for details.`,
        );
      }
    } else {
      phases.end();
    }
  }

  phases.begin(START_PHASES.worktree);

  // --- Worktree creation ---
  const worktreeBase = join(projectRoot, getDataDir(projectRoot), 'worktrees');
  const worktreePath = getWorktreePathForRef(projectRoot, tRef);
  await mkdir(worktreeBase, { recursive: true });

  // Check locks
  const worktreeExists = await pathExists(worktreePath);
  if (worktreeExists) {
    const existingLock = await checkLock(worktreePath);
    if (existingLock) {
      throw new RpcError(409, `Task is already locked by another process (PID ${existingLock.pid}, ${existingLock.command}).`);
    }
  }

  let worktreeExisted = worktreeExists;
  if (worktreeExisted) {
    phases.note(`Reusing existing worktree on ${branchName}`);
  } else if (isLinkedTask || existingSession) {
    const recovery = await recoverMissingWorktree(worktreePath, branchName, projectRoot);
    if (recovery.recovered) {
      // Recreating someone's worktree is a side effect they didn't ask for —
      // say so rather than doing it silently.
      warnings.push(`Worktree was missing, recreated from branch ${branchName}.`);
      if (recovery.dirty) {
        warnings.push('Recovered worktree has uncommitted changes.');
      }
      worktreeExisted = true;
    } else {
      throw new RpcError(500, `Branch '${branchName}' no longer exists. Cannot recover worktree.`);
    }
  } else {
    await withSpan('git.worktree.create', {
      'git.branch': branchName,
      'git.start_sha': startSha,
    }, async () => {
      // A pinned clone's branch was cut at clone time to keep its base commit
      // referenced (src/daemon/clone-redo.ts createPinnedBranch) — check it out
      // as it is rather than trying to create it a second time.
      if (pinnedBase) {
        const existing = await runGit(
          ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`],
          { cwd: projectRoot },
        );
        if (existing.exitCode === 0) {
          const added = await runGit(['worktree', 'add', worktreePath, branchName], { cwd: projectRoot });
          if (added.exitCode !== 0) {
            throw new Error(`git worktree add ${branchName} failed: ${added.stderr}`);
          }
          return;
        }
      }
      await createWorktreeFromSha(worktreePath, branchName, startSha, projectRoot);
    });
  }

  // Empty initial commit
  if (!worktreeExisted && !isLinkedTask) {
    const taskCode = t.code ?? shortId(t.id);
    const commitMessage = `Initialize task ${taskCode}: ${t.goal}`;
    const commitResult = await runGit(
      ['commit', '--allow-empty', '-m', commitMessage],
      { cwd: worktreePath },
    );
    if (commitResult.exitCode !== 0) {
      logger.warn(`Failed to create initial empty commit: ${commitResult.stderr}`);
    }
  }

  // Copy untracked files
  if (!worktreeExisted) {
    await copyUntrackedFilesIntoWorktree(projectRoot, worktreePath, config.worktree.include);
  }

  // Acquire lock
  await acquireLock(worktreePath, 'lazy start');

  phases.end(branchName);

  const containerName = runner.runNameForTask(tRef);

  try {
    const sandbox = await withSpan('sandbox.setup', {}, () => setupSandbox(worktreePath, { storage, taskId: t.id }));

    // --- Agent / model / effort resolution ---
    // One rule for every turn type — see resolveTurnLaunchIdentity. For turn 1
    // there is no previous turn to follow, so this resolves the task's stored
    // choice (`lazy create --model`) or the defaults, and pins the result.
    const { model: modelName, effort: effortValue } = await resolveTurnLaunchIdentity({
      storage,
      task: t,
      config,
      modelOverride: params.modelOverride,
      effortOverride: params.effortOverride,
    });
    const modelId = modelName;

    // `low_high` review mode: the whole work turn runs two-phase. The draft
    // effort replaces the task's normal effort ONLY when nobody chose one —
    // `resolveAndPersistLowHighLoop` is handed the resolved effort and decides,
    // because substituting `draft_effort` for an effort someone deliberately set
    // is a silent downgrade of their task.
    const lowHighLoop = await resolveAndPersistLowHighLoop(
      t, params.reviewOverrides, config, storage, effortValue as EffortLevel,
    );
    const turnEffort = lowHighLoop ? lowHighLoop.draftEffort : effortValue;

    // --- Build prompts ---
    // Timestamp taken BEFORE the read: everything created after this instant is
    // by definition not in `existingComments` and must stay undelivered.
    const notesReadAt = Date.now();
    const existingComments = await storage.getTaskComments(t.id);
    const notesCtx = existingComments.length > 0 ? buildNotesContext(existingComments) : undefined;
    // Turn 1 delivers every existing comment, so it ESTABLISHES the delivery
    // high-water mark (recorded once the session exists, below) — always, even
    // with nothing to deliver. A session that never records one falls back to
    // the last-agent-turn cutoff, which is the very bug this replaces: an ask or
    // sync in between would then swallow the first comment ever written.
    const notesDeliveredThrough = existingComments.length > 0
      ? Math.max(notesReadAt, ...existingComments.map(c => c.created_at))
      : notesReadAt;

    // Journal notice for turn 1: with no prior agent turn there is no cutoff, so
    // every existing entry counts as new — the same rule the notes above follow.
    // Count only; entry content is never injected.
    const existingJournal = await storage.getTaskJournal(t.id);
    const journalNotice = buildJournalNotice(existingJournal.length, existingJournal.length, t.code ?? shortId(t.id)) || undefined;

    // Artifacts were written into the worktree by setupSandbox above; this is
    // the pointer telling the agent they are there. Names and sizes only.
    const artifacts = await storage.listTaskArtifacts(t.id);
    const artifactNotice = buildArtifactNotice(artifacts, t.code ?? shortId(t.id)) || undefined;

    // Re-read the task immediately before composing turn 1. `t` was captured by
    // validateTask() at the top of launchTask, and everything since — runner
    // pre-flight, image build, worktree creation, branch publish — can take many
    // seconds. A `lazy edit --prompt` accepted during that window is durably
    // stored (edits are allowed until the task has turns), so launching from the
    // stale snapshot would hand the agent a prompt the human already replaced.
    // INVARIANT (CLAUDE.md, "Never Lose Human Feedback"): the task prompt is
    // human input — the agent must receive the LATEST accepted version.
    const fresh = await storage.getTask(t.id);
    const taskPrompt = fresh?.prompt ?? t.prompt;
    const taskGoal = fresh?.goal ?? t.goal;

    // Type constraints ride the TURN, not the stored prompt — see
    // src/task/type-constraints.ts for why a cluster's rules cannot be baked in
    // at creation. Empty for every type but `cluster`.
    let turnPrompt = typeConstraintsSection(fresh ?? t) + taskPrompt;
    if (isLinkedTask) {
      const linkedParentBranch = t.metadata?.parent_branch ?? await getRemoteDefaultBranch(projectRoot, config.remote.git_remote);
      const preamble = await buildLinkedTaskPreamble(worktreePath, branchName, linkedParentBranch);
      turnPrompt = preamble + '\n---\n\n' + taskPrompt;
    }

    const systemPrompt = buildSystemPrompt(runner.getAgentInstructions(), renderChattinessSnippet(resolveAgentChattiness(config)), await buildMemorySection(storage, 'agent', { warnBytes: config.memory.warn_bytes }), await buildLazyMdSection(worktreePath));
    const fullPrompt = buildPromptWithInstructions(turnPrompt, taskGoal, true, projectRoot, notesCtx, journalNotice, artifactNotice);

    // --- Persist state BEFORE launch (crash-safe) ---
    let sess;
    if (isLinkedTask && existingSession) {
      sess = existingSession;
    } else if (refusedStartSession) {
      sess = refusedStartSession;
    } else {
      sess = await storage.createSession(t.id, t.agent_id, branchName, startSha);
    }

    // Stamp the resolved runner onto the session (monitoring source of truth).
    // For a linked task reusing an existing session, this also bridges the agent
    // session across a runner boundary if the runner changed since it last ran.
    await stampSessionRunner(storage, projectRoot, sess, worktreePath, runner.type);

    // --- Decide whose credential this turn runs on ---
    // After the session exists (the plan records the turn owner on it and binds
    // the credential to its id) but BEFORE the turn is recorded or the task
    // moves to `working`. A refused plan therefore leaves the task in its
    // pre-start status with a turnless session a retried start reuses — never
    // `working` with a turn and no supervisor, which nothing retries and
    // `lazy unblock` refuses (409). Same order as unblock's prepareTurnLaunch.
    // A single-user install gets `daemon-env` and nothing below changes.
    let credentialPlan: TurnCredentialPlan;
    try {
      credentialPlan = await planTurnCredential(projectRoot, { taskId: t.id, sessionId: sess.id, storage });
    } catch (err) {
      if (err instanceof TurnCredentialUnavailableError) throw new RpcError(400, err.message);
      throw err;
    }

    // --- Every fallible launch step runs BEFORE the flip to `working` ---
    // A throw after the flip left the task `working` with a recorded turn and
    // no supervisor: `lazy unblock` answers 409 and a retried start finds an
    // active session. So the forge fetch behind the supervisor's upstream-merge
    // ref, the protocol dir, the wrap-up plan and the MCP config all happen
    // here, where a failure leaves the pre-start status and a turnless session
    // a retried start reuses. After the flip come local store writes, the
    // (non-fatal) publish and the supervisor launch, whose own failure parks
    // the task `interrupted` for auto-resume; a daemon dying mid-launch is
    // caught by the reconciler's "working, no run, no response" path.
    //
    // The upstream-merge ref is what the supervisor's pre-work sync merges:
    // the LIVE remote-tracking ref (e.g. `origin/main`) for a protected target,
    // so it never merges a stale local branch — but the LOCAL branch for an
    // unprotected parent that accept merges into locally and whose agent
    // commits are not on origin. Per CLAUDE.md "fail hard on remote failures —
    // no silent fallbacks": a fetch failure here must be visible, never
    // swallowed. With `--force-local` the caller has opted into local HEAD, so
    // degrade to the local branch name but still surface a warning.
    phases.begin(START_PHASES.upstreamRef);
    let upstreamMergeRef = parentBranch;
    if (parentBranch) {
      try {
        const resolution = await resolveUpstreamMergeRef(driver, parentBranch, worktreePath, {
          remoteName: config.remote.git_remote,
        });
        warnings.push(...resolution.warnings);
        upstreamMergeRef = resolution.ref;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (params.forceLocal) {
          warnings.push(
            `Failed to resolve upstream ref for ${parentBranch} (using local branch, --force-local): ${detail}`,
          );
        } else {
          throw new RpcError(
            500,
            `Failed to resolve upstream ref for parent branch ${parentBranch}: ${detail}. ` +
              `Refusing to fall back to a stale local ref. Use --force-local to start from the local branch.`,
          );
        }
      }
    }
    if (parentBranch) phases.end(upstreamMergeRef ?? undefined);
    else phases.skip(START_PHASES.upstreamRef, 'no parent branch');

    const protoDir = getProtocolDir(t.id);
    ensureProtocolDir(protoDir);

    const branchConfig = await loadConfig(projectRoot);
    const autoSyncAfterTurn = isFeatureEnabled('auto_sync_after_turn', branchConfig);
    // The wrap-up plan rides every work command: finality is declared DURING
    // the turn, after the command is written, so it cannot be sent later (§3.3).
    const wrapUpFields = await resolveWrapUpCommandFields({
      storage,
      task: t,
      sessionId: sess.id,
      session: sess,
      projectRoot,
      worktreePath,
      config: branchConfig,
      // Turn 1 is recorded after this (below the flip); its actor decides the
      // audience, so hand it over rather than let the creator's actor decide.
      pendingLaunchActor: actorRole(actor),
    });

    // UNDER THE TASK'S LIFECYCLE LOCK, like every other launch path: the
    // member check, the MCP config this turn's container reads, turn 1 and the
    // flip to `working`. A member's entry (src/daemon/member-entry.ts) takes
    // the same lock and refuses a session with no turn yet, so it sees either
    // the turnless session before this block or the `working` task after it.
    let daemonConfigPath: string | null = null;
    await withTaskLifecycleLock(t.id, async () => {
      // No turn starts while a member has a terminal open on the task
      // (./turn-credentials.ts). A first start cannot meet one — entry needs a
      // turn — but a restart of a started task can.
      await refuseLaunchWhileMemberInside(projectRoot, t.id);

      // --- Generate daemon MCP config ---
      // The daemon knows its own webPort — no health check, no fallback.
      // Skip when running outside the daemon (in-process RPC fallback) since
      // there's no daemon for the container to connect to.
      if (runner.usesSandbox() && hasDaemonContext()) {
        daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, { kind: 'task', taskId: t.id });
      }

      await storage.markNotesDelivered(sess.id, notesDeliveredThrough);

      await storage.createTurn({
        sessionId: sess.id,
        sequence: 1,
        role: 'human',
        content: turnPrompt,
        agent: t.agent_id,
        model: modelName,
        effort: turnEffort,
        prompt: fullPrompt,
        actor,
        // INVARIANT: the task prompt is the human's first and most important
        // feedback. If the very first turn crashes before the agent reads it,
        // resume must re-deliver it verbatim rather than say "carry on".
        carriesFeedback: true,
      });

      await storage.updateTaskStatus(t.id, 'working', actor);
    });

    // A fresh START is a fresh child as far as the cluster's fix-round budget
    // is concerned: the count is "how many times has the cluster sent THIS
    // child back since it last started". See src/daemon/cluster-fix-rounds.ts.
    await resetClusterFixRound(storage, t.id);

    // BUG FIX (same class as unblock/resume): only a human taking over clears
    // the turn budget counter; a builder/agent-initiated start increments it.
    if (actorRole(actor) === 'human') {
      try {
        await resetNonHumanTurnCount(storage, t.id);
      } catch {
        // Counter reset is best-effort — task start must proceed even if budget tracking fails
      }
    } else {
      try {
        await incrementNonHumanTurnCount(storage, t.id);
      } catch {
        // Counter increment is best-effort — task start must proceed even if budget tracking fails
      }
    }

    // --- Publish branch ---
    let parentDisplayId: string | null = null;
    if (tParentId) {
      const parentTask = await storage.getTask(tParentId);
      if (parentTask) parentDisplayId = displayId(parentTask);
    }

    if (!isLinkedTask) {
      phases.begin(START_PHASES.publish);
      const mergeTarget = parentBranch ?? await getRemoteDefaultBranch(projectRoot, config.remote.git_remote);
      // Only a top-level task's integration target is a named branch. A child
      // task's target is its parent (kind: 'task') and must not be clobbered —
      // its mergeTarget here is the parent's lazy/ branch, used only to base the
      // published branch, never as the canonical integration target.
      // A stored branch target is the user's explicit `--parent` choice: write
      // only when the slot is empty (or holds a sentinel), never overwrite.
      if (!tParentId && !storedBranchTarget) {
        await storage.updateTaskTarget(t.id, branchTarget(mergeTarget));
      }

      // Publishing at task start pushes the (still empty) branch to the forge
      // before the agent has done anything — the earliest and most visible of
      // the automatic pushes, and the first thing a user who set
      // `<driver>_auto_push = false` notices still happening. Skipping it leaves
      // the task purely local until `lazy submit` or `lazy accept` needs a
      // remote ref, which is exactly what the opt-out asks for.
      if (!autoPushEnabled(config)) {
        logger.debug(`Branch publish skipped: ${autoPushConfigKey(config)} = false`);
      } else {
        try {
          const publishResult = await withSpan('remote.publish_branch', {
            'git.branch': branchName,
            'git.target': mergeTarget,
          }, () => driver.publishBranch({
            branch: branchName,
            targetBranch: mergeTarget,
            task: t,
          }));
          if (publishResult.metadata) {
            for (const [key, value] of Object.entries(publishResult.metadata)) {
              await storage.updateTaskMetadata(t.id, key, value);
            }
          }
        } catch (err) {
          warnings.push(`Failed to publish branch (non-fatal): ${err instanceof Error ? err.message : err}`);
        }
      }
      phases.end();
    } else {
      phases.skip(START_PHASES.publish, 'linked task');
    }

    phases.begin(START_PHASES.launch);

    // Resolved before the flip (see "Every fallible launch step" above). The
    // start result reports it; the publish above used the parent's own name.
    if (parentBranch) parentBranch = upstreamMergeRef;

    const startCommand: StartCommand = {
      type: 'start',
      task_id: t.id,
      goal: t.goal,
      prompt: fullPrompt,
      agent_id: t.agent_id,
      harness,
      system_prompt: systemPrompt,
      model_id: modelId,
      effort: turnEffort,
      parent_branch: parentBranch ?? undefined,
      upstream_merge_ref: parentBranch ?? undefined,
      sync_before_work: false,
      sync_after_work: autoSyncAfterTurn && !isLinkedTaskFn(t),
      ...(lowHighLoop ? { low_high_loop: { review_effort: lowHighLoop.reviewEffort } } : {}),
      ...wrapUpFields,
      ...commonCommandFields(branchConfig),
    };
    writeCommand(protoDir, startCommand);

    // --- Launch supervisor ---
    // A running container's env was fixed when it was created, so a turn whose
    // placeholder must now live in a DIFFERENT env var (its owner's credential
    // kind changed, or a system turn took over from a human) cannot be served by
    // it — the client would emit the wrong request shape and the proxy would
    // refuse with auth_kind_mismatch. Recreate instead. The token VALUE is
    // deliberately stable across turns for exactly this reason: only a KIND
    // change costs a container.
    const mustRecreateForCredential = credentialPlan.mode === 'session' && credentialPlan.kindChanged;
    if (credentialPlan.mode === 'session' && credentialPlan.kindChanged && (await runner.isRunning(containerName))) {
      logger.info(
        `[${tRef}] Recreating container: this turn's credential is a different kind ` +
        `(${credentialPlan.kind}) than the running container was launched with.`,
      );
      await runner.removeRun(containerName);
    }

    const mustRecreateForAgent = mustRecreateForContainerAgent(sess, t.agent_id);
    if (mustRecreateForAgent) {
      logger.info(
        `[${tRef}] Recreating container: agent changed ` +
        `(${sess.container_agent_id} → ${t.agent_id}) — launch env is fixed at create time`,
      );
    }

    if (!mustRecreateForCredential && !mustRecreateForAgent && (await runner.isRunning(containerName))) {
      // Supervisor already running — it will pick up the new command
      phases.note(`reusing running container ${containerName}`);
    } else {
      await removeTaskRun(runner, storage, sess, containerName);

      try {
        await withSpan('docker.launch_supervisor', {
          'lazy.runner': runner.type,
          'lazy.container': containerName,
        }, () => runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined, tRef, t.id, pinnedCustomImage(t), phases.notify));
      } catch (err) {
        await storage.updateTaskStatus(t.id, 'interrupted', getActor());
        if (!worktreeExisted) {
          const { removeWorktree } = await import('../git/operations');
          try {
            await removeWorktree(worktreePath, projectRoot);
          } catch {
            // Best-effort cleanup
          }
        }
        throw new RpcError(500, `Failed to launch supervisor: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Store container name
    await storage.updateSessionContainerName(sess.id, containerName, t.agent_id);
    sess.container_agent_id = t.agent_id;
    await storage.updateSessionInteraction(sess.id, 0);

    phases.end(containerName);

    return {
      sessionId: sess.id,
      containerName,
      worktreePath,
      branchName,
      parentBranch,
      parentDisplayId,
      runnerType: runner.type,
      warnings,
    };
  } finally {
    await removeLock(worktreePath);
  }
}
