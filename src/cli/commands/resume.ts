import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, validateModel, resolveTaskOrExit, taskRef } from '../helpers';
import { followContainer } from './shared';
import { protocolDir as getProtocolDir } from '../../protocol';

import { queryResumeTask } from '../../daemon/rpc-fallback';

import { theme } from '../theme';

// Re-export for other modules that import from resume.ts
export { buildSystemPromptForResume, buildResumePrompt } from '../../daemon/task-lifecycle';

export async function commandResume(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'follow', takesValue: false },
    { name: 'model', takesValue: true },

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

  const root = requireLazyRoot();

  // --- Delegate to daemon RPC ---
  try {
    const result = await queryResumeTask({
      taskId,
      modelOverride,
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
  console.log(`Usage: lazy resume <task_id> [--model <model>] [--follow]

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
  --model <model>    Override model for this session (raw model ID, e.g. claude-sonnet-4-5-20250929)
  --follow           Wait for the agent to finish, streaming output in real time

Examples:
  lazy resume abc12345
  lazy resume abc1 --model claude-opus-4-6
  lazy resume abc1 --follow              # Wait for completion`);
}
