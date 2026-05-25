/**
 * Capture the raw Claude Code session JSONL for a task into lazy storage.
 *
 * Runs on task close (accept/reject/close/abandon) right before the worktree
 * is removed. Unlike `captureConversation` — which parses the JSONL into a
 * searchable `StoredConversation` — this preserves the byte-for-byte transcript
 * so the session can later be rehydrated and resumed via `claude --resume`.
 *
 * The JSONL can live in one of two places, depending on the runner:
 *  - host-process runner: `~/.claude/projects/<encoded>/<sessionId>.jsonl`
 *  - docker/sandbox runner: `<worktree>/.lazy-task-sandbox/.claude/projects/<encoded>/<sessionId>.jsonl`
 *
 * The sandbox copy disappears with the worktree, so we must capture before
 * cleanup. We check the sandbox first (it's the source of truth for sandboxed
 * runs) and fall back to the host location.
 */

import { join } from 'path';
import { readFile } from 'fs/promises';
import { getHome } from '../utils/home';
import { encodeProjectPath } from './claude-code-logs';
import { pathExists } from '../utils/fs';
import { logger } from '../utils/logger';
import type { Storage } from '../storage';

const SANDBOX_DIR = '.lazy-task-sandbox';

/**
 * Discover and persist the raw agent session JSONL for a task.
 *
 * Designed to never throw: a missing log is a normal condition (the task may
 * never have run an agent turn) and is skipped with a debug log; any other
 * failure is logged loudly (it must not crash the close operation) but is not
 * propagated. The session id is the Claude Code session id stored on the
 * task's session (`sess.agent_session_id`).
 */
export async function captureAgentSessionLog(
  storage: Storage,
  taskId: string,
  sessionId: string | null | undefined,
  worktreePath: string,
): Promise<void> {
  if (!sessionId) {
    logger.debug(`No agent session id for task ${taskId}; skipping session log capture`);
    return;
  }

  const encoded = encodeProjectPath(worktreePath);
  const candidates = [
    join(worktreePath, SANDBOX_DIR, '.claude', 'projects', encoded, `${sessionId}.jsonl`),
    join(getHome(), '.claude', 'projects', encoded, `${sessionId}.jsonl`),
  ];

  let sourcePath: string | null = null;
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      sourcePath = candidate;
      break;
    }
  }

  if (!sourcePath) {
    // Normal condition — no JSONL on disk (e.g. task never ran an agent turn).
    logger.debug(
      `No session JSONL found for task ${taskId} (session ${sessionId}); ` +
      `checked: ${candidates.join(', ')}`,
    );
    return;
  }

  try {
    const content = await readFile(sourcePath, 'utf-8');
    await storage.saveAgentSessionLog(taskId, sessionId, content);
    logger.debug(`Captured agent session log for task ${taskId} from ${sourcePath}`);
  } catch (err) {
    // The file existed but could not be read or saved — surface loudly so it
    // can be debugged, but do not crash the close operation.
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      `Failed to capture agent session log for task ${taskId} from ${sourcePath}: ${msg}`,
    );
  }
}
