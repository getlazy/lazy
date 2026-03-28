/**
 * Shared conversation capture logic.
 *
 * Snapshots Claude Code JSONL session files before and after an interactive
 * session, then parses and stores any new or modified conversation into
 * lazy's storage. Used by both the host-process runner (builder sessions)
 * and the pair command (branchless pairing).
 */

import { join } from 'path';
import { homedir } from 'os';
import { readdirSync, statSync } from 'fs';
import {
  encodeProjectPath,
  discoverAllProjectSessions,
  parseConversation,
  extractSummary,
  conversationStats,
} from './claude-code-logs';
import { toStoredConversation } from './conversation-storage';
import { createStorage } from '../storage';
import { logger } from '../utils/logger';

/**
 * Snapshot mtime of all JSONL session files for a project.
 * Returns a map of filename → mtime (ms).
 */
export function snapshotSessionFiles(lazyRoot: string): Map<string, number> {
  const encodedPath = encodeProjectPath(lazyRoot);
  const projectDir = join(homedir(), '.claude', 'projects', encodedPath);
  const times = new Map<string, number>();

  try {
    const entries = readdirSync(projectDir);
    for (const entry of entries) {
      if (entry.endsWith('.jsonl')) {
        try {
          const mtime = statSync(join(projectDir, entry)).mtimeMs;
          times.set(entry, mtime);
        } catch {
          // Skip inaccessible files
        }
      }
    }
  } catch {
    // Project directory doesn't exist yet
  }

  return times;
}

/**
 * Find the newest JSONL file that was created or modified between two snapshots.
 * Returns the filename (e.g. "uuid.jsonl") or null.
 */
function findNewOrModifiedFile(
  before: Map<string, number>,
  after: Map<string, number>,
): string | null {
  let newestFile: string | null = null;
  let newestMtime = 0;

  for (const [file, mtime] of after) {
    const beforeMtime = before.get(file);
    if (beforeMtime === undefined || mtime !== beforeMtime) {
      if (mtime > newestMtime) {
        newestMtime = mtime;
        newestFile = file;
      }
    }
  }

  return newestFile;
}

/**
 * Capture a conversation from JSONL files by comparing before/after snapshots.
 * Parses the conversation and stores it in lazy's storage.
 *
 * @param lazyRoot - The lazy project root directory
 * @param beforeSnapshot - Snapshot taken before the session started
 * @param label - Label for log messages (e.g. "builder", "pairing")
 * @returns The detected session ID, or null if no new conversation was found
 */
export async function captureConversation(
  lazyRoot: string,
  beforeSnapshot: Map<string, number>,
  label: string = 'session',
): Promise<string | null> {
  const afterSnapshot = snapshotSessionFiles(lazyRoot);
  const sessionFile = findNewOrModifiedFile(beforeSnapshot, afterSnapshot);

  if (!sessionFile) {
    return null;
  }

  const sessionId = sessionFile.replace(/\.jsonl$/, '');

  try {
    const available = await discoverAllProjectSessions(lazyRoot);
    const match = available.find(s => s.sessionId === sessionId);

    if (match) {
      const storage = await createStorage(lazyRoot);
      try {
        const conversation = await parseConversation(match.projectPath, match.sessionId);
        const summary = extractSummary(conversation);
        const stats = conversationStats(conversation);
        const stored = toStoredConversation(conversation, summary, stats);
        await storage.saveConversation(stored);
        logger.debug(`${label} conversation captured: ${sessionId}`);
      } finally {
        await storage.close();
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to capture ${label} conversation: ${msg}`);
  }

  return sessionId;
}
