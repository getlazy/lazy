import { join } from 'path';
import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, shortId, displayId, parseFlags, resolveTaskOrExit, formatDate, parseLineRange, sliceLines, getWorktreePath, getBranchNameFromId } from '../helpers';
import { getDiffStat, getDiffFull, getCurrentBranch } from '../../git/operations';
import { getNewNotesSince } from './shared';
import { getTurnDiff } from '../../utils/diff';
import type { Comment } from '../../types';
import { loadConfig } from '../../config/loader';
import { createDriver } from '../../remote';

import { getDataDir } from '../init';

/**
 * Render comments as a virtual unified diff section.
 * Each comment appears as `+` lines, mimicking additions in a review diff.
 */
function renderNotesDiff(comments: Comment[]): string {
  if (comments.length === 0) return '';

  const lines: string[] = [];
  lines.push('diff --lazy a/comments b/comments');
  lines.push('--- /dev/null');
  lines.push('+++ b/comments');

  // Build all comment lines
  const commentLines: string[] = [];
  for (const comment of comments) {
    commentLines.push(`[${formatDate(comment.created_at)}]`);
    const contentLines = comment.content.split('\n');
    commentLines.push(...contentLines);
    commentLines.push('');
  }

  // Emit a single hunk covering all comments
  lines.push(`@@ -0,0 +1,${commentLines.length} @@`);
  for (const line of commentLines) {
    lines.push(`+${line}`);
  }

  return lines.join('\n');
}

export async function commandDiff(args: string[]): Promise<void> {
  // Parse and validate flags
  const parsed = parseFlags(args, [
    { name: 'turn', takesValue: true },
    { name: 'full', takesValue: false },
    { name: 'lines', takesValue: true },
  ], 'diff');

  const taskId = parsed.positional[0];
  if (!taskId) {
    diffUsage();
    process.exit(1);
  }

  // Parse line range if specified
  let lineRange = null;
  const linesValue = parsed.flags.get('lines') as string | undefined;
  if (linesValue !== undefined) {
    lineRange = parseLineRange(linesValue);
    if (!lineRange) {
      console.error(`Invalid line range: ${linesValue}. Format: N..M, N.., or ..M`);
      process.exit(1);
    }
  }

  const root = requireLazyRoot();
  const storage = await requireStorage();

  try {
    // Resolve task
    const task = await resolveTaskOrExit(storage, taskId);

    // Get session
    const sess = await storage.getSessionByTaskId(task.id);
    if (!sess) {
      console.error(`Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
      process.exit(1);
    }

    const worktreePath = getWorktreePath(root, task);
    if (!existsSync(worktreePath)) {
      console.error(`Worktree not found at ${worktreePath}. Session may have been cleaned up.`);
      process.exit(1);
    }

    // Handle --turn flag: show diff for a specific turn
    const turnValue = parsed.flags.get('turn') as string | undefined;
    if (turnValue !== undefined) {
      await handleTurnDiff(storage, sess.id, turnValue, worktreePath, task.parent_task_id, root, lineRange);
      return;
    }

    // Use the captured upstream merge SHA if available (shows only agent's work).
    // This is the SHA of the parent branch at the time it was last merged into this task.
    // Fallback to three-dot diff against the parent branch for old tasks.
    let fromRef: string;
    let useTwoDotDiff = false;

    if (sess.upstream_merge_sha) {
      // Best case: we have the exact upstream SHA that was merged
      fromRef = sess.upstream_merge_sha;
      useTwoDotDiff = true;
    } else {
      // Fallback: use three-dot diff against parent branch (old behavior)
      if (task.parent_task_id) {
        fromRef = await getBranchNameFromId(task.parent_task_id, storage);
      } else {
        fromRef = getCurrentBranch(root);
      }
    }

    // For default diff, find the last agent turn and show notes since then.
    // If no agent turn, show all notes (they were all added before agent started).
    let noteCutoff: number | null = null;
    const turns = await storage.getSessionTurns(sess.id);
    const lastAgentTurn = turns.filter(t => t.role === 'agent').pop();
    if (lastAgentTurn) {
      noteCutoff = lastAgentTurn.timestamp;
    }
    // noteCutoff = null means show all notes

    // Fetch notes for the virtual diff section
    const allNotes = await storage.getTaskComments(task.id);
    const newNotes = noteCutoff
      ? getNewNotesSince(allNotes, noteCutoff)
      : allNotes;
    const notesDiffSection = renderNotesDiff(newNotes);

    const full = parsed.flags.get('full') === true;
    let output = '';
    if (full) {
      const diff = getDiffFull(fromRef, 'HEAD', worktreePath, useTwoDotDiff);
      if (!diff && !notesDiffSection) {
        output = 'No changes.';
      } else {
        const parts: string[] = [];
        if (diff) parts.push(diff);
        if (notesDiffSection) parts.push(notesDiffSection);
        output = parts.join('\n\n');
      }
    } else {
      const stat = getDiffStat(fromRef, 'HEAD', worktreePath, useTwoDotDiff);
      if (!stat && newNotes.length === 0) {
        output = 'No changes.';
      } else {
        const parts: string[] = [];
        if (stat) parts.push(stat);
        if (newNotes.length > 0) {
          parts.push(` comments | ${newNotes.length} comment(s) added`);
        }
        parts.push(`\nFor full diff: lazy diff ${displayId(task)} --full`);
        output = parts.join('\n');
      }
    }

    // Apply line slicing if specified
    if (lineRange) {
      output = sliceLines(output, lineRange);
    }

    console.log(output);
  } finally {
    await storage.close();
  }
}

/**
 * Handle --turn flag: show the diff for a specific turn.
 * Supports numeric turn numbers or "latest" alias.
 */
async function handleTurnDiff(
  storage: Awaited<ReturnType<typeof requireStorage>>,
  sessionId: string,
  turnValue: string,
  worktreePath: string,
  parentTaskId: string | null,
  root: string,
  lineRange: ReturnType<typeof parseLineRange> | null = null,
): Promise<void> {
  const turns = await storage.getSessionTurns(sessionId);
  const agentTurns = turns.filter(t => t.role === 'agent');

  if (agentTurns.length === 0) {
    console.log('No agent turns yet.');
    return;
  }

  let targetTurn;
  if (turnValue === 'latest') {
    targetTurn = agentTurns[agentTurns.length - 1];
  } else {
    const turnSeq = parseInt(turnValue, 10);
    if (isNaN(turnSeq)) {
      console.error(`Invalid turn number: ${turnValue}. Use a number or "latest".`);
      process.exit(1);
    }
    targetTurn = turns.find(t => t.sequence === turnSeq);
    if (!targetTurn) {
      console.error(`Turn ${turnSeq} not found. Available agent turns: ${agentTurns.map(t => t.sequence).join(', ')}`);
      process.exit(1);
    }
  }

  // Compute fallback ref for tasks without per-turn SHAs
  // Resolve through driver to get origin/<branch> when using remote driver.
  let fallbackFromRef: string | undefined;
  if (parentTaskId) {
    fallbackFromRef = await getBranchNameFromId(parentTaskId, storage);
  } else {
    fallbackFromRef = getCurrentBranch(root);
  }

  // Resolve the base ref through the driver to get origin/<branch> when using
  // a remote driver, or the local branch when using local driver.
  try {
    const config = loadConfig(root);
    const driver = createDriver(config);
    fallbackFromRef = await driver.resolveUpstreamRef(fallbackFromRef, worktreePath);
  } catch {
    // Non-fatal: use the local ref if driver resolution fails
  }

  // Get the session to access upstream_merge_sha for backward compat turns
  const session = await storage.getSession(sessionId);
  const upstreamMergeSha = session?.upstream_merge_sha ?? undefined;

  const result = getTurnDiff(targetTurn, worktreePath, fallbackFromRef, upstreamMergeSha);

  if (!result || !result.diff.trim()) {
    let output = 'No changes in this turn.';
    if (lineRange) {
      output = sliceLines(output, lineRange);
    }
    console.log(output);
    return;
  }

  let output = '';
  if (result.isFallback) {
    output = '(Full task diff — per-turn diff unavailable)\n\n' + result.diff;
  } else {
    output = result.diff;
  }

  // Apply line slicing if specified
  if (lineRange) {
    output = sliceLines(output, lineRange);
  }

  console.log(output);
}

export function diffUsage(): void {
  console.log(`Usage: lazy diff <task_id> [--full] [--turn N|latest] [--lines N..M]

Show changes made by a task relative to its upstream branch.
Comments added since the last agent turn are shown as virtual diff additions.

Arguments:
  <task_id>        ID of the task

Options:
  --full           Show full diff (default: stat summary)
  --turn N|latest  Show diff for a specific turn only
  --lines N..M     Return only lines N through M of the output (1-indexed, inclusive)
                   Formats: N..M (range), N.. (from N to end), ..M (start to M)

Examples:
  lazy diff abc123                    # Summary of all changes vs upstream
  lazy diff abc123 --full             # Full diff vs upstream
  lazy diff abc123 --turn latest      # Diff for the most recent turn
  lazy diff abc123 --turn 1           # Diff for turn 1
  lazy diff abc123 --lines 10..50     # Show only lines 10-50 of diff output
  lazy diff abc123 --full --lines 1..100  # First 100 lines of full diff`);
}
