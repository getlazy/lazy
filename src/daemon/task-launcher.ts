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
import { mkdir, writeFile } from 'fs/promises';
import { pathExists } from '../utils/fs';
import { setupSandbox } from '../utils/sandbox';
import { loadConfig } from '../config/loader';
import { createRunner } from '../runner';
import { createDriver } from '../remote';
import { getOrCreateStorage } from './rpc-handlers';
import { getDaemonContext, hasDaemonContext } from './context';
import { getCurrentSha, getRemoteDefaultBranch, createWorktreeFromSha, recoverMissingWorktree, copyUntrackedFilesIntoWorktree } from '../git/operations';
import { checkLock, acquireLock, removeLock } from '../utils/lock';
import { protocolDir as getProtocolDir, writeCommand, ensureProtocolDir, commonCommandFields } from '../protocol';
import { shortId, displayId, taskRef, deriveTaskRef, getWorktreePath, getWorktreePathForRef, getBranchNameFromId } from '../cli/helpers';
import { buildNotesContext, buildSystemPrompt } from '../cli/commands/shared';
import { checkOrphanedChild, retargetOrphanedChild } from '../cli/orphan';
import { parentTaskIdOf, branchTarget } from '../task-target';
import { getAgent, listAgents } from '../agent/registry';
import { getDataDir } from '../cli/init';
import { isFeatureEnabled } from '../utils/features';
import { logger } from '../utils/logger';
import { getActor } from '../constants';
import { runGit } from '../utils/git';
import { RpcError } from './rpc-handlers';
import { isOfflineMode } from '../utils/offline';
import { resolveAndPersistEffort } from './effort';
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
 * The daemon knows its own webPort and token — no health check or fallback
 * needed. This is the key advantage of daemon-owned launch: the MCP config
 * is always correct because the daemon IS the server.
 */
export async function writeDaemonMcpConfig(projectRoot: string, containerName: string, dataDir: string): Promise<string> {
  const { webPort, token } = getDaemonContext();

  const tmpDir = join(projectRoot, dataDir, 'tmp');
  await mkdir(tmpDir, { recursive: true });
  const configPath = join(tmpDir, `daemon-mcp-${containerName}.json`);

  const config = {
    token,
    projectRoot,
    taskId: '', // Template — filled per-task by mcpServerConfig()
    target: `http://host.docker.internal:${webPort}`,
  };
  await writeFile(configPath, JSON.stringify(config, null, 2));

  return configPath;
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

  // Check parent worktree exists for child tasks
  const tParentId = parentTaskIdOf(t);
  if (tParentId) {
    const parentTask = await storage.getTask(tParentId);
    if (!parentTask) {
      throw new RpcError(400, `Parent task not found: ${tParentId}`);
    }
    const parentWorktreePath = getWorktreePath(root, parentTask);
    if (!await pathExists(parentWorktreePath)) {
      throw new RpcError(400, `Cannot start child task: parent task has no worktree. Start the parent first with: lazy start ${displayId(parentTask)}`);
    }
  }

  // Handle orphaned child (parent accepted, branch gone).
  // CLI prompts the user and passes retargetOrphan=true if confirmed.
  // Daemon only retargets when explicitly told to.
  if (tParentId && retargetOrphan) {
    const orphanStatus = await checkOrphanedChild(t, storage, root);
    if (orphanStatus.isOrphaned && orphanStatus.retargetBranch) {
      await retargetOrphanedChild(t, storage, orphanStatus.retargetBranch);
      // Refresh task
      t = (await storage.getTask(t.id))!;
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

  // --- Validate task ---
  let t = await validateTask(storage, params.taskId, projectRoot, params.agentId, params.retargetOrphan);

  // Apply agent override
  if (params.agentId) {
    t = { ...t, agent_id: params.agentId };
  }

  // --- Runner pre-flight ---
  const runner = await createRunner(projectRoot);

  // Validate runner/agent compatibility
  if (t.agent_id !== 'claude-code' && runner.type !== 'dangerously-host-process-without-any-isolation') {
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
  runner.checkAvailability();

  const config = await loadConfig(projectRoot);

  // --- Offline mode: auto-enable forceLocal and use local driver ---
  const offline = await isOfflineMode(join(projectRoot, '.lazy'));
  if (offline) {
    params.forceLocal = true;
    if (config.remote.driver === 'gitlab' || config.remote.driver === 'github') {
      warnings.push(
        'Note: lazy is in offline mode. Accepts will not create ' +
        `${config.remote.driver === 'gitlab' ? 'MRs' : 'PRs'}, and remote sync will be ` +
        'skipped. Run `lazy system online` to restore remote operations.',
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
      const parentRef = await driver.resolveUpstreamRef(parentBranch, projectRoot);
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
    // Top-level task with no stored target. Default to the repo's configured
    // integration branch (origin/HEAD → main fallback), NOT the user's currently
    // checked-out branch. Adopting whatever the user happens to be on at start
    // time produced bad PRs targeting dead release branches. Explicit override:
    // pass --parent at create-time (or use lazy reparent post-creation).
    parentBranch = await getRemoteDefaultBranch(projectRoot, config.remote.git_remote);

    try {
      const parentRef = await driver.resolveUpstreamRef(parentBranch, projectRoot);
      const resolveResult = await runGit(['rev-parse', parentRef], { cwd: projectRoot });
      if (resolveResult.exitCode === 0) {
        startSha = resolveResult.stdout;
      } else if (params.forceLocal) {
        warnings.push('Using local HEAD (remote ref resolution failed)');
        startSha = await getCurrentSha(projectRoot);
      } else {
        throw new RpcError(500, `Failed to resolve upstream ref. Use --force-local to start from local HEAD.`);
      }
    } catch (err) {
      if (err instanceof RpcError) throw err;
      if (params.forceLocal) {
        warnings.push(`Failed to fetch ${parentBranch} (using local HEAD): ${err instanceof Error ? err.message : err}`);
        startSha = await getCurrentSha(projectRoot);
      } else {
        throw new RpcError(500, `Failed to fetch ${parentBranch}: ${err instanceof Error ? err.message : err}. Use --force-local to start from local HEAD.`);
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
      worktreeExisted = true;
    } else {
      throw new RpcError(500, `Branch '${branchName}' no longer exists. Cannot recover worktree.`);
    }
  } else {
    await createWorktreeFromSha(worktreePath, branchName, startSha, projectRoot);
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
    const sandbox = await setupSandbox(worktreePath);

    // --- Model resolution ---
    // When Ollama is enabled for Claude Code, always use the Ollama model — task/sticky
    // model names (e.g. "claude-opus-4-8") don't exist in Ollama's model registry.
    const modelName = (config.ollama.enabled && config.ollama.model && t.agent_id === 'claude-code')
      ? config.ollama.model
      : (params.modelOverride ?? t.model ?? config.models.default);
    const modelId = modelName;

    if (!t.model) {
      await storage.updateTaskModel(t.id, modelName);
    }

    const effortValue = await resolveAndPersistEffort(t, params.effortOverride, config.agent.effort, storage);

    // --- Build prompts ---
    const existingComments = await storage.getTaskComments(t.id);
    const notesCtx = existingComments.length > 0 ? buildNotesContext(existingComments) : undefined;

    let turnPrompt = t.prompt;
    if (isLinkedTask) {
      const linkedParentBranch = t.metadata?.parent_branch ?? await getRemoteDefaultBranch(projectRoot, config.remote.git_remote);
      const preamble = await buildLinkedTaskPreamble(worktreePath, branchName, linkedParentBranch);
      turnPrompt = preamble + '\n---\n\n' + t.prompt;
    }

    const systemPrompt = buildSystemPrompt(runner.getAgentInstructions());
    const fullPrompt = buildPromptWithInstructions(turnPrompt, t.goal, true, projectRoot, notesCtx);

    // --- Persist state BEFORE launch (crash-safe) ---
    let sess;
    if (isLinkedTask && existingSession) {
      sess = existingSession;
    } else {
      sess = await storage.createSession(t.id, t.agent_id, branchName, startSha);
    }

    await storage.createTurn({
      sessionId: sess.id,
      sequence: 1,
      role: 'human',
      content: turnPrompt,
      model: modelName,
      prompt: fullPrompt,
      actor: getActor(),
    });

    await storage.updateTaskStatus(t.id, 'working', getActor());

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
      if (!tParentId) {
        await storage.updateTaskTarget(t.id, branchTarget(mergeTarget));
      }

      try {
        const publishResult = await driver.publishBranch({
          branch: branchName,
          targetBranch: mergeTarget,
          task: t,
        });
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
      try {
        parentBranch = await driver.resolveUpstreamRef(parentBranch, worktreePath);
      } catch {
        // Resolution failed — use the local branch name
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
      daemonConfigPath = await writeDaemonMcpConfig(projectRoot, containerName, config.data.path);
    }

    // --- Launch supervisor ---
    if (runner.isRunning(containerName)) {
      // Supervisor already running — it will pick up the new command
    } else {
      runner.removeRun(containerName);

      try {
        await runner.launchSupervisor(sandbox, containerName, protoDir, false, daemonConfigPath ?? undefined);
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
}
