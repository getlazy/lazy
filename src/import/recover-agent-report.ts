/**
 * Recover the agent's written report for a turn from the Claude Code session
 * JSONL that already exists on disk.
 *
 * Why this exists — incremental turn persistence:
 *
 * An agent turn (including the agent's written report) is normally persisted to
 * storage only in the single finalize step (`handleCompletedResponse`), driven
 * by the supervisor writing `response.json`. If that finalize never produces a
 * processable response (crash / kill / OOM / teardown / hang at finalize), the
 * report text — which only ever lived in that response — is lost, and stranded
 * recovery can do no better than drop a placeholder.
 *
 * But Claude Code writes the transcript JSONL incrementally as the agent
 * produces text. That transcript IS a durable, incremental record of the turn's
 * report, written long before (and independently of) finalize. So instead of
 * inventing a new write path, recovery reads the report back from the transcript
 * that is already on disk. This is the "persist as produced" guarantee: the
 * words survive a lost or late finalize because Claude Code already wrote them
 * down as they were produced.
 *
 * The JSONL lives in one of two places, depending on the runner (mirrors
 * `captureAgentSessionLog`):
 *   - docker/sandbox runner: `<worktree>/.lazy-task-sandbox/.claude/projects/<encoded>/<sessionId>.jsonl`
 *   - host-process runner:   `~/.claude/projects/<encoded>/<sessionId>.jsonl`
 */

import { join } from 'path';
import { readFile, readdir } from 'fs/promises';
import { getHome } from '../utils/home';
import { encodeProjectPath, createParseState, parseJsonlLines } from './claude-code-logs';
import { pathExists } from '../utils/fs';
import { logger } from '../utils/logger';

const SANDBOX_DIR = '.lazy-task-sandbox';

/**
 * Best-effort extraction of the agent's written report for a stranded turn from
 * the Claude Code session JSONL on disk.
 *
 * We scan EVERY transcript in the worktree's project directory — not just
 * `<sessionId>.jsonl` — because:
 *   - a stranded FIRST turn never recorded its session id in storage
 *     (`agent_session_id` is set from the response that was never written), and
 *   - Claude Code opens a fresh JSONL file on resume / compaction, so the
 *     report may live in a file whose name is not the stored session id.
 * When the session id IS known it is preferred, but discovery still falls back
 * to every file so the realistic "no stored id" case is covered.
 *
 * ## Watermark
 *
 * The transcript is a rolling record of the WHOLE session — every turn's text,
 * not just this one's. Taking "the latest assistant message" is wrong when a
 * turn strands having produced NO report (a crash before the agent wrote
 * anything): the latest message is then the PREVIOUS turn's report, which would
 * be misattributed to this turn under a "[Recovered]" banner.
 *
 * `sinceTimestampMs` is a message-level watermark — the timestamp of the last
 * finalized turn already persisted to storage. When provided, recovery returns
 * only assistant text NEWER than that watermark (i.e. this turn's content, and
 * any earlier-stranded turns since the last finalize), joined in order. If
 * nothing is newer, it returns null so the caller correctly falls back to the
 * placeholder instead of resurfacing stale text. A timestamp (not a line
 * number) is used deliberately: the transcript is not one append-only file, so
 * a line offset would be ambiguous across the rolling file set.
 *
 * With no watermark (a stranded FIRST turn — there is no prior turn to confuse
 * this one with) recovery falls back to the latest-timestamped assistant
 * message, the historical behavior.
 *
 * Never throws — recovery must proceed even when the transcript is missing or
 * unreadable. Returns the trimmed report text, or null when nothing usable is
 * found (the caller then falls back to its placeholder).
 */
export async function readAgentReportFromSessionLog(
  worktreePath: string,
  sessionId: string | null | undefined,
  sinceTimestampMs?: number | null,
): Promise<string | null> {
  try {
    const encoded = encodeProjectPath(worktreePath);
    const projectDirs = [
      join(worktreePath, SANDBOX_DIR, '.claude', 'projects', encoded),
      join(getHome(), '.claude', 'projects', encoded),
    ];

    // Collect candidate JSONL files across both possible project locations.
    // Prefer the named session file when we know it, but always include every
    // top-level transcript in the directory (see doc comment for why).
    const files: string[] = [];
    const seen = new Set<string>();
    const addFile = (path: string): void => {
      if (!seen.has(path)) {
        seen.add(path);
        files.push(path);
      }
    };

    for (const dir of projectDirs) {
      if (sessionId) {
        const named = join(dir, `${sessionId}.jsonl`);
        if (await pathExists(named)) addFile(named);
      }
      try {
        const entries = await readdir(dir);
        for (const entry of entries) {
          if (entry.endsWith('.jsonl')) addFile(join(dir, entry));
        }
      } catch {
        // Directory absent — normal (this runner kind / location wasn't used).
      }
    }

    if (files.length === 0) return null;

    // Parse every candidate and collect all assistant messages that carry text
    // (tool-only assistant messages are skipped). Across the rolling file set
    // these are the session's full sequence of agent reports/narration.
    const messages: { text: string; timestamp: string }[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, 'utf-8');
      } catch {
        continue; // File vanished or unreadable — skip it.
      }
      const state = createParseState();
      parseJsonlLines(content, state);
      for (const m of state.messages) {
        if (m.role !== 'assistant') continue;
        const text = m.text.trim();
        if (!text) continue;
        messages.push({ text, timestamp: m.timestamp ?? '' });
      }
    }

    if (messages.length === 0) return null;

    // Watermark mode: recover only content NEWER than the last finalized turn.
    // Everything at or before the watermark was already consumed by a prior
    // finalize, so resurfacing it would misattribute old text to this turn.
    if (typeof sinceTimestampMs === 'number' && Number.isFinite(sinceTimestampMs)) {
      const fresh = messages
        .filter((m) => {
          const ms = Date.parse(m.timestamp);
          return Number.isFinite(ms) && ms > sinceTimestampMs;
        })
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      // Nothing new since the last finalize → caller falls back to placeholder
      // rather than resurfacing a stale (previous-turn) report.
      if (fresh.length === 0) return null;
      // Join everything produced since the last finalize, in order — this also
      // recovers multiple stranded turns in a row, not just the last one.
      return fresh.map((m) => m.text).join('\n\n');
    }

    // No watermark (stranded FIRST turn): keep the historical behavior of
    // taking the latest-timestamped assistant message as the turn's report.
    let best: { text: string; timestamp: string } | null = null;
    for (const m of messages) {
      if (!best || m.timestamp >= best.timestamp) best = m;
    }
    return best?.text ?? null;
  } catch (err) {
    // Defensive: any unexpected failure degrades to the placeholder, never a
    // thrown error that would abort recovery.
    logger.debug(
      `readAgentReportFromSessionLog failed for ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
