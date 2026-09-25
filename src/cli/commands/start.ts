/**
 * `lazy start` command — thin CLI client.
 *
 * Handles: flag parsing, task validation, interactive prompts, UI output.
 * Delegates: all launch orchestration to daemon via `queryStartTask` RPC.
 */

import { parseReviewFlags, REVIEW_FLAGS, REVIEW_FLAGS_USAGE } from '../review-flags';
import { TeamsCommandRefusedError } from '../../daemon/client';
import { existsSync } from 'fs';
import { shortId, displayId, displayIdFor, getWorktreePath } from '../../task/identity';
import { requireLazyRoot, requireStorage, parseFlags, validateModel, validateAgentProfileOrExit, resolveTaskOrExit } from '../helpers';
import { getRemoteDefaultBranch } from '../../git/operations';
import { promptYesNo, isTTY } from '../editor';
import { followContainer } from './shared';
import { checkOrphanedChild } from '../../task/orphan';
import { protocolDir as getProtocolDir } from '../../protocol';

import { queryStartTask, queryTaskEnv } from '../../daemon/rpc-fallback';
import { collectTaskEnvVars } from './env';
import { VALID_EFFORT_LEVELS, type EffortLevel, type RunnerType, resolveRunnerType, RUNNER_ALIAS_HINT } from '../../config/types';
import { hostRunnerRemovedMessage, isRemovedHostRunnerInput } from '../../runner/host-runner-gate';

import { theme } from '../../render/theme';
import { createPhaseDisplay } from '../phase-display';
import { parentTaskIdOf } from '../../task-target';
import { formatMarkdown } from '../../utils/markdown';
import { initTracing, shutdownTracing, withSpan, currentTraceparent } from '../../tracing';
import { maybeOfferWorktreeImageForTask } from '../../docker/worktree-image';
import { usagePauseOverrideEligibility } from '../human-terminal';


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
    ...REVIEW_FLAGS,
    // Registered only so the pre-fold spelling gets a message naming its
    // replacement instead of a generic "unknown flag" (rejected below).
    { name: 'low-high-loop', takesValue: true },
    // Registered only so the pre-rename spelling gets a message naming its
    // replacement instead of a generic "unknown flag" (rejected below).
    { name: 'ivan-loop', takesValue: true },
    { name: 'env', takesValue: true, accumulate: true },
    { name: 'env-file', takesValue: true },

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

  // The loop was renamed; the old flag is gone rather than silently aliased, so
  // a script still passing it is told rather than quietly getting a plain turn.
  if (parsed.flags.get('ivan-loop') !== undefined) {
    console.error("--ivan-loop has been renamed. Use --review low-high instead.");
    process.exit(1);
  }

  // The low-high loop stopped being an experiment and became one of three
  // review MODES, so its flag is gone rather than silently aliased: --review
  // takes a mode, and "off" now means NO review at all, which is not what
  // --low-high-loop off meant. Guessing between them would be the wrong
  // direction on a flag that decides how much a task costs to review.
  if (parsed.flags.get('low-high-loop') !== undefined) {
    console.error(
      "--low-high-loop is now --review. Use --review low-high for the same behaviour, " +
      "or --review separate for what --low-high-loop off used to do (a reviewer in its " +
      "own session after the final). --review off means no review at all.",
    );
    process.exit(1);
  }

  // The three --review* flags, each independent: supplying one leaves the
  // other two inherited (task > parent task > project).
  const reviewFlags = parseReviewFlags(parsed.flags);
  if ('error' in reviewFlags) {
    console.error(reviewFlags.error);
    process.exit(1);
  }
  const reviewOverrides = reviewFlags.overrides;

  // Parse --runner flag (per-task runner override; persists onto the task)
  let runnerOverride: RunnerType | undefined;
  const runnerValue = parsed.flags.get('runner') as string | undefined;
  if (runnerValue !== undefined) {
    if (isRemovedHostRunnerInput(runnerValue)) {
      console.error(hostRunnerRemovedMessage('per-task --runner'));
      process.exit(1);
    }
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
    await validateAgentProfileOrExit(process.cwd(), agentFlag);
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

      // CLI TTY only (skipped for --yes / non-TTY): offer to pin this cwd's
      // worktree Dockerfile on the task before the daemon launches.
      await maybeOfferWorktreeImageForTask(root, storage, t.id, { skipPrompt: yes });
    } finally {
      await storage.close();
    }
  }

  // --- Per-task environment variables (--env / --env-file) ---
  // Sugar over `lazy env set`, applied BEFORE the launch RPC so the values are
  // in place when the agent's container/process is created. Deliberately not
  // part of StartTaskParams: a secret must not travel through launch params,
  // task state, or a turn — only through the daemon's own 0600 host file.
  const envSpecs = (parsed.flags.get('env') as string[] | undefined) ?? [];
  const envFileFlag = parsed.flags.get('env-file') as string | undefined;
  if (envSpecs.length > 0 || envFileFlag) {
    try {
      const vars = await collectTaskEnvVars(envSpecs, envFileFlag);
      if (Object.keys(vars).length > 0) {
        const envResult = await queryTaskEnv({ action: 'set', taskId, vars });
        console.log(
          `Set ${envResult.changed?.length ?? 0} task environment variable(s): ${(envResult.changed ?? []).join(', ')}`,
        );
      }
    } catch (err) {
      // Fail before launching: starting the agent without the token it was
      // meant to have produces a confusing failure deep inside the container.
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
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
    } catch (err) {
      // A clone bound to Lazy Teams has no store of its own to keep the CLI's
      // spans in, and Teams does not accept them: the launch's own spans are
      // recorded by the daemon that ran it. Anything else is a real failure.
      // Without this the refused flush at shutdown turned a start that HAD
      // happened into "Error:" and exit 1.
      if (err instanceof TeamsCommandRefusedError || (err instanceof Error && err.cause instanceof TeamsCommandRefusedError)) return;
      throw err;
    } finally {
      await s.close();
    }
  });
  // Only a person at their own terminal may TAKE the one-shot usage-pause
  // override — the builder's shell is the CLI's human channel too.
  const overrideEligibility = await usagePauseOverrideEligibility();
  try {
    const display = createPhaseDisplay();
    let result;
    try {
      result = await withSpan('lazy.start', {
        'lazy.command': 'start',
        'lazy.task_id': taskId,
      }, () => queryStartTask({
        taskId,
        modelOverride,
        agentId,
        forceLocal,
        retargetOrphan,
        effortOverride,
        reviewOverrides,
        runnerOverride,
        // The CLI IS the human channel, and the daemon requires the actor to be
        // named rather than defaulted: the turn this writes decides whether the
        // task's work is written for a person. (A user-kind caller's `userId`
        // is pinned over this by the daemon, never taken from here.)
        actor: 'human',
        ...overrideEligibility,
        traceparent: currentTraceparent() ?? undefined,
      }, display));
    } finally {
      display.close();
    }
    // Flush the CLI root span before we continue (CLI is short-lived).
    await shutdownTracing();

    // Print warnings
    for (const w of result.warnings) {
      console.log(w);
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
  console.log(`Usage: lazy start <task_id> [--model <model>] [--agent <profile>] [--effort <level>] [--review <mode>] [--review-gate <g>] [--review-auto-fix <on|off>] [--runner <docker|container|podman>] [--env KEY=VALUE] [--env-file <path>] [--follow] [--yes] [--force-local]

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
  --model <model>    Override model for this session (e.g. opus, sonnet, claude-opus-5)
  --agent <profile>  Agent profile to run this task with — an [agents.<name>] block in
                     lazy.toml; harness names (claude-code, codex, cursor, pi) are the
                     built-in profiles. Default: from the task or lazy.toml.
  --effort <level>   Override Claude Code reasoning effort (low, medium, high, xhigh, max)
                     Persists on the task so resumes use the same value, and it
                     is respected in low-high review mode: the draft runs at the
                     effort you set, not at [review] draft_effort. A project-wide
                     [agent] effort does not do that — only a choice about this
                     task.
${REVIEW_FLAGS_USAGE}
  --runner <type>    Run this task on a specific runner regardless of the global
                     [runner] type: docker, container, or podman.
                     Persists on the task; takes effect this turn.
  --env KEY=VALUE    Give this task an environment variable (repeatable). A bare
                     --env KEY prompts for the value without echoing it, which
                     keeps a secret out of shell history and the process table.
                     Values live on this host only — never in task state, turns,
                     prompts, or logs — and are deleted when the task ends.
                     Manage them later with 'lazy env'.
  --env-file <path>  Read KEY=VALUE lines for this task from a dotenv-style file
  --follow           Wait for the agent to finish, streaming output in real time
  --yes              Skip confirmation prompts
  --force-local      Start from local HEAD even if remote fetch fails (use with caution)

Model Selection:
  Models are selected in this priority order:
  1. --model flag (session override)
  2. Task's model setting (if set during task creation)
  3. The agent's own default, if it has one (Cursor: "auto" — Cursor picks)
  4. lazy.toml default model
  5. Built-in default (claude-opus-5)

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
