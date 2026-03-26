/**
 * Activity monitor for live agent streaming.
 *
 * Tails Claude Code JSONL session logs from the sandbox directory and
 * formats condensed activity lines showing what the agent is doing:
 *   - Tool calls (file reads, edits, writes, bash commands)
 *   - Brief summaries of what Claude is thinking/doing
 *
 * Used by followContainer() and the loop polling display to show
 * real-time agent activity instead of raw Docker logs.
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { theme, dim } from './theme';
import { encodeProjectPath } from '../import/claude-code-logs';

const SANDBOX_DIR = '.lazy-task-sandbox';

/**
 * Human-readable descriptions for Claude Code tool calls.
 * Maps tool name → formatter that takes the input and returns a short description.
 */
const TOOL_FORMATTERS: Record<string, (input: Record<string, unknown>) => string> = {
  Read: (input) => {
    const path = input.file_path as string | undefined;
    return path ? `Reading ${shortenPath(path)}` : 'Reading file';
  },
  Write: (input) => {
    const path = input.file_path as string | undefined;
    return path ? `Writing ${shortenPath(path)}` : 'Writing file';
  },
  Edit: (input) => {
    const path = input.file_path as string | undefined;
    return path ? `Editing ${shortenPath(path)}` : 'Editing file';
  },
  MultiEdit: (input) => {
    const path = input.file_path as string | undefined;
    return path ? `Multi-editing ${shortenPath(path)}` : 'Multi-editing file';
  },
  Bash: (input) => {
    const cmd = input.command as string | undefined;
    if (!cmd) return 'Running command';
    // Show first ~60 chars of the command
    const short = cmd.length > 60 ? cmd.substring(0, 57) + '...' : cmd;
    return `Running: ${short}`;
  },
  Glob: (input) => {
    const pattern = input.pattern as string | undefined;
    return pattern ? `Searching: ${pattern}` : 'Searching files';
  },
  Grep: (input) => {
    const pattern = input.pattern as string | undefined;
    return pattern ? `Grepping: ${pattern}` : 'Searching content';
  },
  WebFetch: (input) => {
    const url = input.url as string | undefined;
    return url ? `Fetching: ${url}` : 'Fetching URL';
  },
  WebSearch: (input) => {
    const query = input.query as string | undefined;
    return query ? `Searching web: ${query}` : 'Web search';
  },
  TodoWrite: () => 'Updating todo list',
  Task: (input) => {
    const desc = input.description as string | undefined;
    return desc ? `Subagent: ${desc}` : 'Launching subagent';
  },
  NotebookEdit: (input) => {
    const path = input.notebook_path as string | undefined;
    return path ? `Editing notebook ${shortenPath(path)}` : 'Editing notebook';
  },
};

/** Shorten a file path to show just the last 2-3 segments. */
function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '.../' + parts.slice(-3).join('/');
}

interface RawContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface RawLogEntry {
  type: string;
  timestamp?: string;
  message?: {
    role: string;
    content: string | RawContentBlock[];
  };
}

/**
 * Extract activity events from a JSONL log entry.
 * Returns an array of human-readable activity descriptions.
 */
function extractActivities(entry: RawLogEntry): string[] {
  const activities: string[] = [];

  if (entry.type !== 'assistant' || !entry.message) return activities;

  const content = entry.message.content;
  if (!Array.isArray(content)) return activities;

  for (const block of content) {
    if (block.type === 'tool_use' && block.name) {
      const formatter = TOOL_FORMATTERS[block.name];
      if (formatter && block.input) {
        activities.push(formatter(block.input));
      } else {
        activities.push(`Tool: ${block.name}`);
      }
    }
  }

  return activities;
}

export interface ActivityLine {
  timestamp: string;
  activity: string;
}

/**
 * Monitor that tails Claude Code JSONL session logs and emits
 * formatted activity lines.
 *
 * Usage:
 *   const monitor = new ActivityMonitor(worktreePath, taskId);
 *   monitor.start();
 *   // ... poll for activities ...
 *   const lines = monitor.drain();
 *   monitor.stop();
 */
export class ActivityMonitor {
  private worktreePath: string;
  private taskId: string;
  private turnStartedAt: number;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingLines: ActivityLine[] = [];
  private lastFileSize = 0;
  private lastSessionFile: string | null = null;

  constructor(worktreePath: string, taskId: string, turnStartedAt?: string) {
    this.worktreePath = worktreePath;
    this.taskId = taskId;
    this.turnStartedAt = turnStartedAt ? new Date(turnStartedAt).getTime() : Date.now();
  }

  /** Start polling for new JSONL entries. */
  start(pollIntervalMs = 1000): void {
    this.timer = setInterval(() => {
      if (this.stopped) return;
      this.poll();
    }, pollIntervalMs);
    // Do an immediate poll
    this.poll();
  }

  /** Stop monitoring. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Drain all pending activity lines (returns and clears the buffer).
   * Each line is formatted with timestamp and task ID.
   */
  drain(): ActivityLine[] {
    const lines = this.pendingLines;
    this.pendingLines = [];
    return lines;
  }

  /**
   * Drain and print all pending activity lines to the console.
   * Returns the number of lines printed.
   */
  printDrain(): number {
    const lines = this.drain();
    for (const line of lines) {
      console.log(`${dim(line.timestamp)} [${theme.taskId(this.taskId)}] ${line.activity}`);
    }
    return lines.length;
  }

  /** Get the elapsed timestamp string. */
  private ts(): string {
    const elapsed = Math.floor((Date.now() - this.turnStartedAt) / 1000);
    const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    return `[${m}:${s}]`;
  }

  /** Find the most recently modified JSONL file in the sandbox. */
  private findSessionFile(): string | null {
    const encodedPath = encodeProjectPath(this.worktreePath);
    const projectDir = join(this.worktreePath, SANDBOX_DIR, '.claude', 'projects', encodedPath);

    if (!existsSync(projectDir)) return null;

    let latestFile: string | null = null;
    let latestMtime = 0;

    try {
      const entries = readdirSync(projectDir);
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const fullPath = join(projectDir, entry);
        try {
          const st = statSync(fullPath);
          if (st.mtimeMs > latestMtime) {
            latestMtime = st.mtimeMs;
            latestFile = fullPath;
          }
        } catch {
          // Skip
        }
      }
    } catch {
      // Directory may not exist yet
    }

    return latestFile;
  }

  /** Poll for new JSONL entries and extract activities. */
  private poll(): void {
    try {
      // Find the session file (may change between polls if a new session starts)
      const sessionFile = this.findSessionFile();
      if (!sessionFile) return;

      // If we switched to a new file, reset the read position
      if (sessionFile !== this.lastSessionFile) {
        this.lastSessionFile = sessionFile;
        this.lastFileSize = 0;
      }

      // Check file size to see if there's new content
      let fileSize: number;
      try {
        fileSize = statSync(sessionFile).size;
      } catch {
        return;
      }

      if (fileSize <= this.lastFileSize) return;

      // Read the entire file and process only new lines
      // (Reading only the tail is tricky with UTF-8 and partial lines)
      const content = readFileSync(sessionFile, 'utf-8');
      const lines = content.split('\n');

      // Process lines from where we left off (approximate by character count)
      let charCount = 0;
      for (const line of lines) {
        charCount += line.length + 1; // +1 for the newline
        if (charCount <= this.lastFileSize) continue;
        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line) as RawLogEntry;
          const activities = extractActivities(entry);

          for (const activity of activities) {
            this.pendingLines.push({
              timestamp: this.ts(),
              activity,
            });
          }
        } catch {
          // Skip malformed lines
        }
      }

      this.lastFileSize = fileSize;
    } catch {
      // Non-fatal — session logs may not exist yet
    }
  }
}

/**
 * Parse a supervisor log line into a human-readable activity description.
 * Returns null if the line is not interesting or should be hidden.
 *
 * Supervisor log lines have the format: [MM:SS] [module] message
 * e.g. "[01:23] [supervisor] Phase: work"
 * e.g. "[01:23] [work] Running Claude Code (resume)..."
 */
export function parseSupervisorLogLine(line: string): string | null {
  // Strip the timestamp prefix from supervisor logs (we'll add our own)
  const stripped = line.replace(/^\[\d{2}:\d{2}\]\s*/, '').trim();
  if (!stripped) return null;

  // Phase transitions — these are the most useful
  if (stripped.startsWith('[supervisor] Phase:')) {
    const phase = stripped.replace('[supervisor] Phase:', '').trim();
    return formatPhase(phase);
  }

  // Work module messages
  if (stripped.startsWith('[work]')) {
    const msg = stripped.replace('[work]', '').trim();

    // Filter out noisy messages
    if (msg.startsWith('Running Claude Code')) return 'Agent starting...';
    if (msg.startsWith('Claude Code completed')) return 'Agent finished, processing response...';
    if (msg.startsWith('Response captured')) return null; // redundant with phase
    if (msg.startsWith('Retry')) return msg; // Keep retry messages
    if (msg.startsWith('Success after')) return msg;

    return msg;
  }

  // Supervisor startup/tool checks
  if (stripped.startsWith('[supervisor] Found')) return null; // tool check lines
  if (stripped.startsWith('[supervisor] Starting')) return null;
  if (stripped.startsWith('[supervisor] Worktree:')) return null;
  if (stripped.startsWith('[supervisor] Waiting for command')) return null;
  if (stripped.startsWith('[supervisor] Received command:')) return null;
  if (stripped.startsWith('[supervisor] Turn complete')) return null;
  if (stripped.startsWith('[supervisor] Tagged HEAD')) return null;

  // Pass through error/warning messages
  if (stripped.includes('ERROR') || stripped.includes('failed') || stripped.includes('error')) {
    return stripped;
  }

  // Hide everything else
  return null;
}

/** Map supervisor phases to human-friendly descriptions. */
function formatPhase(phase: string): string | null {
  switch (phase) {
    case 'merge_and_fix': return 'Syncing with upstream...';
    case 'merge_and_fix_done': return 'Upstream sync complete';
    case 'work': return 'Agent working...';
    case 'work_done': return 'Agent finished';
    case 'permission_pushback': return 'Permission violation detected, pushing back...';
    case 'permission_pushback_done': return 'Permission pushback complete';
    case 'post_turn_check': return 'Running post-turn check...';
    case 'post_turn_check_done': return 'Post-turn check complete';
    case 'post_turn_sync': return 'Post-turn sync...';
    case 'post_turn_sync_done': return 'Post-turn sync complete';
    case 'writing_response': return null; // internal detail
    case 'retrying': return 'Retrying after error...';
    case 'reading_command': return null; // internal detail
    default: return null;
  }
}
