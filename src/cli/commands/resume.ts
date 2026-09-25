import { requireLazyRoot, requireStorage, parseFlags, validateModel, resolveTaskOrExit } from '../helpers';
import { shortId, displayId, taskRef } from '../../task/identity';
import { followContainer } from './shared';
import { protocolDir as getProtocolDir } from '../../protocol';

import { queryResumeTask } from '../../daemon/rpc-fallback';
import { VALID_EFFORT_LEVELS, type EffortLevel } from '../../config/types';

import { theme } from '../../render/theme';
import { usagePauseOverrideEligibility } from '../human-terminal';

// Re-export for other modules that import from resume.ts
export { buildSystemPromptForResume, buildResumePrompt } from '../../daemon/task-lifecycle';

export async function commandResume(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'follow', takesValue: false },
    { name: 'model', takesValue: true },
    { name: 'effort', takesValue: true },

  ], 'resume');

  const taskId = parsed.positional[0];
  if (!taskId) {
    resumeUsage();
    process.exit(1);
  }

  // Parse flags
  const follow = parsed.flags.get('follow') === true;

  const modelValue = parsed.flags.get('model') as string | undefined;
  let modelOverride: string | undefined;
  if (modelValue !== undefined) {
    modelOverride = validateModel(modelValue);
  }

  // Parse --effort flag
  let effortOverride: EffortLevel | undefined;
  const effortValue = parsed.flags.get('effort') as string | undefined;
  if (effortValue !== undefined) {
    if (!VALID_EFFORT_LEVELS.includes(effortValue as EffortLevel)) {
      console.error(`Invalid effort '${effortValue}'. Must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`);
      process.exit(1);
    }
    effortOverride = effortValue as EffortLevel;
  }

  const root = requireLazyRoot();

  // --- Delegate to daemon RPC ---
  // Resuming launches a supervisor, which may resolve and build a container
  // image first — narrate those phases instead of sitting silent for minutes.
  const { createPhaseDisplay } = await import('../phase-display');
  const display = createPhaseDisplay();
  try {
    const result = await queryResumeTask({
      taskId,
      modelOverride,
      effortOverride,
      ...(await usagePauseOverrideEligibility()),
    }, display);
    display.close();

    // Print warnings
    for (const w of result.warnings) {
      console.log(w);
    }

    console.log(`\nResumed task ${shortId(taskId)}`);

    // Get display info from storage for output
    const storage = await requireStorage();
    try {
      const task = await resolveTaskOrExit(storage, taskId);
      console.log(`  Goal:      ${task.goal}`);
      console.log(`  ${result.runnerLabel}: ${result.runnerDisplayName}`);

      if (!follow) {
        console.log(`\nTask is working. The agent is running in the background.`);
        console.log(`Check progress with: lazy blocked`);
        console.log(`Or check status with: lazy status ${displayId(task)}`);
      }

      // Follow container output
      if (follow) {
        const protoDir = getProtocolDir(task.id);
        const exitCode = await followContainer(result.containerName, storage, root, result.worktreePath, protoDir);
        await storage.close();
        process.exit(exitCode);
      }
    } finally {
      await storage.close();
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  } finally {
    // Idempotent — the success path closes it before printing the summary.
    display.close();
  }
}

export function resumeUsage(): void {
  console.log(`Usage: lazy resume <task_id> [--model <model>] [--effort <level>] [--follow]

Resume a task with NO new feedback — writes a command for the supervisor and
launches a container if needed. To send guidance instead, use
'lazy unblock <task_id> --message "..."'.

Tasks become 'interrupted' when:
  - The Docker container crashes or is killed
  - The machine goes down while an agent is running
  - Network connectivity is lost during execution

Also resumes a 'blocked' or 'conflict' task exactly as it left off, with no new
context — the agent picks up where its last turn ended. A protected-file
decision still pending does not block a resume: nothing reverts a file, and the
decision is made at 'lazy accept'.

Arguments:
  <task_id>    ID of the task to resume

Options:
  --model <model>    Override model for this session (e.g. opus, sonnet, claude-opus-5)
  --effort <level>   Override Claude Code reasoning effort (low, medium, high, xhigh, max)
  --follow           Wait for the agent to finish, streaming output in real time

Examples:
  lazy resume abc12345
  lazy resume abc1 --model opus
  lazy resume abc1 --follow              # Wait for completion`);
}
