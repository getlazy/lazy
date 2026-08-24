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
import { runGit } from '../utils/git';
import { buildTurnHistoryContext } from '../cli/commands/shared';
import handoffTemplate from '../prompts/agent-switch-handoff.md' with { type: 'text' };

/**
 * Classify whether a merge commit's tree matches one of its parents
 * (conflict-free / no unique content from the merge itself).
 * Returns null when the commit is not a merge or git fails.
 */
async function mergeIsTreeEquivalent(
  sha: string,
  cwd: string,
): Promise<{ parents: string[]; treeMatchesParent: boolean } | null> {
  const parentsResult = await runGit(['rev-list', '--parents', '-n', '1', sha], { cwd });
  if (parentsResult.exitCode !== 0 || !parentsResult.stdout.trim()) return null;

  // Format: "<sha> <parent1> <parent2> ..."
  const parts = parentsResult.stdout.trim().split(/\s+/);
  if (parts.length < 3) return null; // not a merge
  const parents = parts.slice(1);

  const treeOf = async (ref: string): Promise<string | null> => {
    const r = await runGit(['rev-parse', `${ref}^{tree}`], { cwd });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  };

  const mergeTree = await treeOf(sha);
  if (!mergeTree) return null;

  for (const parent of parents) {
    const parentTree = await treeOf(parent);
    if (parentTree && parentTree === mergeTree) {
      return { parents, treeMatchesParent: true };
    }
  }
  return { parents, treeMatchesParent: false };
}

/**
 * Build a short branch orientation block: changed-file stat + task commits,
 * omitting conflict-free merge commits when detectable.
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

  const commits = await getNewCommits(gitStartSha, worktreePath);
  const kept: string[] = [];
  let omittedMerges = 0;

  for (const c of commits) {
    const mergeInfo = await mergeIsTreeEquivalent(c.sha, worktreePath);
    if (mergeInfo?.treeMatchesParent) {
      omittedMerges += 1;
      continue;
    }
    // Non-merge, or a merge that actually changed the tree (e.g. conflict resolution).
    const subject = c.message.split('\n')[0] ?? c.message;
    const tag = mergeInfo ? ' (merge with unique content)' : '';
    kept.push(`- \`${c.sha.slice(0, 8)}\` ${subject}${tag}`);
  }

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
      : '(no non-omitted commits since base)';

  return `## Branch orientation

- Branch: \`${branchName}\`
- Base SHA: \`${baseShort}\`
- Conflict-free merge commits omitted from the list below: ${omittedMerges}${syncNote}

### Files changed since base

\`\`\`
${filesBlock}
\`\`\`

### Task commits (conflict-free merges omitted)

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
