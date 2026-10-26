import type { Storage } from '../storage';
import { writeCommand, type StartCommand, type UnblockCommand } from '../protocol';
import { environmentReplacedPrefix } from '../task/environment-replaced';

/**
 * A failed in-place start can discover a replacement after the command was
 * published. Refresh only after the old run was removed, before launching its
 * successor: a kept supervisor may already be consuming the original command.
 * The notice remains pending until the caller successfully launches that turn.
 */
export async function refreshEnvironmentReplacedCommand(
  storage: Pick<Storage, 'getTaskMetadata'>,
  protoDir: string,
  command: StartCommand | UnblockCommand,
  previousPrefix: string,
): Promise<string> {
  const prefix = await environmentReplacedPrefix(storage, command.task_id);
  if (prefix === previousPrefix) return prefix;
  if (!command.prompt.startsWith(previousPrefix)) {
    throw new Error(`Cannot refresh the environment replacement notice for task ${command.task_id}: its command no longer starts with the original notice.`);
  }
  command.prompt = prefix + command.prompt.slice(previousPrefix.length);
  writeCommand(protoDir, command);
  return prefix;
}
