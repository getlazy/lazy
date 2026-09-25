/**
 * Layer (d) of §1.5.2 — what lazy's store adds to a region that git already
 * produced: the task's goal, the acting identity, and the review chunks.
 *
 * ENRICHMENT ONLY. Nothing here may ever be a prerequisite for a region: every
 * lookup that misses returns null, and the carving carries on with the commit
 * subject and the git author it already had.
 */

import type { Storage } from '../storage/interface';
import type { Turn } from '../types';
import { groupTurnsIntoChunks } from '../utils/turn-chunks';
import type { RegionChunkFacts, RegionEnrichment, RegionTaskFacts } from './compute';

/**
 * Build the enrichment port over a Storage.
 *
 * Memoized per cover: the carving asks about the same task code up to three
 * times (title, expansion test, chunks), and on a 400-region release that is
 * the difference between 400 and 1,200 store round-trips.
 */
export function storeEnrichment(storage: Storage): RegionEnrichment {
  const cache = new Map<string, Promise<RegionTaskFacts | null>>();
  return {
    lookupTask(code: string): Promise<RegionTaskFacts | null> {
      const hit = cache.get(code);
      if (hit) return hit;
      const pending = loadTaskFacts(storage, code);
      cache.set(code, pending);
      return pending;
    },
  };
}

async function loadTaskFacts(storage: Storage, code: string): Promise<RegionTaskFacts | null> {
  const resolved = await storage.resolveTask(code);
  const task = resolved.task;
  if (!task) return null;

  const session = await storage.getSessionByTaskId(task.id);
  const turns: Turn[] = session ? await storage.getSessionTurns(session.id) : [];

  return {
    code,
    taskId: task.id,
    status: task.status,
    goal: task.goal,
    ...(session?.git_branch ? { branch: session.git_branch } : {}),
    actors: distinct(turns.map((t) => t.actor)),
    agents: distinct(turns.map((t) => t.agent)),
    models: distinct(turns.map((t) => t.model_id ?? t.model)),
    chunks: chunkFacts(turns),
  };
}

function distinct(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

/**
 * A chunk's diffable range, from the work-only SHAs of its turns.
 *
 * `start_sha_work .. end_sha_work` deliberately, not `start_sha .. end_sha`:
 * the work SHAs exclude the pre- and post-turn sync merges, so a chunk region
 * shows what the chunk DID rather than what upstream moved underneath it.
 *
 * A chunk whose turns carry no SHAs at all (legacy turns, a turn that crashed
 * before recording) is dropped rather than given an invented range — a region
 * pointing at the wrong commits is worse than one region fewer.
 */
export function chunkFacts(turns: Turn[]): RegionChunkFacts[] {
  const facts: RegionChunkFacts[] = [];
  for (const chunk of groupTurnsIntoChunks(turns)) {
    const from = chunk.turns.map((t) => t.start_sha_work).find((s): s is string => !!s);
    const to = [...chunk.turns].reverse().map((t) => t.end_sha_work).find((s): s is string => !!s);
    if (!from || !to || from === to) continue;
    const boundary = chunk.boundary;
    const title = boundary
      ? firstLine(boundary.content) || `Chunk ${chunk.index + 1}`
      : `Chunk ${chunk.index + 1} (agent turns)`;
    facts.push({ index: chunk.index, title, from, to });
  }
  return facts;
}

function firstLine(content: string): string {
  const line = content.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}
