/**
 * Claude Code conversation log parser
 *
 * Reads JSONL conversation logs from ~/.claude/projects/ and extracts
 * structured conversation data suitable for storage in lazy.
 *
 * Claude Code log format:
 *   - Each line is a JSON object with a "type" field
 *   - Types: "queue-operation", "user", "assistant", "progress"
 *   - User/assistant messages have a "message" field with role and content
 *   - Content can be a string or array of {type, text/name/input/...} objects
 *   - Subagent conversations are stored in separate files under subagents/
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, basename } from 'path';
import { getHome } from '../utils/home';
import type { TokenUsage } from '../types';

// --- Raw JSONL types ---

interface RawLogEntry {
  type: 'queue-operation' | 'user' | 'assistant' | 'progress';
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  userType?: string;
  message?: RawMessage;
  // progress-specific
  data?: unknown;
  // queue-operation-specific
  operation?: string;
}

interface RawMessage {
  role: 'user' | 'assistant';
  content: string | RawContentBlock[];
  model?: string;
  id?: string;
  type?: string;
  stop_reason?: string | null;
  usage?: RawUsage;
}

interface RawContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  // text block
  text?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // tool_result block
  tool_use_id?: string;
  content?: string | RawContentBlock[];
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// --- Parsed conversation types ---

export interface ConversationMessage {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  role: 'user' | 'assistant';
  /** Plain text content extracted from the message (tool calls/results excluded) */
  text: string;
  /** Model used for assistant messages */
  model: string | null;
  /** Token usage for assistant messages */
  usage: TokenUsage | null;
}

export type { TokenUsage } from '../types';

export interface SubagentConversation {
  agentId: string;
  messages: ConversationMessage[];
}

export interface ParsedConversation {
  sessionId: string;
  projectPath: string;
  cwd: string | null;
  version: string | null;
  gitBranch: string | null;
  startedAt: string | null;
  endedAt: string | null;
  messages: ConversationMessage[];
  subagents: SubagentConversation[];
  totalUsage: TokenUsage;
}

// --- Discovery ---

/**
 * Get the Claude Code projects directory
 */
function getClaudeProjectsDir(): string {
  return join(getHome(), '.claude', 'projects');
}

/**
 * Encode a project path as Claude Code does for directory names.
 * Replaces both path separators (/) and dots (.) with dashes.
 */
export function encodeProjectPath(projectPath: string): string {
  return '-' + projectPath.replace(/[/.]/g, '-').replace(/^-/, '');
}

/**
 * Discover all Claude Code sessions for a given project path.
 * Returns session IDs (UUIDs) found in the project directory.
 */
export async function discoverSessions(projectPath: string): Promise<string[]> {
  const projectsDir = getClaudeProjectsDir();

  // Try both the exact path and common worktree patterns
  const encodedPath = encodeProjectPath(projectPath);
  const projectDir = join(projectsDir, encodedPath);

  try {
    const entries = await readdir(projectDir);
    const sessions: string[] = [];

    for (const entry of entries) {
      // Session JSONL files are named <session-id>.jsonl at the top level
      if (entry.endsWith('.jsonl')) {
        sessions.push(basename(entry, '.jsonl'));
      }
    }

    return sessions;
  } catch {
    return [];
  }
}

/**
 * Discover sessions across all project directories that match a path prefix.
 * Useful for finding sessions from worktrees (which have different paths).
 */
export async function discoverAllProjectSessions(repoRootPath: string): Promise<Array<{ projectPath: string; sessionId: string }>> {
  const projectsDir = getClaudeProjectsDir();
  const encodedPrefix = encodeProjectPath(repoRootPath);

  const results: Array<{ projectPath: string; sessionId: string }> = [];

  try {
    const projectDirs = await readdir(projectsDir);

    for (const dir of projectDirs) {
      // Match directories that start with the encoded repo root path
      if (!dir.startsWith(encodedPrefix)) continue;

      const fullDir = join(projectsDir, dir);
      const dirStat = await stat(fullDir);
      if (!dirStat.isDirectory()) continue;

      const entries = await readdir(fullDir);
      for (const entry of entries) {
        if (entry.endsWith('.jsonl')) {
          results.push({
            projectPath: dir,
            sessionId: basename(entry, '.jsonl'),
          });
        }
      }
    }
  } catch {
    // Projects directory doesn't exist
  }

  return results;
}

// --- Parsing ---

/**
 * Parse a single JSONL line into a ConversationMessage, or null if not a user/assistant message.
 */
function parseLogEntry(line: string): { entry: RawLogEntry; message: ConversationMessage | null } {
  const entry = JSON.parse(line) as RawLogEntry;

  if (entry.type !== 'user' && entry.type !== 'assistant') {
    return { entry, message: null };
  }

  if (!entry.message) {
    return { entry, message: null };
  }

  const msg = entry.message;
  let text = '';

  if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    // Extract only text blocks - skip tool_use and tool_result blocks entirely
    const textParts: string[] = [];

    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      }
    }

    text = textParts.join('\n').trim();
  }

  // Skip messages that have no text content (pure tool calls or tool results)
  if (!text) {
    return { entry, message: null };
  }

  let usage: TokenUsage | null = null;
  if (msg.usage) {
    usage = {
      inputTokens: msg.usage.input_tokens ?? 0,
      outputTokens: msg.usage.output_tokens ?? 0,
      cacheCreationTokens: msg.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    };
  }

  return {
    entry,
    message: {
      uuid: entry.uuid ?? '',
      parentUuid: entry.parentUuid ?? null,
      timestamp: entry.timestamp ?? '',
      role: msg.role,
      text,
      model: msg.model ?? null,
      usage,
    },
  };
}

/** Accumulated state from parsing JSONL lines */
export interface JsonlParseState {
  messages: ConversationMessage[];
  metadata: {
    sessionId?: string;
    cwd?: string;
    version?: string;
    gitBranch?: string;
  };
  usage: TokenUsage;
}

/**
 * Create a fresh parse state for incremental parsing.
 */
export function createParseState(): JsonlParseState {
  return {
    messages: [],
    metadata: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };
}

/**
 * Parse JSONL lines and accumulate results into the given state.
 * Each line is parsed independently — safe to call repeatedly with new chunks.
 *
 * Token usage is tracked from ALL assistant messages (including tool-only ones
 * that we skip for content), since they all consume tokens.
 */
export function parseJsonlLines(text: string, state: JsonlParseState): void {
  const lines = text.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as RawLogEntry;

      // Aggregate token usage from all assistant messages, even those we skip
      if (raw.type === 'assistant' && raw.message?.usage) {
        const u = raw.message.usage;
        state.usage.inputTokens += u.input_tokens ?? 0;
        state.usage.outputTokens += u.output_tokens ?? 0;
        state.usage.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
        state.usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      }

      const { entry, message } = parseLogEntry(line);

      // Capture metadata from the first user message
      if (entry.type === 'user' && !state.metadata.sessionId) {
        state.metadata = {
          sessionId: entry.sessionId,
          cwd: entry.cwd,
          version: entry.version,
          gitBranch: entry.gitBranch,
        };
      }

      if (message) {
        state.messages.push(message);
      }
    } catch {
      // Skip malformed lines
    }
  }
}

/**
 * Parse a JSONL file into conversation messages and aggregate token usage.
 */
async function parseJsonlFile(filePath: string): Promise<JsonlParseState> {
  const content = await readFile(filePath, 'utf-8');
  const state = createParseState();
  parseJsonlLines(content, state);
  return state;
}

/**
 * Parse a complete Claude Code conversation session from disk.
 *
 * @param projectPath - Encoded project directory name (e.g., "-Users-foo-prg-myproject")
 * @param sessionId - UUID of the session
 */
export async function parseConversation(projectPath: string, sessionId: string): Promise<ParsedConversation> {
  const projectsDir = getClaudeProjectsDir();
  const projectDir = join(projectsDir, projectPath);

  // Parse main conversation file
  const mainFile = join(projectDir, `${sessionId}.jsonl`);
  const { messages: mainMessages, metadata, usage: mainUsage } = await parseJsonlFile(mainFile);

  // Parse subagent conversations
  const subagents: SubagentConversation[] = [];
  const subagentsDir = join(projectDir, sessionId, 'subagents');

  // Aggregate usage from main + all subagents
  const totalUsage: TokenUsage = { ...mainUsage };

  try {
    const subagentFiles = await readdir(subagentsDir);

    for (const file of subagentFiles) {
      if (!file.endsWith('.jsonl')) continue;

      const agentId = basename(file, '.jsonl').replace('agent-', '');
      const { messages: subMessages, usage: subUsage } = await parseJsonlFile(join(subagentsDir, file));

      totalUsage.inputTokens += subUsage.inputTokens;
      totalUsage.outputTokens += subUsage.outputTokens;
      totalUsage.cacheCreationTokens += subUsage.cacheCreationTokens;
      totalUsage.cacheReadTokens += subUsage.cacheReadTokens;

      if (subMessages.length > 0) {
        subagents.push({
          agentId,
          messages: subMessages,
        });
      }
    }
  } catch {
    // No subagents directory
  }

  // Compute timestamps
  const allTimestamps = mainMessages
    .map((m) => m.timestamp)
    .filter((t) => t)
    .sort();
  const startedAt = allTimestamps[0] ?? null;
  const endedAt = allTimestamps[allTimestamps.length - 1] ?? null;

  return {
    sessionId,
    projectPath,
    cwd: metadata.cwd ?? null,
    version: metadata.version ?? null,
    gitBranch: metadata.gitBranch ?? null,
    startedAt,
    endedAt,
    messages: mainMessages,
    subagents,
    totalUsage,
  };
}

/**
 * Extract a human-readable summary of a conversation.
 * Takes the first user message text as the summary.
 */
export function extractSummary(conversation: ParsedConversation): string {
  const firstUserMsg = conversation.messages.find((m) => m.role === 'user' && m.text.trim());
  if (!firstUserMsg) return '(empty conversation)';

  const text = firstUserMsg.text.trim();
  // Take the first line or first 200 chars
  const firstLine = text.split('\n')[0];
  if (firstLine.length <= 200) return firstLine;
  return firstLine.substring(0, 197) + '...';
}

/**
 * Count stats for a conversation.
 */
export function conversationStats(conversation: ParsedConversation): {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  subagentCount: number;
  totalTokens: number;
} {
  const userMessages = conversation.messages.filter((m) => m.role === 'user');
  const assistantMessages = conversation.messages.filter((m) => m.role === 'assistant');

  return {
    messageCount: conversation.messages.length,
    userMessageCount: userMessages.length,
    assistantMessageCount: assistantMessages.length,
    subagentCount: conversation.subagents.length,
    totalTokens: conversation.totalUsage.inputTokens + conversation.totalUsage.outputTokens + conversation.totalUsage.cacheCreationTokens + conversation.totalUsage.cacheReadTokens,
  };
}
