/**
 * `lazy start` command — thin CLI client.
 *
 * Handles: flag parsing, task validation, interactive prompts, UI output.
 * Delegates: all launch orchestration to daemon via `queryStartTask` RPC.
 */

import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, displayIdFor, parseFlags, validateModel, resolveTaskOrExit, getWorktreePath } from '../helpers';
import { getRemoteDefaultBranch } from '../../git/operations';
import { promptYesNo, isTTY } from '../editor';
import { followContainer } from './shared';
import { checkOrphanedChild } from '../orphan';
import { protocolDir as getProtocolDir } from '../../protocol';

import { listAgents } from '../../agent/registry';
import { queryStartTask } from '../../daemon/rpc-fallback';
import { VALID_EFFORT_LEVELS, type EffortLevel, type RunnerType, resolveRunnerType, RUNNER_ALIAS_HINT } from '../../config/types';

import { theme } from '../theme';
import { parentTaskIdOf } from '../../task-target';
import { formatMarkdown } from '../../utils/markdown';
import { initTracing, shutdownTracing, withSpan, currentTraceparent } from '../../tracing';


export async function commandStart(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'model', takesValue: true },
    { name: 'agent', takesValue: true },
    { name: 'follow', takesValue: false },
    { name: 'yes', takesValue: false },
    { name: 'force-local', takesValue: false },
    { name: 'effort', takesValue: true },
    { name: 'runner', takesValue: true },

  ], 'start');

  const modelValue = parsed.flags.get('model') as string | undefined;
  const follow = parsed.flags.get('follow') === true;
  const yes = parsed.flags.get('yes') === true;
  const forceLocal = parsed.flags.get('force-local') === true;

  // Determine model override
  let modelOverride: string | undefined;
  if (modelValue !== undefined) {
    modelOverride = validateModel(modelValue);
  }

  // Parse --effort flag (overrides task metadata and config for this session onward)
  let effortOverride: EffortLevel | undefined;
  const effortValue = parsed.flags.get('effort') as string | undefined;
  if (effortValue !== undefined) {
    if (!VALID_EFFORT_LEVELS.includes(effortValue as EffortLevel)) {
      console.error(`Invalid effort '${effortValue}'. Must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
      process.exit(1);
    }
    effortOverride = effortValue as EffortLevel;
  }

  // Parse --runner flag (per-task runner override; persists onto the task)
  let runnerOverride: RunnerType | undefined;
  const runnerValue = parsed.flags.get('runner') as string | undefined;
  if (runnerValue !== undefined) {
    const resolved = resolveRunnerType(runnerValue);
    if (!resolved) {
      console.error(`Invalid runner '${runnerValue}'. Must be one of: ${RUNNER_ALIAS_HINT}`);
      process.exit(1);
    }
    runnerOverride = resolved;
  }

  // Parse --agent flag
  const agentFlag = parsed.flags.get('agent') as string | undefined;
  let agentId: string | undefined;
  if (agentFlag !== undefined) {
    const validAgents = listAgents();
    if (!validAgents.includes(agentFlag)) {
      console.error(`Unknown agent '${agentFlag}'. Available agents: ${validAgents.join(', ')}`);
      process.exit(1);
    }
    agentId = agentFlag;
  }

  // Require task ID
  const taskId = parsed.positional[0];
  if (!taskId) {
    console.error('Error: Task ID is required.');
    console.error('');
    console.error('`lazy start` does not create tasks — it only starts one that already');
    console.error('exists. Creation flags (--goal, --prompt, --code, --type, --parent) live');
    console.error('on `lazy create`, where they are still correctable before an agent runs.');
    console.error('');
    console.error('  lazy create --goal "..." --prompt "..." --code my-task-code');
    console.error('  lazy start my-task-code');
    process.exit(1);
  }

  // --- Lightweight pre-flight checks (TTY-only interactive concerns) ---
  // The daemon does authoritative validation. These checks are to prevent
  // the user from seeing confusing daemon errors when we can give better UX.
  const root = requireLazyRoot();
  let retargetOrphan = false;

  {
    const storage = await requireStorage();
    try {
      const t = await resolveTaskOrExit(storage, taskId);

      if (!t.prompt) {
        console.error(`Task ${displayId(t)} has no prompt. Set one with: lazy edit ${displayId(t)}`);
        process.exit(1);
      }

      // Check for orphaned child (parent accepted, branch gone) and prompt for retarget
      const parentId = parentTaskIdOf(t);
      if (parentId) {
        const parentTask = await storage.getTask(parentId);
        if (!parentTask) {
          console.error(`Parent task not found: ${parentId}`);
          process.exit(1);
        }

        const parentWorktreePath = getWorktreePath(root, parentTask);
        if (!existsSync(parentWorktreePath)) {
          // Check if it's an orphan that can be retargeted
          const orphanStatus = await checkOrphanedChild(t, storage, root);
          if (orphanStatus.isOrphaned && orphanStatus.retargetBranch) {
            console.log(theme.warning(`\nParent task was accepted and its branch deleted.`));
            console.log(`This task needs to be retargeted to ${theme.taskId(orphanStatus.retargetBranch)} before starting.\n`);

            let shouldRetarget: boolean;
            if (isTTY() && !yes) {
              shouldRetarget = await promptYesNo(`Retarget to ${orphanStatus.retargetBranch}?`, true);
            } else {
              shouldRetarget = true;
              if (!isTTY()) {
                console.log(`Automatically retargeting to ${orphanStatus.retargetBranch} (non-interactive mode).`);
              }
            }

            if (!shouldRetarget) {
              console.error('Cannot start without retargeting. The parent branch no longer exists.');
              process.exit(1);
            }

            retargetOrphan = true;
          } else {
            console.error(`Cannot start child task: parent task has no worktree.`);
            console.error(`Start the parent first with: lazy start ${displayId(parentTask)}`);
            process.exit(1);
          }
        }
      }

      // Warn if task has no parent and there are active tasks on other branches
      if (!parentId) {
        const allTasks = await storage.listTasks();
        const activeTasks = allTasks.filter(task => {
          const status = task.status;
          return status === 'working' || status === 'interrupted' || status === 'pairing' || status === 'merging';
        });

        if (activeTasks.length > 0 && !yes) {
          const defaultBranch = await getRemoteDefaultBranch(root);
          console.log(theme.warning(`\nTask '${displayId(t)}' has no parent and will branch from ${defaultBranch}.`));
          console.log(`There are ${activeTasks.length} active task(s) on other branches:`);
          for (const activeTask of activeTasks.slice(0, 5)) {
            console.log(`  - ${displayId(activeTask)}: ${activeTask.goal}`);
          }
          if (activeTasks.length > 5) {
            console.log(`  ... and ${activeTasks.length - 5} more`);
          }
          console.log('');

          if (isTTY()) {
            const confirmed = await promptYesNo('Continue?', true);
            if (!confirmed) {
              console.log('Task not started. To make this a child task, use: lazy create --parent <parent_task_id>');
              process.exit(0);
            }
          }
        }
      }

      // Show task details and ask for confirmation unless --yes was provided
      if (!yes && isTTY()) {
        console.log(`\nTask: ${displayId(t)}`);
        console.log(`Goal: ${t.goal}`);
        console.log(`\nPrompt:`);
        console.log(formatMarkdown(t.prompt).join('\n'));
        console.log('');

        const confirmed = await promptYesNo('Start this task?', false);
        if (!confirmed) {
          console.log(`Task not started. Edit the prompt with: lazy edit ${displayId(t)}`);
          process.exit(0);
        }
      }
    } finally {
      await storage.close();
    }
  }

  // --- Delegate to daemon RPC ---
  // The CLI's `lazy.start` span is the true user-perceived request boundary;
  // its `traceparent` is propagated to the daemon so the daemon's launch spans
  // stitch under it into one trace.
  initTracing('cli', async (spans) => {
    const s = await requireStorage();
    try {
      await s.appendTraceSpans(spans);
    } finally {
      await s.close();
    }
  });
  try {
    const result = await withSpan('lazy.start', {
      'lazy.command': 'start',
      'lazy.task_id': taskId,
    }, () => queryStartTask({
      taskId,
      modelOverride,
      agentId,
      forceLocal,
      retargetOrphan,
      effortOverride,
      runnerOverride,
      traceparent: currentTraceparent() ?? undefined,
    }));
    // Flush the CLI root span before we continue (CLI is short-lived).
    await shutdownTracing();

    // Print warnings
    for (const w of result.warnings) {
      console.log(w);
    }

    // Queued at the concurrency cap — the daemon will launch it automatically
    // when a slot frees up. Not an error: surface it plainly and return.
    if (result.queued) {
      const storage = await requireStorage();
      try {
        const t = await resolveTaskOrExit(storage, taskId);
        console.log(
          theme.warning(
            `\nTask ${displayId(t)} queued (${result.queueRunning}/${result.queueLimit} agents running).`,
          ),
        );
        console.log('It will start automatically when an agent slot frees up (a running task finishes or a blocked one is reviewed).');
        console.log(`  Watch the queue: ${theme.command('lazy active')}`);
        console.log(`  Raise the cap for this daemon session: ${theme.command('lazy daemon config set max_concurrent_agents <N>')}`);
      } finally {
        await storage.close();
      }
      return;
    }

    // Print summary — task is now running asynchronously
    // Need storage briefly for displayIdFor of parent
    const storage = await requireStorage();
    try {
      const t = await resolveTaskOrExit(storage, taskId);
      console.log(theme.success(`\nStarted task ${displayId(t)}`));
      console.log(`  ${theme.label('Goal:')}      ${t.goal}`);
      console.log(`  ${theme.label('Branch:')}    ${result.branchName}`);
      console.log(`  ${theme.label('Worktree:')}  ${result.worktreePath}`);
      console.log(`  ${theme.label('Runner:')}    ${result.containerName}`);
      if (result.parentDisplayId) {
        console.log(`  ${theme.label('Parent:')}    ${theme.taskId(result.parentDisplayId)}`);
      }

      if (!follow) {
        console.log(`\nTask is working. The agent is running in the background.`);
        console.log(`Check progress with: ${theme.command('lazy blocked')}`);
        console.log(`Or check status with: ${theme.command('lazy status ' + displayId(t))}`);
      }

      // Follow container output
      if (follow) {
        const protoDir = getProtocolDir(t.id);
        const exitCode = await followContainer(result.containerName, storage, root, result.worktreePath, protoDir);
        await storage.close();
        process.exit(exitCode);
      }
    } finally {
      await storage.close();
    }
  } catch (err) {
    // Flush any recorded spans (e.g. the failed root span) before exiting.
    await shutdownTracing();
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

export function startUsage(): void {
  console.log(`Usage: lazy start <task_id> [--model <model>] [--agent <agent_id>] [--effort <level>] [--runner <host|docker|container|podman>] [--follow] [--yes] [--force-local]

Start an existing task. The daemon handles worktree creation, agent launch,
and lifecycle management.

This command does NOT create tasks. Creation parameters — goal, prompt, code,
type, parent — belong to 'lazy create', which leaves the task in the backlog
where 'lazy edit' can still correct them. Once an agent is running, none of them
can be changed. Use 'lazy create --code <code> ...' then 'lazy start <code>'.
See public-docs/surface-asymmetries.md (section 9) for why.

Use 'lazy blocked' to check when the agent finishes and needs your input.
Use 'lazy status <task_id>' to check the current state.

Arguments:
  <task_id>          ID of the task to start (short hex prefix or task code)

Options:
  --model <model>    Override model for this session (e.g. opus, sonnet, claude-opus-4-8)
  --agent <agent_id> Agent to use for this task (default: from task or lazy.toml)
  --effort <level>   Override Claude Code reasoning effort (low, medium, high, xhigh, max)
                     Persists on the task so resumes use the same value.
  --runner <type>    Run this task on a specific runner regardless of the global
                     [runner] type: host, docker, container, or podman.
                     Persists on the task; takes effect this turn.
  --follow           Wait for the agent to finish, streaming output in real time
  --yes              Skip confirmation prompts
  --force-local      Start from local HEAD even if remote fetch fails (use with caution)

Model Selection:
  Models are selected in this priority order:
  1. --model flag (session override)
  2. Task's model setting (if set during task creation)
  3. The agent's own default, if it has one (Cursor: "auto" — Cursor picks)
  4. lazy.toml default model
  5. Built-in default (claude-opus-4-8)

Notes:
  - Each task can only have one session (1:1 relationship)
  - If the task already has a session, use 'lazy unblock' instead
  - Tasks automatically fetch the latest remote state before creating worktrees.
    If the remote fetch fails, 'lazy start' will abort unless --force-local is used.
  - In offline mode ('lazy system offline' or offline = "on"), the remote fetch is
    skipped automatically and the task branches from the local parent HEAD.
  - For child tasks, the worktree starts from the parent's branch HEAD (fetched from remote)
  - The human turn is recorded before the container launches, so it's
    crash-safe — if the process dies, the turn is preserved

Examples:
  lazy create --goal "Add auth" --prompt "..." --code add-auth
  lazy start add-auth                       # Start it by its code
  lazy start abc12345                       # ...or by short ID
  lazy start abc12345 --yes                 # Start without confirmation
  lazy start abc1 --model claude-haiku-4-5-20251001  # Start with model override
  lazy start abc1 --follow                  # Wait for completion`);
}
