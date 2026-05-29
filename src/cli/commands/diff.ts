import { existsSync } from 'fs';
import { requireLazyRoot, requireStorage, displayId, parseFlags, resolveTaskOrExit, parseLineRange, sliceLines, getWorktreePath, getBranchNameFromId } from '../helpers';
import { getCurrentBranch, getRemoteDefaultBranch, recoverMissingWorktreeWithFetch } from '../../git/operations';
import { getTurnDiff } from '../../utils/diff';
import { loadConfig } from '../../config/loader';
import { createDriver } from '../../remote';
import { queryDiff } from '../../daemon/rpc-fallback';
import { parentTaskIdOf } from '../../task-target';

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

  // --turn needs local git/worktree access — stays direct
  const turnValue = parsed.flags.get('turn') as string | undefined;
  if (turnValue !== undefined) {
    const root = requireLazyRoot();
    const storage = await requireStorage();
    try {
      const task = await resolveTaskOrExit(storage, taskId);
      const sess = await storage.getSessionByTaskId(task.id);
      if (!sess) {
        console.error(`Task ${displayId(task)} has no session. Start it first with: lazy start ${displayId(task)}`);
        process.exit(1);
      }
      const worktreePath = getWorktreePath(root, task);
      if (!existsSync(worktreePath)) {
        // Worktree is gone — try to recover from local or remote branch
        const branchName = sess.git_branch;
        const config = await loadConfig(root);
        try {
          const recovery = await recoverMissingWorktreeWithFetch(
            worktreePath, branchName, config.remote.git_remote, root,
          );
          if (!recovery.recovered) {
            console.error(`Worktree is gone and branch '${branchName}' not found locally or on remote.`);
            process.exit(1);
          }
          console.error(`Worktree recovered from branch '${branchName}'.`);
        } catch (err) {
          console.error(`Failed to recover worktree: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        }
      }
      await handleTurnDiff(storage, sess.id, turnValue, worktreePath, parentTaskIdOf(task), root, lineRange);
    } finally {
      await storage.close();
    }
    return;
  }

  // Default diff via daemon RPC
  const full = parsed.flags.get('full') === true;
  const { output: diffOutput } = await queryDiff({ taskId, full });

  let output = diffOutput;
  if (lineRange) {
    output = sliceLines(output, lineRange);
  }
  console.log(output);
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
    fallbackFromRef = await getRemoteDefaultBranch(root);
  }

  // Resolve the base ref through the driver to get origin/<branch> when using
  // a remote driver, or the local branch when using local driver.
  try {
    const config = await loadConfig(root);
    const driver = createDriver(config);
    fallbackFromRef = await driver.resolveUpstreamRef(fallbackFromRef, worktreePath);
  } catch {
    // Non-fatal: use the local ref if driver resolution fails
  }

  // Get the session to access upstream_merge_sha for backward compat turns
  const session = await storage.getSession(sessionId);
  const upstreamMergeSha = session?.upstream_merge_sha ?? undefined;

  const result = await getTurnDiff(targetTurn, worktreePath, fallbackFromRef, upstreamMergeSha);

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
