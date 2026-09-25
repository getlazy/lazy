import { parseFlags, validateModel, validateAgentProfileOrExit } from '../helpers';
import { validateCode } from '../../task/identity';
import { theme } from '../../render/theme';

export async function commandClone(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'parent', takesValue: true },
    { name: 'default-parent', takesValue: false },
    { name: 'code', takesValue: true },
    { name: 'model', takesValue: true },
    { name: 'agent', takesValue: true },
    { name: 'same-base', takesValue: false },
    { name: 'base', takesValue: true },
  ], 'clone');

  const taskId = parsed.positional[0];
  if (!taskId) {
    cloneUsage();
    process.exit(1);
  }

  const parentValue = parsed.flags.get('parent') as string | undefined;
  const defaultParent = parsed.flags.get('default-parent') as boolean;
  const codeValue = parsed.flags.get('code') as string | undefined;
  const modelValue = parsed.flags.get('model') as string | undefined;
  const agentValue = parsed.flags.get('agent') as string | undefined;
  const sameBase = parsed.flags.get('same-base') as boolean;
  const baseValue = parsed.flags.get('base') as string | undefined;

  if (parentValue !== undefined && defaultParent) {
    console.error('Error: Cannot use both --parent and --default-parent flags');
    process.exit(1);
  }
  if (sameBase && baseValue !== undefined) {
    console.error('Error: Cannot use both --same-base and --base flags');
    process.exit(1);
  }

  if (codeValue !== undefined) {
    const codeError = validateCode(codeValue);
    if (codeError) {
      console.error(`Invalid code '${codeValue}': ${codeError}`);
      process.exit(1);
    }
  }

  const model = modelValue !== undefined ? validateModel(modelValue) : undefined;
  if (agentValue !== undefined) {
    await validateAgentProfileOrExit(process.cwd(), agentValue);
  }

  // The daemon owns the clone: parent, code, agent and base resolution all
  // live in src/daemon/clone-redo.ts, shared with the dashboard.
  const { queryCloneTask } = await import('../../daemon/rpc-fallback');
  let result: Awaited<ReturnType<typeof queryCloneTask>>;
  try {
    result = await queryCloneTask({
      taskId,
      parent: parentValue,
      defaultParent,
      code: codeValue,
      model,
      agent: agentValue,
      sameBase,
      base: baseValue,
      actor: 'human',
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(`Created task ${theme.taskId(result.displayId)} — clone of ${result.sourceDisplayId}`);
  console.log(`  ${theme.label('Goal:')} ${result.goal}`);
  if (result.code) {
    console.log(`  ${theme.label('Code:')} ${result.code}`);
  }
  if (result.parentDisplayId) {
    console.log(`  ${theme.label('Parent:')} ${result.parentDisplayId}`);
  }
  if (result.model) {
    console.log(`  ${theme.label('Model:')} ${result.model}`);
  }
  if (agentValue !== undefined) {
    console.log(`  ${theme.label('Agent:')} ${result.agentId}`);
  }
  if (result.type !== 'task') {
    console.log(`  ${theme.label('Type:')} ${result.type}`);
  }
  if (result.pinnedBase) {
    console.log(`  ${theme.label('Pinned to:')} ${theme.commitSha(result.pinnedBase.substring(0, 12))} — no upstream is merged in until you run ${theme.command('lazy sync ' + result.displayId)}`);
  }
  if (result.imagePinWarning) {
    console.log(`  ${theme.warning('Warning:')} ${result.imagePinWarning}`);
  }

  console.log(`\nTask is in backlog. Start it with: ${theme.command('lazy start ' + result.displayId)}`);
}

export function cloneUsage(): void {
  console.log(`Usage: lazy clone <task_id> [--parent <task_id> | --default-parent] [--code <code>] [--model <model>]
                  [--agent <profile>] [--same-base | --base <sha>]

Duplicate a task with the same goal, prompt, model, and type. Creates a fresh task
in the backlog with no session history. By default, inherits the source task's parent.

Arguments:
  <task_id>          ID of the task to clone

Options:
  --parent <task_id> Set a new parent for the cloned task
  --default-parent   Use default parent (null, root task) instead of inheriting from source
                     (conflicts with --parent)
  --code <code>      Set a custom code for the cloned task (default: auto-generated)
  --model <model>    Override model for the cloned task (e.g. opus, sonnet, claude-opus-5)
                     Default: inherit from source task — or, with --agent naming a
                     different agent, that agent's default model
  --agent <profile>  Run the clone on another agent profile (e.g. cursor)
                     Default: inherit from source task
  --same-base        Branch from the exact commit the source task started from
                     (not the parent's current head) and PIN the clone there, so a
                     re-run on another agent or model sees the same code. Works on
                     finished tasks. Nothing merges the parent in automatically;
                     an explicit "lazy sync" lifts the pin.
  --base <sha>       Like --same-base, but pinned to a commit you name

What gets carried over:
  - Goal (always)
  - Prompt (latest version)
  - Agent and model (unless --agent / --model override; both stay on the clone.
    --agent alone switches to the new agent's default model, never the source's)
  - Task type (task, fix, spike, etc.)
  - Code (auto-suffixed with -clone-N, or explicit via --code)

What starts fresh:
  - No session, no turns, no commits
  - New git branch from parent's HEAD (or main if no parent) — or from the
    pinned commit with --same-base / --base
  - Status: backlog
  - Container image (root-resolved; warns if source had a per-task pin)
  - Metadata: cloned_from=<source_task_id> recorded

What does NOT carry over:
  - Session history, turns, comments
  - Container state

Examples:
  lazy clone abc123                           # Clone, inheriting source task's parent
  lazy clone abc123 --default-parent          # Clone as root task (no parent)
  lazy clone abc123 --parent def456           # Clone under a specific parent
  lazy clone abc123 --code my-new-code        # Clone with explicit code
  lazy clone abc123 --model opus                         # Clone with different model
  lazy clone fix-auth --parent main-task      # Reparent a task
  lazy clone abc123 --same-base --agent cursor --model gpt-5  # Like-for-like re-run

After cloning:
  lazy start <cloned_task_id>                 # Start working on the clone`);
}
