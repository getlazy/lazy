/**
 * Pi session JSONL parser.
 *
 * Converts pi's session files (documented in the pi package's own
 * docs/session-format.md, and verified against real files written by the
 * pinned @earendil-works/pi-coding-agent@0.84.4 — see
 * test/fixtures/pi/sessions/) into lazy's conversation model
 * ({@link ParsedConversation}), so pi conversations flow through the same
 * storage conversion (`toStoredConversation`) and stats/summary helpers as
 * Claude Code's.
 *
 * Pi session format, as verified on disk:
 *   - line 1 is a `{"type":"session","version":3,"id":"<uuid>","cwd":...}`
 *     header (no id/parentId tree fields);
 *   - every other line is a tree entry with `id` (8-char hex), `parentId`,
 *     and an ISO `timestamp`;
 *   - conversation content lives in `{"type":"message","message":{...}}`
 *     entries whose `message.role` is `user`, `assistant`, `toolResult`,
 *     `bashExecution`, `custom`, `branchSummary`, or `compactionSummary`;
 *   - assistant usage is per-LLM-call: `{input, output, cacheRead,
 *     cacheWrite, ...}`. Compaction and branch-summary entries may carry
 *     their own `usage` (the LLM work that produced the summary), as may
 *     toolResult messages (nested LLM work); lazy counts all of them, so the
 *     total is the session's whole token cost and not just its assistant
 *     turns. Those two entry shapes come from pi's format doc — unlike the
 *     header and message shapes, no captured fixture exercised them — and
 *     the total is display metadata for `lazy conversations`. Billing-grade
 *     accounting is the proxy's wire extraction, which is separate and
 *     unaffected by anything here (no double count).
 *
 * Like the Claude Code parser, only user/assistant TEXT becomes messages;
 * tool calls, tool results and thinking blocks are skipped for content but
 * their token usage still counts. Entries form a tree (in-place branching),
 * and we deliberately parse in file order rather than walking leaf-to-root:
 * capture wants everything the human and agent said, including abandoned
 * branches — the same "keep the whole transcript" posture as Claude capture.
 */

import { readFile, stat } from 'fs/promises';
import { basename, dirname } from 'path';
import type { ConversationMessage, ParsedConversation } from './claude-code-logs';
import type { TokenUsage } from '../types';

// --- Raw session entry types (subset lazy reads; see docs/session-format.md
// in the pi package for the full definitions) ---

interface RawPiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface RawPiContentBlock {
  type?: string;
  text?: string;
}

interface RawPiMessage {
  role?: string;
  content?: string | RawPiContentBlock[];
  model?: string;
  usage?: RawPiUsage;
  /** Unix ms — pi's message-level timestamp (entry timestamp is ISO). */
  timestamp?: number;
}

interface RawPiEntry {
  type?: string;
  // session header
  version?: number;
  cwd?: string;
  // tree entries
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: RawPiMessage;
  // compaction / branch_summary entries may carry summary-generation usage
  usage?: RawPiUsage;
}

/** Map pi's usage shape onto lazy's. cacheWrite is cache creation. */
function addUsage(total: TokenUsage, u: RawPiUsage | undefined): void {
  if (!u) return;
  total.inputTokens += u.input ?? 0;
  total.outputTokens += u.output ?? 0;
  total.cacheCreationTokens += u.cacheWrite ?? 0;
  total.cacheReadTokens += u.cacheRead ?? 0;
}

/** Extract the plain text of a pi message content (string or block array). */
function extractText(content: string | RawPiContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text)
    .map((b) => b.text as string)
    .join('\n')
    .trim();
}

/**
 * The session id encoded in a pi session filename
 * (`<timestamp>_<session-uuid>.jsonl`), or null if the name doesn't match.
 * The header's `id` is authoritative when the file parses; this is the
 * fallback for discovery-time keying without reading every file.
 */
export function piSessionIdFromFilename(filePath: string): string | null {
  const name = basename(filePath);
  const m = /_([0-9a-fA-F-]{36})\.jsonl$/.exec(name);
  return m ? m[1] : null;
}

/**
 * Parse pi session JSONL content into lazy's conversation model.
 *
 * Never throws on malformed lines — like the Claude parser, a bad line is
 * skipped so one corrupt entry cannot lose the rest of the transcript.
 *
 * @param content - Raw JSONL file content.
 * @param fallbackSessionId - Used when the header line is missing/unreadable
 *   (typically derived from the filename).
 * @param projectPath - The session directory name the file lives in (pi's
 *   `--<cwd-with-dashes>--` encoding), stored for provenance like Claude's
 *   encoded project dir.
 */
export function parsePiSessionContent(
  content: string,
  fallbackSessionId: string,
  projectPath: string,
): ParsedConversation {
  const lines = content.split('\n').filter((l) => l.trim());

  let sessionId = fallbackSessionId;
  let cwd: string | null = null;
  let version: string | null = null;
  const messages: ConversationMessage[] = [];
  const totalUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  for (const line of lines) {
    let entry: RawPiEntry;
    try {
      entry = JSON.parse(line) as RawPiEntry;
    } catch {
      continue; // Skip malformed lines
    }

    if (entry.type === 'session') {
      if (typeof entry.id === 'string' && entry.id) sessionId = entry.id;
      cwd = entry.cwd ?? null;
      version = entry.version != null ? `pi-session-v${entry.version}` : null;
      continue;
    }

    // Summary-generation usage on compaction/branch_summary entries counts
    // toward the session total: the tokens were spent in this session, and
    // the total is a cost display, not an assistant-turn count.
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      addUsage(totalUsage, entry.usage);
      continue;
    }

    if (entry.type !== 'message' || !entry.message) continue;
    const msg = entry.message;

    // Usage counts from every message that carries it — assistant messages
    // always, toolResult messages when a tool did nested LLM work — even when
    // the message contributes no text.
    addUsage(totalUsage, msg.usage);

    if (msg.role !== 'user' && msg.role !== 'assistant') continue;

    const text = extractText(msg.content);
    // Skip messages with no text content (image-only user messages, pure
    // tool-call assistant messages) — same rule as the Claude parser.
    if (!text) continue;

    messages.push({
      uuid: entry.id ?? '',
      parentUuid: entry.parentId ?? null,
      timestamp: entry.timestamp ?? '',
      role: msg.role,
      text,
      model: msg.role === 'assistant' ? (msg.model ?? null) : null,
      usage: msg.usage
        ? {
            inputTokens: msg.usage.input ?? 0,
            outputTokens: msg.usage.output ?? 0,
            cacheCreationTokens: msg.usage.cacheWrite ?? 0,
            cacheReadTokens: msg.usage.cacheRead ?? 0,
          }
        : null,
    });
  }

  const timestamps = messages.map((m) => m.timestamp).filter((t) => t).sort();

  return {
    sessionId,
    projectPath,
    cwd,
    version,
    gitBranch: null, // pi does not record the branch in its session files
    startedAt: timestamps[0] ?? null,
    endedAt: timestamps[timestamps.length - 1] ?? null,
    messages,
    subagents: [], // pi has no subagent transcript files
    totalUsage,
  };
}

/**
 * Parse a pi session file from disk into lazy's conversation model.
 * Throws only when the file itself cannot be read.
 *
 * No size cap, deliberately — the same posture as the Claude reader
 * (`parseJsonlFile` in claude-code-logs.ts). The file is agent-written and
 * bounded by the session's own length, and this is a one-shot read when a
 * pairing ends, not a hot path. Truncating at intake would lose history,
 * which is the one thing capture exists to prevent.
 */
export async function parsePiSessionFile(filePath: string): Promise<ParsedConversation> {
  const content = await readFile(filePath, 'utf-8');
  return parsePiSessionContent(
    content,
    piSessionIdFromFilename(filePath) ?? basename(filePath, '.jsonl'),
    basename(dirname(filePath)),
  );
}

/** A discovered pi session file plus the stat info needed to detect changes. */
export interface PiSessionFileInfo {
  filePath: string;
  /** Session id from the filename (best-effort key for change detection). */
  sessionId: string;
  mtimeMs: number;
  size: number;
}

/**
 * Stat a set of discovered pi session file paths (as returned by
 * `PiAgent.discoverSessionFiles`). Files that vanish between discovery and
 * stat are skipped, same as Claude discovery.
 */
export async function statPiSessionFiles(filePaths: string[]): Promise<PiSessionFileInfo[]> {
  const results: PiSessionFileInfo[] = [];
  for (const filePath of filePaths) {
    try {
      const s = await stat(filePath);
      if (!s.isFile()) continue;
      results.push({
        filePath,
        sessionId: piSessionIdFromFilename(filePath) ?? basename(filePath, '.jsonl'),
        mtimeMs: s.mtimeMs,
        size: s.size,
      });
    } catch {
      // File vanished between discovery and stat — skip it.
    }
  }
  return results;
}
