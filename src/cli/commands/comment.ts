import { requireStorage, parseFlags, resolveTaskOrExit } from '../helpers';
import { shortId, displayId } from '../../task/identity';
import { openEditor, removeRecoveryFile, readStdinIfPiped } from '../editor';
import { getActor } from '../../constants';
import { requireActorIdentity } from '../identity-preflight';
import { sanitizeUserText } from '../../utils/sanitize-text';
import { editComment } from '../../daemon/rpc-fallback';
import { findComment, isCommentSeen, CommentAlreadySeenError } from '../../task/comment-edit';

export async function commandComment(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'message', aliases: ['m'], takesValue: true },
    { name: 'edit', takesValue: true },
  ], 'comment');
  const editId = parsed.flags.get('edit') as string | undefined;

  const taskId = parsed.positional[0];
  if (!taskId) {
    commentUsage();
    process.exit(1);
  }

  const storage = await requireStorage();
  try {
    const task = await resolveTaskOrExit(storage, taskId);

    // Before the editor, never after: a comment the daemon will refuse to
    // attribute must not cost the human the text they typed.
    await requireActorIdentity();

    // PRE-FLIGHT before any input is collected: never let a human type an
    // edit the daemon is certain to refuse. The daemon re-checks at write time.
    let editing: Awaited<ReturnType<typeof findComment>> | undefined;
    if (editId) {
      try {
        editing = await findComment(storage, task.id, editId);
        if (await isCommentSeen(storage, task.id, editing)) throw new CommentAlreadySeenError(editing.id);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }

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
        const initial = editing?.content ?? '';
        const editResult = await openEditor(initial, `comment-${shortId(task.id)}`);
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

    // INTAKE BOUNDARY: comments are delivered to the agent as prompt text,
    // which becomes argv of `claude -p`. Escape control characters here so a
    // NUL from a file/editor/pipe can never reach the spawn seam.
    content = sanitizeUserText(content);

    if (editId) {
      // The daemon decides whether this comment may still change: only while
      // the agent has not been shown it. A refusal says why.
      try {
        const { comment } = await editComment({ taskId: task.id, commentId: editing!.id, content: content.trim(), actor: getActor() });
        if (commentRecoveryPath) removeRecoveryFile(commentRecoveryPath);
        console.log(`Edited comment ${shortId(comment.id)} on task ${displayId(task)}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        if (commentRecoveryPath) console.error(`Your text is kept in ${commentRecoveryPath}`);
        process.exit(1);
      }
      return;
    }

    const comment = await storage.createComment(task.id, content.trim(), getActor());
    // Comment is now durably persisted — clean up recovery file
    if (commentRecoveryPath) removeRecoveryFile(commentRecoveryPath);

    // INVARIANT (fix-comment-auto-launch): a comment NEVER starts a turn.
    // No signal is emitted here. The comment rides the next `lazy unblock`,
    // which builds a "NOTES ADDED SINCE YOUR LAST TURN" block from storage.
    // Only unblock (and the initial start) deliver notes — `lazy ask` skips
    // them deliberately and `lazy sync` never builds them. Emitting a signal
    // made the daemon
    // auto-unblock the task within one reconcile tick, so the human's own
    // `lazy unblock` seconds later refused with "task is busy" and their
    // actual feedback never reached the agent.
    console.log(`Added comment to task ${displayId(task)}`);
    console.log(`  Comment ID: ${shortId(comment.id)}`);
    console.log(`  Created: ${comment.created_at}`);
  } finally {
    await storage.close();
  }
}

export function commentUsage(): void {
  console.log(`Usage: lazy comment <task_id> [-m|--message "..."] [--edit <comment_id>]

Add a freeform comment/annotation to a task, or edit one the agent has not seen yet.

Arguments:
  <task_id>    ID of the task to annotate (can be shortened)

Options:
  -m, --message "..."   Provide comment text inline instead of opening editor
  --edit <comment_id>    Replace the text of an existing comment (id or prefix). Only
                        allowed while the agent has not been shown it; once delivered,
                        a comment is history the agent may have acted on, so add a
                        new comment with the correction instead. $EDITOR opens with
                        the current text.

Input priority: --message flag > piped stdin > $EDITOR (interactive)

A comment never starts a turn. It is delivered to the agent in the prompt of the
next lazy unblock, alongside your feedback. lazy ask and lazy sync do not carry
comments, and never consume them — they wait for the unblock.

Comments are human annotations for context that doesn't fit in turns or prompts:
- "Session was accepted but code was lost due to worktree corruption"
- "Superseded by task f8603ccb"
- "Agent struggled with X, try different approach next time"

Comments are markdown — headings, lists and code fences render on the task page
in the web UI, and multi-paragraph comments are normal.

Examples:
  lazy comment abc12345 --message "Superseded by task xyz"
  lazy comment abc1                                       # Opens $EDITOR
  echo "My comment" | lazy comment abc1                   # Piped stdin
  lazy comment abc1 --edit 3f2a -m "Corrected text"      # Edit an unseen comment`);
}
