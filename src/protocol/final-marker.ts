/**
 * `final.json` — the protocol-dir marker for HOW THIS AGENT INVOCATION ENDED.
 *
 * WHY A FILE. A turn ends in one of three ways (final-turn design §2): the
 * agent declared final, the agent left a blocking raise (needs-input), or it
 * just stopped. Nobody ASKS the agent which — the ending is derived — but the
 * SUPERVISOR, running inside the task container, still has to act on the
 * difference the moment an invocation ends: a final runs the full closing
 * chain, a park runs the presentation alone. The first two endings are
 * declared through MCP tools that execute in the DAEMON, and the supervisor
 * cannot read lazy state: its only channels are the bind-mounted protocol dir
 * and the worktree. So the daemon drops a marker in `protocolDir(taskId)` —
 * the same directory it already writes `command.json` into and the supervisor
 * already polls.
 *
 * BOTH ENDINGS, ONE FILE. `lazy_final` sets `final`; a blocking `lazy_raise`
 * sets `needs_input`. Two keys rather than one enum because an agent can do
 * both in one turn (declare, then raise) and neither record may erase the
 * other: the claim is still true about the SHA it names, and the raise still
 * gates accept on its own.
 *
 * `final` selects the closing chain. `needs_input` selects nothing by itself —
 * a park is a park however it was reached — and exists so the supervisor can
 * answer the narrower question "did this invocation reach the daemon at all?",
 * which is what decides whether the MCP-down handoff file is worth reading.
 *
 * LIFECYCLE, and it is the whole safety story:
 *   1. The supervisor CLEARS it before EVERY agent invocation, exactly as it
 *      clears `turn-handoff.jsonl`. INVARIANT (design §13.10): a stale marker
 *      from the previous turn must never make an unfinished turn look done.
 *      `writeCommand` clears it too, for a turn whose supervisor never reaches
 *      that code.
 *   2. The supervisor READS it after each invocation and carries any claim home
 *      on the protocol response; the reconciler persists it onto the turn
 *      (`Turn.final`), which is the DURABLE record.
 *   3. `cleanProtocol` drops it at teardown.
 *
 * The marker is a SIGNAL, never the record. Nothing outside the supervisor's
 * own turn may read it to answer "is this task final" — that is
 * `resolveFinalState`'s question, over the turns.
 */

import { join } from 'path';
import { mkdir, readFile, writeFile, rename, unlink } from 'fs/promises';
import { logger } from '../utils/logger';

export const FINAL_MARKER_FILE = 'final.json';

/**
 * Cap on the agent's note. Long enough for the one line the tool asks for and
 * short enough that a runaway paste cannot become the turn record.
 */
export const MAX_FINAL_NOTE_LENGTH = 2_000;

/** The pencils-down half of the marker. */
export interface FinalMarkerClaim {
  /** HEAD of the task branch when the claim was made. */
  sha: string;
  /** ISO timestamp the claim was recorded. */
  declared_at: string;
  /** The agent's one-line note, already trimmed and truncated. */
  note?: string;
}

/** The needs-input half: a blocking raise was filed during this invocation. */
export interface NeedsInputMark {
  /** ISO timestamp of the first blocking raise this invocation filed. */
  at: string;
}

export interface FinalMarkerFile {
  version: 1;
  final?: FinalMarkerClaim;
  needs_input?: NeedsInputMark;
}

function markerPath(protoDir: string): string {
  return join(protoDir, FINAL_MARKER_FILE);
}

/** Trim and cap an agent-supplied note. Undefined means "no note". */
export function normalizeFinalNote(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= MAX_FINAL_NOTE_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_FINAL_NOTE_LENGTH - 1).trimEnd()}…`;
}

/** Write the marker whole. Atomic (temp + rename) so no reader sees a half-file. */
export async function writeFinalMarker(protoDir: string, file: FinalMarkerFile): Promise<void> {
  await mkdir(protoDir, { recursive: true });
  const target = markerPath(protoDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
  await rename(tmp, target);
}

/**
 * Merge one half of the marker into whatever is already there.
 *
 * Read-modify-write, so a `needs_input` mark can never erase a `final` claim
 * made earlier in the same invocation, or the reverse. Callers must serialize
 * per task (the daemon registry does) — two concurrent tool calls racing here
 * would otherwise lose one half.
 */
export async function mergeFinalMarker(
  protoDir: string,
  patch: Pick<FinalMarkerFile, 'final' | 'needs_input'>,
): Promise<FinalMarkerFile> {
  const existing = (await readFinalMarker(protoDir)) ?? { version: 1 as const };
  const merged: FinalMarkerFile = {
    version: 1,
    ...(patch.final ?? existing.final ? { final: patch.final ?? existing.final } : {}),
    ...(patch.needs_input ?? existing.needs_input
      ? { needs_input: patch.needs_input ?? existing.needs_input }
      : {}),
  };
  await writeFinalMarker(protoDir, merged);
  return merged;
}

/**
 * Remove the marker. Missing file is success.
 *
 * Never throws: this runs before every agent invocation, and a marker that
 * cannot be cleared must not fail the turn — but it IS warned about, because a
 * surviving stale marker is precisely the failure the clear exists to prevent.
 */
export async function clearFinalMarker(
  protoDir: string,
  log?: (message: string) => void,
): Promise<void> {
  try {
    await unlink(markerPath(protoDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    const message = `final-marker: failed to clear ${markerPath(protoDir)}: ${(err as Error).message}`;
    if (log) log(message);
    else logger.warn(message);
  }
}

/**
 * Read the marker, or null when the invocation declared nothing.
 *
 * Degrades to null for every untrustworthy case — missing (the normal one),
 * corrupt, or a shape this version does not understand. "I could not read it"
 * must mean "declared nothing", never a fabricated claim about a SHA. A marker
 * with neither half is also null: an empty declaration is not a declaration.
 */
export async function readFinalMarker(
  protoDir: string,
  log?: (message: string) => void,
): Promise<FinalMarkerFile | null> {
  const filePath = markerPath(protoDir);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const message = `final-marker: failed to read ${filePath}: ${(err as Error).message}`;
    if (log) log(message);
    else logger.warn(message);
    return null;
  }

  let parsed: FinalMarkerFile;
  try {
    parsed = JSON.parse(raw) as FinalMarkerFile;
  } catch (err) {
    const message = `final-marker: corrupt ${filePath}: ${(err as Error).message}`;
    if (log) log(message);
    else logger.warn(message);
    return null;
  }

  // Shape-check rather than trusting the file: this is a read surface for a
  // file on disk, and a half-understood entry must degrade to "declared
  // nothing" instead of producing a claim about an undefined SHA.
  const claim = parsed.final;
  const note = normalizeFinalNote(claim?.note);
  const final: FinalMarkerClaim | undefined =
    claim && typeof claim.sha === 'string' && claim.sha.trim() && typeof claim.declared_at === 'string'
      ? { sha: claim.sha.trim(), declared_at: claim.declared_at, ...(note ? { note } : {}) }
      : undefined;
  const needsInput: NeedsInputMark | undefined =
    parsed.needs_input && typeof parsed.needs_input.at === 'string'
      ? { at: parsed.needs_input.at }
      : undefined;

  if (!final && !needsInput) return null;
  return {
    version: 1,
    ...(final ? { final } : {}),
    ...(needsInput ? { needs_input: needsInput } : {}),
  };
}
