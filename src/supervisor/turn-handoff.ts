/**
 * The agent's end-of-turn handoff file.
 *
 * WHY THIS EXISTS
 *
 * The `lazy_*` MCP tools are an agent's only channel to lazy state, and that
 * channel can die mid-turn: the daemon restarts onto a new port, the stdio proxy
 * child exits, a long turn outlives its connection. When it does, the agent
 * reaches the end of its turn holding exactly the things that are most expensive
 * to lose — its journal entry (why it made the calls it made) and its follow-ups
 * — with nowhere to put them. What agents actually did was fall back to running
 * the lazy CLI inside the container, which fails with EROFS because the repo
 * mount is read-only, and would bypass the daemon's storage ownership even if it
 * could write. The retrospective ended up pasted into a summary for a human to
 * re-enter by hand, or simply lost.
 *
 * So there is a second, dumber channel that shares NO failure mode with the
 * first: a file. The agent appends NDJSON to `<worktree>/.lazy-task-sandbox/
 * turn-handoff.jsonl`, a path it can always write (the worktree is mounted
 * read-write in every runner, and the sandbox dir is gitignored so this pollutes
 * neither `git status` nor the task diff). The supervisor clears it before the
 * agent runs and reads it after — on the success path AND on the error path, so
 * a watchdog kill still lands the agent's account of the turn. The entries ride
 * home on the protocol response and the daemon reconciler persists them through
 * Storage, so nothing bypasses the daemon.
 *
 * Deliberately NOT a fallback that talks to the daemon: any such route shares
 * the single point of failure with MCP, which is the whole problem.
 */

import { join } from 'path';
import { readFile, writeFile, rm } from 'fs/promises';
import { SANDBOX_DIR } from '../utils/sandbox';
import type { AgentHandoffEntry } from '../protocol/types';

/** File name of the handoff file inside the sandbox dir. */
export const TURN_HANDOFF_FILENAME = 'turn-handoff.jsonl';

/**
 * Cap on entries collected from one turn. A runaway loop writing this file must
 * not turn into an unbounded number of journal rows.
 */
const MAX_HANDOFF_ENTRIES = 50;

/** Cap on one entry's content. Long enough for a real retrospective. */
const MAX_HANDOFF_CONTENT = 20_000;

/** Absolute path of a worktree's handoff file. */
export function turnHandoffPath(worktreePath: string): string {
  return join(worktreePath, SANDBOX_DIR, TURN_HANDOFF_FILENAME);
}

/**
 * Remove any handoff file left from a previous turn.
 *
 * Must run before every agent launch: a stale file would be collected again and
 * re-journaled on a turn whose agent never wrote it. Never throws — a handoff
 * file that cannot be cleared is not a reason to fail a turn, and a stale entry
 * is deduped downstream by content.
 */
export async function clearTurnHandoff(
  worktreePath: string,
  log?: (message: string) => void,
): Promise<void> {
  const path = turnHandoffPath(worktreePath);
  try {
    await rm(path, { force: true });
  } catch (err) {
    log?.(`Could not clear turn handoff file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Read and parse the handoff file the agent may have written this turn.
 *
 * Returns [] when there is no file (the normal case — the tools worked). Never
 * throws: this runs on the way out of a turn, including the failure path, and a
 * malformed line must not turn a completed turn into a crashed one. Bad lines
 * are skipped individually so one truncated write does not discard the entries
 * around it.
 */
export async function collectTurnHandoff(
  worktreePath: string,
  log?: (message: string) => void,
): Promise<AgentHandoffEntry[]> {
  const path = turnHandoffPath(worktreePath);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    // ENOENT is the normal case: the agent's tools worked, so it never wrote one.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log?.(`Could not read turn handoff file ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return [];
  }

  const entries: AgentHandoffEntry[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (entries.length >= MAX_HANDOFF_ENTRIES) {
      skipped++;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped++;
      continue;
    }
    const entry = parsed as Partial<AgentHandoffEntry>;
    if (entry?.kind !== 'journal' && entry?.kind !== 'followup') {
      skipped++;
      continue;
    }
    if (typeof entry.content !== 'string' || entry.content.trim() === '') {
      skipped++;
      continue;
    }
    entries.push({ kind: entry.kind, content: entry.content.slice(0, MAX_HANDOFF_CONTENT) });
  }

  if (skipped > 0) {
    log?.(`Turn handoff file ${path}: skipped ${skipped} unusable line${skipped === 1 ? '' : 's'}`);
  }
  if (entries.length > 0) {
    log?.(
      `Collected ${entries.length} end-of-turn handoff entr${entries.length === 1 ? 'y' : 'ies'} ` +
      `from the agent (its lazy tools were unavailable)`,
    );
  }
  return entries;
}

/**
 * Collect the handoff and shape it for spreading into a protocol response.
 *
 * Returns `{}` when the agent left nothing, so the field stays absent on the
 * overwhelmingly common healthy turn instead of serializing an empty array.
 */
export async function handoffField(
  worktreePath: string,
  log?: (message: string) => void,
): Promise<{ agent_handoff?: AgentHandoffEntry[] }> {
  const entries = await collectTurnHandoff(worktreePath, log);
  return entries.length > 0 ? { agent_handoff: entries } : {};
}

/**
 * Append one entry to a worktree's handoff file.
 *
 * Exported for tests and for any host-side caller that needs to seed the file;
 * the agent itself writes it with ordinary file tools.
 */
export async function appendTurnHandoff(
  worktreePath: string,
  entry: AgentHandoffEntry,
): Promise<void> {
  const path = turnHandoffPath(worktreePath);
  let existing = '';
  try {
    existing = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const prefix = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
  await writeFile(path, `${prefix}${JSON.stringify(entry)}\n`);
}
