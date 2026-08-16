/**
 * Shared conversation capture logic.
 *
 * Snapshots Claude Code JSONL session files before and after an interactive
 * session, then parses and stores any new or modified conversation into
 * lazy's storage. Used by both the host-process runner (builder sessions)
 * and the pair command (branchless pairing).
 *
 * A single builder/pairing run is NOT one JSONL file: Claude Code opens a
 * fresh `<uuid>.jsonl` on `/clear`, on compaction, and on resume. Capturing
 * only one file silently drops every other segment — so capture iterates the
 * FULL set of new-or-modified files for the project and persists each.
 */

import {
  discoverProjectSessionFiles,
  parseConversation,
  extractSummary,
  conversationStats,
  type SessionFileInfo,
} from './claude-code-logs';
import { excludeMachineOneshots } from './machine-oneshot';
import { toStoredConversation } from './conversation-storage';
import type { Storage } from '../storage';
import { tryRemoteStorage } from '../cli/helpers';
import { logger } from '../utils/logger';

/**
 * A point-in-time snapshot of a project's session files, keyed by sessionId.
 * Records mtime + size so a later snapshot can be diffed to find which files
 * a session actually wrote to (a touched-but-grown file is "modified").
 */
export type SessionSnapshot = Map<string, { mtimeMs: number; size: number }>;

/**
 * Snapshot all JSONL session files for a project.
 *
 * Async (per CLAUDE.md: no sync fs). Returns a map of sessionId →
 * {mtimeMs, size}.
 */
export async function snapshotSessionFiles(lazyRoot: string): Promise<SessionSnapshot> {
  const files = await excludeMachineOneshots(await discoverProjectSessionFiles(lazyRoot));
  const snapshot: SessionSnapshot = new Map();
  for (const f of files) {
    snapshot.set(f.sessionId, { mtimeMs: f.mtimeMs, size: f.size });
  }
  return snapshot;
}

/**
 * A file is "owned" by the current run if it did not exist before the run
 * started, or if it grew / changed mtime since then. Pre-existing, untouched
 * files belong to earlier sessions and must not be re-captured.
 */
function isNewOrModified(file: SessionFileInfo, before: SessionSnapshot): boolean {
  const prior = before.get(file.sessionId);
  if (prior === undefined) return true;
  return file.size !== prior.size || file.mtimeMs !== prior.mtimeMs;
}

export interface CaptureResult {
  /** Session IDs successfully persisted this call. */
  captured: string[];
  /** The newest (latest-mtime) owned session — the one a resume should target. */
  newestSessionId: string | null;
  /** Per-file capture errors (sessionId + error). Empty when all succeeded. */
  errors: Array<{ sessionId: string; error: Error }>;
}

/**
 * Parse and persist EVERY session file that is new or modified relative to
 * `before`, optionally skipping files that are unchanged since they were last
 * captured (`alreadyCaptured`, used by the incremental monitor to avoid
 * redundant re-saves).
 *
 * Each file is captured independently: a failure on one is recorded and
 * surfaced via the returned `errors` array, but does not prevent the others
 * from being saved. Capture is load-bearing for "never lose history" — callers
 * MUST inspect `errors` and surface them; they are never swallowed here.
 *
 * `alreadyCaptured`, when provided, is mutated in place to reflect what was
 * just persisted so the next incremental pass skips unchanged files.
 */
export async function captureNewOrModifiedConversations(
  lazyRoot: string,
  before: SessionSnapshot,
  storage: Storage,
  alreadyCaptured?: SessionSnapshot,
): Promise<CaptureResult> {
  // lazy's own machine one-shots are not conversations and are never owned by
  // this run, even though they are written into the same dir while it runs (a
  // fidelity summary from an accept made during the session). Excluding them
  // here keeps them out of the store AND out of `newestSessionId`, which callers
  // use as the resume target. See src/import/machine-oneshot.ts.
  const files = await excludeMachineOneshots(await discoverProjectSessionFiles(lazyRoot));

  const owned = files.filter(f => isNewOrModified(f, before));

  const captured: string[] = [];
  const errors: Array<{ sessionId: string; error: Error }> = [];

  let newest: SessionFileInfo | null = null;
  for (const file of owned) {
    if (!newest || file.mtimeMs > newest.mtimeMs) newest = file;

    // Skip files unchanged since we last persisted them (incremental mode).
    const last = alreadyCaptured?.get(file.sessionId);
    if (last && last.size === file.size && last.mtimeMs === file.mtimeMs) {
      continue;
    }

    try {
      const conversation = await parseConversation(file.projectPath, file.sessionId);
      // A brand-new JSONL may exist with no parseable messages yet (Claude
      // writes the file before the first turn lands). Don't persist an empty
      // shell — wait for a later pass once it has content.
      if (conversation.messages.length === 0) continue;

      const summary = extractSummary(conversation);
      const stats = conversationStats(conversation);
      const stored = toStoredConversation(conversation, summary, stats);
      await storage.saveConversation(stored);

      captured.push(file.sessionId);
      alreadyCaptured?.set(file.sessionId, { mtimeMs: file.mtimeMs, size: file.size });
    } catch (err) {
      errors.push({ sessionId: file.sessionId, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  return { captured, newestSessionId: newest?.sessionId ?? null, errors };
}

/**
 * Capture all conversations from a finished interactive session by diffing
 * before/after snapshots and persisting every new-or-modified JSONL file.
 *
 * @param lazyRoot - The lazy project root directory
 * @param beforeSnapshot - Snapshot taken before the session started
 * @param label - Label for log messages (e.g. "Builder", "Pairing")
 * @param existingStorage - Optional pre-existing Storage instance to use
 * @returns The newest detected session ID (for resume), or null if none found
 */
export async function captureConversation(
  lazyRoot: string,
  beforeSnapshot: SessionSnapshot,
  label: string = 'session',
  existingStorage?: Storage,
): Promise<string | null> {
  // Use provided storage, or connect to the daemon via RemoteStorage.
  // Never create FileStorage directly — only the daemon owns the storage lock.
  const storage = existingStorage ?? await tryRemoteStorage(lazyRoot);
  if (!storage) {
    // Daemon unavailable IS a capture failure — surface it loudly. The session
    // already exited so there's nothing to abort, but the user must know their
    // conversation was not saved (it remains in ~/.claude/projects and can be
    // imported later with `lazy import-conversation`).
    logger.error(`Failed to capture ${label} conversation: daemon is not running — conversation was NOT saved.`);
    return null;
  }

  let result: CaptureResult;
  try {
    result = await captureNewOrModifiedConversations(lazyRoot, beforeSnapshot, storage);
  } finally {
    if (!existingStorage) await storage.close();
  }

  if (result.errors.length > 0) {
    for (const { sessionId, error } of result.errors) {
      logger.error(`Failed to capture ${label} conversation ${sessionId.substring(0, 8)}: ${error.message}`);
    }
  }
  if (result.captured.length > 0) {
    logger.debug(`${label} conversations captured: ${result.captured.map(s => s.substring(0, 8)).join(', ')}`);
  }

  return result.newestSessionId;
}
