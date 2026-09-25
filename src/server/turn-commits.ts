/**
 * Attribute session commits to the turn that produced them, by timestamp
 * — Commit has no turn_id.
 *
 * Recording order (reconcile): work turn, then any supervised nudge turns,
 * then createCommit with Date.now(). Commit timestamps are therefore after
 * every turn of that exchange. Attribution:
 *
 *   each commit → the latest agent/work turn with timestamp <= commit.timestamp
 *
 * That skips nudge/ask/review turns and still ties the commit to the work
 * turn that made it. Commits before any work turn stay unattributed — they
 * still appear on the Commits tab.
 *
 * See docs/design/turn-commit-attribution.md.
 */

import type { Turn, Commit } from '../types';

/** Agent work turn (or legacy missing turn_type) — the turns that commit. */
export function isAgentWorkTurn(turn: Turn): boolean {
  return turn.role === 'agent' && (turn.turn_type ?? 'work') === 'work';
}

function turnsInOrder(turns: Turn[]): Turn[] {
  return [...turns].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.sequence - b.sequence;
  });
}

/**
 * The agent/work turn this commit belongs to, or null if none yet.
 */
export function workTurnForCommit(commit: Commit, turns: Turn[]): Turn | null {
  let best: Turn | null = null;
  for (const turn of turnsInOrder(turns)) {
    if (!isAgentWorkTurn(turn)) continue;
    if (turn.timestamp > commit.timestamp) break;
    best = turn;
  }
  return best;
}

/**
 * Commits attributed to this turn (oldest first). Empty unless the turn is
 * an agent/work turn.
 */
export function commitsForTurn(turn: Turn, allTurns: Turn[], commits: Commit[]): Commit[] {
  if (!isAgentWorkTurn(turn)) return [];
  return commits
    .filter((c) => workTurnForCommit(c, allTurns)?.id === turn.id)
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.id.localeCompare(b.id);
    });
}

/**
 * Map turn id → commits attributed to that turn. Only agent/work turns
 * appear. Unattributed commits (before the first work turn) are omitted.
 */
export function attributeCommitsToTurns(
  turns: Turn[],
  commits: Commit[],
): Map<string, Commit[]> {
  const out = new Map<string, Commit[]>();
  if (turns.length === 0 || commits.length === 0) return out;
  for (const turn of turnsInOrder(turns)) {
    if (!isAgentWorkTurn(turn)) continue;
    const attributed = commitsForTurn(turn, turns, commits);
    if (attributed.length > 0) out.set(turn.id, attributed);
  }
  return out;
}
