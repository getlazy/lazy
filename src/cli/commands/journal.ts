import { requireStorage, shortId, displayId, formatDate, parseFlags, resolveTaskOrExit } from '../helpers';
import { openEditor, removeRecoveryFile, readStdinIfPiped } from '../editor';
import { sanitizeUserText } from '../../utils/sanitize-text';
import { getActor } from '../../constants';

/**
 * `lazy journal <task>` — read or append to a task's journal.
 *
 * The journal is an append-only, prompt-immune side channel for orchestration
 * metadata, decision rationale, and cross-run memories. Unlike `lazy comment`,
 * a journal entry is NEVER delivered to the agent — so this command deliberately
 * does NOT emit any daemon signal or trigger auto-react. It only persists.
 *
 * Modes:
 *   - `--message "..."`            append inline
 *   - piped stdin                  append from stdin
 *   - `--add` (interactive TTY)    append via $EDITOR
 *   - no input                     read (print all entries) — the safe default
 */
export async function commandJournal(args: string[]): Promise<void> {
  const parsed = parseFlags(args, [
    { name: 'message', aliases: ['m'], takesValue: true },
    { name: 'add', takesValue: false },
  ], 'journal');

  const taskId = parsed.positional[0];
  if (!taskId) {
    journalUsage();
    process.exit(1);
  }

  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskId);

    const messageValue = parsed.flags.get('message') as string | undefined;
    const addFlag = parsed.flags.get('add') === true;

    // Determine append content from --message > piped stdin. We only consult
    // stdin when it is actually piped, so the default interactive invocation
    // (a bare `lazy journal <task>`) falls through to read mode.
    let content: string | null = null;
    let recoveryPath: string | null = null;

    if (messageValue !== undefined) {
      content = messageValue;
    } else {
      const stdinContent = await readStdinIfPiped();
      if (stdinContent !== null) {
        content = stdinContent;
      } else if (addFlag) {
        // Interactive append via $EDITOR (requires TTY).
        if (!process.stdin.isTTY) {
          console.error('Interactive mode requires a TTY. Use --message flag or pipe via stdin.');
          process.exit(1);
        }
        console.log('Opening editor for journal entry...');
        const editResult = await openEditor('', `journal-${shortId(task.id)}`);
        if (editResult === null) {
          console.log('Editor cancelled.');
          return;
        }
        const { content: edited, recoveryPath: rp } = editResult;
        if (!edited.trim()) {
          if (rp) removeRecoveryFile(rp);
          console.log('Empty journal entry. Cancelled.');
          return;
        }
        content = edited.trim();
        recoveryPath = rp;
      }
    }

    // No append input → read mode.
    if (content === null) {
      const entries = await storage.getTaskJournal(task.id);
      if (entries.length === 0) {
        console.log(`No journal entries for task ${displayId(task)}.`);
        return;
      }
      console.log(`Journal for task ${displayId(task)} (${entries.length}):\n`);
      for (const entry of entries) {
        const who = entry.actor ? ` (${entry.actor})` : '';
        console.log(`[${formatDate(entry.created_at)}]${who}`);
        for (const line of entry.content.split('\n')) {
          console.log(`  ${line}`);
        }
        console.log('');
      }
      return;
    }

    if (!content.trim()) {
      if (recoveryPath) removeRecoveryFile(recoveryPath);
      console.error('Empty journal entry.');
      process.exit(1);
    }

    // INTAKE BOUNDARY: journal entries are never injected into a prompt, but a
    // raw NUL from a file/editor/pipe would still land in the store and corrupt
    // every read surface. Escape at the door like every other text intake.
    const entry = await storage.appendJournalEntry(task.id, sanitizeUserText(content).trim(), getActor());
    // Entry is now durably persisted — clean up recovery file. No signal is
    // emitted: journal entries are orchestration metadata, not agent guidance.
    if (recoveryPath) removeRecoveryFile(recoveryPath);

    console.log(`Added journal entry to task ${displayId(task)}`);
    console.log(`  Entry ID: ${shortId(entry.id)}`);
    console.log(`  Created: ${entry.created_at}`);
  } finally {
    await storage.close();
  }
}

export function journalUsage(): void {
  console.log(`Usage: lazy journal <task_id> [-m|--message "..."] [--add]

Read or append to a task's journal — an append-only, prompt-immune side channel.

Arguments:
  <task_id>    ID of the task (can be shortened)

Options:
  -m, --message "..."   Append this text as a journal entry
  --add                 Append a journal entry via \$EDITOR (interactive)

With no input, prints all journal entries (read mode).
Append input priority: --message flag > piped stdin > --add (\$EDITOR).

The journal is for orchestration metadata and memories that should NOT reach
the agent's prompt — decisions and their rationale, things deferred for later,
cross-run notes. Unlike comments, journal entries are never delivered to the
agent as guidance; they are for the human and for future runs.

Examples:
  lazy journal abc12345                                   # Read entries
  lazy journal abc1 --message "Blocked on upstream X landing"
  lazy journal abc1 --add                                 # Opens \$EDITOR
  echo "Stubbed retry logic, revisit" | lazy journal abc1 # Piped stdin`);
}
