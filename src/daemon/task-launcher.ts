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

import { join } from 'path';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { pathExists } from '../utils/fs';
import { setupSandbox } from '../utils/sandbox';
import { loadConfig } from '../config/loader';
import type { RunnerType } from '../config/types';
import { resolveAgentModel } from '../agent/agent-model';
import { resolveAgentChattiness, renderChattinessSnippet } from '../config/chattiness';
import { createRunner } from '../runner';
import { stampSessionRunner } from '../runner/session-launch';
import { pinnedCustomImage } from '../docker/worktree-image';
import { createDriver, resolveUpstreamMergeRef } from '../remote';
import { getOrCreateStorage } from './rpc-handlers';
import { getDaemonContext, hasDaemonContext } from './context';
import { mintMcpToken, type McpIdentity, type MintMcpTokenOptions } from './mcp-tokens';
import { getMcpConfigDir } from './paths';
import { getCurrentSha, getRemoteDefaultBranch, createWorktreeFromSha, recoverMissingWorktree, copyUntrackedFilesIntoWorktree } from '../git/operations';
import { checkLock, acquireLock, removeLock } from '../utils/lock';
import { protocolDir as getProtocolDir, writeCommand, ensureProtocolDir, commonCommandFields } from '../protocol';
import { shortId, displayId, taskRef, deriveTaskRef, getWorktreePath, getWorktreePathForRef, getBranchNameFromId } from '../cli/helpers';
import { buildNotesContext, buildSystemPrompt } from '../cli/commands/shared';
import { buildMemorySection } from '../memory';
import { checkOrphanedChild, retargetOrphanedChild } from '../cli/orphan';
import { parentTaskIdOf, branchTarget } from '../task-target';
import { getAgent, getAgentPackaging, listAgents } from '../agent/registry';
import { getDataDir } from '../cli/init';
import { isFeatureEnabled } from '../utils/features';
import { logger } from '../utils/logger';
import { getActor } from '../constants';
import { getNonHumanTurnCount, incrementNonHumanTurnCount, resetNonHumanTurnCount, checkTurnBudget } from './turn-budget';
import type { Actor } from '../types';
import { runGit } from '../utils/git';
import { withSpan } from '../tracing';
import { RpcError } from './rpc-handlers';
import { isOfflineMode } from '../utils/offline';
import { resolveAndPersistEffort } from './effort';
import { tryAdmitAgentSlot, releaseAgentSlot, effectiveAgentLimit } from './concurrency';
import type { StartCommand } from '../protocol';
import type { Task, Storage } from '../storage';

import goalContextStartText from '../prompts/goal-context-start.md' with { type: 'text' };
import goalContextContinueText from '../prompts/goal-context-continue.md' with { type: 'text' };

// --- Input/Output types ---

export interface StartTaskParams {
  taskId: string;
  modelOverride?: string;
  agentId?: string;
  forceLocal?: boolean;
  /** CLI has already prompted the user and confirmed orphan retargeting. */
  retargetOrphan?: boolean;
  /** CLI `--effort` override. Persists on the task so resumes see the same value. */
  effortOverride?: string;
  /**
   * Per-task runner override (already resolved to a canonical RunnerType by the
   * CLI/MCP boundary). Highest precedence at launch and PERSISTED onto the task
   * so subsequent turns stay on the chosen runner (avoiding a cross-runner
   * flip-flop). null/undefined → fall back to `task.runner_type ?? global`.
   */
  runnerOverride?: RunnerType;
  /**
   * Who submitted this command, by channel: MCP boundary → 'builder', CLI → 'human'.
   * When absent, falls back to getActor() (env-var / 'human'). Set explicitly by
   * the MCP boundary because the turn is persisted in the daemon process, where
   * the env-var default cannot see the caller's channel. See {@link MCP_ACTOR}.
   */
  actor?: Actor;
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
   * Set when the launch was deferred at the concurrency cap: the task is now in
   * `queued` status and the reconciler will launch it as a slot frees up. When
   * true, the container/session/worktree fields are placeholders (empty/null).
   */
  queued?: boolean;
  /** Agent slots in use at the moment this task was queued (for "N/N running"). */
  queueRunning?: number;
  /** The effective agent cap this task was queued against. */
  queueLimit?: number;
}

// --- Helper functions ---

function buildPromptWithInstructions(userPrompt: string, goal: string, isFirstTurn: boolean, lazyRoot: string, notesContext?: string): string {
  const goalContext = (isFirstTurn ? goalContextStartText : goalContextContinueText)
    .replace(/\{\{goal\}\}/g, goal) + '\n\n';

  const notesSection = notesContext ?? '';
  return goalContext + notesSection + userPrompt;
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
  // into exactly one container, by absolute path.
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

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
  if (agentIdOverride) {
    const validAgents = listAgents();
    if (!validAgents.includes(agentIdOverride)) {
      throw new RpcError(400, `Unknown agent '${agentIdOverride}'. Available agents: ${validAgents.join(', ')}`);
    }
  }

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
  const storage = await getOrCreateStorage();
  const warnings: string[] = [];
  // Channel actor: MCP-originated starts are 'builder'/'agent', CLI 'human'.
  // Falls back to getActor() for CLI (env-var / 'human').
  const actor = params.actor ?? getActor();

  // --- Validate task ---
  let t = await withSpan('start.validate', { 'lazy.task_id': params.taskId }, () =>
    validateTask(storage, params.taskId, projectRoot, params.agentId, params.retargetOrphan),
  );

  // Apply agent override
  if (params.agentId) {
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

  // Validate runner/agent compatibility against the RESOLVED runner. The
  // capability comes from the agent's packaging, not a hardcoded id list.
  if (
    runner.type !== 'dangerously-host-process-without-any-isolation' &&
    !getAgentPackaging(t.agent_id).supportsContainerRunner()
  ) {
    throw new RpcError(400, `Agent "${t.agent_id}" only supports host-process runner. Set runner type to "dangerously-host-process-without-any-isolation" in lazy.toml.`);
  }

  // Set the configured agent on the runner so it uses the correct auth.
  // Without this, HostProcessRunner defaults to the ClaudeCodeAgent singleton
  // which requires ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN even for agents
  // that don't need them (e.g., qa-agent).
  const agent = getAgent(t.agent_id);
  if ('setAgent' in runner && typeof (runner as any).setAgent === 'function') {
    (runner as any).setAgent(agent);
  }
  await runner.checkAvailability();

  const config = await loadConfig(projectRoot);

  // --- Turn budget: cap consecutive turns without a human in the loop ---
  // Builder/agent-initiated starts count; a human start resets the count.
  // Checked before the queue gate so a task that would be refused never even
  // joins the queue — refusing after queueing would still consume a turn once
  // the reconciler drained it.
  if (actor !== 'human') {
    const nonHumanTurnCount = await getNonHumanTurnCount(storage, t.id);
    const budgetDecision = checkTurnBudget(nonHumanTurnCount, config.limits.max_turns_without_human);
    if (!budgetDecision.allowed) {
      throw new RpcError(409, `Task ${displayId(t)}: ${budgetDecision.reason}`);
    }
  }

  // --- Concurrency gate (agent slot) ---
  // A slot is held by each *working* agent task. At the cap, queue instead of
  // launching: mark the task `queued` and let the reconciler drain it when a
  // slot frees (respecting the cap). Re-entrant for an already-working task, so
  // an idempotent relaunch never trips the cap. See src/daemon/concurrency.ts.
  const agentLimit = effectiveAgentLimit(config);
  const slot = await tryAdmitAgentSlot(storage, t.id, agentLimit);
  // Only backlog/queued tasks can transition to `queued`. `lazy start` is a
  // backlog operation; a task that already has a session falls through to the
  // session check below, which returns the proper "already has a session" error
  // rather than an invalid-transition crash.
  const queueEligible = t.status === 'backlog' || t.status === 'queued';
  if (!slot.admitted && queueEligible) {
    // Persist model/effort overrides so the drained relaunch reuses them — the
    // reconciler re-enters launchTask with only the taskId.
    if (params.modelOverride) await storage.updateTaskModel(t.id, params.modelOverride);
    if (params.effortOverride) {
      await resolveAndPersistEffort(t, params.effortOverride, config.agent.effort, storage);
    }
    if (t.status !== 'queued') {
      await storage.updateTaskStatus(t.id, 'queued', actor);
    }
    logger.info(`Task ${displayId(t)} queued (${slot.running}/${slot.limit} agents running)`);
    return {
      queued: true,
      queueRunning: slot.running,
      queueLimit: slot.limit,
      sessionId: '',
      containerName: '',
      worktreePath: '',
      branchName: '',
      parentBranch: null,
      parentDisplayId: null,
      runnerType: runner.type,
      warnings,
    };
  }

  // Slot reserved — release it once the launch settles. Success flips the task
  // to `working` (which keeps the slot counted); any failure frees it. The
  // whole launch body runs inside this try so an early throw can't leak a slot.
  try {

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
  const isLinkedTask = !!t.metadata?.import_source_url;
  const existingSession = await storage.getSessionByTaskId(t.id);
  if (existingSession && !isLinkedTask) {
    if (!existingSession.ended_at) {
      throw new RpcError(409, `Task ${displayId(t)} already has an active session. Unblock it with: lazy unblock ${displayId(t)}`);
    } else {
      throw new RpcError(409, `Task ${displayId(t)} session has ended (${existingSession.outcome}). Create a variant with: lazy branch ${displayId(t)}`);
    }
  }

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
    : `lazy/${tRef}`;

  // --- Determine parent branch and start SHA ---
  const tParentId = parentTaskIdOf(t);
  // Explicit branch target stored at create time (`lazy create --parent release-x`).
  // '' and a stale 'lazy/…' ref are "needs runtime resolution" sentinels, not real
  // targets (see src/task-target.ts) — treat both as absent.
  const storedRawTarget = t.target.kind === 'branch' ? t.target.branch : '';
  const storedBranchTarget = storedRawTarget && !storedRawTarget.startsWith('lazy/')
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
  if (config.git.lfs_check !== 'off') {
    const { inspectLfsEnvironment } = await import('../git/lfs');
    const lfs = await inspectLfsEnvironment(projectRoot, startSha);
    if (lfs.problems.length > 0) {
      const summary =
        `This repository uses git LFS, but ${lfs.problems.map((p) => p.message).join('; and ')}. ` +
        `Commits made here would silently store raw file content instead of LFS pointers, ` +
        `producing a branch that cannot be pushed.`;
      if (config.git.lfs_check === 'warn') {
        warnings.push(`${summary} Run \`lazy doctor\` for details.`);
      } else {
        throw new RpcError(
          400,
          `Refusing to start task ${displayId(t)}: ${summary}\n\n` +
          `Run \`lazy doctor\` for details.`,
        );
      }
    }
  }

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
    // Reusing existing worktree
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
    }, () => createWorktreeFromSha(worktreePath, branchName, startSha, projectRoot));
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

  const containerName = runner.runNameForTask(tRef);

  try {
    const sandbox = await withSpan('sandbox.setup', {}, () => setupSandbox(worktreePath));

    // --- Model resolution ---
    // Per-role model resolution: a local backend (ollama/proxy) forces its
    // authoritative model; otherwise CLI flag > task.model > default.
    const modelName = resolveAgentModel(config, {
      preferredModel: params.modelOverride ?? t.model,
      agentId: t.agent_id,
    });
    const modelId = modelName;

    if (!t.model) {
      await storage.updateTaskModel(t.id, modelName);
    }

    const effortValue = await resolveAndPersistEffort(t, params.effortOverride, config.agent.effort, storage);

    // --- Build prompts ---
    const existingComments = await storage.getTaskComments(t.id);
    const notesCtx = existingComments.length > 0 ? buildNotesContext(existingComments) : undefined;

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

    let turnPrompt = taskPrompt;
    if (isLinkedTask) {
      const linkedParentBranch = t.metadata?.parent_branch ?? await getRemoteDefaultBranch(projectRoot, config.remote.git_remote);
      const preamble = await buildLinkedTaskPreamble(worktreePath, branchName, linkedParentBranch);
      turnPrompt = preamble + '\n---\n\n' + taskPrompt;
    }

    const systemPrompt = buildSystemPrompt(runner.getAgentInstructions(), renderChattinessSnippet(resolveAgentChattiness(config)), await buildMemorySection(storage, 'agent', { warnBytes: config.memory.warn_bytes }));
    const fullPrompt = buildPromptWithInstructions(turnPrompt, taskGoal, true, projectRoot, notesCtx);

    // --- Persist state BEFORE launch (crash-safe) ---
    let sess;
    if (isLinkedTask && existingSession) {
      sess = existingSession;
    } else {
      sess = await storage.createSession(t.id, t.agent_id, branchName, startSha);
    }

    // Stamp the resolved runner onto the session (monitoring source of truth).
    // For a linked task reusing an existing session, this also bridges the agent
    // session across a runner boundary if the runner changed since it last ran.
    await stampSessionRunner(storage, projectRoot, sess, worktreePath, runner.type);

    await storage.createTurn({
      sessionId: sess.id,
      sequence: 1,
      role: 'human',
      content: turnPrompt,
      agent: t.agent_id,
      model: modelName,
      effort: effortValue,
      prompt: fullPrompt,
      actor,
      // INVARIANT: the task prompt is the human's first and most important
      // feedback. If the very first turn crashes before the agent reads it,
      // resume must re-deliver it verbatim rather than say "carry on".
      carriesFeedback: true,
    });

    await storage.updateTaskStatus(t.id, 'working', actor);

    // BUG FIX (same class as unblock/resume): only a human taking over clears
    // the turn budget counter; a builder/agent-initiated start increments it.
    if (actor === 'human') {
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

    // --- Write protocol command ---
    const protoDir = getProtocolDir(t.id);
    ensureProtocolDir(protoDir);

    if (parentBranch) {
      // Resolve to the ref the supervisor's pre-work sync should merge: the
      // LIVE remote-tracking ref (e.g. `origin/main`) for a protected target, so
      // it never merges a stale local branch — but the LOCAL branch for an
      // unprotected parent that accept merges into locally and whose agent
      // commits are not on origin. Per CLAUDE.md "fail hard on remote failures —
      // no silent fallbacks": a fetch failure here must be visible, never
      // swallowed. With `--force-local` the caller has opted into local HEAD, so
      // degrade to the local branch name but still surface a warning.
      try {
        const resolution = await resolveUpstreamMergeRef(driver, parentBranch, worktreePath, {
          remoteName: config.remote.git_remote,
        });
        warnings.push(...resolution.warnings);
        parentBranch = resolution.ref;
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

    const branchConfig = await loadConfig(projectRoot, { cwd: worktreePath });
    const autoSyncAfterTurn = isFeatureEnabled('auto_sync_after_turn', branchConfig);

    const startCommand: StartCommand = {
      type: 'start',
      task_id: t.id,
      goal: t.goal,
      prompt: fullPrompt,
      agent_id: t.agent_id,
      system_prompt: systemPrompt,
      model_id: modelId,
      effort: effortValue,
      parent_branch: parentBranch ?? undefined,
      sync_before_work: false,
      sync_after_work: autoSyncAfterTurn,
      ...commonCommandFields(branchConfig),
    };
    writeCommand(protoDir, startCommand);

    // --- Generate daemon MCP config ---
    // The daemon knows its own webPort — no health check, no fallback.
    // Skip when running outside the daemon (in-process RPC fallback) since
    // there's no daemon for the container to connect to.
    let daemonConfigPath: string | null = null;
    if (runner.usesSandbox() && hasDaemonContext()) {
      daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, { kind: 'task', taskId: t.id });
    }

    // --- Launch supervisor ---
    if (await runner.isRunning(containerName)) {
      // Supervisor already running — it will pick up the new command
    } else {
      await runner.removeRun(containerName);

      try {
        await withSpan('docker.launch_supervisor', {
          'lazy.runner': runner.type,
          'lazy.container': containerName,
        }, () => runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined, tRef, pinnedCustomImage(t)));
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
    await storage.updateSessionContainerName(sess.id, containerName);
    await storage.updateSessionInteraction(sess.id, 0);

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

  } finally {
    releaseAgentSlot(t.id);
  }
}
