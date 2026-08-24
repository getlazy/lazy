/**
 * Daemon-side registry of agent-reported progress lines.
 *
 * `lazy_update_progress` is the complement to the working substate: the substate
 * says an agent is alive, the progress line says what it is doing. The daemon is
 * the writer for the same reason it is the writer of `waiting.json` — every agent
 * tool call authenticates with a per-session MCP token, so the daemon knows which
 * task is reporting without reading a byte of agent output, and no client ever
 * writes state directly.
 *
 * LATEST-WINS: each call replaces the previous message. There is no history here
 * and there must not be one — see src/protocol/progress.ts for why this never
 * reaches Storage.
 *
 * INVARIANT — bookkeeping must never break the call it observes. Every failure in
 * here is caught and logged: a progress post that cannot be recorded is a lost
 * status line, and losing a status line must never cost an agent its tool call,
 * let alone its turn.
 */

import { protocolDir, writeProgressFile, clearProgressFile, normalizeProgressMessage } from '../protocol';
import { logger } from '../utils/logger';

/** Tasks whose `progress.json` this process currently owns, for shutdown cleanup. */
const owned = new Set<string>();

/**
 * Per-task serialization of protocol-file writes. Concurrent posts from one
 * session are possible (the MCP server dispatches requests concurrently), and
 * latest-wins is only meaningful if the writes do not interleave or reorder.
 */
const writeChains = new Map<string, Promise<void>>();

function serializeWrite(taskId: string, op: () => Promise<void>): Promise<void> {
  const prev = writeChains.get(taskId) ?? Promise.resolve();
  const next = prev.then(op, op).catch(err => {
    // Observational only — a failed write degrades the substate to what it was
    // before this existed (`working(agent)` with no progress line).
    logger.warn(`progress-registry: failed to update progress for ${taskId}: ${(err as Error).message}`);
  });
  writeChains.set(taskId, next);
  return next;
}

/**
 * Record (replacing any previous) the progress line for a task.
 *
 * Returns the normalized message actually recorded plus whether it was
 * truncated — the caller echoes both back to the agent so a truncation is
 * visible rather than silent. `message` is null when nothing printable
 * remained, in which case the marker is cleared instead.
 */
export async function recordProgress(
  taskId: string,
  rawMessage: string,
): Promise<{ message: string | null; truncated: boolean }> {
  const { message, truncated } = normalizeProgressMessage(rawMessage);
  const dir = protocolDir(taskId);

  if (message === '') {
    owned.delete(taskId);
    await serializeWrite(taskId, () => clearProgressFile(dir));
    return { message: null, truncated: false };
  }

  owned.add(taskId);
  await serializeWrite(taskId, () =>
    writeProgressFile(dir, {
      version: 1,
      writer_pid: process.pid,
      message,
      recorded_at: new Date().toISOString(),
    }),
  );
  return { message, truncated };
}

/** Drop a task's progress marker (turn over, or explicit clear). */
export async function clearProgress(taskId: string): Promise<void> {
  owned.delete(taskId);
  await serializeWrite(taskId, () => clearProgressFile(protocolDir(taskId)));
}

/**
 * Clear every marker this process owns. Called on daemon shutdown so a clean stop
 * does not leave files that readers must fall back to the pid check to disbelieve.
 */
export async function clearAllProgress(): Promise<void> {
  const taskIds = [...owned];
  owned.clear();
  await Promise.all(taskIds.map(taskId => serializeWrite(taskId, () => clearProgressFile(protocolDir(taskId)))));
}
