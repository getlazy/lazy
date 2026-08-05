/**
 * Live conversation capture sweep — the host-side half of capture.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now the only LIVE capture path was the in-container builder supervisor
 * (src/supervisor/builder.ts), which watches the projects dir it can see from
 * inside the container. That covers the builder's own Claude session and
 * nothing else. But lazy itself runs Claude on the HOST, outside any builder
 * container: `runClaudeOneshot` (PR/commit fidelity summaries on every accept,
 * `lazy report`, LLM memory compaction) spawns `claude -p` with the host's HOME
 * and the repo as cwd, so Claude writes a session JSONL into the shared
 * `~/.claude/projects/<encoded-repo>/` dir. Nothing captured those. They only
 * ever reached the store when a human ran `lazy doctor --reimport-conversations`
 * — which is exactly why a reimport keeps finding SAME-DAY conversations that
 * "live capture missed". Sessions a human starts by running `claude` in the repo
 * directly have always been in the same boat.
 *
 * The sweep closes that gap at the only place that can see every root: the
 * daemon. It reuses the reimport discovery/parse machinery (so on-disk layout
 * knowledge lives in exactly one place) and persists through the Storage
 * interface it is handed.
 *
 * It is also a backstop for the builder supervisor: the isolation dirs are on
 * the host too, so if in-container capture ever rots again, the sweep still
 * lands those conversations.
 *
 * COST DISCIPLINE
 * ---------------
 * Parsing every session on every tick would be minutes of CPU (a long-running
 * builder JSONL is multiple MB and history runs to hundreds of files), so the
 * sweep parses a session only when it has to:
 *
 *   - not in the store yet                        → parse and save
 *   - seen before by this cursor and changed      → parse and save (re-save
 *     keeps a long-running session's stored copy current mid-run)
 *   - first sighting of a session already stored  → record its stat, parse
 *     nothing (this is what keeps daemon start cheap)
 *
 * Discovery is readdir + stat, plus one small head-read per unique session to
 * recognize lazy's own machine-generated one-shots and skip them entirely
 * (see src/import/machine-oneshot.ts). Those runs — the fidelity summary on
 * every accept, `lazy report`, LLM memory compaction — are housekeeping, not
 * conversations, and used to make up the bulk of the store.
 */

import {
  discoverCandidateSessionsPartitioned,
  type ReimportOptions,
} from './reimport-conversations';
import { parseConversation, extractSummary, conversationStats } from './claude-code-logs';
import { toStoredConversation } from './conversation-storage';
import type { Storage } from '../storage/interface';

/** Size/mtime of a session file the last time the sweep looked at it. */
interface SeenFile {
  size: number;
  mtimeMs: number;
}

/**
 * Per-process memory of what the sweep has already looked at. Held by the
 * caller (the daemon) so it survives between ticks and dies with the process —
 * a cold start simply re-seeds it, which is correct and cheap.
 */
export type SweepCursor = Map<string, SeenFile>;

export function createSweepCursor(): SweepCursor {
  return new Map();
}

export interface SweepResult {
  /** Unique sessions discovered on disk this tick. */
  scanned: number;
  /** Sessions parsed and persisted this tick. */
  captured: string[];
  /** Sessions skipped because the JSONL held no parseable messages yet. */
  skippedEmpty: string[];
  /**
   * Machine-generated lazy one-shots skipped by design (fidelity summaries,
   * `lazy report`, LLM memory compaction). Counted so the daemon can say what it
   * ignored instead of pretending it never saw them.
   */
  skippedMachineOneshots: number;
  /** Per-session failures — returned for the caller to log, never swallowed. */
  errors: Array<{ sessionId: string; error: Error }>;
}

/**
 * Run one capture sweep. Idempotent and safe to call on a timer.
 *
 * Failures are per-session: one unreadable or half-written JSONL can never stop
 * the rest of the sweep, and every failure is reported back to the caller.
 */
export async function sweepConversations(
  opts: ReimportOptions & { storage: Storage; cursor: SweepCursor },
): Promise<SweepResult> {
  const { storage, cursor } = opts;
  const { capturable: candidates, machineOneshots } = await discoverCandidateSessionsPartitioned(opts);

  const result: SweepResult = {
    scanned: candidates.length,
    captured: [],
    skippedEmpty: [],
    skippedMachineOneshots: machineOneshots.length,
    errors: [],
  };

  for (const c of candidates) {
    const stat: SeenFile = { size: c.size, mtimeMs: c.mtimeMs };
    const seen = cursor.get(c.sessionId);
    try {
      if (seen && seen.size === stat.size && seen.mtimeMs === stat.mtimeMs) {
        continue; // Unchanged since the last look — nothing to do.
      }

      // First sighting of a session that is already stored: adopt its stat as
      // the baseline instead of re-parsing history on every daemon start. A
      // later modification still lands, because the cursor now has a baseline
      // to compare against.
      if (!seen && (await storage.isConversationImported(c.sessionId))) {
        cursor.set(c.sessionId, stat);
        continue;
      }

      const conversation = await parseConversation(c.projectPath, c.sessionId, c.projectsDirRoot);
      if (conversation.messages.length === 0) {
        // An empty shell (Claude created the file before any turn landed).
        // Don't persist a content-free stub; leave the cursor unset so the next
        // sweep re-examines it once it has content.
        result.skippedEmpty.push(c.sessionId);
        continue;
      }

      const summary = extractSummary(conversation);
      const stats = conversationStats(conversation);
      await storage.saveConversation(toStoredConversation(conversation, summary, stats));

      cursor.set(c.sessionId, stat);
      result.captured.push(c.sessionId);
    } catch (err) {
      // Leave the cursor unset for this session so a transient failure is
      // retried on the next tick rather than silently marked as handled.
      result.errors.push({
        sessionId: c.sessionId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return result;
}
