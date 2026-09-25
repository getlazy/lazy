/**
 * The project's Start services command — where it lives and how it resolves.
 *
 * The Services card's "Start services" button runs this command in a task's
 * shell. A UI sets it at runtime, so it lives in the project's STORE (the
 * project settings record), never in lazy.toml: an edit to lazy.toml is an
 * uncommitted change in somebody's working tree, and a Teams-managed project
 * has no human-owned root checkout to edit at all.
 *
 * lazy.toml's `[serve] start_services_cmd` is a ONE-TIME IMPORT: while the
 * store has no command, the root lazy.toml's value is what resolves, and the
 * daemon copies it into the store at startup. Once the store holds a command,
 * lazy.toml is no longer consulted for it. Clearing the command records that it
 * was cleared, so neither the fallback nor the import brings the lazy.toml
 * value back. Nothing here ever writes lazy.toml.
 *
 * The lazy.toml read is the project ROOT's (`getStartServicesCmd`), never a
 * task worktree copy — a task branch must not choose what a human's button runs.
 */

import type { Storage } from '../storage/interface';
import type { ProjectSettings } from '../storage/types';
import { getStartServicesCmd } from './discovery';
import { startServicesCmdProblem } from './ports';
import { updateProjectSettings } from '../daemon/project-settings';

export class StartServicesCmdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartServicesCmdError';
  }
}

/**
 * Validate a designated command: a non-empty single line after trim. The rule
 * is `startServicesCmdProblem` — the one lazy.toml's `[serve]
 * start_services_cmd` is loaded under — so a value imported from the file and a
 * value typed into a form cannot disagree. Only the wording is this surface's.
 */
export function validateStartServicesCmd(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new StartServicesCmdError(
      `The Start services command must be a string, got ${JSON.stringify(raw)}.`,
    );
  }
  const command = raw.trim();
  const problem = startServicesCmdProblem(command);
  if (problem === 'empty') {
    throw new StartServicesCmdError(
      'The Start services command must not be empty. ' +
      'Give the command that starts your services inside the task environment, e.g. bin/dev.',
    );
  }
  // One command, one line: a newline would run as a multi-line shell script
  // in the task's terminal.
  if (problem === 'multiline') {
    throw new StartServicesCmdError(
      'The Start services command must be a single line. ' +
      'Newlines and other control characters cannot be saved. Paste one command, e.g. bin/dev.',
    );
  }
  return command;
}

function storedCommand(settings: ProjectSettings | null): string {
  const value = settings?.startServicesCmd;
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Persist `raw` as the project's Start services command. Returns the trimmed
 * value that was saved. Every other key in the record is kept as it is —
 * including `updatedAt`/`updatedBy`, which describe the settings FORM (Teams
 * shows them as "Last changed" for the model and agent defaults) and must not
 * move when only this command did.
 */
export async function setStartServicesCmd(storage: Storage, raw: unknown): Promise<string> {
  const command = validateStartServicesCmd(raw);
  await updateProjectSettings(storage, (current) => {
    const { startServicesCmdCleared: _cleared, ...rest } = current ?? {};
    return { ...rest, startServicesCmd: command };
  });
  return command;
}

/**
 * Clear the project's Start services command: no command is offered until
 * somebody designates one again. Recorded as a CLEAR rather than an absent key,
 * so the lazy.toml fallback and the daemon-start import cannot bring an old
 * `[serve] start_services_cmd` back. Like a designation, it leaves the
 * record's other keys (and its updatedAt/updatedBy) alone.
 */
export async function clearStartServicesCmd(storage: Storage): Promise<void> {
  await updateProjectSettings(storage, (current) => {
    const { startServicesCmd: _cmd, ...rest } = current ?? {};
    return { ...rest, startServicesCmdCleared: true };
  });
}

/**
 * The command "Start services" runs: the store's, else (before the one-time
 * import has happened) the project root lazy.toml's. '' when neither sets one.
 */
export async function resolveProjectStartServicesCmd(
  storage: Storage,
  projectRoot: string,
): Promise<string> {
  const settings = await storage.getProjectSettings();
  const stored = storedCommand(settings);
  if (stored) return stored;
  if (settings?.startServicesCmdCleared) return '';
  return getStartServicesCmd(projectRoot);
}

/**
 * Copy the root lazy.toml's `[serve] start_services_cmd` into the store when the
 * store has none. Returns the imported command, or null when nothing was
 * imported (already stored, cleared, or lazy.toml sets none). Idempotent; run at daemon
 * startup so a user's existing setting never silently disappears.
 */
export async function importStartServicesCmdFromConfig(
  storage: Storage,
  projectRoot: string,
): Promise<string | null> {
  const fromToml = await getStartServicesCmd(projectRoot);
  if (!fromToml) return null;
  let imported: string | null = null;
  // Decided inside the serialized update, so a designation racing the import
  // is never overwritten by it. updatedAt/updatedBy are left alone (see
  // setStartServicesCmd).
  await updateProjectSettings(storage, (current) => {
    if (storedCommand(current) || current?.startServicesCmdCleared) return null;
    imported = fromToml;
    return { ...(current ?? {}), startServicesCmd: fromToml };
  });
  return imported;
}
