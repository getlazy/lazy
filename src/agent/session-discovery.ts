/**
 * Find the active Claude Code session for a runner's project directory.
 *
 * Claude writes one JSONL file per session under
 * `<projectDir>/<session-id>.jsonl`. The filename (minus `.jsonl`) is the
 * session id, and the most recently modified file is the active one.
 *
 * WHERE `projectDir` lives depends on the runner (its HOME differs), so this
 * helper does NOT compute it — the caller asks the runner via
 * `runner.agentSessionProjectDir(worktreePath)` and passes the result in. That
 * keeps every caller (watch, work.ts, the activity monitor) runner-agnostic
 * and the runner the single source of truth for its own session-log location.
 *
 * This scanning logic was previously duplicated in `cli/commands/watch.ts` and
 * `cli/activity-monitor.ts`; it now lives here so the supervisor can use it
 * too — see GracefulExitTimeoutError handling in `supervisor/work.ts`.
 */

import { readdir, stat } from 'fs/promises';
import { basename, join } from 'path';
import { pathExists } from '../utils/fs';

export interface SessionFileInfo {
  /** Absolute path of the JSONL file. */
  path: string;
  /** Claude session id (the filename minus `.jsonl`). */
  sessionId: string;
  /** mtime of the file in ms since epoch. */
  mtimeMs: number;
}

/**
 * Return the most recently modified Claude Code JSONL session file in the
 * given project directory, or null if none exists yet (e.g. the agent hasn't
 * started writing logs, or the directory doesn't exist).
 *
 * When `minMtimeMs` is provided, only files modified at or after that time
 * are considered — used by the supervisor to ignore stale sessions from a
 * previous turn.
 */
export async function findLatestSessionFile(
  projectDir: string,
  minMtimeMs?: number,
): Promise<SessionFileInfo | null> {
  if (!(await pathExists(projectDir))) return null;

  let latest: SessionFileInfo | null = null;

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    // Directory was removed between pathExists() and readdir() — rare race
    // during agent restart. Safe to return null and let the caller retry.
    return null;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const fullPath = join(projectDir, entry);
    try {
      const st = await stat(fullPath);
      if (minMtimeMs !== undefined && st.mtimeMs < minMtimeMs) continue;
      if (!latest || st.mtimeMs > latest.mtimeMs) {
        latest = {
          path: fullPath,
          sessionId: basename(entry, '.jsonl'),
          mtimeMs: st.mtimeMs,
        };
      }
    } catch {
      // File may have been deleted or rotated between readdir and stat.
      // Safe to skip — callers that poll will pick it up on the next pass.
    }
  }

  return latest;
}
