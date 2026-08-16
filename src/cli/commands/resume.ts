import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, validateModel, resolveTaskOrExit, taskRef } from '../helpers';
import { followContainer } from './shared';
import { protocolDir as getProtocolDir } from '../../protocol';

import { queryResumeTask } from '../../daemon/rpc-fallback';
import { VALID_EFFORT_LEVELS, type EffortLevel } from '../../config/types';

import { theme } from '../theme';

// Re-export for other modules that import from resume.ts
export { buildSystemPromptForResume, buildResumePrompt } from '../../daemon/task-lifecycle';

export async function commandResume(args: string[]): Promise<void> {
  // This used to announce itself as deprecated in favour of a messageless
  // `lazy unblock` — a call that cannot succeed: unblock rejects empty
  // feedback ("Empty feedback.") and refuses to run with none at all ("No
  // feedback provided."). Nothing else expresses a no-feedback resume, so the
  // command is not deprecated; the notice just points at the right tool for
  // the OTHER case. Same wording as lazy_resume's MCP description, on purpose.
  console.error(`[note] 'lazy resume' resumes a task with NO new feedback. To send guidance instead, use 'lazy unblock <task> --message "..."' — unblock requires non-empty feedback, so it cannot express a no-feedback resume.`);

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
  try {
    const result = await queryResumeTask({
      taskId,
      modelOverride,
      effortOverride,
    });

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
  }
}

export function resumeUsage(): void {
  console.log(`Usage: lazy resume <task_id> [--model <model>] [--effort <level>] [--follow]

Resume an interrupted task. Writes a command for the supervisor and launches
a container if needed.

Tasks become 'interrupted' when:
  - The Docker container crashes or is killed
  - The machine goes down while an agent is running
  - Network connectivity is lost during execution

The agent receives a special prompt telling it to review the branch state
and continue working towards the goal.

Arguments:
  <task_id>    ID of the interrupted task to resume

Options:
  --model <model>    Override model for this session (e.g. opus, sonnet, claude-opus-4-8)
  --effort <level>   Override Claude Code reasoning effort (low, medium, high, xhigh, max)
  --follow           Wait for the agent to finish, streaming output in real time

Examples:
  lazy resume abc12345
  lazy resume abc1 --model opus
  lazy resume abc1 --follow              # Wait for completion`);
}
