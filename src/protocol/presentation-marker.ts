/**
 * `presentation.json` — the protocol-dir marker for "a presentation was declared
 * for this task" (final-turn design §6.2, slice 3).
 *
 * WHY A FILE. The wrap-up's presentation step — which runs on every park a human
 * faces, not only on a final — waits for the agent to author the report's
 * presentation (§6.1) via `lazy_report`. It
 * is the DAEMON that executes that MCP call, and the SUPERVISOR — running
 * inside the task container — that has to check whether it happened. The
 * supervisor cannot read lazy state: its only channels are the bind-mounted
 * protocol dir and the worktree. So the daemon drops this marker into
 * `protocolDir(taskId)` — the same directory it already writes `final.json`
 * into and the supervisor already polls.
 *
 * THE MARKER IS A SIGNAL, NEVER THE RECORD. Nothing answers "did this task
 * present?" by reading this file — the durable answer lives in the task's
 * stored report (`TurnReport.presentation`), which the reviewer surfaces render.
 * The marker exists so a step that runs OUTSIDE the daemon can gate on the
 * event; once the step has read it, it has no further meaning. It is cleared
 * before the present invocation and dropped by `cleanProtocol` at teardown, and
 * nothing anywhere may treat its absence after teardown as "not presented".
 *
 * NO SERIALIZATION CHAIN, DELIBERATELY. `final.json` merges two halves per
 * invocation and must be read-modify-write under the daemon's per-task registry.
 * This marker has one fact to state — "declared, at T" — and the whole file is
 * written atomically (temp + rename), so two concurrent `lazy_report` calls
 * racing here both mean "declared"; last writer wins and neither loses the
 * fact. A read-modify-write would add a merge for no information.
 */

import { join } from 'path';
import { mkdir, readFile, writeFile, rename, unlink } from 'fs/promises';
import { logger } from '../utils/logger';
import { protocolDir } from './io';

export const PRESENTATION_MARKER_FILE = 'presentation.json';

/** What the marker file states: a declaration happened. */
export interface PresentationMarkerFile {
  version: 1;
  /** ISO timestamp the declaration was recorded (from the report that carried it). */
  declared_at: string;
}

function markerPath(protoDir: string): string {
  return join(protoDir, PRESENTATION_MARKER_FILE);
}

/** Write the marker whole. Atomic (temp + rename) so no reader sees a half-file. */
export async function writePresentationMarker(protoDir: string, declaredAt?: string): Promise<void> {
  await mkdir(protoDir, { recursive: true });
  const file: PresentationMarkerFile = {
    version: 1,
    declared_at: declaredAt ?? new Date().toISOString(),
  };
  const target = markerPath(protoDir);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
  await rename(tmp, target);
}

/**
 * The daemon-side convenience for the `lazy_report` handler: mark that the
 * current report of the given task declared its presentation.
 *
 * Best-effort by contract: callers wrap it in their own try/catch, because a
 * failed marker write must not fail the report call itself — a false "not
 * declared" only parks the wrap-up's presentation step once, visibly, while a
 * swallowed report call would lose the agent's entire report.
 */
export async function recordPresentationDeclared(taskId: string): Promise<void> {
  await writePresentationMarker(protocolDir(taskId));
}

/**
 * Remove the marker. Missing file is success.
 *
 * Never throws: this runs before the present invocation, and a marker that
 * cannot be cleared must not fail the turn — but it IS warned about, because a
 * surviving stale marker is precisely the false "declared" the clear exists to
 * prevent (final-turn design §13.10 analog).
 */
export async function clearPresentationMarker(
  protoDir: string,
  log?: (message: string) => void,
): Promise<void> {
  try {
    await unlink(markerPath(protoDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    const message = `presentation-marker: failed to clear ${markerPath(protoDir)}: ${(err as Error).message}`;
    if (log) log(message);
    else logger.warn(message);
  }
}

/**
 * Read the marker, or null when no declaration is on record.
 *
 * Degrades to null for every untrustworthy case — missing (the normal one),
 * corrupt, or a shape this version does not understand. "I could not read it"
 * must mean "not declared" — the wrap-up step treats that as failure and parks
 * the task, which is the recoverable direction (a false positive would wave a
 * task through its reader-facing step with no presentation at all).
 */
export async function readPresentationMarker(
  protoDir: string,
  log?: (message: string) => void,
): Promise<PresentationMarkerFile | null> {
  const filePath = markerPath(protoDir);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const message = `presentation-marker: failed to read ${filePath}: ${(err as Error).message}`;
    if (log) log(message);
    else logger.warn(message);
    return null;
  }

  let parsed: PresentationMarkerFile;
  try {
    parsed = JSON.parse(raw) as PresentationMarkerFile;
  } catch (err) {
    const message = `presentation-marker: corrupt ${filePath}: ${(err as Error).message}`;
    if (log) log(message);
    else logger.warn(message);
    return null;
  }

  const declaredAt = parsed.declared_at;
  if (parsed.version !== 1 || typeof declaredAt !== 'string' || !declaredAt.trim()) {
    const message = `presentation-marker: unrecognized shape in ${filePath} — treating as not declared`;
    if (log) log(message);
    else logger.warn(message);
    return null;
  }
  return { version: 1, declared_at: declaredAt };
}