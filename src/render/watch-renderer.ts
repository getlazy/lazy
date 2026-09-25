/**
 * JSONL conversation renderer for `lazy watch`.
 *
 * Formats Claude Code JSONL log entries into human-readable terminal output:
 * thinking blocks, tool calls with inputs, tool results, and assistant text.
 *
 * All rendering functions are pure (string → string) and exported for testing,
 * including renderEntryLines(), which is what the daemon's web watch panel uses.
 * The only side-effecting function is renderEntry(), a thin console.log wrapper
 * around it so the CLI's output stays byte-identical.
 */

import { dim, bold, cyan, blue } from './theme';

// ── JSONL types (matching activity-monitor.ts / claude-code-logs.ts) ────

export interface RawContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | RawContentBlock[];
  is_error?: boolean;
}

export interface RawLogEntry {
  type: string; // 'assistant', 'user', 'progress', 'queue-operation'
  timestamp?: string;
  message?: {
    role: string;
    content: string | RawContentBlock[];
  };
}

// ── Separators ──────────────────────────────────────────────────────────

const SEPARATOR_WIDTH = 60;

export function thinkingSeparatorOpen(): string {
  const label = ' Thinking ';
  const dashes = '─'.repeat(Math.max(0, SEPARATOR_WIDTH - label.length - 3));
  return dim(`─── ${label}${dashes}`);
}

export function thinkingSeparatorClose(): string {
  return dim('─'.repeat(SEPARATOR_WIDTH));
}

export function responseSeparatorOpen(): string {
  const label = ' Response ';
  const dashes = '─'.repeat(Math.max(0, SEPARATOR_WIDTH - label.length - 3));
  return dim(`─── ${label}${dashes}`);
}

export function responseSeparatorClose(): string {
  return dim('─'.repeat(SEPARATOR_WIDTH));
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Shorten a file path to show just the last 3 segments. */
export function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '.../' + parts.slice(-3).join('/');
}

// ── Tool call formatting ────────────────────────────────────────────────

/** Format a tool_use block into a displayable string. */
export function formatToolCall(block: RawContentBlock): string {
  const name = block.name ?? 'unknown';
  const input = block.input ?? {};

  switch (name) {
    case 'Read': {
      const path = input.file_path as string | undefined;
      return `${cyan('▶')} ${bold('Read')} ${path ? shortenPath(path) : '(file)'}`;
    }
    case 'Write': {
      const path = input.file_path as string | undefined;
      return `${cyan('▶')} ${bold('Write')} ${path ? shortenPath(path) : '(file)'}`;
    }
    case 'Edit':
    case 'MultiEdit': {
      const path = input.file_path as string | undefined;
      const lines: string[] = [];
      lines.push(`${cyan('▶')} ${bold(name)} ${path ? shortenPath(path) : '(file)'}`);
      if (name === 'Edit' && input.old_string && input.new_string) {
        const old = String(input.old_string);
        const nw = String(input.new_string);
        const oldFirst = old.split('\n')[0].substring(0, 70);
        const newFirst = nw.split('\n')[0].substring(0, 70);
        if (oldFirst) lines.push(dim(`  - ${oldFirst}`));
        if (newFirst) lines.push(dim(`  + ${newFirst}`));
      }
      return lines.join('\n');
    }
    case 'Bash': {
      const cmd = input.command as string | undefined;
      if (!cmd) return `${cyan('▶')} ${bold('Bash')}`;
      const short = cmd.length > 80 ? cmd.substring(0, 77) + '...' : cmd;
      return `${cyan('▶')} ${bold('Bash')} ${dim(short)}`;
    }
    case 'Grep': {
      const pattern = input.pattern as string | undefined;
      const path = input.path as string | undefined;
      const parts = [`${cyan('▶')} ${bold('Grep')}`];
      if (pattern) parts.push(`pattern:${dim('"' + pattern + '"')}`);
      if (path) parts.push(`path:${dim(shortenPath(path))}`);
      return parts.join(' ');
    }
    case 'Glob': {
      const pattern = input.pattern as string | undefined;
      return `${cyan('▶')} ${bold('Glob')} ${pattern ? dim(pattern) : ''}`;
    }
    case 'Agent':
    case 'Task': {
      const desc = input.description as string | undefined;
      return `${cyan('▶')} ${bold('Agent')} ${desc ? dim(desc) : ''}`;
    }
    case 'TodoWrite':
      return `${cyan('▶')} ${bold('TodoWrite')}`;
    case 'WebFetch': {
      const url = input.url as string | undefined;
      return `${cyan('▶')} ${bold('WebFetch')} ${url ? dim(url) : ''}`;
    }
    case 'WebSearch': {
      const query = input.query as string | undefined;
      return `${cyan('▶')} ${bold('WebSearch')} ${query ? dim(query) : ''}`;
    }
    default: {
      const displayName = name.startsWith('mcp__lazy__') ? name.replace('mcp__lazy__', 'lazy:') : name;
      const inputStr = JSON.stringify(input);
      const short = inputStr.length > 80 ? inputStr.substring(0, 77) + '...' : inputStr;
      return `${cyan('▶')} ${bold(displayName)} ${dim(short)}`;
    }
  }
}

// ── Tool result formatting ──────────────────────────────────────────────

/** Maximum lines to show before truncating with a "lines omitted" indicator. */
const HEAD_LINES = 50;
const TAIL_LINES = 10;

/** Format a tool_result content block. */
export function formatToolResult(block: RawContentBlock): string | null {
  const isError = block.is_error === true;
  let text = '';

  if (typeof block.content === 'string') {
    text = block.content;
  } else if (Array.isArray(block.content)) {
    const parts = block.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!);
    text = parts.join('\n');
  }

  if (!text) return null;

  if (isError) {
    // Show full error text, dimmed with error marker
    const indented = text.split('\n').map((l) => `  ${l}`).join('\n');
    return dim(`  ✗ error:\n${indented}`);
  }

  const lines = text.split('\n');

  if (lines.length <= HEAD_LINES + TAIL_LINES) {
    // Show full result, dimmed and indented
    return dim(`  ${lines.join('\n  ')}`);
  }

  // Long result: show head + tail with omission indicator
  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(-TAIL_LINES);
  const omitted = lines.length - HEAD_LINES - TAIL_LINES;
  return dim(
    `  ${head.join('\n  ')}\n` +
    `  ... (${omitted} lines omitted) ...\n` +
    `  ${tail.join('\n  ')}`
  );
}

// ── Entry rendering ─────────────────────────────────────────────────────

/**
 * Render a single JSONL entry to a list of lines — pure, so the SAME rendering
 * can go to a terminal (`lazy watch`) or down a WebSocket to the web watch panel
 * (src/server/watch-ws.ts) without either surface re-deriving the format.
 *
 * A returned string may itself contain newlines (a tool result is one block);
 * every caller is expected to emit each element followed by a line break, which
 * is exactly what `console.log` did when this function wrote directly.
 */
export function renderEntryLines(entry: RawLogEntry): string[] {
  const out: string[] = [];

  if (entry.type === 'assistant' && entry.message) {
    const content = entry.message.content;
    if (typeof content === 'string') {
      out.push('');
      out.push(responseSeparatorOpen());
      out.push(content);
      out.push(responseSeparatorClose());
      return out;
    }

    if (!Array.isArray(content)) return out;

    let inThinking = false;
    let hasText = false;

    for (const block of content) {
      if (block.type === 'thinking') {
        const text = block.thinking ?? block.text ?? '';
        if (!text.trim()) continue;
        if (!inThinking) {
          out.push('');
          out.push(thinkingSeparatorOpen());
          inThinking = true;
        }
        out.push(dim(text));
      } else if (block.type === 'text') {
        if (inThinking) {
          out.push(thinkingSeparatorClose());
          inThinking = false;
        }
        const text = block.text ?? '';
        if (!text.trim()) continue;
        if (!hasText) {
          out.push('');
          out.push(responseSeparatorOpen());
          hasText = true;
        }
        out.push(text);
      } else if (block.type === 'tool_use') {
        if (inThinking) {
          out.push(thinkingSeparatorClose());
          inThinking = false;
        }
        if (hasText) {
          out.push(responseSeparatorClose());
          hasText = false;
        }
        out.push('');
        out.push(formatToolCall(block));
      } else if (block.type === 'tool_result') {
        const result = formatToolResult(block);
        if (result) out.push(result);
      }
    }

    if (inThinking) out.push(thinkingSeparatorClose());
    if (hasText) out.push(responseSeparatorClose());
    return out;
  }

  if (entry.type === 'user' && entry.message) {
    const content = entry.message.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          const result = formatToolResult(block);
          if (result) out.push(result);
        }
      }
      return out;
    }

    // Plain text user message — show all of it
    if (typeof content === 'string' && content.trim()) {
      out.push('');
      out.push(blue('▷ ') + content);
    }
  }

  // Skip 'progress', 'queue-operation', 'system' types silently
  return out;
}

/** Render a single JSONL entry to stdout. */
export function renderEntry(entry: RawLogEntry): void {
  for (const line of renderEntryLines(entry)) console.log(line);
}
