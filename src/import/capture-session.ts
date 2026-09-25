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
import { toStoredConversation, saveConversationWithoutRegression } from './conversation-storage';
import { parsePiSessionFile, statPiSessionFiles, type PiSessionFileInfo } from './pi-session-logs';
import type { ParsedConversation } from './claude-code-logs';
import { getAgent } from '../agent/registry';
import type { Storage } from '../storage';
import { tryRemoteStorage } from '../preconditions';
import { logger } from '../utils/logger';
import { join } from 'path';
import { SANDBOX_DIR } from '../utils/sandbox';

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

// --- Pi task sessions ---
//
// Pi tasks run in a container whose HOME is the worktree's sandbox mount, so
// their session files live at `<worktree>/.lazy-task-sandbox/.pi/agent/
// sessions/...` — a different tree from Claude's `~/.claude/projects/`, in
// pi's own documented format (parsed by src/import/pi-session-logs.ts).
// Discovery goes through PiAgent.discoverSessionFiles so the on-disk layout
// stays known in exactly one place.

function discoverPiTaskSessionFiles(worktreePath: string): string[] {
  return getAgent('pi').discoverSessionFiles({
    configDir: join(worktreePath, SANDBOX_DIR, '.pi'),
  });
}

/**
 * Snapshot the pi session files in a task's sandbox, keyed by session id.
 * The pi analogue of {@link snapshotSessionFiles}, for diffing after a
 * pairing session ends.
 */
export async function snapshotPiTaskSessionFiles(worktreePath: string): Promise<SessionSnapshot> {
  const files = await statPiSessionFiles(discoverPiTaskSessionFiles(worktreePath));
  const snapshot: SessionSnapshot = new Map();
  for (const f of files) {
    snapshot.set(f.sessionId, { mtimeMs: f.mtimeMs, size: f.size });
  }
  return snapshot;
}

/** {@link CaptureResult} plus the conversations capture actually parsed. */
export interface PiCaptureResult extends CaptureResult {
  /**
   * Every owned conversation that had messages, oldest file first. Returned so
   * a caller that wants the transcript (pairing's summary) reads what capture
   * already parsed, instead of re-discovering a file by session id: a stored
   * id can name a file this pairing never touched, and a pairing that wrote
   * more than one session file (a daemon restart relaunches the agent) has
   * more than one transcript to summarize.
   */
  conversations: ParsedConversation[];
}

/**
 * Parse and persist every pi session file in the task sandbox that is new or
 * modified relative to `before` — the pi analogue of
 * {@link captureNewOrModifiedConversations}, with the same error posture:
 * per-file failures are returned, never swallowed, and one bad file does not
 * stop the others. Saves go through the no-regression guard so a stale copy
 * can never shorten a stored conversation.
 */
export async function capturePiTaskConversations(
  worktreePath: string,
  before: SessionSnapshot,
  storage: Storage,
): Promise<PiCaptureResult> {
  const files = await statPiSessionFiles(discoverPiTaskSessionFiles(worktreePath));

  const isOwned = (file: PiSessionFileInfo): boolean => {
    const prior = before.get(file.sessionId);
    if (prior === undefined) return true;
    return file.size !== prior.size || file.mtimeMs !== prior.mtimeMs;
  };
  // Oldest first, so the returned conversations read in the order they were
  // written when one pairing produced more than one session file.
  const owned = files.filter(isOwned).sort((a, b) => a.mtimeMs - b.mtimeMs);

  const captured: string[] = [];
  const errors: Array<{ sessionId: string; error: Error }> = [];
  const conversations: ParsedConversation[] = [];

  // Newest OWNED file, parsed or not — the same contract as the Claude
  // function above: `newestSessionId` is the RESUME target (the file the agent
  // would append to next), not a receipt of what was captured. An empty shell
  // or an unparseable file is still the one a resume continues; `captured` and
  // `conversations` answer the other question.
  let newest: PiSessionFileInfo | null = null;
  for (const file of owned) {
    if (!newest || file.mtimeMs > newest.mtimeMs) newest = file;

    let conversation: ParsedConversation;
    try {
      conversation = await parsePiSessionFile(file.filePath);
    } catch (err) {
      errors.push({ sessionId: file.sessionId, error: err instanceof Error ? err : new Error(String(err)) });
      continue;
    }

    // A session file may exist with only header/settings entries and no
    // conversation yet — same rule as Claude capture: don't persist an empty
    // shell.
    if (conversation.messages.length === 0) continue;

    // Collected BEFORE the save is attempted, deliberately: persisting and
    // summarizing are independent, so a storage failure must not also cost the
    // caller the transcript it would have summarized.
    conversations.push(conversation);

    try {
      const summary = extractSummary(conversation);
      const stats = conversationStats(conversation);
      const stored = toStoredConversation(conversation, summary, stats);
      await saveConversationWithoutRegression(storage, stored);
      captured.push(conversation.sessionId);
    } catch (err) {
      errors.push({ sessionId: conversation.sessionId, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }

  return { captured, newestSessionId: newest?.sessionId ?? null, errors, conversations };
}
