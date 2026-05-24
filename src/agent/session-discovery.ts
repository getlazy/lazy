/**
 * Find the active Claude Code session for a worktree.
 *
 * Claude writes one JSONL file per session under
 * `<worktree>/.lazy-task-sandbox/.claude/projects/<encodedPath>/<session-id>.jsonl`
 * (the sandbox is the in-container HOME). The filename (minus `.jsonl`) is
 * the session id, and the most recently modified file is the active one.
 *
 * This logic was previously duplicated in `cli/commands/watch.ts` and
 * `cli/activity-monitor.ts`; it now lives here so the supervisor can use it
 * too — see GracefulExitTimeoutError handling in `supervisor/work.ts`.
 */

import { readdir, stat } from 'fs/promises';
import { basename, join } from 'path';
import { encodeProjectPath } from '../import/claude-code-logs';
import { pathExists } from '../utils/fs';

const SANDBOX_DIR = '.lazy-task-sandbox';

export interface SessionFileInfo {
  /** Absolute path of the JSONL file. */
  path: string;
  /** Claude session id (the filename minus `.jsonl`). */
  sessionId: string;
  /** mtime of the file in ms since epoch. */
  mtimeMs: number;
}

/**
 * Return the most recently modified Claude Code JSONL session file for the
 * given worktree, or null if none exists yet (e.g. the agent hasn't started
 * writing logs).
 *
 * When `minMtimeMs` is provided, only files modified at or after that time
 * are considered — used by the supervisor to ignore stale sessions from a
 * previous turn.
 */
export async function findLatestSessionFile(
  worktreePath: string,
  minMtimeMs?: number,
): Promise<SessionFileInfo | null> {
  const encodedPath = encodeProjectPath(worktreePath);
  const projectDir = join(worktreePath, SANDBOX_DIR, '.claude', 'projects', encodedPath);

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
