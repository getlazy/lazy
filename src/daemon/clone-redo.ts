/**
 * Clone and redo — the daemon implementations the web (and later CLI/MCP)
 * call so those rules live in one place.
 *
 * The web and the CLI call these; MCP's lazy_clone still opens storage itself.
 * A clone is a fresh backlog sibling. A redo closes the old task and creates
 * a replacement under the same parent, NOT started (the CLI's `--no-start`
 * posture — starting is a separate verb).
 */

import { getOrCreateStorage } from './rpc-handlers';
import { closeTask } from './task-lifecycle';
import { beginWorktreeTeardown } from './member-entry';
import { RpcError } from './rpc-error';
import { loadConfig } from '../config/loader';
import { resolveAgentForNewTaskFromConfig } from '../agent/task-agent';
import { currentPromptOf } from '../task-prompt';
import { parentTaskIdOf } from '../task-target';
import { looksLikeTaskBranch, taskBranchFor } from '../git/branch-prefix';
import { droppedCustomImagePinWarning } from '../docker/worktree-image';
import { deriveTaskRef, displayId, displayIdFor, shortId, validateCode, getWorktreePath, MAX_TASK_CODE_LENGTH } from '../task/identity';
import { agentProfileOrThrow, agentProfilesFor } from '../config/agent-profiles';
import { BASE_PIN_KEY } from '../task/base-pin';
import { escapeRegex } from '../utils/regex';
import { hasUncommittedChanges } from '../git/operations';
import { pathExists } from '../utils/fs';
import { latestWorkAgentTurn } from '../utils/turns';
import { turnText } from '../utils/turn-content';
import { getDiffStat } from '../git/operations';
import { isTerminalStatus } from '../types';
import type { ActorInput, Task } from '../types';
import type { Storage } from '../storage/interface';
import { logger } from '../utils/logger';
import { runGit } from '../utils/git';

export interface CloneTaskParams {
  taskId: string;
  goal?: string;
  prompt?: string;
  code?: string;
  parent?: string;
  /** Make the clone top-level instead of inheriting the source's parent. Exclusive with `parent`. */
  defaultParent?: boolean;
  /** Model for the clone; default is the source's model. Sticky on the clone. */
  model?: string;
  /** Agent profile for the clone; default is the source's agent. Sticky on the clone. */
  agent?: string;
  /**
   * Branch the clone from the commit the SOURCE's first turn started from, and
   * pin it there (see src/task/base-pin.ts). Exclusive with `base`.
   */
  sameBase?: boolean;
  /** Branch the clone from this commit (any rev git resolves) and pin it there. */
  base?: string;
  actor?: ActorInput;
}

export interface CloneTaskResult {
  taskId: string;
  displayId: string;
  /** The source task, as a display id (the caller may have passed a prefix). */
  sourceDisplayId: string;
  imagePinWarning: string | null;
  goal: string;
  code: string | null;
  type: string;
  parentDisplayId: string | null;
  model: string | null;
  agentId: string;
  /** Full SHA the clone is pinned to, or null for an ordinary clone. */
  pinnedBase: string | null;
}

/**
 * The commit a pinned clone branches from, verified to exist.
 *
 * `sameBase` reads the SOURCE session's `git_start_sha`: the commit its branch
 * was cut from at `lazy start`, before the "Initialize task" commit and before
 * any turn ran — so before any pre-turn sync, which is what makes it the code
 * the original's first turn saw. `Turn.start_sha` is per turn and sits after
 * the init commit; `Task.branched_from_sha` is recorded only for subtasks and
 * is rewritten by reopen, so it is the fallback, not the source.
 */
async function resolveCloneBase(
  projectRoot: string,
  storage: Storage,
  source: Task,
  params: Pick<CloneTaskParams, 'sameBase' | 'base'>,
): Promise<string | null> {
  const explicitBase = params.base?.trim();
  if (params.sameBase && explicitBase) {
    throw new RpcError(400, 'Use either --same-base or --base <sha>, not both.');
  }
  if (!params.sameBase && !explicitBase) return null;

  let wanted: string;
  let described: string;
  if (params.sameBase) {
    const session = await storage.getSessionByTaskId(source.id);
    const recorded = session?.git_start_sha || source.branched_from_sha;
    if (!recorded) {
      throw new RpcError(
        409,
        `Task ${displayId(source)} was never started, so it has no starting commit to reuse. ` +
        `Clone it without --same-base, or name a commit with --base <sha>.`,
      );
    }
    wanted = recorded;
    described = `the commit ${displayId(source)} started from (${recorded.substring(0, 12)})`;
  } else {
    if (explicitBase!.startsWith('-')) {
      throw new RpcError(400, `Invalid base '${explicitBase}': a commit or ref cannot start with '-'.`);
    }
    wanted = explicitBase!;
    described = `'${explicitBase}'`;
  }

  const resolved = await runGit(['rev-parse', '--verify', '--quiet', `${wanted}^{commit}`], { cwd: projectRoot });
  if (resolved.exitCode !== 0 || !resolved.stdout.trim()) {
    throw new RpcError(
      409,
      `Cannot clone from ${described}: that commit is not in this repository. ` +
      `It was most likely only reachable from a branch that has since been deleted, and git has pruned it. ` +
      `If a remote still has it, fetch it (git fetch <remote> ${wanted}) and try again; ` +
      `otherwise clone without a pinned base.`,
    );
  }
  return resolved.stdout.trim();
}

/**
 * Cut the pinned clone's own task branch at the pinned commit NOW, at clone
 * time, so the commit is referenced from the moment the clone exists. An old
 * task's start commit can be reachable from nothing else (its branch deleted,
 * accept tags retired), and git may prune an unreferenced object that is
 * already old at the next gc — the gap between `lazy clone` and `lazy start`
 * must not be able to lose it. The launcher checks the branch out as-is.
 *
 * The task ref is derived and stored here exactly as `lazy start` would, so
 * the branch name is the one start will look for. No new ref scheme: this is
 * the task branch the clone would have had anyway.
 */
async function createPinnedBranch(
  projectRoot: string,
  storage: Storage,
  task: Task,
  sha: string,
): Promise<void> {
  const ref = deriveTaskRef(task, await storage.listTasks());
  await storage.updateTaskMetadata(task.id, 'task_ref', ref);
  if (!task.metadata) task.metadata = {};
  task.metadata.task_ref = ref;
  const branch = taskBranchFor(ref);
  const created = await runGit(['branch', branch, sha], { cwd: projectRoot });
  if (created.exitCode !== 0) {
    throw new RpcError(
      500,
      `Created ${displayId(task)} but could not create its branch ${branch} at ${sha.substring(0, 12)}: ` +
      `${created.stderr || 'unknown error'}. The pin is recorded; \`lazy start ${displayId(task)}\` will retry from the commit.`,
    );
  }
}

export interface RedoTaskParams {
  taskId: string;
  reason: string;
  actor?: ActorInput;
}

export interface RedoTaskResult {
  oldTaskId: string;
  oldDisplayId: string;
  taskId: string;
  displayId: string;
  imagePinWarning: string | null;
}

async function nextSuffixedCode(
  oldCode: string,
  suffixKind: 'clone' | 'redo',
  storage: Storage,
): Promise<string> {
  const existing = oldCode.match(new RegExp(`^(.+)-${suffixKind}-(\\d+)$`));
  const base = existing ? existing[1] : oldCode;
  const all = await storage.listTasks();
  let maxN = 0;
  const pattern = new RegExp(`^${escapeRegex(base)}-${suffixKind}-(\\d+)$`);
  for (const task of all) {
    if (!task.code) continue;
    const match = task.code.match(pattern);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > maxN) maxN = n;
    }
  }
  const suffix = `-${suffixKind}-${maxN + 1}`;
  const maxBase = MAX_TASK_CODE_LENGTH - suffix.length;
  let finalBase = base.length > maxBase ? base.substring(0, maxBase).replace(/-$/, '') : base;
  const code = finalBase + suffix;
  return validateCode(code) === null ? code : '';
}

export async function cloneTask(
  projectRoot: string,
  params: CloneTaskParams,
): Promise<CloneTaskResult> {
  const storage = await getOrCreateStorage();
  const resolved = await storage.resolveTask(params.taskId);
  if (!resolved.task) {
    if (resolved.ambiguousMatches?.length) {
      throw new RpcError(409, `Ambiguous task ID '${params.taskId}'. Matches: ${resolved.ambiguousMatches.map((t) => displayId(t)).join(', ')}`);
    }
    throw new RpcError(404, `No task found matching '${params.taskId}'`);
  }
  const source = resolved.task;

  // Default parent is the source's parent — a clone is a sibling, not a child.
  // Passing `parent` is an override; omitting it must not nest under the source.
  const explicitParent = params.parent !== undefined && params.parent.trim() !== '';
  if (params.defaultParent && explicitParent) {
    throw new RpcError(400, 'Cannot use both --parent and --default-parent');
  }
  let newParentTaskId: string | undefined = params.defaultParent ? undefined : (parentTaskIdOf(source) ?? undefined);
  if (explicitParent) {
    const parentResolved = await storage.resolveTask(params.parent!.trim());
    if (!parentResolved.task) {
      throw new RpcError(404, `Parent task not found: ${params.parent}`);
    }
    if (isTerminalStatus(parentResolved.task.status)) {
      throw new RpcError(
        409,
        `Cannot use task ${displayId(parentResolved.task)} as parent: task is ${parentResolved.task.status}`,
      );
    }
    newParentTaskId = parentResolved.task.id;
  }

  if (params.code) {
    const codeError = validateCode(params.code);
    if (codeError) throw new RpcError(400, `Invalid code '${params.code}': ${codeError}`);
  }

  let cloneCode = params.code;
  if (!cloneCode && source.code) {
    cloneCode = await nextSuffixedCode(source.code, 'clone', storage);
  }

  const goal = (params.goal ?? source.goal).trim();
  if (!goal) throw new RpcError(400, 'A clone needs a goal.');

  const [config, projectSettings] = await Promise.all([
    loadConfig(projectRoot),
    storage.getProjectSettings(),
  ]);

  const agentOverride = params.agent?.trim() || undefined;
  if (params.agent !== undefined && !agentOverride) {
    throw new RpcError(400, 'Agent must not be empty.');
  }
  if (agentOverride) {
    try {
      agentProfileOrThrow(agentProfilesFor(config), agentOverride, '--agent');
    } catch (err) {
      throw new RpcError(400, err instanceof Error ? err.message : String(err));
    }
  }

  // Every check that can refuse runs before the task exists.
  const pinnedBase = await resolveCloneBase(projectRoot, storage, source, params);

  const agentId = resolveAgentForNewTaskFromConfig(
    { explicit: agentOverride, inheritFrom: source },
    config.agent,
    projectSettings,
  ).agentId;
  const cloned = await storage.createTask(
    goal,
    newParentTaskId,
    pinnedBase ?? undefined,
    cloneCode || undefined,
    source.type,
    agentId,
    params.actor,
  );

  const prompt = params.prompt !== undefined ? params.prompt : (currentPromptOf(source) ?? '');
  await storage.updateTaskPrompt(cloned.id, prompt);
  // Persisted on the clone, so every turn inherits it (turn-model stickiness).
  // A model id is not portable across agents (see src/daemon/agent-switch.ts):
  // switching agent without naming a model leaves the clone's model UNSET
  // instead of carrying the source's model onto a harness that cannot run it;
  // the first launch resolves the new agent's default through the one launch
  // helper (resolveTurnLaunchIdentity) and persists it.
  const agentSwitched = agentOverride !== undefined && agentOverride !== source.agent_id;
  let model: string | null = params.model?.trim() || null;
  if (!model && !agentSwitched) {
    model = source.model ?? null;
  }
  if (model) {
    await storage.updateTaskModel(cloned.id, model);
  }
  await storage.updateTaskMetadata(cloned.id, 'cloned_from', source.id);
  if (pinnedBase) {
    await storage.updateTaskMetadata(cloned.id, BASE_PIN_KEY, pinnedBase);
    await createPinnedBranch(projectRoot, storage, cloned, pinnedBase);
  }

  return {
    taskId: cloned.id,
    displayId: displayId(cloned),
    sourceDisplayId: displayId(source),
    imagePinWarning: droppedCustomImagePinWarning(source),
    goal: cloned.goal,
    code: cloned.code ?? null,
    type: cloned.type,
    parentDisplayId: newParentTaskId ? await displayIdFor(storage, newParentTaskId) : null,
    model,
    agentId,
    pinnedBase,
  };
}

export async function redoTask(
  projectRoot: string,
  params: RedoTaskParams,
): Promise<RedoTaskResult> {
  const reason = params.reason.trim();
  if (!reason) {
    throw new RpcError(400, 'A reason is required to redo a task.');
  }

  const storage = await getOrCreateStorage();
  const resolved = await storage.resolveTask(params.taskId);
  if (!resolved.task) {
    throw new RpcError(404, `Task not found: ${params.taskId}`);
  }
  const oldTask = resolved.task;

  if (oldTask.status === 'complete') {
    throw new RpcError(409, `Task ${displayId(oldTask)} is already complete (merged). Nothing to redo.`);
  }
  if (oldTask.status === 'abandoned') {
    throw new RpcError(
      409,
      `Task ${displayId(oldTask)} is already closed. Nothing to redo. To work on it again: lazy reopen ${displayId(oldTask)}`,
    );
  }
  if (oldTask.status === 'working' || oldTask.status === 'pairing') {
    throw new RpcError(
      409,
      `Task ${displayId(oldTask)} is ${oldTask.status}. Wait for it to finish or interrupt it before redoing.`,
    );
  }

  // A member working in the old task's files refuses the redo BEFORE the new
  // task is created: the close at the end refuses while they are inside, and
  // a redo that created its replacement first left a stray duplicate behind.
  // Claiming the worktree also keeps members out until the close has run.
  const releaseWorktree = await beginWorktreeTeardown(oldTask.id);
  try {
    return await redoClaimedTask(projectRoot, params, reason, storage, oldTask);
  } finally {
    releaseWorktree();
  }
}

async function redoClaimedTask(
  projectRoot: string,
  params: RedoTaskParams,
  reason: string,
  storage: Awaited<ReturnType<typeof getOrCreateStorage>>,
  oldTask: Task,
): Promise<RedoTaskResult> {
  const worktreePath = getWorktreePath(projectRoot, oldTask);
  if (await pathExists(worktreePath) && (await hasUncommittedChanges(worktreePath))) {
    throw new RpcError(
      409,
      `Task ${displayId(oldTask)} has uncommitted changes. Commit or stash them before redoing.`,
    );
  }

  const sess = await storage.getSessionByTaskId(oldTask.id);
  let redoContext = '';
  if (sess) {
    const turns = await storage.getSessionTurns(sess.id);
    const lastAgentTurn = latestWorkAgentTurn(turns);
    if (lastAgentTurn) {
      const lastAgentText = turnText(lastAgentTurn);
      const summary = lastAgentText.length > 4000
        ? lastAgentText.substring(0, 4000) + '\n... (truncated)'
        : lastAgentText;
      redoContext += `\n## Previous Attempt Context\n\nThis task is a redo of a previous attempt (${shortId(oldTask.id)}). The previous agent's last response:\n\n${summary}\n`;
    }
    try {
      const diffStat = await getDiffStat(sess.git_start_sha, 'HEAD', worktreePath);
      if (diffStat.trim()) {
        redoContext += `\nFiles changed in previous attempt:\n\`\`\`\n${diffStat}\`\`\`\n`;
      }
    } catch {
      // Worktree may not exist or diff may fail — context is optional.
    }
    if (redoContext) {
      redoContext = '\n' + redoContext + '\nUse this context as a starting point, but work from the current state of the codebase in your worktree.\n';
    }
  }

  const latestPrompt = currentPromptOf(oldTask) ?? '';
  const [config, projectSettings] = await Promise.all([
    loadConfig(projectRoot),
    storage.getProjectSettings(),
  ]);
  const newTask = await storage.createTask(
    oldTask.goal,
    parentTaskIdOf(oldTask) ?? undefined,
    undefined,
    undefined,
    oldTask.type,
    resolveAgentForNewTaskFromConfig(
      { inheritFrom: oldTask },
      config.agent,
      projectSettings,
    ).agentId,
    params.actor,
  );

  await storage.updateTaskPrompt(newTask.id, latestPrompt + redoContext);
  if (oldTask.model) {
    await storage.updateTaskModel(newTask.id, oldTask.model);
  }
  if (oldTask.code) {
    const redoCode = await nextSuffixedCode(oldTask.code, 'redo', storage);
    if (redoCode) {
      try {
        await storage.updateTaskCode(newTask.id, redoCode);
      } catch {
        logger.debug(`Could not set code '${redoCode}' on redo of ${displayId(oldTask)}`);
      }
    }
  }
  await storage.updateTaskMetadata(newTask.id, 'redo_of', oldTask.id);

  // Close the old task through the daemon's own closer so cleanup stays one path.
  await closeTask(projectRoot, {
    taskId: oldTask.id,
    reason: `${reason} (redone as ${displayId(newTask)})`,
    actor: params.actor,
  });

  return {
    oldTaskId: oldTask.id,
    oldDisplayId: displayId(oldTask),
    taskId: newTask.id,
    displayId: displayId(newTask),
    imagePinWarning: droppedCustomImagePinWarning(oldTask),
  };
}

/** Live tasks + local branches for the reparent datalist. Presentation data. */
export async function listReparentTargets(
  projectRoot: string,
  exceptTaskId?: string,
): Promise<{ tasks: Array<{ id: string; code: string | null; goal: string }>; branches: string[] }> {
  const storage = await getOrCreateStorage();
  const all = await storage.listTasks();
  const tasks = all
    .filter((t) => t.id !== exceptTaskId && !isTerminalStatus(t.status))
    .map((t) => ({ id: t.id, code: t.code ?? null, goal: t.goal }));

  const listed = await runGit(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
    { cwd: projectRoot },
  );
  const branches = listed.exitCode === 0
    ? listed.stdout.split('\n').map((b) => b.trim()).filter((b) => b && !looksLikeTaskBranch(b))
    : [];

  return { tasks, branches };
}
