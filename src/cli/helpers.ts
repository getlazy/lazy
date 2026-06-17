/**
 * CLI helper functions
 *
 * Common utilities shared across CLI commands.
 */

import { join } from 'path';
import { findLazyRoot, getDataDir } from './init';
import type { Storage } from '../storage';
import { repoHasCommits } from '../git/operations';
import { checkPairingLock } from '../utils/pairing-lock';
import { isTTY, promptChoice } from './editor';
import type { Task, TokenUsage } from '../types';
import { DaemonClient, RpcApplicationError } from '../daemon/client';
import { RemoteStorage } from '../storage/remote-storage';

/**
 * Maximum length for task codes (in characters).
 * Used for validation in CLI and MCP tool schemas.
 */
export const MAX_TASK_CODE_LENGTH = 80;

/**
 * Get the lazy root directory or exit with an error
 */
export function requireLazyRoot(): string {
  const root = findLazyRoot();
  if (!root) {
    console.error('Error: not in a lazy project. Run `lazy init` first.');
    process.exit(1);
  }
  if (!repoHasCommits(root)) {
    console.error('Error: repository has no commits. Lazy requires at least one commit to function.');
    console.error("Run: git commit --allow-empty -m 'Initial commit'");
    process.exit(1);
  }
  return root;
}

/**
 * Try to create a RemoteStorage that proxies through the daemon.
 * Returns null if the daemon is unavailable or in test/daemon mode.
 */
export async function tryRemoteStorage(root: string): Promise<Storage | null> {
  // Skip daemon in test mode or when we ARE the daemon
  if (process.env.LAZY_TEST === '1') return null;
  if (process.env.LAZY_IS_DAEMON === '1') return null;

  const client = DaemonClient.create(root);
  if (!client) return null;

  try {
    // Fetch the storage path from the daemon so getStoragePath()/getTaskDir() work.
    const info = await client.rpc('storage', root, {
      method: 'getStoragePath',
      args: {},
    }) as string;

    return new RemoteStorage(client, root, info);
  } catch (err) {
    // The daemon RESPONDED but the operation failed (e.g. storage-lock
    // contention, a 500). That is NOT "daemon not running" — surface it so the
    // real problem is visible instead of sending the user to restart a healthy
    // daemon. Only a transport failure (daemon genuinely unreachable) should
    // fall through to the null → "Daemon is not running" path.
    if (err instanceof RpcApplicationError) throw err;
    return null;
  }
}

/**
 * Create and initialize storage, or exit with an error.
 * Routes all calls through the daemon via RemoteStorage — CLI processes
 * never touch .storage-lock directly. Only the daemon creates FileStorage.
 *
 * Exits with an error if the daemon is not running.
 */
export async function requireStorage(): Promise<Storage> {
  const root = requireLazyRoot();

  const remote = await tryRemoteStorage(root);
  if (remote) return remote;

  console.error('Error: Daemon is not running. Start it with: lazy daemon start');
  process.exit(1);
}

/**
 * Shorten a UUID to 8 characters
 */
export function shortId(id: string): string {
  return id.substring(0, 8);
}

/**
 * Return the preferred display identifier for a task.
 * If the task has a code, return it; otherwise return the short hex ID.
 */
export function displayId(task: Task): string {
  return task.code ?? shortId(task.id);
}

/**
 * Look up a task by ID and return its display identifier.
 * Falls back to shortId if the task cannot be found.
 */
export async function displayIdFor(storage: Storage, taskId: string): Promise<string> {
  const task = await storage.getTask(taskId);
  return task ? displayId(task) : shortId(taskId);
}

/**
 * Get the stable task ref for a task.
 * Returns the stored task_ref metadata if available, falling back to shortId.
 * New tasks have task_ref stored at creation time; old tasks use shortId.
 */
export function taskRef(task: Task): string {
  return task.metadata?.task_ref ?? shortId(task.id);
}

/**
 * Look up a task's ref by ID. Falls back to shortId if task not found.
 */
export async function taskRefFromId(taskId: string, storage: Storage): Promise<string> {
  const task = await storage.getTask(taskId);
  return task ? taskRef(task) : shortId(taskId);
}

/**
 * Get the worktree path for a task.
 */
export function getWorktreePath(root: string, task: Task): string {
  return join(root, getDataDir(root), 'worktrees', taskRef(task));
}

/**
 * Get the worktree path for a task ref string (already resolved).
 */
export function getWorktreePathForRef(root: string, tRef: string): string {
  return join(root, getDataDir(root), 'worktrees', tRef);
}

/**
 * Get the git branch name for a task.
 */
export function getBranchName(task: Task): string {
  return `lazy/${taskRef(task)}`;
}

/**
 * Get the git branch name for a task by ID.
 */
export async function getBranchNameFromId(taskId: string, storage: Storage): Promise<string> {
  return `lazy/${await taskRefFromId(taskId, storage)}`;
}

/**
 * Format a timestamp as YY-MM-DD for use in task refs.
 */
function formatDateForRef(ts: number): string {
  const d = new Date(ts);
  const yy = String(d.getUTCFullYear()).slice(-2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Derive a stable, human-readable reference for a task.
 * Used for branch names (lazy/<ref>), worktree dirs, and container names.
 *
 * Progressive disambiguation:
 * 1. <code>                    — when code is unique across all tasks
 * 2. <code>-<yy-mm-dd>        — when another task shares the same code
 * 3. <code>-<yy-mm-dd>-<id>   — when ambiguous on both code and date
 * 4. <shortId>                 — fallback when no code is set
 *
 * @param task The task to derive a ref for
 * @param allTasks All tasks (including terminal) for ambiguity checking
 */
export function deriveTaskRef(task: Task, allTasks: Task[]): string {
  if (!task.code) {
    return shortId(task.id);
  }

  // Check for other tasks with the same code (excluding this task)
  const sameCode = allTasks.filter(t => t.id !== task.id && t.code === task.code);

  if (sameCode.length === 0) {
    // Unique code
    return task.code;
  }

  // Need date disambiguation
  const dateStr = formatDateForRef(task.created_at);

  // Check if any same-code tasks also share the same date
  const sameDateAndCode = sameCode.filter(t => formatDateForRef(t.created_at) === dateStr);

  if (sameDateAndCode.length === 0) {
    // Date disambiguates
    return `${task.code}-${dateStr}`;
  }

  // Full disambiguation with task ID
  return `${task.code}-${dateStr}-${shortId(task.id)}`;
}

/**
 * Build a map from task ID → display identifier for a list of tasks.
 * Useful for resolving parent_task_id in list views without extra lookups.
 * Falls back to shortId for IDs not in the map.
 */
export function buildDisplayIdMap(tasks: Task[]): (taskId: string) => string {
  const map = new Map<string, string>();
  for (const t of tasks) {
    map.set(t.id, displayId(t));
  }
  return (taskId: string) => map.get(taskId) ?? shortId(taskId);
}

/**
 * Derive a task code from a branch name or title string.
 * Rules: lowercase, replace `/` and non-alphanumeric (except dots) with `-`, collapse runs of `-` and `.`, truncate to 80 chars.
 * Returns null if the derived code would be invalid (too short, reserved, etc.).
 */
export function deriveCode(input: string): string | null {
  const derived = input
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')  // replace non-alphanumeric runs (except dots) with single `-`
    .replace(/\.{2,}/g, '.')       // collapse multiple consecutive dots to single dot
    .replace(/^[-.]+/, '')         // strip leading hyphens and dots
    .replace(/[-.]+$/, '')         // strip trailing hyphens and dots
    .slice(0, MAX_TASK_CODE_LENGTH)  // truncate to max code length
    .replace(/[-.]+$/, '');        // strip any trailing hyphens or dots created by truncation

  if (validateCode(derived) !== null) {
    return null;
  }
  return derived;
}

/**
 * Validate a task code.
 * Rules: lowercase alphanumeric + hyphens + dots, 2-80 chars, starts and ends with a letter or digit.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateCode(code: string): string | null {
  if (code.length < 2) {
    return `Code must be 2-${MAX_TASK_CODE_LENGTH} characters long`;
  }
  if (code.length > MAX_TASK_CODE_LENGTH) {
    return `Task code must be ${MAX_TASK_CODE_LENGTH} characters or fewer (got ${code.length}). Shorten it.`;
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(code)) {
    return 'Code must be lowercase alphanumeric + hyphens + dots, starting and ending with a letter or digit';
  }
  if (code.startsWith('lazy-')) {
    return "Codes starting with 'lazy-' are reserved for system entities";
  }
  return null;
}

/**
 * Format a unix timestamp (ms since epoch) for display.
 * Returns "YYYY-MM-DD HH:MM" in UTC.
 */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Format milliseconds as a human-readable duration
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Format a token count compactly (e.g., 1234 -> "1.2k", 1234567 -> "1.2M")
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  } else if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return String(tokens);
}

/**
 * Get total input tokens including cached tokens.
 * Claude Code reports non-cached input separately from cache creation and cache read tokens,
 * but they all count as input tokens.
 */
export function totalInputTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
}

/**
 * Get total tokens (input + output) from a TokenUsage object
 */
export function totalTokens(usage: TokenUsage | null): number {
  if (!usage) return 0;
  return totalInputTokens(usage) + usage.outputTokens;
}

/**
 * Format token usage as a compact string showing input and output tokens.
 * Example: "1.2k/350" (1.2k input, 350 output)
 */
export function formatTokenUsage(usage: TokenUsage | null): string {
  if (!usage) return '-';
  return `${formatTokenCount(totalInputTokens(usage))}/${formatTokenCount(usage.outputTokens)}`;
}

/**
 * Flag validation result
 */
export interface ParsedFlags {
  /** Positional arguments (non-flag args) */
  positional: string[];
  /** Flag values: map of flag name to value (or true for boolean flags, or string[] for accumulate flags) */
  flags: Map<string, string | boolean | string[]>;
}

/**
 * Flag definition for command argument parsing
 */
export interface FlagDefinition {
  /** Flag name (e.g., 'goal', 'model') */
  name: string;
  /** Alternative names/aliases (e.g., ['f'] for 'fuzzy') */
  aliases?: string[];
  /** Whether this flag takes a value (false = boolean flag) */
  takesValue: boolean;
  /**
   * When true, the flag's value is optional. If the next argument looks like
   * another flag (starts with '-') or is absent, the flag is set to `true`
   * (bare usage). Otherwise the next argument is consumed as its value.
   * Only meaningful when `takesValue` is true.
   */
  optionalValue?: boolean;
  /**
   * When true, repeated occurrences of this flag accumulate into a string[].
   * e.g., --approve-file a.ts --approve-file b.ts → ['a.ts', 'b.ts']
   * Only meaningful when `takesValue` is true.
   */
  accumulate?: boolean;
}

/**
 * Parse and validate command-line arguments against a set of allowed flags.
 * Returns parsed positional args and flag values.
 * Exits with an error if unknown flags are found.
 *
 * @param args - Raw command arguments (e.g., process.argv.slice(2))
 * @param allowedFlags - Array of flag definitions
 * @param commandName - Name of the command (for error messages)
 * @returns Parsed positional arguments and flag values
 *
 * @example
 * const flags = [
 *   { name: 'goal', takesValue: true },
 *   { name: 'model', takesValue: true },
 *   { name: 'follow', takesValue: false },
 *   { name: 'fuzzy', aliases: ['f'], takesValue: false },
 * ];
 * const parsed = parseFlags(args, flags, 'start');
 * const goal = parsed.flags.get('goal') as string | undefined;
 * const follow = parsed.flags.get('follow') === true;
 */
export function parseFlags(
  args: string[],
  allowedFlags: FlagDefinition[],
  commandName: string
): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean | string[]>();

  // Build lookup maps for fast validation
  const flagMap = new Map<string, FlagDefinition>();
  for (const def of allowedFlags) {
    flagMap.set(`--${def.name}`, def);
    if (def.aliases) {
      for (const alias of def.aliases) {
        flagMap.set(`-${alias}`, def);
      }
    }
  }

  // Parse arguments
  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    // Check if it's a flag
    if (arg.startsWith('-')) {
      const def = flagMap.get(arg);

      if (!def) {
        // Unknown flag
        console.error(`Unknown flag: ${arg}. Run \`lazy ${commandName} --help\` for usage.`);
        process.exit(1);
      }

      if (def.takesValue) {
        if (def.optionalValue) {
          // Optional value: consume next arg only if it doesn't look like a flag
          const next = args[i + 1];
          if (next && !next.startsWith('-')) {
            flags.set(def.name, next);
            i += 2;
          } else {
            // Bare usage — set to true (present without value)
            flags.set(def.name, true);
            i += 1;
          }
        } else if (def.accumulate) {
          // Accumulate: repeated flags build a string[]
          if (i + 1 >= args.length) {
            console.error(`${arg} requires a value`);
            process.exit(1);
          }
          const existing = flags.get(def.name);
          if (Array.isArray(existing)) {
            existing.push(args[i + 1]);
          } else {
            flags.set(def.name, [args[i + 1]]);
          }
          i += 2;
        } else {
          // Flag requires a value
          if (i + 1 >= args.length) {
            console.error(`${arg} requires a value`);
            process.exit(1);
          }
          flags.set(def.name, args[i + 1]);
          i += 2;
        }
      } else {
        // Boolean flag
        flags.set(def.name, true);
        i += 1;
      }
    } else {
      // Positional argument
      positional.push(arg);
      i += 1;
    }
  }

  return { positional, flags };
}

/**
 * Resolve a task identifier (hex ID, UUID, or code) to a Task.
 * Exits with an appropriate error message if not found or ambiguous.
 */
export async function resolveTaskOrExit(storage: Storage, input: string): Promise<import('../types').Task> {
  const result = await storage.resolveTask(input);

  if (result.task) {
    return result.task;
  }

  if (result.ambiguousMatches && result.ambiguousMatches.length > 0) {
    // Build formatted options for each task
    const options: string[] = [];
    for (const t of result.ambiguousMatches) {
      // Get the most recent session for this task to determine last interaction
      const session = await storage.getSessionByTaskId(t.id);
      const timestamp = session?.last_interaction_at ?? t.created_at;
      const formattedDate = formatDate(timestamp);

      // Pad status to align columns nicely (longest status is "interrupted" = 11 chars)
      const paddedStatus = t.status.padEnd(12);

      options.push(`${shortId(t.id)}  ${paddedStatus}  ${formattedDate}  ${t.goal}`);
    }

    // In TTY mode, offer interactive choice
    if (isTTY()) {
      const choice = await promptChoice(`Multiple tasks match code '${input}'. Choose one:`, options);
      return result.ambiguousMatches[choice];
    }

    // In non-TTY mode, print error and exit
    console.error(`Multiple tasks match code '${input}'. Use the ID to disambiguate:`);
    for (const option of options) {
      console.error(`  ${option}`);
    }
    process.exit(1);
  }

  console.error(`No task found matching '${input}'`);
  process.exit(1);
}

/**
 * Validate a model name value.
 * Accepts any non-empty string — users pass raw model IDs directly.
 */
export function validateModel(value: string): string {
  if (!value.trim()) {
    console.error('Model name cannot be empty');
    process.exit(1);
  }
  return value;
}

/**
 * Check if a task is locked for pairing and exit with an error if so.
 * Call this in any command that should refuse while pairing is active.
 * @param tRef - The task ref (or shortId for legacy tasks) used as the worktree directory name
 */
export function rejectIfPairing(root: string, tRef: string, displayTaskId: string): void {
  const worktreePath = getWorktreePathForRef(root, tRef);
  const pairingLock = checkPairingLock(worktreePath);
  if (pairingLock) {
    console.error(`Task ${tRef} is locked for pairing (PID ${pairingLock.pid}, started ${pairingLock.started_at}).`);
    console.error(`Exit the pairing session first, or clear the lock with: lazy pair ${displayTaskId} --unlock`);
    process.exit(1);
  }
}

/**
 * Parsed line range for output slicing
 */
export interface LineRange {
  /** Starting line (1-indexed, inclusive). undefined means "from start" */
  start?: number;
  /** Ending line (1-indexed, inclusive). undefined means "to end" */
  end?: number;
}

/**
 * Parse a line range string (e.g., "10..20", "10..", "..20").
 * Returns null if the format is invalid.
 * Line numbers are 1-indexed and inclusive.
 *
 * @param rangeStr - Line range string (e.g., "10..20")
 * @returns Parsed range or null if invalid
 *
 * @example
 * parseLineRange("10..20") => { start: 10, end: 20 }
 * parseLineRange("10..")   => { start: 10, end: undefined }
 * parseLineRange("..20")   => { start: undefined, end: 20 }
 */
export function parseLineRange(rangeStr: string): LineRange | null {
  // Must contain exactly one ".."
  const parts = rangeStr.split('..');
  if (parts.length !== 2) {
    return null;
  }

  const [startStr, endStr] = parts;

  // At least one side must be specified
  if (!startStr && !endStr) {
    return null;
  }

  const range: LineRange = {};

  if (startStr) {
    const start = parseInt(startStr, 10);
    if (isNaN(start) || start < 1) {
      return null;
    }
    range.start = start;
  }

  if (endStr) {
    const end = parseInt(endStr, 10);
    if (isNaN(end) || end < 1) {
      return null;
    }
    range.end = end;
  }

  // If both specified, start must be <= end
  if (range.start !== undefined && range.end !== undefined && range.start > range.end) {
    return null;
  }

  return range;
}

/**
 * Slice output text to a specific line range.
 * Line numbers are 1-indexed and inclusive.
 *
 * @param output - The full output text
 * @param range - The line range to extract
 * @returns The sliced output
 *
 * @example
 * sliceLines("line1\nline2\nline3", { start: 2, end: 3 }) => "line2\nline3"
 * sliceLines("line1\nline2\nline3", { start: 2 }) => "line2\nline3"
 * sliceLines("line1\nline2\nline3", { end: 2 }) => "line1\nline2"
 */
export function sliceLines(output: string, range: LineRange): string {
  const lines = output.split('\n');

  // Convert 1-indexed to 0-indexed for array slicing
  const startIdx = range.start !== undefined ? range.start - 1 : 0;
  const endIdx = range.end !== undefined ? range.end : lines.length;

  // Clamp to valid bounds
  const clampedStart = Math.max(0, Math.min(startIdx, lines.length));
  const clampedEnd = Math.max(0, Math.min(endIdx, lines.length));

  return lines.slice(clampedStart, clampedEnd).join('\n');
}
