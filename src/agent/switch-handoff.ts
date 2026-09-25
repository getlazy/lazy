/**
 * Distilled context handoff when an agent session cannot be resumed
 * (agent switch mid-task, or any other fresh-session path with prior turns).
 *
 * Sessions are not migrated between agents — see
 * docs/spikes/cross-agent-session-transplant.md. Lazy already injects turn
 * history on `!canResume`; this module adds orientation framing and a
 * branch/commit summary so the new agent can re-familiarize itself.
 *
 * Design: docs/spikes/cross-agent-context-handoff.md
 */

import type { Turn } from '../types';
import { getDiffStat, getNewCommits } from '../git/operations';
import { buildTurnHistoryContext } from '../task/turn-context';
import handoffTemplate from '../prompts/agent-switch-handoff.md' with { type: 'text' };

/**
 * Build a short branch orientation block: changed-file stat + task commits.
 *
 * The list is a FIRST-PARENT walk, and that choice replaced an earlier
 * noise filter that must not come back. The walk used to be
 * `<base>..HEAD` — a reachability query — which listed every commit of every
 * line the branch had ever merged, so a synced branch introduced itself to the
 * new agent with months of other tasks' history. To keep that readable, merges
 * whose tree equalled one of their parents were dropped from the list: safe at
 * the time, because the commits that merge carried were listed individually
 * anyway.
 *
 * Under a first-parent walk that filter INVERTS: the merge commit is the only
 * representative of the line it brought in, so omitting it dropped that work
 * from the handoff with nothing left to stand for it. First-parent already
 * collapses a merged line to a single line of output, which is all the noise
 * filter was ever for, so the filter is gone rather than repaired.
 *
 * Clean upstream syncs are still called out — from the TURN records via
 * `cleanSyncTurnCount`, which knows a sync from a child accept; the shape of a
 * commit's tree never did.
 */
export async function buildTaskOrientationContext(opts: {
  branchName: string;
  gitStartSha: string;
  worktreePath: string;
  /** Lazy sync turns that were clean auto-merges (actor supervisor, turn_type sync, no conflicts). */
  cleanSyncTurnCount?: number;
}): Promise<string> {
  const { branchName, gitStartSha, worktreePath } = opts;
  const baseShort = gitStartSha.slice(0, 8);

  let filesStat = '';
  try {
    filesStat = (await getDiffStat(gitStartSha, 'HEAD', worktreePath, true)).trim();
  } catch {
    // Orientation is best-effort — never block the turn.
  }

  // First-parent: orientation is what THIS branch did. Without it a branch that
  // has synced its upstream lists that upstream's commits as its own work.
  let commits: Awaited<ReturnType<typeof getNewCommits>> = [];
  try {
    commits = await getNewCommits(gitStartSha, worktreePath, { firstParent: true });
  } catch {
    // Same best-effort contract as the file stat above: orientation must never
    // block a turn. An unreadable branch yields no commit list, and the block
    // below says so rather than implying the branch is empty.
  }
  const kept = commits.map(c => {
    const subject = c.message.split('\n')[0] ?? c.message;
    return `- \`${c.sha.slice(0, 8)}\` ${subject}`;
  });

  const syncNote =
    opts.cleanSyncTurnCount && opts.cleanSyncTurnCount > 0
      ? `\n- Lazy recorded ${opts.cleanSyncTurnCount} conflict-free upstream sync turn(s) — treat those merges as bookkeeping.`
      : '';

  const filesBlock = filesStat
    ? filesStat
    : '(no file changes detected since base, or diff unavailable)';

  const commitsBlock =
    kept.length > 0
      ? kept.join('\n')
      : '(no commits since base, or the branch could not be read)';

  return `## Branch orientation

- Branch: \`${branchName}\`
- Base SHA: \`${baseShort}\`${syncNote}

### Files changed since base

\`\`\`
${filesBlock}
\`\`\`

### Task commits (first-parent — a merge is one line, not the line it merged)

${commitsBlock}
`;
}

/**
 * Count lazy sync turns that look like clean auto-merges (ignore as narrative).
 */
export function countCleanSyncTurns(turns: Turn[]): number {
  return turns.filter(
    (t) =>
      t.actor === 'supervisor' &&
      t.turn_type === 'sync' &&
      !(t.merge_conflicts && t.merge_conflicts.length > 0),
  ).length;
}

/**
 * Full handoff block for a fresh agent session that has prior lazy turns:
 * orientation template + turn history (with truncation honesty).
 */
export async function buildAgentSwitchHandoffContext(opts: {
  turns: Turn[];
  branchName: string;
  gitStartSha: string;
  worktreePath: string;
  maxHistoryChars?: number;
}): Promise<string> {
  const orientation = await buildTaskOrientationContext({
    branchName: opts.branchName,
    gitStartSha: opts.gitStartSha,
    worktreePath: opts.worktreePath,
    cleanSyncTurnCount: countCleanSyncTurns(opts.turns),
  });

  const turnHistory = buildTurnHistoryContext(opts.turns, opts.maxHistoryChars);

  return handoffTemplate
    .replace('{{orientation}}', orientation)
    .replace('{{turnHistory}}', turnHistory);
}
