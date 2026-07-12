import type { Turn } from '../types';

/**
 * A "review chunk": one genuine human/builder review intervention plus every
 * automation-authored turn that followed it (agent work, supervisor nudges,
 * system auto-resumes) up to — but not including — the next intervention.
 *
 * Reviewing at chunk granularity is the fix for the "latest turn loses context"
 * problem: comment-driven auto-resumes, supervisor nudges, and syncs insert
 * intermediate turns between two human turns. A reviewer who only looks at the
 * latest turn silently skips them. A chunk keeps the boundary turn and all of
 * its follow-on turns together, so nothing in between is lost.
 */
export interface TurnChunk {
  /** 0-based index of this chunk within the session. */
  index: number;
  /**
   * The human/builder turn that opens the chunk. Null only for a leading chunk
   * of automation/agent turns that precede any review intervention (e.g. a
   * session that was auto-resumed before the first human turn) — those turns
   * are kept rather than dropped.
   */
  boundary: Turn | null;
  /** All turns in the chunk in sequence order, including the boundary turn. */
  turns: Turn[];
}

/**
 * Does this turn open a new review chunk? A boundary is a genuine human/builder
 * review intervention — the point a reviewer actually cares about.
 *
 * Expressed via the actor model: a role='human' turn authored by a real
 * reviewer starts a chunk. That means actor 'human' or 'builder' — and, for
 * backward compatibility, legacy turns with no actor at all (absent === human).
 * Turns injected by automation are NOT boundaries and get absorbed into the
 * current chunk:
 *   - supervisor nudges       → actor 'supervisor'
 *   - reconciler/auto-deliver → actor 'system'
 *   - agent work/responses    → role 'agent' (never has an actor)
 *
 * NOTE: the human-vs-builder distinction does not affect WHERE boundaries fall —
 * both are reviewer interventions — so chunking is correct today even though the
 * `builder-actor` task (which makes the MCP boundary tag turns as 'builder')
 * has not landed. Until it does, builder-originated turns simply carry
 * actor='human', which is still a boundary. See docs/spikes/chunked-turns.md.
 *
 * `auto_triggered` is a backstop for legacy turns predating actor population: an
 * auto-triggered human-role turn is automation even if its actor is missing.
 */
export function isChunkBoundary(turn: Turn): boolean {
  if (turn.role !== 'human') return false;
  if (turn.actor === 'supervisor' || turn.actor === 'system') return false;
  if (turn.auto_triggered) return false;
  return true;
}

/**
 * Group a session's turns (in sequence order) into review chunks. The input is
 * assumed already ordered by sequence, as returned by getSessionTurns.
 */
export function groupTurnsIntoChunks(turns: Turn[]): TurnChunk[] {
  const chunks: TurnChunk[] = [];
  let current: TurnChunk | null = null;

  for (const turn of turns) {
    const boundary = isChunkBoundary(turn);
    // Open a new chunk at every boundary, and also when nothing is open yet
    // (leading automation/agent turns form a boundary-less chunk).
    if (boundary || current === null) {
      current = {
        index: chunks.length,
        boundary: boundary ? turn : null,
        turns: [turn],
      };
      chunks.push(current);
    } else {
      current.turns.push(turn);
    }
  }

  return chunks;
}
