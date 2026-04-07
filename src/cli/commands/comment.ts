import { requireStorage, requireLazyRoot, shortId, displayId, parseFlags, resolveTaskOrExit } from '../helpers';
import { openEditor, removeRecoveryFile, readStdinIfPiped } from '../editor';
import { getActor } from '../../constants';
import { emitSignal, initSignalDb } from '../../daemon/signals';

export async function commandComment(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'message', takesValue: true },
  ], 'comment');

  const taskId = parsed.positional[0];
  if (!taskId) {
    commentUsage();
    process.exit(1);
  }

  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskId);

    // Get comment content from --message or $EDITOR
    let content: string;
    let commentRecoveryPath: string | null = null;
    const messageValue = parsed.flags.get('message') as string | undefined;
    if (messageValue !== undefined) {
      content = messageValue;
    } else {
      // Try piped stdin before falling back to $EDITOR
      const stdinContent = await readStdinIfPiped();
      if (stdinContent !== null) {
        content = stdinContent;
      } else {
        // Open editor for comment (requires TTY)
        if (!process.stdin.isTTY) {
          console.error('Interactive mode requires a TTY. Use --message flag or pipe via stdin.');
          process.exit(1);
        }
        console.log('Opening editor for comment...');
        const editResult = await openEditor('', `comment-${shortId(task.id)}`);
        if (editResult === null) {
          console.log('Editor cancelled.');
          return;
        }
        const { content: edited, recoveryPath } = editResult;
        if (!edited.trim()) {
          if (recoveryPath) removeRecoveryFile(recoveryPath);
          console.log('Empty comment. Cancelled.');
          return;
        }
        content = edited.trim();
        commentRecoveryPath = recoveryPath;
      }
    }

    if (!content.trim()) {
      if (commentRecoveryPath) removeRecoveryFile(commentRecoveryPath);
      console.error('Empty comment.');
      process.exit(1);
    }

    const comment = await storage.createComment(task.id, content.trim(), getActor());
    // Comment is now durably persisted — clean up recovery file
    if (commentRecoveryPath) removeRecoveryFile(commentRecoveryPath);

    // Emit a comment signal unconditionally — state checks belong in the
    // delivery/consumption phase, not at emission time. Retry up to 2 attempts
    // and fail loudly so the human knows if signal emission broke.
    const root = requireLazyRoot();
    initSignalDb(root);
    let signalEmitted = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        emitSignal(task.id, {
          type: 'comment',
          summary: content.trim(),
          details: { comment_id: comment.id, actor: getActor(), source: 'local' },
        });
        signalEmitted = true;
        break;
      } catch (err) {
        if (attempt === 2) {
          console.error(`Warning: failed to emit comment signal after 2 attempts: ${err instanceof Error ? err.message : err}`);
          console.error('The comment was saved, but the daemon may not deliver it automatically.');
        }
      }
    }

    console.log(`Added comment to task ${displayId(task)}`);
    console.log(`  Comment ID: ${shortId(comment.id)}`);
    console.log(`  Created: ${comment.created_at}`);
  } finally {
    await storage.close();
  }
}

export function commentUsage(): void {
  console.log(`Usage: lazy comment <task_id> [--message "..."]

Add a freeform comment/annotation to a task.

Arguments:
  <task_id>    ID of the task to annotate (can be shortened)

Options:
  --message "..."   Provide comment text inline instead of opening editor

Input priority: --message flag > piped stdin > $EDITOR (interactive)

Comments are human annotations for context that doesn't fit in turns or prompts:
- "Session was accepted but code was lost due to worktree corruption"
- "Superseded by task f8603ccb"
- "Agent struggled with X, try different approach next time"

Examples:
  lazy comment abc12345 --message "Superseded by task xyz"
  lazy comment abc1                                       # Opens $EDITOR
  echo "My comment" | lazy comment abc1                   # Piped stdin`);
}
