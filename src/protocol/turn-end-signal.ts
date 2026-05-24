/**
 * Turn-end signal marker file.
 *
 * Lives at <protocolDir>/turn-end-signal. Written by the MCP `lazy_commit`
 * handler after a successful commit — `lazy_commit` is the de-facto end-of-turn
 * tool today (the prompt mandates committing as the last action of a turn).
 *
 * The supervisor watches this marker alongside the agent process. Once the
 * marker appears, the supervisor starts a one-shot grace timer. If the timer
 * fires before claude -p exits naturally, the agent is killed — see
 * `src/supervisor/watchdog.ts` and `GracefulExitTimeoutError` in `work.ts`.
 *
 * INVARIANT: once written, the marker does NOT reset on later tool calls.
 * The whole point is to bound how long we wait for claude's plumbing to wind
 * down once the agent considers itself done. Resetting on more tool calls
 * would reintroduce the indefinite-hang failure mode this feature prevents.
 */

import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { mkdir, rename, writeFile } from 'fs/promises';
import { readFileSafe, unlinkSafe } from '../utils/fs';

const FILE_NAME = 'turn-end-signal';

export interface TurnEndSignal {
  /** Full git commit SHA from the `lazy_commit` that signaled end-of-turn. */
  commit_sha: string;
  /** ISO 8601 timestamp the signal was written. */
  written_at: string;
}

export function turnEndSignalPath(protocolDir: string): string {
  return join(protocolDir, FILE_NAME);
}

/**
 * Write the marker atomically. Idempotent — re-writes simply overwrite.
 * The supervisor's wait-loop only acts on the first appearance; subsequent
 * writes do NOT reset the grace timer (see invariant above).
 */
export async function writeTurnEndSignal(protocolDir: string, signal: TurnEndSignal): Promise<void> {
  const finalPath = turnEndSignalPath(protocolDir);
  await mkdir(dirname(finalPath), { recursive: true });
  const tmp = join(dirname(finalPath), `.tmp-${randomUUID()}-${FILE_NAME}`);
  await writeFile(tmp, JSON.stringify(signal), 'utf-8');
  await rename(tmp, finalPath);
}

/**
 * Read the marker. Returns null when the file is absent (normal — no signal
 * yet). Throws when the file exists but cannot be read or parsed (real error,
 * not a "missing" condition — see CLAUDE.md "distinguish between 'not found'
 * and 'found but broken'").
 */
export async function readTurnEndSignal(protocolDir: string): Promise<TurnEndSignal | null> {
  const filePath = turnEndSignalPath(protocolDir);
  const content = await readFileSafe(filePath);
  if (content === null) return null;
  try {
    return JSON.parse(content) as TurnEndSignal;
  } catch (err) {
    throw new Error(
      `Failed to parse turn-end-signal at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Remove the marker. Safe to call when the file is absent.
 * Called by the supervisor at the start of a new turn so stale markers from
 * a previous turn do not trigger the grace timer prematurely.
 */
export async function clearTurnEndSignal(protocolDir: string): Promise<void> {
  await unlinkSafe(turnEndSignalPath(protocolDir));
}
